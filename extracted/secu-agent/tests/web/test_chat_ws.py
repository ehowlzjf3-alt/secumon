"""/ws/chat WebSocket + /api/chat/history endpoint.

- token query param 인증 (env SA_CHAT_TOKEN 또는 default — LAN 내부)
- 단일 채널 multi-viewer (여러 ws 가 같은 session 구독)
- recv {"text": "..."} → operator agent turn → server send LoopEvent JSON 들
- /api/chat/history?limit=50 → 최근 메시지 (페이지 새로고침 replay)
"""
from __future__ import annotations

import json
import pytest
from typing import ClassVar

from pydantic import BaseModel


def _set_token(monkeypatch, tok: str = "tok-123"):
    monkeypatch.setenv("SA_CHAT_TOKEN", tok)


@pytest.fixture()
def fake_llm_patch(monkeypatch):
    """ChatSession 이 쓸 LLM client 를 fake 로 교체 — endpoint factory 가 호출."""
    from secu_agent.agent.llm.base import LLMClient
    from secu_agent.agent.llm.types import StreamMessageStop, StreamTextDelta, StreamUsage

    class _FakeLLM(LLMClient):
        @property
        def name(self):
            return "fake"

        async def stream(self, request):
            yield StreamTextDelta(text="자동응답 reply")
            yield StreamMessageStop(
                stop_reason="end_turn",
                usage=StreamUsage(input_tokens=1, output_tokens=1),
            )

    from secu_agent.web.routes import chat as chat_route
    monkeypatch.setattr(chat_route, "_make_llm_client",
                        lambda: _FakeLLM())
    return _FakeLLM


def test_chat_history_empty_initially(tmp_db, client, monkeypatch):
    _set_token(monkeypatch)
    r = client.get("/api/chat/history?token=tok-123&limit=10")
    assert r.status_code == 200
    body = r.json()
    assert "messages" in body
    assert body["messages"] == []


def test_chat_history_rejects_wrong_token(tmp_db, client, monkeypatch):
    _set_token(monkeypatch, "good")
    r = client.get("/api/chat/history?token=wrong&limit=10")
    assert r.status_code in (401, 403)


def test_chat_new_endpoint_creates_empty_latest_session(tmp_db, client, monkeypatch):
    from secu_agent import state

    _set_token(monkeypatch)
    old_sid = state.chat_session_get_or_create(agent_type="smb")
    state.chat_message_add(old_sid, role="user", content={"text": "old chat"})

    r = client.post("/api/chat/new?token=tok-123&agent_type=smb")

    assert r.status_code == 200
    body = r.json()
    assert body["agent_type"] == "smb"
    assert body["session_id"] != old_sid
    assert state.chat_session_get_or_create(agent_type="smb") == body["session_id"]

    history = client.get("/api/chat/history?token=tok-123&agent_type=smb").json()
    assert history["messages"] == []


def test_chat_new_endpoint_rejects_wrong_token(tmp_db, client, monkeypatch):
    _set_token(monkeypatch, "good")

    r = client.post("/api/chat/new?token=wrong&agent_type=smb")

    assert r.status_code in (401, 403)


def test_chat_sessions_api_creates_lists_and_archives_agents(
    tmp_db, client, monkeypatch,
):
    _set_token(monkeypatch)

    r = client.post(
        "/api/chat/sessions?token=tok-123",
        json={"agent_type": "web", "label": "dev web agent"},
    )
    assert r.status_code == 200
    created = r.json()["session"]
    assert created["agent_type"] == "web"
    assert created["label"] == "dev web agent"
    sid = created["id"]

    listed = client.get("/api/chat/sessions?token=tok-123&agent_type=web").json()
    assert listed["total"] == 1
    assert listed["items"][0]["id"] == sid

    patched = client.patch(
        f"/api/chat/sessions/{sid}?token=tok-123",
        json={"status": "archived"},
    )
    assert patched.status_code == 200
    assert patched.json()["session"]["status"] == "archived"

    active = client.get("/api/chat/sessions?token=tok-123&agent_type=web").json()
    assert active["items"] == []
    archived = client.get(
        "/api/chat/sessions?token=tok-123&agent_type=web&include_archived=true",
    ).json()
    assert archived["items"][0]["id"] == sid


