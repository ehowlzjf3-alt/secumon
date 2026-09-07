"""v3.81 T4: agent_type 레지스트리 — 도메인 agent_type 등록형 전환 (확정 결정 ③)."""
from __future__ import annotations

import pytest

from secu_agent.agent_type_registry import (
    CORE_AGENT_TYPES, register_agent_type, unregister_agent_type, valid_agent_types,
)


def test_core_agent_types_only_by_default():
    assert valid_agent_types() == CORE_AGENT_TYPES == frozenset({"agent"})


def test_register_unregister_roundtrip():
    try:
        register_agent_type("smb")
        assert "smb" in valid_agent_types()
        with pytest.raises(ValueError, match="이미 등록"):
            register_agent_type("smb")
    finally:
        assert unregister_agent_type("smb") is True
    assert "smb" not in valid_agent_types()
    assert unregister_agent_type("agent") is False  # 코어 제거 불가
    with pytest.raises(ValueError, match="이미 등록"):
        register_agent_type("agent")


def test_schedule_tool_rejects_unregistered_agent_type(tmp_db, tmp_path):
    """도메인 agent_type 는 plugin 미부착 상태에서 보이게 거부 (silent 생성 금지)."""
    import asyncio

    from secu_agent.agent.tools.base import ToolContext, ToolError
    from secu_agent.agent.tools.schedule_tool import ScheduleTool

    tool = ScheduleTool()
    ctx = ToolContext(evidence_dir=tmp_path)
    res = asyncio.run(tool.execute(tool.input_model(
        action="create", agent_type="smb", prompt="정기 점검 작업 수행",
        cron_expr="0 9 * * *",
    ), ctx))
    assert isinstance(res, ToolError)
    assert "미등록 agent_type" in res.message


def test_schedule_tool_accepts_registered_agent_type(tmp_db, tmp_path):
    import asyncio

    from secu_agent.agent.tools.base import ToolContext, ToolSuccess
    from secu_agent.agent.tools.schedule_tool import ScheduleTool

    tool = ScheduleTool()
    ctx = ToolContext(evidence_dir=tmp_path)
    try:
        register_agent_type("testdom")
        res = asyncio.run(tool.execute(tool.input_model(
            action="create", agent_type="testdom", prompt="정기 점검 작업 수행",
            cron_expr="0 9 * * *",
        ), ctx))
        assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    finally:
        unregister_agent_type("testdom")
