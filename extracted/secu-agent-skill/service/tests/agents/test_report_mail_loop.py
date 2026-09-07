from __future__ import annotations

import asyncio
from typing import Any

from domains.smb.application.contracts import PHASE_REPORT_MAIL
from domains.smb.application.report_mail_runner import ReportMailServices
from domains.smb.application import report_mail_runner


class _FakeStore:
    def __init__(
        self,
        *,
        enabled: int = 1,
        counts: list[int] | None = None,
        count_error: Exception | None = None,
    ) -> None:
        self.enabled = enabled
        self.counts = list(counts or [])
        self.count_error = count_error
        self.heartbeats: list[dict[str, Any]] = []

    def reclaim_stale_mail_threads(self) -> int:
        return 0

    def control_flag_get(self, component: str) -> dict[str, Any]:
        return {"component": component, "enabled": self.enabled, "run_now": 0}

    def control_flag_consume_run_now(self, component: str) -> bool:
        return False

    def reported_host_count(self) -> int:
        if self.count_error is not None:
            raise self.count_error
        return self.counts.pop(0) if self.counts else 0

    def heartbeat_upsert(
        self,
        component: str,
        *,
        phase: str,
        detail: str | None = None,
        pid: int | None = None,
    ) -> None:
        self.heartbeats.append({
            "component": component,
            "phase": phase,
            "detail": detail,
            "pid": pid,
        })

    def pipeline_run_start(self, component: str) -> int:
        return 1

    def pipeline_run_finish(self, run_id: int, *, status: str, detail: str) -> None:
        pass


class _UnusedPlanGateway:
    def ensure_plan_loaded(self, plan_name: str) -> Any:
        raise AssertionError("plan gateway should not be used in these tests")

    async def run_plan_events(self, plan: Any, *, cancel_event: asyncio.Event):
        raise AssertionError("plan gateway should not be used in these tests")


def _services(store: _FakeStore) -> ReportMailServices:
    return ReportMailServices(store=store, plan_gateway=_UnusedPlanGateway())


def test_report_mail_loop_runs_fanout_when_reported_queue_exists() -> None:
    store = _FakeStore(counts=[2, 0])
    calls: list[bool] = []

    async def fake_runner(stop_event: asyncio.Event) -> dict[str, Any]:
        calls.append(stop_event.is_set())
        return {"status": "ok", "claimed": 2, "succeeded": 2, "failed": 0}

    result = asyncio.run(
        report_mail_runner.run_report_mail_loop(
            services=_services(store),
            once=True,
            plan_runner=fake_runner,
        ),
    )

    assert calls == [False]
    assert result["passes"] == 1
    assert result["errors"] == 0
    assert [h["phase"] for h in store.heartbeats] == [PHASE_REPORT_MAIL, "idle"]


def test_report_mail_loop_idles_without_reported_queue() -> None:
    store = _FakeStore(counts=[0])

    async def fail_runner(stop_event: asyncio.Event) -> dict[str, Any]:
        raise AssertionError("fanout should not run with an empty queue")

    result = asyncio.run(
        report_mail_runner.run_report_mail_loop(
            services=_services(store),
            once=True,
            plan_runner=fail_runner,
        ),
    )

    assert result["passes"] == 0
    assert [h["phase"] for h in store.heartbeats] == ["idle"]


def test_report_mail_loop_respects_disabled_control_flag() -> None:
    store = _FakeStore(
        enabled=0,
        count_error=AssertionError("queue should not be checked"),
    )

    async def fail_runner(stop_event: asyncio.Event) -> dict[str, Any]:
        raise AssertionError("fanout should not run when disabled")

    result = asyncio.run(
        report_mail_runner.run_report_mail_loop(
            services=_services(store),
            once=True,
            plan_runner=fail_runner,
        ),
    )

    assert result["passes"] == 0
    assert [h["phase"] for h in store.heartbeats] == ["disabled"]
