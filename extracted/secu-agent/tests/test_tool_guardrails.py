from __future__ import annotations

import asyncio
from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.engine import QueryConfig, run_query
from secu_agent.agent.events import ToolCallCompleted
from secu_agent.agent.eval.scripted_llm import (
    ScriptedLLMClient,
    ScriptedToolCall,
    ScriptedTurn,
)
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess
from secu_agent.agent.tools.registry import ToolRegistry


def test_tool_guardrail_warns_repeated_exact_failure():
    from secu_agent.agent.tool_guardrails import (
        ToolCallGuardrailConfig,
        ToolCallGuardrailController,
    )

    guard = ToolCallGuardrailController(ToolCallGuardrailConfig(
        exact_failure_warn_after=2,
    ))

    first = guard.after_call("probe", {"url": "x"}, "[error]", failed=True)
    second = guard.after_call("probe", {"url": "x"}, "[error]", failed=True)

    assert first.action == "allow"
    assert second.action == "warn"
    assert second.code == "repeated_exact_failure_warning"


def test_tool_guardrail_warns_readonly_no_progress():
    from secu_agent.agent.tool_guardrails import (
        ToolCallGuardrailConfig,
        ToolCallGuardrailController,
    )

    guard = ToolCallGuardrailController(ToolCallGuardrailConfig(
        no_progress_warn_after=2,
    ))

    first = guard.after_call(
        "web_fetch", {"url": "https://example.com"}, "same", is_read_only=True,
    )
    second = guard.after_call(
        "web_fetch", {"url": "https://example.com"}, "same", is_read_only=True,
    )

    assert first.action == "allow"
    assert second.action == "warn"
    assert second.code == "idempotent_no_progress_warning"


def test_tool_guardrail_blocks_when_hard_stop_enabled():
    from secu_agent.agent.tool_guardrails import (
        ToolCallGuardrailConfig,
        ToolCallGuardrailController,
    )

    guard = ToolCallGuardrailController(ToolCallGuardrailConfig(
        hard_stop_enabled=True,
        exact_failure_block_after=1,
    ))
    guard.after_call("probe", {"url": "x"}, "bad", failed=True)

    decision = guard.before_call("probe", {"url": "x"})
    assert decision.action == "block"
    assert decision.code == "repeated_exact_failure_block"


class _FailInput(BaseModel):
    value: str = Field(default="x")


class _FailTool(Tool[_FailInput]):
    name: ClassVar[str] = "fail_tool"
    description: ClassVar[str] = "always fails"
    input_model: ClassVar[type[BaseModel]] = _FailInput

    async def execute(self, validated_input: _FailInput, context: ToolContext) -> ToolResult:
        del context
        return ToolError(kind="execution", message=f"failed {validated_input.value}")


def _collect(aiter):
    async def _go():
        out = []
        async for ev in aiter:
            out.append(ev)
        return out
    return asyncio.run(_go())


def test_engine_appends_tool_guardrail_warning_to_repeated_failure(tmp_path):
    registry = ToolRegistry()
    registry.register(_FailTool)
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(tool_calls=[
            ScriptedToolCall(name="fail_tool", input={"value": "x"}, id="fail-1"),
        ]),
        ScriptedTurn(tool_calls=[
            ScriptedToolCall(name="fail_tool", input={"value": "x"}, id="fail-2"),
        ]),
        ScriptedTurn(text="blocked"),
    ])

    events = _collect(run_query(
        client=client,
        registry=registry,
        context=ToolContext(evidence_dir=tmp_path),
        initial_messages=[UserMessage(content=[TextBlock(text="run failing tool twice")])],
        config=QueryConfig(
            max_turns=3,
            tool_guardrails=True,
            tool_guardrail_exact_failure_warn_after=2,
        ),
    ))

    completed = [
        ev for ev in events
        if isinstance(ev, ToolCallCompleted) and ev.name == "fail_tool"
    ]
    assert len(completed) == 2
    assert isinstance(completed[-1].result, ToolError)
    assert "Tool loop warning" in completed[-1].result.message
