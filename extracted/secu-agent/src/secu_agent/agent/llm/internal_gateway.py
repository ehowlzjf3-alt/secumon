"""OpenAI chat-completions compatible 어댑터 — 사내 게이트웨이 호출용.

headers auth, reasoning_effort, max_completion_tokens, temperature 미지원
게이트웨이를 위한 fallback flag 유지.
"""
from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, cast

import httpx
import openai
from openai import AsyncOpenAI

from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import (
    AssistantMessage,
    ImageBlock,
    Message,
    StopReason,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from secu_agent.agent.llm.profile import LLMProfile
from secu_agent.agent.llm.types import (
    ErrorKind,
    LLMRequest,
    StreamError,
    StreamEvent,
    StreamMessageStop,
    StreamReasoningDelta,
    StreamTextDelta,
    StreamToolUseDelta,
    StreamToolUseStart,
    StreamToolUseStop,
    StreamUsage,
    ToolSpec,
)


def _map_finish_reason(fr: str | None) -> StopReason:
    if fr == "stop":
        return "end_turn"
    if fr == "tool_calls":
        return "tool_use"
    if fr == "length":
        return "max_tokens"
    if fr == "content_filter":
        return "error"
    return "end_turn"


def _user_to_openai(m: UserMessage) -> list[dict[str, Any]]:
    msgs: list[dict[str, Any]] = []
    text_parts: list[str] = []
    image_parts: list[dict[str, Any]] = []
    for b in m.content:
        if isinstance(b, ToolResultBlock):
            msgs.append({"role": "tool", "tool_call_id": b.tool_use_id, "content": b.content})
        elif isinstance(b, TextBlock):
            text_parts.append(b.text)
        elif isinstance(b, ImageBlock):
            # v3.43-V1: OpenAI vision schema — base64 data URL inline.
            image_parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{b.media_type};base64,{b.data_b64}"},
            })
    if image_parts:
        # multimodal: text + image 가 같이 있거나 image 만 있는 경우 array 형식
        parts: list[dict[str, Any]] = []
        if text_parts:
            parts.append({"type": "text", "text": "".join(text_parts)})
        parts.extend(image_parts)
        msgs.append({"role": "user", "content": parts})
    elif text_parts:
        msgs.append({"role": "user", "content": "".join(text_parts)})
    return msgs


def _assistant_to_openai(m: AssistantMessage) -> dict[str, Any]:
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    for b in m.content:
        if isinstance(b, TextBlock):
            text_parts.append(b.text)
        elif isinstance(b, ToolUseBlock):
            tool_calls.append({
                "id": b.id,
                "type": "function",
                "function": {"name": b.name, "arguments": json.dumps(b.input)},
            })
    msg: dict[str, Any] = {"role": "assistant"}
    msg["content"] = "".join(text_parts) if text_parts else None
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return msg


def _to_openai_messages(messages: list[Message], system: str | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if system:
        out.append({"role": "system", "content": system})
    for m in messages:
        if isinstance(m, SystemMessage):
            out.append({"role": "system", "content": m.text})
        elif isinstance(m, UserMessage):
            out.extend(_user_to_openai(m))
        elif isinstance(m, AssistantMessage):
            out.append(_assistant_to_openai(m))
    return out


def _to_openai_tools(tools: list[ToolSpec] | None) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.input_schema,
            },
        }
        for t in tools
    ]