def test_chat_sessions_api_creates_generic_agent_by_default(
    tmp_db, client, monkeypatch,
):
    _set_token(monkeypatch)

    r = client.post(
        "/api/chat/sessions?token=tok-123",
        json={"label": "office/dev autonomous agent"},
    )

    assert r.status_code == 200
    created = r.json()["session"]
    assert created["agent_type"] == "agent"
    assert created["label"] == "office/dev autonomous agent"

    listed = client.get("/api/chat/sessions?token=tok-123&agent_type=agent").json()
    assert listed["total"] == 1
    assert listed["agent_types"][0] == "agent"


def test_chat_sessions_api_ends_agent_session_without_deleting_history(
    tmp_db, client, monkeypatch,
):
    from secu_agent import state

    _set_token(monkeypatch)
    sid = state.chat_session_new(agent_type="agent", label="delete me")
    state.chat_message_add(sid, role="user", content={"text": "remove"})

    r = client.delete(f"/api/chat/sessions/{sid}?token=tok-123")

    assert r.status_code == 200
    assert r.json()["ended"] is True
    assert r.json()["deleted"] is False
    row = state.chat_session_get(sid)
    assert row is not None
    assert row["status"] == "archived"
    assert state.chat_messages_for(sid)[0]["content"]["text"] == "remove"
    active = client.get("/api/chat/sessions?token=tok-123&agent_type=agent").json()
    assert active["total"] == 0
    archived = client.get(
        "/api/chat/sessions?token=tok-123&agent_type=agent&include_archived=true",
    ).json()
    assert archived["total"] == 1
    assert archived["items"][0]["id"] == sid


def test_chat_history_returns_persisted_messages(tmp_db, client, monkeypatch):
    from secu_agent import state
    _set_token(monkeypatch)
    sid = state.chat_session_get_or_create()
    state.chat_message_add(sid, role="user", content={"text": "안녕"})
    state.chat_message_add(sid, role="assistant", content={"text": "응 잘 지내?"})

    r = client.get("/api/chat/history?token=tok-123&limit=10")
    assert r.status_code == 200
    msgs = r.json()["messages"]
    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"]["text"] == "안녕"


def test_chat_history_can_target_agent_session(tmp_db, client, monkeypatch):
    from secu_agent import state

    _set_token(monkeypatch)
    s1 = state.chat_session_new(agent_type="web", label="one")
    s2 = state.chat_session_new(agent_type="web", label="two")
    state.chat_message_add(s1, role="user", content={"text": "first agent"})
    state.chat_message_add(s2, role="user", content={"text": "second agent"})

    r = client.get(
        f"/api/chat/history?token=tok-123&agent_type=web&session_id={s1}",
    )
    assert r.status_code == 200
    body = r.json()
    assert body["session_id"] == s1
    assert [m["content"]["text"] for m in body["messages"]] == ["first agent"]


def test_ws_chat_rejects_wrong_token(tmp_db, client, monkeypatch):
    _set_token(monkeypatch, "good")
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/chat?token=bad") as ws:
            ws.receive_text()


def test_ws_chat_full_turn_yields_events(tmp_db, client, monkeypatch, fake_llm_patch):
    """browser → server text → server streams events → 종료."""
    _set_token(monkeypatch)
    with client.websocket_connect("/ws/chat?token=tok-123") as ws:
        ws.send_text(json.dumps({"text": "pending share 보여줘"}))

        seen_types = []
        for _ in range(50):  # 안전 limit
            raw = ws.receive_text()
            payload = json.loads(raw)
            seen_types.append(payload.get("event"))
            if payload.get("event") == "LoopCompleted":
                break

        assert "TextChunk" in seen_types or "LoopCompleted" in seen_types

    # DB 에 user + assistant 영속
    from secu_agent import state
    sid = state.chat_session_get_or_create()
    roles = [m["role"] for m in state.chat_messages_for(sid)]
    assert "user" in roles
    assert "assistant" in roles


