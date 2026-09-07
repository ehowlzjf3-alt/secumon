"""Confluence E2E discovery runners."""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
from pathlib import Path
from typing import Any, Protocol

from domains.services.application.devops_discovery import (
    DevopsDiscoveryConfig,
    build_devops_discovery_spl,
    ingest_devops_discovery_rows,
)
from domains.services.confluence.application.contracts import (
    COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
    COMPONENT_CONFLUENCE_SSO_DISCOVERY,
    PHASE_CONFLUENCE_SPACE_DISCOVERY,
    PHASE_CONFLUENCE_SSO_DISCOVERY,
)
from service import state_domain as state
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.confluence_discovery")

_DEFAULT_SPACE_LIMIT = 100000


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
            raise RuntimeError("MCP_SPLUNK_URL or SPLUNK_REST_URL is required for Confluence SSO discovery")
        from service.collector import splunk_owner

        if (os.environ.get("MCP_SPLUNK_URL") or "").strip():
            return asyncio.run(splunk_owner._search_via_mcp(spl, max_results=max_results))
        return splunk_owner._search_via_rest(spl, max_results=max_results)


def _bounded_space_limit(max_spaces: int | None) -> int:
    if max_spaces is None:
        return _DEFAULT_SPACE_LIMIT
    return max(1, min(int(max_spaces), _DEFAULT_SPACE_LIMIT))


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def run_space_discovery_pass(
    *,
    max_spaces: int | None = None,
    space_type: str | None = None,
) -> dict[str, Any]:
    load_runtime_env(load_plugins=False)
    component = COMPONENT_CONFLUENCE_SPACE_DISCOVERY
    state.heartbeat_upsert(component, phase=PHASE_CONFLUENCE_SPACE_DISCOVERY, pid=os.getpid())
    run_id = state.pipeline_run_start(component)
    status = "ok"
    detail = ""
    try:
        before = state.confluence_space_targets_summary()
        # ★ REST 가 아니라 **브라우저**로 센다 (사용자 결정 2026-08-26).
        #   `cf.list_spaces` 는 `/rest/api/space` 를 치는데 그 엔드포인트는 죽어 있다:
        #     Basic 403 "Basic Authentication has been disabled" · Bearer PAT 429
        #   그래서 이 패스가 매 런 error 로 끝났고 space 큐가 id 1~25 에서 멈춰 있었다.
        #
        #   ⚠️ `space_type` 필터는 브라우저 경로에 없다. directory 페이지가 global/personal 을
        #      구분해 주지 않기 때문이다 — 없는 것을 흉내내지 않고 명시적으로 무시한다.
        from domains.services.confluence.plugin.tools.confluence_browser_spaces import (
            browser_list_spaces,
        )

        if space_type:
            log.warning("[confluence-discovery] space_type=%r 는 브라우저 경로에서 "
                        "지원되지 않는다 — 무시하고 전체를 센다", space_type)
        got = browser_list_spaces(limit=_bounded_space_limit(max_spaces))
        if not got.get("ok"):
            # ★ 0건과 실패를 구분한다. 빈 목록을 성공으로 기록하면 discovery 가
            #   조용히 아무것도 안 하는 상태가 되고, 큐가 안 느는 것을 아무도 모른다.
            raise RuntimeError(
                f"confluence space 열거 실패(브라우저): {got.get('detail') or '사유 없음'}")
        spaces = got["spaces"]
        upserted = 0
        for space in spaces:
            key = str(getattr(space, "key", "") or "").strip()
            if not key:
                continue
            state.confluence_space_target_upsert(
                key,
                space_name=getattr(space, "name", None) or None,
                space_type=getattr(space, "type", None) or None,
            )
            upserted += 1
        after = state.confluence_space_targets_summary()
        result = {
            "kind": "confluence_space_discovery",
            "enumerated": len(spaces),
            "upserted": upserted,
            "new": max(0, after["total"] - before["total"]),
            "total": after["total"],
            "never_scanned": after["never_scanned"],
            "scanned": after["scanned"],
        }
        detail = (
            f"enumerated={result['enumerated']} upserted={upserted} "
            f"new={result['new']} total={result['total']}"
        )
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


def run_sso_discovery_pass(
    *,
    earliest: str | None = None,
    latest: str | None = None,
    day_bucket: str | None = None,
    max_urls: int | None = None,
    searcher: SplunkSearchPort | None = None,
) -> dict[str, Any]:
    load_runtime_env(load_plugins=False)
    component = COMPONENT_CONFLUENCE_SSO_DISCOVERY
    state.heartbeat_upsert(component, phase=PHASE_CONFLUENCE_SSO_DISCOVERY, pid=os.getpid())
    run_id = state.pipeline_run_start(component)
    status = "ok"
    detail = ""
    try:
        config = DevopsDiscoveryConfig(
            earliest=earliest or os.environ.get("CONFLUENCE_SSO_DISCOVERY_EARLIEST", "-7d"),
            latest=latest or os.environ.get("CONFLUENCE_SSO_DISCOVERY_LATEST", "now"),
            day_bucket=day_bucket,
            max_urls=max_urls or _int_env("CONFLUENCE_SSO_DISCOVERY_MAX_URLS", 2000),
        )
        client = searcher or _DefaultSplunkSearchClient()
        rows = client.search(
            build_devops_discovery_spl(config, service_filter="confluence"),
            max_results=config.bounded_max_urls(),
        )
        result = ingest_devops_discovery_rows(
            rows,
            config=config,
            store=state,
            service_filter="confluence",
        )
        result["kind"] = "confluence_sso_discovery"
        detail = (
            f"rows={result['splunk_rows']} normalized={result['normalized']} "
            f"upserted={result['upserted']} new={result['new']} total={result['total']}"
        )
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


