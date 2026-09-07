"""Knox Mail MCP transport — JSON-RPC 2.0 over SSE (`knox_send_email`).

v3.82 U3a: `web/services/owner_mail.py` 에서 전송부만 이동 (도메인 무관).
SMB draft builder/asset_owner 조회는 도메인 서비스(skill repo) 소유.
`knox/mail_sink.py`(KnoxMailSink) 가 이 모듈을 사용한다 — agent 레이어가
web 레이어를 역참조하던 의존 역전 해소.

Knox 메신저(채팅, knox/client.py 데몬 HTTP)와는 별개 채널이다.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any
from urllib.parse import urljoin

import httpx


class OwnerMailError(RuntimeError):
    """Raised when an owner notification draft/send operation fails."""


def _sender() -> str:
    raw = (
        os.environ.get("SA_KNOX_MAIL_SENDER")
        or os.environ.get("MAIL_SENDER_EMAIL")
        or os.environ.get("SA_OWNER_MAIL_FROM")
        or "dssoc"
    )
    sender = str(raw).strip() or "dssoc"
    return sender.split("@", 1)[0]


def _mcp_server_url() -> str:
    # v3.81 T4: 하드코딩 기본 호스트 제거 (보안 위생) — 미설정 = fail-closed.
    url = (
        os.environ.get("SA_KNOX_MAIL_MCP_URL")
        or os.environ.get("MCP_SERVER_URL")
        or ""
    ).strip()
    if not url:
        raise OwnerMailError(
            "SA_KNOX_MAIL_MCP_URL 미설정 — Knox Mail MCP 주소 없이는 발송 불가"
        )
    return url.rstrip("/")


def _events(lines: Any):
    event_type = ""
    data_lines: list[str] = []
    for raw in lines:
        line = str(raw).rstrip("\r\n")
        if line == "":
            if data_lines:
                yield event_type or "message", "\n".join(data_lines)
            event_type = ""
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event_type = line[len("event:"):].strip()
            continue
        if line.startswith("data:"):
            data_lines.append(line[len("data:"):].strip())
    if data_lines:
        yield event_type or "message", "\n".join(data_lines)


def _post_message(
    client: httpx.Client, base_url: str, endpoint_path: str, message: dict[str, Any],
) -> None:
    url = urljoin(base_url + "/", endpoint_path.lstrip("/"))
    r = client.post(url, json=message, headers={"Content-Type": "application/json"}, timeout=10)
    r.raise_for_status()


def _wait_for_response(events: Any, response_id: int, *, timeout_seconds: float) -> Any:
    deadline = time.monotonic() + timeout_seconds
    for event_type, data in events:
        if time.monotonic() > deadline:
            raise OwnerMailError(f"Knox Mail MCP 응답 timeout: id={response_id}")
        if event_type != "message" or not data:
            continue
        try:
            parsed = json.loads(data)
        except ValueError:
            continue
        if parsed.get("id") != response_id:
            continue
        if parsed.get("error"):
            message = parsed["error"].get("message") if isinstance(parsed["error"], dict) else parsed["error"]
            raise OwnerMailError(f"Knox Mail MCP 오류: {message}")
        return parsed.get("result")
    raise OwnerMailError(f"Knox Mail MCP SSE 종료: id={response_id}")


#: LiteLLM MCP 게이트웨이 — 구 MCP 호스트(12.23.72.66)가 전 포트 사망한 뒤 이전한 자리.
#: 실측 2026-08-30: `12.23.72.66:8005` · `127.0.0.1:8005` 둘 다 무응답,
#: `gateway.security.samsungds.net` 은 살아 있고 `knox-knox_send_email` 이 실제로 나간다.
GATEWAY_URL_ENV = "SA_MCP_GATEWAY_URL"
GATEWAY_KEY_ENV = "SA_MCP_GATEWAY_KEY"
#: 게이트웨이에서 이 도구가 올라가 있는 서버 이름. 도구 이름은 `<서버>-<도구>` 로 붙는다.
GATEWAY_MAIL_SERVER_ENV = "SA_MCP_GATEWAY_MAIL_SERVER"
_GATEWAY_MAIL_SERVER_DEFAULT = "knox"

#: ⚠️ **사내 CA 를 명시해야 한다.** httpx 는 certifi 번들을 쓰는데 거기엔 사내 CA 가 없어
#: `[SSL: CERTIFICATE_VERIFY_FAILED] self-signed certificate in certificate chain` 이 난다
#: (curl 은 시스템 번들을 쓰므로 같은 URL 이 curl 로는 되고 코드로는 안 되는 형태로 나타난다).
#: 검증을 끄지 않는다 — 번들을 바꿔 끼운다.
GATEWAY_CA_ENV = "SA_MCP_GATEWAY_CA"
_SYSTEM_CA_DEFAULT = "/etc/ssl/certs/ca-certificates.crt"


def _gateway_verify() -> Any:
    """TLS 검증에 쓸 CA 번들. 지정이 없으면 시스템 번들, 그것도 없으면 기본값."""
    import os.path

    ca = (os.environ.get(GATEWAY_CA_ENV) or "").strip()
    if ca and os.path.exists(ca):
        return ca
    if os.path.exists(_SYSTEM_CA_DEFAULT):
        return _SYSTEM_CA_DEFAULT
    return True


def _gateway_config() -> tuple[str, str, str] | None:
    """(url, key, server) — 셋이 다 있을 때만. 하나라도 없으면 게이트웨이를 안 쓴다."""
    url = (os.environ.get(GATEWAY_URL_ENV) or "").strip().rstrip("/")
    key = (os.environ.get(GATEWAY_KEY_ENV) or "").strip()
    if not url or not key:
        return None
    server = (os.environ.get(GATEWAY_MAIL_SERVER_ENV) or "").strip() or _GATEWAY_MAIL_SERVER_DEFAULT
    return url, key, server


def _call_via_gateway(tool_name: str, args: dict[str, Any]) -> Any:
    """LiteLLM MCP 게이트웨이(streamable-http)로 한 번에 호출한다.

    옛 경로(SSE)와 다른 점 셋 — 실측으로 확인한 것만 적는다:
      1. `POST {url}/mcp/` 한 방. SSE 세션 수립·initialize 왕복이 없다.
      2. `Accept: application/json, text/event-stream` 이 **둘 다** 필요하다.
         하나만 주면 `-32600 Not Acceptable` 이 온다.
      3. 도구 이름에 서버 접두가 붙는다 — `knox_send_email` → `knox-knox_send_email`.

    ⚠️ `trust_env=False` — samsungds.net 은 전사 프록시에 걸려 "전사 차단" HTML 이 온다
       (프록시를 타면 JSON 대신 그 페이지를 파싱하게 된다).
    """
    cfg = _gateway_config()
    if cfg is None:
        raise OwnerMailError(f"{GATEWAY_URL_ENV}/{GATEWAY_KEY_ENV} 미설정")
    url, key, server = cfg
    qualified = tool_name if tool_name.startswith(f"{server}-") else f"{server}-{tool_name}"
    payload = {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": qualified, "arguments": args},
    }
    # ★ **ASCII 로 이스케이프해서 보낸다** (2026-09-01 실측으로 확정).
    #
    #   게이트웨이는 요청 본문을 4096 바이트 조각으로 잘라 조각마다 따로 UTF-8 디코딩한다.
    #   한글은 3바이트라 한 글자가 그 경계를 걸치면 조각이 반쪽 글자로 끝나고 —
    #       HTTP 500 {"details": "'utf-8' codec can't decode byte 0xea in position 4095"}
    #   같은 본문을 `\uXXXX` 로 이스케이프해 보내면 그대로 200 이다(양쪽 다 재현했다).
    #
    #   ⚠️ httpx 의 `json=` 은 못 쓴다 — 0.28 부터 `ensure_ascii=False` 로 직렬화해서
    #      원시 UTF-8 을 그대로 싣는다(`_content.encode_json`). 우리가 직렬화한다.
    #   ⚠️ 본문이 4KB 를 넘고 한글이 경계에 걸릴 때만 터지므로 **길이·내용에 따라 되다 안 되다**
    #      한다. "간헐적 게이트웨이 장애" 로 보이지만 같은 메일은 항상 실패한다.
    body_bytes = json.dumps(payload, ensure_ascii=True).encode("ascii")
    try:
        with httpx.Client(timeout=90, trust_env=False, verify=_gateway_verify()) as client:
            r = client.post(
                f"{url}/mcp/",
                headers={
                    "Authorization": f"Bearer {key}",
                    "x-mcp-servers": server,
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                },
                content=body_bytes,
            )
            r.raise_for_status()
            body = r.text
    except httpx.HTTPStatusError as e:
        # ★ 응답 **본문**을 버리지 않는다. `raise_for_status()` 는 상태줄만 남기는데,
        #   게이트웨이는 실패 사유를 본문에 담아 준다(어떤 인자가 문제인지까지).
        #   2026-09-01: 이것 때문에 500 을 하루 종일 "게이트웨이 죽음" 으로 오진했다 —
        #   같은 시각 tools/list 와 최소 인자 발송은 200 이었다.
        detail = ""
        try:
            detail = (e.response.text or "").strip().replace("\n", " ")[:400]
        except Exception:  # noqa: BLE001 — 사유를 못 읽는다고 발송 실패를 감추지 않는다
            detail = ""
        raise OwnerMailError(
            f"MCP 게이트웨이 오류 HTTP {e.response.status_code}"
            + (f": {detail}" if detail else " (본문 없음)")
        ) from e
    except httpx.HTTPError as e:
        raise OwnerMailError(f"MCP 게이트웨이 연결 실패: {e}") from e

    # 응답이 SSE 프레임(`data: {...}`)으로 올 수도, 순수 JSON 으로 올 수도 있다.
    for line in body.replace("\r", "").split("\n"):
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line.startswith("{"):
            continue
        try:
            doc = json.loads(line)
        except ValueError:
            continue
        if "error" in doc:
            raise OwnerMailError(f"MCP 게이트웨이 오류: {str(doc['error'])[:300]}")
        if "result" in doc:
            return doc["result"]
    raise OwnerMailError(f"MCP 게이트웨이 응답을 못 읽었다: {body[:200]}")


def call_knox_mail_tool(
    tool_name: str,
    args: dict[str, Any],
    *,
    mcp_server_url: str | None = None,
) -> Any:
    """Call a Knox Mail MCP tool over JSON-RPC 2.0 over SSE.

    Ported from VulnerMove's mailSendService.ts. Each call opens a fresh SSE
    session, initializes it, and then invokes the tool.
    """
    # ★ 게이트웨이가 설정돼 있으면 그쪽을 쓴다. 옛 SSE 경로는 폴백으로 남긴다 —
    #   구 호스트가 되살아나는 환경(개발기 등)에서 코드를 안 바꾸고 돌 수 있게.
    if mcp_server_url is None and _gateway_config() is not None:
        return _call_via_gateway(tool_name, args)

    base_url = (mcp_server_url or _mcp_server_url()).rstrip("/")
    endpoint_path = ""
    try:
        with httpx.Client(timeout=None, trust_env=False) as client:
            with client.stream(
                "GET",
                f"{base_url}/sse",
                headers={"Accept": "text/event-stream"},
                timeout=90,
            ) as response:
                response.raise_for_status()
                events = _events(response.iter_lines())
                for event_type, data in events:
                    if event_type == "endpoint" and data:
                        endpoint_path = data
                        break
                if not endpoint_path:
                    raise OwnerMailError("Knox Mail MCP endpoint 이벤트를 받지 못했습니다.")

                _post_message(client, base_url, endpoint_path, {
                    "jsonrpc": "2.0",
                    "method": "initialize",
                    "id": 1,
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "secu-agent-mail", "version": "1.0.0"},
                    },
                })
                _wait_for_response(events, 1, timeout_seconds=10)
                _post_message(client, base_url, endpoint_path, {
                    "jsonrpc": "2.0",
                    "method": "notifications/initialized",
                })
                _post_message(client, base_url, endpoint_path, {
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "id": 2,
                    "params": {"name": tool_name, "arguments": args},
                })
                return _wait_for_response(events, 2, timeout_seconds=60)
    except httpx.HTTPError as e:
        raise OwnerMailError(f"Knox Mail MCP 연결 실패: {e}") from e


def _parse_tool_result(result: Any) -> dict[str, Any]:
    raw: Any = None
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, list) and content:
            first = content[0]
            if isinstance(first, dict):
                raw = first.get("text")
        structured = result.get("structuredContent")
        if raw is None and isinstance(structured, dict):
            raw = structured.get("result")
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except ValueError as e:
            raise OwnerMailError(f"Knox Mail MCP 결과 JSON 파싱 실패: {e}") from e
        if isinstance(parsed, dict):
            return parsed
    if isinstance(result, dict):
        return result
    raise OwnerMailError("Knox Mail MCP 결과 형식을 해석할 수 없습니다.")


def send_owner_mail(
    *,
    sender: str,
    recipients: list[str],
    subject: str,
    content: str,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    content_type: str = "HTML",
    doc_secu_type: str = "OFFICIAL",
) -> dict[str, Any]:
    to = [r.strip() for r in recipients if r and r.strip()]
    cc_list = [r.strip() for r in (cc or []) if r and r.strip()]
    bcc_list = [r.strip() for r in (bcc or []) if r and r.strip()]
    if not to:
        raise OwnerMailError("TO 수신자가 없습니다.")
    if not subject.strip():
        raise OwnerMailError("제목이 비어 있습니다.")
    if not content.strip():
        raise OwnerMailError("본문이 비어 있습니다.")

    mcp_args: dict[str, Any] = {
        "sender": sender.split("@", 1)[0],
        "recipients": to,
        "subject": subject,
        "content": content,
        "content_type": content_type or "HTML",
        "doc_secu_type": doc_secu_type or "OFFICIAL",
    }
    if cc_list:
        mcp_args["cc"] = cc_list
    if bcc_list:
        mcp_args["bcc"] = bcc_list

    result = call_knox_mail_tool("knox_send_email", mcp_args)
    parsed = _parse_tool_result(result)
    if not parsed.get("success"):
        raise OwnerMailError(str(parsed.get("message") or "Knox 메일 발송 실패"))
    return {
        "sent": True,
        "to": to,
        "cc": cc_list,
        "bcc": bcc_list,
        "from": mcp_args["sender"],
        "subject": subject,
        "knox_result": parsed,
    }
