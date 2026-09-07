"""Infrastructure adapters used by dev_web application services."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import os
from pathlib import Path
from typing import Any

from service import state_domain as state
from service.runtime_env import load_runtime_env


_REPO = Path(__file__).resolve().parents[3]
_SKILLS_DIR = _REPO / "domains" / "dev_web" / "skills"


class DevWebStateGateway:
    """Adapter over the existing domain state module."""

    dev_web_claim_stale_seconds = state.DEV_WEB_CLAIM_STALE_SECONDS
    dev_web_rescan_seconds = state.DEV_WEB_RESCAN_SECONDS

    def connect(self) -> Any:
        return state.connect()

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
        return state.dev_web_target_upsert(
            url,
            source=source,
            day_bucket=day_bucket,
            event_count=event_count,
            priority_score=priority_score,
            domain=domain,
            cycle_key=cycle_key,
        )

    def dev_web_targets_summary(self, *, day_bucket: str | None = None) -> dict[str, int]:
        return state.dev_web_targets_summary(day_bucket=day_bucket)

    def claim_report_thread(
        self,
        *,
        session_id: int,
        status: str,
    ) -> dict[str, Any] | None:
        return state.dev_web_report_thread_claim_next(
            session_id=session_id,
            status=status,
        )

    def retry_report_thread(
        self,
        thread_id: int,
        *,
        expect_status: str,
        status: str,
        retry_after: float | None = None,
        last_reason: str | None = None,
    ) -> bool:
        """claim 하던 status 인 동안에만 되돌린다 — 파킹을 덮지 않기 위한 원자 가드."""
        return state.dev_web_report_thread_retry_if_status(
            thread_id, expect_status=expect_status, status=status,
            retry_after=retry_after, last_reason=last_reason,
        )

    def set_report_thread_status(
        self,
        thread_id: int,
        status: str,
        *,
        retry_after: float | None = None,
        last_reason: str | None = None,
    ) -> None:
        fields: dict[str, Any] = {}
        if retry_after is not None:
            fields["retry_after"] = retry_after
        if last_reason is not None:
            fields["last_reason"] = last_reason
        state.dev_web_report_thread_set_status(thread_id, status, **fields)

    def reclaim_stale_report_threads(self) -> int:
        return state.dev_web_report_thread_reclaim_stale()

    def control_flag_get(self, component: str) -> dict[str, Any]:
        return state.control_flag_get(component)

    def control_flag_consume_run_now(self, component: str) -> bool:
        return state.control_flag_consume_run_now(component)

    def reported_target_count(self) -> int:
        with state.connect() as c:
            row = c.execute(
                "SELECT COUNT(*) FROM dev_web_report_thread "
                "WHERE status='reported' AND last_cycle_key=?",
                (state.smb_current_cycle_key(),),
            ).fetchone()
        return int(row[0] or 0) if row else 0

    def current_cycle_key(self) -> str:
        return state.smb_current_cycle_key()

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


class DevWebWorkerRuntime:
    """Filesystem and subprocess environment adapter for dev_web workers."""

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


class SplunkSearchClient:
    """Direct Splunk adapter for standalone dev_web discovery runners."""

    def enabled(self) -> bool:
        from service.collector import splunk_owner

        return splunk_owner.splunk_enabled()

    def search(self, spl: str, *, max_results: int) -> list[dict[str, Any]]:
        """SPL 실행은 `splunk_owner.search` 단일 진입점에 위임한다.

        2026-08-16: 여기서 따로 분기하던 탓에 게이트웨이 이전 때 dev_web 만 죽어 있었다
        (discovery 5주 정지). 경로 선택 규칙은 한 곳에만 둔다.
        SPL 이 `earliest=`/`latest=` 를 본문에 담고 있으므로 인자로는 넓게 준다.
        """
        from service.collector import splunk_owner

        if not self.enabled():
            raise RuntimeError(
                "MCP_SPLUNK_GATEWAY_URL / MCP_SPLUNK_URL / SPLUNK_REST_URL 중 하나가 "
                "dev_web discovery 에 필요하다"
            )
        return splunk_owner.search(spl, max_results=max_results, earliest="-7d@d", latest="now")


def default_state_gateway() -> DevWebStateGateway:
    return DevWebStateGateway()


def default_worker_runtime() -> DevWebWorkerRuntime:
    return DevWebWorkerRuntime()


def default_core_plan_gateway() -> CorePlanGateway:
    return CorePlanGateway()


def default_splunk_search_client() -> SplunkSearchClient:
    return SplunkSearchClient()
