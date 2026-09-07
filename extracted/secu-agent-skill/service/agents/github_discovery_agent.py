"""GitHub E2E repo discovery runner."""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
from pathlib import Path
from typing import Any, Protocol

from domains.services.application.devops_discovery import (
    repo_excluded,
)
from domains.services.github.application.contracts import (
    COMPONENT_GITHUB_DISCOVERY,
    COMPONENT_GITHUB_SEARCH_DISCOVERY,
    PHASE_GITHUB_DISCOVERY,
    PHASE_GITHUB_SEARCH_DISCOVERY,
)
from domains.services.github.application.scanner import (
    discover_repositories,
    discover_repositories_by_search,
)
from service import state_domain as state
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.github_discovery")


class SplunkSearchPort(Protocol):
    def search(self, spl: str, *, max_results: int) -> list[dict[str, Any]]:
        """Run a Splunk search and return rows."""


class _DefaultSplunkSearchClient:
    def enabled(self) -> bool:
        return bool(
            (os.environ.get("MCP_SPLUNK_URL") or "").strip()
            or (os.environ.get("SPLUNK_REST_URL") or "").strip()
        )

    def search(self, spl: str, *, max_results: int) -> list[dict[str, Any]]:
        if not self.enabled():
            raise RuntimeError("MCP_SPLUNK_URL or SPLUNK_REST_URL is required for GitHub SSO discovery")
        from service.collector import splunk_owner

        if (os.environ.get("MCP_SPLUNK_URL") or "").strip():
            return asyncio.run(splunk_owner._search_via_mcp(spl, max_results=max_results))
        return splunk_owner._search_via_rest(spl, max_results=max_results)


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def run_discovery_pass(
    *,
    max_repos: int | None = None,
    include_archived: bool = False,
    visibilities: tuple[str, ...] = ("public", "internal"),
) -> dict[str, Any]:
    load_runtime_env(load_plugins=False)
    component = COMPONENT_GITHUB_DISCOVERY
    state.heartbeat_upsert(component, phase=PHASE_GITHUB_DISCOVERY, pid=os.getpid())
    run_id = state.pipeline_run_start(component)
    status = "ok"
    detail = ""
    try:
        result = discover_repositories(
            visibilities=visibilities,
            include_archived=include_archived,
            max_repos=max_repos,
        )
        detail = f"enumerated={result['enumerated']} new={result['new']} total={result['after']['total']}"
        return result
    except Exception as e:  # noqa: BLE001
        status = "error"
        detail = repr(e)[:500]
        raise
    finally:
        state.heartbeat_upsert(component, phase="idle" if status == "ok" else "error", detail=detail, pid=os.getpid())
        state.pipeline_run_finish(run_id, status=status, detail=detail)


def _github_scope_screen(exclude_repos: list[str] | None = None):
    """등재 시점 범위 검사기. 꺼져 있으면 None(=기존 동작, 전부 등재).

    사유 문자열을 돌려준다(None = 범위 안, 큐에 넣는다):
      - `out_of_scope: excluded repo`   제외 목록(시크릿 스캐너/자사 도구 리포)
      - `no_access: repo metadata not found at ingestion`   우리가 못 읽는다
      - `out_of_scope: private repo`    점검 범위는 internal/public 이다

    프록시 로그 경로는 GitHub API 를 안 부르므로 못 읽는 repo 도 큐에 넣는다. 검색 경로는
    읽히는 repo 만 돌려주지만 **범위**는 모른다(권한 있는 private 이 섞인다). 둘 다 여기를 탄다.
    끄려면 `SA_DEVOPS_VISIBILITY_CHECK=0`.
    """
    if (os.environ.get("SA_DEVOPS_VISIBILITY_CHECK", "1") or "").strip().lower() in {
        "0", "false", "no", "off",
    }:
        return None
    from domains.services.github.plugin.agent_types import github as gh

    patterns = list(exclude_repos or [])

    def _screen(slug: str) -> str | None:
        if repo_excluded(slug, patterns):
            return "out_of_scope: excluded repo"
        meta = gh.repo_meta(slug)
        if meta is None:
            return "no_access: repo metadata not found at ingestion"
        # ⚠️ `private` 필드로 판정하면 안 된다 — GHES 는 **internal repo 에도 private=true** 를
        # 준다. 그걸로 걸렀다간 점검 대상의 본진인 internal 을 통째로 닫는다.
        # visibility 가 없는 구버전 응답이면 판정을 보류하고 살려둔다(닫는 쪽이 위험하다).
        if (meta.visibility or "").strip().lower() == "private":
            return "out_of_scope: private repo"
        return None

    return _screen


def _search_exclude_repos() -> list[str]:
    """제외 목록만 뽑아온다. 설정 로드가 깨져도 발견 자체는 굴러가야 한다."""
    try:
        return _load_search_keywords(None)[2]
    except Exception as e:  # noqa: BLE001
        log.warning("exclude_repos 로드 실패 — 제외 없이 진행: %r", e)
        return []


