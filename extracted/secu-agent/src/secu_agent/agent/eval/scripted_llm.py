"""ScriptedLLMClient — 결정적 LLMClient.

list[ScriptedTurn] 을 받아 호출마다 차례로 재생. eval harness 가 LLM 응답을
시나리오로 고정해서 도구 시퀀스 / 최종 응답을 회귀 검증한다.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import StopReason
from secu_agent.agent.llm.types import (
    LLMRequest,
    StreamEvent,
    StreamMessageStop,
    StreamReasoningDelta,
    StreamTextDelta,
    StreamToolUseDelta,
    StreamToolUseStart,
    StreamToolUseStop,
    StreamUsage,
)


@dataclass(slots=True)
class ScriptedToolCall:
    name: str
    input: dict[str, object] = field(default_factory=dict)
    id: str | None = None


@dataclass(slots=True)
class ScriptedTurn:
    text: str = ""
    reasoning: str = ""
    tool_calls: list[ScriptedToolCall] = field(default_factory=list)
    stop_reason: StopReason | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None


class ScriptedLLMClient(LLMClient):
    def __init__(self, turns: list[ScriptedTurn], *, name: str = "scripted") -> None:
        self._turns = list(turns)
        self._cursor = 0
        self._name = name
        self._tool_id_counter = 0

    @property
    def name(self) -> str:
        return self._name

    def _next_tool_id(self) -> str:
        self._tool_id_counter += 1
        return f"scripted_tu_{self._tool_id_counter:04d}"

    async def stream(self, request: LLMRequest) -> AsyncIterator[StreamEvent]:
        if self._cursor >= len(self._turns):
            raise RuntimeError(
                f"ScriptedLLMClient script exhausted: "
                f"{len(self._turns)} turns scripted, {self._cursor + 1}-th call requested"
            )
        turn = self._turns[self._cursor]
        self._cursor += 1

        if turn.reasoning:
            yield StreamReasoningDelta(text=turn.reasoning)

        if turn.text:
            yield StreamTextDelta(text=turn.text)

        for call in turn.tool_calls:
            tu_id = call.id or self._next_tool_id()
            yield StreamToolUseStart(tool_use_id=tu_id, name=call.name)
            payload = json.dumps(call.input, ensure_ascii=False)
            yield StreamToolUseDelta(tool_use_id=tu_id, input_json_delta=payload)
            yield StreamToolUseStop(tool_use_id=tu_id)

        stop = turn.stop_reason
        if stop is None:
            stop = "tool_use" if turn.tool_calls else "end_turn"

        usage: StreamUsage | None = None
        if turn.input_tokens is not None or turn.output_tokens is not None:
            usage = StreamUsage(
                input_tokens=turn.input_tokens or 0,
                output_tokens=turn.output_tokens or 0,
            )

        yield StreamMessageStop(stop_reason=stop, usage=usage)
