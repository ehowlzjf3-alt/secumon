"""Scenario runner — ScriptedLLM + scenario 로 run_query 구동.

results: tools_called sequence, final_text, total_turns, events. scoring 모듈이
ScenarioExpectations 와 비교.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from pydantic import BaseModel

from secu_agent.agent.engine import QueryConfig, run_query
from secu_agent.agent.eval.scenario import Scenario, ToolStub
from secu_agent.agent.eval.scripted_llm import ScriptedLLMClient
from secu_agent.agent.events import (
    LoopCompleted,
    LoopError,
    LoopEvent,
    TextChunk,
    ToolCallCompleted,
    ToolCallStarted,
)
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    ToolSuccess,
)
from secu_agent.agent.tools.registry import ToolRegistry


class _StubInput(BaseModel):
    model_config = {"extra": "allow"}


def _build_stub_tool_cls(stub: ToolStub) -> type[Tool]:
    """ToolStub → Tool subclass 동적 생성. registry 에 등록 가능."""
    msg = stub.success_message
    err = stub.is_error
    kind = stub.error_kind
    desc = stub.description

    class _StubTool(Tool[_StubInput]):
        name = stub.name
        description = desc
        input_model = _StubInput
        domain = "scenario_stub"

        async def execute(self, payload, context) -> ToolResult:
            if err:
                return ToolError(kind=kind, message=msg)
            return ToolSuccess(content=msg)

    _StubTool.__name__ = f"StubTool_{stub.name}"
    return _StubTool


def build_stub_registry(stubs: list[ToolStub]) -> ToolRegistry:
    r = ToolRegistry()
    for stub in stubs:
        r.register(_build_stub_tool_cls(stub))
    return r


@dataclass(slots=True)
class ScenarioResult:
    scenario_name: str
    events: list[LoopEvent] = field(default_factory=list)
    tools_called: list[str] = field(default_factory=list)
    tools_completed_ok: list[str] = field(default_factory=list)
    tools_completed_error: list[str] = field(default_factory=list)
    final_text: str = ""
    total_turns: int = 0
    stop_reason: str | None = None
    loop_error: str | None = None


async def run_scenario(
    scenario: Scenario,
    *,
    registry: ToolRegistry | None = None,
    evidence_dir: Path,
    system: str | None = None,
    extra_turn_budget: int = 4,
) -> ScenarioResult:
    """시나리오 실행. ScriptedLLM 의 turns 만큼 + 여유분 (extra_turn_budget) max_turns 보정.

    extra_turn_budget — engine 이 LoopCompleted 까지 도달하기 전에 max_turns trip 으로
    조기 종료되는 걸 방지. 보통 시나리오는 마지막 turn 이 text-only 라 자동 end_turn.
    """
    if registry is None:
        registry = build_stub_registry(scenario.tool_stubs)

    client = ScriptedLLMClient(turns=scenario.script)
    context = ToolContext(evidence_dir=evidence_dir)
    initial = [UserMessage(content=[TextBlock(text=scenario.user_input)])]

    cfg = QueryConfig(
        max_turns=len(scenario.script) + extra_turn_budget,
        temperature=0.0,
    )

    result = ScenarioResult(scenario_name=scenario.name)
    text_buf: list[str] = []

    async for ev in run_query(
        client=client,
        registry=registry,
        context=context,
        initial_messages=initial,
        system=system,
        config=cfg,
    ):
        result.events.append(ev)
        if isinstance(ev, ToolCallStarted):
            result.tools_called.append(ev.name)
        elif isinstance(ev, ToolCallCompleted):
            if isinstance(ev.result, ToolSuccess):
                result.tools_completed_ok.append(ev.name)
            else:
                result.tools_completed_error.append(ev.name)
        elif isinstance(ev, TextChunk):
            text_buf.append(ev.text)
        elif isinstance(ev, LoopCompleted):
            result.total_turns = ev.total_turns
            result.stop_reason = ev.reason
        elif isinstance(ev, LoopError):
            result.loop_error = ev.message

    result.final_text = "".join(text_buf)
    return result
