"""Infrastructure adapters used by Confluence E2E application services."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from service import state_domain as state

_REPO = Path(__file__).resolve().parents[4]
_SKILLS_DIR = _REPO / "domains" / "services" / "confluence" / "skills"


class ConfluenceStateGateway:
    """Adapter over the existing domain state module."""

    confluence_space_claim_stale_seconds = state.CONFLUENCE_SPACE_CLAIM_STALE_SECONDS
    confluence_space_rescan_seconds = state.CONFLUENCE_SPACE_RESCAN_SECONDS
    confluence_search_claim_stale_seconds = state.CONFLUENCE_SEARCH_CLAIM_STALE_SECONDS
    confluence_search_rescan_seconds = state.CONFLUENCE_SEARCH_RESCAN_SECONDS
    confluence_report_thread_claim_stale_seconds = (
        state.CONFLUENCE_REPORT_THREAD_CLAIM_STALE_SECONDS
    )
    devops_claim_stale_seconds = state.DEVOPS_CLAIM_STALE_SECONDS
    devops_rescan_seconds = state.DEVOPS_RESCAN_SECONDS

    def connect(self) -> Any:
        return state.connect()

    def control_flag_get(self, component: str) -> dict[str, Any]:
        return state.control_flag_get(component)

    def pipeline_runs_recent(self, component: str, *, limit: int) -> list[dict[str, Any]]:
        return state.pipeline_runs_recent(component, limit=limit)

    def current_cycle_key(self) -> str:
        return state.smb_current_cycle_key()

    def ensure_space_cycle_current(self) -> dict[str, Any]:
        return state.confluence_space_cycle_ensure_current()

    def ensure_sso_cycle_current(self) -> dict[str, Any]:
        return state.devops_target_cycle_ensure_current(service="confluence")

    def claim_sso_target(self, *, session_id: int) -> dict[str, Any] | None:
        cycle_key = state.smb_current_cycle_key()
        return state.devops_target_claim_next(
            session_id=session_id,
            service="confluence",
            cycle_key=cycle_key,
        )

    def reset_sso_target(
        self,
        target_id: int,
        *,
        reason: str | None = None,
        retry_after: float | None = None,
    ) -> None:
        with state.connect() as c:
            c.execute(
                "UPDATE devops_target SET status='pending', claimed_by=NULL, "
                "claimed_at=NULL, cycle_scanned_at=NULL, cycle_finding_count=0, "
                "retry_after=?, last_reason=? WHERE id=? AND service='confluence'",
                (retry_after, reason[:500] if reason else None, int(target_id)),
            )

    def claim_report_thread(self, *, session_id: int, status: str) -> dict[str, Any] | None:
        return state.confluence_report_thread_claim_next(
            session_id=session_id,
            status=status,
        )

    def set_report_thread_status(self, thread_id: int, status: str, **fields: Any) -> None:
        state.confluence_report_thread_set_status(thread_id, status, **fields)

    def reclaim_stale_report_threads(self) -> int:
        return state.confluence_report_thread_reclaim_stale()

    def reclaim_stale_sso_claims(self) -> int:
        """github 쪽과 같은 `devops_target` 테이블 — 같은 백스톱을 공유한다.

        `_reclaim_stale_claims` 는 `claimed_at` 이 신선한 행을 건드리지 않으므로
        (그리고 terminal row 는 불변) 다른 도메인이 도는 중에 불려도 안전하다.
        """
        return state.devops_reclaim_stale_claims()


class ConfluenceWorkerRuntime:
    """Filesystem and subprocess environment adapter for Confluence workers."""

    def __init__(self, *, repo_root: Path = _REPO, skills_dir: Path = _SKILLS_DIR) -> None:
        self._repo_root = repo_root
        self._skills_dir = skills_dir

    def make_evidence_dir(self, label: str) -> Path:
        from service.agents import runtime

        return runtime.make_evidence_dir(label)

    def worker_env(self) -> dict[str, str]:
        engine = Path(os.environ.get("SA_ENGINE_DIR", str(Path.home() / "project" / "secu-agent")))
        existing_py = os.environ.get("PYTHONPATH", "")
        py_parts = [str(engine / "src"), str(self._repo_root)]
        if existing_py:
            py_parts.append(existing_py)
        env = {
            "PYTHONPATH": os.pathsep.join(py_parts),
            "SA_ENGINE_DIR": str(engine),
            "SA_PLUGINS": os.environ.get(
                "SA_PLUGINS",
                str(self._repo_root / "plugin" / "bootstrap.py"),
            ),
        }
        existing_skills = os.environ.get("SA_SKILLS_DIRS", "")
        env["SA_SKILLS_DIRS"] = (
            str(self._skills_dir)
            if not existing_skills
            else str(self._skills_dir) + os.pathsep + existing_skills
        )
        return env


def default_state_gateway() -> ConfluenceStateGateway:
    return ConfluenceStateGateway()


def default_worker_runtime() -> ConfluenceWorkerRuntime:
    return ConfluenceWorkerRuntime()
