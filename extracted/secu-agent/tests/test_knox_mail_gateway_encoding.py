"""MCP 게이트웨이 요청 본문 인코딩 — 한글이 4KB 경계에서 잘리지 않게.

## 왜 이 테스트가 있나 (2026-09-01 실측)

게이트웨이는 요청 본문을 4096 바이트 조각으로 잘라 조각마다 따로 UTF-8 디코딩한다.
한글은 3바이트라 한 글자가 경계에 걸치면 조각이 반쪽 글자로 끝난다 —

    HTTP 500 {"error":"MCP request failed",
              "details":"'utf-8' codec can't decode byte 0xea in position 4095"}

같은 본문을 `\\uXXXX` 로 이스케이프하면 200 이다(양쪽 다 라이브로 재현했다).

⚠️ 이 결함은 **우리가 아무것도 안 해도 다시 생긴다.** httpx 0.28 이 `encode_json` 을
   `ensure_ascii=False` 로 바꿨다 — `json=` 로 돌아가는 순간 원시 UTF-8 이 다시 나간다.
   그래서 "ASCII 로 나간다" 를 테스트로 못박는다.

⚠️ 증상이 "간헐적 게이트웨이 장애" 처럼 보인다. 본문이 4KB 를 넘고 한글이 하필 경계에
   걸릴 때만 터지기 때문이다. 하루를 오진에 썼다.
"""
from __future__ import annotations

import json

import pytest

from secu_agent.knox import owner_mail


class _Resp:
    status_code = 200
    text = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'

    def raise_for_status(self) -> None:
        return None


class _Client:
    """`content=` 로 실제 나간 바이트를 붙잡아 둔다."""

    captured: dict[str, object] = {}

    def __init__(self, *a, **kw) -> None:
        pass

    def __enter__(self) -> "_Client":
        return self

    def __exit__(self, *a) -> None:
        return None

    def post(self, url, *, headers=None, content=None, json=None, **kw):
        type(self).captured = {"url": url, "headers": headers, "content": content, "json": json}
        return _Resp()


@pytest.fixture
def _gateway(monkeypatch):
    monkeypatch.setenv(owner_mail.GATEWAY_URL_ENV, "https://gw.example.test")
    monkeypatch.setenv(owner_mail.GATEWAY_KEY_ENV, "sk-test")
    monkeypatch.setattr(owner_mail.httpx, "Client", _Client)
    _Client.captured = {}


def _korean_call(chars: int = 1298) -> None:
    owner_mail._call_via_gateway(
        "knox_send_email",
        {"subject": "공유 폴더 점검", "content": "<p>" + ("가" * chars) + "</p>"},
    )


def test_request_body_is_pure_ascii(_gateway) -> None:
    """★ 본문에 non-ASCII 바이트가 한 개도 없어야 한다 — 경계에 걸칠 글자가 없어진다."""
    _korean_call()
    body = _Client.captured["content"]
    assert isinstance(body, (bytes, bytearray)), "content= 로 직접 실어야 한다"
    assert max(body) < 128, "원시 UTF-8 이 나갔다 — 4KB 경계에서 게이트웨이가 500 을 낸다"


def test_body_still_decodes_to_the_same_payload(_gateway) -> None:
    """이스케이프는 표현만 바꾼다 — 게이트웨이가 읽는 값은 같아야 한다."""
    _korean_call(10)
    doc = json.loads(_Client.captured["content"].decode("ascii"))
    args = doc["params"]["arguments"]
    assert args["subject"] == "공유 폴더 점검"
    assert args["content"] == "<p>" + ("가" * 10) + "</p>"
    assert doc["params"]["name"] == "knox-knox_send_email"


def test_does_not_use_httpx_json_kwarg(_gateway) -> None:
    """`json=` 은 httpx 0.28 부터 `ensure_ascii=False` 다 — 쓰면 안 된다."""
    _korean_call(10)
    assert _Client.captured["json"] is None, "json= 로 돌아가면 결함이 그대로 재발한다"


def test_no_multibyte_char_straddles_the_4kb_boundary(_gateway) -> None:
    """실제로 터졌던 그 길이(한글 1298자)로 경계를 직접 확인한다."""
    _korean_call(1298)
    body = _Client.captured["content"]
    assert len(body) > 4096
    for edge in range(4096, len(body), 4096):
        assert body[edge] < 0x80, f"{edge} 바이트 경계에 멀티바이트 글자가 걸쳤다"


def test_http_500_error_carries_the_gateway_reason(monkeypatch) -> None:
    """500 의 **본문**이 사유다. 버리면 '연결 실패' 라는 틀린 이름만 남는다."""
    import httpx

    class _Failing(_Client):
        def post(self, url, **kw):
            request = httpx.Request("POST", url)
            response = httpx.Response(
                500, request=request,
                text='{"error":"MCP request failed","details":"codec can\'t decode byte 0xea"}',
            )
            raise httpx.HTTPStatusError("500", request=request, response=response)

    monkeypatch.setenv(owner_mail.GATEWAY_URL_ENV, "https://gw.example.test")
    monkeypatch.setenv(owner_mail.GATEWAY_KEY_ENV, "sk-test")
    monkeypatch.setattr(owner_mail.httpx, "Client", _Failing)

    with pytest.raises(owner_mail.OwnerMailError) as e:
        _korean_call(10)
    message = str(e.value)
    assert "500" in message
    assert "codec can't decode" in message, "게이트웨이가 준 사유가 사라졌다"
