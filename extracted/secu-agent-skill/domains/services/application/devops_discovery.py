"""DevOps proxy-log discovery helpers shared by service domains."""
from __future__ import annotations

import datetime as dt
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from fnmatch import fnmatch
import re
from typing import Any, Protocol
from urllib.parse import urlparse

_GITHUB_HOST = "github.samsungds.net"
_CONFLUENCE_HOST = "confluence.samsungds.net"
_GITHUB_REPO_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
_CONFLUENCE_SPACE_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,80}$", re.IGNORECASE)
_GITHUB_NON_REPO_FIRST_SEGMENTS = {
    "about",
    "apps",
    "dashboard",
    "enterprise",
    "explore",
    "features",
    "issues",
    "login",
    "marketplace",
    "notifications",
    "orgs",
    "pricing",
    "pulls",
    "search",
    "settings",
    "topics",
    "users",
    "_private",
    "api",
    "assets",
    "sessions",
}
_GITHUB_NON_REPO_SECOND_SEGMENTS = {
    "followers",
    "following",
    "repositories",
    "settings",
    "teams",
}

_SPL_TEMPLATE = (
    'search index=hq_prx_* earliest={earliest} latest={latest} '
    '{host_clause} '
    '| rex field=_raw "(?<full_url>https?://[^\\s:|]+)" '
    '| where isnotnull(full_url) '
    '| stats count as count by full_url '
    '| sort -count '
    '| head {max_urls}'
)


class DevopsDiscoveryStorePort(Protocol):
    def devops_target_upsert(
        self,
        url: str,
        *,
        service: str,
        source: str,
        day_bucket: str,
        access_count: int = 0,
    ) -> int:
        """Insert or update one DevOps target."""

    def devops_targets_summary(
        self,
        *,
        day_bucket: str | None = None,
        service: str | None = None,
    ) -> dict[str, int]:
        """Return DevOps target queue counts."""

    def devops_target_set_status(self, target_id: int, status: str, **fields: Any) -> None:
        """Transition one DevOps target (used to close unreadable targets at ingestion)."""


@dataclass(frozen=True)
class DevopsDiscoveryConfig:
    earliest: str = "-7d"
    latest: str = "now"
    day_bucket: str | None = None
    max_urls: int = 2000
    source: str = "proxy"

    def resolved_day_bucket(self) -> str:
        day = self.day_bucket or dt.date.today().isoformat()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", day):
            raise ValueError(f"day_bucket must be YYYY-MM-DD: {day!r}")
        return day

    def bounded_max_urls(self) -> int:
        return max(1, min(int(self.max_urls), 20000))


def _host_clause(service_filter: str | None = None) -> str:
    service = str(service_filter or "").strip().lower()
    if service == "github":
        return f'URL_Host="{_GITHUB_HOST}"'
    if service == "confluence":
        return f'URL_Host="{_CONFLUENCE_HOST}"'
    return f'(URL_Host="{_GITHUB_HOST}" OR URL_Host="{_CONFLUENCE_HOST}")'


def build_devops_discovery_spl(
    config: DevopsDiscoveryConfig,
    *,
    service_filter: str | None = None,
) -> str:
    return _SPL_TEMPLATE.format(
        earliest=config.earliest,
        latest=config.latest,
        host_clause=_host_clause(service_filter),
        max_urls=config.bounded_max_urls(),
    )


def _valid_confluence_space_key(value: str) -> bool:
    return bool(_CONFLUENCE_SPACE_KEY_RE.fullmatch(str(value or "").strip()))


