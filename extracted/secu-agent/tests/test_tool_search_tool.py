"""v3.17: ToolSearchTool — deferred 도구 schema 동적 unlock.

핵심:
- registry.search() 결과를 ToolSuccess content 에 정리해 반환.
- 매치된 도구 이름을 context.unlocked_tools 에 추가 → 다음 model pass 부터 build_specs 가 schema 노출.
- select:NAME[,NAME...] 직접 선택 지원.
- is_destructive=False, is_read_only=True, deferred=False (항상 노출).
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.tools.base import (
    EmptyInput, Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)
from secu_agent.agent.tools.registry import ToolRegistry


class _SearchableInput(BaseModel):
    pattern: str = ""


class _DummyDeferredA(Tool[_SearchableInput]):
    """샌드박스 패키지 격리 실행 — 의심 파일 strace + INETSim 분석."""

    name: ClassVar[str] = "fake_run_in_sandbox"
    description: ClassVar[str] = "샌드박스 microVM 에서 의심 파일을 격리 실행한다."
    search_hint: ClassVar[str] = "sandbox isolation strace malware"
    input_model: ClassVar[type[BaseModel]] = _SearchableInput
    deferred: ClassVar[bool] = True
    domain: ClassVar[str] = "sandbox"

    async def execute(self, payload: _SearchableInput, context: ToolContext) -> ToolResult:
        del payload, context
        return ToolSuccess(content="ok")


class _DummyDeferredB(Tool[_SearchableInput]):
    """파이썬 코드 직접 실행 — evidence 분석용."""

    name: ClassVar[str] = "fake_python_exec"
    description: ClassVar[str] = "evidence 디렉토리에서 임의 python 코드 실행."
    search_hint: ClassVar[str] = "python script execute compute"
    input_model: ClassVar[type[BaseModel]] = _SearchableInput
    deferred: ClassVar[bool] = True
    domain: ClassVar[str] = "core"

    async def execute(self, payload: _SearchableInput, context: ToolContext) -> ToolResult:
        del payload, context
        return ToolSuccess(content="ok")


class _DummyAlwaysOn(Tool[EmptyInput]):
    """기본 노출 도구 — list 류."""

    name: ClassVar[str] = "fake_list_things"
    description: ClassVar[str] = "기본 list 도구."
    search_hint: ClassVar[str] = "list enumerate"
    input_model: ClassVar[type[BaseModel]] = EmptyInput
    deferred: ClassVar[bool] = False
    domain: ClassVar[str] = "core"

    async def execute(self, payload: EmptyInput, context: ToolContext) -> ToolResult:
        del payload, context
        return ToolSuccess(content="ok")


def _registry_with_dummies() -> ToolRegistry:
    r = ToolRegistry()
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool
    r.register(ToolSearchTool)
    r.register(_DummyDeferredA)
    r.register(_DummyDeferredB)
    r.register(_DummyAlwaysOn)
    return r


def _ctx(tmp_path: Path, registry: ToolRegistry) -> ToolContext:
    ctx = ToolContext(evidence_dir=tmp_path)
    ctx.registry = registry
    return ctx


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


# ─── 메타 ────────────────────────────────────────────────────────────


def test_tool_search_metadata():
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    assert ToolSearchTool.is_destructive is False
    assert ToolSearchTool.is_read_only is True
    assert ToolSearchTool.deferred is False  # 본인은 항상 노출
    assert ToolSearchTool.domain == "core"


# ─── 키워드 검색 ──────────────────────────────────────────────────────


def test_keyword_query_returns_matches_and_unlocks(tmp_path):
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    r = _registry_with_dummies()
    ctx = _ctx(tmp_path, r)
    res = _run(ToolSearchTool(), {"query": "sandbox", "max_results": 5}, ctx)
    assert isinstance(res, ToolSuccess)
    assert "fake_run_in_sandbox" in res.content
    assert "fake_run_in_sandbox" in ctx.unlocked_tools


def test_keyword_query_no_match(tmp_path):
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    r = _registry_with_dummies()
    ctx = _ctx(tmp_path, r)
    res = _run(ToolSearchTool(), {"query": "kubernetes", "max_results": 5}, ctx)
    assert isinstance(res, ToolSuccess)
    assert "no match" in res.content.lower() or "매치" in res.content
    assert ctx.unlocked_tools == set()


# ─── select:NAME 직접 선택 ──────────────────────────────────────────


def test_select_loads_named_tools(tmp_path):
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    r = _registry_with_dummies()
    ctx = _ctx(tmp_path, r)
    res = _run(ToolSearchTool(), {
        "query": "select:fake_python_exec,fake_run_in_sandbox",
        "max_results": 5,
    }, ctx)
    assert isinstance(res, ToolSuccess)
    assert "fake_python_exec" in ctx.unlocked_tools
    assert "fake_run_in_sandbox" in ctx.unlocked_tools


def test_select_unknown_name_reported_not_added(tmp_path):
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    r = _registry_with_dummies()
    ctx = _ctx(tmp_path, r)
    res = _run(ToolSearchTool(), {
        "query": "select:not_a_real_tool,fake_python_exec",
        "max_results": 5,
    }, ctx)
    assert isinstance(res, ToolSuccess)
    assert "fake_python_exec" in ctx.unlocked_tools
    assert "not_a_real_tool" not in ctx.unlocked_tools
    assert "not_a_real_tool" in res.content  # report as missing


# ─── 검증 ───────────────────────────────────────────────────────────


def test_empty_query_rejected(tmp_path):
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    r = _registry_with_dummies()
    ctx = _ctx(tmp_path, r)
    res = _run(ToolSearchTool(), {"query": "   ", "max_results": 5}, ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "validation"


def test_missing_registry_in_ctx(tmp_path):
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    ctx = ToolContext(evidence_dir=tmp_path)  # registry None
    res = _run(ToolSearchTool(), {"query": "sandbox", "max_results": 5}, ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "execution"


# ─── build_specs 통합 — 핵심 ─────────────────────────────────────────


def test_deferred_tool_appears_only_after_unlock(tmp_path):
    """search 호출 전후로 build_specs 가 다른 결과 — 회귀 잡는 핵심 케이스."""
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    r = _registry_with_dummies()
    ctx = _ctx(tmp_path, r)

    before = {s.name for s in r.build_specs(ctx.unlocked_tools)}
    assert "fake_run_in_sandbox" not in before
    assert "fake_python_exec" not in before
    assert "tool_search" in before
    assert "fake_list_things" in before

    _run(ToolSearchTool(), {"query": "sandbox", "max_results": 5}, ctx)

    after = {s.name for s in r.build_specs(ctx.unlocked_tools)}
    assert "fake_run_in_sandbox" in after


# ─── max_results 상한 ────────────────────────────────────────────────


def test_max_results_capped(tmp_path):
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    r = _registry_with_dummies()
    ctx = _ctx(tmp_path, r)
    # 너무 큰 값 → 내부에서 상한 clamp (오류 안 나야 함)
    res = _run(ToolSearchTool(), {"query": "fake", "max_results": 9999}, ctx)
    assert isinstance(res, ToolSuccess)
