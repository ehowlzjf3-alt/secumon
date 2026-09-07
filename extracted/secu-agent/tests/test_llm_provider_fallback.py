from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.fallback import FallbackLLMClient
from secu_agent.agent.llm.factory import _profile_names_from_env
from secu_agent.agent.llm.types import (
    LLMRequest,
    StreamError,
    StreamEvent,
    StreamMessageStop,
    StreamReasoningDelta,
    StreamTextDelta,
    StreamToolUseStart,
)


class _ScriptedClient(LLMClient):
    def __init__(self, name: str, events: list[StreamEvent]):
        self._name = name
        self.events = events
        self.calls = 0
        self.closed = False

    @property
    def name(self) -> str:
        return self._name

    async def stream(self, request: LLMRequest) -> AsyncIterator[StreamEvent]:
        del request
        self.calls += 1
        for event in self.events:
            yield event

    async def aclose(self) -> None:
        self.closed = True


async def _collect(client: LLMClient) -> list[StreamEvent]:
    return [event async for event in client.stream(LLMRequest(messages=[]))]


@pytest.mark.anyio
async def test_fallback_uses_next_client_on_retryable_first_event():
    primary = _ScriptedClient(
        "primary",
        [StreamError(kind="transient", message="timeout", retryable=True)],
    )
    secondary = _ScriptedClient(
        "secondary",
        [
            StreamTextDelta(text="ok"),
            StreamMessageStop(stop_reason="end_turn", usage=None),
        ],
    )

    events = await _collect(FallbackLLMClient([primary, secondary]))

    assert [type(e).__name__ for e in events] == [
        "StreamTextDelta",
        "StreamMessageStop",
    ]
    assert primary.calls == 1
    assert secondary.calls == 1


@pytest.mark.anyio
async def test_fallback_uses_next_client_on_auth_error():
    primary = _ScriptedClient(
        "primary",
        [StreamError(kind="auth", message="bad key", retryable=False)],
    )
    secondary = _ScriptedClient(
        "secondary",
        [StreamTextDelta(text="backup")],
    )

    events = await _collect(FallbackLLMClient([primary, secondary]))

    assert isinstance(events[0], StreamTextDelta)
    assert events[0].text == "backup"
    assert secondary.calls == 1


@pytest.mark.anyio
async def test_fallback_does_not_retry_non_fallback_error():
    primary = _ScriptedClient(
        "primary",
        [StreamError(kind="invalid_request", message="bad schema", retryable=False)],
    )
    secondary = _ScriptedClient("secondary", [StreamTextDelta(text="unused")])

    events = await _collect(FallbackLLMClient([primary, secondary]))

    assert isinstance(events[0], StreamError)
    assert events[0].kind == "invalid_request"
    assert secondary.calls == 0


@pytest.mark.anyio
async def test_fallback_does_not_switch_after_partial_output():
    primary = _ScriptedClient(
        "primary",
        [
            StreamTextDelta(text="partial"),
            StreamError(kind="transient", message="late timeout", retryable=True),
        ],
    )
    secondary = _ScriptedClient("secondary", [StreamTextDelta(text="unused")])

    events = await _collect(FallbackLLMClient([primary, secondary]))

    assert [type(e).__name__ for e in events] == ["StreamTextDelta", "StreamError"]
    assert secondary.calls == 0


@pytest.mark.anyio
async def test_fallback_after_reasoning_only_delta():
    """reasoning delta(비커밋) 뒤 retryable 에러 → 다음 프로파일로 폴백.

    gauss/gpt-oss 는 reasoning_content 를 먼저 대량으로 흘린다. reasoning 은
    frontend/DB/next-turn 어디에도 커밋되지 않으므로, 그 뒤 게이트웨이 5xx 에서
    프로바이더를 바꿔도 assistant 턴은 오염되지 않는다 → 무손실 폴백해야 한다.
    """
    primary = _ScriptedClient(
        "primary",
        [
            StreamReasoningDelta(text="let me think..."),
            StreamError(kind="transient", message="gateway 500", retryable=True),
        ],
    )
    secondary = _ScriptedClient(
        "secondary",
        [
            StreamTextDelta(text="answer"),
            StreamMessageStop(stop_reason="end_turn", usage=None),
        ],
    )

    events = await _collect(FallbackLLMClient([primary, secondary]))

    # primary 의 reasoning 은 그대로 yield 되고(표시용), 커밋 출력은 secondary 것만.
    assert [type(e).__name__ for e in events] == [
        "StreamReasoningDelta",
        "StreamTextDelta",
        "StreamMessageStop",
    ]
    assert isinstance(events[1], StreamTextDelta) and events[1].text == "answer"
    assert primary.calls == 1 and secondary.calls == 1


@pytest.mark.anyio
async def test_fallback_blocked_after_tool_use_start():
    """tool-use 시작(커밋)은 폴백 차단 — 텍스트와 동일하게 턴을 오염시킨다."""
    primary = _ScriptedClient(
        "primary",
        [
            StreamToolUseStart(tool_use_id="t1", name="scan_text"),
            StreamError(kind="transient", message="late 500", retryable=True),
        ],
    )
    secondary = _ScriptedClient("secondary", [StreamTextDelta(text="unused")])

    events = await _collect(FallbackLLMClient([primary, secondary]))

    assert [type(e).__name__ for e in events] == ["StreamToolUseStart", "StreamError"]
    assert secondary.calls == 0


@pytest.mark.anyio
async def test_no_fallback_when_reasoning_then_non_fallback_error():
    """reasoning 뒤라도 비-폴백 에러(invalid_request)는 그대로 표면화."""
    primary = _ScriptedClient(
        "primary",
        [
            StreamReasoningDelta(text="hmm"),
            StreamError(kind="invalid_request", message="bad", retryable=False),
        ],
    )
    secondary = _ScriptedClient("secondary", [StreamTextDelta(text="unused")])

    events = await _collect(FallbackLLMClient([primary, secondary]))

    assert [type(e).__name__ for e in events] == [
        "StreamReasoningDelta",
        "StreamError",
    ]
    assert secondary.calls == 0


@pytest.mark.anyio
async def test_fallback_closes_all_clients():
    first = _ScriptedClient("first", [])
    second = _ScriptedClient("second", [])
    client = FallbackLLMClient([first, second])

    await client.aclose()

    assert first.closed is True
    assert second.closed is True


def test_profile_names_from_env_prefers_explicit_chain():
    profiles = {"a": object(), "b": object(), "c": object()}

    names = _profile_names_from_env(
        profiles=profiles,
        profile_name="a",
        chain_raw=" missing, b, c ",
    )

    assert names == ["b", "c"]


def test_profile_names_from_env_falls_back_to_first_profile_when_missing():
    profiles = {"first": object(), "second": object()}

    names = _profile_names_from_env(
        profiles=profiles,
        profile_name="missing",
        chain_raw=None,
    )

    assert names == ["first"]
