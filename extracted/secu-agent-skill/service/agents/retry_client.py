"""LLM client 턴별 재시도 래퍼 — 간헐 게이트웨이 500 흡수.

배경: security 게이트웨이(LiteLLM)가 스트리밍 콜마다 간헐적으로 transient 500
("'async for'...got NoneType" 등)을 낸다(관측상 콜당 ~1/6). 멀티턴 에이전트 태스크는
10~40콜을 하므로 그중 하나가 거의 확실히 터져 **태스크 전체가 실패**한다. 체인 폴백
(같은 게이트웨이의 형제 모델끼리)은 소용이 없다 — 같은 턴에 둘 다 500 이다.

해법: 콘텐츠(text/tool delta) **커밋 전**의 transient StreamError는 **같은 요청으로
재시도**한다(무손실 — 이미 방출한 델타 없음). 콜당 17% 실패가 재시도 2회면 ~0.5%로 떨어져
멀티턴 태스크가 완주한다. 폴백(다른 모델 전환)과 직교 — 폴백 전에 같은 모델을 먼저 되살린다.

kill-switch: SA_STREAM_RETRY=0. 횟수: SA_STREAM_RETRY_MAX(기본 2). 관측: SA_STREAM_RETRY_DEBUG.
"""
from __future__ import annotations

import asyncio
import os
import sys
from typing import Any, AsyncIterator

from secu_agent.agent.llm.types import (
    StreamError,
    StreamTextDelta,
    StreamToolUseDelta,
    StreamToolUseStart,
    StreamToolUseStop,
)

# 콘텐츠/도구 델타가 나가면 "커밋" — 그 뒤 에러는 재시도 시 중복 방출되므로 재시도 금지.
# (reasoning/usage/message_stop 은 커밋 아님 — FallbackLLMClient 와 동일 기준.)
_COMMITTED = (StreamTextDelta, StreamToolUseStart, StreamToolUseDelta, StreamToolUseStop)


class RetryingLLMClient:
    """단일 LLM client 를 감싸 커밋-전 transient StreamError 를 같은 요청으로 재시도."""

    def __init__(self, inner: Any, *, max_retries: int | None = None, base_delay: float = 0.6):
        self._inner = inner
        if max_retries is None:
            try:
                max_retries = int(os.environ.get("SA_STREAM_RETRY_MAX", "2"))
            except ValueError:
                max_retries = 2
        self._max = max(0, max_retries)
        self._delay = base_delay

    @property
    def name(self) -> str:
        return f"retry({getattr(self._inner, 'name', '?')})"

    def __getattr__(self, item: str) -> Any:
        # name/stream 은 자기 것. 그 외(harness_tier/aclose/...)는 inner 위임.
        return getattr(self._inner, item)

    async def stream(self, request: Any) -> AsyncIterator[Any]:
        attempt = 0
        while True:
            committed = False
            captured: StreamError | None = None
            async for ev in self._inner.stream(request):
                if isinstance(ev, StreamError):
                    if not committed:
                        captured = ev
                        break  # 아직 콘텐츠 미방출 → 재시도 후보
                    yield ev   # 커밋 후 에러 → 무손실 재시도 불가, 그대로 전파
                    return
                if isinstance(ev, _COMMITTED):
                    committed = True
                yield ev
            if captured is not None and captured.retryable and attempt < self._max:
                attempt += 1
                if os.environ.get("SA_STREAM_RETRY_DEBUG"):
                    print(
                        f"[retry] {self.name} transient '{captured.message[:80]}' "
                        f"재시도 {attempt}/{self._max}",
                        file=sys.stderr, flush=True,
                    )
                await asyncio.sleep(self._delay * attempt)
                continue  # 같은 요청 재시도(콘텐츠 미커밋 → 안전)
            if captured is not None:
                yield captured  # 소진/비재시도 → 전파(폴백이 받아 다른 모델로 넘길 수 있음)
            return


def wrap_retry(client: Any) -> Any:
    """SA_STREAM_RETRY=0 이 아니면 재시도 래퍼로 감싼다."""
    if os.environ.get("SA_STREAM_RETRY", "1").strip().lower() in {"0", "false", "no", "off"}:
        return client
    return RetryingLLMClient(client)
