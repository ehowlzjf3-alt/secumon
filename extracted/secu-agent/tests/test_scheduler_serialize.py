"""v3.79 ④: 스케줄 fire 를 같은 세션의 사용자 turn 과 직렬화.

배경: _fire_one 은 source_session_id 로 사용자 라이브 chat 과 같은 chat_session
row 에 sess.turn() 을 돌리는데, 웹 WS 핸들러가 잡는 per-session hub.turn_lock
(channel = f"{agent_type}:{session_id}") 을 잡지 않았다 → 유저 turn 과 스케줄 fire 가
동시 실행되어 메시지 interleave + goal 이중 진행(꼬임).

수정: _fire_one 이 세션 확정 후 같은 채널 hub 의 turn_lock 을 잡고 turn 을 drain.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

from secu_agent import state
from secu_agent.agent.events import LoopCompleted


class _LockHub:
    """web routes 의 _Hub 흉내 — turn_lock + broadcast."""

    def __init__(self):
        self.calls: list[dict[str, Any]] = []
        self._turn_lock = asyncio.Lock()

    @property
    def turn_lock(self) -> asyncio.Lock:
        return self._turn_lock

    async def broadcast(self, payload: dict[str, Any]) -> None:
        self.calls.append(payload)


def _run(coro):
    return asyncio.run(coro)


def test_fire_one_holds_session_turn_lock_during_turn(tmp_db, tmp_path, monkeypatch):
    from secu_agent.agent import scheduler_tick

    src_sid = state.chat_session_new(agent_type="agent")
    state.schedule_create(
        agent_type="agent", prompt="아침 점검", cron_expr="* * * * *",
        next_run=time.time() - 10, origin="operator_agent",
        source_session_id=src_sid,
    )
    job = state.schedule_due(now=time.time())[0]

    hub = _LockHub()
    channels: list[str] = []

    async def _get_hub(channel: str):
        channels.append(channel)
        return hub

    observed = {"locked_during_turn": None}

    class _Sess:
        session_id = src_sid

        async def turn(self, user_text: str):
            observed["locked_during_turn"] = hub.turn_lock.locked()
            yield LoopCompleted(
                reason="end_turn", total_turns=1, final_message=None, usage=None,
            )

    def _factory(*, agent_type, evidence_dir, session_id=None):
        return _Sess()

    monkeypatch.setattr(scheduler_tick, "_make_sub_session", _factory)

    _run(scheduler_tick._fire_one(
        job, get_hub=_get_hub, evidence_dir=tmp_path, now=time.time(),
    ))

    assert observed["locked_during_turn"] is True, (
        "스케줄 fire 의 turn 이 per-session turn_lock 안에서 돌아야 함 — "
        "안 잡으면 사용자 turn 과 동시 실행(꼬임)"
    )
    # turn 끝나면 락 해제 (다음 사용자 turn 막으면 안 됨)
    assert hub.turn_lock.locked() is False
    # 웹 WS 핸들러와 같은 채널 컨벤션으로 락을 가져갔는지
    assert f"agent:{src_sid}" in channels


def test_fire_one_lock_hub_missing_turn_lock_graceful(tmp_db, tmp_path, monkeypatch):
    """기존 테스트들의 hub stub 엔 turn_lock 이 없음 — 없으면 락 없이 진행 (회귀 가드)."""
    from secu_agent.agent import scheduler_tick

    src_sid = state.chat_session_new(agent_type="agent")
    state.schedule_create(
        agent_type="agent", prompt="x", cron_expr="* * * * *",
        next_run=time.time() - 10, origin="operator_agent",
        source_session_id=src_sid,
    )
    job = state.schedule_due(now=time.time())[0]

    class _Bare:  # turn_lock 없음
        async def broadcast(self, payload):
            pass

    async def _get_hub(channel: str):
        return _Bare()

    done = {"ran": False}

    class _Sess:
        session_id = src_sid

        async def turn(self, user_text: str):
            done["ran"] = True
            yield LoopCompleted(
                reason="end_turn", total_turns=1, final_message=None, usage=None,
            )

    def _factory(*, agent_type, evidence_dir, session_id=None):
        return _Sess()

    monkeypatch.setattr(scheduler_tick, "_make_sub_session", _factory)
    _run(scheduler_tick._fire_one(
        job, get_hub=_get_hub, evidence_dir=tmp_path, now=time.time(),
    ))
    assert done["ran"] is True
