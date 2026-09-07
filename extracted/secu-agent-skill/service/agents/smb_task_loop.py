"""은퇴한 SMB 평면 태스크 레인의 러너 — heartbeat 만 낸다.

원래 이 루프는 `smb_task_agent.run_task_pass` 를 반복 호출해 walked share 큐를
직접 소비했다. 2026-08-28 에 그 레인은 은퇴했다: 큐의 시작점은 이제 `smb.lead` 이고,
리드가 share 하나당 검토원 하나를 띄운다(`open_inspection`/`ask_inspector`).

그래도 이 러너는 **살려 둔다**. 두 가지 때문이다:

  1. k8s Deployment 와 `tests/test_k8s_manifests.py` 가
     `domains.smb.runners.task` → `callable(module.main)` 을 단언한다.
  2. 조용히 멈추면 콘솔에서 러너가 죽은 것처럼 보인다. 폴링마다
     `retired_flat_pass` 가 heartbeat 를 `phase="disabled"` 로 갱신해
     **살아 있으면서 큐를 리드에게 넘겼다**는 사실을 콘솔에 싣는다.

⚠️ `control_flag` 를 읽지 않는다. `control_flag_get` 은 행이 없으면 `enabled=1` 로
   **만들어서** 돌려주므로, 은퇴 가드가 그걸 부르면 지운 레인을 되살리는 부작용이 난다.
   은퇴 판정의 근거는 `lead_agent._RETIRED_FLAT` 하나다.

되찾으려면 태그 `flat-lane-last`.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
from typing import Any

from domains.smb.application.contracts import COMPONENT_TASK
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.smb_task_loop")

DEFAULT_POLL_SECONDS = 60.0


def _poll_seconds() -> float:
    raw = os.environ.get("SMB_TASK_POLL_SEC", "")
    try:
        value = float(raw)
        if value > 0:
            return value
    except ValueError:
        pass
    return DEFAULT_POLL_SECONDS


def _install_signal_handlers(stop: asyncio.Event) -> None:
    def _sig() -> None:
        stop.set()

    try:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, _sig)
    except (NotImplementedError, RuntimeError):
        pass


async def _sleep_or_stop(stop: asyncio.Event, timeout: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        pass


async def run_task_loop(
    *,
    poll_sec: float | None = None,
    once: bool = False,
    max_loops: int | None = None,
    max_hosts: int | None = None,
    charter_ref: str = "",
    stop_event: asyncio.Event | None = None,
) -> dict[str, Any]:
    """은퇴 사실을 폴링마다 heartbeat 에 싣는다. 아무 share 도 claim 하지 않는다.

    `max_hosts`/`charter_ref` 는 호출부(러너 CLI·k8s args)를 안 건드리려고 남긴
    빈 인자다 — 소비할 큐가 없으니 쓰이지 않는다.
    """
    del max_hosts, charter_ref
    from service.agents.lead_agent import retired_flat_pass

    poll = poll_sec if poll_sec is not None and poll_sec > 0 else _poll_seconds()
    stop = stop_event or asyncio.Event()
    loops = errors = 0
    last: dict[str, Any] | None = None

    while not stop.is_set():
        loops += 1
        try:
            last = retired_flat_pass(COMPONENT_TASK)
        except Exception as e:  # noqa: BLE001
            errors += 1
            log.exception("[task-loop] tick failed")
            if once:
                raise
            del e

        if once or (max_loops is not None and loops >= max_loops):
            break
        await _sleep_or_stop(stop, poll)

    return {"loops": loops, "passes": loops - errors, "errors": errors, "last": last}


async def _main_async(args: argparse.Namespace) -> dict[str, Any]:
    # 은퇴한 레인이라 플러그인 레지스트리가 필요 없다 — 부팅 비용만 든다.
    load_runtime_env(load_plugins=False)
    stop = asyncio.Event()
    _install_signal_handlers(stop)
    return await run_task_loop(
        poll_sec=args.poll_sec,
        once=args.once,
        max_loops=args.max_loops,
        max_hosts=args.max_hosts,
        charter_ref=args.charter,
        stop_event=stop,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Retired SMB flat-lane runner")
    parser.add_argument("--once", action="store_true", help="run one poll tick and exit")
    parser.add_argument("--poll-sec", type=float, default=None)
    parser.add_argument("--max-loops", type=int, default=None, help="test/debug bound")
    parser.add_argument("--max-hosts", type=int, default=None, help="은퇴 — 무시된다")
    parser.add_argument(
        "--charter",
        default=os.environ.get("DEFAULT_CHARTER_REF", "SECOPS-2026-001"),
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=os.environ.get("SMB_AGENT_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    result = asyncio.run(_main_async(args))
    log.info("[task-loop] stopped %s", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