def test_ws_chat_can_run_against_explicit_agent_session(
    tmp_db, client, monkeypatch, fake_llm_patch,
):
    from secu_agent import state

    _set_token(monkeypatch)
    sid = state.chat_session_new(agent_type="web", label="web agent")
    with client.websocket_connect(
        f"/ws/chat?token=tok-123&agent_type=web&session_id={sid}",
    ) as ws:
        ws.send_text(json.dumps({"text": "hello web agent"}))
        events = []
        for _ in range(50):
            payload = json.loads(ws.receive_text())
            events.append(payload.get("event"))
            if payload.get("event") == "LoopCompleted":
                break

    assert "LoopCompleted" in events
    rows = state.chat_messages_for(sid)
    assert any(
        row["role"] == "user"
        and row["content"].get("text") == "hello web agent"
        for row in rows
    )


def test_ws_chat_can_run_against_generic_agent_session(
    tmp_db, client, monkeypatch, fake_llm_patch,
):
    from secu_agent import state

    _set_token(monkeypatch)
    sid = state.chat_session_new(agent_type="agent", label="general agent")
    with client.websocket_connect(
        f"/ws/chat?token=tok-123&agent_type=agent&session_id={sid}",
    ) as ws:
        ws.send_text(json.dumps({"text": "오피스/개발망을 알아서 훑어줘"}))
        events = []
        for _ in range(50):
            payload = json.loads(ws.receive_text())
            events.append(payload.get("event"))
            if payload.get("event") == "LoopCompleted":
                break

    assert "LoopCompleted" in events
    rows = state.chat_messages_for(sid)
    assert any(
        row["role"] == "user"
        and "오피스/개발망" in row["content"].get("text", "")
        for row in rows
    )


def test_ws_chat_new_slash_command_resets_to_empty_session(
    tmp_db, client, monkeypatch,
):
    from secu_agent import state

    _set_token(monkeypatch)
    old_sid = state.chat_session_get_or_create(agent_type="smb")
    state.chat_message_add(old_sid, role="user", content={"text": "old chat"})

    with client.websocket_connect("/ws/chat?token=tok-123") as ws:
        ws.send_text(json.dumps({"text": "/new"}))
        payload = json.loads(ws.receive_text())

    assert payload["event"] == "ChatSessionReset"
    assert payload["agent_type"] == "agent"
    assert payload["session_id"] != old_sid
    assert state.chat_session_get_or_create(agent_type="agent") == payload["session_id"]
    assert state.chat_messages_for(payload["session_id"]) == []


def test_ws_chat_new_action_resets_to_empty_session(
    tmp_db, client, monkeypatch,
):
    from secu_agent import state

    _set_token(monkeypatch)
    old_sid = state.chat_session_get_or_create(agent_type="smb")
    state.chat_message_add(old_sid, role="user", content={"text": "old chat"})

    with client.websocket_connect("/ws/chat?token=tok-123") as ws:
        ws.send_text(json.dumps({"action": "new"}))
        payload = json.loads(ws.receive_text())

    assert payload["event"] == "ChatSessionReset"
    assert payload["session_id"] != old_sid
    assert state.chat_messages_for(payload["session_id"]) == []


def test_chat_history_agent_type_scoped(tmp_db, client, monkeypatch):
    """agent_type=smb 와 agent_type=github 의 history 가 분리됨."""
    from secu_agent import state
    _set_token(monkeypatch)
    s_smb = state.chat_session_get_or_create(agent_type="smb")
    s_gh = state.chat_session_get_or_create(agent_type="github")
    state.chat_message_add(s_smb, role="user", content={"text": "smb msg"})
    state.chat_message_add(s_gh, role="user", content={"text": "github msg"})

    r_smb = client.get("/api/chat/history?token=tok-123&agent_type=smb").json()
    r_gh = client.get("/api/chat/history?token=tok-123&agent_type=github").json()
    smb_texts = [m["content"]["text"] for m in r_smb["messages"]]
    gh_texts = [m["content"]["text"] for m in r_gh["messages"]]
    assert "smb msg" in smb_texts
    assert "github msg" not in smb_texts
    assert "github msg" in gh_texts


