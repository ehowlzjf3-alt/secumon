"""자율(무인) 실행 capability 게이트 — audit #1.

python_exec(임의 코드 실행) 및 destructive 도구는 schedule_origin(무인) 컨텍스트에서
기본 차단(fail-closed)되고, 운영자가 SA_AUTONOMOUS_TOOLS allowlist 로 명시 opt-in 한
도구만 허용된다. 대화형(사람 있음)에서는 기존 동작 유지.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.tools.approval import InMemoryApprovalStore
from secu_agent.agent.tools.autonomy import AUTONOMOUS_TOOLS_ENV
from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolInvocation,
    ToolSuccess,
)
from secu_agent.agent.tools.invoker import invoke_tool
from secu_agent.agent.tools.python_exec_tool import PythonExecTool
from secu_agent.agent.tools.registry import ToolRegistry

_SCHEDULE_META = {"schedule_origin": {"schedule_id": 1, "fire_id": 2}}


def _decision(metadata: dict) -> object:
    tool = PythonExecTool()
    ctx = ToolContext(evidence_dir=Path("/tmp"), metadata=metadata)
    return asyncio.run(tool.check_permission(PythonExecTool.input_model(code="print(1)"), ctx))


# ── python_exec check_permission ────────────────────────────────────────

def test_python_exec_interactive_allows():
    d = _decision({})
    assert d.behavior == "allow"


def test_python_exec_autonomous_denied_by_default(monkeypatch):
    monkeypatch.delenv(AUTONOMOUS_TOOLS_ENV, raising=False)
    d = _decision(_SCHEDULE_META)
    assert d.behavior == "deny"
    assert AUTONOMOUS_TOOLS_ENV in d.reason  # opt-in 방법 안내


def test_python_exec_autonomous_allowed_when_opted_in(monkeypatch):
    monkeypatch.setenv(AUTONOMOUS_TOOLS_ENV, "python_exec")
    d = _decision(_SCHEDULE_META)
    assert d.behavior == "allow"


def test_python_exec_autonomous_other_tool_optin_does_not_leak(monkeypatch):
    monkeypatch.setenv(AUTONOMOUS_TOOLS_ENV, "terminal, some_other")
    d = _decision(_SCHEDULE_META)
    assert d.behavior == "deny"


# ── invoker autonomous gate (destructive 도구) ──────────────────────────

class _ProbeInput(BaseModel):
    command: str = "ls"


class _DestructiveProbe(Tool[_ProbeInput]):
    name: ClassVar[str] = "destructive_probe"
    description: ClassVar[str] = "Test-only destructive probe."
    input_model: ClassVar[type[BaseModel]] = _ProbeInput
    is_destructive: ClassVar[bool] = True

    async def execute(self, validated_input: _ProbeInput, context: ToolContext):
        del context
        return ToolSuccess(content=f"ran {validated_input.command}")


def _invoke_scheduled(approval: InMemoryApprovalStore):
    registry = ToolRegistry()
    registry.register(_DestructiveProbe)
    ctx = ToolContext(
        evidence_dir=Path("/tmp"),
        approval_resolver=approval,
        metadata=dict(_SCHEDULE_META),
    )
    return asyncio.run(invoke_tool(
        ToolInvocation(id="call-1", name="destructive_probe", input={"command": "ls"}),
        registry,
        ctx,
    ))


def test_invoker_denies_destructive_autonomous_by_default(monkeypatch):
    monkeypatch.delenv(AUTONOMOUS_TOOLS_ENV, raising=False)
    approvals = InMemoryApprovalStore()
    approvals.allow_invocation("call-1", reason="operator approved")
    result = _invoke_scheduled(approvals)
    assert isinstance(result, ToolError)
    assert result.kind == "permission"
    assert "scheduled" in result.message.lower()


def test_invoker_allows_destructive_autonomous_when_opted_in(monkeypatch):
    monkeypatch.setenv(AUTONOMOUS_TOOLS_ENV, "destructive_probe")
    approvals = InMemoryApprovalStore()
    approvals.allow_invocation("call-1", reason="operator approved")
    result = _invoke_scheduled(approvals)
    # 자율 게이트 통과 → 승인(allow) → 실행 성공.
    assert isinstance(result, ToolSuccess), result
    assert "ran ls" in result.content
