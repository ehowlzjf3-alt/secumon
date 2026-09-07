"""Ports required by dev_web application use cases."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any, Protocol


class SplunkSearchPort(Protocol):
    def search(self, spl: str, *, max_results: int) -> list[dict[str, Any]]:
        """Run a Splunk SPL search and return result rows."""


class DevWebDiscoveryStorePort(Protocol):
    def dev_web_target_upsert(
        self,
        url: str,
        *,
        source: str,
        day_bucket: str,
        event_count: int = 0,
        priority_score: int = 0,
        domain: str | None = None,
        cycle_key: str | None = None,
    ) -> int:
        """Insert or update one dev_web target."""

    def dev_web_targets_summary(self, *, day_bucket: str | None = None) -> dict[str, int]:
        """Return target queue counts."""

    def control_flag_get(self, component: str) -> dict[str, Any]:
        """Return component control flag."""

    def control_flag_consume_run_now(self, component: str) -> bool:
        """Consume one-shot run request."""

    def heartbeat_upsert(
        self,
        component: str,
        *,
        phase: str,
        detail: str | None = None,
        pid: int | None = None,
    ) -> None:
        """Record liveness for an application component."""

    def pipeline_run_start(self, component: str) -> int:
        """Open a pipeline run row."""

    def pipeline_run_finish(self, run_id: int, *, status: str, detail: str) -> None:
        """Close a pipeline run row."""


class WorkerRuntimePort(Protocol):
    def make_evidence_dir(self, label: str) -> Path:
        """Create and return an evidence directory for one worker target."""

    def worker_env(self) -> dict[str, str]:
        """Return environment variables used by worker subprocesses."""


class QualityTelemetryPort(Protocol):
    """워커 품질 텔레메트리 (#1 눈, skill_quality) — 구현은 plugin 컴포지션 루트가 주입.

    spec_env: attempt_id 생성·started 기록 후 worker env 반환. observe: completion
    (valid/invalid 모두)을 parent_observed 로 기록. 둘 다 best-effort.
    """

    def spec_env(self, base_env, *, worker_type: str, component: str) -> dict[str, str]:
        ...

    def observe(self, completion, *, worker_type: str, component: str) -> None:
        ...


class DevWebFanoutStorePort(Protocol):
    def claim_report_thread(
        self,
        *,
        session_id: int,
        status: str,
    ) -> dict[str, Any] | None:
        """Claim one report/reverify thread in the requested status."""

    def set_report_thread_status(
        self,
        thread_id: int,
        status: str,
        *,
        retry_after: float | None = None,
        last_reason: str | None = None,
    ) -> None:
        """Set a report thread back to a retryable status."""


class DevWebLoopStorePort(Protocol):
    def reclaim_stale_report_threads(self) -> int:
        """Release stale claimed report threads."""

    def control_flag_get(self, component: str) -> dict[str, Any]:
        """Return component control flag."""

    def control_flag_consume_run_now(self, component: str) -> bool:
        """Consume one-shot run request."""

    def reported_target_count(self) -> int:
        """Return report threads ready for report fanout."""

    def heartbeat_upsert(
        self,
        component: str,
        *,
        phase: str,
        detail: str | None = None,
        pid: int | None = None,
    ) -> None:
        """Record liveness for an application component."""

    def pipeline_run_start(self, component: str) -> int:
        """Open a pipeline run row."""

    def pipeline_run_finish(self, run_id: int, *, status: str, detail: str) -> None:
        """Close a pipeline run row."""


class CorePlanGatewayPort(Protocol):
    def ensure_plan_loaded(self, plan_name: str) -> Any:
        """Load plugins and return a registered core task plan."""

    def run_plan_events(
        self,
        plan: Any,
        *,
        cancel_event: asyncio.Event,
    ) -> AsyncIterator[Any]:
        """Run a core task plan and yield events."""


class PipelineProjectionStorePort(Protocol):
    dev_web_claim_stale_seconds: float
    dev_web_rescan_seconds: float

    def connect(self) -> AbstractContextManager[Any]:
        """Open a DB connection/context manager."""

    def current_cycle_key(self) -> str:
        """Return the current weekly cycle key."""

    def control_flag_get(self, component: str) -> dict[str, Any]:
        """Return component control flag."""

    def pipeline_runs_recent(self, component: str, *, limit: int) -> list[dict[str, Any]]:
        """Return recent pipeline run summaries."""
