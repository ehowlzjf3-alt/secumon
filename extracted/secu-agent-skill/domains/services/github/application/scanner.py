"""GitHub E2E scan/report/recheck services.

The scanner is deliberately deterministic: clone/read-only scan, masked
evidence JSON, core finding lifecycle upsert, then GitHub-domain report thread
state. The engine remains unchanged.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import asdict
from email.utils import getaddresses
from html import escape
from pathlib import Path
from typing import Any
from uuid import uuid4

from service import state_domain as state
from service.agents.llm_provenance import with_served_llm
from service.services.remediation_mail import (
    allowed_pii_values,
    append_original_message,
    reply_subject,
    reply_targets,
)
from service.services.finding_verification import (
    is_agent_verified_extra,
    make_agent_verification,
)
from secu_agent.agent.delivery import DeliveryPayload, deliver
from secu_agent import state as core_state

from domains.services.application.devops_discovery import github_target_url, repo_excluded
from domains.services.application.report_cycles import (
    accumulated_week_label,
    notice_recurrence_label,
    should_show_recurrence,
    report_cycle_summary,
)
from domains.services.github.application import secret_gate
from domains.services.github.plugin.agent_types import github as gh
from domains.services.github.plugin.agent_types import github_scan
from service.services import owner_recipients as orx
from service.services import severity as _sev


_SEV_KO = {
    "critical": "심각",
    "high": "높음",
    "medium": "보통",
    "low": "낮음",
    "informational": "정보",
}
_VERIFICATION_LABELS = {
    "live_in_HEAD": "HEAD에 현재 존재",
    "historical_only": "git history에 존재",
    "gone": "현재 미확인",
    "unknown": "확인 불가",
}
_API_CODE_SEARCH_TERMS = (
    "AKIA",
    "ghp_",
    "github_pat",
    "password",
    "secret",
    "token",
    "filename:.env",
    "filename:.npmrc",
    "filename:.pypirc",
    "filename:.netrc",
    "filename:credentials",
    "filename:id_rsa",
    "filename:.pem",
    "filename:.tfvars",
    "filename:kubeconfig",
    "filename:application.properties",
    "filename:application.yml",
)
_API_SEARCH_METHOD = "api_code_search_detail_scan"
_API_COMMIT_METHOD = "api_recent_commit_patch_scan"
_API_RECHECK_METHOD = "api_head_detail_refetch"
_GITHUB_AUTH_FAILURE_STATUS_CODES = {401}
_GITHUB_LIMIT_FAILURE_STATUS_CODES = {429}
_GITHUB_LIMIT_FAILURE_TEXT = (
    "abuse detection",
    "rate limit",
    "rate-limit",
    "rate_limited",
    "ratelimit",
    "retry-after",
    "secondary rate limit",
    "too many requests",
)
_MAIL_BODY_LIMIT = 100_000
# ── 담당자 수신자 해석 — SSOT 위임 ────────────────────────────────────────────
# 예전엔 _csv/_iter_recipient_values/_is_internal_owner_email/_owner_recipient_list 와
# 16키 목록이 이 파일 안에 있었고, 같은 것이 confluence reporter·양쪽 webapp 에 복사돼
# 있었다(4벌). 그중 webapp 판본은 dict 재귀가 빠져 **화면과 메일이 다른 답**을 냈다.
# 키 목록이 갈라진 탓에 신 스캐너가 author_email 쓰기를 멈춘 것도 못 잡았다.
# → service.services.owner_recipients 로 옮기고 여기서는 이름만 남긴다.
_csv = orx.csv
_iter_recipient_values = orx.iter_recipient_values
_is_internal_owner_email = orx.is_internal
_owner_recipient_list = orx.recipient_list


def _github_owner_recipients_from_extra(extra: dict[str, Any] | None) -> list[str]:
    return orx.from_extra(extra, orx.GITHUB_KEYS)
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
_GITHUB_RECHECK_FINAL_STATUSES = {
    "recheck_requested",
    "remediated",
    "partially_remediated",
    "still_open",
    "exception_review",
}
_GITHUB_RECHECK_VERDICTS = {"unknown", "still_open", "now_closed"}
_GITHUB_RECHECK_DELIVERY_REQUIRED_STATUSES = {
    "remediated",
    "partially_remediated",
    "still_open",
}
_REPORT_STYLES = """
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: #f7fafc;
      color: #2d3748;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', Arial, sans-serif;
      font-size: 14px;
      line-height: 1.7;
    }
    .container {
      max-width: 960px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.08);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #12343b 0%, #256d65 100%);
      color: #ffffff;
      padding: 30px 40px;
    }
    .header h1 { margin: 0 0 8px 0; font-size: 22px; font-weight: 700; }
    .header p { margin: 0; opacity: 0.92; font-size: 14px; }
    .content { padding: 36px 40px 40px 40px; }
    .lead { margin: 0 0 20px 0; }
    .info-card {
      background: linear-gradient(135deg, #e6fffa 0%, #ebf8ff 100%);
      border-left: 4px solid #2c7a7b;
      border-radius: 0 8px 8px 0;
      padding: 18px 22px;
      margin: 22px 0;
    }
    .warning-card {
      background: linear-gradient(135deg, #fff5f5 0%, #fffaf0 100%);
      border-left: 4px solid #c53030;
      border-radius: 0 8px 8px 0;
      color: #742a2a;
      padding: 16px 20px;
      margin: 22px 0;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px 14px;
      margin: 8px 0;
    }
    .metric {
      background: rgba(255,255,255,0.75);
      border: 1px solid #b2f5ea;
      border-radius: 8px;
      padding: 10px 12px;
    }
    .metric small {
      display: block;
      color: #4a5568;
      font-size: 12px;
      margin-bottom: 3px;
    }
    .metric strong { color: #234e52; font-size: 14px; }
    .section-title {
      margin: 28px 0 14px 0;
      padding-bottom: 8px;
      border-bottom: 2px solid #e2e8f0;
      color: #234e52;
      font-size: 16px;
      font-weight: 700;
    }
    .section-title span { color: #2c7a7b; margin-right: 8px; }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 14px 0;
      font-size: 12px;
      table-layout: fixed;
    }
    th {
      background: #3d565d;
      color: #ffffff;
      padding: 8px 7px;
      text-align: left;
      font-weight: 700;
      border: 1px solid #3d565d;
      word-break: keep-all;
    }
    td {
      padding: 8px 7px;
      border: 1px solid #e2e8f0;
      background: #ffffff;
      vertical-align: top;
      word-break: break-word;
    }
    tr:nth-child(even) td { background: #f8fafc; }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 12px;
      font-weight: 700;
      background: #edf2f7;
      color: #2d3748;
    }
    .badge-critical, .badge-high { background: #fed7d7; color: #9b2c2c; }
    .badge-medium { background: #feebc8; color: #9c4221; }
    .badge-low, .badge-informational { background: #c6f6d5; color: #276749; }
    .badge-live { background: #fed7d7; color: #9b2c2c; }
    .badge-history { background: #feebc8; color: #9c4221; }
    ol, ul { margin: 12px 0; padding-left: 24px; }
    li { margin: 8px 0; color: #4a5568; }
    code {
      background: #edf2f7;
      border: 1px solid #d9e2ec;
      border-radius: 4px;
      padding: 1px 5px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 12px;
    }
    .note {
      color: #4a5568;
      font-size: 13px;
      background: #f7fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 12px 14px;
      margin: 16px 0;
    }
    .footer {
      margin-top: 34px;
      padding-top: 22px;
      border-top: 1px solid #e2e8f0;
      color: #718096;
    }
    .footer strong { color: #2d3748; }
  </style>
"""


def _safe_repo_label(repo: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in repo)[:80]


def _evidence_path(evidence_dir: Path, repo: str) -> Path:
    out_dir = Path(evidence_dir) / "github_e2e"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f"{_safe_repo_label(repo)}_{uuid4().hex[:12]}.json"
















def _repo_head_sha(repo_dir: Path) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo_dir), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return proc.stdout.strip() or None
    except Exception:
        return None




def _api_error(phase: str, error: Exception, **extra: Any) -> dict[str, Any]:
    out = {
        "phase": phase,
        "error": repr(error)[:500],
        **extra,
    }
    status_code = _http_status_code(error)
    if status_code is not None:
        out["status_code"] = status_code
    if _api_limit_failed(error):
        out["limit_failed"] = True
    return out


def _http_status_code(error: Exception) -> int | None:
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    if isinstance(status, int):
        return status
    match = re.search(r"\bHTTP\s+(\d{3})\b", str(error))
    if match:
        return int(match.group(1))
    return None


def _http_error_text(error: Exception) -> str:
    parts = [repr(error)]
    response = getattr(error, "response", None)
    if response is not None:
        try:
            parts.append(str(response.text))
        except Exception:  # noqa: BLE001
            pass
        try:
            parts.extend(f"{k}: {v}" for k, v in response.headers.items())
        except Exception:  # noqa: BLE001
            pass
    return "\n".join(parts).lower()


def _api_limit_failed(error: Exception) -> bool:
    status_code = _http_status_code(error)
    if status_code in _GITHUB_LIMIT_FAILURE_STATUS_CODES:
        return True
    if status_code == 403:
        text = _http_error_text(error)
        return any(token in text for token in _GITHUB_LIMIT_FAILURE_TEXT)
    return False






def _api_auth_failed(error: Exception) -> bool:
    return _http_status_code(error) in _GITHUB_AUTH_FAILURE_STATUS_CODES


def _api_unavailable(error: Exception) -> bool:
    if _api_auth_failed(error) or _api_limit_failed(error):
        return False
    text = repr(error)
    return (
        "GITHUB_BASE_URL" in text
        or "GITHUB_TOKEN" in text
        or error.__class__.__module__.startswith("httpx")
    )








def _invalid_repo_path_reason(path: str, *, subject: str = "code search candidate") -> str | None:
    value = str(path or "").strip()
    if not value:
        return f"{subject} missing path"
    if len(value) > 4096:
        return f"{subject} invalid path"
    if value.startswith("/") or "\\" in value or _CONTROL_CHAR_RE.search(value):
        return f"{subject} invalid path"
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return f"{subject} invalid path"
    return None






















def _clone_and_scan_repo(repo: str) -> tuple[list[github_scan.ScanFinding], str | None, str | None]:
    tmp_root = Path(tempfile.mkdtemp(prefix="github-e2e-"))
    repo_dir = tmp_root / _safe_repo_label(repo)
    try:
        ok, message = github_scan.clone_repo(repo, str(repo_dir))
        if not ok:
            return [], None, message
        head_sha = _repo_head_sha(repo_dir)
        return github_scan.scan_repo(str(repo_dir), repo), head_sha, None
    finally:
        try:
            shutil.rmtree(tmp_root)
        except OSError:
            pass


def discover_repositories(
    *,
    visibilities: tuple[str, ...] = ("public", "internal"),
    include_archived: bool = False,
    max_repos: int | None = None,
) -> dict[str, Any]:
    """Enumerate GitHub Enterprise repositories into the bounded rolling queue."""
    before = state.github_repo_targets_summary()
    repos = list(gh.iter_all_repos(
        visibilities=visibilities,
        include_archived=include_archived,
        max_repos=max_repos,
    ))
    for repo in repos:
        state.github_repo_target_upsert(
            repo.full_name,
            default_branch=repo.default_branch,
            pushed_at=repo.pushed_at,
        )
    after = state.github_repo_targets_summary()
    return {
        "enumerated": len(repos),
        "before": before,
        "after": after,
        "new": max(0, after["total"] - before["total"]),
    }


def discover_repositories_by_search(
    entries: list[dict[str, Any]],
    *,
    config_version: str | None = None,
    per_query_limit: int = 100,
    max_repos: int | None = None,
    spacing_seconds: float | None = None,
    day_bucket: str | None = None,
    exclude_repos: list[str] | None = None,
    scope_screen: Callable[[str], str | None] | None = None,
) -> dict[str, Any]:
    """v3.91: 전역 `/search/code` 로 후보 repo 를 발견해 **활성 워커 큐**에 적재한다.

    커버리지 원천 3종 비교:
      - `iter_all_repos`   : 전사 `/repositories` 열거 → visibility 필터.
                             소비 컴포넌트 `github.scan`/`github.collector` 가 **enabled=0** → 미가동.
      - 프록시 로그         : GitHub API 를 **안 부르므로** visibility 를 모른다. 방문 기록만 있으면
                             못 읽는 private repo 도 등재 → 큐의 64%가 접근불가.
      - 여기(code_search)  : 인덱스가 **읽을 수 있는 repo 만** 돌려준다 → visibility 문제가 구조적으로 없다.

    ⚠️ 적재 대상은 `devops_target(service='github')` 이다. `github_repo_target` 이 아니다 —
    그쪽 소비자(`github.scan`)는 꺼져 있어서 넣어봐야 finding 이 안 나온다. 실제로 도는 건
    `github.sso_hunt`/`sso_discovery` 경로이고 그게 `devops_target` 을 claim 한다.
    URL 은 `github_target_url` 로 프록시 발견분과 **같은 키 공간**에 정규화해 중복 등재를 피한다.

    path 는 발견 신호일 뿐 저장하지 않는다 — 큐 단위가 repo 이고, 파일 선별은 워커 스캔 소관이다.

    v3.92 `scope_screen`: 검색 인덱스는 "읽을 수 있는" repo 를 돌려줄 뿐 **점검 범위**를
    모른다. 토큰에 권한이 있는 private repo 도 결과에 섞이는데 방침은 internal/public 이다.
    주입형인 이유는 `exclude_repos` 와 같다 — 판정 로직을 호출자가 갈아끼울 수 있어야 한다.
    검사기가 터지면 **적재하는 쪽으로** 넘어간다(범위 밖이라 단정하지 않는다).
    """
    bucket = day_bucket or dt.date.today().isoformat()
    # 시크릿 스캐너/샘플 저장소는 `ghp_`/`AKIA` 픽스처를 **정상적으로** 갖고 있어 값 접두
    # 키워드에 100% 걸린다. secret_gate 가 tests//fixtures/ 경로를 거르지만 리포 루트의
    # 샘플은 통과할 수 있으므로, 오탐의 근원을 큐 진입 단계에서 끊는다.
    exclude_patterns = list(exclude_repos or [])
    before = state.devops_targets_summary(service="github")
    spacing = (
        float(os.environ.get("SA_GH_SEARCH_SPACING_SEC") or 2.0)
        if spacing_seconds is None else float(spacing_seconds)
    )
    seen_repos: set[str] = set()
    excluded_repos: set[str] = set()
    out_of_scope_repos: dict[str, str] = {}
    per_keyword: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    screen_errors = 0
    capped = False

    for index, entry in enumerate(entries):
        keyword = str(entry.get("keyword") or "").strip()
        if not keyword:
            continue
        if max_repos is not None and len(seen_repos) >= max_repos:
            capped = True
            break
        qualifiers = [str(q).strip() for q in (entry.get("qualifiers") or []) if str(q).strip()]
        query = " ".join([*qualifiers, keyword]) if qualifiers else keyword
        # 연속 호출은 secondary rate limit(403) 을 부른다. code_search 가 백오프로 복구하지만
        # 애초에 간격을 줘서 맞지 않는 편이 빠르다. 첫 호출은 대기 없이 나간다.
        if index and spacing > 0:
            time.sleep(spacing)
        try:
            hits = gh.code_search(query, per_page=min(per_query_limit, 100),
                                  max_results=per_query_limit)
        except Exception as exc:  # noqa: BLE001
            errors.append({"keyword": keyword, "query": query, "error": repr(exc)})
            per_keyword.append({"keyword": keyword, "hits": 0, "repos": 0, "status": "error"})
            continue
        fresh = 0
        invalid = 0
        skipped = 0
        oos = 0
        for hit in hits:
            repo = (hit.repo or "").strip()
            if not repo or repo.lower() in seen_repos:
                continue
            if repo.lower() in excluded_repos or repo.lower() in out_of_scope_repos:
                continue
            if repo_excluded(repo, exclude_patterns):
                # seen_repos 와 분리한다 — 거기 넣으면 max_repos 캡과 repos_seen 집계에
                # "큐에 넣은 것"으로 섞여 들어간다.
                excluded_repos.add(repo.lower())
                skipped += 1
                continue
            url = github_target_url(repo)
            if url is None:
                invalid += 1
                continue
            if scope_screen is not None:
                try:
                    reason = scope_screen(repo)
                except Exception as exc:  # noqa: BLE001
                    # 확인 실패로 범위 밖이라 단정하지 않는다. 적재하고 워커가 판단하게 둔다.
                    screen_errors += 1
                    errors.append({"keyword": keyword, "repo": repo, "error": repr(exc)})
                    reason = None
                if reason:
                    # 제외 목록과 마찬가지로 max_repos 예산을 쓰지 않는다.
                    out_of_scope_repos[repo.lower()] = reason
                    oos += 1
                    continue
            if max_repos is not None and len(seen_repos) >= max_repos:
                capped = True
                break
            seen_repos.add(repo.lower())
            state.devops_target_upsert(
                url,
                service="github",
                source="code_search",
                day_bucket=bucket,
                # 검색으로 걸린 것은 프록시 트래픽량이 없다. 같은 repo 를 프록시가 이미 높은
                # 카운트로 등재했을 수 있으므로 **덮지 않는다**(claim 정렬이 access_count DESC).
                access_count=1,
                preserve_access_count=True,
            )
            fresh += 1
        per_keyword.append({
            "keyword": keyword, "hits": len(hits), "repos": fresh,
            "invalid": invalid, "excluded": skipped, "out_of_scope": oos, "status": "ok",
        })

    after = state.devops_targets_summary(service="github")
    return {
        "kind": "github_search_discovery",
        "config_version": config_version,
        "day_bucket": bucket,
        "keywords": len(per_keyword),
        "repos_seen": len(seen_repos),
        "excluded": len(excluded_repos),
        "excluded_repos": sorted(excluded_repos),
        "out_of_scope": len(out_of_scope_repos),
        "out_of_scope_repos": dict(sorted(out_of_scope_repos.items())),
        "screen_errors": screen_errors,
        "new": max(0, after["total"] - before["total"]),
        "total": after["total"],
        "capped": capped,
        "per_keyword": per_keyword,
        "errors": errors,
        "before": before,
        "after": after,
    }


def _finding_rows(thread_id: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for fid in state.github_report_thread_finding_ids(thread_id):
        row = core_state.finding_get(fid)
        if row:
            rows.append(row)
    return rows


def repo_from_finding(row: dict[str, Any]) -> str:
    """정규화된 GitHub finding 의 저장소 스코프. 못 정하면 "unknown".

    ⚠️⚠️ **asset 형태가 두 가지다.** 실측 2026-08-30(라이브 301건):

        https://github.samsungds.net/ORG/REPO/...   294건
        github:ORG/REPO/commit/<sha>                  7건

    한쪽만 벗기면 나머지가 통째로 "unknown" 이 되어 보고 패스가 조용히 버린다 —
    실제로 `skipped_unknown_scope: 294` 로 나타났고, 그 숫자는 `pipeline_run.detail`
    에만 남아 화면 어디에도 없었다. 오늘 같은 함정을 세 번 밟았다(담당자 소급,
    러너 배선, 여기). **양쪽 다 벗긴다.**
    """
    extra = row.get("extra") or {}
    metadata = extra.get("metadata") if isinstance(extra.get("metadata"), dict) else {}
    repo = str(metadata.get("repo") or "").strip()
    if repo:
        return repo
    asset = str(row.get("asset") or "").strip()
    if not asset:
        return "unknown"

    # 두 형태를 같은 자리로 정규화한다 — 스킴/호스트를 벗기면 나머지는 ORG/REPO/... 다.
    scoped = asset
    if scoped.startswith("github:"):
        scoped = scoped[len("github:"):]
    elif "://" in scoped:
        scoped = scoped.split("://", 1)[1]
        # host/ORG/REPO/... → ORG/REPO/...
        scoped = scoped.split("/", 1)[1] if "/" in scoped else ""
    else:
        return "unknown"

    scoped = scoped.strip("/")
    if not scoped:
        return "unknown"
    if "/commit/" in scoped:
        repo = scoped.split("/commit/", 1)[0].strip()
        return repo or "unknown"
    parts = scoped.split("/", 2)
    if len(parts) >= 2 and parts[0] and parts[1]:
        return f"{parts[0]}/{parts[1]}"
    return "unknown"


def sync_report_threads() -> dict[str, int]:
    """Ensure current GitHub findings have repo-scoped report threads.

    Scan workers upsert report threads as they persist findings, but the report
    phase also heals pre-existing or externally inserted lifecycle rows so the
    report board can recover like SMB/Confluence.

    ★ 저장소 축으로 돈다 — 예전엔 finding 을 `last_seen DESC LIMIT 500` 으로 잘랐다.
      통보 단위는 **저장소**인데 창을 finding 에 걸어서 생긴 사고다(실측 2026-08-24):

          열린 finding 14,348 · agent_verified 13,261 · verified 저장소 607
          창 500 이 덮은 저장소 85 → 나머지 522곳은 열린 채로 통보 대상이 아니었다

      저장소당 finding 이 평균 21.8건이라 창 500 은 저장소 85곳밖에 못 산다. 게다가
      정렬이 결정론이라 **매주 같은 500건**만 봤다 — 창이 앞으로 나가지 않는다.
      코드 상한이던 5000 까지 키워도 저장소 절반이다. 크기가 아니라 축이 틀렸다.

    ⚠️ 상한을 다시 넣지 말 것. 전량 스캔 비용을 재보면 넣을 이유가 없다 —
      finding 14,348건 조회 0.16초, `finding_get` 13,261회 5초다. 상한은 비용을 아끼지
      못하면서 조용히 저장소를 떨어뜨린다. 그게 이 버그였다.
    """
    counters = {
        "seen": 0,
        "new": 0,
        "merged": 0,
        "recurred": 0,
        "dup": 0,
        "skipped_unknown_scope": 0,
        "skipped_unverified": 0,
        "owner_recipient_count": 0,
        "owner_missing_count": 0,
    }
    active_statuses = ("open", "triaged")
    active_in = ",".join("?" for _ in active_statuses)
    with state.connect() as c:
        rows = c.execute(
            f"SELECT id FROM finding_lifecycle WHERE task_type='github' "
            f"AND status IN ({active_in}) "
            "ORDER BY last_seen DESC, id DESC",
            active_statuses,
        ).fetchall()

    # 저장소로 묶는다. dict 는 삽입 순서를 지키므로 "가장 최근 finding 을 가진 저장소" 가
    # 앞에 온다 — 정렬 의도(최근 우선)가 축이 바뀌어도 남는다.
    #
    # finding 의 `extra` 는 여기서 버린다. hits/masked_hits 가 실려 있어 13,261건을 그대로
    # 들고 있으면 메모리가 커진다. 뒤에서 쓸 것(담당자)만 지금 뽑아 둔다.
    by_repo: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        row = core_state.finding_get(int(r["id"]))
        if not row:
            continue
        counters["seen"] += 1
        extra = row.get("extra") or {}
        if not is_agent_verified_extra(extra):
            counters["skipped_unverified"] += 1
            continue
        repo = repo_from_finding(row)
        if not repo or repo.lower() == "unknown":
            counters["skipped_unknown_scope"] += 1
            continue
        by_repo.setdefault(repo, []).append({
            "id": int(row["id"]),
            "severity": row.get("severity"),
            "owner_from_extra": _github_owner_recipients_from_extra(extra),
        })
    counters["repos_seen"] = len(by_repo)

    # ★ 담당자 조회는 **저장소당 1회**다(finding 축이던 시절 평균 21.8회를 두드렸다).
    #   backfill 도 같은 캐시를 쓴다 — 안 그러면 스레드마다 다시 두드린다.
    owner_cache: dict[str, list[str]] = {}
    for repo, findings in by_repo.items():
        # 저장소 담당자는 **저장소당 한 번만** 조회한다. 예전엔 finding 마다 불러
        # 같은 저장소를 평균 21.8번 두드렸다(DB + knox 임직원 대장).
        # sentinel 이 필요하다 — 조회 결과가 빈 목록일 수 있고, 그때도 재조회하면 안 된다.
        repo_owner: list[str] | None = None
        for item in findings:
            owner_list = item["owner_from_extra"]
            if not owner_list:
                # finding 에 없으면 저장소 담당자로 떨어진다. 이게 없으면 스레드가
                # `owner_recipient` 비어 생기고, claim 필터(주차 ∧ 담당자)에서 영원히 걸린다.
                if repo_owner is None:
                    repo_owner = owner_cache.get(repo)
                    if repo_owner is None:
                        repo_owner = _repo_owner_recipients(repo)
                        owner_cache[repo] = repo_owner
                owner_list = repo_owner
                if owner_list:
                    counters["owner_from_repo_count"] = counters.get("owner_from_repo_count", 0) + 1
            if owner_list:
                counters["owner_recipient_count"] += 1
            else:
                counters["owner_missing_count"] += 1
            owner_recipients = ", ".join(owner_list) or None
            action, _thread_id = state.github_report_thread_upsert(
                finding_id=item["id"],
                repo=repo,
                severity=item["severity"],
                recipient=owner_recipients,
                owner_recipient=owner_recipients,
                status="reported",
            )
            counters[action] = counters.get(action, 0) + 1

    # ★ 담당자는 **주차의 사실이 아니라 저장소의 속성**이다(사용자 지적 2026-09-01:
    #   "시스템에 지난 주꺼가 우선되는게 어딧냐"). upsert 의 병합 후보 조건이
    #   `last_cycle_key = 현재주차` 라, 지난 주차에 열린 스레드는 담당자가 나중에 풀려도
    #   **영영 안 실린다** — 실측 2026-09-01: 해석은 끝났는데 안 실린 스레드 37건.
    #   담당자 없는 스레드는 claim 필터(주차 ∧ 담당자)에서 걸려 발송 대기로도 못 간다.
    filled, attempts = _backfill_thread_owners(cache=owner_cache)
    counters["owner_backfilled"] = filled
    # ★ "0건" 이 **시도 실패**인지 **시도조차 안 함**인지 구분되게 남긴다. 오늘 그걸
    #   못 봐서 배선이 도는지 한 번 더 확인해야 했다.
    counters["owner_resolve_attempts"] = attempts
    return counters


#: 한 패스에서 **새로 해석**할 저장소 수 상한. 해석은 GitHub API 를 타므로 무제한이면
#: 한 패스가 길어지고 rate limit 을 먹는다. 못 한 것은 다음 패스가 집는다(상태를 본다).
_OWNER_RESOLVE_PER_PASS = 25


def _resolve_repo_owner_now(repo: str) -> bool:
    """저장소 담당자를 **지금** 해석해 저장한다. 싼 경로(커밋 작성자 메일)만 쓴다.

    ⚠️ 브라우저(SSO)는 안 쓴다 — 메일 큐 패스가 그것 때문에 길어지면 안 된다.
    """
    try:
        from service.services.github_owner import _from_commit_author, persist

        owner = _from_commit_author(repo)
    except Exception:  # noqa: BLE001 — 해석 실패는 담당자 미상이지 오류가 아니다
        return False
    if owner is None:
        return False
    try:
        persist(owner)
        return True
    except Exception:  # noqa: BLE001
        return False


def _backfill_thread_owners(
    *, limit: int = 500, cache: dict | None = None,
) -> tuple[int, int]:
    """열린 스레드 중 담당자가 빈 것을 채운다 — **주기 무관**, 없으면 **그 자리에서 해석**.

    ## 왜 여기인가 (사용자 지적 2026-09-01 "다른 도메인이랑 맞춰")

    도메인마다 담당자를 채우는 자리가 다른데, github 만 **아무도 안 부르는 별도 패스**에
    있었다:

        smb         수집기가 채운다(collector → splunk_owner) — 상시 프로세스
        confluence  스캔이 finding 의 extra 에 넣는다 — 발견 시점
        dev_web     담당자 개념 없음
        github      `github.owner` 패스 — ★ 실행 기록이 아예 없었다

    그래서 github 스레드 262건이 담당자 없이 큐에 멈춰 있었다. 담당자가 비면 발송 대기로
    못 넘어간다. 프로세스를 하나 더 띄우는 대신, **이미 매 패스 도는 자리**(공용 러너의
    `sync_report_threads`)에서 필요한 것만 해석한다.

    ⚠️ 비싼 경로(SSO 브라우저 상위기여자)는 여기서 쓰지 않는다. 커밋 작성자 메일은 API
       한 번이라 패스 안에서 감당된다. 브라우저가 필요한 저장소는 남고, 사람이 돌린다.
    ⚠️ 저장소당 1회 · 패스당 상한. 못 한 것은 다음 패스가 집는다.
    """
    filled = 0
    resolved = 0
    attempted: set[str] = set()
    with state.connect() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id, repo FROM github_report_thread "
            "WHERE COALESCE(owner_recipient,'') = '' "
            "  AND status NOT IN ('closed','remediated','resolved','false_positive') "
            "ORDER BY id LIMIT ?",
            (int(limit),),
        )]
    seen: dict[str, list[str]] = dict(cache or {})
    for row in rows:
        repo = str(row["repo"] or "")
        # ⚠️ 저장소당 1회. 스레드마다 두드리면 담당자 조회가 스레드 수만큼 늘어난다
        #    (이 저장소가 finding 축이던 시절 겪은 그 비용이다).
        if repo in seen:
            recipients = seen[repo]
        else:
            recipients = _repo_owner_recipients(repo)
            seen[repo] = recipients
        # ★ 기록이 비어 있으면 **그 자리에서 해석**한다. 위 캐시는 sync 본 루프가 이미
        #   채워 두므로(빈 값으로), 캐시 미스일 때만 시도하면 영원히 안 걸린다.
        #   저장소당 1회 · 패스당 상한.
        if not recipients and repo not in attempted and resolved < _OWNER_RESOLVE_PER_PASS:
            attempted.add(repo)
            resolved += 1
            if _resolve_repo_owner_now(repo):
                recipients = _repo_owner_recipients(repo)
                seen[repo] = recipients
        if not recipients:
            continue
        joined = ", ".join(recipients)
        try:
            state.github_report_thread_set_status(
                int(row["id"]),
                # 상태는 그대로 둔다 — 담당자를 채우는 것이지 큐 자리를 옮기는 게 아니다.
                str(state.github_report_thread_get(int(row["id"])).get("status") or "reported"),
                recipient=joined,
                owner_recipient=joined,
                last_reason="담당자 backfill(주기 무관)",
            )
            filled += 1
        except Exception:  # noqa: BLE001 — 한 건 실패가 sync 를 죽이지 않는다
            #   이 모듈엔 로거가 없다. 결과는 카운터(`owner_backfilled`)로 나간다 —
            #   러너가 그걸 찍는다.
            continue
    return filled, len(attempted)

def _scan_trace_from_metadata(metadata: dict[str, Any]) -> dict[str, str]:
    """Return bounded API/clone scan trace fields for reports."""
    out: dict[str, str] = {}
    for key in ("scan_method", "source", "commit", "candidate_source", "candidate_query"):
        value = str(metadata.get(key) or "").strip()
        if value:
            out[key] = value[:500]
    return out


def build_report_for_thread(thread: dict[str, Any]) -> dict[str, Any]:
    """Build a repo-focused report payload and HTML preview."""
    thread_id = int(thread["id"])
    repo = str(thread.get("repo") or "")
    cycle_summary = report_cycle_summary(thread)
    findings = _finding_rows(thread_id)
    report_items: list[dict[str, Any]] = []
    out_of_scope_count = 0
    for row in findings:
        row_repo = _finding_repo_out_of_scope(row, repo)
        if row_repo is not None:
            out_of_scope_count += 1
            continue
        extra = row.get("extra") or {}
        metadata = extra.get("metadata") or {}
        verification = extra.get("verification") or {}
        report_items.append({
            "id": row["id"],
            "asset": row["asset"],
            "asset_kind": row["asset_kind"],
            "severity": row["severity"],
            "summary": row["summary"],
            "status": row["status"],
            "path": metadata.get("path"),
            "source": metadata.get("source"),
            "commit": metadata.get("commit"),
            "verification_status": verification.get("status"),
            "scan_trace": _scan_trace_from_metadata(metadata),
            "hits": extra.get("hits") or [],
            "recommended_actions": extra.get("recommended_actions") or [],
        })
    summary = _report_summary(report_items)
    html = _report_html(
        repo,
        report_items,
        summary,
        recipient=str(thread.get("owner_recipient") or thread.get("recipient") or ""),
        cycle_summary=cycle_summary,
        sent_notice_count=state.thread_sent_notice_count("github", thread_id),
    )
    return {
        "repo": repo,
        "thread_id": thread_id,
        "finding_count": len(report_items),
        "out_of_scope_count": out_of_scope_count,
        **cycle_summary,
        "summary": summary,
        "verification_counts": summary["verification_counts"],
        "findings": report_items,
        "html": html,
    }


def github_report_mail_subject(repo: str) -> str:
    # ★ 대상(저장소)은 **맨 뒤**로 — 4도메인 공용 조립기.
    from _shared.mail_subject import compose_subject

    return compose_subject(state.normalize_github_subject_tag(repo), "소스코드 시크릿 조치 요청")







def _repo_owner_recipients(repo: str) -> list[str]:
    """저장소 담당자 → 수신자 후보. finding extra 에 없을 때의 **2차 출처**다.

    ★ 왜 필요한가: finding 의 `author_email` 은 **그 커밋을 올린 사람**이고, 저장소를 실제로
    관리하는 사람과 다를 수 있다. 그리고 신 스캔 경로에는 한동안 그 값이 아예 없었다.
    `github_repo_owner`(저장소 축, 다른 세션이 knox 조회로 채운다)를 폴백으로 둔다.

    ⚠️ 주소를 **여기서 조립하지 않는다.** 그 테이블이 갖고 있는 건 Knox ID(`donghun.yi`)지
    메일이 아니고, `knox_id → 메일` 규칙은 `knox_directory.Employee.email` 이 소유한다.
    규칙을 두 곳에 적으면 어긋난다(오늘 네 번 봤다).
    """
    name = str(repo or "").strip()
    if not name:
        return []
    try:
        row = state.github_repo_owner_get(name)
    except Exception:  # noqa: BLE001 — 담당자 조회 실패가 스레드 생성을 막지 않는다
        return []
    knox_id = str((row or {}).get("knox_id") or "").strip()
    if not knox_id:
        return []
    from service.services.knox_directory import Employee

    return _owner_recipient_list([Employee(knox_id=knox_id).email])


def _github_dssoc_recipients() -> list[str]:
    return (
        _csv(os.environ.get("GITHUB_REMEDIATION_DSSOC_RECIPIENT"))
        or _csv(os.environ.get("SA_DSSOC_MAIL_RECIPIENT"))
        or ["dssoc@samsung.com"]
    )


def github_report_delivery_targets(
    owner_recipients: list[str] | None = None, *, manual: bool = False,
) -> dict[str, Any]:
    """조치요청 메일 수신처 — **담당자 + DSSOC**. DSSOC 만 보내는 건 드라이런 때뿐이다.

    규칙은 `owner_recipients.delivery_targets` 가 소유한다. 예전엔 4도메인이 같은 분기를
    각자 들고 있었고 기본값이 `dssoc_only` 였다 — 실발송이 켜져도 담당자가 빠지는 구멍이
    거기 있었다(자율발송 스위치와 수신처 스위치가 서로를 몰랐다).
    """
    return orx.delivery_targets(
        owner_recipients,
        mode_env="GITHUB_REMEDIATION_MAIL_MODE",
        dssoc_env_names=("GITHUB_REMEDIATION_DSSOC_RECIPIENT", "SA_DSSOC_MAIL_RECIPIENT"),
        manual=manual,
    )


def _mail_body(body: Any, *, limit: int = _MAIL_BODY_LIMIT) -> str:
    """길면 자른다. **잘렸다는 사실은 담당자에게 보여야 한다.**

    예전엔 `<!-- … truncated -->` HTML 주석이었다. 주석은 메일 클라이언트에서
    안 보이므로 담당자는 **본문이 잘린 줄도 몰랐다** — 조치 대상을 놓친다.

    ⚠️ 이 함수를 포함해 메일 본문 경로에 HTML 주석을 넣지 마라. 주석은 그대로
      실려 나가고, 우리에게만 의미 있는 내부 메모가 담당자에게 간다
      (2026-08-24 dev_web 에서 실제로 그럴 뻔했다).
    """
    raw = str(body or "")
    if len(raw) > limit:
        return raw[:limit].rstrip() + (
            '\n<p style="color:#8a6d3b">※ 본문이 길어 일부만 표시했습니다. '
            "전체 내용이 필요하시면 본 메일로 문의해 주세요.</p>"
        )
    return raw


def _record_outbound_message(
    thread: dict[str, Any],
    *,
    subject: str,
    body: str,
    recipients: list[str],
    cc: list[str] | None = None,
    message_kind: str,
    reply_message: dict[str, Any] | None = None,
) -> None:
    thread_id = int(thread["id"])
    repo = str(thread.get("repo") or "")
    state.service_reply_message_add(
        domain="github",
        direction="out",
        thread_id=thread_id,
        in_reply_to=(
            (reply_message or {}).get("message_id")
            or (reply_message or {}).get("in_reply_to")
        ),
        references_header=(reply_message or {}).get("references_header"),
        root_message_id=(reply_message or {}).get("root_message_id"),
        subject=subject,
        subject_tag=thread.get("subject_tag") or state.normalize_github_subject_tag(repo),
        mail_from="dssoc",
        mail_to=", ".join(recipients) or None,
        mail_cc=", ".join(cc or []) or None,
        body_excerpt=body,
        body_html=body,
        agent_verdict="sent",
        decision_reason=message_kind,
    )


def _decision_from_service_message(message: dict[str, Any]) -> str | None:
    verdict = str(message.get("agent_verdict") or "")
    prefix = "classified_"
    return verdict[len(prefix):] if verdict.startswith(prefix) else None


def _attach_preexisting_replies(
    thread: dict[str, Any],
    *,
    repo: str,
    received_after: float,
) -> list[dict[str, Any]]:
    thread_id = int(thread["id"])
    subject_tag = thread.get("subject_tag") or state.normalize_github_subject_tag(repo)
    attached = state.service_reply_message_attach_unmatched(
        "github",
        str(subject_tag),
        thread_id,
        received_after=received_after,
    )
    if not attached:
        return []
    latest = attached[-1]
    decision = _decision_from_service_message(latest)
    if decision:
        reason = str(latest.get("decision_reason") or "pre-existing inbound reply attached")
        state.service_report_thread_mark_reply_decision(
            "github",
            thread_id,
            decision=decision,
            reason=f"pre-existing inbound replies attached: {len(attached)}; {reason}",
        )
    else:
        state.github_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            last_reason=f"pre-existing inbound replies attached: {len(attached)}",
        )
    return attached


def _report_finding_count(report: dict[str, Any]) -> int:
    if "finding_count" in report:
        try:
            return int(report.get("finding_count") or 0)
        except (TypeError, ValueError):
            return 0
    findings = report.get("findings")
    return len(findings) if isinstance(findings, list) else 0


def _mark_empty_report_error(thread_id: int, report: dict[str, Any], *, action: str) -> str:
    out_of_scope = int(report.get("out_of_scope_count") or 0)
    reason = f"report {action} skipped: no in-scope findings (out_of_scope_count={out_of_scope})"
    state.github_report_thread_set_status(
        thread_id,
        "error",
        report_json="{}",
        report_html=None,
        notified_at=None,
        last_reason=reason,
    )
    return reason


def _skip_empty_report_delivery(thread_id: int, report: dict[str, Any]) -> dict[str, Any]:
    reason = _mark_empty_report_error(thread_id, report, action="delivery")
    return {
        "mode": "skipped_empty_report",
        "detail": reason,
        "recipients": [],
        "cc": [],
        "policy": "blocked_empty_report",
        "subject": None,
        "draft_path": None,
        "scan_hits": [],
        "attached_replies": 0,
    }


async def deliver_report_for_thread(
    thread: dict[str, Any],
    report: dict[str, Any],
    *,
    evidence_dir: Path,
    charter_ref: str = "",
) -> dict[str, Any]:
    """Deliver a built GitHub report through the core egress gate."""
    thread_id = int(thread["id"])
    if _report_finding_count(report) <= 0:
        return _skip_empty_report_delivery(thread_id, report)
    repo = str(thread.get("repo") or report.get("repo") or "")
    requested = _owner_recipient_list([thread.get("owner_recipient") or thread.get("recipient")])
    targets = github_report_delivery_targets(requested)
    subject = github_report_mail_subject(repo)
    # ★ 티켓번호를 제목 앞에 찍는다 — 회신 매칭의 1차 키다.
    #   기존 제목 태그는 지우지 않는다(폴백 경로가 그걸 본다).
    subject = state.stamp_subject_for_thread(subject, "github", thread_id)
    body = _mail_body(report.get("html"))
    payload = DeliveryPayload(
        subject=subject,
        body=body,
        recipients=tuple(targets["recipients"]),
        cc=tuple(targets["cc"]),
        finding_id=int(thread.get("finding_id") or 0) or None,
        metadata={
            "domain": "github",
            "thread_id": thread_id,
            "repo": repo,
            "delivery_policy": targets["mode"],
            "requested_recipients": [r for r in requested if r],
            "cycle_key": thread.get("last_cycle_key"),
        },
    )
    # ★ 자동 최초 발송이 닫혀 있으면 **발송을 시도하지 않는다** ("제작까지만").
    #   수신처가 비어 있어 그대로 부르면 sink 가 "TO 수신자가 없습니다" 로 매분 터진다
    #   (리포트 러너는 간격 0분 = 매분 실행, 대기 큐 수백 건).
    #   초안(report_json/report_html)은 이미 위에서 만들어 저장했다.
    if str(targets.get("mode") or "") == "initial_closed":
        state.github_report_thread_set_status(
            thread_id, "report_ready",
            last_reason=str(targets.get("reason") or "자동 최초 발송 닫힘 — 초안만 저장"),
        )
        return {
            "mode": "initial_closed", "sent": False,
            "reason": targets.get("reason"),
            "note": "초안만 저장했다. 발송하려면 콘솔에서 수동 승인하라.",
        }

    delivery_started_at = time.time()
    result = await deliver(
        "knox_mail",
        payload,
        evidence_dir=Path(evidence_dir),
        charter_ref=charter_ref,
    )
    if result.mode == "sent":
        state.github_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            recipient=", ".join(targets["recipients"]) or None,
            notified_at=time.time(),
            last_reason="report mailed",
        )
        _record_outbound_message(
            thread,
            subject=subject,
            body=body,
            recipients=list(targets["recipients"]),
            cc=list(targets["cc"]),
            message_kind="outbound_report_notice",
        )
        attached_replies = _attach_preexisting_replies(
            thread,
            repo=repo,
            received_after=delivery_started_at,
        )
    else:
        attached_replies = []
        state.github_report_thread_set_status(
            thread_id,
            "report_ready",
            last_reason=result.detail[:500],
        )
    return {
        "mode": result.mode,
        "detail": result.detail,
        "recipients": list(targets["recipients"]),
        "cc": list(targets["cc"]),
        "policy": targets["mode"],
        "subject": subject,
        "draft_path": result.draft_path,
        "scan_hits": list(result.scan_hits),
        "attached_replies": len(attached_replies),
    }


def github_recheck_mail_subject(repo: str) -> str:
    return f"RE: {state.normalize_github_subject_tag(repo)} 소스코드 시크릿 재검증 결과"




def _github_recheck_body(thread: dict[str, Any], result: dict[str, Any]) -> str:
    from service.services.sensitive_summary import recheck_status_label

    repo = _html(str(thread.get("repo") or result.get("repo") or ""))
    # ⚠️ 예전엔 `now_closed` 같은 **엔진 내부 키가 그대로** 나갔다. 행별 `결과` 열은 번역돼
    #    있는데 여기만 원문이라 같은 메일 안에서 어긋나기까지 했다.
    final_status = _html(recheck_status_label(result.get("final_status")))
    # `확인 시점 HEAD` — 담당자가 "어느 시점 기준으로 확인했나" 를 알아야 재조치를 판단한다.
    # scan 요약에 없으면 항목의 verification 에서 가져온다(예전엔 행별 증거 문자열에 있었는데
    # 그 열을 빼면서 사라질 뻔했다 — 진단은 빼되 **기준 시점은 남긴다**).
    _head = str((result.get("scan") or {}).get("head_sha") or "").strip()
    if not _head:
        for _item in result.get("results") or []:
            if isinstance(_item, dict):
                _v = _item.get("verification") if isinstance(_item.get("verification"), dict) else {}
                _head = str(_v.get("head_sha") or "").strip()
                if _head:
                    break
    head_sha = _html(_head or "-")
    rows: list[str] = []
    verdict_label = {
        "now_closed": "현재 HEAD에서 미검출",
        "still_open": "현재 HEAD에서 재확인",
        "unknown": "재검증 보류",
    }
    for item in result.get("results") or []:
        if not isinstance(item, dict):
            continue
        path = _html(str(item.get("path") or "-"))
        verdict = str(item.get("verdict") or "unknown")
        # ★ `검증 근거` 는 예전에 `api_code_search_detail_scan matched HEAD abc123 detail
        #   fetched` 같은 **영문 내부 진단**이었다. 조치요청 메일에서 스캔 방식·후보 출처를
        #   뺀 것과 같은 이유로 뺀다 — 우리 진단이지 담당자가 할 일이 아니다.
        #   `finding_id`(DB 내부 id) 열도 뺐다: 담당자에게 아무 뜻이 없다.
        rows.append(
            "<tr>"
            f"<td><code>{path}</code></td>"
            f"<td>{_html(verdict_label.get(verdict, verdict))}</td>"
            "</tr>"
        )
    if not rows:
        rows.append("<tr><td colspan=\"2\">표시할 재검증 항목이 없습니다.</td></tr>")
    status = str(result.get("final_status") or "")
    if status in {"still_open", "partially_remediated"}:
        guidance = "현재 HEAD에서 다시 확인되는 항목은 토큰 폐기/재발급과 저장소 정리를 다시 확인해 주세요."
    elif status == "remediated":
        guidance = "현재 HEAD 기준으로 기존 항목이 확인되지 않았습니다. 노출된 값은 재사용 방지를 위해 폐기 상태를 유지해 주세요."
    else:
        guidance = "현재 HEAD 재확인이 보류되었습니다. 일시 오류나 접근 제한이 해소되면 다시 확인하겠습니다."
    return f"""<div style="font-family:'Malgun Gothic',Arial,sans-serif;line-height:1.6">
<p>안녕하세요.</p>
<p><b>{repo}</b> 저장소 시크릿 조치 회신에 대한 재검증 결과를 안내드립니다.</p>
<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:13px">
  <tr>
    <th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">저장소</th>
    <td style="border:1px solid #d9e2ec;padding:8px">{repo}</td>
  </tr>
  <tr>
    <th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">재검증 상태</th>
    <td style="border:1px solid #d9e2ec;padding:8px">{final_status}</td>
  </tr>
  <tr>
    <th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">확인 시점 HEAD</th>
    <td style="border:1px solid #d9e2ec;padding:8px">{head_sha}</td>
  </tr>
</table>
<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:13px">
  <thead><tr>
    <th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">위치</th>
    <th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">결과</th>
  </tr></thead>
  <tbody>{''.join(rows)}</tbody>
</table>
<p>{_html(guidance)}</p>
<p>감사합니다.<br/>DS보안관제 (정보보호)</p>
</div>"""


def finalize_github_recheck_result(
    thread: dict[str, Any],
    result: dict[str, Any],
    *,
    mailed: bool = False,
    recipient: str | None = None,
) -> str:
    thread_id = int(thread["id"])
    final_status = _github_recheck_result_final_status(result)
    if not mailed and final_status in _GITHUB_RECHECK_DELIVERY_REQUIRED_STATUSES:
        state.github_report_thread_schedule_recheck_retry(
            thread_id,
            reason=f"recheck {final_status} blocked until result mail is sent",
        )
        return "recheck_requested"
    fields: dict[str, Any] = {"last_reason": f"recheck {final_status}"}
    if mailed:
        fields["last_reason"] = f"recheck {final_status}; result mailed"
        fields["notified_at"] = time.time()
        if recipient:
            fields["recipient"] = recipient
    state.github_report_thread_set_status(thread_id, final_status, **fields)
    for item in result.get("results") or []:
        if not isinstance(item, dict) or item.get("verdict") != "now_closed":
            continue
        try:
            core_state.finding_set_status(
                int(item["finding_id"]),
                "remediated",
                reason="github recheck now_closed",
            )
        except Exception:
            pass
    return final_status


async def deliver_recheck_result_for_thread(
    thread: dict[str, Any],
    result_payload: dict[str, Any],
    *,
    evidence_dir: Path,
    charter_ref: str = "",
) -> dict[str, Any]:
    """Notify the recheck result and finalize only after a sent delivery."""
    thread_id = int(thread["id"])
    safe_final_status = _github_recheck_result_final_status(result_payload)
    if safe_final_status == "recheck_requested":
        reason = "recheck result delivery skipped: no conclusive structured results"
        retry_after = state.github_report_thread_schedule_recheck_retry(thread_id, reason=reason)
        return {
            "mode": "skipped_retryable_recheck",
            "detail": reason,
            "recipients": [],
            "cc": [],
            "policy": "blocked_retryable_recheck",
            "subject": None,
            "draft_path": None,
            "scan_hits": [],
            "final_status": "recheck_requested",
            "retry_after": retry_after,
        }
    result_payload = {**result_payload, "final_status": safe_final_status}
    repo = str(thread.get("repo") or result_payload.get("repo") or "")
    reply_message = state.service_reply_message_latest_inbound_after_latest_outbound(
        "github",
        thread_id,
        fallback_outbound_at=thread.get("notified_at"),
    )
    requested = _owner_recipient_list([thread.get("owner_recipient") or thread.get("recipient")])
    if reply_message is not None:
        recipients, cc = reply_targets(
            reply_message,
            dssoc_recipients=_github_dssoc_recipients(),
        )
        targets = {"mode": "reply_to_inbound_sender", "recipients": recipients, "cc": cc}
        subject = reply_subject(
            thread.get("subject_tag") or state.normalize_github_subject_tag(repo),
            original_subject=str(reply_message.get("subject") or ""),
        )
    else:
        targets = github_report_delivery_targets(requested)
        subject = github_recheck_mail_subject(repo)
    # ★ 재검증 결과 회신에도 같은 티켓을 찍는다 — 담당자가 다시 답장하면 붙는다.
    #   ⚠️ if/else **밖**이다. 처음엔 else 가지(신규 발송)에만 넣었는데, 정작 중요한 건
    #      위쪽 가지 — **담당자 답장에 회신하는** 경로다. 거기 안 찍으면 다음 왕복부터
    #      티켓 1차 키가 사라지고 제목 태그 폴백으로 되돌아간다.
    subject = state.stamp_subject_for_thread(subject, "github", thread_id)
    body = _github_recheck_body(thread, result_payload)
    if reply_message is not None:
        body = append_original_message(body, reply_message)
    metadata = {
        "domain": "github",
        "thread_id": thread_id,
        "repo": repo,
        "delivery_policy": targets["mode"],
        "content_type": "HTML",
        "requested_recipients": [r for r in requested if r],
        "cycle_key": thread.get("last_cycle_key"),
        "recheck_final_status": result_payload.get("final_status"),
    }
    if reply_message is not None:
        metadata.update({
            "reply_message_id": int(reply_message["id"]),
            "in_reply_to": reply_message.get("message_id") or reply_message.get("in_reply_to"),
            "references": reply_message.get("references_header"),
            "root_message_id": reply_message.get("root_message_id"),
            "delivery_allowed_pii_values": allowed_pii_values(
                reply_message.get("mail_from"),
                reply_message.get("mail_to"),
                reply_message.get("mail_cc"),
                *targets["recipients"],
                *targets["cc"],
            ),
        })
    payload = DeliveryPayload(
        subject=subject,
        body=body,
        recipients=tuple(targets["recipients"]),
        cc=tuple(targets["cc"]),
        finding_id=int(thread.get("finding_id") or 0) or None,
        metadata=metadata,
    )
    delivery = await deliver(
        "knox_mail",
        payload,
        evidence_dir=Path(evidence_dir),
        charter_ref=charter_ref,
    )
    retry_after = None
    if delivery.mode == "sent":
        final_status = finalize_github_recheck_result(
            thread,
            result_payload,
            mailed=True,
            recipient=", ".join(targets["recipients"]) or None,
        )
        _record_outbound_message(
            thread,
            subject=subject,
            body=body,
            recipients=list(targets["recipients"]),
            cc=list(targets["cc"]),
            message_kind="outbound_recheck_result_notice",
            reply_message=reply_message,
        )
    else:
        final_status = "recheck_requested"
        retry_after = state.github_report_thread_schedule_recheck_retry(
            thread_id,
            reason=f"recheck result delivery {delivery.mode}: {delivery.detail or 'not sent'}",
        )
    return {
        "mode": delivery.mode,
        "detail": delivery.detail,
        "recipients": list(targets["recipients"]),
        "cc": list(targets["cc"]),
        "policy": targets["mode"],
        "subject": subject,
        "draft_path": delivery.draft_path,
        "scan_hits": list(delivery.scan_hits),
        "final_status": final_status,
        "retry_after": retry_after,
    }


def _report_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    verification_counts: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    scan_method_counts: dict[str, int] = {}
    severity_counts: dict[str, int] = {}
    paths: set[str] = set()
    masked_hits = 0
    for item in items:
        verification = str(item.get("verification_status") or "unknown")
        verification_counts[verification] = verification_counts.get(verification, 0) + 1
        source = str(item.get("source") or "unknown")
        source_counts[source] = source_counts.get(source, 0) + 1
        scan_trace = item.get("scan_trace") if isinstance(item.get("scan_trace"), dict) else {}
        scan_method = str(scan_trace.get("scan_method") or "unknown")
        scan_method_counts[scan_method] = scan_method_counts.get(scan_method, 0) + 1
        severity = str(item.get("severity") or "informational")
        severity_counts[severity] = severity_counts.get(severity, 0) + 1
        # ⚠️ 커밋 단위 finding 은 `path` 가 없다 — asset 이 `github:repo/commit/sha` 라
        #    파일이 아니라 커밋을 가리키고, 파일명은 `metadata.files` 배열에 들어간다
        #    (`service_task_tools` 가 `[f["filename"] for f in commit.files]` 로 넣는다).
        #    그래서 `unique_paths=0` 인데 근거는 28건인 메일이 나갔다(실측 #301) — 받는
        #    사람은 **"영향 없음"** 으로 읽는다. 표엔 3행이 뜨는데 경로는 0이라 앞뒤도 안 맞았다.
        #    실측 분포(이번 주차 81건): api_code_search_detail_scan 74건은 path 가 있고
        #    커밋·릴리스 경로만 비어 있다.
        if item.get("path"):
            paths.add(str(item["path"]))
        else:
            meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            for fname in (meta.get("files") or []):
                if str(fname or "").strip():
                    paths.add(str(fname).strip())
        masked_hits += len([h for h in item.get("hits") or [] if isinstance(h, dict) and h.get("masked")])
    return {
        "verification_counts": verification_counts,
        "source_counts": source_counts,
        "scan_method_counts": scan_method_counts,
        "severity_counts": severity_counts,
        "live_head": int(verification_counts.get("live_in_HEAD", 0)),
        "historical_only": int(verification_counts.get("historical_only", 0)),
        "unique_paths": len(paths),
        "masked_hit_count": masked_hits,
        "highest_severity": _highest_severity(items),
    }


def _highest_severity(items: list[dict[str, Any]]) -> str:
    rank = _sev.RANK  # SSOT — 같은 맵이 state_domain 에 4벌 더 있었다
    best = "informational"
    for item in items:
        sev = str(item.get("severity") or "informational")
        if rank.get(sev, 0) > rank.get(best, 0):
            best = sev
    return best


def _report_html(
    repo: str,
    items: list[dict[str, Any]],
    summary: dict[str, Any],
    *,
    recipient: str = "",
    cycle_summary: dict[str, Any] | None = None,
    #: 이 스레드로 **실제로 나간** 안내 수. 재확인 문구의 유일한 근거다.
    sent_notice_count: int = 0,
) -> str:
    # ★ 정책: **그릇은 보여주고 내용물은 감춘다.**
    #   담당자가 가야 할 위치(경로/커밋)는 남기고, 그 안에서 발견된 값(`마스킹 값` 열)과
    #   우리 내부 진단(`스캔 방식`·`후보 출처`)은 뺀다. 조치요청 메일은 전달·회신으로 퍼지고
    #   메일함에 남으므로, 값이 실리면 메일 자체가 새 노출 경로가 된다.
    #   원본은 `report_json` 에 그대로 남는다 — 줄이는 건 메일 본문뿐이다.
    from service.services import sensitive_summary as _ss

    sensitive = _ss.merge_counts(*[_ss.sensitive_counts(item.get("hits")) for item in items])
    rows = []
    for item in items:
        verification = str(item.get("verification_status") or "unknown")
        verification_class = "live" if verification == "live_in_HEAD" else "history"
        actions = item.get("recommended_actions") or []
        action_text = "; ".join(str(a) for a in actions[:2]) or "Credential rotation and source cleanup"
        rows.append(
            "<tr>"
            f"<td><span class='badge badge-{_html(str(item.get('severity') or 'informational'))}'>"
            f"{_html(_severity_label(str(item.get('severity') or 'informational')))}</span></td>"
            f"<td><code>{_html(str(item.get('path') or item.get('asset') or '-'))}</code></td>"
            f"<td><span class='badge badge-{verification_class}'>{_html(_verification_label(verification))}</span></td>"
            f"<td>{_html(action_text)}</td>"
            "</tr>"
        )
    live = int(summary.get("live_head") or 0)
    history = int(summary.get("historical_only") or 0)
    visible_issue = []
    if live:
        visible_issue.append(f"현재 HEAD 노출 {live}건")
    if history:
        visible_issue.append(f"git history 노출 {history}건")
    issue_text = ", ".join(visible_issue) or "GitHub secret exposure 확인 필요"
    # ⚠️ `unique_paths` 는 commit 단위 finding 에서 0 이다(경로가 아니라 커밋이 단위라서).
    #    그대로 `0개` 로 찍으면 받는 사람은 **"영향 없음"** 으로 읽는다 — 실제로는 근거가
    #    수십 건인데도 그랬다(실측 #301: 영향 0개 / 마스킹된 근거 28건).
    #    세는 단위를 값에 밝힌다.
    unique_paths = int(summary.get("unique_paths") or 0)
    if unique_paths:
        impact_text = f"파일/경로 {unique_paths}개"
    elif items:
        impact_text = f"커밋·항목 {len(items)}건"
    else:
        impact_text = "-"
    recipient_html = _html(recipient or "담당자")
    warning = ""
    if live:
        warning = (
            "<div class='warning-card'><strong>현재 HEAD에 남아 있는 시크릿이 있습니다.</strong><br>"
            "노출된 토큰/키는 먼저 폐기 또는 재발급하고, 저장소 HEAD에서 제거해 주세요.</div>"
        )
    # ★ "이전에 안내드린" 은 **실제로 나갔을 때만** 말한다. 예전엔 스캔 주차로 말해서
    #   첫 발송인데도 "2주 누적 확인" 이 나갔다(2026-08-31 실측). 본 것 ≠ 알린 것.
    recurrence_notice = ""
    if should_show_recurrence(sent_notice_count):
        recurrence_notice = (
            f"<div class='warning-card'><strong>{_html(notice_recurrence_label(sent_notice_count))}</strong><br>"
            "이전에 안내드린 저장소 시크릿 노출 항목이 이번 주 점검에서도 다시 확인되었습니다. "
            "값 폐기/재발급과 저장소 정리를 한 번 더 점검해 주시기 바랍니다.</div>"
        )
    return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  {_REPORT_STYLES}
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>GitHub 소스코드 조치 요청</h1>
      <p>삼성전자 DS 정보보호센터 · DS보안관제</p>
    </div>
    <div class="content">
      <p class="lead">{recipient_html}님,</p>
      <p class="lead">DS보안관제에서 GitHub 저장소 시크릿 노출 점검 결과를 안내드립니다. 대상 저장소에서 노출 값 제거와 Credential 회전 확인이 필요합니다.</p>
      {recurrence_notice}
      {warning}
      {_ss.credential_notice_html(sensitive)}
      <div class="info-card">
        <div class="metric-grid">
          <div class="metric"><small>대상 저장소</small><strong>{_html(repo)}</strong></div>
          <div class="metric"><small>확인 내용</small><strong>{_html(issue_text)}</strong></div>
          <div class="metric"><small>요청 사항</small><strong>시크릿 폐기/재발급 및 소스 정리</strong></div>
          <div class="metric"><small>최고 심각도</small><strong>{_html(_severity_label(str(summary.get("highest_severity") or "informational")))}</strong></div>
          <div class="metric"><small>영향 범위</small><strong>{_html(impact_text)}</strong></div>
          {_ss.exposure_metric_html(int(summary.get("masked_hit_count") or 0), sensitive)}
        </div>
      </div>

      <div class="section-title"><span>■</span>내용</div>
      <div class="note">현재 HEAD에 남아 있는 항목은 즉시 회전 대상입니다. history-only 항목은 현재 파일에서는 제거되었더라도 git history에 남아 있을 수 있으므로, 토큰 회전과 history 접근 범위 확인이 필요합니다.</div>

      {_ss.summary_html(sensitive, container_word="저장소")}

      {_ss.actions_html(sensitive)}

      <div class="section-title"><span>■</span>조치 방법</div>
      <ol>
        <li>노출된 토큰, 키, 비밀번호는 먼저 폐기 또는 재발급해 주세요.</li>
        <li>현재 HEAD에 남은 값은 저장소에서 제거하고 secret manager 또는 환경변수로 이동해 주세요.</li>
        <li>history-only 항목은 토큰 회전 후 필요 시 git history 정리 또는 저장소 접근 제한을 검토해 주세요.</li>
        <li>같은 값이 sibling repo, Jenkinsfile, GitHub Actions workflow, 배포 스크립트에 재사용되었는지 확인해 주세요.</li>
        <li>조치 후 본 메일 또는 시스템에서 재검증을 요청해 주세요. DS보안관제에서 HEAD 기준으로 다시 확인하겠습니다.</li>
      </ol>

      <div class="section-title"><span>■</span>확인된 항목</div>
      <table>
        <tr><th style="width:10%">심각도</th><th style="width:42%">위치</th><th style="width:14%">현재 상태</th><th style="width:34%">권장 조치</th></tr>
        {''.join(rows) if rows else '<tr><td colspan="4">표시할 항목이 없습니다.</td></tr>'}
      </table>

      <div class="footer">
        <p>감사합니다.</p>
        <p><strong>DS보안관제 (정보보호)</strong></p>
      </div>
    </div>
  </div>
</body>
</html>"""


def _severity_label(value: str) -> str:
    return _SEV_KO.get(value, value or "-")


def _verification_label(value: str) -> str:
    return _VERIFICATION_LABELS.get(value, value or "-")


def _html(text: str) -> str:
    return escape(str(text or ""), quote=True)


def mark_report_ready(thread: dict[str, Any], report: dict[str, Any]) -> None:
    thread_id = int(thread["id"])
    if _report_finding_count(report) <= 0:
        _mark_empty_report_error(thread_id, report, action="ready")
        return
    state.github_report_thread_set_status(
        thread_id,
        "report_ready",
        report_json=json.dumps(
            {k: v for k, v in report.items() if k != "html"},
            ensure_ascii=False,
            sort_keys=True,
        ),
        report_html=report.get("html"),
        last_reason=f"report built with {report.get('finding_count', 0)} findings",
    )
    state.github_report_thread_bump_attempt(thread_id, reason="report built")


def _original_hit_signatures(row: dict[str, Any]) -> set[tuple[str, str, str | None]]:
    extra = row.get("extra") or {}
    metadata = extra.get("metadata") or {}
    path = metadata.get("path")
    out: set[tuple[str, str, str | None]] = set()
    for hit in extra.get("hits") or []:
        if not isinstance(hit, dict):
            continue
        out.add((str(hit.get("kind") or ""), str(hit.get("masked") or ""), path))
    return {x for x in out if x[0] and x[1]}


def _current_api_signatures(repo: str, path: str, text: str) -> set[tuple[str, str, str]]:
    findings = github_scan._findings_from_text(text, repo, path, "worktree", None)
    return {(finding.kind, finding.masked, finding.path) for finding in findings}


def _fetch_api_recheck_text(repo: str, path: str, *, ref: str) -> tuple[str | None, str | None]:
    detail = getattr(gh, "fetch_file_at_ref_detail", None)
    if detail is not None and getattr(gh.fetch_file_at_ref, "__name__", "") == "fetch_file_at_ref":
        text, missing_reason = detail(repo, path, ref=ref)
        return text, missing_reason
    text = gh.fetch_file_at_ref(repo, path, ref=ref)
    return text, "not_found" if text is None else None


def _finding_repo_out_of_scope(row: dict[str, Any], repo: str) -> str | None:
    row_repo = repo_from_finding(row)
    if row_repo and row_repo != "unknown" and row_repo.lower() != str(repo or "").lower():
        return row_repo
    return None


def _api_recheck_rows(
    *,
    repo: str,
    rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    meta: dict[str, Any] = {
        "strategy": "api_first",
        "method": _API_RECHECK_METHOD,
        "head_sha": None,
        "detail_fetched": 0,
        "detail_missing": 0,
        "errors": [],
        "unavailable": False,
        "auth_failed": False,
        "limit_failed": False,
        "out_of_scope_count": 0,
    }
    try:
        meta["head_sha"] = gh.repo_head_sha(repo, "HEAD")
    except Exception as exc:  # noqa: BLE001
        meta["errors"].append(_api_error("repo_head_sha", exc, ref="HEAD"))
        status_code = _http_status_code(exc)
        if _api_limit_failed(exc):
            meta["limit_failed"] = True
            return [
                {
                    "finding_id": int(row["id"]),
                    "path": (row.get("extra") or {}).get("metadata", {}).get("path"),
                    "verdict": "unknown",
                    "verification": {
                        "method": _API_RECHECK_METHOD,
                        "matched": False,
                        "head_sha": None,
                        "status_code": status_code,
                        "limit_failed": True,
                    },
                    "error": repr(exc)[:500],
                }
                for row in rows
            ], meta
        if _api_auth_failed(exc):
            meta["auth_failed"] = True
            return [
                {
                    "finding_id": int(row["id"]),
                    "path": (row.get("extra") or {}).get("metadata", {}).get("path"),
                    "verdict": "unknown",
                    "verification": {
                        "method": _API_RECHECK_METHOD,
                        "matched": False,
                        "head_sha": None,
                        "status_code": status_code,
                    },
                    "error": repr(exc)[:500],
                }
                for row in rows
            ], meta
        if status_code in {403, 404}:
            return [
                {
                    "finding_id": int(row["id"]),
                    "path": (row.get("extra") or {}).get("metadata", {}).get("path"),
                    "verdict": "unknown",
                    "verification": {
                        "method": _API_RECHECK_METHOD,
                        "matched": False,
                        "head_sha": None,
                        "status_code": status_code,
                    },
                    "error": repr(exc)[:500],
                }
                for row in rows
            ], meta
        if _api_unavailable(exc):
            meta["unavailable"] = True
            return [], meta
    if not meta.get("head_sha"):
        meta["head_missing"] = True
        return [
            {
                "finding_id": int(row["id"]),
                "path": (row.get("extra") or {}).get("metadata", {}).get("path"),
                "verdict": "unknown",
                "verification": {
                    "method": _API_RECHECK_METHOD,
                    "matched": False,
                    "head_sha": None,
                },
                "error": "GitHub HEAD ref not found",
            }
            for row in rows
        ], meta

    results: list[dict[str, Any]] = []
    for row in rows:
        metadata = (row.get("extra") or {}).get("metadata") or {}
        path = str(metadata.get("path") or "").strip()
        finding_id = int(row["id"])
        row_repo = _finding_repo_out_of_scope(row, repo)
        if row_repo is not None:
            meta["out_of_scope_count"] += 1
            results.append({
                "finding_id": finding_id,
                "path": path or None,
                "verdict": "unknown",
                "verification": {
                    "method": _API_RECHECK_METHOD,
                    "matched": False,
                    "head_sha": meta.get("head_sha"),
                    "repo": row_repo,
                },
                "error": f"finding repo outside thread scope: {row_repo}",
            })
            continue
        if not path:
            results.append({
                "finding_id": finding_id,
                "path": None,
                "verdict": "unknown",
                "verification": {
                    "method": _API_RECHECK_METHOD,
                    "matched": False,
                    "head_sha": meta.get("head_sha"),
                },
                "error": "missing finding metadata.path",
            })
            continue
        invalid_path = _invalid_repo_path_reason(
            path,
            subject="finding metadata.path",
        )
        if invalid_path:
            results.append({
                "finding_id": finding_id,
                "path": path,
                "verdict": "unknown",
                "verification": {
                    "method": _API_RECHECK_METHOD,
                    "matched": False,
                    "head_sha": meta.get("head_sha"),
                },
                "error": invalid_path,
            })
            continue
        try:
            text, missing_reason = _fetch_api_recheck_text(
                repo,
                path,
                ref=str(meta["head_sha"]),
            )
        except Exception as exc:  # noqa: BLE001
            meta["errors"].append(
                _api_error("fetch_file_at_ref", exc, path=path, ref=str(meta["head_sha"])),
            )
            if _api_auth_failed(exc):
                meta["auth_failed"] = True
            limit_failed = _api_limit_failed(exc)
            if limit_failed:
                meta["limit_failed"] = True
            if _api_unavailable(exc):
                meta["unavailable"] = True
                return [], meta
            verification = {
                "method": _API_RECHECK_METHOD,
                "matched": False,
                "head_sha": meta.get("head_sha"),
            }
            status_code = _http_status_code(exc)
            if status_code is not None:
                verification["status_code"] = status_code
            if limit_failed:
                verification["limit_failed"] = True
            results.append({
                "finding_id": finding_id,
                "path": path,
                "verdict": "unknown",
                "verification": verification,
                "error": repr(exc)[:500],
            })
            continue
        if text is None:
            meta["detail_missing"] += 1
            if missing_reason != "not_found":
                results.append({
                    "finding_id": finding_id,
                    "path": path,
                    "verdict": "unknown",
                    "verification": {
                        "method": _API_RECHECK_METHOD,
                        "matched": False,
                        "head_sha": meta.get("head_sha"),
                        "detail_fetched": False,
                        "missing_reason": missing_reason or "unknown",
                    },
                    "error": f"GitHub content detail not inspectable: {missing_reason or 'unknown'}",
                })
                continue
            matched = False
        else:
            meta["detail_fetched"] += 1
            matched = bool(_original_hit_signatures(row) & _current_api_signatures(repo, path, text))
        verdict = "still_open" if matched else "now_closed"
        verification = {
            "method": _API_RECHECK_METHOD,
            "matched": matched,
            "head_sha": meta.get("head_sha"),
            "detail_fetched": text is not None,
        }
        if text is None and missing_reason:
            verification["missing_reason"] = missing_reason
        results.append({
            "finding_id": finding_id,
            "path": path,
            "verdict": verdict,
            "verification": verification,
            "error": None,
        })
    return results, meta


def _clone_recheck_rows(
    *,
    repo: str,
    rows: list[dict[str, Any]],
    scan_findings: list[github_scan.ScanFinding],
    head_sha: str | None,
) -> list[dict[str, Any]]:
    current: set[tuple[str, str, str | None]] = set()
    for finding in scan_findings:
        if finding.source != "worktree":
            continue
        current.add((finding.kind, finding.masked, finding.path))
    out: list[dict[str, Any]] = []
    for row in rows:
        row_repo = _finding_repo_out_of_scope(row, repo)
        if row_repo is not None:
            out.append({
                "finding_id": int(row["id"]),
                "path": (row.get("extra") or {}).get("metadata", {}).get("path"),
                "verdict": "unknown",
                "verification": {
                    "method": "clone_head_rescan",
                    "matched": False,
                    "head_sha": head_sha,
                    "repo": row_repo,
                },
                "error": f"finding repo outside thread scope: {row_repo}",
            })
            continue
        live = bool(_original_hit_signatures(row) & current)
        out.append({
            "finding_id": int(row["id"]),
            "path": (row.get("extra") or {}).get("metadata", {}).get("path"),
            "verdict": "still_open" if live else "now_closed",
            "verification": {
                "method": "clone_head_rescan",
                "matched": live,
                "head_sha": head_sha,
            },
            "error": None,
        })
    return out


def _github_recheck_final_status(results: list[dict[str, Any]]) -> str:
    if not results:
        return "recheck_requested"
    verdicts = {str(r.get("verdict") or "unknown") for r in results}
    if any(v not in _GITHUB_RECHECK_VERDICTS for v in verdicts):
        return "recheck_requested"
    if "unknown" in verdicts:
        return "recheck_requested"
    still_open = "still_open" in verdicts
    now_closed = "now_closed" in verdicts
    if still_open and now_closed:
        return "partially_remediated"
    if still_open:
        return "still_open"
    if now_closed:
        return "remediated"
    return "recheck_requested"


def _github_recheck_result_final_status(result: dict[str, Any]) -> str:
    results = result.get("results")
    if not isinstance(results, list):
        return "recheck_requested"
    final_status = _github_recheck_final_status(results)
    return final_status if final_status in _GITHUB_RECHECK_FINAL_STATUSES else "recheck_requested"


def _persist_github_recheck_rows(thread_id: int, repo: str, results: list[dict[str, Any]]) -> None:
    for item in results:
        state.github_recheck_result_add(
            thread_id=thread_id,
            finding_id=int(item["finding_id"]) if item.get("finding_id") is not None else None,
            repo=repo,
            path=item.get("path"),
            verdict=str(item.get("verdict") or "unknown"),
            verification=item.get("verification") if isinstance(item.get("verification"), dict) else {},
            error=item.get("error"),
        )


def _write_github_recheck_evidence(
    *,
    evidence_dir: Path,
    repo: str,
    thread_id: int,
    final_status: str,
    results: list[dict[str, Any]],
    scan: dict[str, Any],
    charter_ref: str = "",
) -> str:
    api_scan = scan.get("api_scan") if isinstance(scan.get("api_scan"), dict) else {}
    evidence_ref = _evidence_path(evidence_dir, f"github-recheck-{repo or thread_id}")
    payload = {
        "kind": "github_recheck_evidence",
        "created_at": time.time(),
        "thread_id": thread_id,
        "repo": repo,
        "final_status": final_status,
        "auth_failed": bool(api_scan.get("auth_failed")),
        "limit_failed": bool(api_scan.get("limit_failed")),
        "results": results,
        "scan": scan,
    }
    if charter_ref:
        payload["charter_ref"] = charter_ref
    evidence_ref.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(evidence_ref)


def recheck_thread(
    thread: dict[str, Any],
    *,
    evidence_dir: Path,
    finalize: bool = True,
    charter_ref: str = "",
) -> dict[str, Any]:
    """API-refetch current HEAD first, then classify each thread finding."""
    repo = str(thread.get("repo") or "")
    thread_id = int(thread["id"])
    rows = _finding_rows(thread_id)
    results, api_scan = _api_recheck_rows(repo=repo, rows=rows)
    clone_fallback: dict[str, Any] = {"used": False}

    if api_scan.get("unavailable"):
        scan_findings, head_sha, scan_error = _clone_and_scan_repo(repo)
        clone_fallback = {
            "used": True,
            "head_sha": head_sha,
            "raw_finding_count": len(scan_findings),
            "error": scan_error,
        }
    else:
        scan_findings, head_sha, scan_error = [], api_scan.get("head_sha"), None

    if clone_fallback.get("used") and scan_error:
        failure_result = {
            "finding_id": None,
            "path": None,
            "verdict": "unknown",
            "verification": {
                "method": "clone_head_rescan",
                "matched": False,
                "head_sha": head_sha,
            },
            "error": scan_error,
        }
        _persist_github_recheck_rows(thread_id, repo, [failure_result])
        result = {
            "repo": repo,
            "thread_id": thread_id,
            "final_status": "recheck_requested",
            "results": [failure_result],
            "scan": {
                "head_sha": head_sha,
                "method": "clone_head_rescan",
                "api_scan": api_scan,
                "clone_fallback": clone_fallback,
            },
        }
        result["evidence_ref"] = _write_github_recheck_evidence(
            evidence_dir=evidence_dir,
            repo=repo,
            thread_id=thread_id,
            final_status=str(result["final_status"]),
            results=result["results"],
            scan=result["scan"],
            charter_ref=charter_ref,
        )
        if charter_ref:
            result["charter_ref"] = charter_ref
        if finalize:
            state.github_report_thread_set_status(
                thread_id,
                "recheck_requested",
                last_reason=f"recheck failed: {scan_error}",
            )
        return result

    if clone_fallback.get("used"):
        results = _clone_recheck_rows(
            repo=repo,
            rows=rows,
            scan_findings=scan_findings,
            head_sha=head_sha,
        )
    _persist_github_recheck_rows(thread_id, repo, results)
    final_status = _github_recheck_final_status(results)
    result = {
        "repo": repo,
        "thread_id": thread_id,
        "final_status": final_status,
        "results": [
            {
                k: v
                for k, v in item.items()
                if k in {"finding_id", "path", "verdict", "verification", "error"}
            }
            for item in results
        ],
        "scan": {
            "head_sha": head_sha,
            "method": "clone_head_rescan" if clone_fallback.get("used") else _API_RECHECK_METHOD,
            "api_scan": api_scan,
            "clone_fallback": clone_fallback,
        },
    }
    result["evidence_ref"] = _write_github_recheck_evidence(
        evidence_dir=evidence_dir,
        repo=repo,
        thread_id=thread_id,
        final_status=final_status,
        results=result["results"],
        scan=result["scan"],
        charter_ref=charter_ref,
    )
    if charter_ref:
        result["charter_ref"] = charter_ref
    if finalize:
        result["final_status"] = finalize_github_recheck_result(thread, result)
    return result


