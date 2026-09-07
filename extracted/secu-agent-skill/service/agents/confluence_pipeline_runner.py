"""Persistent Confluence E2E pipeline runner.

Consumes Confluence-only control_flag rows and executes space discovery, SSO URL
discovery, API space task, SSO URL task, report, and recheck passes. This
mirrors the GitHub runner while keeping Confluence API/SSO fanout in the domain
plugin.
"""
from __future__ import annotations

import argparse
from dataclasses import replace
import logging
import os
import signal
import time
from collections.abc import Callable
from typing import Any

from domains.services.confluence.application.contracts import (
    COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
    COMPONENT_CONFLUENCE_SSO_DISCOVERY,
    COMPONENT_CONFLUENCE_SSO_TASK,
    CONFLUENCE_SSO_TASK_PLAN,
)
from service import state_domain as state
from service.agents.confluence_discovery_agent import (
    run_search_keyword_sync,
    run_space_discovery_pass,
    run_sso_discovery_pass,
)
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.confluence_pipeline_runner")

DEFAULT_POLL_SECONDS = 60.0
DEFAULT_INTERVALS = {
    COMPONENT_CONFLUENCE_SPACE_DISCOVERY: 86400.0,
    COMPONENT_CONFLUENCE_SSO_DISCOVERY: 86400.0,
    COMPONENT_CONFLUENCE_SSO_TASK: 300.0,
}