# ══════════════════════════════════════════════════════════════════════════════
# 프록시(Splunk) 발견 경로는 삭제됐다 (사용자 결정 2026-08-27)
# ══════════════════════════════════════════════════════════════════════════════
#
# 여기 `run_sso_discovery_pass()` 가 Splunk 프록시 로그에서 github URL 을 긁어
# `devops_target(service='github')` 에 적재했다. 문제는 구조적이었다:
#
#   프록시는 GitHub API 를 **한 번도 안 부른다** → visibility 를 알 방법이 없다
#   → 우리 토큰으로 못 읽는 private repo 도 "누가 방문했다" 는 이유로 큐에 들어온다
#
# 실측 2026-08-27, 같은 큐 안에서 출처별 비교:
#
#     출처          건수   error+skipped   finding
#     code_search    880     102 (12%)       32
#     proxy          466     271 (58%)       11
#
# 절반 넘게 열지도 못하는 것을 매 주기 다시 시도했다.
#
# ★ 대체가 아니라 **이미 있었다.** `run_search_discovery_pass()`(전역 `/search/code`)가
#   같은 큐를 채우고 있었고 이미 다수(65%)였다. 검색 인덱스는 **읽을 수 있는 repo 만**
#   돌려주므로 visibility 문제가 원리적으로 생기지 않는다.
#
# ⚠️ confluence 는 그대로다 — `confluence_discovery_agent.run_sso_discovery_pass()` 는
#    별개 함수이고, 위키는 "누가 봤나" 가 여전히 유효한 발견 신호다.
# ══════════════════════════════════════════════════════════════════════════════

_DEFAULT_SEARCH_KEYWORDS_FILE = (
    Path(__file__).resolve().parents[2]
    / "domains" / "services" / "github" / "config" / "search_keywords.yaml"
)


def _packaged_exclude_repos() -> list[str]:
    """패키지 YAML 의 `exclude_repos` 만 읽는다(키워드 출처와 무관하게 항상 적용)."""
    import yaml

    try:
        data = yaml.safe_load(_DEFAULT_SEARCH_KEYWORDS_FILE.read_text(encoding="utf-8")) or {}
    except Exception as e:  # noqa: BLE001
        log.warning("패키지 exclude_repos 로드 실패 — 제외 없이 진행: %r", e)
        return []
    return [str(x).strip() for x in (data.get("exclude_repos") or []) if str(x).strip()]


def _load_search_keywords(
    config_path: Path | None = None,
) -> tuple[str | None, list[dict[str, Any]], list[str]]:
    """코드검색 키워드 허용목록 로드. 우선순위: env 리스트 > 인자 > env 파일 > 패키지 기본 YAML.

    반환: (config_version, [{keyword, qualifiers|None}, ...], exclude_repos). confluence 로더와
    같은 계약이라 운영 절차(`--search-sync`, env override)를 도메인 간에 똑같이 쓸 수 있다.
    """
    import yaml

    env_inline = (os.environ.get("GITHUB_SEARCH_KEYWORDS") or "").strip()
    if env_inline:
        entries = [
            {"keyword": kw.strip(), "qualifiers": None}
            for kw in env_inline.split(",")
            if kw.strip()
        ]
        # ⚠️ 제외 목록은 **키워드 출처와 무관하게** 패키지 설정에서 온다.
        # 초안은 여기서 `[]` 를 돌려줬는데, 그러면 키워드 하나 재실행하려고 env 를 켠 순간
        # 시크릿 스캐너·자사 repo 제외가 통째로 풀린다. 게다가 `_search_exclude_repos()` 를
        # 쓰는 **프록시 발견 경로까지** 같이 풀린다(같은 로더를 탄다).
        return ("env-inline", entries, _packaged_exclude_repos())

    path = (
        config_path
        or (Path(os.environ["GITHUB_SEARCH_KEYWORDS_FILE"]).expanduser()
            if (os.environ.get("GITHUB_SEARCH_KEYWORDS_FILE") or "").strip()
            else _DEFAULT_SEARCH_KEYWORDS_FILE)
    )
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    version = str(data.get("version") or "") or None
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in data.get("keywords") or []:
        if isinstance(raw, str):
            kw, quals = raw.strip(), None
        elif isinstance(raw, dict):
            kw = str(raw.get("keyword") or "").strip()
            quals_raw = raw.get("qualifiers")
            quals = (
                [str(q).strip() for q in quals_raw if str(q).strip()]
                if isinstance(quals_raw, (list, tuple)) and quals_raw
                else None
            )
        else:
            continue
        if not kw or kw in seen:
            continue
        seen.add(kw)
        entries.append({"keyword": kw, "qualifiers": quals})
    excludes = [str(x).strip() for x in (data.get("exclude_repos") or []) if str(x).strip()]
    return (version, entries, excludes)


