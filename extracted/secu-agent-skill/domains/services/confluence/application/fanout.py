"""Confluence E2E fanout application orchestration.

Core owns TaskPlan, FanoutAdapter, WorkerPool, and goal mechanics. This skill
repo owns Confluence target claim/build/release, worker argv, and worker skill
contracts.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from domains.services.confluence.application.contracts import (
    COMPONENT_CONFLUENCE_SEARCH_TASK,
    COMPONENT_CONFLUENCE_SPACE_TASK,
    COMPONENT_CONFLUENCE_SSO_TASK,
    CONFLUENCE_E2E_PLAN,
    CONFLUENCE_TASK_PLAN,
    CONFLUENCE_TASK_SKILL,
    CONFLUENCE_RECHECK_PLAN,
    CONFLUENCE_RECHECK_SESSION_ID,
    CONFLUENCE_RECHECK_SKILL,
    CONFLUENCE_REPORT_PLAN,
    CONFLUENCE_REPORT_SESSION_ID,
    CONFLUENCE_REPORT_SKILL,
    CONFLUENCE_SEARCH_TASK_SESSION_ID,
    CONFLUENCE_SPACE_TASK_SESSION_ID,
    CONFLUENCE_SSO_TASK_PLAN,
    CONFLUENCE_SSO_TASK_SESSION_ID,
    PHASE_CONFLUENCE_RECHECK,
    PHASE_CONFLUENCE_REPORT,
    PHASE_CONFLUENCE_SSO_TASK,
)
from domains.services.confluence.application.ports import (
    ConfluenceFanoutStorePort,
    QualityTelemetryPort,
    WorkerRuntimePort,
)

ADAPTER_SSO = CONFLUENCE_SSO_TASK_PLAN
ADAPTER_REPORT = CONFLUENCE_REPORT_PLAN
ADAPTER_RECHECK = CONFLUENCE_RECHECK_PLAN


log = logging.getLogger("domains.services.confluence.fanout")


@dataclass(frozen=True)
class FanoutServices:
    store: ConfluenceFanoutStorePort
    runtime: WorkerRuntimePort
    quality: QualityTelemetryPort | None = None


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


# ── 평면 space/search 어댑터는 은퇴했다 (2026-08-28) ───────────────────────
# `_make_space_adapter` 는 `confluence_space_target` 을, `_make_search_adapter` 는
# `confluence_search_target` 을 배치로 claim 해 `service.agents.confluence_task_worker`
# 를 팬아웃했다. 이제 두 큐는 리드가 소비한다 — `confluence.lead`(space) ·
# `confluence_search.lead`(keyword). 워커 프롬프트는 `_build_user_text` 의
# `space_batch`/`keyword_search` 분기가 **그대로** 만든다(검토원 계약이 직접 부른다).
#
# ⚠️ **`_make_sso_adapter` 는 은퇴 대상이 아니다** — `confluence.sso_task` 는
#    `lead_agent._LEADS` 에 없고 대체 리드가 없다. 아래 sso 어댑터와 그 플랜은 그대로 산다.
#    같은 이유로 `_quality_env`/`_quality_observe`·`_write_spec`·`_failure_reason` 도 남는다.
#
# ✅ 함께 지운 `_group_searches_by_scope`(scope 이질 배치 union 방어)는 대체물이 필요 없다.
#    그게 막던 조건은 **배치 claim**(CONFLUENCE_SEARCH_BATCH=8)에서만 생겼는데, 리드는
#    `delegate_input(target_id: int, ...)` 로 **한 건씩만** 위임해서 scope 혼합이 구조적으로
#    불가능하다.
#
# 되찾으려면 태그 `flat-lane-last`.

def _make_sso_adapter(services: FanoutServices) -> Any:
    from secu_agent.agent.fanout import FanoutTarget
    from secu_agent.agent.worker_pool import WorkerSpec

    class _ConfluenceSsoAdapter:
        name = ADAPTER_SSO

        _reclaimed = False

        async def claim_next(self):
            # 런당 1회 stale claim 백스톱 — github 쪽과 같은 `devops_target` 테이블이다.
            # 코어 `FanoutAdapter.release` 가 전제하는 백스톱이 아무 데서도 안 불리고 있었다.
            if not self._reclaimed:
                self._reclaimed = True
                reclaim = getattr(services.store, "reclaim_stale_sso_claims", None)
                if callable(reclaim):
                    n = await asyncio.to_thread(reclaim)
                    if n:
                        log.info("[%s] stale claim %d건 회수", self.name, n)
            row = await asyncio.to_thread(
                services.store.claim_sso_target,
                session_id=CONFLUENCE_SSO_TASK_SESSION_ID,
            )
            if row is None:
                return None
            return FanoutTarget(
                label=f"confluence-sso-{int(row['id'])}",
                payload={"kind": "sso_url", "target": row},
            )

        async def build_spec(self, target):
            row = (target.payload or {}).get("target") or {}
            ev_dir = services.runtime.make_evidence_dir(target.label)
            _write_spec(ev_dir, {
                "task_id": target.label,
                "task_type": "confluence",
                "skill": CONFLUENCE_TASK_SKILL,
                "skill_resource": "worker.md",
                "charter_ref": os.environ.get("DEFAULT_CHARTER_REF", "SECOPS-2026-001"),
                "target": {
                    "kind": "sso_url",
                    "target_id": int(row["id"]),
                    "url": row.get("url"),
                    "day_bucket": row.get("day_bucket"),
                    "access_count": row.get("access_count"),
                },
            })
            return WorkerSpec(
                label=target.label,
                argv=(sys.executable, "-m", "service.agents.confluence_task_worker", str(ev_dir)),
                evidence_dir=ev_dir,
                env=await _quality_env(services, services.runtime.worker_env(),
                                 worker_type="confluence_sso_url",
                                 component=COMPONENT_CONFLUENCE_SSO_TASK),
                timeout_sec=_int_env("CONFLUENCE_SSO_WORKER_TIMEOUT_SEC", 1800),
                payload=row,
            )

        async def release(self, target, completion, *, success: bool):
            # parent_observed 는 success 분기 앞 — 성공 no-op 이 관측을 삼키면 안 됨(#1 눈)
            await _quality_observe(services, completion,
                             worker_type="confluence_sso_url",
                             component=COMPONENT_CONFLUENCE_SSO_TASK)
            if success:
                return
            row = (target.payload or {}).get("target") or {}
            if row.get("id") is None:
                return
            retry_seconds = _int_env("CONFLUENCE_SSO_FAILURE_RETRY_SECONDS", 1800)
            await asyncio.to_thread(
                services.store.reset_sso_target,
                int(row["id"]),
                reason=_failure_reason(completion),
                retry_after=time.time() + retry_seconds,
            )

        def summarize(self, report) -> str:
            return (
                f"confluence_sso_task: claimed={report.claimed} ok={report.succeeded} "
                f"fail={report.failed} findings={report.findings_count}"
            )

    return _ConfluenceSsoAdapter()


class _ConfluenceThreadAdapter:
    def __init__(
        self,
        *,
        services: FanoutServices,
        name: str,
        skill: str,
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
        self._skill = skill
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
            from domains.services.confluence.application.reporter import sync_report_threads

            await asyncio.to_thread(sync_report_threads)
        thread = await asyncio.to_thread(
            self._services.store.claim_report_thread,
            session_id=self._session_id,
            status=self._claim_status,
        )
        if thread is None:
            return None
        return FanoutTarget(
            label=f"{self.name}-{int(thread['id'])}-{thread.get('space_key')}",
            payload=thread,
        )

    async def build_spec(self, target):
        from secu_agent.agent.worker_pool import WorkerSpec

        ev_dir = self._services.runtime.make_evidence_dir(target.label)
        _write_spec(ev_dir, {
            "task_id": target.label,
            "task_type": self.name,
            "skill": self._skill,
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


def _register_adapters(services: FanoutServices) -> bool:
    try:
        from secu_agent.agent.fanout import register_fanout_adapter
    except ImportError:
        return False
    for name, factory in (
        (ADAPTER_SSO, lambda: _make_sso_adapter(services)),
        (ADAPTER_REPORT, lambda: _ConfluenceThreadAdapter(
            services=services,
            name=ADAPTER_REPORT,
            skill=CONFLUENCE_REPORT_SKILL,
            claim_status="reported",
            session_id=CONFLUENCE_REPORT_SESSION_ID,
            worker_module="service.agents.confluence_report_worker",
            retry_status="reported",
            timeout_env="CONFLUENCE_REPORT_WORKER_TIMEOUT_SEC",
            timeout_default=600,
            failure_retry_env="CONFLUENCE_REPORT_FAILURE_RETRY_SECONDS",
            failure_retry_default=1800,
            sync_before_claim=True,
        )),
        (ADAPTER_RECHECK, lambda: _ConfluenceThreadAdapter(
            services=services,
            name=ADAPTER_RECHECK,
            skill=CONFLUENCE_RECHECK_SKILL,
            claim_status="recheck_requested",
            session_id=CONFLUENCE_RECHECK_SESSION_ID,
            worker_module="service.agents.confluence_recheck_worker",
            retry_status="recheck_requested",
            timeout_env="CONFLUENCE_RECHECK_WORKER_TIMEOUT_SEC",
            timeout_default=900,
            failure_retry_env="CONFLUENCE_RECHECK_FAILURE_RETRY_SECONDS",
            failure_retry_default=1800,
        )),
    ):
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

    sso_phase = Phase(
        name=PHASE_CONFLUENCE_SSO_TASK,
        adapter=ADAPTER_SSO,
        k=_int_env("CONFLUENCE_SSO_PARALLEL", 1),
        required=False,
    )
    report_phase = Phase(
        name=PHASE_CONFLUENCE_REPORT,
        adapter=ADAPTER_REPORT,
        k=_int_env("CONFLUENCE_REPORT_PARALLEL", 2),
        required=False,
    )
    recheck_phase = Phase(
        name=PHASE_CONFLUENCE_RECHECK,
        adapter=ADAPTER_RECHECK,
        k=_int_env("CONFLUENCE_RECHECK_PARALLEL", 1),
        required=False,
    )
    plans = (
        TaskPlan(name=CONFLUENCE_SSO_TASK_PLAN, phases=(sso_phase,)),
        TaskPlan(name=CONFLUENCE_REPORT_PLAN, phases=(report_phase,)),
        TaskPlan(name=CONFLUENCE_RECHECK_PLAN, phases=(recheck_phase,)),
        TaskPlan(name=CONFLUENCE_TASK_PLAN, phases=(sso_phase,)),
        TaskPlan(name=CONFLUENCE_E2E_PLAN, phases=(
            sso_phase,
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
    """Register Confluence E2E fanout adapters and plans into the neutral core."""
    adapters = _register_adapters(services)
    plans = _register_plans()
    return adapters or plans
