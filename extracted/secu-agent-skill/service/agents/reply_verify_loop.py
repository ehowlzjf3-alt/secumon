"""Persistent SMB reply/reverify runner.

`reply_verify_agent` is the unit of work: one POP3 poll plus one bounded
reply_received queue drain. This wrapper keeps invoking it so inbound replies
are collected periodically and the reverify heartbeat stays live.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import suppress
import logging
import os
import signal
from typing import Any, Awaitable, Callable

from domains.smb.application.contracts import COMPONENT_REVERIFY, PHASE_REVERIFY
from service import state_domain as state
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.reply_verify_loop")

DEFAULT_POLL_SECONDS = 60.0

PassRunner = Callable[..., Awaitable[dict[str, Any]]]
SleepFn = Callable[[float], Awaitable[Any]]


def _poll_seconds() -> float:
    raw = (os.environ.get("SMB_REPLY_VERIFY_POLL_SECONDS") or "").strip()
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_POLL_SECONDS
    return value if value > 0 else DEFAULT_POLL_SECONDS


def _install_signal_handlers(stop: asyncio.Event) -> None:
    def _sig() -> None:
        stop.set()

    try:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, _sig)
    except (NotImplementedError, RuntimeError):
        pass


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


def _heartbeat(phase: str, detail: str | None = None) -> None:
    state.heartbeat_upsert(COMPONENT_REVERIFY, phase=phase, detail=detail, pid=os.getpid())


async def run_reply_verify_loop(
    *,
    poll_sec: float | None = None,
    once: bool = False,
    max_loops: int | None = None,
    max_threads: int | None = None,
    charter_ref: str = "",
    poll_pop3: bool = True,
    stop_event: asyncio.Event | None = None,
    pass_runner: PassRunner | None = None,
    sleep_fn: SleepFn = asyncio.sleep,
) -> dict[str, Any]:
    """Run POP3 reply collection and reverify passes continuously."""
    from service.agents import reply_verify_agent

    poll = poll_sec if poll_sec is not None and poll_sec > 0 else _poll_seconds()
    stop = stop_event or asyncio.Event()
    runner = pass_runner or reply_verify_agent.run_reply_pass
    loops = passes = errors = 0
    last: dict[str, Any] | None = None

    while not stop.is_set():
        loops += 1
        try:
            flag = state.control_flag_get(COMPONENT_REVERIFY)
            run_now = state.control_flag_consume_run_now(COMPONENT_REVERIFY)
            enabled = bool(int(flag.get("enabled", 1)))
            if not enabled and not run_now:
                _heartbeat("disabled", "control flag disabled")
            else:
                last = await runner(
                    max_threads=max_threads,
                    charter_ref=charter_ref,
                    poll_pop3=poll_pop3,
                )
                passes += 1
                handled = int(last.get("handled") or 0)
                inbox = last.get("inbox") or {}
                detail = f"handled={handled} inbox={inbox}"
                _heartbeat("idle" if handled <= 0 else PHASE_REVERIFY, detail[:500])
        except Exception as e:  # noqa: BLE001
            errors += 1
            log.exception("[reply-loop] tick failed")
            with suppress(Exception):
                _heartbeat("error", repr(e)[:500])
            if once:
                raise

        if once or (max_loops is not None and loops >= max_loops):
            break
        await _sleep_or_stop(stop, poll, sleep_fn)

    return {"loops": loops, "passes": passes, "errors": errors, "last": last}


async def _main_async(args: argparse.Namespace) -> dict[str, Any]:
    load_runtime_env(load_plugins=True)
    stop = asyncio.Event()
    _install_signal_handlers(stop)
    return await run_reply_verify_loop(
        poll_sec=args.poll_sec,
        once=args.once,
        max_loops=args.max_loops,
        max_threads=args.max_threads,
        charter_ref=args.charter,
        poll_pop3=not args.no_pop3,
        stop_event=stop,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Persistent SMB reply/reverify POP3 runner")
    parser.add_argument("--once", action="store_true", help="run one poll tick and exit")
    parser.add_argument("--poll-sec", type=float, default=None)
    parser.add_argument("--max-loops", type=int, default=None, help="test/debug bound")
    parser.add_argument("--max-threads", type=int, default=None)
    parser.add_argument("--no-pop3", action="store_true", help="POP3 poll 생략(큐만 처리)")
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
    log.info("[reply-loop] stopped %s", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