def _classify(e: Exception) -> StreamError:
    if isinstance(e, openai.AuthenticationError):
        return StreamError(kind="auth", message=str(e))
    if isinstance(e, openai.RateLimitError):
        return StreamError(kind="rate_limit", message=str(e), retryable=True)
    if isinstance(e, openai.APITimeoutError | openai.APIConnectionError):
        return StreamError(kind="transient", message=str(e), retryable=True)
    if isinstance(e, openai.BadRequestError):
        msg = str(e).lower()
        kind: ErrorKind = "invalid_request"
        if "context" in msg and "length" in msg:
            kind = "context_length"
        elif "max_tokens" in msg or "maximum" in msg:
            kind = "max_tokens"
        return StreamError(kind=kind, message=str(e))
    # 서버측 일시 장애(5xx / 529 overloaded)는 retryable 로 분류해야 fallback
    # 체인·재시도가 발동한다. auth(401)/rate_limit(429)/bad_request(400)은 위에서
    # 이미 걸러졌으므로, 남은 APIStatusError 중 status>=500 만 여기 해당한다.
    if isinstance(e, openai.APIStatusError):
        status = getattr(e, "status_code", None)
        if isinstance(status, int) and status >= 500:
            return StreamError(kind="transient", message=str(e), retryable=True)
    return StreamError(kind="other", message=str(e))


@dataclass
class _ToolCallState:
    index: int
    id: str = ""
    name: str = ""
    emitted_start: bool = False
    buffered_args: str = ""


def _process_tool_call_delta(
    tc: Any, tool_calls: dict[int, _ToolCallState],
) -> list[StreamEvent]:
    events: list[StreamEvent] = []
    idx = tc.index
    state = tool_calls.setdefault(idx, _ToolCallState(index=idx))

    if tc.id and not state.id:
        state.id = tc.id
    if tc.function and tc.function.name and not state.name:
        state.name = tc.function.name

    if state.id and state.name and not state.emitted_start:
        events.append(StreamToolUseStart(tool_use_id=state.id, name=state.name))
        state.emitted_start = True
        if state.buffered_args:
            events.append(StreamToolUseDelta(
                tool_use_id=state.id, input_json_delta=state.buffered_args,
            ))
            state.buffered_args = ""

    if tc.function and tc.function.arguments:
        if state.emitted_start:
            events.append(StreamToolUseDelta(
                tool_use_id=state.id, input_json_delta=tc.function.arguments,
            ))
        else:
            state.buffered_args += tc.function.arguments

    return events


