"""TodoTool — operator 가 plan 짜고 순차 진행할 때 쓰는 단일 도구.

action=write|read. write 시 merge 옵션. context.metadata["session_id"] 로 영속.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


def _ctx(tmp_path: Path, session_id: int) -> ToolContext:
    return ToolContext(
        evidence_dir=tmp_path,
        metadata={"session_id": session_id},
    )


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_todo_write_returns_full_list_summary(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.todo_tool import TodoTool
    sid = state.chat_session_get_or_create(agent_type="smb")
    ctx = _ctx(tmp_path, sid)
    res = _run(TodoTool(), {
        "action": "write",
        "todos": [
            {"id": "1", "content": "198.51.100.x 추가", "status": "pending"},
            {"id": "2", "content": "10.125.x 추가", "status": "pending"},
        ],
    }, ctx)
    assert isinstance(res, ToolSuccess)
    assert "198.51.100.x" in res.content
    assert "10.125.x" in res.content
    # summary stats
    assert "pending" in res.content
    # DB 영속됐는지
    assert len(state.todo_read(sid)) == 2
    assert len(ctx.metadata["todo_items"]) == 2


def test_todo_write_marks_finding_followup_addressed(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.todo_tool import TodoTool

    sid = state.chat_session_get_or_create(agent_type="agent")
    ctx = _ctx(tmp_path, sid)
    ctx.metadata["finding_followup_pending"] = True
    ctx.metadata["finding_signal_revision"] = 3

    res = _run(TodoTool(), {
        "action": "write",
        "todos": [{"id": "1", "content": "Validate new finding"}],
    }, ctx)

    assert isinstance(res, ToolSuccess)
    assert ctx.metadata["finding_followup_pending"] is False
    assert ctx.metadata["finding_followup_addressed_revision"] == 3


def test_todo_read_without_writes(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.todo_tool import TodoTool
    sid = state.chat_session_get_or_create(agent_type="smb")
    ctx = _ctx(tmp_path, sid)
    res = _run(TodoTool(), {"action": "read"}, ctx)
    assert isinstance(res, ToolSuccess)
    assert "0" in res.content or "empty" in res.content.lower() or "없음" in res.content
    assert ctx.metadata["todo_items"] == []


def test_todo_write_merge_updates_status(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.todo_tool import TodoTool
    sid = state.chat_session_get_or_create(agent_type="smb")
    state.todo_write(sid, todos=[
        {"id": "a", "content": "first task"},
        {"id": "b", "content": "second task"},
    ])
    _run(TodoTool(), {
        "action": "write",
        "merge": True,
        "todos": [{"id": "a", "status": "in_progress"}],
    }, _ctx(tmp_path, sid))
    _run(TodoTool(), {
        "action": "write",
        "merge": True,
        "todos": [{"id": "a", "status": "completed"}],
    }, _ctx(tmp_path, sid))
    items = state.todo_read(sid)
    by = {i["id"]: i for i in items}
    assert by["a"]["status"] == "completed"
    assert by["a"]["content"] == "first task"  # not erased
    assert by["b"]["status"] == "pending"


def test_todo_tool_ignores_pending_to_completed_jump(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.todo_tool import TodoTool

    sid = state.chat_session_get_or_create(agent_type="smb")
    state.todo_write(sid, todos=[
        {"id": "3", "content": "crawl", "status": "in_progress"},
        {"id": "4", "content": "probe hidden paths", "status": "pending"},
        {"id": "5", "content": "test SQLi", "status": "pending"},
    ])

    res = _run(TodoTool(), {
        "action": "write",
        "merge": True,
        "todos": [
            {"id": "3", "status": "completed"},
            {"id": "4", "status": "completed"},
            {"id": "5", "status": "completed"},
        ],
    }, _ctx(tmp_path, sid))

    assert isinstance(res, ToolSuccess)
    assert "contract_warning" in res.content
    by = {i["id"]: i for i in state.todo_read(sid)}
    assert by["3"]["status"] == "completed"
    assert by["4"]["status"] == "pending"
    assert by["5"]["status"] == "pending"


def test_todo_tool_initial_write_cannot_seed_completed_items(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.todo_tool import TodoTool

    sid = state.chat_session_get_or_create(agent_type="smb")
    res = _run(TodoTool(), {
        "action": "write",
        "todos": [{"id": "1", "content": "scan", "status": "completed"}],
    }, _ctx(tmp_path, sid))

    assert isinstance(res, ToolSuccess)
    assert "contract_warning" in res.content
    assert state.todo_read(sid)[0]["status"] == "pending"


def test_todo_tool_can_mark_in_progress_item_blocked(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.todo_tool import TodoTool

    sid = state.chat_session_get_or_create(agent_type="smb")
    state.todo_write(sid, todos=[
        {"id": "1", "content": "crawl", "status": "in_progress"},
        {"id": "2", "content": "report", "status": "pending"},
    ])

    res = _run(TodoTool(), {
        "action": "write",
        "merge": True,
        "todos": [{"id": "1", "status": "blocked"}],
    }, _ctx(tmp_path, sid))

    assert isinstance(res, ToolSuccess)
    assert "[!] 1. crawl" in res.content
    assert "blocked=1" in res.content
    by = {i["id"]: i for i in state.todo_read(sid)}
    assert by["1"]["status"] == "blocked"
    assert by["2"]["status"] == "pending"


def test_todo_write_default_replaces(tmp_db, tmp_path):
    """merge 안 주면 replace — old item 들 사라짐."""
    from secu_agent import state
    from secu_agent.agent.tools.todo_tool import TodoTool
    sid = state.chat_session_get_or_create(agent_type="smb")
    state.todo_write(sid, todos=[{"id": "old", "content": "x"}])
    _run(TodoTool(), {
        "action": "write",
        "todos": [{"id": "new", "content": "y"}],
    }, _ctx(tmp_path, sid))
    items = state.todo_read(sid)
    assert [i["id"] for i in items] == ["new"]


def test_todo_tool_requires_session_id_in_context(tmp_db, tmp_path):
    from secu_agent.agent.tools.todo_tool import TodoTool
    res = _run(TodoTool(), {"action": "read"},
               ToolContext(evidence_dir=tmp_path, metadata={}))
    assert isinstance(res, ToolError)


def test_todo_in_operator_registry(tmp_db):
    from secu_agent.agent.tools import build_registry_for_task
    r = build_registry_for_task("operator")
    names = [t.name for t in r.all()]
    assert "todo" in names


def test_todo_write_without_todos_arg_errors(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.todo_tool import TodoTool
    sid = state.chat_session_get_or_create(agent_type="smb")
    res = _run(TodoTool(), {"action": "write"}, _ctx(tmp_path, sid))
    assert isinstance(res, ToolError)
