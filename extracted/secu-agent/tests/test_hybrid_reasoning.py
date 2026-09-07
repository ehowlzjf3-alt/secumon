"""v3.72: 하이브리드 reasoning (medium 기본 + xhigh 승급) 검증.

- engine._resolve_reasoning_effort: deep_passes_remaining 카운터 소진 + 승급
- DeepModeTool: 카운터 세팅 + cap + max(prev)
- finding_followup 안전망: HIGH/critical 신호 → 카운터 자동 1+
- chat_session base effort: 자율(agent)=medium / interactive=None / env override 최우선
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

from secu_agent.agent.engine import (
    _DEEP_REASONING_EFFORT,
    _resolve_reasoning_effort,
)
from secu_agent.agent.finding_followup import FindingSignal, append_finding_signal
from secu_agent.agent.tools.base import ToolContext
from secu_agent.agent.tools.deep_mode import DeepModeInput, DeepModeTool

from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.types import (
    LLMRequest, StreamMessageStop, StreamTextDelta, StreamUsage,
)


# ---- engine._resolve_reasoning_effort ----

def test_resolve_effort_no_deep_returns_base():
    md: dict = {}
    assert _resolve_reasoning_effort("medium", md) == "medium"
    assert _resolve_reasoning_effort(None, md) is None
    # 카운터 미세팅 → 소진할 것 없음
    assert "deep_passes_remaining" not in md or md["deep_passes_remaining"] == 0


def test_resolve_effort_escalates_and_decrements():
    md = {"deep_passes_remaining": 2}
    # base 가 medium 이어도 승급
    assert _resolve_reasoning_effort("medium", md) == _DEEP_REASONING_EFFORT
    assert md["deep_passes_remaining"] == 1
    assert _resolve_reasoning_effort("medium", md) == _DEEP_REASONING_EFFORT
    assert md["deep_passes_remaining"] == 0
    # 소진되면 base 복귀
    assert _resolve_reasoning_effort("medium", md) == "medium"


def test_resolve_effort_handles_bad_counter():
    assert _resolve_reasoning_effort("medium", {"deep_passes_remaining": "x"}) == "medium"
    assert _resolve_reasoning_effort("medium", {"deep_passes_remaining": None}) == "medium"
    assert _resolve_reasoning_effort("medium", {"deep_passes_remaining": -3}) == "medium"


# ---- DeepModeTool ----

def _run(coro):
    return asyncio.run(coro)


def test_deep_mode_sets_counter(tmp_path):
    ctx = ToolContext(evidence_dir=tmp_path)
    tool = DeepModeTool()
    res = _run(tool.execute(DeepModeInput(reason="swagger+token 패턴", passes=4), ctx))
    assert res.type == "success"
    assert ctx.metadata["deep_passes_remaining"] == 4


def test_deep_mode_caps_at_8(tmp_path):
    ctx = ToolContext(evidence_dir=tmp_path)
    _run(DeepModeTool().execute(DeepModeInput(reason="r", passes=8), ctx))
    assert ctx.metadata["deep_passes_remaining"] == 8


def test_deep_mode_takes_max_of_existing(tmp_path):
    ctx = ToolContext(evidence_dir=tmp_path)
    ctx.metadata["deep_passes_remaining"] = 5
    _run(DeepModeTool().execute(DeepModeInput(reason="r", passes=2), ctx))
    # 기존 5 가 요청 2 보다 크므로 유지
    assert ctx.metadata["deep_passes_remaining"] == 5


def test_deep_mode_default_passes(tmp_path):
    ctx = ToolContext(evidence_dir=tmp_path)
    _run(DeepModeTool().execute(DeepModeInput(reason="r"), ctx))
    assert ctx.metadata["deep_passes_remaining"] == 3


# ---- finding_followup 안전망 ----

def _signal(severity: str) -> FindingSignal:
    return FindingSignal(
        source_tool="web_site_sweep", task_type="web",
        asset="https://x.samsungds.net", summary="exposed", severity=severity,
    )


def test_high_signal_auto_escalates():
    md: dict = {}
    append_finding_signal(md, _signal("high"))
    assert md["deep_passes_remaining"] >= 1


def test_critical_signal_auto_escalates():
    md: dict = {}
    append_finding_signal(md, _signal("critical"))
    assert md["deep_passes_remaining"] >= 1


def test_medium_signal_no_escalation():
    md: dict = {}
    append_finding_signal(md, _signal("medium"))
    assert int(md.get("deep_passes_remaining", 0) or 0) == 0


def test_high_signal_does_not_shrink_existing_window():
    md = {"deep_passes_remaining": 4}
    append_finding_signal(md, _signal("high"))
    assert md["deep_passes_remaining"] == 4  # max(4,1)


# ---- chat_session base effort ----

class _FakeLLM(LLMClient):
    @property
    def name(self) -> str:
        return "fake"

    async def stream(self, request: LLMRequest) -> AsyncIterator:
        yield StreamTextDelta(text="ok")
        yield StreamMessageStop(
            stop_reason="end_turn",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        )


def test_autonomous_agent_base_effort_is_medium(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.chat_session import ChatSession

    sid = state.chat_session_new(agent_type="agent")
    sess = ChatSession.load(
        client=_FakeLLM(), evidence_dir=tmp_path,
        task_type="operator", session_id=sid, session_agent_type="agent",
    )
    assert sess.cfg.reasoning_effort == "medium"


def test_interactive_operator_base_effort_is_medium(tmp_db, tmp_path):
    from secu_agent.agent.chat_session import ChatSession

    # v3.76.3: interactive operator 도 base **medium** (예전엔 None→profile xhigh 라 느렸음).
    # deep_mode 도구 / HIGH·critical finding 시 engine 이 그 pass 만 xhigh 로 승급.
    sess = ChatSession.load(client=_FakeLLM(), evidence_dir=tmp_path)
    assert sess.cfg.reasoning_effort == "medium"


def test_env_override_wins(tmp_db, tmp_path, monkeypatch):
    from secu_agent import state
    from secu_agent.agent.chat_session import ChatSession

    monkeypatch.setenv("SA_CHAT_REASONING_EFFORT", "low")
    sid = state.chat_session_new(agent_type="agent")
    sess = ChatSession.load(
        client=_FakeLLM(), evidence_dir=tmp_path,
        task_type="operator", session_id=sid, session_agent_type="agent",
    )
    # 자율이라도 env override 가 최우선
    assert sess.cfg.reasoning_effort == "low"