def test_ws_chat_isolates_by_agent_type(tmp_db, client, monkeypatch, fake_llm_patch):
    """smb agent_type ws 와 github agent_type ws 는 broadcast 분리."""
    _set_token(monkeypatch)
    with client.websocket_connect("/ws/chat?token=tok-123&agent_type=smb") as ws_smb, \
         client.websocket_connect("/ws/chat?token=tok-123&agent_type=github") as ws_gh:
        ws_smb.send_text(json.dumps({"text": "smb-hi"}))

        def _drain(ws, max_events=30):
            collected = []
            for _ in range(max_events):
                try:
                    raw = ws.receive_text()
                except Exception:
                    break
                payload = json.loads(raw)
                collected.append(payload)
                if payload.get("event") == "LoopCompleted":
                    break
            return collected

        smb_events = _drain(ws_smb)
        # github ws 는 아무것도 못 받아야 함 (다른 agent_type)
        # — 짧게 drain 시도 후 timeout. 받은 게 있으면 fail.
        import threading, queue
        q = queue.Queue()

        def _try_recv():
            try:
                q.put(ws_gh.receive_text())
            except Exception as e:
                q.put(e)

        t = threading.Thread(target=_try_recv, daemon=True)
        t.start()
        t.join(timeout=0.5)
        # 못 받았어야 — queue 비어있어야
        assert q.empty(), f"github ws got smb broadcast: {q.get_nowait()!r}"

        assert any(e.get("event") == "LoopCompleted" for e in smb_events)


def test_ws_chat_non_smb_agent_type_runs_agent_turn(
    tmp_db, client, monkeypatch, fake_llm_patch,
):
    """github/jenkins/confluence/web agent_type 도 미구현 차단 없이 agent turn 실행."""
    _set_token(monkeypatch)
    with client.websocket_connect("/ws/chat?token=tok-123&agent_type=github") as ws:
        ws.send_text(json.dumps({"text": "repo exposure 확인해줘"}))

        seen = []
        for _ in range(50):
            raw = ws.receive_text()
            payload = json.loads(raw)
            seen.append(payload)
            if payload.get("event") in ("LoopCompleted", "LoopError"):
                break

    events = [e.get("event") for e in seen]
    assert "LoopCompleted" in events
    assert not any("아직 미구현" in e.get("message", "") for e in seen)

    from secu_agent import state
    sid = state.chat_session_get_or_create(agent_type="github")
    roles = [m["role"] for m in state.chat_messages_for(sid)]
    assert "user" in roles
    assert "assistant" in roles


def test_ws_chat_multi_viewer_broadcasts(tmp_db, client, monkeypatch, fake_llm_patch):
    """두 ws 가 같은 agent_type session 에 join — 한 쪽이 input 보내면 양쪽 다 events 받음."""
    _set_token(monkeypatch)
    with client.websocket_connect("/ws/chat?token=tok-123&agent_type=smb") as ws_a, \
         client.websocket_connect("/ws/chat?token=tok-123&agent_type=smb") as ws_b:
        ws_a.send_text(json.dumps({"text": "hi"}))

        def _drain(ws):
            collected = []
            for _ in range(30):
                try:
                    raw = ws.receive_text()
                except Exception:
                    break
                payload = json.loads(raw)
                collected.append(payload.get("event"))
                if payload.get("event") == "LoopCompleted":
                    break
            return collected

        events_a = _drain(ws_a)
        events_b = _drain(ws_b)

        assert "LoopCompleted" in events_a
        assert "LoopCompleted" in events_b


