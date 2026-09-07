"""v3.12-A: Tool 메타 (domain / prompt_section / dispatch_keywords) + registry 합성.

새 도메인 추가 시 도구 한 번 등록하면 prompt 자동 반영 — drift 자동 소멸.
"""
from __future__ import annotations

from typing import ClassVar

import pytest
from pydantic import BaseModel

from secu_agent.agent.tools.base import (
    EmptyInput, Tool, ToolContext, ToolResult, ToolSuccess,
)
from secu_agent.agent.tools.registry import ToolRegistry


class _CoreFoo(Tool[EmptyInput]):
    name: ClassVar[str] = "core_foo"
    description: ClassVar[str] = "core 도구 예시."
    input_model: ClassVar[type[BaseModel]] = EmptyInput

    async def execute(self, validated_input, context):  # noqa: D401
        return ToolSuccess(content="ok")


class _SmbBar(Tool[EmptyInput]):
    name: ClassVar[str] = "smb_bar"
    description: ClassVar[str] = "SMB 도메인 도구 예시."
    input_model: ClassVar[type[BaseModel]] = EmptyInput
    domain: ClassVar[str] = "smb"
    dispatch_keywords: ClassVar[tuple[str, ...]] = ("스캔", "발견")
    prompt_section: ClassVar[str] = "use this when scanning SMB."

    async def execute(self, validated_input, context):  # noqa: D401
        return ToolSuccess(content="ok")


class _GhBaz(Tool[EmptyInput]):
    name: ClassVar[str] = "gh_baz"
    description: ClassVar[str] = "github 도메인 도구 예시."
    input_model: ClassVar[type[BaseModel]] = EmptyInput
    domain: ClassVar[str] = "github"
    dispatch_keywords: ClassVar[tuple[str, ...]] = ("repo", "커밋")
    prompt_section: ClassVar[str] = "use this when reviewing github repos."

    async def execute(self, validated_input, context):  # noqa: D401
        return ToolSuccess(content="ok")


def test_tool_metadata_defaults():
    """메타 박지 않은 도구 — domain=core, 빈 keywords/section."""
    assert _CoreFoo.domain == "core"
    assert _CoreFoo.dispatch_keywords == ()
    assert _CoreFoo.prompt_section == ""


def test_tool_metadata_set():
    assert _SmbBar.domain == "smb"
    assert _SmbBar.dispatch_keywords == ("스캔", "발견")
    assert "scanning SMB" in _SmbBar.prompt_section


def test_registry_tools_by_domain():
    r = ToolRegistry()
    r.register(_CoreFoo)
    r.register(_SmbBar)
    r.register(_GhBaz)
    smb = r.tools_by_domain("smb")
    assert [t.name for t in smb] == ["smb_bar"]
    core = r.tools_by_domain("core")
    assert [t.name for t in core] == ["core_foo"]


def test_registry_domains_listed_sorted():
    r = ToolRegistry()
    r.register(_GhBaz)
    r.register(_CoreFoo)
    r.register(_SmbBar)
    assert r.domains() == ("core", "github", "smb")


def test_registry_tools_section_text_groups_by_domain():
    r = ToolRegistry()
    r.register(_CoreFoo)
    r.register(_SmbBar)
    r.register(_GhBaz)
    text = r.tools_section_text()
    # 도메인 헤더 + 각 도구 prompt_section
    assert "## smb" in text
    assert "## github" in text
    assert "scanning SMB" in text
    assert "github repos" in text
    # core 도구는 prompt_section 비어있으면 생략
    assert "core_foo" not in text


def test_registry_tools_section_text_filters_by_domains():
    r = ToolRegistry()
    r.register(_SmbBar)
    r.register(_GhBaz)
    text = r.tools_section_text(domains=("smb",))
    assert "scanning SMB" in text
    assert "github repos" not in text


def test_registry_dispatch_cheat_sheet():
    r = ToolRegistry()
    r.register(_CoreFoo)
    r.register(_SmbBar)
    r.register(_GhBaz)
    sheet = r.dispatch_cheat_sheet_text()
    # 도구별 한 줄, 키워드 / 도구이름 포함
    assert "smb_bar" in sheet
    assert "스캔" in sheet
    assert "gh_baz" in sheet
    assert "repo" in sheet
    # keywords 없는 core_foo 는 cheat sheet 에 없음
    assert "core_foo" not in sheet