class OpenAICompatClient(LLMClient):
    """OpenAI-compat chat completions 어댑터. 사내 게이트웨이 + 외부 둘 다 사용 가능."""

    def __init__(self, profile: LLMProfile) -> None:
        self._profile = profile
        self._http = httpx.AsyncClient(
            proxy=profile.proxy or None,
            verify=profile.verify_ssl,
            timeout=profile.timeout,
            trust_env=profile.trust_env,
            headers=dict(profile.headers),
        )
        api_key = profile.auth.api_key or "placeholder-not-used"
        self._client = AsyncOpenAI(
            base_url=profile.base_url, api_key=api_key, http_client=self._http,
        )
        self._reasoning_disabled = False
        self._use_max_completion_tokens = False
        self._temperature_unsupported = False

    @property
    def name(self) -> str:
        return self._profile.name

    @property
    def harness_tier(self) -> str | None:
        # Front-D: profile 등급을 client 로 노출 — 모든 agent-loop 경로가 여기서 파생.
        return self._profile.harness_tier

    async def aclose(self) -> None:
        await self._client.close()
        await self._http.aclose()

    async def _open_stream(self, request: LLMRequest) -> Any:
        extra_headers = {
            "Prompt-Msg-Id": str(uuid.uuid4()),
            "Completion-Msg-Id": str(uuid.uuid4()),
        }
        messages = cast(Any, _to_openai_messages(request.messages, request.system))
        tools: Any = _to_openai_tools(request.tools) or openai.NOT_GIVEN
        stop: Any = request.stop_sequences or openai.NOT_GIVEN

        kwargs: dict[str, Any] = {
            "model": self._profile.model,
            "messages": messages,
            "tools": tools,
            "stop": stop,
            "stream": True,
            "stream_options": {"include_usage": True},
            "extra_headers": extra_headers,
        }
        if not self._temperature_unsupported:
            kwargs["temperature"] = request.temperature
        if self._use_max_completion_tokens:
            kwargs["max_completion_tokens"] = request.max_tokens
        else:
            kwargs["max_tokens"] = request.max_tokens
        # extra_body 합성:
        #  - profile.extra_body (정적, e.g. qwen 의 chat_template_kwargs)
        #  - reasoning_effort (profile.reasoning_effort_supported=True 일 때만)
        extra_body: dict[str, Any] = dict(self._profile.extra_body)
        if self._profile.reasoning_effort_supported and not self._reasoning_disabled:
            req_re = (
                request.vendor_params.get("reasoning_effort")
                if request.vendor_params else None
            )
            effective_re = req_re or self._profile.reasoning_effort
            if effective_re is not None:
                extra_body["reasoning_effort"] = effective_re
        if extra_body:
            kwargs["extra_body"] = extra_body
        # v3.53-18: per-request response_format (goal judge JSON 강제 등).
        # 모델이 미지원이면 BadRequest → flag 세우고 빼고 재시도 (fail-open).
        if (request.vendor_params
                and not getattr(self, "_response_format_unsupported", False)):
            rf = request.vendor_params.get("response_format")
            if rf:
                kwargs["response_format"] = rf

        try:
            return await self._client.chat.completions.create(**kwargs)
        except openai.BadRequestError as e:
            msg = str(e).lower()
            if not self._use_max_completion_tokens and "max_completion_tokens" in msg:
                self._use_max_completion_tokens = True
                return await self._open_stream(request)
            if not self._temperature_unsupported and "temperature" in msg:
                self._temperature_unsupported = True
                return await self._open_stream(request)
            if not self._reasoning_disabled and "reasoning_effort" in msg:
                self._reasoning_disabled = True
                return await self._open_stream(request)
            if (not getattr(self, "_response_format_unsupported", False)
                    and "response_format" in msg):
                self._response_format_unsupported = True
                return await self._open_stream(request)
            raise

    async def stream(self, request: LLMRequest) -> AsyncIterator[StreamEvent]:
        try:
            stream = await self._open_stream(request)
        except openai.APIError as e:
            yield _classify(e)
            return

        tool_calls: dict[int, _ToolCallState] = {}
        usage: StreamUsage | None = None
        finish_reason: str | None = None

        try:
            async for chunk in stream:
                if chunk.usage is not None:
                    _ptd = getattr(chunk.usage, "prompt_tokens_details", None)
                    _cached = int(getattr(_ptd, "cached_tokens", 0) or 0) if _ptd else 0
                    _inp = int(chunk.usage.prompt_tokens or 0)
                    usage = StreamUsage(
                        input_tokens=_inp,
                        output_tokens=int(chunk.usage.completion_tokens or 0),
                        cache_read_input_tokens=_cached,
                        # OpenAI 호환 게이트웨이는 'cache 쓰기(creation)' 수치를 주지
                        # 않는다 — prompt_tokens_details.cached_tokens 는 read-from-cache
                        # 뿐이다. (input-cached)를 creation 으로 라벨하면 일반 미캐시
                        # 입력을 Anthropic 식 cache-write 로 오기재한다(관측 왜곡).
                        # 실제로 보고된 값만 싣는다 → creation 은 0(미보고).
                        cache_creation_input_tokens=0,
                    )
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta

                if delta.content:
                    yield StreamTextDelta(text=delta.content)
                # reasoning 모델은 사고 trace 를 reasoning_content 채널로 보냄. 분리해서
                # 별도 event 로 yield — 표시는 되지만 영속·되먹임은 없다
                # (StreamReasoningDelta docstring).
                extra = getattr(delta, "model_extra", None) or {}
                rc = extra.get("reasoning_content") or extra.get("reasoning")
                if rc:
                    yield StreamReasoningDelta(text=rc)

                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        for ev in _process_tool_call_delta(tc, tool_calls):
                            yield ev

                if choice.finish_reason:
                    finish_reason = choice.finish_reason
        except openai.APIError as e:
            yield _classify(e)
            return

        for state in tool_calls.values():
            if state.emitted_start:
                yield StreamToolUseStop(tool_use_id=state.id)

        yield StreamMessageStop(
            stop_reason=_map_finish_reason(finish_reason), usage=usage,
        )
