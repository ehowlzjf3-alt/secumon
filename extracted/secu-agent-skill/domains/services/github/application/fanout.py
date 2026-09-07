"""GitHub E2E fanout application adapters."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

from domains.services.github.application.contracts import (
    GITHUB_E2E_AGENTS_PLAN,
    GITHUB_TASK_PLAN,
    COMPONENT_GITHUB_RECHECK,
    COMPONENT_GITHUB_REPORT,
    COMPONENT_GITHUB_SCAN,
    GITHUB_RECHECK_PLAN,
    GITHUB_RECHECK_SESSION_ID,
    GITHUB_REPORT_PLAN,
    GITHUB_REPORT_SESSION_ID,
    GITHUB_SCAN_PLAN,
    GITHUB_SCAN_SESSION_ID,
    GITHUB_SCAN_SKILL,
    PHASE_GITHUB_RECHECK,
    PHASE_GITHUB_REPORT,
    PHASE_GITHUB_SCAN,
)

ADAPTER_GITHUB_SCAN = GITHUB_SCAN_PLAN
ADAPTER_GITHUB_REPORT = GITHUB_REPORT_PLAN
ADAPTER_GITHUB_RECHECK = GITHUB_RECHECK_PLAN


log = logging.getLogger("domains.services.github.fanout")


@dataclass(frozen=True)
class FanoutServices:
    store: Any
    runtime: Any
    quality: Any = None  # QualityTelemetryPort 형상 (#1 눈) — plugin 컴포지션 루트가 주입


async def _quality_env(services: FanoutServices, base_env, *, worker_type: str, component: str):
    """quality 포트 미주입(구 테스트/픽스처)이면 base_env 그대로 — 무배선=무변화.

    동기 DB 기록을 to_thread 로 — 이벤트 루프(spawn/claim reset)를 블로킹하지 않는다(codex verify #3).
    """
    if services.quality is None:
        return base_env
    return await asyncio.to_thread(
        services.quality.spec_env, base_env, worker_type=worker_type, component=component)


async def _quality_observe(services: FanoutServices, completion, *, worker_type: str, component: str) -> None:
    if services.quality is not None:
        await asyncio.to_thread(
            services.quality.observe, completion, worker_type=worker_type, component=component)


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _write_spec(ev_dir: Path, payload: dict[str, Any]) -> None:
    (ev_dir / "task_spec.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _failure_reason(completion: Any | None) -> str:
    if completion is None:
        return "worker failed before completion"
    parts = [str(getattr(completion, "outcome", "") or "worker_failed")]
    rc = getattr(completion, "rc", None)
    if rc is not None:
        parts.append(f"rc={rc}")
    result = getattr(completion, "result", None)
    detail = (
        getattr(result, "summary", None)
        or getattr(result, "detail", None)
        or getattr(result, "reason", None)
    )
    if detail:
        parts.append(str(detail))
    return " ".join(parts)[:500]


def _make_scan_adapter(services: FanoutServices) -> Any:
    from secu_agent.agent.fanout import FanoutTarget
    from secu_agent.agent.worker_pool import WorkerSpec

    class _GithubScanAdapter:
        name = ADAPTER_GITHUB_SCAN

        async def claim_next(self):
            rows = await asyncio.to_thread(
                services.store.claim_scan_targets,
                session_id=GITHUB_SCAN_SESSION_ID,
                limit=1,
            )
            if not rows:
                return None
            target = rows[0]
            return FanoutTarget(label=f"github-scan-{target['id']}-{target['repo']}", payload=target)

        async def build_spec(self, target):
            ev_dir = services.runtime.make_evidence_dir(target.label)
            _write_spec(ev_dir, {
                "task_id": target.label,
                "task_type": ADAPTER_GITHUB_SCAN,
                "skill": GITHUB_SCAN_SKILL,
                "skill_resource": "worker.md",
                "charter_ref": os.environ.get("DEFAULT_CHARTER_REF", "SECOPS-2026-001"),
                "target": target.payload,
            })
            return WorkerSpec(
                label=target.label,
                argv=(sys.executable, "-m", "service.agents.github_scan_worker", str(ev_dir)),
                evidence_dir=ev_dir,
                env=services.runtime.worker_env(),
                timeout_sec=_int_env("GITHUB_SCAN_WORKER_TIMEOUT_SEC", 1800),
                payload=target.payload,
            )

        async def release(self, target, completion, *, success: bool):
            if success:
                return
            await asyncio.to_thread(
                services.store.set_scan_target_status,
                int(target.payload["id"]),
                "error",
                last_reason=_failure_reason(completion),
                finding_count=0,
            )

        def summarize(self, report) -> str:
            return f"github_scan: claimed={report.claimed} ok={report.succeeded} fail={report.failed}"

    return _GithubScanAdapter()


# ── 평면 SSO 어댑터는 은퇴했다 (2026-08-28) ───────────────────────────────
# `_make_sso_adapter` 는 `devops_target(service='github')` 을 직접 claim 해
# `service.agents.github_task_worker` 를 팬아웃했다. 이제 그 큐는 `github.lead`
# 가 소비한다 — target 하나당 검토원 하나. 워커 프롬프트는
# `github_task_worker._build_user_text` 가 그대로 만든다.
#
# ✅ stale claim 백스톱은 **잃지 않았다**. 이 어댑터가 부르던
#    `reclaim_stale_sso_claims` 는 `state.devops_reclaim_stale_claims` 이고,
#    그건 service 필터 없이 `devops_target` 전체를 회수한다. confluence 의 sso
#    레인이 살아 있어(은퇴 대상 아님) 같은 테이블을 계속 회수한다.
#    → dev_web 과 달리 여기서는 새 구멍이 없다.
#
# 어댑터 등록·`GITHUB_SSO_TASK_PLAN`·`GITHUB_TASK_PLAN`/E2E 플랜의 sso phase·
# 파이프라인 러너 스텝도 함께 뺐다. 되찾으려면 태그 `flat-lane-last`.


class _GithubThreadAdapter:
    def __init__(
        self,
        *,
        services: FanoutServices,
        name: str,
        claim_status: str,
        session_id: int,
        worker_module: str,
        retry_status: str,
        timeout_env: str,
        timeout_default: int,
        failure_retry_env: str,
        failure_retry_default: int,
        sync_before_claim: bool = False,
    ) -> None:
        self._services = services
        self.name = name
        self._claim_status = claim_status
        self._session_id = session_id
        self._worker_module = worker_module
        self._retry_status = retry_status
        self._timeout_env = timeout_env
        self._timeout_default = timeout_default
        self._failure_retry_env = failure_retry_env
        self._failure_retry_default = failure_retry_default
        self._sync_before_claim = sync_before_claim

    async def claim_next(self):
        from secu_agent.agent.fanout import FanoutTarget

        if self._sync_before_claim:
            from domains.services.github.application.scanner import sync_report_threads

            await asyncio.to_thread(sync_report_threads)
        thread = await asyncio.to_thread(
            self._services.store.claim_report_thread,
            session_id=self._session_id,
            status=self._claim_status,
        )
        if thread is None:
            return None
        return FanoutTarget(label=f"{self.name}-{int(thread['id'])}-{thread.get('repo')}", payload=thread)

    async def build_spec(self, target):
        from secu_agent.agent.worker_pool import WorkerSpec

        ev_dir = self._services.runtime.make_evidence_dir(target.label)
        _write_spec(ev_dir, {
            "task_id": target.label,
            "task_type": self.name,
            "skill": self.name,
            "skill_resource": "worker.md",
            "charter_ref": os.environ.get("DEFAULT_CHARTER_REF", "SECOPS-2026-001"),
            "target": target.payload,
        })
        return WorkerSpec(
            label=target.label,
            argv=(sys.executable, "-m", self._worker_module, str(ev_dir)),
            evidence_dir=ev_dir,
            env=self._services.runtime.worker_env(),
            timeout_sec=_int_env(self._timeout_env, self._timeout_default),
            payload=target.payload,
        )

    async def release(self, target, completion, *, success: bool):
        if success:
            return
        retry_seconds = _int_env(self._failure_retry_env, self._failure_retry_default)
        await asyncio.to_thread(
            self._services.store.set_report_thread_status,
            int(target.payload["id"]),
            self._retry_status,
            retry_after=time.time() + retry_seconds,
            last_reason=_failure_reason(completion),
        )

    def summarize(self, report) -> str:
        return f"{self.name}: claimed={report.claimed} ok={report.succeeded} fail={report.failed}"


def _make_report_adapter(services: FanoutServices) -> Any:
    return _GithubThreadAdapter(
        services=services,
        name=ADAPTER_GITHUB_REPORT,
        claim_status="reported",
        session_id=GITHUB_REPORT_SESSION_ID,
        worker_module="service.agents.github_report_worker",
        retry_status="reported",
        timeout_env="GITHUB_REPORT_WORKER_TIMEOUT_SEC",
        timeout_default=600,
        failure_retry_env="GITHUB_REPORT_FAILURE_RETRY_SECONDS",
        failure_retry_default=1800,
        sync_before_claim=True,
    )


def _register_adapters(services: FanoutServices) -> bool:
    try:
        from secu_agent.agent.fanout import register_fanout_adapter
    except ImportError:
        return False
    adapters = (
        (ADAPTER_GITHUB_SCAN, lambda: _make_scan_adapter(services)),
        (ADAPTER_GITHUB_REPORT, lambda: _make_report_adapter(services)),
        (ADAPTER_GITHUB_RECHECK, lambda: _GithubThreadAdapter(
            services=services,
            name=ADAPTER_GITHUB_RECHECK,
            claim_status="recheck_requested",
            session_id=GITHUB_RECHECK_SESSION_ID,
            worker_module="service.agents.github_recheck_worker",
            retry_status="recheck_requested",
            timeout_env="GITHUB_RECHECK_WORKER_TIMEOUT_SEC",
            timeout_default=900,
            failure_retry_env="GITHUB_RECHECK_FAILURE_RETRY_SECONDS",
            failure_retry_default=1800,
        )),
    )
    for name, factory in adapters:
        try:
            register_fanout_adapter(name, factory)
        except ValueError:
            pass
    return True


def _register_plans() -> bool:
    try:
        from secu_agent.agent.task_plan import TaskPlan, Phase, register_task_plan
    except ImportError:
        return False
    scan_phase = Phase(
        name=PHASE_GITHUB_SCAN,
        adapter=ADAPTER_GITHUB_SCAN,
        k=_int_env("GITHUB_SCAN_PARALLEL", 2),
        required=False,
    )
    report_phase = Phase(
        name=PHASE_GITHUB_REPORT,
        adapter=ADAPTER_GITHUB_REPORT,
        k=_int_env("GITHUB_REPORT_PARALLEL", 2),
        required=False,
    )
    recheck_phase = Phase(
        name=PHASE_GITHUB_RECHECK,
        adapter=ADAPTER_GITHUB_RECHECK,
        k=_int_env("GITHUB_RECHECK_PARALLEL", 1),
        required=False,
    )
    plans = (
        TaskPlan(name=GITHUB_SCAN_PLAN, phases=(scan_phase,)),
        TaskPlan(name=GITHUB_REPORT_PLAN, phases=(report_phase,)),
        TaskPlan(name=GITHUB_RECHECK_PLAN, phases=(recheck_phase,)),
        TaskPlan(name=GITHUB_TASK_PLAN, phases=(scan_phase,)),
        TaskPlan(name=GITHUB_E2E_AGENTS_PLAN, phases=(
            scan_phase,
            report_phase,
            recheck_phase,
        )),
    )
    for plan in plans:
        try:
            register_task_plan(plan)
        except ValueError:
            pass
    return True


def register(services: FanoutServices) -> bool:
    adapters = _register_adapters(services)
    plans = _register_plans()
    return adapters or plans
