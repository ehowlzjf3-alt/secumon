"""요청을 보낸 순간이 idle 시계의 기준이 된다 (2026-08-27).

## 무엇이 있었나

검토원들이 **생각하는 중에** 죽었다. 실측:

    [loop error] harness idle timeout: no observable activity for 300.3s
                 after turn_started
    budget_trip: kind=idle, last_event="turn_started"

    github     검토원 idle 사망  7/7   (100%)
    confluence                  10/38  (26%)

`turn_started` 이후 첫 청크가 올 때까지 관측 가능한 이벤트가 **하나도 없다**.
모델 추론이든 백엔드 대기든, 그 구간은 워치독 눈에 "아무 일도 안 일어남" 이다.
그래서 느린 호출 하나가 살아 있는 런을 죽였다.

## 고침

요청을 보내는 순간 `report_progress("llm_request_sent")` 를 한 번 친다.
그러면 호출은 `max_idle_sec` 만큼의 시간을 온전히 받는다.

★ **요청당 한 번이다 — 하트비트가 아니다.** 응답이 영영 안 오면 워치독은 여전히
  운다. 주기적으로 touch 하면 멎은 호출을 무한정 붙잡게 되고, 그건 워치독을
  없애는 것과 같다.

⚠️ 이것만으로 부족하다: `max_idle_sec` 이 클라이언트 timeout 보다 커야
   "클라이언트가 먼저 말하고 워치독은 진짜 죽음만 잡는" 순서가 된다.
   그 불변식은 스킬 저장소 `_shared/tests/test_inspector_idle_ordering.py` 가 잰다.
"""
from __future__ import annotations

import asyncio
import inspect

from secu_agent.agent import engine
from secu_agent.agent.tools.base import ToolContext


class _Ctx(ToolContext):
    pass


def _ctx(events: list[str]) -> ToolContext:
    c = ToolContext(evidence_dir=None, metadata={})
    c.progress = events.append
    return c


class _SilentClient:
    """요청을 받고 **아무 청크도 안 주는** 클라이언트 — 느린 백엔드 대역."""

    def __init__(self, chunks=()):
        self.chunks = list(chunks)

    async def stream(self, request):  # noqa: ANN001
        for ch in self.chunks:
            yield ch


def _drain(client, ctx):
    class _B:
        usage = None
        stop_reason = None

        def apply(self, ev):  # noqa: ANN001
            return None

    async def _run():
        out = []
        async for ev in engine._stream_and_yield(client, object(), _B(), None, ctx):
            out.append(ev)
        return out

    return asyncio.run(_run())


def test_sending_the_request_counts_as_activity():
    """★ 청크가 하나도 없어도 '요청을 보냈다' 는 관측이다."""
    events: list[str] = []
    _drain(_SilentClient(), _ctx(events))
    assert "llm_request_sent" in events, "요청 시작이 부모 타이머에 안 닿는다"


def test_it_fires_once_per_request_not_per_chunk():
    """★ 하트비트로 퇴화하면 멎은 호출을 무한정 붙잡는다."""
    events: list[str] = []
    _drain(_SilentClient(chunks=[object(), object(), object()]), _ctx(events))
    assert events.count("llm_request_sent") == 1, f"요청당 한 번이 아니다: {events}"


def test_a_missing_context_is_harmless():
    """`context=None` 경로(테스트·비하네스 호출)에서 죽지 않는다."""
    assert _drain(_SilentClient(), None) == []


def test_the_touch_happens_before_the_stream_is_consumed():
    """★ 스트림을 다 읽은 뒤에 치면 아무 소용이 없다 — 죽는 건 그 사이다."""
    src = inspect.getsource(engine._stream_and_yield)
    touch = src.index('report_progress("llm_request_sent")')
    stream = src.index("async for ev in client.stream(request)")
    assert touch < stream, "touch 가 스트림 소비 뒤에 있다"
