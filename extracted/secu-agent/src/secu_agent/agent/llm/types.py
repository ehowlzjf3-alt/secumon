"""LLM request + streaming event types."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from secu_agent.agent.llm.messages import Message, StopReason


@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, object]


@dataclass(slots=True)
class LLMRequest:
    messages: list[Message]
    system: str | None = None
    tools: list[ToolSpec] | None = None
    max_tokens: int = 4096
    temperature: float = 0.0
    stop_sequences: list[str] | None = None
    vendor_params: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class StreamTextDelta:
    text: str
    type: Literal["text_delta"] = "text_delta"


@dataclass(frozen=True, slots=True)
class StreamReasoningDelta:
    """reasoning 모델의 사고 trace — final 응답 content 와 분리된 별도 채널.

    **표시는 된다.** engine 이 ReasoningChunk 로 바꿔 web SSE / TUI / knox / scheduler
    로 흘린다. 반면 **영속과 되먹임은 없다** — assistant 턴에 커밋되지 않고, DB 에 저장
    되지 않으며(scheduler 요약도 TextChunk 만 모은다), 다음 turn 의 messages 에도 안
    들어간다. 즉 휘발성 표시 채널이다.

    이 성격이 두 가지 판단의 근거다 — (1) reasoning 만 나온 뒤의 오류는 커밋을 오염시키지
    않으므로 폴백해도 안전하다(fallback.py), (2) 마스킹 계약은 영속·외부전달 채널을
    대상으로 하며 이 채널은 거기 해당하지 않는다.

    transport 마다 실제로 담기는 것이 다르다: chat.completions 계열은 모델이 낸
    `reasoning_content` 원본 델타를, Responses API 계열은 공급자가 만든 요약을 준다.
    """
    text: str
    type: Literal["reasoning_delta"] = "reasoning_delta"


@dataclass(frozen=True, slots=True)
class StreamToolUseStart:
    tool_use_id: str
    name: str
    type: Literal["tool_use_start"] = "tool_use_start"


@dataclass(frozen=True, slots=True)
class StreamToolUseDelta:
    tool_use_id: str
    input_json_delta: str
    type: Literal["tool_use_delta"] = "tool_use_delta"


@dataclass(frozen=True, slots=True)
class StreamToolUseStop:
    tool_use_id: str
    type: Literal["tool_use_stop"] = "tool_use_stop"


@dataclass(frozen=True, slots=True)
class StreamUsage:
    input_tokens: int
    output_tokens: int
    # P1: prefix-cache telemetry. cache_read = prompt tokens served from the
    # gateway's automatic prefix cache. cache_creation = tokens written to cache
    # this turn, ONLY for providers that report it (Anthropic-native). OpenAI-
    # compatible endpoints (internal_gateway/codex) don't report a cache-write
    # figure, so they leave it 0 — do NOT synthesize it from (input - cached),
    # which mislabels ordinary uncached input as cache creation.
    # Default 0 so providers that omit cache reporting compile unchanged.
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0


@dataclass(frozen=True, slots=True)
class StreamMessageStop:
    stop_reason: StopReason
    usage: StreamUsage | None = None
    type: Literal["message_stop"] = "message_stop"


ErrorKind = Literal[
    "transient",
    "rate_limit",
    "max_tokens",
    "prompt_too_long",
    "context_length",
    "auth",
    "invalid_request",
    "other",
]


@dataclass(frozen=True, slots=True)
class StreamError:
    kind: ErrorKind
    message: str
    retryable: bool = False
    type: Literal["error"] = "error"


StreamEvent = (
    StreamTextDelta
    | StreamReasoningDelta
    | StreamToolUseStart
    | StreamToolUseDelta
    | StreamToolUseStop
    | StreamMessageStop
    | StreamError
)
