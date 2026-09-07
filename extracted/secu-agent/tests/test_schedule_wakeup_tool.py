"""v3.13: ScheduleWakeupTool — N초 후 1회 wake-up.

state.schedule_create() 에 repeat=1 + next_run=now+N 로 래핑.
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


def _ctx(tmp_path: Path, agent_type: str = "agent") -> ToolContext:
    return ToolContext(evidence_dir=tmp_path, metadata={"agent_type": agent_type})


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_wakeup_creates_one_shot_schedule(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.schedule_wakeup_tool import ScheduleWakeupTool

    res = _run(ScheduleWakeupTool(), {
        "delay_sec": 120,
        "prompt": "10분 후 추가 result 확인",
        "reason": "long-running scan 결과 대기",
    }, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), getattr(res, "message", res)

    rows = state.schedule_list()
    assert len(rows) == 1
    r = rows[0]
    assert r["repeat"] == 1
    assert r["origin"] == "operator_agent"
    assert r["agent_type"] == "agent"
    assert r["next_run"] > time.time()
    assert r["next_run"] < time.time() + 200
    assert r["schedule_kind"] == "self_wakeup"
    assert r["stale_policy"] == "skip_if_superseded"
    assert r["expires_at"] is not None
    assert r["expires_at"] > r["next_run"]


def test_wakeup_stores_source_session_and_message_boundary(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.schedule_wakeup_tool import ScheduleWakeupTool

    session_id = state.chat_session_new(agent_type="agent")
    source_msg = state.chat_message_add(
        session_id, role="user", content={"text": "scan this then check later"},
    )
    ctx = ToolContext(
        evidence_dir=tmp_path,
        metadata={"agent_type": "agent", "session_id": session_id},
    )

    res = _run(ScheduleWakeupTool(), {
        "delay_sec": 120,
        "prompt": "check the scan result",
        "reason": "polling",
    }, ctx)

    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    row = state.schedule_list()[0]
    assert row["schedule_kind"] == "self_wakeup"
    assert row["stale_policy"] == "skip_if_superseded"
    assert row["source_session_id"] == session_id
    assert row["source_message_id"] == source_msg


def test_wakeup_rejects_short_delay(tmp_db, tmp_path):
    from secu_agent.agent.tools.schedule_wakeup_tool import ScheduleWakeupTool

    res = _run(ScheduleWakeupTool(), {
        "delay_sec": 5, "prompt": "x", "reason": "y",
    }, _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "validation"


def test_wakeup_rejects_long_delay(tmp_db, tmp_path):
    from secu_agent.agent.tools.schedule_wakeup_tool import ScheduleWakeupTool

    res = _run(ScheduleWakeupTool(), {
        "delay_sec": 99999, "prompt": "x", "reason": "y",
    }, _ctx(tmp_path))
    assert isinstance(res, ToolError)


def test_wakeup_metadata():
    from secu_agent.agent.tools.schedule_wakeup_tool import ScheduleWakeupTool

    assert ScheduleWakeupTool.is_destructive is False
    assert ScheduleWakeupTool.domain == "core"
    assert ScheduleWakeupTool.name == "schedule_wakeup"
