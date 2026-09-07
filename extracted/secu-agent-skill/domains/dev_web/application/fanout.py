"""dev_web E2E fanout orchestration."""
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

from domains.dev_web.application.contracts import (
    DEV_WEB_E2E_AGENTS_PLAN,
    DEV_WEB_REPLY_VERIFY_PLAN,
    DEV_WEB_REPORT_PLAN,
    PHASE_REPLY_VERIFY,
    PHASE_REPORT,
    REPORT_SESSION_ID,
    REVERIFY_SESSION_ID,
)
from domains.dev_web.application.ports import (
    DevWebFanoutStorePort,
    QualityTelemetryPort,
    WorkerRuntimePort,
)

ADAPTER_REPORT = DEV_WEB_REPORT_PLAN
ADAPTER_REPLY_VERIFY = DEV_WEB_REPLY_VERIFY_PLAN


log = logging.getLogger("domains.dev_web.fanout")


@dataclass(frozen=True)
class FanoutServices:
    store: DevWebFanoutStorePort
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


# ── 평면 task 어댑터는 은퇴했다 (2026-08-28) ──────────────────────────────
# `_make_task_adapter` 는 `dev_web_target` 을 직접 claim 해
# `service.agents.dev_web_task_worker` 를 팬아웃했다. 이제 그 큐는 `dev_web.lead`
# 가 소비한다 — target 하나당 검토원 하나. 워커 프롬프트는
# `dev_web_task_agent._build_user_text` 가 그대로 만든다.
#
# ⚠️ 이 어댑터가 **stale claim 백스톱의 유일한 호출부**였다
#    (`store.reclaim_stale_task_claims` → `state.dev_web_reclaim_stale_claims`).
#    ✅ 정정: 행이 영구히 잠기지는 않는다 — 리드의 `claimable_statuses` 가
#       `in_progress` 를 포함해서 다음 패스가 다시 집는다(4도메인 공통).
#    ⚠️ 대신 성질이 바뀌었다: 옛 백스톱은 stale 임계를 보고 풀었는데, 리드는 그 검사 없이
#       다시 목록에 올린다 — "영원히 잠김" 이 아니라 "아직 도는 검토원의 타깃을 다시 위임"
#       쪽 위험이다. `state_domain.dev_web_reclaim_stale_claims` 에 자세히 적어 뒀다.
#
# 어댑터 등록과 `DEV_WEB_TASK_PLAN`·E2E 플랜의 task phase 도 함께 뺐다.
# 되찾으려면 태그 `flat-lane-last`.


class _ReportThreadAdapter:
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

    async def claim_next(self):
        from secu_agent.agent.fanout import FanoutTarget

        thread = await asyncio.to_thread(
            self._services.store.claim_report_thread,
            session_id=self._session_id,
            status=self._claim_status,
        )
        if thread is None:
            return None
        return FanoutTarget(
            label=f"{self.name}-{int(thread['id'])}-{thread.get('domain')}",
            payload=thread,
        )

    async def build_spec(self, target):
        from secu_agent.agent.worker_pool import WorkerSpec

        thread = target.payload
        ev_dir = self._services.runtime.make_evidence_dir(target.label)
        _write_spec(ev_dir, {
            "task_id": target.label,
            "task_type": self.name,
            "skill": self.name,
            "skill_resource": "worker.md",
            "charter_ref": os.environ.get("DEFAULT_CHARTER_REF", "SECOPS-2026-001"),
            "target": {
                "thread_id": int(thread["id"]),
                "target_id": thread.get("target_id"),
                "finding_id": thread.get("finding_id"),
                "domain": thread.get("domain"),
                "url": thread.get("url"),
            },
        })
        return WorkerSpec(
            label=target.label,
            argv=(sys.executable, "-m", self._worker_module, str(ev_dir)),
            evidence_dir=ev_dir,
            env=self._services.runtime.worker_env(),
            timeout_sec=_int_env(self._timeout_env, self._timeout_default),
            payload=thread,
        )

    async def release(self, target, completion, *, success: bool):
        if success:
            return
        retry_seconds = _int_env(self._failure_retry_env, self._failure_retry_default)
        # ⚠️ **claim 하던 status 인 동안에만** 되돌린다. 에이전트가 이미 report_ready 로
        #    파킹한 뒤 워커 래퍼가 rc≠0 을 돌려주면, 무조건 덮기는 그 파킹을 풀고
        #    파킹 토큰(last_reason)까지 지워 "되돌리는 문" 을 영영 0행으로 만든다.
        #    파킹 이전에는 reported→reported 라 무해했으므로 이 가드가 없었다.
        await asyncio.to_thread(
            self._services.store.retry_report_thread,
            int((target.payload or {})["id"]),
            expect_status=self._claim_status,
            status=self._retry_status,
            retry_after=time.time() + retry_seconds,
            last_reason=_failure_reason(completion),
        )

    def summarize(self, report) -> str:
        return f"{self.name}: claimed={report.claimed} ok={report.succeeded} fail={report.failed}"


