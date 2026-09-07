"""Generic operator memory tool."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from secu_agent.agent.tools.approval import InMemoryApprovalStore
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolInvocation, ToolSuccess
from secu_agent.agent.tools.invoker import invoke_tool
from secu_agent.agent.tools.memory_tool import MemoryTool
from secu_agent.agent.tools.registry import ToolRegistry


@pytest.fixture(autouse=True)
def _register_domain_memory_scopes():
    """de-domain v3.84 #5: path_pattern 등 도메인 scope 는 plugin 등록형 (코어 base =
    global/operator). 도메인 등록 상황을 시뮬레이션 (register/unregister 로 격리)."""
    from secu_agent import state
    for s in ("host", "share", "path_pattern"):
        state.register_memory_scope(s)
    yield
    for s in ("host", "share", "path_pattern"):
        state.unregister_memory_scope(s)


def _ctx(tmp_path: Path, approval=None, **meta) -> ToolContext:
    md = {"charter_ref": "TH-TEST-001"}
    md.update(meta)
    return ToolContext(evidence_dir=tmp_path, approval_resolver=approval, metadata=md)


def _run(payload, ctx):
    tool = MemoryTool()
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_memory_save_search_get_delete(tmp_db, tmp_path):
    saved = _run({
        "action": "save",
        "scope": "global",
        "key": "*",
        "rule": "반도체 공정정보는 사내 중요정보로 분류한다.",
        "severity_hint": "high",
        "tags": ["semiconductor", "confidential"],
    }, _ctx(tmp_path))
    assert isinstance(saved, ToolSuccess), saved
    memory_id = int(saved.content.split("memory_id=", 1)[1].split()[0])

    searched = _run({"action": "search", "query": "반도체"}, _ctx(tmp_path))
    assert isinstance(searched, ToolSuccess), searched
    assert "반도체 공정정보" in searched.content

    got = _run({"action": "get", "memory_id": memory_id}, _ctx(tmp_path))
    assert isinstance(got, ToolSuccess), got
    assert "semiconductor" in got.content

    deleted = _run({"action": "delete", "memory_id": memory_id}, _ctx(tmp_path))
    assert isinstance(deleted, ToolSuccess), deleted
    assert "deleted" in deleted.content


def test_memory_recall_matches_context_text(tmp_db, tmp_path):
    _run({
        "action": "save",
        "scope": "path_pattern",
        "key": "process_recipe",
        "rule": "process_recipe 경로는 반도체 공정정보 가능성이 높다.",
        "severity_hint": "high",
    }, _ctx(tmp_path))

    recalled = _run({
        "action": "recall",
        "context": "share path includes fab/process_recipe/v2.xlsx",
    }, _ctx(tmp_path))

    assert isinstance(recalled, ToolSuccess), recalled
    assert "반도체 공정정보" in recalled.content


def test_memory_save_requires_approval_through_invoker(tmp_db, tmp_path):
    registry = ToolRegistry()
    registry.register(MemoryTool)
    ctx = _ctx(tmp_path)

    res = asyncio.run(invoke_tool(
        ToolInvocation(
            id="mem-save",
            name="memory",
            input={
                "action": "save",
                "scope": "global",
                "key": "*",
                "rule": "rule",
            },
        ),
        registry,
        ctx,
    ))

    assert isinstance(res, ToolError)
    assert res.kind == "permission"


def test_memory_save_runs_after_approval(tmp_db, tmp_path):
    registry = ToolRegistry()
    registry.register(MemoryTool)
    approvals = InMemoryApprovalStore()
    approvals.allow_invocation("mem-save-allow", reason="operator approved")
    ctx = _ctx(tmp_path, approvals)

    res = asyncio.run(invoke_tool(
        ToolInvocation(
            id="mem-save-allow",
            name="memory",
            input={
                "action": "save",
                "scope": "operator",
                "key": "reporting",
                "rule": "결과 보고는 증거 경로를 포함한다.",
            },
        ),
        registry,
        ctx,
    ))

    assert isinstance(res, ToolSuccess), res
    assert "memory_id=" in res.content


def test_memory_registered_for_operator():
    from secu_agent.agent.tools import build_registry_for_task

    r = build_registry_for_task("operator")
    names = {t.name for t in r.all()}
    assert "memory" in names