def normalize_devops_url(raw_url: str) -> tuple[str, str] | None:
    """Return `(service, normalized target URL)` for a proxy-log URL."""
    try:
        p = urlparse(raw_url.strip())
    except Exception:  # noqa: BLE001
        return None
    host = (p.netloc.split("@")[-1].split(":")[0]).lower()
    segs = [s for s in p.path.split("/") if s]
    if host == _GITHUB_HOST:
        if len(segs) < 2:
            return None
        org, repo = segs[0], segs[1]
        repo = re.sub(r"\.git$", "", repo)
        if (
            org.lower() in _GITHUB_NON_REPO_FIRST_SEGMENTS
            or repo.lower() in _GITHUB_NON_REPO_SECOND_SEGMENTS
            or not _GITHUB_REPO_SEGMENT_RE.fullmatch(org)
            or not _GITHUB_REPO_SEGMENT_RE.fullmatch(repo)
        ):
            return None
        return "github", f"https://{_GITHUB_HOST}/{org}/{repo}"
    if host == _CONFLUENCE_HOST:
        low = [s.lower() for s in segs]
        if "display" in low:
            i = low.index("display")
            if i + 1 < len(segs) and _valid_confluence_space_key(segs[i + 1]):
                return "confluence", f"https://{_CONFLUENCE_HOST}/display/{segs[i + 1]}"
        if "spaces" in low:
            i = low.index("spaces")
            if i + 1 < len(segs) and _valid_confluence_space_key(segs[i + 1]):
                return "confluence", f"https://{_CONFLUENCE_HOST}/spaces/{segs[i + 1]}"
        return None
    return None


def _row_url(row: dict[str, Any]) -> str:
    return str(row.get("full_url") or row.get("url") or "").strip()


def _row_count(row: dict[str, Any]) -> int:
    try:
        return max(0, int(row.get("count") or row.get("event_count") or 0))
    except (TypeError, ValueError):
        return 0


