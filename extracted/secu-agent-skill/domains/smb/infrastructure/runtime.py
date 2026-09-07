"""Infrastructure adapters used by SMB application services."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import os
from pathlib import Path
from typing import Any

from service import state_domain as state
from service.runtime_env import load_runtime_env


_REPO = Path(__file__).resolve().parents[3]
_SKILLS_DIR = _REPO / "domains" / "smb" / "skills"


class SmbStateGateway:
    """Adapter over the existing domain state module."""

    smb_subnet_claim_stale_seconds = state.SMB_SUBNET_CLAIM_STALE_SECONDS
    smb_subnet_rescan_seconds = state.SMB_SUBNET_RESCAN_SECONDS
    smb_claim_stale_seconds = state.SMB_CLAIM_STALE_SECONDS
    collector_claim_stale_seconds = state.COLLECTOR_CLAIM_STALE_SECONDS
    mail_thread_claim_stale_seconds = state.MAIL_THREAD_CLAIM_STALE_SECONDS

    def connect(self) -> Any:
        return state.connect()

    def current_cycle_key(self) -> str:
        state.smb_cycle_ensure_current()
        return state.smb_current_cycle_key()

    def claim_mail_thread(
        self,
        *,
        session_id: int,
        status: str,
    ) -> dict[str, Any] | None:
        return state.mail_thread_claim_next(session_id=session_id, status=status)

    def set_mail_thread_status(self, thread_id: int, status: str, **fields: Any) -> None:
        state.mail_thread_set_status(thread_id, status, **fields)

    def reclaim_stale_mail_threads(self) -> int:
        return state.mail_thread_reclaim_stale()

    def control_flag_get(self, component: str) -> dict[str, Any]:
        return state.control_flag_get(component)

    def control_flag_consume_run_now(self, component: str) -> bool:
        return state.control_flag_consume_run_now(component)

    def reported_host_count(self) -> int:
        with state.connect() as c:
            row = c.execute(
                "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status='reported'",
            ).fetchone()
        return int(row[0] or 0) if row else 0

    def heartbeat_upsert(
        self,
        component: str,
        *,
        phase: str,
        detail: str | None = None,
        pid: int | None = None,
    ) -> None:
        state.heartbeat_upsert(component, phase=phase, detail=detail, pid=pid)

    def pipeline_run_start(self, component: str) -> int:
        return state.pipeline_run_start(component)

    def pipeline_run_finish(self, run_id: int, *, status: str, detail: str) -> None:
        state.pipeline_run_finish(run_id, status=status, detail=detail)

    def pipeline_runs_recent(self, component: str, *, limit: int) -> list[dict[str, Any]]:
        return state.pipeline_runs_recent(component, limit=limit)


class SmbWorkerRuntime:
    """Filesystem and subprocess environment adapter for domain workers."""

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


class CorePlanGateway:
    """Gateway over domain-neutral core task-plan APIs."""

    def ensure_plan_loaded(self, plan_name: str) -> Any:
        load_runtime_env(load_plugins=True)
        from secu_agent.agent.task_plan import get_task_plan

        plan = get_task_plan(plan_name)
        if plan is None:
            raise RuntimeError(f"task plan not registered: {plan_name}")
        return plan

    async def run_plan_events(
        self,
        plan: Any,
        *,
        cancel_event: asyncio.Event,
    ) -> AsyncIterator[Any]:
        from secu_agent.agent.task_plan import run_plan

        async for event in run_plan(plan, cancel_event=cancel_event):
            yield event


def default_state_gateway() -> SmbStateGateway:
    return SmbStateGateway()


def default_worker_runtime() -> SmbWorkerRuntime:
    return SmbWorkerRuntime()


def default_core_plan_gateway() -> CorePlanGateway:
    return CorePlanGateway()
