from __future__ import annotations

import asyncio
from pathlib import Path
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.tools.approval import InMemoryApprovalStore
from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolInvocation,
    ToolSuccess,
)
from secu_agent.agent.tools.invoker import invoke_tool
from secu_agent.agent.tools.registry import ToolRegistry


class ProbeInput(BaseModel):
    command: str
    timeout_sec: float = 1.0


class DestructiveProbeTool(Tool[ProbeInput]):
    name: ClassVar[str] = "destructive_probe"
    description: ClassVar[str] = "Test-only destructive probe."
    input_model: ClassVar[type[BaseModel]] = ProbeInput
    is_destructive: ClassVar[bool] = True

    async def execute(self, validated_input: ProbeInput, context: ToolContext):
        del context
        return ToolSuccess(
            content=f"executed command={validated_input.command} "
            f"timeout={validated_input.timeout_sec}"
        )


def _registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(DestructiveProbeTool)
    return registry


def _ctx(tmp_path: Path, approval: InMemoryApprovalStore | None = None) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path, approval_resolver=approval)


def _invoke(tmp_path: Path, invocation_id: str, approval: InMemoryApprovalStore | None = None):
    return asyncio.run(
        invoke_tool(
            ToolInvocation(
                id=invocation_id,
                name="destructive_probe",
                input={"command": "ls", "timeout_sec": 1.0},
            ),
            _registry(),
            _ctx(tmp_path, approval),
        )
    )


def test_destructive_tool_without_approval_fails_closed(tmp_path):
    result = _invoke(tmp_path, "call-no-approval")

    assert isinstance(result, ToolError)
    assert result.kind == "permission"
    assert "approval required" in result.message


def test_schedule_origin_denies_destructive_tool_even_with_approval(tmp_path):
    approvals = InMemoryApprovalStore()
    approvals.allow_invocation("call-scheduled", reason="operator approved")
    ctx = ToolContext(
        evidence_dir=tmp_path,
        approval_resolver=approvals,
        metadata={"schedule_origin": {"schedule_id": 1, "fire_id": 2}},
    )

    result = asyncio.run(invoke_tool(
        ToolInvocation(
            id="call-scheduled",
            name="destructive_probe",
            input={"command": "ls", "timeout_sec": 1.0},
        ),
        _registry(),
        ctx,
    ))

    assert isinstance(result, ToolError)
    assert result.kind == "permission"
    assert "scheduled" in result.message.lower()


def test_destructive_tool_runs_after_explicit_invocation_approval(tmp_path):
    approvals = InMemoryApprovalStore()
    approvals.allow_invocation("call-allow", reason="operator approved")

    result = _invoke(tmp_path, "call-allow", approvals)

    assert isinstance(result, ToolSuccess)
    assert "executed command=ls" in result.content


def test_destructive_tool_denied_by_approval_store(tmp_path):
    approvals = InMemoryApprovalStore()
    approvals.deny_invocation("call-deny", reason="operator denied")

    result = _invoke(tmp_path, "call-deny", approvals)

    assert isinstance(result, ToolError)
    assert result.kind == "permission"
    assert "operator denied" in result.message


def test_approval_can_update_tool_input_before_execution(tmp_path):
    approvals = InMemoryApprovalStore()
    approvals.allow_invocation(
        "call-update",
        reason="operator narrowed command",
        updated_input={"command": "pwd", "timeout_sec": 0.5},
    )

    result = _invoke(tmp_path, "call-update", approvals)

    assert isinstance(result, ToolSuccess)
    assert "executed command=pwd" in result.content
    assert "timeout=0.5" in result.content


def test_tool_level_one_shot_approval_matches_next_invocation(tmp_path):
    approvals = InMemoryApprovalStore()
    approvals.allow_tool_once("destructive_probe", reason="next probe approved")

    first = _invoke(tmp_path, "call-first", approvals)
    second = _invoke(tmp_path, "call-second", approvals)

    assert isinstance(first, ToolSuccess)
    assert isinstance(second, ToolError)
    assert second.kind == "permission"
