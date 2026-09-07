from __future__ import annotations

import asyncio
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.engine import QueryConfig, run_query
from secu_agent.agent.events import LoopError, TextChunk, ToolCallCompleted
from secu_agent.agent.eval.scripted_llm import (
    ScriptedLLMClient,
    ScriptedToolCall,
    ScriptedTurn,
)
from secu_agent.agent.execution_contract import (
    active_todo_items,
    build_execution_contract_reminder,
    format_active_todo_snapshot,
)
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.tools.base import Tool, ToolContext, ToolResult, ToolSuccess
from secu_agent.agent.tools.registry import ToolRegistry


class _NoopInput(BaseModel):
    pass


class _NoopTool(Tool[_NoopInput]):
    name: ClassVar[str] = "noop"
    description: ClassVar[str] = "test noop tool"
    input_model: ClassVar[type[BaseModel]] = _NoopInput
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: _NoopInput, context: ToolContext) -> ToolResult:
        del validated_input, context
        return ToolSuccess(content="noop ok")


def _collect(aiter):
    async def _go():
        out = []
        async for ev in aiter:
            out.append(ev)
        return out
    return asyncio.run(_go())


def _registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(_NoopTool)
    return registry


def test_active_todo_snapshot_only_includes_open_items():
    items = [
        {"id": "1", "content": "crawl", "status": "completed"},
        {"id": "2", "content": "probe", "status": "in_progress"},
        {"id": "3", "content": "report", "status": "pending"},
        {"id": "4", "content": "not applicable", "status": "blocked"},
    ]

    active = active_todo_items(items)
    snapshot = format_active_todo_snapshot(items)

    assert [item["id"] for item in active] == ["2", "3"]
    assert snapshot is not None
    assert "2: in_progress - probe" in snapshot
    assert "3: pending - report" in snapshot
    assert "1: completed" not in snapshot
    assert "4: blocked" not in snapshot
    assert "not applicable" not in snapshot


def test_execution_contract_allows_all_terminal_todos():
    reminder = build_execution_contract_reminder({
        "todo_items": [
            {"id": "1", "content": "done", "status": "completed"},
            {"id": "2", "content": "cannot continue", "status": "blocked"},
            {"id": "3", "content": "cancelled by user", "status": "cancelled"},
        ],
    })

    assert reminder is None


def test_engine_retries_text_only_when_active_todos_remain(tmp_path):
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(text="다음 단계로 진행하겠습니다."),
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="noop", input={}, id="noop-1")]),
    ])
    context = ToolContext(evidence_dir=tmp_path, metadata={
        "todo_items": [
            {"id": "1", "content": "HTML 분석", "status": "in_progress"},
            {"id": "2", "content": "보고서 작성", "status": "pending"},
        ],
    })

    events = _collect(run_query(
        client=client,
        registry=_registry(),
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="계속")])],
        config=QueryConfig(max_turns=2),
    ))

    assert context.metadata["execution_contract_reminder_count"] == 1
    assert any(isinstance(ev, ToolCallCompleted) and ev.name == "noop" for ev in events)
    assert not any(
        isinstance(ev, TextChunk) and "다음 단계로 진행하겠습니다" in ev.text
        for ev in events
    )


def test_engine_stops_with_contract_violation_after_repeated_text_only(tmp_path):
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(text="진행하겠습니다."),
        ScriptedTurn(text="계속 진행하겠습니다."),
    ])
    context = ToolContext(evidence_dir=tmp_path, metadata={
        "todo_items": [
            {"id": "1", "content": "정적 분석", "status": "pending"},
        ],
    })

    events = _collect(run_query(
        client=client,
        registry=_registry(),
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="고고")])],
        config=QueryConfig(max_turns=3, max_execution_contract_reminders=1),
    ))

    assert any(isinstance(ev, LoopError) and "execution contract violation" in ev.message
               for ev in events)
    assert not any(isinstance(ev, TextChunk) for ev in events)


def test_engine_allows_text_only_when_todos_terminal(tmp_path):
    client = ScriptedLLMClient(turns=[ScriptedTurn(text="완료했습니다.")])
    context = ToolContext(evidence_dir=tmp_path, metadata={
        "todo_items": [
            {"id": "1", "content": "정리", "status": "completed"},
            {"id": "2", "content": "추가 테스트", "status": "blocked"},
        ],
    })

    events = _collect(run_query(
        client=client,
        registry=_registry(),
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="상태 알려줘")])],
        config=QueryConfig(max_turns=1),
    ))

    assert any(isinstance(ev, TextChunk) and ev.text == "완료했습니다." for ev in events)