def _float_env(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _optional_int_env(name: str) -> int | None:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def _optional_str_env(name: str) -> str | None:
    raw = (os.environ.get(name) or "").strip()
    return raw or None


def _latest_run_age(component: str) -> float | None:
    rows = state.pipeline_runs_recent(component, limit=1)
    if not rows:
        return None
    row = rows[0]
    ts = row.get("finished_at") or row.get("started_at")
    if not ts:
        return None
    return max(0.0, time.time() - float(ts))


def _should_run(component: str) -> tuple[bool, dict[str, Any]]:
    flag = state.control_flag_get(component)
    run_now = state.control_flag_consume_run_now(component)
    enabled = bool(int(flag.get("enabled", 1)))
    if run_now:
        return True, flag
    if not enabled:
        state.heartbeat_upsert(
            component,
            phase="disabled",
            detail="control flag disabled",
            pid=os.getpid(),
        )
        return False, flag
    interval = float(flag.get("interval_seconds") or DEFAULT_INTERVALS[component])
    age = _latest_run_age(component)
    if age is None or age >= interval:
        return True, flag
    state.heartbeat_upsert(
        component,
        phase="idle",
        detail=f"next due in {round(interval - age, 1)}s",
        pid=os.getpid(),
    )
    return False, flag


def _cap_single_phase_plan(plan: Any, max_targets: int | None) -> Any:
    if max_targets is None:
        return plan
    phases = tuple(replace(phase, max_targets=max_targets) for phase in plan.phases)
    return replace(plan, phases=phases)


def _run_plan_pass(
    *,
    component: str,
    plan_name: str,
    max_targets: int | None = None,
) -> dict[str, Any]:
    import asyncio

    from secu_agent.agent.events import (
        PhaseAborted,
        PhaseCompleted,
        PhaseStarted,
        PlanCompleted,
        WorkerCompleted,
    )
    from secu_agent.agent.task_plan import get_task_plan, run_plan

    # ★ 평면 태스크 레인은 은퇴했다 — 태스크 큐의 시작점은 리드다(2026-08-26 결정).
    #   `_run_plan_pass` 는 태스크·SSO 계열이 공유하는 진입점이라 여기 한 곳이면 된다.
    #   은퇴 대상이 아닌 컴포넌트(report/recheck 등)는 None 이 나와 그대로 진행한다.
    from service.agents.lead_agent import retired_flat_pass

    retired = retired_flat_pass(component)
    if retired is not None:
        return retired

    plan = get_task_plan(plan_name)
    if plan is None:
        raise LookupError(f"Confluence task plan not registered: {plan_name!r}")
    plan = _cap_single_phase_plan(plan, max_targets)
    run_id = state.pipeline_run_start(component)
    status = "ok"
    detail = "no completion"
    claimed = succeeded = failed = findings = 0

    async def _go() -> None:
        nonlocal claimed, succeeded, failed, findings, status, detail
        async for ev in run_plan(plan):
            if isinstance(ev, PhaseStarted):
                state.heartbeat_upsert(
                    component,
                    phase=ev.phase,
                    detail=f"{ev.adapter} k={ev.k}",
                    pid=os.getpid(),
                )
            elif isinstance(ev, WorkerCompleted):
                state.heartbeat_upsert(
                    component,
                    phase="task",
                    detail=f"{ev.label}: {ev.status}",
                    pid=os.getpid(),
                )
            elif isinstance(ev, PhaseCompleted):
                report = ev.report
                claimed = int(getattr(report, "claimed", 0) or 0)
                succeeded = int(getattr(report, "succeeded", 0) or 0)
                failed = int(getattr(report, "failed", 0) or 0)
                findings = int(getattr(report, "findings_count", 0) or 0)
                detail = (
                    f"phase={ev.phase} claimed={claimed} ok={succeeded} "
                    f"fail={failed} findings={findings}"
                )
            elif isinstance(ev, PhaseAborted):
                status = "error"
                detail = ev.reason[:500]
                state.heartbeat_upsert(component, phase="error", detail=detail, pid=os.getpid())
            elif isinstance(ev, PlanCompleted):
                result = ev.result
                claimed = int(getattr(result, "total_claimed", 0) or 0)
                succeeded = int(getattr(result, "total_succeeded", 0) or 0)
                failed = int(getattr(result, "total_failed", 0) or 0)
                findings = int(getattr(result, "total_findings", 0) or 0)
                status = "cancelled" if ev.cancelled else ("error" if ev.aborted else "ok")
                detail = (
                    f"reason={ev.reason} claimed={claimed} ok={succeeded} "
                    f"fail={failed} findings={findings}"
                )

    try:
        asyncio.run(_go())
        return {
            "claimed": claimed,
            "succeeded": succeeded,
            "failed": failed,
            "findings": findings,
            "status": status,
            "detail": detail,
        }
    except Exception as e:  # noqa: BLE001
        status = "error"
        detail = repr(e)[:500]
        state.heartbeat_upsert(component, phase="error", detail=detail, pid=os.getpid())
        raise
    finally:
        state.pipeline_run_finish(run_id, status=status, detail=detail)


def _seed_search_keywords() -> None:
    """키워드 허용목록 → `confluence_search_target` 큐 시드 (멱등, ~15 upsert).

    ★ **이게 이 큐의 유일한 자동 생산자다.** `confluence_search_target_upsert` 의 비-테스트
      호출부는 `run_search_keyword_sync` 하나뿐이고, 그걸 자동으로 부르는 곳은 여기뿐이다
      (`confluence_discovery_agent --search-sync` 는 수동 CLI 다). space/sso 와 달리 search
      에는 전용 discovery 컴포넌트가 없다 — 원래 설계가 "별도 discovery 스텝 없이 레인 머리에서
      시드해서 fresh 배포가 결코 inert 하지 않게" 였다.

    ⚠️ 그래서 **평면 search_task 레인과 함께 지우면 안 된다.** 시드가 끊기면 큐가 안 채워지고,
       그 큐를 보는 `confluence_search.lead` 가 영원히 idle 이 된다. 레인은 은퇴했지만 시드는
       살아 있어야 한다 — 그래서 space discovery 스텝 머리로 옮겼다(2026-08-28).

    옮긴 자리의 뜻: space discovery 는 confluence 의 **공급** 단계다. 그게 꺼져 있으면
    confluence 공급 전체를 끈 것이므로 키워드 시드가 함께 멈추는 것이 앞뒤가 맞는다.
    주기도 300s → 86,400s 로 내려간다 — curated 허용목록에 300초 재시드는 낭비였다
    (은퇴 직전 24h 255런).
    """
    try:
        result = run_search_keyword_sync()
        log.info("[confluence-runner] search keyword sync %s", result)
    except Exception as e:  # noqa: BLE001 — 시드 실패는 뒤따르는 space discovery 를 막지 않음
        log.warning("[confluence-runner] search keyword sync failed: %r", e)


def _run_space_discovery_pass(**kwargs: Any) -> dict[str, Any]:
    """space discovery + 키워드 시드. 시드는 best-effort 라 discovery 결과를 바꾸지 않는다."""
    _seed_search_keywords()
    return run_space_discovery_pass(**kwargs)


def _run_if_due(component: str, fn: Callable[[], dict[str, Any]]) -> dict[str, Any] | None:
    should, _flag = _should_run(component)
    if not should:
        return None
    log.info("[confluence-runner] running %s", component)
    return fn()


def run_once() -> dict[str, Any]:
    """Run due Confluence components once in pipeline order."""
    load_runtime_env(load_plugins=True)
    out: dict[str, Any] = {}
    steps: tuple[tuple[str, Callable[[], dict[str, Any]]], ...] = (
        (COMPONENT_CONFLUENCE_SPACE_DISCOVERY, lambda: _run_space_discovery_pass(
            max_spaces=_optional_int_env("CONFLUENCE_SPACE_DISCOVERY_MAX_SPACES"),
            space_type=_optional_str_env("CONFLUENCE_SPACE_DISCOVERY_TYPE"),
        )),
        # ★ space_task·search_task 스텝은 지웠다 (2026-08-28). 두 큐의 시작점은
        #   `confluence.lead`·`confluence_search.lead` 이고, 리드는 자기 러너가 돈다.
        #   ⚠️ 키워드 시드는 search 스텝 머리에 있었지만 위 space discovery 로 옮겼다 —
        #      `confluence_search_target` 의 유일한 자동 생산자다(094c113).
        (COMPONENT_CONFLUENCE_SSO_DISCOVERY, lambda: run_sso_discovery_pass(
            earliest=_optional_str_env("CONFLUENCE_SSO_DISCOVERY_EARLIEST"),
            latest=_optional_str_env("CONFLUENCE_SSO_DISCOVERY_LATEST"),
            day_bucket=_optional_str_env("CONFLUENCE_SSO_DISCOVERY_DAY_BUCKET"),
            max_urls=_optional_int_env("CONFLUENCE_SSO_DISCOVERY_MAX_URLS"),
        )),
        (COMPONENT_CONFLUENCE_SSO_TASK, lambda: _run_plan_pass(
            component=COMPONENT_CONFLUENCE_SSO_TASK,
            plan_name=CONFLUENCE_SSO_TASK_PLAN,
            max_targets=_optional_int_env("CONFLUENCE_SSO_MAX_TARGETS_PER_TICK"),
        )),
        # ★ report·recheck 스텝은 지웠다 (2026-08-31). 메일 큐는 4도메인 **공용 러너**가
        #   돈다 — `service/agents/thread_pipeline_runner.py` (ThreadAdapter 계약 기반).
        #   여기 남겨 두면 같은 컴포넌트를 둘이 돌리고, 주기 판정이 서로를 앞지른다.
        #
        #   이 러너에 남는 것은 **이 도메인에만 있는 일**뿐이다(발견·스캔·담당자 해석 등).
    )
    for component, fn in steps:
        try:
            result = _run_if_due(component, fn)
            if result is not None:
                out[component] = result
        except Exception as e:  # noqa: BLE001
            log.exception("[confluence-runner] %s failed", component)
            state.heartbeat_upsert(component, phase="error", detail=repr(e)[:500], pid=os.getpid())
            out[component] = {"error": repr(e)[:500]}
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Persistent Confluence E2E pipeline runner")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--poll-sec", type=float, default=None)
    parser.add_argument("--max-loops", type=int, default=None)
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=os.environ.get("CONFLUENCE_AGENT_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    stop = False

    def _stop(_signum, _frame) -> None:
        nonlocal stop
        stop = True

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _stop)
        except Exception:
            pass

    loops = 0
    poll = args.poll_sec if args.poll_sec and args.poll_sec > 0 else _float_env(
        "CONFLUENCE_PIPELINE_POLL_SECONDS",
        DEFAULT_POLL_SECONDS,
    )
    while not stop:
        loops += 1
        result = run_once()
        log.info("[confluence-runner] tick %s", result)
        if args.once or (args.max_loops is not None and loops >= args.max_loops):
            break
        time.sleep(poll)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