def test_ws_chat_inactivity_watchdog_kills_hung_turn(tmp_db, client, monkeypatch):
    """LLM/도구 hang (이벤트 0개) → inactivity 임계 후 LoopError 로 끊김."""
    import asyncio as _aio
    _set_token(monkeypatch)
    # watchdog 빠르게 발동시키기
    monkeypatch.setenv("SA_CHAT_INACTIVITY_TIMEOUT", "0.5")
    monkeypatch.setenv("SA_CHAT_INACTIVITY_CHECK_INTERVAL", "0.1")

    # ChatSession.load → 무한 hang 하는 turn 반환
    from secu_agent.web.routes import chat as chat_route

    class _HangSession:
        session_id = 1

        async def turn(self, text):
            await _aio.sleep(60)  # 60초 sleep — watchdog 이 먼저 끊어야
            return
            yield  # noqa

    monkeypatch.setattr(
        chat_route.ChatSession, "load",
        classmethod(lambda cls, **kw: _HangSession()),
    )

    with client.websocket_connect("/ws/chat?token=tok-123") as ws:
        ws.send_text(json.dumps({"text": "hang"}))
        seen = []
        for _ in range(20):
            try:
                raw = ws.receive_text()
            except Exception:
                break
            payload = json.loads(raw)
            seen.append(payload)
            if payload.get("event") == "LoopError":
                break
        # watchdog 으로 끊겼다는 메시지 — "무활동" 텍스트 포함
        loop_errors = [e for e in seen if e.get("event") == "LoopError"]
        assert loop_errors, f"expected LoopError, got: {[e.get('event') for e in seen]}"
        assert "무활동" in loop_errors[0]["message"]


def test_ws_chat_cancel_action_aborts_turn(tmp_db, client, monkeypatch):
    """{"action":"cancel"} 메시지 받으면 진행 중 turn cancel + LoopError broadcast."""
    import asyncio as _aio
    _set_token(monkeypatch)
    # watchdog 은 짧게 설정 안 함 — cancel 이 먼저 발동해야
    monkeypatch.setenv("SA_CHAT_INACTIVITY_TIMEOUT", "60")

    from secu_agent.web.routes import chat as chat_route

    class _SlowSession:
        session_id = 1

        async def turn(self, text):
            # 천천히 yield — cancel 받기 전에 끝나면 안됨
            await _aio.sleep(5)
            return
            yield  # noqa

    monkeypatch.setattr(
        chat_route.ChatSession, "load",
        classmethod(lambda cls, **kw: _SlowSession()),
    )

    with client.websocket_connect("/ws/chat?token=tok-123") as ws:
        ws.send_text(json.dumps({"text": "go"}))
        # 잠시 대기 후 cancel 보냄
        import time
        time.sleep(0.3)
        ws.send_text(json.dumps({"action": "cancel"}))

        seen = []
        for _ in range(20):
            try:
                raw = ws.receive_text()
            except Exception:
                break
            payload = json.loads(raw)
            seen.append(payload)
            if payload.get("event") == "LoopError":
                break

        loop_errors = [e for e in seen if e.get("event") == "LoopError"]
        assert loop_errors, f"expected cancel LoopError, got: {[e.get('event') for e in seen]}"
        assert "cancel" in loop_errors[0]["message"] or "사용자" in loop_errors[0]["message"]


def test_ws_chat_streaming_keeps_alive_past_inactivity_threshold(
    tmp_db, client, monkeypatch,
):
    """이벤트 흐르고 있으면 inactivity 누적 안 됨 — 임계보다 오래 걸리는 turn 도 통과."""
    import asyncio as _aio
    _set_token(monkeypatch)
    # threshold 짧게, but 이벤트 더 자주
    monkeypatch.setenv("SA_CHAT_INACTIVITY_TIMEOUT", "0.5")
    monkeypatch.setenv("SA_CHAT_INACTIVITY_CHECK_INTERVAL", "0.1")

    from secu_agent.web.routes import chat as chat_route
    from secu_agent.agent.events import (
        TurnStarted, TextChunk, LoopCompleted, StreamUsage,
    )

    class _StreamSession:
        session_id = 1

        async def turn(self, text):
            yield TurnStarted(turn=1)
            # 0.1초마다 chunk — total 1.5초 (threshold 0.5 보다 김)
            for i in range(15):
                yield TextChunk(text=f"chunk-{i}")
                await _aio.sleep(0.1)
            yield LoopCompleted(
                reason="end_turn", total_turns=1, final_message="done",
                usage=StreamUsage(input_tokens=0, output_tokens=0),
            )

    monkeypatch.setattr(
        chat_route.ChatSession, "load",
        classmethod(lambda cls, **kw: _StreamSession()),
    )

    with client.websocket_connect("/ws/chat?token=tok-123") as ws:
        ws.send_text(json.dumps({"text": "stream"}))
        seen = []
        for _ in range(50):
            try:
                raw = ws.receive_text()
            except Exception:
                break
            payload = json.loads(raw)
            seen.append(payload)
            if payload.get("event") in ("LoopCompleted", "LoopError"):
                break
        # 끝까지 갔어야 함 — LoopError 면 안 됨
        events = [e.get("event") for e in seen]
        assert "LoopCompleted" in events, (
            f"streaming should NOT trigger watchdog: events={events}"
        )
        assert "LoopError" not in events


