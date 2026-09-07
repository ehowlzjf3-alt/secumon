"""Scheduler tick — background loop 1개 cycle.

scheduler_tick_once 는 단위 cycle: schedule_due → fire 하나씩 → next_run advance.
배경 task 는 web/app.py 의 lifespan 에서 startup 시 spawn.

Sub-ChatSession 은 operator task_type 으로 새로 만든다 — 메인 chat 과 같은
agent_type 의 hub 에 결과 broadcast (deliver="chat").

테스트 가능성:
- _make_sub_session 은 monkeypatch 지점.
- get_hub 는 caller 가 주입 (web layer 에서는 _get_hub, 테스트에서는 stub).
- 시각은 now 인자로 주입 가능.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from secu_agent import state
from secu_agent.agent.schedule_contract import (
    ScheduleDecision,
    evaluate_schedule_fire,
)
from secu_agent.agent.events import (
    LoopCompleted, LoopError, ReasoningChunk, TextChunk, ToolCallCompleted,
    ToolCallStarted, TurnStarted,
)
from secu_agent.agent.tools.base import ToolSuccess

log = logging.getLogger("secu_agent.scheduler")


def _runtime_task_type(agent_type: str) -> str:
    # v3.85: 단일 소스 — session_runtime 이 등록형 별칭(resolve_task_type)을 위임.
    from secu_agent.agent.session_runtime import runtime_task_type
    return runtime_task_type(agent_type)


def _make_sub_session(
    *,
    agent_type: str,
    evidence_dir: Path,
    session_id: int | None = None,
):
    """기본 factory — 실제 ChatSession 만든다. 테스트에서 monkeypatch."""
    # NOTE: 매 fire 마다 새 ChatSession 인스턴스. 같은 agent_type 의 chat_session
    # row 를 공유 (load 는 get_or_create) — 사용자 chat 과 같은 context.
    # 자율 fire 임을 구분하려면 별도 session 을 만들 수도 있는데, v1 은
    # 통합 — 운영자가 같은 채팅창에서 자율 결과를 본다.
    from secu_agent.agent.chat_session import ChatSession
    from secu_agent.agent.llm.factory import make_llm_client_from_env
    client = make_llm_client_from_env()
    return ChatSession.load(
        client=client,
        evidence_dir=evidence_dir,
        task_type=_runtime_task_type(agent_type),
        session_id=session_id,
        session_agent_type=agent_type,
    )


def _event_to_payload(ev: Any) -> dict[str, Any]:
    name = type(ev).__name__
    if isinstance(ev, TurnStarted):
        return {"event": name, "turn": ev.turn}
    if isinstance(ev, TextChunk):
        return {"event": name, "text": ev.text}
    if isinstance(ev, ReasoningChunk):
        return {"event": name, "text": ev.text}
    if isinstance(ev, ToolCallStarted):
        return {"event": name, "id": ev.tool_use_id,
                "name": ev.name, "input": ev.input}
    if isinstance(ev, ToolCallCompleted):
        is_ok = isinstance(ev.result, ToolSuccess)
        content_text = (
            ev.result.content if is_ok
            else getattr(ev.result, "message", "")
        )
        # v3.79 ② U4: 같은 프론트로 broadcast — WS 범람 방지 상한 (chat.py 와 동일)
        limit = int(os.environ.get("SA_WS_RESULT_MAX", "6000"))
        if len(content_text) > limit:
            omitted = len(content_text) - limit
            content_text = (
                content_text[:limit] + f"\n…[{omitted}자 생략 — 전체는 tool_event/DB]"
            )
        return {"event": name, "id": ev.tool_use_id, "name": ev.name,
                "ok": is_ok, "result": content_text}
    if isinstance(ev, LoopCompleted):
        return {"event": name, "reason": ev.reason,
                "total_turns": ev.total_turns}
    if isinstance(ev, LoopError):
        return {"event": name, "message": ev.message}
    return {"event": name}


def _record_delivery_dry_run(
    *,
    job: dict[str, Any],
    fire_id: int,
    status: str,
    result_summary: str | None,
    child_session_id: int | None,
) -> None:
    """Persist the report payload that an external delivery would send."""
    fire = state.schedule_fire_get(fire_id) or {}
    payload = {
        "kind": "schedule_fire_report",
        "schedule_id": job["id"],
        "fire_id": fire_id,
        "agent_type": job["agent_type"],
        "cron_expr": job["cron_expr"],
        "deliver": job["deliver"],
        "status": status,
        "result_summary": result_summary or "",
        "child_session_id": child_session_id,
        "fired_at": fire.get("fired_at"),
        "finished_at": fire.get("finished_at"),
    }
    state.schedule_delivery_record_dry_run(
        fire_id=fire_id,
        schedule_id=job["id"],
        destination="internal-report",
        payload=payload,
    )


def _signal_session(sess: Any) -> None:
    """sess.context.signal set — RalphController 가 다음 boundary 에서 멈추고
    active goal 을 pause 한다 (④-1 연동)."""
    sig = getattr(getattr(sess, "context", None), "signal", None)
    if sig is not None and hasattr(sig, "set"):
        try:
            sig.set()
        except Exception:
            pass


async def _drain_turn(
    *, sess: Any, prompt: str,
    on_event: Callable[[Any], Awaitable[None]],
    interrupt_waits: list,
    inactivity_limit: float,
    check_interval: float,
) -> str | None:
    """v3.79 ④-2: turn drain (인터럽트/무활동 감시).

    반환: None=정상 완료, 'cancelled'=stop/cancel 이벤트, 'inactivity'=무활동 중단.
    turn 내부 예외는 호출자에 그대로 전파 (기존 status=error 경로).
    """
    last_ts = time.monotonic()

    async def _consume() -> None:
        nonlocal last_ts
        async for ev in sess.turn(prompt):
            last_ts = time.monotonic()
            await on_event(ev)

    drain = asyncio.create_task(_consume())
    waiters = [asyncio.create_task(w.wait()) for w in interrupt_waits]
    try:
        while True:
            done, _pending = await asyncio.wait(
                [drain, *waiters],
                timeout=(check_interval if inactivity_limit > 0 else None),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if drain in done:
                drain.result()  # turn 예외 전파
                return None
            if any(w in done for w in waiters):
                _signal_session(sess)
                drain.cancel()
                await asyncio.gather(drain, return_exceptions=True)
                return "cancelled"
            if inactivity_limit > 0 and (time.monotonic() - last_ts) > inactivity_limit:
                _signal_session(sess)
                drain.cancel()
                await asyncio.gather(drain, return_exceptions=True)
                return "inactivity"
    finally:
        for w in waiters:
            w.cancel()


def _intent_decision(job: dict[str, Any], *, now: float) -> ScheduleDecision:
    source_session_id = job.get("source_session_id")
    latest_user_message_id: int | None = None
    if isinstance(source_session_id, int):
        latest_user_message_id = state.chat_latest_message_id(
            source_session_id,
            role="user",
        )
    return evaluate_schedule_fire(
        job,
        now=now,
        latest_user_message_id=latest_user_message_id,
    )


async def _fire_one(
    job: dict[str, Any], *,
    get_hub: Callable[[str], Awaitable[Any]] | None,
    evidence_dir: Path,
    now: float | None = None,
    interrupt_events: Callable[[int], list] | None = None,
) -> None:
    """schedule job 1개 fire — chat broadcast + ChatSession 실행 + audit."""
    sid = job["id"]
    deliver = job["deliver"]
    agent_type = job["agent_type"]
    prompt = job["prompt"]

    hub = None
    hub_channel: str | None = None
    if deliver == "chat" and get_hub is not None:
        try:
            source_session_id = job.get("source_session_id")
            channel = (
                f"{agent_type}:{source_session_id}"
                if isinstance(source_session_id, int)
                else agent_type
            )
            hub = await get_hub(channel)
            hub_channel = channel
        except Exception as e:  # 채팅 채널 없어도 fire 는 진행
            log.warning("scheduler get_hub failed: %s", e)
            hub = None

    async def _bc(payload: dict[str, Any]) -> None:
        if hub is not None:
            try:
                await hub.broadcast(payload)
            except Exception as e:
                log.warning("scheduler broadcast failed: %s", e)

    decision = _intent_decision(job, now=now or time.time())
    if not decision.should_run:
        fire_id = state.schedule_fire_start(sid)
        queued = decision.reason == "confirmation_required"
        fire_status = "queued" if queued else "skipped"
        summary = f"{fire_status}: {decision.reason}"
        if decision.detail:
            summary += f" — {decision.detail}"
        state.schedule_fire_finish(
            fire_id,
            status=fire_status,
            result_summary=summary,
            child_session_id=None,
        )
        try:
            _record_delivery_dry_run(
                job=job,
                fire_id=fire_id,
                status=fire_status,
                result_summary=summary,
                child_session_id=None,
            )
        except Exception as e:
            log.warning("scheduler deferred delivery dry-run failed: %s", e)
        await _bc({
            "event": "ScheduleFireQueued" if queued else "ScheduleFireSkipped",
            "schedule_id": sid,
            "fire_id": fire_id,
            "agent_type": agent_type,
            "reason": decision.reason,
            "detail": decision.detail,
            "status": fire_status,
        })
        return

    # 1) audit row + counter
    fire_id = state.schedule_fire_start(sid)

    await _bc({
        "event": "ScheduleFireStarted",
        "schedule_id": sid, "fire_id": fire_id,
        "agent_type": agent_type, "prompt": prompt[:200],
    })

    # 2) sub-ChatSession 실행
    summary_parts: list[str] = []
    child_session_id: int | None = None
    status = "ok"
    err_msg: str | None = None
    try:
        source_session_id = job.get("source_session_id")
        if isinstance(source_session_id, int):
            try:
                sess = _make_sub_session(
                    agent_type=agent_type,
                    evidence_dir=evidence_dir,
                    session_id=source_session_id,
                )
            except TypeError as e:
                if "session_id" not in str(e):
                    raise
                sess = _make_sub_session(agent_type=agent_type, evidence_dir=evidence_dir)
        else:
            sess = _make_sub_session(agent_type=agent_type, evidence_dir=evidence_dir)
        schedule_origin = {
            "type": "schedule",
            "schedule_id": sid,
            "fire_id": fire_id,
            "agent_type": agent_type,
            "schedule_kind": job.get("schedule_kind") or "legacy",
            "stale_policy": job.get("stale_policy") or "run",
        }
        input_origin = {
            "type": "schedule",
            "schedule_id": sid,
            "fire_id": fire_id,
        }
        setattr(sess, "schedule_origin", schedule_origin)
        setattr(sess, "input_origin", input_origin)
        ctx = getattr(sess, "context", None)
        if ctx is not None and hasattr(ctx, "metadata"):
            ctx.metadata["schedule_origin"] = schedule_origin
            ctx.metadata["input_origin"] = input_origin
        child_session_id = getattr(sess, "session_id", None)
        # v3.79 ④: 같은 세션의 사용자 turn 과 직렬화 — 웹 WS 핸들러와 같은
        # per-session 채널(f"{agent_type}:{session_id}") hub 의 turn_lock 을 잡고
        # turn 을 돌린다. 안 잡으면 스케줄 fire 와 라이브 chat 이 같은
        # chat_session row 에 동시 turn → 메시지 interleave + goal 이중 진행(꼬임).
        turn_lock = None
        if isinstance(child_session_id, int):
            lock_channel = f"{agent_type}:{child_session_id}"
            if hub is not None and hub_channel == lock_channel:
                # broadcast hub 가 이미 그 세션 채널 — 재사용 (중복 get_hub 회피)
                turn_lock = getattr(hub, "turn_lock", None)
            elif get_hub is not None:
                try:
                    lock_hub = await get_hub(lock_channel)
                    turn_lock = getattr(lock_hub, "turn_lock", None)
                except Exception:
                    turn_lock = None
        # v3.79 ④-2: 인터럽트 이벤트(웹층 stop/cancel) + 무활동 watchdog.
        # 없으면 fire 가 시작된 뒤 멈출 방법이 없다(취소 불능 + hang 시 락 영구점유).
        waits: list = []
        if interrupt_events is not None and isinstance(child_session_id, int):
            try:
                waits = [
                    w for w in (interrupt_events(child_session_id) or [])
                    if w is not None
                ]
            except Exception:
                waits = []
        inactivity_limit = float(os.environ.get(
            "SA_SCHEDULE_INACTIVITY_TIMEOUT", "600"))
        check_interval = float(os.environ.get(
            "SA_SCHEDULE_INACTIVITY_CHECK_INTERVAL", "5"))

        async def _on_turn_event(ev: Any) -> None:
            if isinstance(ev, TextChunk):
                summary_parts.append(ev.text)
            await _bc(_event_to_payload(ev))

        async with (turn_lock if turn_lock is not None
                    else contextlib.nullcontext()):
            outcome = await _drain_turn(
                sess=sess, prompt=prompt, on_event=_on_turn_event,
                interrupt_waits=waits,
                inactivity_limit=inactivity_limit,
                check_interval=check_interval,
            )
        if outcome == "cancelled":
            status = "cancelled"
            err_msg = "사용자 중단(stop/cancel) — fire 취소"
        elif outcome == "inactivity":
            status = "error"
            err_msg = f"무활동 {inactivity_limit:.0f}s 초과 — fire 중단"
    except Exception as e:
        status = "error"
        err_msg = f"{type(e).__name__}: {e}"
        log.exception("scheduler fire %s errored", sid)
        await _bc({
            "event": "LoopError",
            "message": err_msg,
        })

    # 3) audit close + next_run advance
    summary_text = (err_msg or "".join(summary_parts))[:500]
    state.schedule_fire_finish(
        fire_id, status=status,
        result_summary=summary_text or None,
        child_session_id=child_session_id,
    )
    try:
        _record_delivery_dry_run(
            job=job,
            fire_id=fire_id,
            status=status,
            result_summary=summary_text or None,
            child_session_id=child_session_id,
        )
    except Exception as e:
        log.warning("scheduler delivery dry-run failed: %s", e)

    # 다음 fire 계산 — paused 됐을 수도 있으니 status 재조회
    cur = state.schedule_get(sid)
    if cur and cur["status"] == "active":
        try:
            from secu_agent.agent.scheduler import compute_next_run
            nxt = compute_next_run(cur["cron_expr"])
            state.schedule_update(sid, next_run=nxt)
        except Exception as e:
            log.warning("schedule %s next_run compute failed: %s", sid, e)

    await _bc({
        "event": "ScheduleFireFinished",
        "schedule_id": sid, "fire_id": fire_id,
        "status": status,
    })


async def scheduler_tick_once(
    *,
    get_hub: Callable[[str], Awaitable[Any]] | None,
    evidence_dir: Path,
    now: float | None = None,
    interrupt_events: Callable[[int], list] | None = None,
) -> int:
    """1 cycle. 반환: fire 된 job 개수."""
    due = state.schedule_due(now=now)
    if not due:
        return 0
    n = 0
    for job in due:
        try:
            await _fire_one(
                job,
                get_hub=get_hub,
                evidence_dir=evidence_dir,
                now=now or time.time(),
                interrupt_events=interrupt_events,
            )
            n += 1
        except Exception:
            log.exception("scheduler tick unexpected error for sid=%s",
                          job.get("id"))
    return n


async def scheduler_loop(
    *,
    get_hub: Callable[[str], Awaitable[Any]] | None,
    evidence_dir: Path,
    interval_seconds: float = 60.0,
    stop_event=None,
    interrupt_events: Callable[[int], list] | None = None,
) -> None:
    """무한 loop — startup task. interval_seconds 마다 tick. stop_event Cancel 가능."""
    import asyncio as _aio
    log.info("scheduler loop started (interval=%s)", interval_seconds)
    while True:
        try:
            await scheduler_tick_once(
                get_hub=get_hub, evidence_dir=evidence_dir,
                interrupt_events=interrupt_events,
            )
        except Exception:
            log.exception("scheduler tick crashed (continuing)")
        if stop_event is not None:
            try:
                await _aio.wait_for(stop_event.wait(),
                                    timeout=interval_seconds)
                return  # signaled
            except _aio.TimeoutError:
                continue
        else:
            await _aio.sleep(interval_seconds)
