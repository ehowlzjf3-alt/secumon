"""KnoxDaemonClient — 8771 데몬 HTTP 래퍼 + SSE 파싱/dedup."""
from __future__ import annotations

import json

import httpx
import pytest

from secu_agent.knox.client import (
    KnoxDaemonClient,
    KnoxMessage,
    _SeenSet,
    iter_sse_messages,
)


def _client(handler) -> KnoxDaemonClient:
    transport = httpx.MockTransport(handler)
    return KnoxDaemonClient(base_url="http://127.0.0.1:8771", transport=transport)


# --------------------------- message normalization ---------------------------
def test_message_from_raw_extracts_singleid():
    raw = {
        "chatroomId": "205186313073722368",
        "msgid": 123,
        "sender": 813539424732188673,
        "text": "hello",
        "sender_profile": {"singleID": "shaneee.baek", "name": "백승한"},
    }
    m = KnoxMessage.from_raw(raw)
    assert m.chatroom_id == "205186313073722368"
    assert m.msgid == 123
    assert m.sender_singleid == "shaneee.baek"
    assert m.text == "hello"


def test_dedup_key_prefers_msgid_then_msgkey():
    a = KnoxMessage.from_raw({"chatroomId": "r", "msgid": 7, "text": "x"})
    b = KnoxMessage.from_raw({"chatroomId": "r", "msgkey": "k1", "text": "y"})
    assert a.dedup_key() == ("msgid", 7)
    assert b.dedup_key() == ("msgkey", "r", "k1")


# --------------------------- HTTP methods (MockTransport) ---------------------
@pytest.mark.anyio
async def test_health():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/health"
        return httpx.Response(200, json={"ok": True, "uptime_s": 1.0})

    c = _client(handler)
    out = await c.health()
    assert out["ok"] is True
    await c.aclose()


@pytest.mark.anyio
async def test_send_single_chunk_payload():
    seen: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/send"
        body = json.loads(req.content)
        seen.append(body)
        return httpx.Response(200, json={"ok": True, "result_code": 1000})

    c = _client(handler)
    out = await c.send("room-1", "hello world")
    assert seen == [{"chatroomId": "room-1", "text": "hello world"}]
    assert out[-1]["ok"] is True
    await c.aclose()


@pytest.mark.anyio
async def test_send_chunks_long_text():
    sent: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(json.loads(req.content)["text"])
        return httpx.Response(200, json={"ok": True})

    c = _client(handler)
    long = "\n".join(f"line{i}" for i in range(2000))  # > 3500 chars
    await c.send("room-1", long, max_chars=200)
    assert len(sent) > 1  # 청크 분할됨
    assert all(len(s) <= 200 for s in sent)
    assert "".join(s.replace("\n", "") for s in sent) == long.replace("\n", "")
    await c.aclose()


@pytest.mark.anyio
async def test_send_skips_empty_text():
    called = False

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json={"ok": True})

    c = _client(handler)
    out = await c.send("room-1", "   ")
    assert called is False
    assert out == []
    await c.aclose()


@pytest.mark.anyio
async def test_resolve_and_search_payloads():
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/resolve":
            assert json.loads(req.content) == {"single_ids": ["shaneee.baek"]}
            return httpx.Response(200, json={"ok": True, "userIds": {"shaneee.baek": 1}})
        if req.url.path == "/search":
            return httpx.Response(200, json={"ok": True, "count": 0, "people": []})
        return httpx.Response(404)

    c = _client(handler)
    r = await c.resolve(["shaneee.baek"])
    assert r["userIds"]["shaneee.baek"] == 1
    s = await c.search("보안")
    assert s["ok"] is True
    await c.aclose()


# --------------------------- SSE parsing + dedup -----------------------------
async def _alines(lines):
    for ln in lines:
        yield ln


@pytest.mark.anyio
async def test_iter_sse_parses_data_and_skips_keepalive():
    lines = [
        ": keepalive",
        'data: {"chatroomId":"r","msgid":1,"text":"a"}',
        "",
        'data: {"chatroomId":"r","msgid":2,"text":"b"}',
        "",
    ]
    seen = _SeenSet()
    got = [m async for m in iter_sse_messages(_alines(lines), seen)]
    assert [m.text for m in got] == ["a", "b"]


@pytest.mark.anyio
async def test_iter_sse_dedups_by_msgid():
    lines = [
        'data: {"chatroomId":"r","msgid":1,"text":"a"}',
        "",
        'data: {"chatroomId":"r","msgid":1,"text":"dup"}',
        "",
    ]
    seen = _SeenSet()
    got = [m async for m in iter_sse_messages(_alines(lines), seen)]
    assert [m.text for m in got] == ["a"]


@pytest.mark.anyio
async def test_iter_sse_ignores_bad_json():
    lines = ["data: not-json", "", 'data: {"chatroomId":"r","msgid":9,"text":"ok"}', ""]
    seen = _SeenSet()
    got = [m async for m in iter_sse_messages(_alines(lines), seen)]
    assert [m.text for m in got] == ["ok"]


def test_seenset_is_bounded():
    s = _SeenSet(cap=3)
    for i in range(5):
        assert s.seen(("msgid", i)) is False
    # 가장 오래된 0,1 은 evict — 다시 보면 새것 취급
    assert s.seen(("msgid", 0)) is False
    # 최근 것은 여전히 중복
    assert s.seen(("msgid", 4)) is True
