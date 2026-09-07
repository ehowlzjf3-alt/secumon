"""Persistent GitHub E2E pipeline runner.

Consumes GitHub-only control_flag rows and executes discovery, scan, report,
and recheck passes. This is separate from the SMB 8767 runner/control plane.
"""
from __future__ import annotations

import argparse
import logging
import os
import signal
import time
from collections.abc import Callable
from typing import Any

from domains.services.github.application.contracts import (
    COMPONENT_GITHUB_DISCOVERY,
    COMPONENT_GITHUB_OWNER,
    COMPONENT_GITHUB_SCAN,
)
from service import state_domain as state
from service.agents.github_discovery_agent import (
    run_discovery_pass,
)
from service.agents.github_scan_agent import run_scan_pass
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.github_pipeline_runner")

DEFAULT_POLL_SECONDS = 60.0
DEFAULT_INTERVALS = {
    COMPONENT_GITHUB_DISCOVERY: 86400.0,
    COMPONENT_GITHUB_SCAN: 300.0,
    # 담당자 해석은 조직 저장소마다 브라우저를 여는 비싼 일이고, 새 저장소가 생겨야만
    # 할 일이 있다. 30분이면 보고보다 먼저 담당자가 채워진다.
    COMPONENT_GITHUB_OWNER: 1800.0,
}


def _float_env(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _latest_run_age(component: str) -> float | None:
    rows = state.pipeline_runs_recent(component, limit=1)
    if not rows:
        return None
    row = rows[0]
    ts = row.get("finished_at") or row.get("started_at")
    if not ts:
        return None
    return max(0.0, time.time() - float(ts))


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


def _should_run(component: str) -> tuple[bool, dict[str, Any]]:
    flag = state.control_flag_get(component)
    run_now = state.control_flag_consume_run_now(component)
    enabled = bool(int(flag.get("enabled", 1)))
    if run_now:
        return True, flag
    if not enabled:
        state.heartbeat_upsert(component, phase="disabled", detail="control flag disabled", pid=os.getpid())
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


# ── 플랜 패스 진입점은 은퇴했다 (2026-08-28) ──────────────────────────────
# `_run_plan_pass`(+`_cap_single_phase_plan`)의 유일한 호출부가 sso_task 스텝이었다.
# github 의 나머지 스텝(discovery·scan·report·recheck)은 각자 전용 패스를 부른다.
# 되찾으려면 태그 `flat-lane-last`. confluence 쪽 동명 함수는 살아 있다 —
# 거기서는 sso_task 레인이 은퇴 대상이 아니다.


def _run_if_due(component: str, fn: Callable[[], dict[str, Any]]) -> dict[str, Any] | None:
    should, _flag = _should_run(component)
    if not should:
        return None
    log.info("[github-runner] running %s", component)
    return fn()


def _run_owner_pass(*, org_limit: int | None = None) -> dict[str, Any]:
    """담당자 해석 패스 — **지연 import** 로 부른다.

    ⚠️ 모듈 최상단에서 `github_owner` 를 import 하면 그 체인이 knox/mcp 를 끌어오고,
       테스트가 `control_flag_set` 으로 쓴 값과 러너가 읽는 값이 갈린다(플래그를 껐는데
       전 스텝이 다 도는 형태로 나타난다 — 2026-08-30 실측). 이 저장소가 반복해서 당한
       "계약 호출이 부트스트랩을 끌어온다" 와 같은 계열이다.
    """
    from service.services.github_owner import run_owner_pass

    return run_owner_pass(org_limit=org_limit)


def run_once() -> dict[str, Any]:
    """Run due GitHub components once in pipeline order."""
    load_runtime_env(load_plugins=True)
    out: dict[str, Any] = {}
    steps: tuple[tuple[str, Callable[[], dict[str, Any]]], ...] = (
        (COMPONENT_GITHUB_DISCOVERY, lambda: run_discovery_pass(
            max_repos=_optional_int_env("GITHUB_DISCOVERY_MAX_REPOS"),
        )),
        (COMPONENT_GITHUB_SCAN, lambda: run_scan_pass(
            max_repos=_optional_int_env("GITHUB_SCAN_MAX_REPOS_PER_TICK"),
        )),
        # ★ 보고보다 **먼저** 담당자를 채운다 — 스레드가 만들어질 때 수신처가 있어야
        #   `owner_recipient` 가 그 스레드에 실린다. 순서가 바뀌면 한 주기 늦는다.
        (COMPONENT_GITHUB_OWNER, lambda: _run_owner_pass(
            org_limit=_optional_int_env("GITHUB_OWNER_ORG_LIMIT_PER_TICK"),
        )),
        # ★ sso_task 스텝은 지웠다 (2026-08-28). `devops_target(service='github')`
        #   큐의 시작점은 `github.lead` 이고, 리드는 자기 러너가 돈다 — 이 파이프라인이
        #   아니다. 플랜 자체도 등록하지 않으므로 여기서 부르면 "plan not registered".
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
            log.exception("[github-runner] %s failed", component)
            state.heartbeat_upsert(component, phase="error", detail=repr(e)[:500], pid=os.getpid())
            out[component] = {"error": repr(e)[:500]}
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Persistent GitHub E2E pipeline runner")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--poll-sec", type=float, default=None)
    parser.add_argument("--max-loops", type=int, default=None)
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=os.environ.get("GITHUB_AGENT_LOG_LEVEL", "INFO"),
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
        "GITHUB_PIPELINE_POLL_SECONDS",
        DEFAULT_POLL_SECONDS,
    )
    while not stop:
        loops += 1
        result = run_once()
        log.info("[github-runner] tick %s", result)
        if args.once or (args.max_loops is not None and loops >= args.max_loops):
            break
        time.sleep(poll)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
