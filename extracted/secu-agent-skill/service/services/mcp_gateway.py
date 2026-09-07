"""사내 LiteLLM MCP 게이트웨이 호출 — 서버 이름만 바꿔 재사용하는 얇은 전송 계층.

`splunk_owner._search_via_gateway` 가 이 접속 방식을 처음 세웠는데, 거기 붙어 있어서
다른 서버(`knox` 등)를 쓰려면 통째로 복사해야 했다. 복사는 갈라진다 — 오늘만
개인키 armor 정규식과 confluence space_key 파서가 각각 갈라진 걸 봤다. 그래서 뺐다.

⚠️ `splunk_owner` 는 아직 자기 복사본을 쓴다(동작 중인 경로를 건드리지 않으려고).
   다음에 그 파일을 열 일이 있으면 여기로 합류시킬 것.

## 접속 규약 (라이브 확인 2026-08-23)

- streamable-http, `Authorization: Bearer <key>`, `x-mcp-servers: <server>` 헤더.
- 헤더를 **생략하면 전 서버의 도구가 다 온다**(현재 27개 서버 / 154개 도구).
  서버를 지정하면 그 서버 것만 온다 — 도구 이름은 `<server>-<tool>` 형식.
- ⚠️ `trust_env=False`: 사내 프록시(MWG)가 403 `New_All_deny_Page` 로 가로챈다.
- ⚠️ 사내 CA 로 **검증한다**(끄지 않는다). httpx 기본은 certifi 라 사내 CA 를 모른다.

env 는 splunk 쪽 이름을 그대로 재사용한다 — **같은 게이트웨이**이고, 키를 두 벌 관리하면
한쪽만 갱신되는 사고가 난다(`SECU_AGENT_PG_DSN` 을 엔진·게이트웨이가 공유해서 겪은 것과 같은 함정).
"""
from __future__ import annotations

import json
import os
import ssl
from typing import Any

_DEFAULT_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"


class McpGatewayError(RuntimeError):
    """게이트웨이 호출 자체가 실패했다.

    ⚠️ 이것을 빈 결과로 바꾸지 마라. `splunk_owner` 가 그렇게 했다가 게이트웨이가
    평문 에러(`User not allowed to call this tool.`)를 돌려준 5일 동안 dev_web
    discovery 가 "대상 0건" 으로 조용히 성공했다.
    """


def gateway_url() -> str:
    return (os.environ.get("MCP_SPLUNK_GATEWAY_URL") or "").strip()


def gateway_key() -> str:
    return (
        os.environ.get("MCP_SPLUNK_GATEWAY_KEY")
        or os.environ.get("LITELLM_API_KEY")
        or ""
    ).strip()


def gateway_ca() -> str:
    return (os.environ.get("MCP_SPLUNK_GATEWAY_CA") or _DEFAULT_CA_BUNDLE).strip()


def enabled() -> bool:
    return bool(gateway_url() and gateway_key())


def _ssl_context() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=gateway_ca())


async def call_tools(server: str, calls: list[tuple[str, dict[str, Any]]],
                     *, concurrency: int = 6) -> list[Any]:
    """한 세션에서 여러 도구 호출을 동시에 돌리고 결과를 **입력 순서대로** 돌려준다.

    세션을 호출마다 새로 여는 건 비싸다(초기화 왕복이 매번 붙는다). 담당자 조회처럼
    수백 건을 물어보는 경우가 있어 세션 하나에 묶는다.

    반환 원소는 도구가 돌려준 text 를 JSON 으로 판 값이거나, 실패면 `McpGatewayError`
    **인스턴스**다(예외를 던지지 않는다 — 한 건이 실패해도 나머지는 써야 하니까).
    호출부가 `isinstance(x, Exception)` 으로 갈라야 한다.
    """
    import asyncio

    import httpx
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    if not enabled():
        raise McpGatewayError(
            "MCP_SPLUNK_GATEWAY_URL / (MCP_SPLUNK_GATEWAY_KEY|LITELLM_API_KEY) 미설정"
        )
    http_client = httpx.AsyncClient(
        headers={"Authorization": f"Bearer {gateway_key()}", "x-mcp-servers": server},
        follow_redirects=True,
        trust_env=False,
        verify=_ssl_context(),
        timeout=httpx.Timeout(30.0, read=300.0),
    )
    out: list[Any] = [None] * len(calls)
    async with http_client:
        async with streamable_http_client(gateway_url(), http_client=http_client) as (r, w, _sid):
            async with ClientSession(r, w) as session:
                await session.initialize()
                sem = asyncio.Semaphore(max(1, concurrency))

                async def one(idx: int, tool: str, args: dict[str, Any]) -> None:
                    async with sem:
                        try:
                            res = await session.call_tool(tool, args)
                            out[idx] = _payload(res)
                        except Exception as exc:  # noqa: BLE001 — 개별 실패는 값으로 돌린다
                            out[idx] = McpGatewayError(f"{tool}: {exc!r}")

                await asyncio.gather(*(one(i, t, a) for i, (t, a) in enumerate(calls)))
    return out


def _payload(result: Any) -> Any:
    """MCP content 블록 → JSON 값. JSON 이 아니면 **에러로 본다**.

    ★ 게이트웨이는 실패를 평문으로 돌려준다(`Error: User not allowed to call this tool.`).
    파싱 실패를 빈 값으로 내리면 그게 "데이터 없음" 으로 읽힌다.
    """
    text = " ".join(
        getattr(item, "text", "") for item in (getattr(result, "content", None) or [])
    ).strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        raise McpGatewayError(f"응답이 JSON 이 아니다(평문 에러로 읽는다): {text[:300]}") from None
