"""KnoxBridge — 인가→세션바인딩→turn→render→send + 승인 회신 라우팅."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from secu_agent import state
from secu_agent.agent.events import TextChunk
from secu_agent.agent.tools.approval import ApprovalRequest
from secu_agent.knox.approval import KnoxApprovalRegistry, short_id_for
from secu_agent.knox.bridge import KnoxBridge, parse_approval_reply
from secu_agent.knox.client import KnoxMessage
from secu_agent.knox.config import KnoxConfig, RoomConfig


class FakeClient:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    async def send(self, chatroom_id: str, text: str):
        self.sent.append((chatroom_id, text))
        return [{"ok": True}]

    async def aclose(self) -> None:
        pass


class FakeSession:
    def __init__(self, events) -> None:
        self._events = events
        self.context = SimpleNamespace(approval_resolver=None)

    async def turn(self, text):
        for ev in self._events:
            yield ev


def _cfg() -> KnoxConfig:
    return KnoxConfig(rooms={
        "room-A": RoomConfig(
            chatroom_id="room-A", charter_ref="CHG-1", agent_type="smb",
            allowed_singleids={"shaneee.baek"}, approval_mode="ask",
        ),
    })


def _msg(chatroom_id="room-A", single="shaneee.baek", text="status 요약", msgid=1):
    return KnoxMessage.from_raw({
        "chatroomId": chatroom_id, "msgid": msgid, "text": text,
        "sender_profile": {"singleID": single},
    })


# ------------------------------- pure parser ---------------------------------
def test_parse_approval_reply():
    assert parse_approval_reply("approve ab12cd") == (True, "ab12cd")
    assert parse_approval_reply("deny ab12cd") == (False, "ab12cd")
    assert parse_approval_reply("승인 xyz") == (True, "xyz")
    assert parse_approval_reply("거부 xyz") == (False, "xyz")
    assert parse_approval_reply("status 요약 해줘") is None
    assert parse_approval_reply("approve") is None


# ------------------------------- turn path -----------------------------------
@pytest.mark.anyio
async def test_allowed_message_runs_turn_and_replies(tmp_db):
    client = FakeClient()
    sess = FakeSession([TextChunk(text="결과"), TextChunk(text="입니다")])
    bridge = KnoxBridge(
        client=client, config=_cfg(), own_singleid="th-bot",
        session_loader=lambda sid, agent_type: sess,
    )
    await bridge.handle(_msg(text="status 요약"))
    await bridge.join()
    assert ("room-A", "결과입니다") in client.sent
    # chatroom ↔ session 영속 바인딩
    m = state.knox_room_session_get("room-A")
    assert m is not None and m["agent_type"] == "smb" and m["charter_ref"] == "CHG-1"
    await bridge.aclose()


@pytest.mark.anyio
async def test_disallowed_sender_is_silent(tmp_db):
    client = FakeClient()
    sess = FakeSession([TextChunk(text="x")])
    bridge = KnoxBridge(
        client=client, config=_cfg(), own_singleid="th-bot",
        session_loader=lambda sid, agent_type: sess,
    )
    await bridge.handle(_msg(single="intruder", text="hack"))
    await bridge.join()
    assert client.sent == []
    assert state.knox_room_session_get("room-A") is None
    await bridge.aclose()


@pytest.mark.anyio
async def test_unconfigured_room_is_silent(tmp_db):
    client = FakeClient()
    bridge = KnoxBridge(
        client=client, config=_cfg(), own_singleid="th-bot",
        session_loader=lambda sid, agent_type: FakeSession([]),
    )
    await bridge.handle(_msg(chatroom_id="room-Z"))
    await bridge.join()
    assert client.sent == []
    await bridge.aclose()


@pytest.mark.anyio
async def test_self_message_skipped(tmp_db):
    client = FakeClient()
    bridge = KnoxBridge(
        client=client, config=_cfg(), own_singleid="th-bot",
        session_loader=lambda sid, agent_type: FakeSession([TextChunk(text="x")]),
    )
    await bridge.handle(_msg(single="th-bot"))
    await bridge.join()
    assert client.sent == []
    await bridge.aclose()


@pytest.mark.anyio
async def test_turn_error_sends_error_message(tmp_db):
    client = FakeClient()

    class BoomSession:
        def __init__(self):
            self.context = SimpleNamespace(approval_resolver=None)

        async def turn(self, text):
            raise RuntimeError("boom")
            yield  # pragma: no cover

    bridge = KnoxBridge(
        client=client, config=_cfg(), own_singleid="th-bot",
        session_loader=lambda sid, agent_type: BoomSession(),
    )
    await bridge.handle(_msg())
    await bridge.join()
    assert any("오류" in t and "boom" in t for _, t in client.sent)
    await bridge.aclose()


# --------------------- approval reply routing (concurrency) ------------------
@pytest.mark.anyio
async def test_approval_reply_resolves_in_flight_turn(tmp_db):
    """turn 이 승인 대기 중일 때, 메인 루프가 승인 회신을 읽어 해소한다(데드락 없음)."""
    client = FakeClient()
    registry = KnoxApprovalRegistry()

    class ApprovalSession:
        def __init__(self):
            self.context = SimpleNamespace(approval_resolver=None)

        async def turn(self, text):
            req = ApprovalRequest(
                invocation_id="inv-appr0001", tool_name="smb_write",
                tool_input={"p": 1}, reason="쓰기",
            )
            dec = await self.context.approval_resolver.resolve(req)
            yield TextChunk(text=f"decision={dec.behavior}")

    bridge = KnoxBridge(
        client=client, config=_cfg(), own_singleid="th-bot",
        registry=registry, approval_timeout=5.0,
        session_loader=lambda sid, agent_type: ApprovalSession(),
    )
    # 1) 점검 메시지 → 워커가 turn 시작 → 승인 프롬프트 게시 + 대기
    await bridge.handle(_msg(text="위험 작업 해줘", msgid=1))
    # 프롬프트가 올라올 때까지 대기
    for _ in range(200):
        await asyncio.sleep(0.01)
        if any("승인 필요" in t for _, t in client.sent):
            break
    assert any("승인 필요" in t for _, t in client.sent)
    # 2) 같은 방에서 승인 회신 → 메인 루프가 즉시 해소
    short = short_id_for("inv-appr0001")
    await bridge.handle(_msg(text=f"approve {short}", msgid=2))
    await bridge.join()
    assert ("room-A", "decision=allow") in client.sent
    await bridge.aclose()


@pytest.mark.anyio
async def test_poll_once_routes_messages(tmp_db):
    """폴링 경로: poll_messages 가 준 메시지들을 handle 로 라우팅."""
    client = FakeClient()

    class PollClient(FakeClient):
        def __init__(self, batch):
            super().__init__()
            self._batch = batch

        async def poll_messages(self, *, peek=False):
            b, self._batch = self._batch, []
            return b

    pc = PollClient([
        _msg(single="shaneee.baek", text="status", msgid=1),
        _msg(single="intruder", text="hack", msgid=2),  # 불허 → 무시
    ])
    bridge = KnoxBridge(
        client=pc, config=_cfg(), own_singleid="th-bot",
        session_loader=lambda sid, agent_type: FakeSession([TextChunk(text="ok")]),
    )
    n = await bridge._poll_once()
    await bridge.join()
    assert n == 2  # 2건 받음
    # 허용된 1건만 응답
    assert ("room-A", "ok") in pc.sent
    assert all(s != "hack" for _, s in pc.sent)
    await bridge.aclose()


@pytest.mark.anyio
async def test_approval_reply_does_not_start_turn(tmp_db):
    client = FakeClient()
    registry = KnoxApprovalRegistry()
    loaded = {"n": 0}

    def loader(sid, agent_type):
        loaded["n"] += 1
        return FakeSession([TextChunk(text="x")])

    bridge = KnoxBridge(
        client=client, config=_cfg(), own_singleid="th-bot",
        registry=registry, session_loader=loader,
    )
    # 대기 건 없음 — approve 회신은 turn 으로 처리되면 안 됨
    await bridge.handle(_msg(text="approve nope12", msgid=5))
    await bridge.join()
    assert loaded["n"] == 0
    assert client.sent == []
    await bridge.aclose()
