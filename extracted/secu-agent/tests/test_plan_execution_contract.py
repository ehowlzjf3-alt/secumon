from __future__ import annotations

import asyncio
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.engine import QueryConfig, run_query
from secu_agent.agent.events import ToolCallCompleted
from secu_agent.agent.eval.scripted_llm import (
    ScriptedLLMClient,
    ScriptedToolCall,
    ScriptedTurn,
)
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.tools.base import Tool, ToolContext, ToolResult, ToolSuccess
from secu_agent.agent.tools.registry import ToolRegistry


class _NoopInput(BaseModel):
    pass


class _NoopTool(Tool[_NoopInput]):
    name: ClassVar[str] = "noop"
    description: ClassVar[str] = "test noop tool"
    input_model: ClassVar[type[BaseModel]] = _NoopInput
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: _NoopInput, context: ToolContext) -> ToolResult:
        del validated_input, context
        return ToolSuccess(content="noop ok")


def _collect(aiter):
    async def _go():
        out = []
        async for ev in aiter:
            out.append(ev)
        return out
    return asyncio.run(_go())


def _registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(_NoopTool)
    return registry


def test_approved_plan_text_only_turn_injects_contract_reminder(tmp_path):
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(text="곧 1단계부터 진행하겠습니다."),
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="noop", input={}, id="noop-1")]),
    ])
    context = ToolContext(evidence_dir=tmp_path, metadata={
        "plan_mode_active": True,
        "plan_mode_status": "approved",
        "plan_mode_plan": {
            "rationale": "웹 점검",
            "steps": ["crawl", "probe"],
        },
    })

    events = _collect(run_query(
        client=client,
        registry=_registry(),
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="응")])],
        config=QueryConfig(max_turns=2),
    ))

    assert any(isinstance(ev, ToolCallCompleted) and ev.name == "noop" for ev in events)
    assert context.metadata["plan_contract_reminder_count"] == 1


def test_executing_plan_text_only_turn_requires_exit_or_more_tools(tmp_path):
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(text="결과 정리했습니다."),
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="noop", input={}, id="noop-1")]),
    ])
    context = ToolContext(evidence_dir=tmp_path, metadata={
        "plan_mode_active": True,
        "plan_mode_status": "executing",
        "plan_mode_plan": {
            "rationale": "웹 점검",
            "steps": ["crawl", "probe"],
        },
    })

    _collect(run_query(
        client=client,
        registry=_registry(),
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="계속")])],
        config=QueryConfig(max_turns=2),
    ))

    assert context.metadata["plan_contract_reminder_count"] == 1
