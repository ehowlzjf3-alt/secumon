"""v3.35-E: GoalTool — operator action 분기 검증."""
from __future__ import annotations

import asyncio
from pathlib import Path

from secu_agent import state
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.agent.tools.goal_tool import GoalTool


def _ctx(tmp_path: Path, session_id: int | None) -> ToolContext:
    return ToolContext(
        evidence_dir=tmp_path,
        metadata={"session_id": session_id} if session_id is not None else {},
    )


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_goal_tool_requires_session_id(tmp_db, tmp_path):
    res = _run(GoalTool(), {"action": "status"}, _ctx(tmp_path, None))
    assert isinstance(res, ToolError)
    assert "session_id" in res.message


def test_goal_set_creates_active_goal(tmp_db, tmp_path):
    sid = state.chat_session_get_or_create()
    res = _run(GoalTool(), {
        "action": "set", "text": "11.106 점검 끝까지", "max_turns": 10,
    }, _ctx(tmp_path, sid))
    assert isinstance(res, ToolSuccess)
    g = state.goal_get_active(sid)
    assert g["goal_text"] == "11.106 점검 끝까지"
    assert g["max_turns"] == 10


def test_goal_set_requires_text(tmp_db, tmp_path):
    sid = state.chat_session_get_or_create()
    res = _run(GoalTool(), {"action": "set", "text": "   "},
               _ctx(tmp_path, sid))
    assert isinstance(res, ToolError)


def test_goal_status_shows_checklist(tmp_db, tmp_path):
    sid = state.chat_session_get_or_create()
    gid = state.goal_set(sid, goal_text="test g")
    state.goal_update_checklist(gid, checklist=[
        {"text": "A", "status": "completed"},
        {"text": "B", "status": "pending"},
    ], decomposed=True)
    res = _run(GoalTool(), {"action": "status"}, _ctx(tmp_path, sid))
    assert isinstance(res, ToolSuccess)
    assert "test g" in res.content
    assert "[x] A" in res.content
    assert "[ ] B" in res.content


def test_goal_tool_manages_criteria(tmp_db, tmp_path):
    sid = state.chat_session_get_or_create()
    state.goal_set(sid, goal_text="test g")

    res = _run(GoalTool(), {
        "action": "add_criteria",
        "text": "finding 기반 deep dive",
    }, _ctx(tmp_path, sid))
    assert isinstance(res, ToolSuccess)
    assert "criteria added #1" in res.content

    status = _run(GoalTool(), {"action": "status"}, _ctx(tmp_path, sid))
    assert "finding 기반 deep dive" in status.content

    removed = _run(GoalTool(), {
        "action": "remove_criteria",
        "index": 1,
    }, _ctx(tmp_path, sid))
    assert "criteria removed #1" in removed.content

    cleared = _run(GoalTool(), {"action": "clear_criteria"}, _ctx(tmp_path, sid))
    assert "criteria cleared (0)" in cleared.content


def test_goal_clear_and_pause_resume(tmp_db, tmp_path):
    sid = state.chat_session_get_or_create()
    state.goal_set(sid, goal_text="g")
    # pause → resume
    r = _run(GoalTool(), {"action": "pause"}, _ctx(tmp_path, sid))
    assert isinstance(r, ToolSuccess)
    assert "paused" in r.content
    g = state.goal_get_active(sid)
    assert g["status"] == "paused"
    r = _run(GoalTool(), {"action": "resume"}, _ctx(tmp_path, sid))
    assert "resumed" in r.content
    # clear
    r = _run(GoalTool(), {"action": "clear"}, _ctx(tmp_path, sid))
    assert "cleared" in r.content
    assert state.goal_get_active(sid) is None


def test_goal_status_no_active_goal(tmp_db, tmp_path):
    sid = state.chat_session_get_or_create()
    res = _run(GoalTool(), {"action": "status"}, _ctx(tmp_path, sid))
    assert isinstance(res, ToolSuccess)
    assert "active goal 없음" in res.content


def test_goal_tool_in_operator_registry(tmp_db):
    from secu_agent.agent.tools import build_registry_for_task
    r = build_registry_for_task("operator")
    names = [t.name for t in r.all()]
    assert "goal" in names
