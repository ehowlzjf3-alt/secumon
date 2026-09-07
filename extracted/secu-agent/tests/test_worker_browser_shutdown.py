"""F5-A: 워커 종료 시 chromium bounded graceful 회수 (orphan/누수 방지).

codex 합심 리뷰 반영 — `_stop_session` 의 await 는 unbounded 라, 응답 없는
chromium 이 워커 종료·worker_result 작성을 무한정 막을 수 있다. `_shutdown_worker_browser`
는 `wait_for` 로 상한을 두고, hang 해도 워커를 막지 않으며 SSO 회로차단기 상태를 보존한다.
"""
from __future__ import annotations

import asyncio
import time

import pytest

from secu_agent.agent.cli import (
    _browser_shutdown_timeout,
    _shutdown_worker_browser,
)
from secu_agent.agent.tools import browser_tool
from secu_agent.agent.tools.browser_tool import _SESSION_STATE, _stop_session


class _HangingPage:
    """close() 가 취소될 때까지 영원히 블록 — 응답 없는 chromium 시뮬레이션."""

    async def close(self) -> None:
        await asyncio.Event().wait()


def _install_hanging_session() -> None:
    asyncio.run(_stop_session())
    _SESSION_STATE["page"] = _HangingPage()
    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["last_used"] = 1000.0


def test_browser_shutdown_timeout_env(monkeypatch):
    monkeypatch.delenv("SA_WORKER_BROWSER_SHUTDOWN_TIMEOUT", raising=False)
    assert _browser_shutdown_timeout() == 5.0
    monkeypatch.setenv("SA_WORKER_BROWSER_SHUTDOWN_TIMEOUT", "2.5")
    assert _browser_shutdown_timeout() == 2.5
    # 무한대 금지: 0/음수/garbage 는 5초 폴백
    monkeypatch.setenv("SA_WORKER_BROWSER_SHUTDOWN_TIMEOUT", "0")
    assert _browser_shutdown_timeout() == 5.0
    monkeypatch.setenv("SA_WORKER_BROWSER_SHUTDOWN_TIMEOUT", "-3")
    assert _browser_shutdown_timeout() == 5.0
    monkeypatch.setenv("SA_WORKER_BROWSER_SHUTDOWN_TIMEOUT", "garbage")
    assert _browser_shutdown_timeout() == 5.0


def test_shutdown_worker_browser_noop_when_not_running(monkeypatch):
    # 브라우저를 켠 적 없는 워커 — 안전한 no-op, 즉시 반환, 예외 없음.
    asyncio.run(_stop_session())
    monkeypatch.setenv("SA_WORKER_BROWSER_SHUTDOWN_TIMEOUT", "5")
    t0 = time.monotonic()
    asyncio.run(_shutdown_worker_browser())
    assert time.monotonic() - t0 < 1.0
    assert not browser_tool._is_running()


def test_shutdown_worker_browser_bounded_on_hang(monkeypatch):
    # 응답 없는 chromium(page.close 가 hang) — helper 는 timeout 안에 반환하고
    # 워커를 막지 않는다. (unbounded 였다면 영원히 hang)
    monkeypatch.setenv("SA_WORKER_BROWSER_SHUTDOWN_TIMEOUT", "0.2")
    _install_hanging_session()
    try:
        t0 = time.monotonic()
        asyncio.run(_shutdown_worker_browser())
        elapsed = time.monotonic() - t0
        # 0.2s timeout — 넉넉히 3s 안에 반환하면 bounded 증명(unbounded=영구 hang)
        assert elapsed < 3.0, f"teardown hung: {elapsed:.1f}s"
    finally:
        asyncio.run(_stop_session())


def test_shutdown_worker_browser_preserves_sso_breaker(monkeypatch):
    # SAFETY-KEEP: browser teardown(timeout 포함)이 SSO 회로차단기를 리셋하면 안 된다
    # (lockout-safe — 브레이커는 프로세스 종료로만 리셋).
    monkeypatch.setenv("SA_WORKER_BROWSER_SHUTDOWN_TIMEOUT", "0.2")
    _install_hanging_session()
    _SESSION_STATE["login_halted"] = True
    _SESSION_STATE["login_fail_streak"] = 3
    try:
        asyncio.run(_shutdown_worker_browser())
        assert _SESSION_STATE["login_halted"] is True
        assert _SESSION_STATE["login_fail_streak"] == 3
    finally:
        _SESSION_STATE["login_halted"] = False
        _SESSION_STATE["login_fail_streak"] = 0
        asyncio.run(_stop_session())


def test_shutdown_worker_browser_swallows_errors(monkeypatch):
    # best-effort: shutdown 이 raise 해도 helper 는 삼키고 워커 종료를 막지 않는다.
    monkeypatch.setenv("SA_WORKER_BROWSER_SHUTDOWN_TIMEOUT", "5")

    async def _boom() -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr(browser_tool, "shutdown_browser", _boom)
    # 예외가 밖으로 새면 워커 finally 가 깨진다 — 반드시 삼켜야 한다.
    asyncio.run(_shutdown_worker_browser())
