"""Splunk 담당자 적재 — IP → asset_owner (smb_domain_e2e 요구 2).

과거 `smb_owner_lookup_tool` 은 agent/MCP registry(ctx.registry) 전용이라 cron 에서 못
돌았고, 그래서 이 모듈이 생겼다. 그 도구는 어느 toolset 에도 등록된 적이 없어(도달 불가)
제거됐다 — **owner enrich 의 유일한 경로가 여기다.**
→ 코드 러너가 Splunk MCP(`splunk_search`)를 **직접** SSE 로 호출한다(ai-soc/ai-sandbox
`McpServerProxy` 패턴, mcp SDK sse_client). 동일 SPL:

    | inputlookup LOOKUP_CONTEXT_ASSET_LIST_V2 where IP="..." | table IP,USER_ID,USER_NAME,USER_DEPT

→ `state_domain.asset_owner_upsert`. REST(token) 경로가 별도로 존재하면
`SPLUNK_REST_URL`+`SPLUNK_TOKEN` 으로 토글(아래 _search_via_rest). MCP_SPLUNK_URL 우선.

## 2026-08-16: LiteLLM MCP 게이트웨이 경로 추가 (기본 경로)

구 MCP 호스트(`MCP_INTERNAL_HOST`)가 통째로 죽었다 — splunk(8002)·wiki(8108)·
ticket(8109)·LiteLLM(9810) **전 포트 타임아웃**. 그 사이 사내 MCP 들이
LiteLLM 게이트웨이(`gateway.security.samsungds.net`)로 이전됐고 거기 `lens_splunk_mcp`
가 등록돼 있다. 그래서 dev_web discovery 가 5주(마지막 day_bucket 2026-07-10) 멈춰
있었고, smb owner-enrich 도 `owners_enriched: 0` 이었다 — **원인은 하나였다.**

접속 방식이 다르다:
  구: `http://host:8002/sse`     SSE · 무인증 · 도구명 `splunk_search`
  신: `https://gw/mcp/`          streamable-http · Bearer · `x-mcp-servers` 헤더 ·
                                 도구명 `lens_splunk_mcp-splunk_run`

env:
- `MCP_SPLUNK_GATEWAY_URL` — LiteLLM MCP 게이트웨이(예: https://.../mcp/). **최우선.**
- `MCP_SPLUNK_GATEWAY_SERVER` — 게이트웨이에 등록된 서버명(기본 `lens_splunk_mcp`).
- `MCP_SPLUNK_GATEWAY_KEY` — 미설정 시 `LITELLM_API_KEY` 재사용(같은 게이트웨이다).
- `MCP_SPLUNK_GATEWAY_CA` — TLS 검증 번들(기본 `/etc/ssl/certs/ca-certificates.crt`).
  ⚠️ httpx 는 기본이 certifi 라 사내 CA 를 모른다 → **명시 필요**. 검증을 끄지 않는다.
- `MCP_SPLUNK_URL` (예: http://<host>:<port>/sse) — 구 MCP-over-SSE.
- `SPLUNK_REST_URL`+`SPLUNK_TOKEN` — REST fallback (services/search/jobs/export).
- 전부 없으면 owner-enrich 비활성(러너가 skip, 토큰 비용 0).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from service import state_domain as state

log = logging.getLogger("service.collector.splunk_owner")

_LOOKUP = "LOOKUP_CONTEXT_ASSET_LIST_V2"


# 2026-08-22: `lens_splunk_mcp` 가 게이트웨이에서 **사라졌다**(list_tools 0개,
# call_tool → "User not allowed to call this tool"). 같은 게이트웨이의 `splunk` 서버로
# 옮겨졌고 도구명·인자·응답 스키마가 전부 바뀌었다:
#     lens_splunk_mcp-splunk_run  {spl, earliest, latest, base} → {ran, count, rows}
#     splunk-splunk_search        {query, earliest_time, latest_time, max_results}
#                                 → {success, count, results}
# 이 이전을 **5일 동안 아무도 몰랐다** — 아래 fail-loud 가 없어서 조용히 0건이었다.
_DEFAULT_GATEWAY_SERVER = "splunk"
_DEFAULT_GATEWAY_TOOL = "splunk_search"
_DEFAULT_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"


class SplunkQueryFailed(RuntimeError):
    """조회 자체가 실패했다 (게이트웨이 `ran=false`).

    ⚠️ `ran=false`(조회 실패) 와 `ran=true, count=0`(조회 성공·데이터 없음) 을 절대
    같이 취급하지 마라 — 도구 설명이 명시적으로 경고하는 지점이다. 섞으면 Splunk 가
    죽은 날 discovery 가 "대상 0건"으로 조용히 성공해 큐가 비어버린다.
    """


def gateway_enabled() -> bool:
    return bool((os.environ.get("MCP_SPLUNK_GATEWAY_URL") or "").strip())


def _gateway_server() -> str:
    return (os.environ.get("MCP_SPLUNK_GATEWAY_SERVER") or _DEFAULT_GATEWAY_SERVER).strip()


def _gateway_tool() -> str:
    return (os.environ.get("MCP_SPLUNK_GATEWAY_TOOL") or _DEFAULT_GATEWAY_TOOL).strip()


def _gateway_key() -> str:
    return (
        os.environ.get("MCP_SPLUNK_GATEWAY_KEY")
        or os.environ.get("LITELLM_API_KEY")
        or ""
    ).strip()


def _gateway_ca() -> str:
    return (os.environ.get("MCP_SPLUNK_GATEWAY_CA") or _DEFAULT_CA_BUNDLE).strip()


def splunk_enabled() -> bool:
    return bool(
        gateway_enabled()
        or (os.environ.get("MCP_SPLUNK_URL") or "").strip()
        or (os.environ.get("SPLUNK_REST_URL") or "").strip()
    )


def _splunk_literal(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_spl(ips: "set[str] | None") -> str:
    if not ips:
        where = 'IP="*"'
    else:
        where = " OR ".join(f"IP={_splunk_literal(ip)}" for ip in sorted(ips))
    return (
        f"| inputlookup {_LOOKUP} where {where} \n"
        "| table IP,USER_ID, USER_NAME, USER_DEPT"
    )


# 게이트웨이 경로의 담당자 조회 베이스. 카탈로그(spl-shared.md)가 지정한 이름이다.
_OWNER_BASE = "endpoint_context_base"
# ⚠️ 이 베이스는 **매시간 전체를 다시 적재하는 스냅샷 인덱스**(hq_context/
#    context_asset_list_test)라 시간창을 넓히면 중복 계수된다 — 카탈로그가 "정확히 1시간"
#    으로 못 박았다. 넓히지 마라.
_OWNER_BASE_WINDOW = "-1h"


def _owner_base() -> str:
    return (os.environ.get("MCP_SPLUNK_GATEWAY_OWNER_BASE") or _OWNER_BASE).strip()


def build_owner_tail_spl(ips: "set[str] | None") -> str:
    """게이트웨이 베이스 뒤에 붙일 **꼬리** SPL.

    구 경로(`| inputlookup LOOKUP_CONTEXT_ASSET_LIST_V2`)와 데이터소스가 다르다:
    - 구: 자산 원장 lookup 전체
    - 신: `endpoint_context_base` = `Usage="오피스" OR "라인"` 으로 좁혀진 통합 Context
    필드(IP/USER_ID/USER_NAME/USER_DEPT)는 같고 실측에서 smb 대상 3건 전부 매칭됐다.
    다만 **모수가 좁다** — 오피스/라인 밖 단말은 안 잡힌다(서버팜 등).
    """
    if not ips:
        tail_where = '| where isnotnull(IP) AND IP!="-"'
    else:
        joined = ", ".join(_splunk_literal(ip) for ip in sorted(ips))
        tail_where = f"| where IP IN ({joined})"
    return f'{tail_where}\n| table IP,USER_ID,USER_NAME,USER_DEPT'


def _rows_from_payload(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        out: list[dict[str, Any]] = []
        for item in payload:
            if isinstance(item, dict) and item.get("type") == "text":
                out.extend(_rows_from_payload(item.get("text", "")))
            elif isinstance(item, dict):
                out.append(item)
        return out
    if isinstance(payload, str):
        try:
            return _rows_from_payload(json.loads(payload))
        except (json.JSONDecodeError, TypeError):
            return []
    if isinstance(payload, dict):
        rows = payload.get("results")
        if isinstance(rows, list):
            return [r for r in rows if isinstance(r, dict)]
    return []


# 조회 실패를 뜻하는 필드. 구 도구는 `ran`, 신 도구는 `success` 를 쓴다.
_OK_FIELDS = ("ran", "success")


def _rows_from_run_payload(payload: Any) -> list[dict[str, Any]]:
    """게이트웨이 splunk 응답 → rows. 실패면 **예외**.

    구 `{ran, count, rows}` / 신 `{success, count, results}` 를 둘 다 읽는다.

    ★ 실패를 빈 리스트로 내리면 호출부가 "데이터 없음" 으로 읽는다. 그게 2026-08-22 에
    실제로 5일간 일어났다 — 게이트웨이가 `"Error: User not allowed to call this tool."`
    이라는 **평문**을 돌려줬는데, JSON 파싱에 실패해 조용히 `[]` 가 됐고 dev_web
    discovery 가 0건으로 "성공" 했다. 그래서:
      · JSON 이 아닌 **비어 있지 않은** 본문은 에러 메시지다 → 예외
      · `ran=false` / `success=false` → 예외
    """
    if isinstance(payload, list):
        out: list[dict[str, Any]] = []
        for item in payload:
            if isinstance(item, dict) and item.get("type") == "text":
                out.extend(_rows_from_run_payload(item.get("text", "")))
            elif isinstance(item, dict):
                out.append(item)
        return out
    if isinstance(payload, str):
        text = payload.strip()
        if not text:
            return []
        try:
            return _rows_from_run_payload(json.loads(text))
        except (json.JSONDecodeError, TypeError):
            # ★ 파싱 실패 = 데이터 없음이 **아니다**. 게이트웨이가 평문 에러를 돌려준 것이다.
            raise SplunkQueryFailed(
                f"splunk 응답이 JSON 이 아니다(게이트웨이 에러로 읽는다): {text[:300]}"
            ) from None
    if isinstance(payload, dict):
        for field in _OK_FIELDS:
            if field in payload and not payload.get(field):
                raise SplunkQueryFailed(
                    f"splunk {field}=false: {str(payload.get('error') or payload)[:300]}"
                )
        for key in ("rows", "results"):
            rows = payload.get(key)
            if isinstance(rows, list):
                return [r for r in rows if isinstance(r, dict)]
    return []


async def _search_via_gateway(
    spl: str, *, max_results: int, earliest: str = "-24h", latest: str = "now",
    base: str | None = None,
) -> list[dict[str, Any]]:
    """LiteLLM MCP 게이트웨이(streamable-http)로 `<server>-splunk_run` 호출.

    `base` 를 주면 카탈로그의 베이스 파이프라인 뒤에 `spl`(꼬리)을 이어 붙여 실행한다.
    `base` 는 **클라이언트에서 이어 붙인다** — 신 도구(`splunk_search`)에는 base 개념이
    없다. 구 도구는 서버가 붙여 줬다.
    """
    import ssl

    import httpx
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    url = (os.environ.get("MCP_SPLUNK_GATEWAY_URL") or "").strip()
    server = _gateway_server()
    key = _gateway_key()
    if not key:
        raise RuntimeError(
            "MCP_SPLUNK_GATEWAY_KEY/LITELLM_API_KEY 미설정 — 게이트웨이 인증 불가"
        )

    # ⚠️ trust_env=False: 사내 프록시가 403 New_All_deny_Page 로 가로챈다(구 SSE 경로와 동일).
    # ⚠️ 사내 CA 로 **검증한다**(끄지 않는다). httpx 기본은 certifi 라 사내 CA 를 모르고,
    #    verify=<문자열 경로> 는 폐기 예정이라 SSLContext 를 직접 만든다.
    http_client = httpx.AsyncClient(
        headers={"Authorization": f"Bearer {key}", "x-mcp-servers": server},
        follow_redirects=True,
        trust_env=False,
        verify=ssl.create_default_context(cafile=_gateway_ca()),
        timeout=httpx.Timeout(30.0, read=600.0),
    )
    async with http_client:
        async with streamable_http_client(url, http_client=http_client) as (r, w, _sid):
            async with ClientSession(r, w) as s:
                await s.initialize()
                # base + 꼬리 SPL 을 여기서 합친다(신 도구엔 base 인자가 없다).
                query = f"{base.strip()} {spl.strip()}".strip() if base else spl
                args: dict[str, Any] = {
                    "query": query,
                    "earliest_time": earliest,
                    "latest_time": latest,
                }
                if max_results and max_results > 0:
                    args["max_results"] = int(max_results)
                tool_name = f"{server}-{_gateway_tool()}"
                resp = await s.call_tool(tool_name, args)
                parts = [
                    t for t in (getattr(b, "text", None) for b in (resp.content or [])) if t
                ]
                body = "\n".join(parts).strip()
                # ★ MCP 도구 에러를 결과로 읽지 않는다. 이걸 안 봐서 5일간
                #   "User not allowed to call this tool" 이 빈 결과로 둔갑했다.
                if getattr(resp, "isError", False):
                    raise SplunkQueryFailed(
                        f"{tool_name} 도구 에러: {body[:300] or '(본문 없음)'}"
                    )
    rows = _rows_from_run_payload(body)
    return rows[:max_results] if max_results and max_results > 0 else rows


def search(
    spl: str, *, max_results: int, earliest: str = "-24h", latest: str = "now",
    base: str | None = None,
) -> list[dict[str, Any]]:
    """SPL 실행 단일 진입점 — 게이트웨이 → 구 MCP(SSE) → REST 순.

    dev_web discovery 와 smb owner-enrich 가 **같은 경로**를 쓰게 모은다. 예전엔 각자
    분기해서 한쪽만 고치면 다른 쪽이 조용히 죽어 있었다.
    `base` 는 게이트웨이 전용(구 경로엔 베이스 개념이 없다).
    """
    if gateway_enabled():
        return asyncio.run(
            _search_via_gateway(
                spl, max_results=max_results, earliest=earliest, latest=latest, base=base,
            )
        )
    if (os.environ.get("MCP_SPLUNK_URL") or "").strip():
        return asyncio.run(_search_via_mcp(spl, max_results=max_results))
    return _search_via_rest(spl, max_results=max_results)


def _val(row: dict[str, Any], *names: str) -> str:
    lower = {str(k).lower(): v for k, v in row.items()}
    for name in names:
        v = row.get(name)
        if v is None:
            v = lower.get(name.lower())
        text = str(v or "").strip()
        if text:
            return text
    return ""


def _internal_httpx_factory(headers=None, auth=None, **_):
    """사내 MCP(12.x)는 호스트 프록시를 우회해야 도달한다 (ai-sandbox McpServerProxy 패턴).

    trust_env=False 로 HTTP_PROXY/HTTPS_PROXY 무시 — 안 하면 사내 프록시가
    403 New_All_deny_Page 로 가로챈다(실측 2026-06-13).
    """
    import httpx
    return httpx.AsyncClient(
        headers=headers, auth=auth, follow_redirects=True, trust_env=False,
        timeout=httpx.Timeout(30.0, read=300.0),
    )


async def _search_via_mcp(spl: str, *, max_results: int) -> list[dict[str, Any]]:
    """MCP-over-SSE splunk_search (ai-sandbox McpServerProxy.call_tool 패턴)."""
    url = (os.environ.get("MCP_SPLUNK_URL") or "").strip()
    from mcp import ClientSession
    from mcp.client.sse import sse_client

    async with sse_client(
        url, timeout=10, sse_read_timeout=600,
        httpx_client_factory=_internal_httpx_factory,
    ) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            resp = await s.call_tool("splunk_search", {
                "query": spl,
                "earliest_time": "-1d",
                "latest_time": "now",
                "max_results": max_results,
            })
            parts: list[str] = []
            for block in (resp.content or []):
                text = getattr(block, "text", None)
                if text:
                    parts.append(text)
            body = "\n".join(parts).strip()
    return _rows_from_payload(body)


def _search_via_rest(spl: str, *, max_results: int) -> list[dict[str, Any]]:
    """REST fallback — services/search/jobs/export (oneshot), token 인증."""
    import httpx

    base = (os.environ.get("SPLUNK_REST_URL") or "").strip().rstrip("/")
    token = (os.environ.get("SPLUNK_TOKEN") or "").strip()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    # inputlookup 은 generating command — search 앞에 `search` 불요, oneshot export.
    data = {
        "search": spl if spl.strip().startswith("|") else f"search {spl}",
        "output_mode": "json",
        "count": str(max_results),
        "exec_mode": "oneshot",
    }
    rows: list[dict[str, Any]] = []
    with httpx.Client(timeout=120, verify=False, trust_env=False) as client:
        resp = client.post(f"{base}/services/search/jobs/export", data=data, headers=headers)
        resp.raise_for_status()
        for line in resp.text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            result = obj.get("result") if isinstance(obj, dict) else None
            if isinstance(result, dict):
                rows.append(result)
    return rows


def enrich_owners(ips: "set[str] | None" = None, *, max_results: int = 5000) -> dict[str, int]:
    """IP 집합(또는 전체)의 담당자를 Splunk 에서 조회해 asset_owner 에 적재.

    반환: {queried, persisted, missing, error}. Splunk 미설정이면 skip(0).
    """
    if not splunk_enabled():
        log.info("[splunk] MCP_SPLUNK_URL/SPLUNK_REST_URL 미설정 — owner-enrich skip")
        return {"queried": 0, "persisted": 0, "missing": 0, "error": 0}

    requested = {str(ip).strip() for ip in (ips or set()) if str(ip).strip()}

    rows: list[dict[str, Any]] = []
    try:
        # 2026-08-22: 게이트웨이 전용 base+tail 분기를 없앴다. 그 우회는 구 도구
        # (`lens_splunk_mcp-splunk_run`)가 `|` 로 시작하는 꼬리 SPL 을 거부해서 필요했던
        # 것이고, 신 도구(`splunk-splunk_search`)는 **생 SPL 을 그대로** 받는다.
        # 실측: `| inputlookup LOOKUP_CONTEXT_ASSET_LIST_V2 …` 가 담당자를 돌려주고,
        # 구 베이스 이름(`endpoint_context_base`)은 매크로로도 savedsearch 로도 없다
        # — 그건 구 게이트웨이가 서버에서 풀어 주던 이름이었다.
        rows = search(build_spl(requested or None), max_results=max_results,
                      earliest="-1d", latest="now")
    except Exception as e:  # noqa: BLE001 — owner-enrich 실패가 파이프라인을 멈추지 않음
        log.warning("[splunk] 조회 실패: %r", e)
        for ip in sorted(requested):
            state.asset_owner_upsert(
                ip,
                source=f"splunk:{_LOOKUP}:error",
            )
        return {"queried": 0, "persisted": 0, "missing": len(requested), "error": 1}

    persisted = 0
    seen: set[str] = set()
    for row in rows:
        ip = _val(row, "IP", "ip")
        if not ip or ip in seen:
            continue
        if requested and ip not in requested:
            continue
        seen.add(ip)
        user_id = _val(row, "USER_ID", "user_id") or None
        state.asset_owner_upsert(
            ip,
            user_id=user_id,
            user_name=_val(row, "USER_NAME", "user_name") or None,
            user_dept=_val(row, "USER_DEPT", "user_dept") or None,
            source=f"splunk:{_LOOKUP}",
        )
        persisted += 1

    missing_ips = requested - seen if requested else set()
    for ip in sorted(missing_ips):
        state.asset_owner_upsert(
            ip,
            source=f"splunk:{_LOOKUP}:missing",
        )
    missing = len(missing_ips)
    log.info("[splunk] owner-enrich queried=%d persisted=%d missing=%d",
             len(rows), persisted, missing)
    return {"queried": len(rows), "persisted": persisted, "missing": missing, "error": 0}