def aggregate_devops_rows(
    rows: list[dict[str, Any]],
    *,
    service_filter: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Normalize and aggregate proxy rows by target URL."""
    wanted = str(service_filter or "").strip().lower()
    agg: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        norm = normalize_devops_url(_row_url(row))
        if norm is None:
            continue
        service, nurl = norm
        if wanted and service != wanted:
            continue
        entry = agg.setdefault(nurl, {"service": service, "count": 0})
        entry["count"] += _row_count(row)
    return agg


def github_repo_slug(normalized_url: str) -> str | None:
    """정규화된 github 타깃 URL → `org/repo`. github 호스트가 아니면 None."""
    try:
        p = urlparse(str(normalized_url or "").strip())
    except Exception:  # noqa: BLE001
        return None
    if (p.netloc.split("@")[-1].split(":")[0]).lower() != _GITHUB_HOST:
        return None
    segs = [s for s in p.path.split("/") if s]
    return f"{segs[0]}/{segs[1]}" if len(segs) >= 2 else None


def github_target_url(slug: str) -> str | None:
    """`org/repo` → 정규화된 devops_target URL. 형식이 틀리면 None.

    `normalize_devops_url` 의 역함수라 코드검색으로 발견한 repo 를 프록시 발견분과
    **같은 키 공간**에 넣을 수 있다(중복 등재 방지).
    """
    parts = [p for p in str(slug or "").strip().strip("/").split("/") if p]
    if len(parts) != 2:
        return None
    org, repo = parts
    if not (_GITHUB_REPO_SEGMENT_RE.fullmatch(org) and _GITHUB_REPO_SEGMENT_RE.fullmatch(repo)):
        return None
    return f"https://{_GITHUB_HOST}/{org}/{repo}"


NO_ACCESS_REASON = "no_access: not readable at ingestion"
OUT_OF_SCOPE_PREFIX = "out_of_scope"


def repo_excluded(slug: str, patterns: Sequence[str] | None) -> bool:
    """`org/repo` 가 제외 glob 중 하나에 걸리면 True. 소문자 비교.

    발견 경로가 둘(프록시 로그 / 전역 코드검색)이라 판정이 갈리면 한쪽으로만 새 들어온다.
    그래서 매칭을 여기 한 곳에 둔다.
    """
    name = str(slug or "").strip().lower()
    if not name:
        return False
    return any(fnmatch(name, str(p).strip().lower()) for p in (patterns or ()))


def screen_reason(verdict: object) -> str | None:
    """검사기 반환값 → 큐에서 닫을 사유(None = 큐에 그대로 둔다).

    두 계약을 다 받는다: 예전 bool 검사기(True=읽힘)와 사유 문자열 검사기.
    `None` 은 **유지**로 읽는다 — 애매하면 타깃을 살려두는 쪽이 안전하다.
    잘못 닫으면 커버리지를 조용히 잃고, 잘못 살려두면 워커가 한 번 헛도는 데 그친다.
    """
    if verdict is None or verdict is True:
        return None
    if isinstance(verdict, str):
        return verdict.strip() or None
    return None if verdict else NO_ACCESS_REASON


def ingest_devops_discovery_rows(
    rows: list[dict[str, Any]],
    *,
    config: DevopsDiscoveryConfig,
    store: DevopsDiscoveryStorePort,
    service_filter: str | None = None,
    visibility_check: Callable[[str], bool | str | None] | None = None,
    no_access_backoff_seconds: float = 30 * 86400.0,
) -> dict[str, Any]:
    """프록시 로그 행 → devops_target 큐 적재.

    v3.91 `visibility_check`: 프록시 로그는 **GitHub API 를 한 번도 안 부르므로** 방문 기록만
    있으면 우리가 못 읽는 private repo 도 그대로 등재된다(실측 481건 전부 source='proxy',
    그중 270건이 접근불가). 등재 시점에 `repo_meta` 한 번으로 가려내면 그 270건이 애초에
    pending 풀에 안 들어간다. rate 7000/h 라 수백 건 확인은 무해하다.

    못 읽는 타깃도 **행 자체는 남긴다** — 지우면 내일 프록시 로그에서 다시 발견해 매번
    재확인하게 된다. 대신 즉시 `skipped(no_access)` + 긴 백오프로 닫아 재순환을 끊는다.
    (영구 제외가 아니라 백오프인 이유: 권한 부여/공개 전환으로 나중에 읽힐 수 있다)

    v3.92: 검사기는 bool 대신 **사유 문자열**을 돌려줄 수 있다. "못 읽는다"와 "읽히지만
    점검 범위가 아니다(private/제외목록)"는 후속 조치가 다른데 사유가 같으면 구분이 안 된다.

    주입형인 이유: 이 모듈은 github/confluence 공용이라 github 클라이언트를 직접 물면
    confluence 경로까지 github 의존을 끌고 간다.
    """
    day_bucket = config.resolved_day_bucket()
    before = store.devops_targets_summary(day_bucket=day_bucket, service=service_filter)
    agg = aggregate_devops_rows(rows[: config.bounded_max_urls()], service_filter=service_filter)
    no_access = 0
    out_of_scope = 0
    checked = 0
    check_errors = 0
    for nurl, entry in agg.items():
        service = str(entry["service"])
        target_id = store.devops_target_upsert(
            nurl,
            service=service,
            source=config.source,
            day_bucket=day_bucket,
            access_count=int(entry["count"]),
        )
        if visibility_check is None or service != "github":
            continue
        slug = github_repo_slug(nurl)
        if not slug:
            continue
        try:
            verdict = visibility_check(slug)
        except Exception:  # noqa: BLE001
            # 확인 자체가 실패하면 **접근불가로 단정하지 않는다** — 일시적 네트워크/rate
            # 문제로 멀쩡한 타깃을 닫아버리면 커버리지를 조용히 잃는다. 기본은 살려둔다.
            check_errors += 1
            continue
        checked += 1
        reason = screen_reason(verdict)
        if reason is None:
            continue
        if reason.startswith(OUT_OF_SCOPE_PREFIX):
            out_of_scope += 1
        else:
            no_access += 1
        fields: dict[str, Any] = {"last_reason": reason}
        if no_access_backoff_seconds > 0:
            fields["retry_after"] = time.time() + no_access_backoff_seconds
        store.devops_target_set_status(target_id, "skipped", **fields)
    after = store.devops_targets_summary(day_bucket=day_bucket, service=service_filter)
    by_service = {
        "github": sum(1 for v in agg.values() if v["service"] == "github"),
        "confluence": sum(1 for v in agg.values() if v["service"] == "confluence"),
    }
    return {
        "kind": "devops_discovery",
        "day_bucket": day_bucket,
        "splunk_rows": len(rows),
        "normalized": len(agg),
        "upserted": len(agg),
        "new": max(0, after["total"] - before["total"]),
        "pending": after["pending"],
        "tasked": after["tasked"],
        "skipped": after["skipped"],
        "error": after["error"],
        "total": after["total"],
        "github": by_service["github"],
        "confluence": by_service["confluence"],
        "service_filter": service_filter,
        "visibility_checked": checked,
        "no_access": no_access,
        "out_of_scope": out_of_scope,
        "screened_out": no_access + out_of_scope,
        "visibility_check_errors": check_errors,
    }