def run_search_discovery_pass(
    *,
    config_path: Path | None = None,
    max_repos: int | None = None,
    per_query_limit: int | None = None,
) -> dict[str, Any]:
    """v3.91: 전역 코드검색으로 후보 repo 발견 → `devops_target(service='github')` 큐 적재.

    프록시 로그 경로(삭제됨)는 GitHub API 를 안 불러 visibility 를 알 수 없었고
    접근 불가 repo 가 큐에 쌓였다. 이 경로는 검색 인덱스가 **읽을 수 있는 repo 만** 돌려주므로
    그 문제가 애초에 생기지 않는다. 큐/워커는 기존 것을 그대로 쓴다.
    (⚠️ `github_repo_target` 이 아니다 — 그쪽 소비자 `github.scan` 은 꺼져 있다)
    """
    load_runtime_env(load_plugins=False)
    component = COMPONENT_GITHUB_SEARCH_DISCOVERY
    state.heartbeat_upsert(component, phase=PHASE_GITHUB_SEARCH_DISCOVERY, pid=os.getpid())
    run_id = state.pipeline_run_start(component)
    status = "ok"
    detail = ""
    try:
        version, entries, excludes = _load_search_keywords(config_path)
        result = discover_repositories_by_search(
            entries,
            config_version=version,
            per_query_limit=per_query_limit or _int_env("GITHUB_SEARCH_LIMIT_PER_QUERY", 100),
            max_repos=max_repos,
            exclude_repos=excludes,
            scope_screen=_github_scope_screen(excludes),
        )
        n_err = len(result["errors"])
        detail = (
            f"keywords={result['keywords']} keywords_ok={result['keywords'] - n_err}"
            f"/{result['keywords']} repos_seen={result['repos_seen']} "
            f"new={result['new']} total={result['total']} "
            f"excluded={result['excluded']} out_of_scope={result['out_of_scope']} "
            f"errors={n_err}"
        )
        if result["errors"]:
            # ★ 2026-08-22 뒤집음. 여기 있던 규칙은 "일부 키워드가 죽어도 pass 는 성공으로
            # 본다 — 다음 사이클에 재시도" 였는데, **그 다음 사이클이 오지 않는다.**
            # 이 배치를 도는 스케줄러가 없다(crontab 0건·systemd timer 0건, 실측). 그래서
            # 07-29 런의 errors=12 도 08-22 런의 errors=4 도 status=ok 로 남았고 3.5주간
            # 아무도 커버리지 손실을 몰랐다. detail 에만 적는 건 아무도 안 읽으면 침묵이다.
            #
            # 검색 키워드 하나가 죽으면 그 키워드의 발견 공간 전체가 이번 런에서 사라진다
            # (실측: 21 중 4 = 19%). 그건 "성공한 런" 이 아니다. 게이트웨이 health 가
            # status IN ('ok','error') 만 보므로 새 상태값을 만들지 않고 error 로 넘긴다 —
            # 새 값은 그 필터에서 탈락해 **오히려 안 보이게** 된다.
            status = "error"
            detail += f" first_error={result['errors'][0].get('error', '')[:120]}"
        return result
    except Exception as e:  # noqa: BLE001
        status = "error"
        detail = repr(e)[:500]
        raise
    finally:
        state.heartbeat_upsert(
            component,
            phase="idle" if status == "ok" else "error",
            detail=detail,
            pid=os.getpid(),
        )
        state.pipeline_run_finish(run_id, status=status, detail=detail)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="GitHub E2E discovery")
    parser.add_argument("--repo", action="store_true", help="run API repo discovery")
    parser.add_argument("--sso", action="store_true", help="run SSO URL discovery")
    parser.add_argument("--search-sync", action="store_true",
                        help="run global code-search repo discovery")
    parser.add_argument("--max-repos", type=int, default=None)
    parser.add_argument("--include-archived", action="store_true")
    parser.add_argument("--visibilities", default="public,internal")
    parser.add_argument("--earliest", default=None)
    parser.add_argument("--latest", default=None)
    parser.add_argument("--day-bucket", default=None)
    parser.add_argument("--max-urls", type=int, default=None)
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=os.environ.get("GITHUB_AGENT_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # 플래그를 하나라도 주면 준 것만 실행한다. 아무것도 안 주면 기존 기본값(repo+sso) 유지 —
    # `--search-sync` 만 줬는데 repo 열거까지 도는 사고를 막는다.
    any_flag = args.repo or args.sso or args.search_sync
    run_repo = args.repo or not any_flag
    run_sso = args.sso or not any_flag
    if args.search_sync:
        log.info(
            "[github-discovery] search pass %s",
            run_search_discovery_pass(max_repos=args.max_repos),
        )
    if run_repo:
        vis = tuple(x.strip() for x in args.visibilities.split(",") if x.strip())
        log.info(
            "[github-discovery] repo pass %s",
            run_discovery_pass(
                max_repos=args.max_repos,
                include_archived=args.include_archived,
                visibilities=vis or ("public", "internal"),
            ),
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
