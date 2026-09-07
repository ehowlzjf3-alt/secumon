"""v3.42 F2: engine 의 repeat-error halt 통합 검증.

ScriptedLLM 이 같은 tool 을 같은 입력으로 두 번 호출. 도구는 매번 에러.
engine 이 두 번째 에러 후 강제 TextChunk + LoopCompleted(reason=repeat_error_halt).
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import ClassVar

import pytest
from pydantic import BaseModel

from secu_agent.agent.engine import QueryConfig, run_query
from secu_agent.agent.events import (
    LoopCompleted, TextChunk, ToolCallCompleted,
)
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import UserMessage, TextBlock
from secu_agent.agent.llm.types import (
    LLMRequest, StreamMessageStop, StreamTextDelta, StreamToolUseStart,
    StreamToolUseDelta, StreamToolUseStop, StreamUsage,
)
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult,
)
from secu_agent.agent.tools.registry import ToolRegistry


# --- always-fail tool ----------------------------------------------------

class _BoomInput(BaseModel):
    x: int = 0


class _BoomTool(Tool[_BoomInput]):
    name: ClassVar[str] = "boom"
    description: ClassVar[str] = "always fails the same way"
    input_model: ClassVar[type[BaseModel]] = _BoomInput
    is_read_only: ClassVar[bool] = True

    async def execute(self, vi: _BoomInput, ctx: ToolContext) -> ToolResult:
        return ToolError(kind="execution", message="boom always fails")


# --- scripted LLM that calls `boom` N times ------------------------------

class _CallBoomNTimes(LLMClient):
    def __init__(self, n: int):
        self._calls_left = n

    @property
    def name(self) -> str:
        return "scripted-boom"

    async def stream(self, request: LLMRequest) -> AsyncIterator:
        if self._calls_left <= 0:
            yield StreamTextDelta(text="done")
            yield StreamMessageStop(
                stop_reason="end_turn",
                usage=StreamUsage(input_tokens=1, output_tokens=1),
            )
            return
        self._calls_left -= 1
        tool_id = f"call-{self._calls_left}"
        yield StreamToolUseStart(tool_use_id=tool_id, name="boom")
        yield StreamToolUseDelta(tool_use_id=tool_id, input_json_delta='{"x": 1}')
        yield StreamToolUseStop(tool_use_id=tool_id)
        yield StreamMessageStop(
            stop_reason="tool_use",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        )


async def _collect(aiter):
    out = []
    async for ev in aiter:
        out.append(ev)
    return out


def _build(tmp_path):
    reg = ToolRegistry()
    reg.register(_BoomTool)
    ctx = ToolContext(evidence_dir=tmp_path, metadata={})
    return reg, ctx


def test_repeat_error_halts_after_two_same_errors(tmp_path):
    reg, ctx = _build(tmp_path)
    client = _CallBoomNTimes(n=5)
    events = asyncio.run(_collect(run_query(
        client=client, registry=reg, context=ctx,
        initial_messages=[UserMessage(content=[TextBlock(text="run boom")])],
        system="test",
        config=QueryConfig(max_turns=20, tool_guardrails=False),
    )))

    # 두 번째 boom 호출 직후 halt 떨어졌는지
    boom_completes = [
        e for e in events if isinstance(e, ToolCallCompleted) and e.name == "boom"
    ]
    assert len(boom_completes) == 2, (
        f"expected 2 boom calls before halt, got {len(boom_completes)}"
    )

    # halt 메시지 TextChunk
    text_chunks = [e for e in events if isinstance(e, TextChunk)]
    assert any("boom" in tc.text and "2회" in tc.text for tc in text_chunks), (
        f"halt diagnostic text not yielded, chunks={[tc.text[:80] for tc in text_chunks]}"
    )

    # LoopCompleted with halt reason
    completes = [e for e in events if isinstance(e, LoopCompleted)]
    assert len(completes) == 1
    assert completes[0].reason == "repeat_error_halt"


def test_single_error_does_not_halt(tmp_path):
    """1회 에러 + 그 다음 정상 응답 → halt 없음."""
    reg, ctx = _build(tmp_path)
    client = _CallBoomNTimes(n=1)
    events = asyncio.run(_collect(run_query(
        client=client, registry=reg, context=ctx,
        initial_messages=[UserMessage(content=[TextBlock(text="run boom once")])],
        system="test",
        config=QueryConfig(max_turns=20, tool_guardrails=False),
    )))
    completes = [e for e in events if isinstance(e, LoopCompleted)]
    assert len(completes) == 1
    assert completes[0].reason == "end_turn"