def test_registry_dispatch_cheat_sheet_filters_by_domains():
    r = ToolRegistry()
    r.register(_SmbBar)
    r.register(_GhBaz)
    sheet = r.dispatch_cheat_sheet_text(domains=("smb",))
    assert "smb_bar" in sheet
    assert "gh_baz" not in sheet


def test_existing_core_tool_has_domain_core():
    """schedule / todo / python_exec / session_search — domain="core" (도메인 무관)."""
    from secu_agent.agent.tools.schedule_tool import ScheduleTool
    from secu_agent.agent.tools.todo_tool import TodoTool
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    from secu_agent.agent.tools.session_search_tool import SessionSearchTool
    assert ScheduleTool.domain == "core"
    assert TodoTool.domain == "core"
    assert PythonExecTool.domain == "core"
    assert SessionSearchTool.domain == "core"


# ─── v3.17: deferred 도구 — 메인 섹션에서 분리 + 별도 listing ─────────


class _DeferredHeavy(Tool[EmptyInput]):
    name: ClassVar[str] = "heavy_thing"
    description: ClassVar[str] = "무거운 도구 — 스키마 deferred."
    input_model: ClassVar[type[BaseModel]] = EmptyInput
    domain: ClassVar[str] = "sandbox"
    deferred: ClassVar[bool] = True
    dispatch_keywords: ClassVar[tuple[str, ...]] = ("샌드박스",)
    prompt_section: ClassVar[str] = "use this when you want to do heavy stuff."

    async def execute(self, validated_input, context):  # noqa: D401
        return ToolSuccess(content="ok")


def test_tools_section_text_excludes_deferred():
    """deferred 도구는 메인 도구 섹션에 안 나옴 — schema 토큰 절약."""
    r = ToolRegistry()
    r.register(_SmbBar)
    r.register(_DeferredHeavy)
    text = r.tools_section_text()
    assert "scanning SMB" in text
    assert "heavy stuff" not in text  # deferred → 제외


def test_dispatch_cheat_sheet_excludes_deferred():
    """deferred 도구는 dispatch cheat sheet 에도 안 나옴 — 직접 호출 방지."""
    r = ToolRegistry()
    r.register(_SmbBar)
    r.register(_DeferredHeavy)
    sheet = r.dispatch_cheat_sheet_text()
    assert "smb_bar" in sheet
    assert "heavy_thing" not in sheet


def test_deferred_tools_listing_text():
    """deferred 도구는 별도 listing — 이름 + 한 줄 description + dispatch keywords."""
    r = ToolRegistry()
    r.register(_SmbBar)
    r.register(_DeferredHeavy)
    listing = r.deferred_tools_listing_text()
    assert "heavy_thing" in listing
    assert "무거운 도구" in listing  # description 첫 줄
    assert "샌드박스" in listing  # dispatch keywords
    # 비 deferred 도구는 listing 에 안 나옴
    assert "smb_bar" not in listing


def test_deferred_tools_listing_empty_when_none():
    r = ToolRegistry()
    r.register(_SmbBar)
    assert r.deferred_tools_listing_text() == ""


def test_existing_tools_marked_deferred():
    """v3.17 에서 deferred 로 마킹하는 도구들."""
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool
    from secu_agent.agent.tools.evidence_tools import BashEvidenceTool
    assert PythonExecTool.deferred is True
    assert RunInSandboxTool.deferred is True
    assert BashEvidenceTool.deferred is True


def test_lightweight_tools_not_deferred():
    """평소에 자주 쓰는 도구는 항상 노출."""
    from secu_agent.agent.tools.evidence_tools import (
        ReadEvidenceFileTool, GrepEvidenceTool,
    )
    from secu_agent.agent.tools.clarify_tool import ClarifyTool
    assert ReadEvidenceFileTool.deferred is False
    assert GrepEvidenceTool.deferred is False
    assert ClarifyTool.deferred is False
