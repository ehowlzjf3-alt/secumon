"""SMB E2E fanout application orchestration.

This is the clean core boundary:

- core owns TaskPlan, FanoutAdapter, WorkerPool, schedule, and goal mechanics;
- this skill repo owns SMB target claim/build/release and worker argv;
- operator tool registry does not receive SMB domain tools.

Each adapter claims one target and spawns one worker process that loads one
worker skill contract.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from domains.smb.application.contracts import (
    MAIL_SESSION_ID,
    PHASE_REPLY_VERIFY,
    PHASE_REPORT_MAIL,
    REVERIFY_SESSION_ID,
    SMB_E2E_AGENTS_PLAN,
    SMB_REPLY_VERIFY_PLAN,
    SMB_REPORT_MAIL_PLAN,
)
from domains.smb.application.ports import (
    QualityTelemetryPort,
    SmbFanoutStorePort,
    WorkerRuntimePort,
)

ADAPTER_REPORT_MAIL = SMB_REPORT_MAIL_PLAN
ADAPTER_REPLY_VERIFY = SMB_REPLY_VERIFY_PLAN


@dataclass(frozen=True)
class FanoutServices:
    store: SmbFanoutStorePort
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


def _write_spec(ev_dir: Path, payload: dict[str, Any]) -> None:
    (ev_dir / "task_spec.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# ── 평면 task 어댑터는 은퇴했다 (2026-08-28) ──────────────────────────────
# `_make_task_adapter` 는 walked share 를 직접 claim 해 `service.agents.smb_task_worker`
# 를 팬아웃했다. 이제 그 큐는 `smb.lead` 가 소비한다 — 리드가 share 하나당 검토원
# 하나를 띄우고(`open_inspection`/`ask_inspector`), 워커 프롬프트는
# `smb_task_agent._build_user_text` 가 그대로 만든다.
#
# ⚠️ 어댑터를 지운 만큼 `SMB_TASK_PLAN` 등록과 `SMB_E2E_AGENTS_PLAN` 의 task phase
#    도 함께 뺐다(아래 `_register_plans`). 이름 상수는 `contracts.py` 에 남는다 —
#    `service/agent_components.py` 가 재수출하고 콘솔 투영이 phase 이름을 쓴다.
# 되찾으려면 태그 `flat-lane-last`.


class _MailThreadAdapter:
    def __init__(
        self, *,
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
            self._services.store.claim_mail_thread,
            session_id=self._session_id,
            status=self._claim_status,
        )
        if thread is None:
            return None
        return FanoutTarget(
            label=f"{self.name}-{int(thread['id'])}-{thread.get('host')}",
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
                "host": thread.get("host"),
                "finding_id": thread.get("finding_id"),
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
        thread_id = int((target.payload or {}).get("id"))
        retry_seconds = _int_env(self._failure_retry_env, self._failure_retry_default)
        reason = _failure_reason(completion)
        await asyncio.to_thread(
            self._services.store.set_mail_thread_status,
            thread_id,
            self._retry_status,
            retry_after=time.time() + retry_seconds,
            last_error_kind="worker_failed",
            last_reason=reason,
        )

    def summarize(self, report) -> str:
        return (
            f"{self.name}: claimed={report.claimed} ok={report.succeeded} "
            f"fail={report.failed}"
        )


def _make_report_mail_adapter(services: FanoutServices) -> Any:
    return _MailThreadAdapter(
        services=services,
        name=ADAPTER_REPORT_MAIL,
        claim_status="reported",
        session_id=MAIL_SESSION_ID,
        worker_module="service.agents.report_mail_worker",
        retry_status="reported",
        timeout_env="SMB_REPORT_MAIL_WORKER_TIMEOUT_SEC",
        timeout_default=900,
        failure_retry_env="SMB_REPORT_MAIL_FAILURE_RETRY_SECONDS",
        failure_retry_default=1800,
    )


def _make_reply_verify_adapter(services: FanoutServices) -> Any:
    return _MailThreadAdapter(
        services=services,
        name=ADAPTER_REPLY_VERIFY,
        claim_status="reply_received",
        session_id=REVERIFY_SESSION_ID,
        worker_module="service.agents.reply_verify_worker",
        retry_status="reply_received",
        timeout_env="SMB_REPLY_VERIFY_WORKER_TIMEOUT_SEC",
        timeout_default=900,
        failure_retry_env="SMB_REPLY_VERIFY_FAILURE_RETRY_SECONDS",
        failure_retry_default=1800,
    )


def _register_adapters(services: FanoutServices) -> bool:
    try:
        from secu_agent.agent.fanout import register_fanout_adapter
    except ImportError:
        return False
    for name, factory in (
        (ADAPTER_REPORT_MAIL, lambda: _make_report_mail_adapter(services)),
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
            name=SMB_REPORT_MAIL_PLAN,
            phases=(Phase(
                name=PHASE_REPORT_MAIL,
                adapter=ADAPTER_REPORT_MAIL,
                k=_int_env("SMB_REPORT_MAIL_PARALLEL", 2),
            ),),
        ),
        TaskPlan(
            name=SMB_REPLY_VERIFY_PLAN,
            phases=(Phase(
                name=PHASE_REPLY_VERIFY,
                adapter=ADAPTER_REPLY_VERIFY,
                k=_int_env("SMB_REPLY_VERIFY_PARALLEL", 2),
            ),),
        ),
        TaskPlan(
            name=SMB_E2E_AGENTS_PLAN,
            phases=(
                Phase(
                    name=PHASE_REPORT_MAIL,
                    adapter=ADAPTER_REPORT_MAIL,
                    k=_int_env("SMB_REPORT_MAIL_PARALLEL", 2),
                    required=False,
                ),
                Phase(
                    name=PHASE_REPLY_VERIFY,
                    adapter=ADAPTER_REPLY_VERIFY,
                    k=_int_env("SMB_REPLY_VERIFY_PARALLEL", 2),
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
    """Register SMB E2E fanout adapters and plans into the domain-neutral core."""
    adapters = _register_adapters(services)
    plans = _register_plans()
    return adapters or plans
