"""v3.14-A: PlanMode 도구 — heavy task 전 사용자 승인 자동.

EnterPlanMode: rationale + steps 보고 사용자 승인 요구 (is_destructive=True).
ExitPlanMode: 실행 완료 후 호출. plan_mode_active 클리어.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


def _ctx(tmp_path: Path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path, metadata={})


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


# ─── EnterPlanMode 메타 ────────────────────────────────────


def test_enter_plan_mode_is_destructive():
    from secu_agent.agent.tools.plan_mode_tools import EnterPlanModeTool
    assert EnterPlanModeTool.is_destructive is True


def test_enter_plan_mode_permission_asks(tmp_path):
    from secu_agent.agent.tools.plan_mode_tools import EnterPlanModeTool

    t = EnterPlanModeTool()
    payload = t.input_model(rationale="200 review", steps=["a", "b"], estimated_minutes=10)
    d = asyncio.run(t.check_permission(payload, _ctx(tmp_path)))
    assert d.behavior == "ask"


# ─── EnterPlanMode 동작 ───────────────────────────────────


def test_enter_plan_mode_marks_active_and_records(tmp_path):
    from secu_agent.agent.tools.plan_mode_tools import EnterPlanModeTool

    ctx = _ctx(tmp_path)
    res = _run(EnterPlanModeTool(), {
        "rationale": "pending share 200 review",
        "steps": ["walk", "review", "triage"],
        "estimated_minutes": 30,
    }, ctx)
    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    assert ctx.metadata.get("plan_mode_active") is True
    plan = ctx.metadata.get("plan_mode_plan")
    assert plan is not None
    assert plan["steps"] == ["walk", "review", "triage"]
    assert plan["estimated_minutes"] == 30


def test_enter_plan_mode_rejects_empty_steps(tmp_path):
    from secu_agent.agent.tools.plan_mode_tools import EnterPlanModeTool

    res = _run(EnterPlanModeTool(), {
        "rationale": "x", "steps": [], "estimated_minutes": 1,
    }, _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "validation"


def test_enter_plan_mode_rejects_if_already_active(tmp_path):
    """이미 plan_mode_active 인 상태에서 또 호출 → 기존 plan 유지 + 실행 유도."""
    from secu_agent.agent.tools.plan_mode_tools import EnterPlanModeTool

    ctx = _ctx(tmp_path)
    _run(EnterPlanModeTool(), {
        "rationale": "first", "steps": ["a"], "estimated_minutes": 1,
    }, ctx)
    res = _run(EnterPlanModeTool(), {
        "rationale": "second", "steps": ["b"], "estimated_minutes": 2,
    }, ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "validation"
    assert ctx.metadata.get("plan_mode_plan")["rationale"] == "first"
    assert "exit_plan_mode" in res.message or "실행" in res.message


def test_enter_plan_mode_persists_chat_session_state(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.plan_mode_tools import EnterPlanModeTool

    sid = state.chat_session_get_or_create()
    ctx = ToolContext(evidence_dir=tmp_path, metadata={"session_id": sid})
    res = _run(EnterPlanModeTool(), {
        "rationale": "web task approval",
        "steps": ["crawl", "probe"],
        "estimated_minutes": 30,
    }, ctx)

    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    saved = state.chat_plan_mode_get(sid)
    assert saved["active"] is True
    assert saved["plan"]["rationale"] == "web task approval"
    assert saved["plan"]["steps"] == ["crawl", "probe"]


# ─── ExitPlanMode ──────────────────────────────────────────


def test_exit_plan_mode_clears_active(tmp_path):
    from secu_agent.agent.tools.plan_mode_tools import (
        EnterPlanModeTool,
        ExitPlanModeTool,
    )

    ctx = _ctx(tmp_path)
    _run(EnterPlanModeTool(), {
        "rationale": "x", "steps": ["a"], "estimated_minutes": 1,
    }, ctx)
    assert ctx.metadata.get("plan_mode_active") is True

    res = _run(ExitPlanModeTool(), {
        "summary": "all done", "executed_steps": ["a"],
    }, ctx)
    assert isinstance(res, ToolSuccess)
    assert ctx.metadata.get("plan_mode_active") is False


def test_exit_plan_mode_clears_chat_session_state(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.plan_mode_tools import (
        EnterPlanModeTool,
        ExitPlanModeTool,
    )

    sid = state.chat_session_get_or_create()
    ctx = ToolContext(evidence_dir=tmp_path, metadata={"session_id": sid})
    _run(EnterPlanModeTool(), {
        "rationale": "x", "steps": ["a"], "estimated_minutes": 1,
    }, ctx)
    assert state.chat_plan_mode_get(sid)["active"] is True

    res = _run(ExitPlanModeTool(), {
        "summary": "done", "executed_steps": ["a"],
    }, ctx)
    assert isinstance(res, ToolSuccess)
    cleared = state.chat_plan_mode_get(sid)
    assert cleared["active"] is False
    assert cleared["last_summary"] == "done"


def test_exit_plan_mode_rejects_when_todos_are_incomplete(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.plan_mode_tools import (
        EnterPlanModeTool,
        ExitPlanModeTool,
    )

    sid = state.chat_session_get_or_create()
    ctx = ToolContext(evidence_dir=tmp_path, metadata={"session_id": sid})
    _run(EnterPlanModeTool(), {
        "rationale": "x", "steps": ["crawl", "probe"], "estimated_minutes": 1,
    }, ctx)
    state.todo_write(sid, todos=[
        {"id": "1", "content": "crawl", "status": "completed"},
        {"id": "2", "content": "probe", "status": "pending"},
    ])

    res = _run(ExitPlanModeTool(), {
        "summary": "done", "executed_steps": ["crawl", "probe"],
    }, ctx)

    assert isinstance(res, ToolError)
    assert res.kind == "validation"
    assert "todo 미완료" in res.message
    assert state.chat_plan_mode_get(sid)["active"] is True


def test_exit_plan_mode_without_enter_returns_validation(tmp_path):
    from secu_agent.agent.tools.plan_mode_tools import ExitPlanModeTool

    res = _run(ExitPlanModeTool(), {
        "summary": "x", "executed_steps": [],
    }, _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "validation"
    assert "plan_mode" in res.message.lower() or "enter" in res.message.lower()


def test_exit_plan_mode_not_destructive():
    from secu_agent.agent.tools.plan_mode_tools import ExitPlanModeTool
    # exit 은 그냥 정리 — 승인 불필요
    assert ExitPlanModeTool.is_destructive is False


# ─── 메타 — 도메인 ────────────────────────────────────────


def test_plan_mode_tools_domain_core():
    from secu_agent.agent.tools.plan_mode_tools import (
        EnterPlanModeTool,
        ExitPlanModeTool,
    )
    # 도메인 무관 — 모든 task 에서 쓸 수 있음
    assert EnterPlanModeTool.domain == "core"
    assert ExitPlanModeTool.domain == "core"
