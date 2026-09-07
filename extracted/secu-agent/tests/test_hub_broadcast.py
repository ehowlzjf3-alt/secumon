"""v3.79 ② U3: Hub full 포트 — per-sub queue + sender task + coalesce + drop-oldest.

②-2(lite)는 병렬 gather + timeout 으로 head-of-line 만 제거했다. full 포트:
- broadcast = enqueue-only (I/O 없음) → 에이전트 turn 이 뷰어 TCP backpressure 에
  1ms 도 안 잡힘.
- per-sub sender task 가 큐를 drain — 연속 TextChunk/ReasoningChunk 는 한 프레임으로
  coalesce (프론트는 둘 다 append 렌더라 병합 무손실).
- 큐 가득 차면 drop-oldest (최신 프레임 우선 — 라이브 뷰 특성).
- send 실패/timeout(SA_WS_SEND_TIMEOUT) → 구독자 self-remove.
"""
from __future__ import annotations

import asyncio
import json
import time


def _run(coro):
    return asyncio.run(coro)


async def _drain(seconds: float = 0.05):
    """sender task 가 큐를 비울 시간."""
    await asyncio.sleep(seconds)


class _FastWS:
    def __init__(self):
        self.frames: list[dict] = []

    async def send_text(self, text: str) -> None:
        self.frames.append(json.loads(text))


class _GatedWS:
    """첫 send 부터 gate 가 열릴 때까지 블록 — coalesce/drop-oldest 시나리오용."""

    def __init__(self):
        self.gate = asyncio.Event()
        self.frames: list[dict] = []

    async def send_text(self, text: str) -> None:
        await self.gate.wait()
        self.frames.append(json.loads(text))


class _SlowWS:
    def __init__(self, delay: float):
        self.delay = delay
        self.frames: list[dict] = []

    async def send_text(self, text: str) -> None:
        await asyncio.sleep(self.delay)
        self.frames.append(json.loads(text))


class _DeadWS:
    async def send_text(self, text: str) -> None:
        raise RuntimeError("connection closed")


def test_broadcast_returns_without_viewer_io(tmp_db):
    """broadcast 는 enqueue-only — 느린 뷰어(0.3s)가 있어도 즉시 반환."""
    from secu_agent.web.routes.chat import _Hub

    async def _go():
        hub = _Hub()
        slow = _SlowWS(0.3)
        await hub.join(slow)
        t0 = time.monotonic()
        await hub.broadcast({"event": "TextChunk", "text": "x"})
        elapsed = time.monotonic() - t0
        await _drain(0.5)
        await hub.leave(slow)
        return elapsed, slow

    elapsed, slow = _run(_go())
    assert elapsed < 0.05, f"broadcast 가 뷰어 I/O 를 기다림 ({elapsed:.3f}s)"
    assert len(slow.frames) == 1  # 비동기로 결국 전달


def test_broadcast_timeout_drops_hung_subscriber(tmp_db, monkeypatch):
    from secu_agent.web.routes.chat import _Hub

    monkeypatch.setenv("SA_WS_SEND_TIMEOUT", "0.2")

    async def _go():
        hub = _Hub()
        fast, hung = _FastWS(), _SlowWS(60)
        await hub.join(fast)
        await hub.join(hung)
        await hub.broadcast({"event": "TextChunk", "text": "x"})
        await _drain(0.4)  # hung 의 send timeout(0.2s) 경과
        await hub.broadcast({"event": "TextChunk", "text": "y"})
        await _drain()
        n_subs = len(hub._subs)
        await hub.leave(fast)
        return fast, n_subs

    fast, n_subs = _run(_go())
    assert len(fast.frames) == 2
    assert n_subs == 1  # hung 은 self-remove


def test_broadcast_drops_failing_subscriber(tmp_db):
    from secu_agent.web.routes.chat import _Hub

    async def _go():
        hub = _Hub()
        fast, dead = _FastWS(), _DeadWS()
        await hub.join(fast)
        await hub.join(dead)
        await hub.broadcast({"event": "TextChunk", "text": "x"})
        await _drain()
        n_subs = len(hub._subs)
        await hub.leave(fast)
        return fast, n_subs

    fast, n_subs = _run(_go())
    assert len(fast.frames) == 1
    assert n_subs == 1


def test_consecutive_text_chunks_coalesced(tmp_db):
    """sender 가 블록된 사이 쌓인 연속 TextChunk 는 한 프레임으로 병합."""
    from secu_agent.web.routes.chat import _Hub

    async def _go():
        hub = _Hub()
        gated = _GatedWS()
        await hub.join(gated)
        await hub.broadcast({"event": "TextChunk", "text": "안"})
        await _drain()  # sender 가 첫 프레임 send 에서 gate 대기 시작
        for t in ("녕", "하", "세", "요"):
            await hub.broadcast({"event": "TextChunk", "text": t})
        gated.gate.set()
        await _drain()
        await hub.leave(gated)
        return gated

    gated = _run(_go())
    # 첫 프레임("안") + 병합 프레임("녕하세요") = 2 프레임 (5개 아님)
    assert len(gated.frames) == 2, f"coalesce 안 됨 — {len(gated.frames)} frames"
    assert gated.frames[0]["text"] == "안"
    assert gated.frames[1]["text"] == "녕하세요"


def test_coalesce_does_not_cross_event_types(tmp_db):
    """TextChunk 사이의 ToolCallStarted 는 병합 경계 — 순서 보존."""
    from secu_agent.web.routes.chat import _Hub

    async def _go():
        hub = _Hub()
        gated = _GatedWS()
        await hub.join(gated)
        await hub.broadcast({"event": "TextChunk", "text": "a"})
        await _drain()
        await hub.broadcast({"event": "TextChunk", "text": "b"})
        await hub.broadcast({"event": "ToolCallStarted", "name": "memory", "id": "t1"})
        await hub.broadcast({"event": "TextChunk", "text": "c"})
        gated.gate.set()
        await _drain()
        await hub.leave(gated)
        return gated

    gated = _run(_go())
    events = [f["event"] for f in gated.frames]
    assert events == ["TextChunk", "TextChunk", "ToolCallStarted", "TextChunk"]
    assert gated.frames[1]["text"] == "b"
    assert gated.frames[3]["text"] == "c"


def test_queue_full_drops_oldest(tmp_db, monkeypatch):
    """큐 가득 → 가장 오래된 프레임 drop, 최신 유지 (라이브 뷰 우선)."""
    from secu_agent.web.routes.chat import _Hub

    monkeypatch.setenv("SA_WS_QUEUE_MAX", "3")

    async def _go():
        hub = _Hub()
        gated = _GatedWS()
        await hub.join(gated)
        await hub.broadcast({"event": "ToolCallStarted", "name": "t0", "id": "0"})
        await _drain()  # sender 가 t0 send 에서 gate 대기 — 이후는 큐에 쌓임
        for i in range(1, 11):  # 10개 — 큐(3) 초과
            await hub.broadcast({"event": "ToolCallStarted", "name": f"t{i}", "id": str(i)})
        gated.gate.set()
        await _drain()
        await hub.leave(gated)
        return gated

    gated = _run(_go())
    names = [f["name"] for f in gated.frames]
    assert names[0] == "t0"  # in-flight
    assert len(names) <= 5  # 큐 상한 3 + in-flight (병합 없음 — 타입별 name 다름)
    assert names[-1] == "t10"  # 최신은 반드시 생존
