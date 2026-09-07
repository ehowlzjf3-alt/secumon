"""Ports required by SMB application use cases."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any, Protocol


class WorkerRuntimePort(Protocol):
    """Filesystem/process services needed to spawn domain workers."""

    def make_evidence_dir(self, label: str) -> Path:
        """Create and return the evidence directory for a worker target."""

    def worker_env(self) -> dict[str, str]:
        """Return the environment variables used by worker subprocesses."""


class QualityTelemetryPort(Protocol):
    """워커 품질 텔레메트리 (#1 눈, skill_quality) — 구현은 plugin 컴포지션 루트가 주입.

    spec_env: attempt_id 생성·started 기록 후 worker env 반환. observe: completion
    (valid/invalid 모두)을 parent_observed 로 기록. 둘 다 best-effort — 실패해도
    팬아웃 흐름에 영향 없어야 한다.
    """

    def spec_env(self, base_env, *, worker_type: str, component: str) -> dict[str, str]:
        ...

    def observe(self, completion, *, worker_type: str, component: str) -> None:
        ...


class SmbFanoutStorePort(Protocol):
    """State operations needed by SMB fanout adapters."""

    def claim_mail_thread(
        self,
        *,
        session_id: int,
        status: str,
    ) -> dict[str, Any] | None:
        """Claim one mail thread in the requested status."""

    def set_mail_thread_status(self, thread_id: int, status: str, **fields: Any) -> None:
        """Set a mail thread back to a retryable status."""


class ReportMailLoopStorePort(Protocol):
    """State operations needed by the persistent report/mail loop."""

    def reclaim_stale_mail_threads(self) -> int:
        """Release stale claimed mail threads."""

    def control_flag_get(self, component: str) -> dict[str, Any]:
        """Return the node control flag."""

    def control_flag_consume_run_now(self, component: str) -> bool:
        """Consume a one-shot run request for the component."""

    def reported_host_count(self) -> int:
        """Return distinct hosts with report drafts ready for mail fanout."""

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
    """Core task-plan gateway used by application runners."""

    def ensure_plan_loaded(self, plan_name: str) -> Any:
        """Load plugins and return the registered plan."""

    def run_plan_events(
        self,
        plan: Any,
        *,
        cancel_event: asyncio.Event,
    ) -> AsyncIterator[Any]:
        """Run a core task plan and yield its events."""


class PipelineProjectionStorePort(Protocol):
    """Read-model persistence port for the SMB pipeline overview."""

    smb_subnet_claim_stale_seconds: float
    smb_subnet_rescan_seconds: float
    smb_claim_stale_seconds: float
    collector_claim_stale_seconds: float
    mail_thread_claim_stale_seconds: float

    def connect(self) -> AbstractContextManager[Any]:
        """Open a DB connection/context manager."""

    def control_flag_get(self, component: str) -> dict[str, Any]:
        """Return a component control flag."""

    def pipeline_runs_recent(self, component: str, *, limit: int) -> list[dict[str, Any]]:
        """Return recent pipeline run summaries for a component."""

    def current_cycle_key(self) -> str:
        """Return and initialize the current SMB weekly cycle key."""
