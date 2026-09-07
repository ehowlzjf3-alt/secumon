from __future__ import annotations

import asyncio
from typing import Any

from domains.smb.application.contracts import COMPONENT_REVERIFY, PHASE_REVERIFY
from service.agents import reply_verify_loop


def _patch_state(monkeypatch, *, enabled: int = 1, run_now: bool = False) -> list[dict[str, Any]]:
    heartbeats: list[dict[str, Any]] = []
    run_now_values = [run_now]

    monkeypatch.setattr(
        reply_verify_loop.state,
        "control_flag_get",
        lambda component: {"component": component, "enabled": enabled},
    )
    monkeypatch.setattr(
        reply_verify_loop.state,
        "control_flag_consume_run_now",
        lambda component: run_now_values.pop(0) if run_now_values else False,
    )
    monkeypatch.setattr(
        reply_verify_loop.state,
        "heartbeat_upsert",
        lambda component, **kwargs: heartbeats.append({"component": component, **kwargs}),
    )
    return heartbeats


def test_reply_verify_loop_polls_pop3_on_each_enabled_tick(monkeypatch) -> None:
    heartbeats = _patch_state(monkeypatch)
    calls: list[dict[str, Any]] = []

    async def fake_runner(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"handled": 0, "inbox": {"polled": 1, "stored": 0}}

    result = asyncio.run(
        reply_verify_loop.run_reply_verify_loop(
            once=True,
            max_threads=4,
            charter_ref="SECOPS-TEST",
            poll_pop3=True,
            pass_runner=fake_runner,
        ),
    )

    assert result["passes"] == 1
    assert result["errors"] == 0
    assert calls == [{
        "max_threads": 4,
        "charter_ref": "SECOPS-TEST",
        "poll_pop3": True,
    }]
    assert heartbeats[-1]["component"] == COMPONENT_REVERIFY
    assert heartbeats[-1]["phase"] == "idle"
    assert "handled=0" in heartbeats[-1]["detail"]
    assert "polled" in heartbeats[-1]["detail"]


def test_reply_verify_loop_marks_active_when_threads_are_handled(monkeypatch) -> None:
    heartbeats = _patch_state(monkeypatch)

    async def fake_runner(**kwargs: Any) -> dict[str, Any]:
        return {"handled": 2, "inbox": {"polled": 3, "stored": 2}}

    result = asyncio.run(
        reply_verify_loop.run_reply_verify_loop(
            once=True,
            pass_runner=fake_runner,
        ),
    )

    assert result["passes"] == 1
    assert heartbeats[-1]["phase"] == PHASE_REVERIFY
    assert "handled=2" in heartbeats[-1]["detail"]


def test_reply_verify_loop_respects_disabled_control_flag(monkeypatch) -> None:
    heartbeats = _patch_state(monkeypatch, enabled=0)

    async def fail_runner(**kwargs: Any) -> dict[str, Any]:
        raise AssertionError("reply pass should not run while disabled")

    result = asyncio.run(
        reply_verify_loop.run_reply_verify_loop(
            once=True,
            pass_runner=fail_runner,
        ),
    )

    assert result["passes"] == 0
    assert result["errors"] == 0
    assert heartbeats == [{
        "component": COMPONENT_REVERIFY,
        "phase": "disabled",
        "detail": "control flag disabled",
        "pid": heartbeats[0]["pid"],
    }]


def test_reply_verify_loop_run_now_bypasses_disabled_control_flag(monkeypatch) -> None:
    heartbeats = _patch_state(monkeypatch, enabled=0, run_now=True)
    calls: list[dict[str, Any]] = []

    async def fake_runner(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"handled": 0, "inbox": {"polled": 1}}

    result = asyncio.run(
        reply_verify_loop.run_reply_verify_loop(
            once=True,
            pass_runner=fake_runner,
        ),
    )

    assert result["passes"] == 1
    assert calls
    assert heartbeats[-1]["phase"] == "idle"


def test_reply_verify_loop_repeats_until_max_loops(monkeypatch) -> None:
    _patch_state(monkeypatch)
    calls = 0
    sleeps: list[float] = []

    async def fake_runner(**kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return {"handled": 0, "inbox": {"polled": calls}}

    async def fake_sleep(timeout: float) -> None:
        sleeps.append(timeout)

    result = asyncio.run(
        reply_verify_loop.run_reply_verify_loop(
            poll_sec=0.25,
            max_loops=2,
            pass_runner=fake_runner,
            sleep_fn=fake_sleep,
        ),
    )

    assert result["loops"] == 2
    assert result["passes"] == 2
    assert calls == 2
    assert sleeps == [0.25]