class _ApprovalProbeInput(BaseModel):
    command: str


from secu_agent.agent.tools.base import Tool


class _ApprovalProbeTool(Tool[_ApprovalProbeInput]):
    name: ClassVar[str] = "approval_probe"
    description: ClassVar[str] = "test destructive approval probe"
    input_model: ClassVar[type[BaseModel]] = _ApprovalProbeInput
    is_read_only: ClassVar[bool] = False
    is_destructive: ClassVar[bool] = True
    deferred: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    prompt_section: ClassVar[str] = ""
    dispatch_keywords: ClassVar[tuple[str, ...]] = ()
    requires_capabilities: ClassVar[frozenset[str]] = frozenset()

    @classmethod
    def input_schema(cls):
        return cls.input_model.model_json_schema()

    async def check_permission(self, validated_input, context):
        from secu_agent.agent.tools.base import PermissionDecision
        del validated_input, context
        return PermissionDecision(behavior="ask", reason="test approval required")

    async def execute(self, validated_input, context):
        from secu_agent.agent.tools.base import ToolSuccess
        del context
        return ToolSuccess(content=f"approved command={validated_input.command}")


@pytest.fixture()
def approval_probe_patch(monkeypatch):
    from secu_agent.agent.eval.scripted_llm import (
        ScriptedLLMClient, ScriptedToolCall, ScriptedTurn,
    )
    from secu_agent.agent.tools.registry import ToolRegistry
    from secu_agent.web.routes import chat as chat_route
    import secu_agent.agent.chat_session as chat_session_mod

    def _registry(_task_type, *, frontend_capabilities=None):
        del frontend_capabilities
        registry = ToolRegistry()
        registry.register(_ApprovalProbeTool)
        return registry

    monkeypatch.setattr(chat_session_mod, "build_registry_for_task", _registry)
    monkeypatch.setattr(chat_route, "_make_llm_client", lambda: ScriptedLLMClient(turns=[
        ScriptedTurn(tool_calls=[
            ScriptedToolCall(
                name="approval_probe",
                input={"command": "dangerous-op"},
                id="approval-call-1",
            ),
        ]),
        ScriptedTurn(text="approval flow done"),
    ]))


def test_ws_chat_approval_allow_runs_destructive_tool(
    tmp_db, client, monkeypatch, approval_probe_patch,
):
    _set_token(monkeypatch)
    monkeypatch.setenv("SA_CHAT_APPROVAL_MODE", "manual")
    with client.websocket_connect("/ws/chat?token=tok-123") as ws:
        ws.send_text(json.dumps({"text": "run approval probe"}))
        seen = []
        approval_id = None
        for _ in range(20):
            payload = json.loads(ws.receive_text())
            seen.append(payload)
            if payload.get("event") == "ApprovalRequested":
                approval_id = payload["approval_id"]
                assert payload["tool_name"] == "approval_probe"
                assert payload["tool_input"] == {"command": "dangerous-op"}
                ws.send_text(json.dumps({
                    "action": "approval",
                    "approval_id": approval_id,
                    "decision": "allow",
                    "reason": "test ok",
                }))
            if payload.get("event") == "LoopCompleted":
                break

    events = [e.get("event") for e in seen]
    assert "ApprovalRequested" in events
    assert any(e.get("event") == "ApprovalResolved" and e.get("decision") == "allow"
               for e in seen)
    completed = [e for e in seen if e.get("event") == "ToolCallCompleted"]
    assert completed
    assert completed[0]["ok"] is True
    assert "approved command=dangerous-op" in completed[0]["result"]

    from secu_agent import state
    audit = state.approval_audit_get("approval-call-1")
    assert audit is not None
    assert audit["agent_type"] == "agent"
    assert audit["tool_name"] == "approval_probe"
    assert audit["decision"] == "allow"
    assert audit["decision_reason"] == "test ok"
    assert len(audit["tool_input_hash"]) == 64