def _make_report_adapter(services: FanoutServices) -> Any:
    return _ReportThreadAdapter(
        services=services,
        name=ADAPTER_REPORT,
        claim_status="reported",
        session_id=REPORT_SESSION_ID,
        worker_module="service.agents.dev_web_report_worker",
        retry_status="reported",
        timeout_env="DEV_WEB_REPORT_WORKER_TIMEOUT_SEC",
        timeout_default=900,
        failure_retry_env="DEV_WEB_REPORT_FAILURE_RETRY_SECONDS",
        failure_retry_default=1800,
    )


def _make_reply_verify_adapter(services: FanoutServices) -> Any:
    return _ReportThreadAdapter(
        services=services,
        name=ADAPTER_REPLY_VERIFY,
        claim_status="reply_received",
        session_id=REVERIFY_SESSION_ID,
        worker_module="service.agents.dev_web_reverify_worker",
        retry_status="reply_received",
        timeout_env="DEV_WEB_REPLY_VERIFY_WORKER_TIMEOUT_SEC",
        timeout_default=900,
        failure_retry_env="DEV_WEB_REPLY_VERIFY_FAILURE_RETRY_SECONDS",
        failure_retry_default=1800,
    )


def _register_adapters(services: FanoutServices) -> bool:
    try:
        from secu_agent.agent.fanout import register_fanout_adapter
    except ImportError:
        return False
    for name, factory in (
        (ADAPTER_REPORT, lambda: _make_report_adapter(services)),
        (ADAPTER_REPLY_VERIFY, lambda: _make_reply_verify_adapter(services)),
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

    plans = (
        TaskPlan(
            name=DEV_WEB_REPORT_PLAN,
            phases=(Phase(
                name=PHASE_REPORT,
                adapter=ADAPTER_REPORT,
                k=_int_env("DEV_WEB_REPORT_PARALLEL", 2),
            ),),
        ),
        TaskPlan(
            name=DEV_WEB_REPLY_VERIFY_PLAN,
            phases=(Phase(
                name=PHASE_REPLY_VERIFY,
                adapter=ADAPTER_REPLY_VERIFY,
                k=_int_env("DEV_WEB_REPLY_VERIFY_PARALLEL", 2),
            ),),
        ),
        TaskPlan(
            name=DEV_WEB_E2E_AGENTS_PLAN,
            phases=(
                Phase(
                    name=PHASE_REPORT,
                    adapter=ADAPTER_REPORT,
                    k=_int_env("DEV_WEB_REPORT_PARALLEL", 2),
                    required=False,
                ),
                Phase(
                    name=PHASE_REPLY_VERIFY,
                    adapter=ADAPTER_REPLY_VERIFY,
                    k=_int_env("DEV_WEB_REPLY_VERIFY_PARALLEL", 2),
                    required=False,
                ),
            ),
        ),
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
