"""Persistent SMB report/mail application runner.

The one-shot `smb_report_mail` TaskPlan is still the unit of work. This module
only owns wakeup/liveness: poll `mail_thread(status='reported')`, keep the
mail heartbeat fresh, and run the registered fanout plan whenever work exists.
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
import logging
import os
from typing import Any

from domains.smb.application.contracts import COMPONENT_MAIL, PHASE_REPORT_MAIL, SMB_REPORT_MAIL_PLAN
from domains.smb.application.ports import CorePlanGatewayPort, ReportMailLoopStorePort

log = logging.getLogger("service.agents.report_mail_loop")

COMPONENT = COMPONENT_MAIL
PLAN_NAME = SMB_REPORT_MAIL_PLAN
ACTIVE_PHASE = PHASE_REPORT_MAIL
DEFAULT_POLL_SECONDS = 15.0

PlanRunner = Callable[[asyncio.Event], Awaitable[dict[str, Any]]]
SleepFn = Callable[[float], Awaitable[Any]]


@dataclass(frozen=True)
class ReportMailServices:
    store: ReportMailLoopStorePort
    plan_gateway: CorePlanGatewayPort


def _float_env(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _poll_seconds() -> float:
    return _float_env("SMB_REPORT_MAIL_POLL_SECONDS", DEFAULT_POLL_SECONDS)


def _heartbeat(
    services: ReportMailServices,
    phase: str,
    detail: str | None = None,
) -> None:
    services.store.heartbeat_upsert(COMPONENT, phase=phase, detail=detail, pid=os.getpid())


async def run_report_mail_plan(
    cancel_event: asyncio.Event,
    services: ReportMailServices,
) -> dict[str, Any]:
    """Run one `smb_report_mail` fanout pass and record a pipeline_run row."""
    from secu_agent.agent.events import (
        PhaseAborted,
        PhaseCompleted,
        PhaseStarted,
        PlanCompleted,
        WorkerCompleted,
    )

    plan = services.plan_gateway.ensure_plan_loaded(PLAN_NAME)
    run_id = services.store.pipeline_run_start(COMPONENT)
    status = "ok"
    detail = "no completion"
    claimed = succeeded = failed = 0
    try:
        async for ev in services.plan_gateway.run_plan_events(plan, cancel_event=cancel_event):
            if isinstance(ev, PhaseStarted):
                _heartbeat(services, ACTIVE_PHASE, f"{ev.adapter} k={ev.k}")
            elif isinstance(ev, WorkerCompleted):
                _heartbeat(services, ACTIVE_PHASE, f"{ev.label}: {ev.status}")
            elif isinstance(ev, PhaseCompleted):
                report = ev.report
                claimed = int(getattr(report, "claimed", 0) or 0)
                succeeded = int(getattr(report, "succeeded", 0) or 0)
                failed = int(getattr(report, "failed", 0) or 0)
                detail = f"claimed={claimed} ok={succeeded} fail={failed}"
                _heartbeat(services, ACTIVE_PHASE, detail)
            elif isinstance(ev, PhaseAborted):
                status = "error"
                detail = ev.reason[:500]
                _heartbeat(services, "error", detail)
            elif isinstance(ev, PlanCompleted):
                result = ev.result
                claimed = int(getattr(result, "total_claimed", 0) or 0)
                succeeded = int(getattr(result, "total_succeeded", 0) or 0)
                failed = int(getattr(result, "total_failed", 0) or 0)
                status = "cancelled" if ev.cancelled else ("error" if ev.aborted else "ok")
                detail = (
                    f"reason={ev.reason} claimed={claimed} "
                    f"ok={succeeded} fail={failed}"
                )
        return {
            "claimed": claimed,
            "succeeded": succeeded,
            "failed": failed,
            "status": status,
            "detail": detail,
        }
    except Exception as e:  # noqa: BLE001
        status = "error"
        detail = repr(e)[:500]
        _heartbeat(services, "error", detail)
        raise
    finally:
        services.store.pipeline_run_finish(run_id, status=status, detail=detail)


async def _sleep_or_stop(
    stop_event: asyncio.Event,
    timeout: float,
    sleep_fn: SleepFn,
) -> None:
    if sleep_fn is not asyncio.sleep:
        await sleep_fn(timeout)
        return
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        pass


async def run_report_mail_loop(
    *,
    services: ReportMailServices,
    poll_sec: float | None = None,
    once: bool = False,
    max_loops: int | None = None,
    stop_event: asyncio.Event | None = None,
    plan_runner: PlanRunner | None = None,
    sleep_fn: SleepFn = asyncio.sleep,
) -> dict[str, Any]:
    """Poll the reported queue forever, or for one bounded test/CLI pass."""
    poll = poll_sec if poll_sec is not None and poll_sec > 0 else _poll_seconds()
    stop = stop_event or asyncio.Event()
    runner = plan_runner or (lambda cancel_event: run_report_mail_plan(cancel_event, services))
    loops = passes = errors = 0
    last: dict[str, Any] | None = None

    while not stop.is_set():
        loops += 1
        try:
            services.store.reclaim_stale_mail_threads()
            flag = services.store.control_flag_get(COMPONENT)
            run_now = services.store.control_flag_consume_run_now(COMPONENT)
            enabled = bool(int(flag.get("enabled", 1)))
            if not enabled and not run_now:
                _heartbeat(services, "disabled", "control flag disabled")
            else:
                queued = services.store.reported_host_count()
                if queued <= 0:
                    _heartbeat(services, "idle", "reported queue empty")
                else:
                    _heartbeat(services, ACTIVE_PHASE, f"reported hosts={queued}")
                    last = await runner(stop)
                    passes += 1
                    remaining = services.store.reported_host_count()
                    phase = "idle" if remaining <= 0 else ACTIVE_PHASE
                    _heartbeat(
                        services,
                        phase,
                        (
                            f"last {last.get('status', 'ok')} "
                            f"claimed={last.get('claimed', 0)} "
                            f"remaining={remaining}"
                        ),
                    )
        except Exception as e:  # noqa: BLE001
            errors += 1
            log.exception("[mail-loop] tick failed")
            with suppress(Exception):
                _heartbeat(services, "error", repr(e)[:500])
            if once:
                raise

        if once or (max_loops is not None and loops >= max_loops):
            break
        await _sleep_or_stop(stop, poll, sleep_fn)

    return {"loops": loops, "passes": passes, "errors": errors, "last": last}