def test_ws_chat_approval_deny_blocks_destructive_tool(
    tmp_db, client, monkeypatch, approval_probe_patch,
):
    _set_token(monkeypatch)
    monkeypatch.setenv("SA_CHAT_APPROVAL_MODE", "manual")
    with client.websocket_connect("/ws/chat?token=tok-123") as ws:
        ws.send_text(json.dumps({"text": "run approval probe"}))
        seen = []
        for _ in range(20):
            payload = json.loads(ws.receive_text())
            seen.append(payload)
            if payload.get("event") == "ApprovalRequested":
                ws.send_text(json.dumps({
                    "action": "approval",
                    "approval_id": payload["approval_id"],
                    "decision": "deny",
                    "reason": "not allowed",
                }))
            if payload.get("event") == "LoopCompleted":
                break

    completed = [e for e in seen if e.get("event") == "ToolCallCompleted"]
    assert completed
    assert completed[0]["ok"] is False
    assert "not allowed" in completed[0]["result"]

    from secu_agent import state
    audit = state.approval_audit_get("approval-call-1")
    assert audit is not None
    assert audit["decision"] == "deny"
    assert audit["decision_reason"] == "not allowed"


def test_ws_chat_approval_auto_allow_is_default(
    tmp_db, client, monkeypatch, approval_probe_patch,
):
    _set_token(monkeypatch)
    monkeypatch.delenv("SA_CHAT_APPROVAL_MODE", raising=False)
    with client.websocket_connect("/ws/chat?token=tok-123") as ws:
        ws.send_text(json.dumps({"text": "run approval probe"}))
        seen = []
        for _ in range(20):
            payload = json.loads(ws.receive_text())
            seen.append(payload)
            if payload.get("event") == "LoopCompleted":
                break

    events = [e.get("event") for e in seen]
    assert "ApprovalRequested" not in events
    assert any(
        e.get("event") == "ApprovalResolved"
        and e.get("decision") == "allow"
        and e.get("mode") == "auto"
        for e in seen
    )
    completed = [e for e in seen if e.get("event") == "ToolCallCompleted"]
    assert completed
    assert completed[0]["ok"] is True

    from secu_agent import state
    audit = state.approval_audit_get("approval-call-1")
    assert audit is not None
    assert audit["decision"] == "allow"
    assert audit["decision_reason"] == "auto approval mode"


def test_ws_chat_smart_approval_uses_llm_judge(
    tmp_db, client, monkeypatch, approval_probe_patch,
):
    from secu_agent.agent.eval.scripted_llm import ScriptedLLMClient, ScriptedTurn
    from secu_agent.web.routes import chat as chat_route

    _set_token(monkeypatch)
    monkeypatch.setenv("SA_CHAT_APPROVAL_MODE", "smart")
    monkeypatch.setattr(
        chat_route,
        "_make_smart_approval_client",
        lambda: ScriptedLLMClient([
            ScriptedTurn(text='{"decision":"deny","reason":"outside approved scope"}'),
        ]),
    )

    with client.websocket_connect("/ws/chat?token=tok-123") as ws:
        ws.send_text(json.dumps({"text": "run approval probe"}))
        seen = []
        for _ in range(20):
            payload = json.loads(ws.receive_text())
            seen.append(payload)
            if payload.get("event") == "LoopCompleted":
                break

    assert any(
        e.get("event") == "ApprovalResolved"
        and e.get("decision") == "deny"
        and e.get("mode") == "smart"
        and e.get("source") == "llm"
        for e in seen
    )
    completed = [e for e in seen if e.get("event") == "ToolCallCompleted"]
    assert completed
    assert completed[0]["ok"] is False
    assert "outside approved scope" in completed[0]["result"]