_DEFAULT_SEARCH_KEYWORDS_FILE = (
    Path(__file__).resolve().parents[2]
    / "domains" / "services" / "confluence" / "config" / "search_keywords.yaml"
)


def _load_search_keywords(config_path: Path | None = None) -> tuple[str | None, list[dict[str, Any]]]:
    """검색 키워드 허용목록을 로드한다. 우선순위: env 리스트 > 인자(config_path) > env 파일 > 패키지 기본 YAML.

    반환: (config_version, [{keyword, scope_space_keys|None}, ...]). scope_space_keys 는 정렬/dedup 된다.
    """
    import yaml

    env_inline = (os.environ.get("CONFLUENCE_SEARCH_KEYWORDS") or "").strip()
    if env_inline:
        entries = [
            {"keyword": kw.strip(), "scope_space_keys": None}
            for kw in env_inline.split(",")
            if kw.strip()
        ]
        return ("env-inline", entries)

    path = (
        config_path
        or (Path(os.environ["CONFLUENCE_SEARCH_KEYWORDS_FILE"]).expanduser()
            if (os.environ.get("CONFLUENCE_SEARCH_KEYWORDS_FILE") or "").strip()
            else _DEFAULT_SEARCH_KEYWORDS_FILE)
    )
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    version = str(data.get("version") or "") or None
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in data.get("keywords") or []:
        if isinstance(raw, str):
            kw, scope = raw.strip(), None
        elif isinstance(raw, dict):
            kw = str(raw.get("keyword") or "").strip()
            scope_raw = raw.get("space_keys") or raw.get("scope_space_keys")
            scope = (
                sorted({str(s).strip() for s in scope_raw if str(s).strip()})
                if isinstance(scope_raw, (list, tuple)) and scope_raw
                else None
            )
        else:
            continue
        if not kw or kw in seen:
            continue
        seen.add(kw)
        entries.append({"keyword": kw, "scope_space_keys": scope})
    return (version, entries)


def run_search_keyword_sync(
    *,
    config_path: Path | None = None,
) -> dict[str, Any]:
    """키워드 허용목록 → confluence_search_target rolling 큐 upsert(bounded, 키워드당 1 row).

    space discovery(cf.list_spaces) 대응 — Splunk 없이 curated 키워드를 큐에 싣는다. 기존 키워드는
    scope/config_version 만 갱신(진행상태 보존). 이후 'confluence 점검(search_task)' 이 oldest-first
    로 브라우저 검색한다.
    """
    load_runtime_env(load_plugins=False)
    before = state.confluence_search_targets_summary()
    version, entries = _load_search_keywords(config_path)
    for e in entries:
        state.confluence_search_target_upsert(
            e["keyword"],
            scope_space_keys=e.get("scope_space_keys"),
            config_version=version,
        )
    after = state.confluence_search_targets_summary()
    return {
        "kind": "confluence_search_keyword_sync",
        "config_version": version,
        "keywords": len(entries),
        "new": max(0, after["total"] - before["total"]),
        "total": after["total"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Confluence E2E discovery runner")
    parser.add_argument("--space", action="store_true", help="run API space discovery")
    parser.add_argument("--search-sync", action="store_true", help="sync keyword allowlist into search queue")
    parser.add_argument("--sso", action="store_true", help="run SSO URL discovery")
    parser.add_argument("--max-spaces", type=int, default=None)
    parser.add_argument("--space-type", default=None)
    parser.add_argument("--earliest", default=None)
    parser.add_argument("--latest", default=None)
    parser.add_argument("--day-bucket", default=None)
    parser.add_argument("--max-urls", type=int, default=None)
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=os.environ.get("CONFLUENCE_AGENT_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    any_flag = args.space or args.sso or args.search_sync
    run_space = args.space or not any_flag
    run_sso = args.sso or not any_flag
    run_search = args.search_sync or not any_flag
    if run_search:
        log.info(
            "[confluence-discovery] search keyword sync %s",
            run_search_keyword_sync(),
        )
    if run_space:
        log.info(
            "[confluence-discovery] space pass %s",
            run_space_discovery_pass(max_spaces=args.max_spaces, space_type=args.space_type),
        )
    if run_sso:
        log.info(
            "[confluence-discovery] sso pass %s",
            run_sso_discovery_pass(
                earliest=args.earliest,
                latest=args.latest,
                day_bucket=args.day_bucket,
                max_urls=args.max_urls,
            ),
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
