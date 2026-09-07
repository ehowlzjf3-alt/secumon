"""v3.62 Q5: 토큰 계측 — token_usage 테이블 + LlmCallMeasured 이벤트.

LLM 호출 한 번당 (system/tools/history char + input/output token) 1행 기록.
engine 은 측정값을 LlmCallMeasured 이벤트로 emit (순수 유지), ChatSession 이 DB 기록.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from secu_agent import state
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.types import (
    LLMRequest, StreamMessageStop, StreamTextDelta, StreamUsage,
)


class _ScriptedFakeLLM(LLMClient):
    def __init__(self, replies: list[str], *, in_tok: int = 7, out_tok: int = 3):
        self._replies = list(replies)
        self._idx = 0
        self._in = in_tok
        self._out = out_tok

    @property
    def name(self) -> str:
        return "scripted"

    async def stream(self, request: LLMRequest) -> AsyncIterator:
        if self._idx >= len(self._replies):
            text = "(no more script)"
        else:
            text = self._replies[self._idx]
            self._idx += 1
        yield StreamTextDelta(text=text)
        yield StreamMessageStop(
            stop_reason="end_turn",
            usage=StreamUsage(input_tokens=self._in, output_tokens=self._out),
        )


def _collect(aiter):
    async def _go():
        return [x async for x in aiter]
    return asyncio.run(_go())


# ---- state layer ----

def test_record_and_summary(tmp_db):
    sid = state.chat_session_new(agent_type="operator")
    state.token_usage_record(
        session_id=sid, turn_seq=1,
        system_chars=100, tools_chars=200, history_chars=50,
        input_tokens=7, output_tokens=3, profile="codex", model="gpt-5.5",
    )
    state.token_usage_record(
        session_id=sid, turn_seq=2,
        system_chars=100, tools_chars=200, history_chars=150,
        input_tokens=11, output_tokens=4,
    )
    s = state.token_usage_summary(sid)
    assert s["calls"] == 2
    assert s["input_tokens"] == 18
    assert s["output_tokens"] == 7
    assert s["system_chars"] == 200
    assert s["tools_chars"] == 400
    assert s["history_chars"] == 200
    assert len(s["turns"]) == 2


def test_summary_empty(tmp_db):
    sid = state.chat_session_new(agent_type="operator")
    s = state.token_usage_summary(sid)
    assert s["calls"] == 0
    assert s["input_tokens"] == 0
    assert s["segment_pct"] == {"system": 0.0, "tools": 0.0, "history": 0.0}


def test_summary_segment_pct(tmp_db):
    sid = state.chat_session_new(agent_type="operator")
    # system 200 / tools 400 / history 200 = 800 total → 25/50/25
    state.token_usage_record(
        session_id=sid, turn_seq=1,
        system_chars=200, tools_chars=400, history_chars=200,
        input_tokens=1, output_tokens=1,
    )
    s = state.token_usage_summary(sid)
    assert s["segment_pct"]["system"] == 25.0
    assert s["segment_pct"]["tools"] == 50.0
    assert s["segment_pct"]["history"] == 25.0


def test_summary_isolated_per_session(tmp_db):
    a = state.chat_session_new(agent_type="operator")
    b = state.chat_session_new(agent_type="operator")
    state.token_usage_record(
        session_id=a, turn_seq=1, system_chars=10, tools_chars=10,
        history_chars=10, input_tokens=5, output_tokens=5,
    )
    assert state.token_usage_summary(a)["calls"] == 1
    assert state.token_usage_summary(b)["calls"] == 0


# ---- engine event + ChatSession recording (end-to-end) ----

def test_chat_turn_emits_and_records(tmp_db, tmp_path):
    from secu_agent.agent.chat_session import ChatSession
    from secu_agent.agent.events import LlmCallMeasured

    sess = ChatSession.load(
        client=_ScriptedFakeLLM(["assistant 한마디"], in_tok=7, out_tok=3),
        evidence_dir=tmp_path,
    )
    events = _collect(sess.turn("hello"))

    # v3.65-fix: LlmCallMeasured 는 순수 백엔드 계측 — WS/consumer 로 새어나가면
    # 프론트가 잡동사니 이벤트로 렌더하므로, turn() 출력엔 노출되지 않아야 한다.
    measured = [e for e in events if isinstance(e, LlmCallMeasured)]
    assert measured == []

    # 대신 DB(token_usage)엔 정확히 기록되어 있어야 한다.
    s = state.token_usage_summary(sess.session_id)
    assert s["calls"] == 1
    assert s["input_tokens"] == 7
    assert s["output_tokens"] == 3
    assert s["system_chars"] > 0       # operator system prompt
    assert s["history_chars"] > 0      # user message "hello" 포함
