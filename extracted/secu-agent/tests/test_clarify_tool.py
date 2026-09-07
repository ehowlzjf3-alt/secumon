"""v3.21: ClarifyTool — agent 가 사용자에게 명시 질문 던짐.

is_destructive=False. ToolSuccess 안에 구조화된 question 포함 — frontend 가
입력 UI 띄울 수 있게. context.metadata["pending_clarification"] 도 박음.
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


def test_clarify_returns_question_marker(tmp_path):
    from secu_agent.agent.tools.clarify_tool import ClarifyTool

    res = _run(ClarifyTool(), {
        "question": "어느 subnet 부터 돌릴까요?",
        "options": ["10.99.0.0/24", "192.0.2.0/16"],
        "rationale": "사용자가 'subnet' 만 말해서 모호",
    }, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess)
    assert "어느 subnet 부터" in res.content
    assert "10.99.0.0/24" in res.content


def test_clarify_marks_pending_in_context(tmp_path):
    from secu_agent.agent.tools.clarify_tool import ClarifyTool

    ctx = _ctx(tmp_path)
    _run(ClarifyTool(), {
        "question": "q?",
        "options": [],
        "rationale": "x",
    }, ctx)
    pending = ctx.metadata.get("pending_clarification")
    assert pending is not None
    assert pending["question"] == "q?"


def test_clarify_options_optional(tmp_path):
    from secu_agent.agent.tools.clarify_tool import ClarifyTool

    res = _run(ClarifyTool(), {
        "question": "free text?",
        "options": [],
        "rationale": "open ended",
    }, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess)


def test_clarify_rejects_empty_question(tmp_path):
    from secu_agent.agent.tools.clarify_tool import ClarifyTool

    res = _run(ClarifyTool(), {
        "question": "  ",
        "options": [],
        "rationale": "x",
    }, _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "validation"


def test_clarify_metadata():
    from secu_agent.agent.tools.clarify_tool import ClarifyTool

    assert ClarifyTool.is_destructive is False
    assert ClarifyTool.is_read_only is True
    assert ClarifyTool.domain == "core"
