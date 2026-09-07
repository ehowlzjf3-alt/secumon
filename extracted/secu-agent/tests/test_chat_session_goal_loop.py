"""v3.35-D: ChatSession + Ralph loop 통합."""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from secu_agent import state
from secu_agent.agent.events import (
    GoalChecklistUpdated, GoalContinuation, GoalDecomposed, GoalDone, GoalPaused,
)
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.types import (
    LLMRequest, StreamMessageStop, StreamTextDelta, StreamUsage,
)


class _ScriptedFakeLLM(LLMClient):
    """response 리스트 차례로 yield. assistant 응답 + judge 응답 둘 다 같은 stream."""

    def __init__(self, replies: list[str]):
        self._replies = list(replies)
        self._idx = 0

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
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        )


def _collect(aiter):
    async def _go():
        out = []
        async for x in aiter:
            out.append(x)
        return out
    return asyncio.run(_go())


def test_turn_without_goal_runs_single_pass(tmp_db, tmp_path):
    """goal 안 박혀있으면 한 번 engine pass 후 종료."""
    from secu_agent.agent.chat_session import ChatSession
    sess = ChatSession.load(
        client=_ScriptedFakeLLM(["assistant 한마디"]),
        evidence_dir=tmp_path,
    )
    events = _collect(sess.turn("hi"))
    # goal lifecycle 이벤트 없어야 함
    types = {type(e).__name__ for e in events}
    assert "GoalDecomposed" not in types
    assert "GoalDone" not in types


def _make_sess(client, evidence_dir):
    """Scripted ChatSession helper."""
    from secu_agent.agent.chat_session import ChatSession
    return ChatSession.load(client=client, evidence_dir=evidence_dir)


def test_turn_with_goal_runs_decompose_and_evaluate(tmp_db, tmp_path, monkeypatch):
    """active goal 있으면 decompose + evaluate 이벤트 발생."""
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "1")
    sess = _make_sess(
        _ScriptedFakeLLM([
            "assistant 응답 1",                                           # main turn
            json.dumps({"checklist": [                                  # decompose
                {"text": "A 항목"}, {"text": "B 항목"},
            ]}),
            json.dumps({                                                # evaluate (1st iter)
                "updates": [{"index": 1, "status": "completed",
                             "evidence": "ev"}],
                "new_items": [], "reason": "A done",
            }),
            # 다음 iteration 의 engine pass
            "두번째 응답",
            json.dumps({                                                # evaluate (2nd iter)
                "updates": [{"index": 2, "status": "completed",
                             "evidence": "all done"}],
                "new_items": [], "reason": "all done",
            }),
        ]),
        tmp_path,
    )
    state.goal_set(sess.session_id, goal_text="goal X", max_turns=5)
    events = _collect(sess.turn("진행해줘"))
    types = [type(e).__name__ for e in events]
    assert "GoalDecomposed" in types
    assert "GoalChecklistUpdated" in types
    assert "GoalContinuation" in types  # 첫 iteration 후 미완료라 continuation
    assert "GoalDone" in types          # 두번째 iteration 후 완료


def test_turn_goal_decompose_failure_uses_fallback_but_never_auto_done(tmp_db, tmp_path):
    """fallback checklist 는 전부 completed 로 평가돼도 자동 done 처리하지 않는다."""
    sess = _make_sess(
        _ScriptedFakeLLM([
            "assistant 응답",
            "이건 JSON 아님",  # decompose 실패
            json.dumps({
                "updates": [
                    {"index": i, "status": "completed", "evidence": "fallback ok"}
                    for i in range(1, 6)
                ],
                "new_items": [],
                "reason": "fallback checklist completed",
            }),
        ]),
        tmp_path,
    )
    state.goal_set(sess.session_id, goal_text="goal X", max_turns=5)
    events = _collect(sess.turn("진행"))
    assert any(isinstance(e, GoalDecomposed) for e in events)
    assert not any(isinstance(e, GoalDone) for e in events)
    paused = [e for e in events if isinstance(e, GoalPaused)]
    assert paused
    assert "fallback checklist" in paused[0].reason
    g = state.goal_get_active(sess.session_id)
    assert g is not None
    assert g["status"] == "paused"
    assert g["last_verdict"] == "needs_review"


def test_turn_goal_budget_exhausted(tmp_db, tmp_path):
    """max_turns 도달 시 paused."""
    sess = _make_sess(
        _ScriptedFakeLLM([
            "응답 1",
            json.dumps({"checklist": [
                {"text": "A"}, {"text": "B"}, {"text": "C"},
            ]}),
            json.dumps({"updates": [], "new_items": [], "reason": "still working"}),
            # max_turns=1 이므로 여기서 paused. continuation 없음.
        ]),
        tmp_path,
    )
    state.goal_set(sess.session_id, goal_text="g", max_turns=1)
    events = _collect(sess.turn("go"))
    paused = [e for e in events if isinstance(e, GoalPaused)]
    assert paused
    assert "max_turns" in paused[0].reason
