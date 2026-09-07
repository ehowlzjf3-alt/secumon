"""v3.79 ④-2: 스케줄 fire cancel/watchdog — 'fire 가 시작되면 멈출 방법이 없음' 제거.

배경: _fire_one 의 turn drain 은 ESC(stop/cancel 이벤트)도 무활동 watchdog 도 없이
끝까지 돈다 → 사용자가 스케줄 fire 를 멈출 수 없고(취소 안됨), LLM/도구 hang 이면
fire 가 영원히 잡혀 있는다(다음 fire 도 lock 에 막힘).

수정: _fire_one 에 interrupt_events 주입(웹층의 per-session stop/cancel 이벤트 접근자)
+ SA_SCHEDULE_INACTIVITY_TIMEOUT 무활동 watchdog. 인터럽트 시 sess.context.signal 도
set — RalphController 가 active goal 을 pause(④-1 연동).
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

from secu_agent import state
from secu_agent.agent.events import LoopCompleted, TextChunk


def _run(coro):
    return asyncio.run(coro)


class _Ctx:
    def __init__(self):
        self.signal = asyncio.Event()
        self.metadata: dict[str, Any] = {}


def _mk_schedule(agent_type="agent", src_sid=None):
    state.schedule_create(
        agent_type=agent_type, prompt="장시간 점검", cron_expr="* * * * *",
        next_run=time.time() - 10, origin="operator_agent",
        source_session_id=src_sid,
    )
    return state.schedule_due(now=time.time())[0]


def test_fire_one_cancelled_by_interrupt_event(tmp_db, tmp_path, monkeypatch):
    from secu_agent.agent import scheduler_tick

    src_sid = state.chat_session_new(agent_type="agent")
    job = _mk_schedule(src_sid=src_sid)

    interrupt = asyncio.Event()

    class _HangingSess:
        session_id = src_sid

        def __init__(self):
            self.context = _Ctx()

        async def turn(self, user_text: str):
            yield TextChunk(text="시작")
            await asyncio.sleep(3600)  # ESC 없으면 영원히

    sess_holder: dict[str, Any] = {}

    def _factory(*, agent_type, evidence_dir, session_id=None):
        sess_holder["sess"] = _HangingSess()
        return sess_holder["sess"]

    monkeypatch.setattr(scheduler_tick, "_make_sub_session", _factory)

    async def _go():
        async def _fire():
            await scheduler_tick._fire_one(
                job, get_hub=None, evidence_dir=tmp_path, now=time.time(),
                interrupt_events=lambda sid: [interrupt],
            )
        task = asyncio.create_task(_fire())
        await asyncio.sleep(0.1)
        interrupt.set()  # 사용자 ESC/X
        await asyncio.wait_for(task, timeout=5.0)

    _run(_go())

    fire = state.schedule_fires_for(job["id"])[0]
    assert fire["status"] == "cancelled", f"fire status={fire['status']}"
    # ④-1 연동: signal set → (실세션이면) RalphController 가 goal pause
    assert sess_holder["sess"].context.signal.is_set()


def test_fire_one_inactivity_watchdog(tmp_db, tmp_path, monkeypatch):
    from secu_agent.agent import scheduler_tick

    job = _mk_schedule()
    monkeypatch.setenv("SA_SCHEDULE_INACTIVITY_TIMEOUT", "0.2")
    monkeypatch.setenv("SA_SCHEDULE_INACTIVITY_CHECK_INTERVAL", "0.05")

    class _HangingSess:
        session_id = 12345

        def __init__(self):
            self.context = _Ctx()

        async def turn(self, user_text: str):
            yield TextChunk(text="시작")
            await asyncio.sleep(3600)  # hang

    def _factory(*, agent_type, evidence_dir, session_id=None):
        return _HangingSess()

    monkeypatch.setattr(scheduler_tick, "_make_sub_session", _factory)

    async def _go():
        await asyncio.wait_for(
            scheduler_tick._fire_one(
                job, get_hub=None, evidence_dir=tmp_path, now=time.time(),
            ),
            timeout=5.0,
        )

    _run(_go())
    fire = state.schedule_fires_for(job["id"])[0]
    assert fire["status"] == "error"
    assert "무활동" in (fire["result_summary"] or "")


def test_fire_one_normal_completion_unaffected(tmp_db, tmp_path, monkeypatch):
    """정상 완료 경로 회귀 가드 — interrupt 미주입 + 빠른 turn → ok."""
    from secu_agent.agent import scheduler_tick

    job = _mk_schedule()

    class _Sess:
        session_id = 777

        def __init__(self):
            self.context = _Ctx()

        async def turn(self, user_text: str):
            yield TextChunk(text="done")
            yield LoopCompleted(
                reason="end_turn", total_turns=1, final_message=None, usage=None,
            )

    def _factory(*, agent_type, evidence_dir, session_id=None):
        return _Sess()

    monkeypatch.setattr(scheduler_tick, "_make_sub_session", _factory)
    _run(scheduler_tick._fire_one(
        job, get_hub=None, evidence_dir=tmp_path, now=time.time(),
    ))
    fire = state.schedule_fires_for(job["id"])[0]
    assert fire["status"] == "ok"
    assert "done" in (fire["result_summary"] or "")
