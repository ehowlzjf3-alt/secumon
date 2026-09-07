"""Ports required by Confluence E2E application use cases."""
from __future__ import annotations

from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any, Protocol


class WorkerRuntimePort(Protocol):
    """Filesystem/process services needed to spawn domain workers."""

    def make_evidence_dir(self, label: str) -> Path:
        """Create and return the evidence directory for a worker target."""

    def worker_env(self) -> dict[str, str]:
        """Return environment variables for worker subprocesses."""


class QualityTelemetryPort(Protocol):
    """워커 품질 텔레메트리 (#1 눈, skill_quality) — 구현은 plugin 컴포지션 루트가 주입.

    spec_env: attempt_id 생성·started 기록 후 worker env 반환. observe: completion
    (valid/invalid 모두)을 parent_observed 로 기록. 둘 다 best-effort.
    """

    def spec_env(self, base_env, *, worker_type: str, component: str) -> dict[str, str]:
        ...

    def observe(self, completion, *, worker_type: str, component: str) -> None:
        ...


class ConfluenceFanoutStorePort(Protocol):
    """State operations needed by Confluence fanout adapters."""

    def claim_sso_target(self, *, session_id: int) -> dict[str, Any] | None:
        """Claim one Confluence SSO URL from the devops target queue."""

    def reset_sso_target(
        self,
        target_id: int,
        *,
        reason: str | None = None,
        retry_after: float | None = None,
    ) -> None:
        """Return a failed SSO URL target to the pending queue."""

    def claim_report_thread(self, *, session_id: int, status: str) -> dict[str, Any] | None:
        """Claim one Confluence report/recheck thread."""

    def set_report_thread_status(self, thread_id: int, status: str, **fields: Any) -> None:
        """Set Confluence report/recheck thread status."""

    def reclaim_stale_report_threads(self) -> int:
        """Release stale report/recheck thread claims."""

    def reclaim_stale_sso_claims(self) -> int:
        """Release stale devops_target claims left by dead workers."""


class PipelineProjectionStorePort(Protocol):
    """Read-model persistence port for the Confluence pipeline overview."""

    confluence_space_claim_stale_seconds: float
    confluence_space_rescan_seconds: float
    confluence_report_thread_claim_stale_seconds: float
    devops_claim_stale_seconds: float
    devops_rescan_seconds: float

    def connect(self) -> AbstractContextManager[Any]:
        """Open a DB connection/context manager."""

    def control_flag_get(self, component: str) -> dict[str, Any]:
        """Read scheduler control state for a component."""

    def pipeline_runs_recent(self, component: str, *, limit: int) -> list[dict[str, Any]]:
        """Return recent pipeline run summaries for a component."""

    def current_cycle_key(self) -> str:
        """Return the current weekly report/recheck cycle key."""

    def ensure_space_cycle_current(self) -> dict[str, Any]:
        """Reset space-target cycle progress when the weekly board changes."""

    def ensure_sso_cycle_current(self) -> dict[str, Any]:
        """Reset SSO URL target cycle progress when the weekly board changes."""
