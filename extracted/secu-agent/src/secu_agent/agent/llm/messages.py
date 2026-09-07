"""Internal message types — vendor-neutral.

Frozen dataclasses, content 는 항상 list[block].
어댑터가 LLM wire format 으로 변환.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4


def _now() -> datetime:
    return datetime.now(UTC)


def _new_id() -> str:
    return str(uuid4())


@dataclass(frozen=True, slots=True)
class TextBlock:
    text: str
    type: Literal["text"] = "text"


@dataclass(frozen=True, slots=True)
class ToolUseBlock:
    id: str
    name: str
    input: dict[str, object]
    type: Literal["tool_use"] = "tool_use"


@dataclass(frozen=True, slots=True)
class ToolResultBlock:
    tool_use_id: str
    content: str
    is_error: bool = False
    type: Literal["tool_result"] = "tool_result"


@dataclass(frozen=True, slots=True)
class ThinkingBlock:
    thinking: str
    type: Literal["thinking"] = "thinking"


@dataclass(frozen=True, slots=True)
class ImageBlock:
    """v3.43-V1: vision input block. base64 data URL 로 OpenAI vision API 전송.

    media_type: image/png | image/jpeg | image/webp | image/gif
    data_b64: base64 encoded raw image bytes (no `data:` prefix)
    """
    media_type: str
    data_b64: str
    type: Literal["image"] = "image"


ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | ImageBlock


StopReason = Literal["end_turn", "tool_use", "max_tokens", "stop_sequence", "error"]


@dataclass(frozen=True, slots=True)
class UserMessage:
    content: list[ContentBlock]
    id: str = field(default_factory=_new_id)
    created_at: datetime = field(default_factory=_now)
    role: Literal["user"] = "user"


@dataclass(frozen=True, slots=True)
class AssistantMessage:
    content: list[ContentBlock]
    stop_reason: StopReason | None = None
    id: str = field(default_factory=_new_id)
    created_at: datetime = field(default_factory=_now)
    role: Literal["assistant"] = "assistant"


@dataclass(frozen=True, slots=True)
class SystemMessage:
    text: str
    id: str = field(default_factory=_new_id)
    created_at: datetime = field(default_factory=_now)
    role: Literal["system"] = "system"


Message = UserMessage | AssistantMessage | SystemMessage


def text_of(message: UserMessage | AssistantMessage) -> str:
    return "".join(b.text for b in message.content if isinstance(b, TextBlock))


def tool_uses(message: AssistantMessage) -> list[ToolUseBlock]:
    return [b for b in message.content if isinstance(b, ToolUseBlock)]
