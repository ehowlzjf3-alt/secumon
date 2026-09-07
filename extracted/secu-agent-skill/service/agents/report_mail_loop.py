"""CLI adapter for the SMB report/mail application runner."""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
from typing import Any

from domains.smb.application.report_mail_runner import ReportMailServices, run_report_mail_loop
from domains.smb.infrastructure.runtime import default_core_plan_gateway, default_state_gateway
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.report_mail_loop")


def _install_signal_handlers(stop: asyncio.Event) -> None:
    def _sig() -> None:
        stop.set()

    try:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, _sig)
    except (NotImplementedError, RuntimeError):
        pass


async def _main_async(args: argparse.Namespace) -> dict[str, Any]:
    load_runtime_env(load_plugins=True)
    stop = asyncio.Event()
    _install_signal_handlers(stop)
    services = ReportMailServices(
        store=default_state_gateway(),
        plan_gateway=default_core_plan_gateway(),
    )
    return await run_report_mail_loop(
        services=services,
        poll_sec=args.poll_sec,
        once=args.once,
        max_loops=args.max_loops,
        stop_event=stop,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Persistent SMB report/mail fanout runner")
    parser.add_argument("--once", action="store_true", help="run one poll tick and exit")
    parser.add_argument("--poll-sec", type=float, default=None)
    parser.add_argument("--max-loops", type=int, default=None, help="test/debug bound")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=os.environ.get("SMB_AGENT_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    result = asyncio.run(_main_async(args))
    log.info("[mail-loop] stopped %s", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
