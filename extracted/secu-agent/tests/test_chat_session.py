"""ChatSession — long-lived operator agent state.

- DB 영속 (chat_session + chat_message)
- in-memory messages: list[Message] (LLM context)
- turn(user_text) async iterator: LoopEvent 들
- LLM 은 mock — engine 통합 검증만
"""
from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import AssistantMessage, TextBlock
from secu_agent.agent.llm.types import (
    LLMRequest, StreamMessageStop, StreamTextDelta, StreamUsage,
)


class _FakeLLM(LLMClient):
    """Deterministic mock — turn 마다 정해진 text 응답."""

    def __init__(self, replies: list[str]):
        self._replies = list(replies)
        self.requests: list[LLMRequest] = []

    @property
    def name(self) -> str:
        return "fake"

    async def stream(self, request: LLMRequest) -> AsyncIterator:
        self.requests.append(request)
        reply = self._replies.pop(0) if self._replies else "ok"
        yield StreamTextDelta(text=reply)
        yield StreamMessageStop(
            stop_reason="end_turn",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        )


def _collect(aiter):
    async def _go():
        out = []
        async for x in aiter:
            out.append(x)
        return out
    return asyncio.run(_go())


def test_chat_session_load_creates_or_loads_db_session(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.chat_session import ChatSession

    sess = ChatSession.load(
        client=_FakeLLM(["hi"]),
        evidence_dir=tmp_path,
    )
    assert isinstance(sess.session_id, int)
    # DB 에 chat_session row 있음
    sid = state.chat_session_get_or_create()
    assert sess.session_id == sid


def test_chat_session_operator_runtime_can_use_generic_agent_session(
    tmp_db, tmp_path,
):
    from secu_agent import state
    from secu_agent.agent.chat_session import ChatSession

    sid = state.chat_session_new(agent_type="agent", label="general agent")
    sess = ChatSession.load(
        client=_FakeLLM(["hi"]),
        evidence_dir=tmp_path,
        task_type="operator",
        session_id=sid,
        session_agent_type="agent",
    )

    assert sess.session_id == sid
    assert sess.context.metadata["agent_type"] == "agent"
    assert state.chat_session_get(sid)["agent_type"] == "agent"


def test_chat_session_uses_130k_context_budget_by_default(tmp_db, tmp_path):
    from secu_agent.agent.chat_session import ChatSession

    sess = ChatSession.load(
        client=_FakeLLM(["hi"]),
        evidence_dir=tmp_path,
    )

    assert sess.cfg.max_tokens_per_call == 16_384
    assert sess.cfg.sliding_window_max_chars == (130_000 - 16_384) * 4
    # v3.71: compact 디폴트 180K (구 30%*sliding=136K) — 루프 내 압축과 맞물려 input bound
    assert sess.cfg.compact_char_threshold == 180_000


def test_chat_session_context_budget_env_override(tmp_db, tmp_path, monkeypatch):
    from secu_agent.agent.chat_session import ChatSession

    monkeypatch.setenv("SA_CHAT_CONTEXT_WINDOW_TOKENS", "50000")
    monkeypatch.setenv("SA_CHAT_MAX_OUTPUT_TOKENS", "4096")
    monkeypatch.setenv("SA_CHAT_COMPACT_THRESHOLD_CHARS", "12345")

    sess = ChatSession.load(
        client=_FakeLLM(["hi"]),
        evidence_dir=tmp_path,
    )

    assert sess.cfg.max_tokens_per_call == 4096
    assert sess.cfg.sliding_window_max_chars == (50_000 - 4_096) * 4
    assert sess.cfg.compact_char_threshold == 12345


def test_chat_session_turn_persists_user_and_assistant_messages(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.chat_session import ChatSession

    sess = ChatSession.load(
        client=_FakeLLM(["안녕! 3개 pending share 있어."]),
        evidence_dir=tmp_path,
    )
    events = _collect(sess.turn("pending share 보여줘"))

    # 최소한 user_text + LoopCompleted 비슷한 흐름
    assert events, "no events produced"

    msgs = state.chat_messages_for(sess.session_id)
    roles = [m["role"] for m in msgs]
    assert "user" in roles
    assert "assistant" in roles
    user_msg = next(m for m in msgs if m["role"] == "user")
    assert user_msg["content"]["text"] == "pending share 보여줘"
    asst_msg = next(m for m in msgs if m["role"] == "assistant")
    assert "pending share" in asst_msg["content"]["text"] or "3개" in asst_msg["content"]["text"]


# de-domain: 도메인 skill 자동주입 테스트는 secu-agent-skill/tests 로 이동


def test_chat_session_marks_scheduled_prompt_origin(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.chat_session import ChatSession
    from secu_agent.agent.llm.messages import TextBlock

    client = _FakeLLM(["scheduled ok"])
    sess = ChatSession.load(
        client=client,
        evidence_dir=tmp_path,
        task_type="operator",
    )
    sess.context.metadata["input_origin"] = {
        "type": "schedule",
        "schedule_id": 7,
        "fire_id": 9,
    }

    _collect(sess.turn("scheduled web check"))

    rows = state.chat_messages_for(sess.session_id)
    schedule_rows = [
        row for row in rows
        if row["role"] == "system"
        and row["content"].get("origin") == "schedule"
    ]
    assert schedule_rows
    assert schedule_rows[0]["content"]["schedule_id"] == 7
    assert not any(
        row["role"] == "user" and row["content"].get("text") == "scheduled web check"
        for row in rows
    )
    request_text = "\n".join(
        block.text
        for msg in client.requests[0].messages
        for block in getattr(msg, "content", [])
        if isinstance(block, TextBlock)
    )
    assert "[SCHEDULED TASK]" in request_text


def test_chat_session_reload_replays_messages(tmp_db, tmp_path):
    """페이지 새로고침처럼 — 같은 DB session 재로드하면 LLM context 가 복원됨."""
    from secu_agent.agent.chat_session import ChatSession

    s1 = ChatSession.load(
        client=_FakeLLM(["first reply"]),
        evidence_dir=tmp_path,
    )
    _collect(s1.turn("first"))

    # 새 instance 로 같은 session 로드
    s2 = ChatSession.load(
        client=_FakeLLM(["second reply"]),
        evidence_dir=tmp_path,
    )
    assert s2.session_id == s1.session_id
    # in-memory messages 가 첫 turn 의 user + assistant 포함
    assert len(s2.messages) >= 2

    # 다음 turn 도 정상
    events = _collect(s2.turn("second"))
    assert events


def test_chat_session_load_restores_active_plan_mode(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.chat_session import ChatSession

    sid = state.chat_session_get_or_create(agent_type="agent")
    plan = {
        "rationale": "웹 점검 전체 계획",
        "steps": ["crawl", "probe"],
        "estimated_minutes": 30,
    }
    state.chat_plan_mode_set(sid, plan=plan)

    sess = ChatSession.load(
        client=_FakeLLM(["ok"]),
        evidence_dir=tmp_path,
        task_type="operator",
    )

    assert sess.session_id == sid
    assert sess.context.metadata["plan_mode_active"] is True
    assert sess.context.metadata["plan_mode_plan"] == plan


def test_chat_session_load_restores_active_todo_snapshot(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.chat_session import ChatSession
    from secu_agent.agent.llm.messages import TextBlock, UserMessage

    sid = state.chat_session_get_or_create(agent_type="agent")
    state.todo_write(sid, todos=[
        {"id": "1", "content": "crawl", "status": "completed"},
        {"id": "2", "content": "static analysis", "status": "in_progress"},
        {"id": "3", "content": "report", "status": "pending"},
    ])

    sess = ChatSession.load(
        client=_FakeLLM(["ok"]),
        evidence_dir=tmp_path,
        task_type="operator",
    )

    assert sess.session_id == sid
    assert "todo_items" in sess.context.metadata
    user_texts = [
        "".join(b.text for b in m.content if isinstance(b, TextBlock))
        for m in sess.messages
        if isinstance(m, UserMessage)
    ]
    assert any("Active execution todo state" in t for t in user_texts)
    assert any("2: in_progress - static analysis" in t for t in user_texts)
    assert not any("1: completed" in t for t in user_texts)


def test_chat_session_ack_to_active_plan_injects_resume_note(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.chat_session import ChatSession
    from secu_agent.agent.llm.messages import TextBlock, UserMessage

    sid = state.chat_session_get_or_create(agent_type="web")
    state.chat_plan_mode_set(sid, plan={
        "rationale": "https://visit.samsungsemi.com 웹 점검",
        "steps": ["web_crawl", "web_vuln_probe"],
        "estimated_minutes": 30,
    })
    client = _FakeLLM(["resume note observed"])
    sess = ChatSession.load(
        client=client,
        evidence_dir=tmp_path,
        task_type="web",
    )

    _collect(sess.turn("응"))

    assert client.requests, "LLM request not captured"
    user_texts = [
        "".join(b.text for b in m.content if isinstance(b, TextBlock))
        for m in client.requests[0].messages
        if isinstance(m, UserMessage)
    ]
    assert any("이미 승인" in t for t in user_texts)
    assert any("enter_plan_mode" in t and "다시 호출" in t for t in user_texts)


def test_chat_session_persists_tool_events(tmp_db, tmp_path):
    """tool_event role 도 DB 에 — replay 시 frontend 가 도구 호출 흐름도 보여줌."""
    # 이번엔 도구 호출 없는 단순 reply 만 — tool_event 가 없어도 OK
    # 도구 호출 케이스는 engine-side 테스트와 라이브 검증으로 커버.
    from secu_agent import state
    from secu_agent.agent.chat_session import ChatSession

    sess = ChatSession.load(
        client=_FakeLLM(["plain text reply"]),
        evidence_dir=tmp_path,
    )
    _collect(sess.turn("hi"))
    msgs = state.chat_messages_for(sess.session_id)
    # 적어도 user + assistant 둘 다 들어가있음
    assert len([m for m in msgs if m["role"] == "user"]) == 1
    assert len([m for m in msgs if m["role"] == "assistant"]) == 1


def test_run_engine_pass_records_tool_events_and_usage_off_loop_in_order(
    tmp_path, monkeypatch,
):
    import secu_agent.agent.chat_session as chat_mod
    from secu_agent.agent.engine import QueryConfig
    from secu_agent.agent.events import (
        LlmCallMeasured, ToolCallCompleted, ToolCallStarted,
    )
    from secu_agent.agent.tools.base import ToolContext, ToolSuccess

    monkeypatch.delenv("SA_CHAT_PROFILE", raising=False)
    calls = []
    run_query_kwargs = []

    async def fake_run_query(**_kwargs):
        run_query_kwargs.append(_kwargs)
        yield ToolCallStarted(
            tool_use_id="tool-1", name="memory", input={"key": "value"},
        )
        yield ToolCallCompleted(
            tool_use_id="tool-1", name="memory", result=ToolSuccess("stored"),
        )
        yield LlmCallMeasured(
            turn=2, system_chars=10, tools_chars=20, history_chars=30,
            input_tokens=7, output_tokens=3,
            cache_read_input_tokens=1, cache_creation_input_tokens=2,
        )

    def fake_chat_message_add(session_id, *, role, content):
        calls.append({
            "kind": "chat_message_add",
            "thread": threading.current_thread(),
            "session_id": session_id,
            "role": role,
            "content": dict(content),
        })
        return len(calls)

    def fake_token_usage_record(**kwargs):
        calls.append({
            "kind": "token_usage_record",
            "thread": threading.current_thread(),
            "kwargs": dict(kwargs),
        })

    monkeypatch.setattr(chat_mod, "run_query", fake_run_query)
    monkeypatch.setattr(chat_mod.state, "chat_message_add", fake_chat_message_add)
    monkeypatch.setattr(chat_mod.state, "token_usage_record", fake_token_usage_record)

    sess = chat_mod.ChatSession(
        session_id=123,
        client=_FakeLLM(["unused"]),
        registry=object(),
        context=ToolContext(evidence_dir=tmp_path),
        messages=[],
        cfg=QueryConfig(),
        sys_prompt="system",
    )
    sess.context.unlocked_tools.add("smb_subnet_sweep")
    loop_thread = None

    async def _go():
        nonlocal loop_thread
        loop_thread = threading.current_thread()
        return [ev async for ev in sess._run_engine_pass()]

    events = asyncio.run(_go())

    assert loop_thread is not None
    assert all(call["thread"] is not loop_thread for call in calls)
    assert [type(ev).__name__ for ev in events] == [
        "ToolCallStarted", "ToolCallCompleted",
    ]
    assert run_query_kwargs[0]["unlocked_tools"] == {"smb_subnet_sweep"}
    assert [call["kind"] for call in calls] == [
        "chat_message_add", "chat_message_add", "token_usage_record",
    ]
    assert calls[0]["session_id"] == 123
    assert calls[0]["role"] == "tool_event"
    assert calls[0]["content"] == {
        "event": "ToolCallStarted",
        "id": "tool-1",
        "name": "memory",
        "input": {"key": "value"},
    }
    assert calls[1]["session_id"] == 123
    assert calls[1]["role"] == "tool_event"
    assert calls[1]["content"] == {
        "event": "ToolCallCompleted",
        "id": "tool-1",
        "name": "memory",
        "ok": True,
        "result": "stored",
    }
    assert calls[2]["kwargs"] == {
        "session_id": 123,
        "turn_seq": 2,
        "system_chars": 10,
        "tools_chars": 20,
        "history_chars": 30,
        "input_tokens": 7,
        "output_tokens": 3,
        "cache_read_input_tokens": 1,
        "cache_creation_input_tokens": 2,
        "profile": None,
        "model": "fake",
    }


# ============================================================
# v3.24-B: ContextSummarizer 통합
# ============================================================

def test_chat_session_operator_has_summarizer(tmp_db, tmp_path):
    """operator task_type 면 summarizer/context engine attach."""
    from secu_agent.agent.chat_session import ChatSession
    sess = ChatSession.load(
        client=_FakeLLM(["ok"]),
        evidence_dir=tmp_path,
        task_type="operator",
    )
    assert sess.summarizer is not None
    assert sess.context_engine is not None
    assert sess.summarizer.threshold_chars > 0


def test_chat_session_agent_has_summarizer(tmp_db, tmp_path):
    """v3.71: autonomous agent task_type 도 summarizer/context engine attach."""
    from secu_agent.agent.chat_session import ChatSession
    sess = ChatSession.load(
        client=_FakeLLM(["ok"]),
        evidence_dir=tmp_path,
        task_type="agent",
    )
    assert sess.summarizer is not None
    assert sess.context_engine is not None


def test_chat_session_non_operator_no_summarizer(tmp_db, tmp_path):
    """다른 task_type(진짜 비대상) 은 summarizer/context engine 없음."""
    from secu_agent.agent.chat_session import ChatSession
    sess = ChatSession.load(
        client=_FakeLLM(["ok"]),
        evidence_dir=tmp_path,
        task_type="smb_share_master",
    )
    assert sess.summarizer is None
    assert sess.context_engine is None


def test_maybe_compress_returns_none_without_summarizer(tmp_db, tmp_path):
    from secu_agent.agent.chat_session import ChatSession
    sess = ChatSession.load(
        client=_FakeLLM(["ok"]),
        evidence_dir=tmp_path,
        task_type="smb_share_master",
    )
    out = asyncio.run(sess.maybe_compress(force=True))
    assert out is None


def test_maybe_compress_returns_none_below_threshold(tmp_db, tmp_path):
    """짧은 history 면 압축 안 됨 (force=False)."""
    from secu_agent.agent.chat_session import ChatSession
    sess = ChatSession.load(
        client=_FakeLLM(["ok"]),
        evidence_dir=tmp_path,
        task_type="operator",
    )
    out = asyncio.run(sess.maybe_compress(force=False))
    assert out is None


def test_maybe_compress_force_triggers_with_summarizer(tmp_db, tmp_path):
    """force=True 면 messages 가 적어도 압축 시도 — 단 너무 적으면 no-op."""
    from secu_agent.agent.chat_session import ChatSession
    from secu_agent.agent.llm.messages import (
        AssistantMessage, TextBlock, UserMessage,
    )
    from secu_agent.agent.read_context import READ_STATE_KEY

    sess = ChatSession.load(
        client=_FakeLLM(["summary body"]),
        evidence_dir=tmp_path,
        task_type="operator",
    )
    # 메시지 충분히 박아넣고 tail_char_budget 작게 만들어 압축 발생 유도
    sess.summarizer.protect_first_n = 1
    sess.summarizer.tail_char_budget = 10
    sess.context.metadata[READ_STATE_KEY] = {"stale": {"size": 1}}
    for i in range(6):
        sess.messages.append(UserMessage(content=[TextBlock(text=f"user msg {i}")]))
        sess.messages.append(AssistantMessage(content=[TextBlock(text=f"reply {i}")]))
    out = asyncio.run(sess.maybe_compress(force=True))
    assert out is not None
    assert out["triggered"]
    assert out["middle_count"] >= 1
    assert READ_STATE_KEY not in sess.context.metadata
