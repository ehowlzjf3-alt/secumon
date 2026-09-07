"""Infrastructure adapters for GitHub E2E services."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from service import state_domain as state

_REPO = Path(__file__).resolve().parents[4]
_SKILLS_DIR = _REPO / "domains" / "services" / "github" / "skills"


class GithubStateGateway:
    github_repo_claim_stale_seconds = state.GITHUB_REPO_CLAIM_STALE_SECONDS
    github_repo_rescan_seconds = state.GITHUB_REPO_RESCAN_SECONDS
    github_report_thread_claim_stale_seconds = state.GITHUB_REPORT_THREAD_CLAIM_STALE_SECONDS
    devops_claim_stale_seconds = state.DEVOPS_CLAIM_STALE_SECONDS
    devops_rescan_seconds = state.DEVOPS_RESCAN_SECONDS

    def connect(self) -> Any:
        return state.connect()

    def control_flag_get(self, component: str) -> dict[str, Any]:
        return state.control_flag_get(component)

    def control_flag_consume_run_now(self, component: str) -> bool:
        return state.control_flag_consume_run_now(component)

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

    def current_cycle_key(self) -> str:
        return state.smb_current_cycle_key()

    def ensure_repo_cycle_current(self) -> dict[str, Any]:
        return state.github_repo_cycle_ensure_current()

    def ensure_sso_cycle_current(self) -> dict[str, Any]:
        return state.devops_target_cycle_ensure_current(service="github")

    def claim_scan_targets(self, *, session_id: int, limit: int) -> list[dict[str, Any]]:
        return state.github_repo_target_claim_next(session_id=session_id, limit=limit)

    def set_scan_target_status(self, target_id: int, status: str, **fields: Any) -> None:
        state.github_repo_target_set_status(target_id, status, **fields)

    def claim_report_thread(self, *, session_id: int, status: str) -> dict[str, Any] | None:
        return state.github_report_thread_claim_next(session_id=session_id, status=status)

    def set_report_thread_status(self, thread_id: int, status: str, **fields: Any) -> None:
        state.github_report_thread_set_status(thread_id, status, **fields)

    def reclaim_stale_report_threads(self) -> int:
        return state.github_report_thread_reclaim_stale()

    # ── sso 평면 레인 포트는 은퇴했다 (2026-08-28) ─────────────────────────
    # `claim_sso_target` · `reset_sso_target` · `reclaim_stale_sso_claims` 의 유일한
    # 호출부가 `_make_sso_adapter` 였고, 그 어댑터를 지웠다. 이름만 남기면 다음 사람이
    # "배선돼 있겠지" 하고 믿는다 — 코어 `FanoutAdapter.release` 주석이 정확히 그랬다.
    #
    # ✅ `devops_target` 의 stale claim 회수는 계속된다. `devops_reclaim_stale_claims`
    #    는 service 필터가 없어 테이블 전체를 회수하고, confluence 의 sso 레인
    #    (`ConfluenceStateGateway.reclaim_stale_sso_claims`)이 살아 있다.
    #    2026-08-22 실측 98건(06-02 claim, 2.5개월 방치)을 풀어 준 그 백스톱이다.


class GithubWorkerRuntime:
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


def default_state_gateway() -> GithubStateGateway:
    return GithubStateGateway()


def default_worker_runtime() -> GithubWorkerRuntime:
    return GithubWorkerRuntime()