def test_ws_chat_busy_followup_queues_after_current_turn(
    tmp_db, client, monkeypatch,
):
    import asyncio as _aio
    from types import SimpleNamespace
    from secu_agent.agent.events import LoopCompleted, TurnStarted
    from secu_agent.web.routes import chat as chat_route

    _set_token(monkeypatch)
    monkeypatch.setenv("SA_CHAT_INACTIVITY_TIMEOUT", "60")
    calls = []

    class _QueuedSession:
        session_id = 1

        def __init__(self):
            self.context = SimpleNamespace(signal=_aio.Event(), approval_resolver=None)

        async def turn(self, text):
            calls.append(text)
            yield TurnStarted(turn=len(calls))
            await _aio.sleep(0.4 if len(calls) == 1 else 0.01)
            yield LoopCompleted(
                reason="end_turn",
                total_turns=1,
                final_message=None,
                usage=None,
            )

    monkeypatch.setattr(
        chat_route.ChatSession, "load",
        classmethod(lambda cls, **kw: _QueuedSession()),
    )

    with client.websocket_connect("/ws/chat?token=tok-123") as ws:
        ws.send_text(json.dumps({"text": "첫 번째 작업"}))
        seen = []
        for _ in range(10):
            payload = json.loads(ws.receive_text())
            seen.append(payload)
            if payload.get("event") == "TurnStarted":
                break
        ws.send_text(json.dumps({"text": "끝나면 두 번째 작업"}))
        loop_completed = 0
        for _ in range(40):
            payload = json.loads(ws.receive_text())
            seen.append(payload)
            if payload.get("event") == "LoopCompleted":
                loop_completed += 1
                if loop_completed == 2:
                    break

    events = [e.get("event") for e in seen]
    assert "TurnInputQueued" in events
    assert loop_completed == 2
    assert calls == ["첫 번째 작업", "끝나면 두 번째 작업"]


def test_ws_chat_busy_revision_aborts_and_restarts_turn(
    tmp_db, client, monkeypatch,
):
    import asyncio as _aio
    from types import SimpleNamespace
    from secu_agent.agent.events import LoopCompleted, TurnStarted
    from secu_agent.web.routes import chat as chat_route

    _set_token(monkeypatch)
    monkeypatch.setenv("SA_CHAT_INACTIVITY_TIMEOUT", "60")
    calls = []
    cancelled = []

    class _RevisionSession:
        session_id = 1

        def __init__(self):
            self.context = SimpleNamespace(signal=_aio.Event(), approval_resolver=None)

        async def turn(self, text):
            calls.append(text)
            yield TurnStarted(turn=len(calls))
            try:
                await _aio.sleep(5 if len(calls) == 1 else 0.01)
            except _aio.CancelledError:
                cancelled.append(text)
                raise
            yield LoopCompleted(
                reason="end_turn",
                total_turns=1,
                final_message=None,
                usage=None,
            )

    monkeypatch.setattr(
        chat_route.ChatSession, "load",
        classmethod(lambda cls, **kw: _RevisionSession()),
    )

    with client.websocket_connect("/ws/chat?token=tok-123") as ws:
        ws.send_text(json.dumps({"text": "대상 A 웹 점검"}))
        seen = []
        for _ in range(10):
            payload = json.loads(ws.receive_text())
            seen.append(payload)
            if payload.get("event") == "TurnStarted":
                break
        ws.send_text(json.dumps({"text": "아니 대상은 B로 바꿔서 진행해"}))
        for _ in range(40):
            payload = json.loads(ws.receive_text())
            seen.append(payload)
            if (
                payload.get("event") == "LoopCompleted"
                and len(calls) >= 2
            ):
                break

    events = [e.get("event") for e in seen]
    assert "TurnRevisionAccepted" in events
    assert cancelled == ["대상 A 웹 점검"]
    assert calls == ["대상 A 웹 점검", "아니 대상은 B로 바꿔서 진행해"]
