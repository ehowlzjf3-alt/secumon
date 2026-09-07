"""LLM fallback wrapper.

Fallback only happens when the failing client emits an error before producing
any **committed** stream output. Once text/tool output starts, switching
providers would duplicate or corrupt the assistant turn, so the original error
is surfaced.

"Committed" = text/tool-use events (persisted into the assistant turn). Reasoning
deltas (reasoning models stream a large reasoning channel FIRST) are display-only
— shown live, but never committed to the assistant turn, the DB, or next-turn
context (see StreamReasoningDelta docstring). A retryable error AFTER reasoning-only
output therefore corrupts nothing on fallback, so it must still fall back — else
a gateway 5xx that lands mid-reasoning kills the turn even though a healthy
sibling profile could have served it.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.types import (
    LLMRequest,
    StreamError,
    StreamEvent,
    StreamTextDelta,
    StreamToolUseDelta,
    StreamToolUseStart,
    StreamToolUseStop,
)

_DEFAULT_FALLBACK_ERROR_KINDS = frozenset({"transient", "rate_limit", "auth"})

# 폴백 차단 판정 = "커밋 출력이 시작됐나". 이 이벤트들만 assistant 턴에 커밋된다.
# StreamReasoningDelta(비영속 사고 trace) / StreamMessageStop / usage 는 제외 —
# 그 뒤 프로바이더 전환은 아무것도 오염시키지 않으므로 폴백 허용.
_COMMITTED_EVENTS = (
    StreamTextDelta,
    StreamToolUseStart,
    StreamToolUseDelta,
    StreamToolUseStop,
)


class FallbackLLMClient(LLMClient):
    def __init__(
        self,
        clients: list[LLMClient],
        *,
        fallback_error_kinds: frozenset[str] = _DEFAULT_FALLBACK_ERROR_KINDS,
    ) -> None:
        if not clients:
            raise ValueError("FallbackLLMClient requires at least one client")
        self._clients = clients
        self._fallback_error_kinds = fallback_error_kinds

    @property
    def name(self) -> str:
        return "fallback(" + " -> ".join(c.name for c in self._clients) + ")"

    @property
    def harness_tier(self) -> str | None:
        # Front-D: 주 client(첫 프로필) 등급을 대표로 노출. 없으면 None(=mid).
        return getattr(self._clients[0], "harness_tier", None) if self._clients else None

    def _should_fallback(self, error: StreamError) -> bool:
        return error.retryable or error.kind in self._fallback_error_kinds

    async def stream(self, request: LLMRequest) -> AsyncIterator[StreamEvent]:
        last_error: StreamError | None = None
        for idx, client in enumerate(self._clients):
            committed = False
            async for event in client.stream(request):
                if isinstance(event, StreamError):
                    can_try_next = (
                        not committed
                        and idx < len(self._clients) - 1
                        and self._should_fallback(event)
                    )
                    if can_try_next:
                        last_error = event
                        break
                    yield event
                    return
                # reasoning/usage/message_stop 는 committed 로 세지 않는다 —
                # 그 뒤 retryable 에러는 무손실 폴백 가능.
                if isinstance(event, _COMMITTED_EVENTS):
                    committed = True
                yield event
            else:
                return
        if last_error is not None:
            yield last_error

    async def aclose(self) -> None:
        for client in self._clients:
            close = getattr(client, "aclose", None)
            if close is not None:
                await close()
