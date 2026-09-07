from __future__ import annotations

import asyncio
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.engine import QueryConfig, run_query
from secu_agent.agent.events import TextChunk, ToolCallStarted
from secu_agent.agent.eval.scripted_llm import (
    ScriptedLLMClient,
    ScriptedToolCall,
    ScriptedTurn,
)
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.tools.base import Tool, ToolContext, ToolResult, ToolSuccess
from secu_agent.agent.tools.registry import ToolRegistry
from secu_agent.agent.turn_contract import (
    looks_like_user_response_request,
    should_emit_text_before_tool_calls,
)


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


def test_clarification_text_is_user_response_request():
    text = "어떤 단계부터 진행할까요? 정보 수집, 취약점 탐지 중 원하시는 작업을 알려주세요."

    assert looks_like_user_response_request(text)
    assert not should_emit_text_before_tool_calls(text)


def test_action_preface_is_allowed_before_tool_calls():
    text = "robots.txt부터 확인하겠습니다."

    assert not looks_like_user_response_request(text)
    assert should_emit_text_before_tool_calls(text)


def test_engine_suppresses_clarification_text_when_same_turn_has_tool_calls(tmp_path):
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(
            text=(
                "어떤 단계부터 진행할까요? 정보 수집, 취약점 탐지 중 "
                "원하시는 작업을 알려주세요."
            ),
            tool_calls=[ScriptedToolCall(name="noop", input={}, id="noop-1")],
        ),
        ScriptedTurn(text="완료했습니다."),
    ])

    events = _collect(run_query(
        client=client,
        registry=_registry(),
        context=ToolContext(evidence_dir=tmp_path, metadata={}),
        initial_messages=[UserMessage(content=[TextBlock(text="웹 점검해봐")])],
        config=QueryConfig(max_turns=2),
    ))

    texts = [ev.text for ev in events if isinstance(ev, TextChunk)]
    assert not any("원하시는 작업을 알려주세요" in text for text in texts)
    assert any("완료했습니다" in text for text in texts)
    assert any(isinstance(ev, ToolCallStarted) and ev.name == "noop" for ev in events)


def test_engine_keeps_text_only_clarification(tmp_path):
    question = "어떤 범위를 먼저 확인할까요?"
    client = ScriptedLLMClient(turns=[ScriptedTurn(text=question)])

    events = _collect(run_query(
        client=client,
        registry=_registry(),
        context=ToolContext(evidence_dir=tmp_path, metadata={}),
        initial_messages=[UserMessage(content=[TextBlock(text="점검 준비")])],
        config=QueryConfig(max_turns=1),
    ))

    assert any(isinstance(ev, TextChunk) and ev.text == question for ev in events)


def test_engine_keeps_action_preface_before_tool_calls(tmp_path):
    preface = "robots.txt부터 확인하겠습니다."
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(
            text=preface,
            tool_calls=[ScriptedToolCall(name="noop", input={}, id="noop-1")],
        ),
        ScriptedTurn(text="확인했습니다."),
    ])

    events = _collect(run_query(
        client=client,
        registry=_registry(),
        context=ToolContext(evidence_dir=tmp_path, metadata={}),
        initial_messages=[UserMessage(content=[TextBlock(text="웹 점검해봐")])],
        config=QueryConfig(max_turns=2),
    ))

    first_text = next(ev.text for ev in events if isinstance(ev, TextChunk))
    first_tool_idx = next(i for i, ev in enumerate(events) if isinstance(ev, ToolCallStarted))
    first_text_idx = next(i for i, ev in enumerate(events) if isinstance(ev, TextChunk))
    assert first_text == preface
    assert first_text_idx < first_tool_idx
