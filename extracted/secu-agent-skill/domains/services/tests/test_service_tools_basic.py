"""v3.51-H3: github / confluence / jenkins / agent_tool 기본 happy + error path."""
from __future__ import annotations

import asyncio
import json

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


# ─── confluence_tools ──────────────────────────────────────


def test_confluence_list_pages_happy(tmp_path, monkeypatch):
    from domains.services.confluence.plugin.agent_types import confluence as cf
    from domains.services.confluence.plugin.tools import confluence_tools as ct

    monkeypatch.setattr(cf, "list_pages", lambda space, **kw: [
        cf.CfPage(id="100", title="P1", space_key=space, version=1, url="/x/100"),
    ])
    tool = ct.ConfluenceListPagesTool()
    ctx = ToolContext(evidence_dir=tmp_path)
    res = asyncio.run(tool.execute(ct.ConfluenceListPagesInput(space_key="TTASK"), ctx))
    assert isinstance(res, ToolSuccess)
    assert "P1" in res.content


def test_confluence_fetch_page_wraps_untrusted(tmp_path, monkeypatch):
    from domains.services.confluence.plugin.agent_types import confluence as cf
    from domains.services.confluence.plugin.tools import confluence_tools as ct

    monkeypatch.setattr(cf, "fetch_page_body",
                        lambda pid: "<p>secret body</p>")
    tool = ct.ConfluenceFetchPageTool()
    ctx = ToolContext(evidence_dir=tmp_path)
    res = asyncio.run(tool.execute(ct.ConfluenceFetchPageInput(page_id="100"), ctx))
    assert isinstance(res, ToolSuccess)
    assert "UNTRUSTED INPUT BEGINS" in res.content
    assert "secret body" in res.content


# ─── agent_tool ────────────────────────────────────────────


def test_agent_tool_list_returns_known_agents(tmp_path):
    from secu_agent.agent.tools.agent_tool import AgentInput, AgentTool

    ctx = ToolContext(evidence_dir=tmp_path)
    tool = AgentTool()
    res = asyncio.run(tool.execute(AgentInput(action="list"), ctx))
    assert isinstance(res, ToolSuccess)
    assert "sub-agent" in res.content.lower()


def test_agent_tool_run_without_subagent_type_errors(tmp_path):
    from secu_agent.agent.tools.agent_tool import AgentInput, AgentTool

    ctx = ToolContext(evidence_dir=tmp_path)
    tool = AgentTool()
    res = asyncio.run(tool.execute(
        AgentInput(action="run", subagent_type=None), ctx,
    ))
    assert isinstance(res, ToolError)
    assert res.kind == "validation"


def test_agent_tool_run_unknown_subagent_errors(tmp_path):
    from secu_agent.agent.tools.agent_tool import AgentInput, AgentTool

    ctx = ToolContext(evidence_dir=tmp_path)
    tool = AgentTool()
    res = asyncio.run(tool.execute(
        AgentInput(action="run", subagent_type="totally-fake-agent-xyz"), ctx,
    ))
    assert isinstance(res, ToolError)
    assert res.kind == "not_found"
    assert "sub-agent" in res.message.lower()


def test_agent_tool_input_type_validation():
    """AgentInput pydantic 검증 — subagent_type 길이 초과."""
    from secu_agent.agent.tools.agent_tool import AgentInput

    with pytest.raises(Exception):
        AgentInput(action="run", subagent_type="x" * 200)
