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
from secu_agent.agent.finding_followup import (
    FindingSignal,
    append_finding_signal,
    build_finding_followup_reminder,
    build_todo_suggestions,
    mark_finding_followup_addressed,
)
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.tools.base import EmptyInput, Tool, ToolContext, ToolResult, ToolSuccess
from secu_agent.agent.tools.registry import ToolRegistry
from secu_agent.agent.tools.todo_tool import TodoTool


class _NoopTool(Tool[EmptyInput]):
    name: ClassVar[str] = "noop"
    description: ClassVar[str] = "test noop"
    input_model: ClassVar[type[BaseModel]] = EmptyInput
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: EmptyInput, context: ToolContext) -> ToolResult:
        del validated_input, context
        return ToolSuccess(content="noop ok")


class _SignalTool(Tool[EmptyInput]):
    name: ClassVar[str] = "signal_tool"
    description: ClassVar[str] = "test finding signal producer"
    input_model: ClassVar[type[BaseModel]] = EmptyInput
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: EmptyInput, context: ToolContext) -> ToolResult:
        del validated_input
        append_finding_signal(
            context.metadata,
            FindingSignal(
                source_tool=self.name,
                task_type="test",
                asset="asset-1",
                asset_kind="asset",
                severity="high",
                status="confirmed",
                summary="confirmed issue",
                evidence_ref="evidence://1",
            ),
        )
        return ToolSuccess(content="signal ok")


def _collect(aiter):
    async def _go():
        out = []
        async for ev in aiter:
            out.append(ev)
        return out

    return asyncio.run(_go())


def test_build_todo_suggestions_for_confirmed_and_inconclusive_findings():
    signals = [
        FindingSignal(
            source_tool="tool",
            task_type="web",
            asset="https://example.test/.env",
            asset_kind="url",
            severity="high",
            status="confirmed",
            summary="secret config exposed",
            finding_id=7,
        ),
        FindingSignal(
            source_tool="tool",
            task_type="web",
            asset="https://example.test/admin",
            asset_kind="url",
            severity="medium",
            status="inconclusive",
            summary="admin page needs validation",
        ),
    ]

    suggestions = build_todo_suggestions(signals)

    classes = [s.action_class for s in suggestions]
    # deep_dive 가 최우선, confirmed report_update + 새 narrative suggestion(report_update) +
    # inconclusive validate 가 모두 포함 (v3.76: narrative 채우기 추가).
    assert classes[0] == "deep_dive"
    assert classes.count("report_update") == 2  # 기존 report_update + 신규 narrative
    assert "validate" in classes
    assert suggestions[0].source_finding_id == 7
    assert any("https://example.test/admin" in s.content for s in suggestions)
    assert any("위험내용" in s.content or "risk narrative" in s.content
               for s in suggestions)


def test_build_todo_suggestions_skips_report_update_when_report_already_updated():
    suggestions = build_todo_suggestions([
        FindingSignal(
            source_tool="domain_report",
            task_type="web",
            asset="https://example.test/.env",
            asset_kind="url",
            severity="high",
            status="confirmed",
            summary="secret config exposed",
            finding_id=7,
            report_updated=True,
            has_narrative=True,  # v3.76: narrative 있으면 위험내용 suggestion 안 뜸
        ),
    ])

    assert [s.action_class for s in suggestions] == ["deep_dive"]


def test_build_todo_suggestions_adds_narrative_when_high_and_missing():
    """v3.76: confirmed + 고심각도 + narrative 없으면 4부 위험내용 채우기 suggestion 추가."""
    suggestions = build_todo_suggestions([
        FindingSignal(
            source_tool="domain_report",
            task_type="web",
            asset="https://example.test/.env",
            asset_kind="url",
            severity="high",
            status="confirmed",
            summary="secret config exposed",
            finding_id=7,
            report_updated=True,
            has_narrative=False,
        ),
    ])
    contents = [s.content for s in suggestions]
    assert any("risk narrative" in c or "위험내용" in c for c in contents)


def test_build_todo_suggestions_no_narrative_suggestion_for_low_severity():
    """저심각도(<high)면 narrative suggestion 안 뜸."""
    suggestions = build_todo_suggestions([
        FindingSignal(
            source_tool="domain_report",
            task_type="web",
            asset="https://example.test/x",
            asset_kind="url",
            severity="medium",
            status="confirmed",
            summary="medium finding",
            finding_id=8,
            report_updated=True,
            has_narrative=False,
        ),
    ])
    assert not any("위험내용" in s.content or "risk narrative" in s.content
                   for s in suggestions)


def test_finding_followup_reminder_requires_todo_and_clears_after_write():
    metadata: dict[str, object] = {}
    append_finding_signal(
        metadata,
        FindingSignal(
            source_tool="tool",
            task_type="web",
            asset="asset-1",
            severity="medium",
            status="suspected",
            summary="needs proof",
        ),
    )

    reminder = build_finding_followup_reminder(metadata, todo_available=True)

    assert reminder is not None
    assert "todo(action='write'" in reminder
    assert "validate" in reminder

    mark_finding_followup_addressed(metadata)

    assert build_finding_followup_reminder(metadata, todo_available=True) is None


def test_engine_retries_text_only_when_finding_signal_needs_todo(tmp_path):
    registry = ToolRegistry()
    registry.register(_SignalTool)
    registry.register(_NoopTool)
    registry.register(TodoTool)
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="signal_tool", input={}, id="sig-1")]),
        ScriptedTurn(text="결과 보고합니다."),
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="noop", input={}, id="noop-1")]),
    ])
    context = ToolContext(evidence_dir=tmp_path, metadata={"session_id": 1})

    events = _collect(run_query(
        client=client,
        registry=registry,
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="run")])],
        config=QueryConfig(max_turns=3),
    ))

    assert context.metadata["finding_followup_reminder_count"] == 1
    assert any(isinstance(ev, ToolCallCompleted) and ev.name == "noop" for ev in events)
    assert not any(
        isinstance(ev, TextChunk) and "결과 보고합니다" in ev.text
        for ev in events
    )


def test_engine_contract_violation_after_repeated_finding_followup_text_only(tmp_path):
    registry = ToolRegistry()
    registry.register(_SignalTool)
    registry.register(TodoTool)
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="signal_tool", input={}, id="sig-1")]),
        ScriptedTurn(text="마무리합니다."),
        ScriptedTurn(text="그래도 마무리합니다."),
    ])
    context = ToolContext(evidence_dir=tmp_path, metadata={"session_id": 1})

    events = _collect(run_query(
        client=client,
        registry=registry,
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="run")])],
        config=QueryConfig(max_turns=4, max_finding_followup_reminders=1),
    ))

    assert any(
        isinstance(ev, LoopError) and "finding follow-up contract violation" in ev.message
        for ev in events
    )
