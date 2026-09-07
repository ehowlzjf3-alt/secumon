"""Confluence E2E fanout adapter checks."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest


class _Runtime:
    def __init__(self, root: Path) -> None:
        self.root = root

    def make_evidence_dir(self, label: str) -> Path:
        out = self.root / label
        out.mkdir(parents=True, exist_ok=True)
        return out

    def worker_env(self) -> dict[str, str]:
        return {"PYTHONPATH": "test"}


def _assert_core_fanout_accepts_worker_result(ev_dir: Path, *, rc: int) -> None:
    from secu_agent.agent import fanout as core_fanout
    from secu_agent.agent.schema.worker_result import read_worker_result
    from secu_agent.agent.worker_pool import WorkerCompletion, WorkerSpec

    completion = WorkerCompletion(
        spec=WorkerSpec(label=ev_dir.name, argv=("python",), evidence_dir=ev_dir),
        result=read_worker_result(ev_dir),
        outcome="exited",
        rc=rc,
        pid=None,
        duration_sec=0.0,
    )

    assert core_fanout._completion_ok(completion) == (True, "ok")


# ── space 어댑터 테스트 3건은 지웠다 (2026-08-28) ───────────────────────────
# `_make_space_adapter` 가 은퇴하면서 claim/build_spec/release 테스트가 갈 곳을 잃었다.
# `test_space_worker_preflight_closes_blank_space_key_without_agent` 도 함께 지운다 —
# 그 프리플라이트가 막던 깨진 배치 행은 **배치 claim 이 사라져 만들어질 수 없다**
# (리드는 한 건씩 위임하고, space_key 는 DDL 이 NOT NULL UNIQUE 로 막는다).
#
# ⚠️ 아래 sso 테스트들은 **은퇴 대상이 아니다** — `confluence.sso_task` 는 리드 대체물이
#    없어 평면 레인 그대로 산다. 특히
#    `test_sso_gateway_reset_does_not_touch_github_target` 은 `devops_target` 을
#    github 과 공유하는 데서 오는 격리 불변식이라 계속 필요하다.


def test_sso_adapter_claims_confluence_url_only(tmp_db, tmp_path, monkeypatch) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import fanout
    from domains.services.confluence.infrastructure.runtime import ConfluenceStateGateway

    monkeypatch.setenv("DEFAULT_CHARTER_REF", "SECOPS-CONFLUENCE-SSO")
    day = dt.date.today().isoformat()
    wanted = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/OPS",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=5,
    )
    sd.devops_target_upsert(
        "https://github.samsungds.net/o/r",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=100,
    )
    services = fanout.FanoutServices(
        store=ConfluenceStateGateway(),
        runtime=_Runtime(tmp_path),
    )
    adapter = fanout._make_sso_adapter(services)

    async def _go():
        target = await adapter.claim_next()
        spec = await adapter.build_spec(target)
        return target, spec

    target, spec = asyncio.run(_go())
    payload = json.loads((spec.evidence_dir / "task_spec.json").read_text(encoding="utf-8"))

    assert int(target.payload["target"]["id"]) == wanted
    assert payload["charter_ref"] == "SECOPS-CONFLUENCE-SSO"
    assert payload["target"]["kind"] == "sso_url"
    assert payload["target"]["target_id"] == wanted
    assert payload["target"]["url"] == "https://confluence.samsungds.net/display/OPS"


def test_sso_adapter_release_preserves_worker_failure_reason(tmp_db, tmp_path, monkeypatch) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import fanout
    from domains.services.confluence.infrastructure.runtime import ConfluenceStateGateway

    monkeypatch.setenv("CONFLUENCE_SSO_FAILURE_RETRY_SECONDS", "42")
    day = dt.date.today().isoformat()
    target_id = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/FAIL",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=5,
    )
    services = fanout.FanoutServices(
        store=ConfluenceStateGateway(),
        runtime=_Runtime(tmp_path),
    )
    adapter = fanout._make_sso_adapter(services)
    completion = SimpleNamespace(
        outcome="exited",
        rc=2,
        result=SimpleNamespace(summary="reason=no_completion terminal=False"),
    )

    async def _go():
        target = await adapter.claim_next()
        before = time.time()
        await adapter.release(target, completion, success=False)
        retry = await adapter.claim_next()
        return before, retry

    before, retry = asyncio.run(_go())
    assert retry is None

    row = sd.devops_target_get(target_id)
    assert row["status"] == "pending"
    assert row["claimed_by"] is None
    assert row["claimed_at"] is None
    assert row["retry_after"] >= before + 41
    assert "exited rc=2 reason=no_completion terminal=False" in row["last_reason"]


def test_sso_gateway_reset_does_not_touch_github_target(tmp_db) -> None:
    import service.state_domain as sd
    from domains.services.confluence.infrastructure.runtime import ConfluenceStateGateway

    now = time.time()
    target_id = sd.devops_target_upsert(
        "https://github.samsungds.net/org/confluence-guard",
        service="github",
        source="proxy",
        day_bucket=dt.date.today().isoformat(),
        access_count=77,
    )
    sd.devops_target_set_status(
        target_id,
        "in_progress",
        claimed_by=999_302,
        claimed_at=now,
        last_reason="owned by github lane",
    )

    ConfluenceStateGateway().reset_sso_target(
        target_id,
        reason="confluence worker failed for forged target",
        retry_after=now + 60,
    )

    row = sd.devops_target_get(target_id)
    assert row["service"] == "github"
    assert row["status"] == "in_progress"
    assert row["claimed_by"] == 999_302
    assert row["last_reason"] == "owned by github lane"
    assert row["retry_after"] is None


def test_report_adapter_claims_thread_and_writes_worker_spec(tmp_db, tmp_path, monkeypatch) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import fanout
    from domains.services.confluence.application.contracts import (
        CONFLUENCE_REPORT_SESSION_ID,
        CONFLUENCE_REPORT_SKILL,
    )
    from domains.services.confluence.infrastructure.runtime import ConfluenceStateGateway
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="secret in page",
        extra={"metadata": {"space_key": "OPS", "page_id": "100"}},
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
    )
    monkeypatch.setenv("DEFAULT_CHARTER_REF", "SECOPS-CONFLUENCE-REPORT")
    services = fanout.FanoutServices(
        store=ConfluenceStateGateway(),
        runtime=_Runtime(tmp_path),
    )
    adapter = fanout._ConfluenceThreadAdapter(
        services=services,
        name=fanout.ADAPTER_REPORT,
        skill=CONFLUENCE_REPORT_SKILL,
        claim_status="reported",
        session_id=CONFLUENCE_REPORT_SESSION_ID,
        worker_module="service.agents.confluence_report_worker",
        retry_status="reported",
        timeout_env="CONFLUENCE_REPORT_WORKER_TIMEOUT_SEC",
        timeout_default=600,
        failure_retry_env="CONFLUENCE_REPORT_FAILURE_RETRY_SECONDS",
        failure_retry_default=1800,
    )

    async def _go():
        target = await adapter.claim_next()
        spec = await adapter.build_spec(target)
        return target, spec

    target, spec = asyncio.run(_go())
    payload = json.loads((spec.evidence_dir / "task_spec.json").read_text(encoding="utf-8"))

    assert int(target.payload["id"]) == thread_id
    assert payload["skill"] == "confluence_report"
    assert payload["charter_ref"] == "SECOPS-CONFLUENCE-REPORT"
    assert payload["target"]["space_key"] == "OPS"
    assert spec.argv[1:3] == ("-m", "service.agents.confluence_report_worker")
    assert sd.confluence_report_thread_claim_next(
        session_id=CONFLUENCE_REPORT_SESSION_ID,
        status="reported",
    ) is None


@pytest.mark.parametrize(
    ("module_name", "result_payload", "detail_file"),
    [
        (
            "service.agents.confluence_report_worker",
            {
                "finding_count": 1,
                "delivery": {"mode": "dry_run", "detail": "dry-run"},
            },
            "report_result.json",
        ),
        (
            "service.agents.confluence_recheck_worker",
            {
                "final_status": "recheck_requested",
                "retry_after": 1234567890.0,
            },
            "recheck_result.json",
        ),
    ],
)
def test_confluence_thread_workers_write_schema_result_for_completed_retryable_passes(
    tmp_path,
    monkeypatch,
    module_name,
    result_payload,
    detail_file,
) -> None:
    import importlib

    from secu_agent.agent.schema.worker_result import read_worker_result

    worker = importlib.import_module(module_name)
    ev_dir = tmp_path / module_name.rsplit(".", 1)[-1]
    ev_dir.mkdir()
    (ev_dir / "task_spec.json").write_text(
        json.dumps(
            {
                "charter_ref": "SECOPS-CONFLUENCE-WORKER",
                "target": {"id": 21, "space_key": "OPS"},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    captured = {}

    def fake_handle(thread, *, evidence_dir, charter_ref=""):
        captured["thread"] = dict(thread)
        captured["evidence_dir"] = evidence_dir
        captured["charter_ref"] = charter_ref
        return result_payload

    monkeypatch.setattr(worker, "_handle_thread", fake_handle)

    rc = worker.main([str(ev_dir)])
    result = read_worker_result(ev_dir)

    assert rc == 0
    assert captured["thread"]["space_key"] == "OPS"
    assert captured["evidence_dir"] == ev_dir
    assert captured["charter_ref"] == "SECOPS-CONFLUENCE-WORKER"
    assert result.status == "ok"
    assert result.rc == 0
    assert (ev_dir / detail_file).exists()
    _assert_core_fanout_accepts_worker_result(ev_dir, rc=rc)


@pytest.mark.parametrize("kind", ["report", "recheck"])
def test_thread_adapter_failure_backoff_prevents_same_pass_reclaim(
    tmp_db,
    tmp_path,
    monkeypatch,
    kind,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import fanout
    from domains.services.confluence.application.contracts import (
        CONFLUENCE_RECHECK_SESSION_ID,
        CONFLUENCE_RECHECK_SKILL,
        CONFLUENCE_REPORT_SESSION_ID,
        CONFLUENCE_REPORT_SKILL,
    )
    from domains.services.confluence.infrastructure.runtime import ConfluenceStateGateway
    from secu_agent import state as core_state
    from secu_agent.agent.fanout import FanoutTarget

    case = {
        "report": {
            "name": fanout.ADAPTER_REPORT,
            "skill": CONFLUENCE_REPORT_SKILL,
            "status": "reported",
            "session_id": CONFLUENCE_REPORT_SESSION_ID,
            "worker_module": "service.agents.confluence_report_worker",
            "timeout_env": "CONFLUENCE_REPORT_WORKER_TIMEOUT_SEC",
            "timeout_default": 600,
            "failure_retry_env": "CONFLUENCE_REPORT_FAILURE_RETRY_SECONDS",
        },
        "recheck": {
            "name": fanout.ADAPTER_RECHECK,
            "skill": CONFLUENCE_RECHECK_SKILL,
            "status": "recheck_requested",
            "session_id": CONFLUENCE_RECHECK_SESSION_ID,
            "worker_module": "service.agents.confluence_recheck_worker",
            "timeout_env": "CONFLUENCE_RECHECK_WORKER_TIMEOUT_SEC",
            "timeout_default": 900,
            "failure_retry_env": "CONFLUENCE_RECHECK_FAILURE_RETRY_SECONDS",
        },
    }[kind]
    monkeypatch.setenv("DEFAULT_CHARTER_REF", f"SECOPS-CONFLUENCE-{kind.upper()}")
    monkeypatch.setenv(case["failure_retry_env"], "42")
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="secret in page",
        extra={"metadata": {"space_key": "OPS", "page_id": "100"}},
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
    )
    if case["status"] != "reported":
        sd.confluence_report_thread_set_status(thread_id, case["status"])
    services = fanout.FanoutServices(
        store=ConfluenceStateGateway(),
        runtime=_Runtime(tmp_path),
    )
    adapter = fanout._ConfluenceThreadAdapter(
        services=services,
        name=case["name"],
        skill=case["skill"],
        claim_status=case["status"],
        session_id=case["session_id"],
        worker_module=case["worker_module"],
        retry_status=case["status"],
        timeout_env=case["timeout_env"],
        timeout_default=case["timeout_default"],
        failure_retry_env=case["failure_retry_env"],
        failure_retry_default=1800,
    )

    async def _go():
        target = await adapter.claim_next()
        spec = await adapter.build_spec(target)
        before = time.time()
        await adapter.release(
            FanoutTarget(label=target.label, payload=target.payload),
            None,
            success=False,
        )
        return spec, before

    spec, before = asyncio.run(_go())
    payload = json.loads((spec.evidence_dir / "task_spec.json").read_text(encoding="utf-8"))

    assert payload["charter_ref"] == f"SECOPS-CONFLUENCE-{kind.upper()}"
    assert payload["target"]["space_key"] == "OPS"
    updated = sd.confluence_report_thread_get(thread_id)
    assert updated["status"] == case["status"]
    assert updated["retry_after"] >= before + 41
    assert "worker failed before completion" in updated["last_reason"]
    assert sd.confluence_report_thread_claim_next(
        session_id=case["session_id"],
        status=case["status"],
    ) is None
