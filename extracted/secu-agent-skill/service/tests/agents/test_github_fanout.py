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


def test_github_scan_adapter_release_preserves_worker_failure_reason(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.github.application import fanout
    from domains.services.github.infrastructure.runtime import GithubStateGateway

    monkeypatch.setenv("DEFAULT_CHARTER_REF", "SECOPS-GITHUB-SCAN")
    target_id = sd.github_repo_target_upsert("org/failing", default_branch="main")
    services = fanout.FanoutServices(
        store=GithubStateGateway(),
        runtime=_Runtime(tmp_path),
    )
    adapter = fanout._make_scan_adapter(services)
    completion = SimpleNamespace(
        outcome="exited",
        rc=1,
        result=SimpleNamespace(summary="reason=max_turns terminal=False"),
    )

    async def _go():
        target = await adapter.claim_next()
        spec = await adapter.build_spec(target)
        await adapter.release(target, completion, success=False)
        return spec

    spec = asyncio.run(_go())
    payload = json.loads((spec.evidence_dir / "task_spec.json").read_text(encoding="utf-8"))

    assert payload["charter_ref"] == "SECOPS-GITHUB-SCAN"
    assert payload["target"]["repo"] == "org/failing"
    row = sd.github_repo_target_get(target_id)
    assert row["status"] == "error"
    assert row["claimed_by"] is None
    assert row["claimed_at"] is None
    assert row["finding_count"] == 0
    assert "exited rc=1 reason=max_turns terminal=False" in row["last_reason"]


# ── 결정론 스캔 경로는 삭제됐다 (2026-08-27) ─────────────────────────────────
#
# 여기 있던 4개 테스트는 `github_scan_agent._handle_target()` 의 상태 판정을 고정했다.
# 그 함수는 `scanner.scan_repo_target()` 을 직접 불러 `finding_upsert` 로 finding 을
# 썼다 — **LLM 이 한 번도 안 돌았다.** 오늘까지 github finding 27,414건이 그 경로로
# 들어왔고, 판정을 거친 것은 7건뿐이었다.
#
# 사용자 결정: 모든 finding 은 등록 전에 LLM 판정을 타야 한다. 그래서 스캔 패스는
# 이제 워커(`github_scan_worker`)를 띄우고, 판단·제출·종료는 그 안의 에이전트가 한다.
#
# ★ 없어진 동작을 고정하는 테스트를 남기면 "이 코드가 아직 그렇게 돈다" 는 거짓말이
#   된다. 지우되, **대체 경로가 같은 성질을 갖는지**는 아래에서 다시 잰다.


def test_scan_pass_spawns_a_worker_and_never_scans_inline(tmp_db, tmp_path, monkeypatch):
    """★ 패스는 스캔하지 않는다 — 워커를 띄운다."""
    import service.state_domain as sd
    from service.agents import github_scan_agent as mod

    sd.github_repo_target_upsert("org/repo", default_branch="main")
    spawned: list[dict] = []
    monkeypatch.setattr(mod, "_spawn_worker",
                        lambda target, *, charter_ref: spawned.append(target) or {
                            "target_id": int(target["id"]), "status": "ok",
                            "finding_count": 0, "reason": ""})

    res = mod.run_scan_pass(max_repos=1)

    assert len(spawned) == 1, "워커를 안 띄웠다"
    assert res["scanned"] == 1
    # 인라인 스캔 함수는 모듈에 아예 없어야 한다.
    assert not hasattr(mod, "_handle_target"), "결정론 경로가 되살아났다"
    assert not hasattr(mod, "scan_repo_target"), "스캐너를 다시 import 했다"


def test_worker_failure_releases_the_claim_as_error_not_tasked(tmp_db, tmp_path, monkeypatch):
    """★ 워커가 종료 도구를 못 불렀을 때 러너가 **대신 판단하면 안 된다.**

    `tasked` 로 닫으면 "봤다" 는 거짓 기록이 되고, 그 기록이 다음 판단의 재료가 된다.
    claim 만 풀고 `error` 로 되돌린다.
    """
    import service.state_domain as sd
    from service.agents import github_scan_agent as mod

    tid = sd.github_repo_target_upsert("org/broken", default_branch="main")
    monkeypatch.setattr(mod, "_spawn_worker",
                        lambda target, *, charter_ref: {
                            "target_id": int(target["id"]), "status": "error",
                            "finding_count": 0, "reason": "worker_result.json 없음"})

    res = mod.run_scan_pass(max_repos=1)

    assert res["errors"] == 1
    row = sd.github_repo_target_get(tid)
    assert row["status"] == "error", f"러너가 상태를 지어냈다: {row['status']}"
    assert "worker_result" in (row.get("last_reason") or "")


def test_one_pass_takes_one_batch_so_the_flag_can_take_effect(tmp_db, monkeypatch):
    """★ 예전 `while True` 는 큐가 빌 때까지 돌아 패스가 끝나지 않았다.

    `control_flag` 는 패스를 **시작할 때만** 검사한다. 끝나지 않는 패스는 플래그를
    0으로 내려도 안 멈춘다 — 실제로 08-25 에 뜬 패스가 1.5일째 `running` 이었고
    그 사이 판정 없는 finding 27,414건이 쌓였다.
    """
    import service.state_domain as sd
    from service.agents import github_scan_agent as mod

    for i in range(7):
        sd.github_repo_target_upsert(f"org/r{i}", default_branch="main")
    monkeypatch.setattr(mod, "_spawn_worker",
                        lambda target, *, charter_ref: {
                            "target_id": int(target["id"]), "status": "ok",
                            "finding_count": 0, "reason": ""})

    res = mod.run_scan_pass(batch_size=3)

    assert res["claimed"] == 3, f"한 패스가 배치를 넘겼다: {res}"


@pytest.mark.parametrize(
    ("module_name", "result_payload", "detail_file"),
    [
        (
            "service.agents.github_report_worker",
            {
                "finding_count": 2,
                "delivery": {"mode": "dry_run", "detail": "dry-run"},
            },
            "report_result.json",
        ),
        (
            "service.agents.github_recheck_worker",
            {
                "final_status": "recheck_requested",
                "retry_after": 1234567890.0,
            },
            "recheck_result.json",
        ),
    ],
)
def test_github_thread_workers_write_schema_result_for_completed_retryable_passes(
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
                "charter_ref": "SECOPS-GITHUB-WORKER",
                "target": {"id": 11, "repo": "org/repo"},
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
    assert captured["thread"]["repo"] == "org/repo"
    assert captured["evidence_dir"] == ev_dir
    assert captured["charter_ref"] == "SECOPS-GITHUB-WORKER"
    assert result.status == "ok"
    assert result.rc == 0
    assert (ev_dir / detail_file).exists()
    _assert_core_fanout_accepts_worker_result(ev_dir, rc=rc)


# ── sso 평면 어댑터 테스트 3건은 지웠다 (2026-08-28) ────────────────────────
# `_make_sso_adapter` 가 은퇴하면서 claim/build_spec/release 테스트가 갈 곳을 잃었다.
#
# ★ 다만 하나는 옮겼다. `test_github_sso_gateway_reset_does_not_touch_confluence_target`
#   이 지키던 것은 어댑터가 아니라 **공유 테이블 격리** — `devops_target` 은 github 과
#   confluence 가 같이 쓰는 큐라, 한쪽 레인이 다른 쪽 행을 건드리면 안 된다.
#   그 불변식은 지금 리드 경로에 있다(`lead_adapter._get_scoped`).
#   → `test_lead_runner_wiring.py::test_github_lead_refuses_a_confluence_target`



def test_github_report_adapter_syncs_findings_before_claim_and_skips_ownerless(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.github.application import fanout
    from domains.services.github.application.contracts import GITHUB_REPORT_SESSION_ID
    from domains.services.github.infrastructure.runtime import GithubStateGateway
    from secu_agent import state as core_state

    from service.services.finding_verification import make_agent_verification

    verified = make_agent_verification(
        method="github_e2e_api_detail_scan",
        source="github_e2e_scan",
        checks=("masked_detector_hit",),
    )
    owner_finding, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/synced/.env",
        asset_kind="repository_file",
        severity="high",
        summary="live token in repo",
        extra={
            "metadata": {
                "repo": "org/synced",
                "path": ".env",
                "owner_email": "Repo Owner <repo.owner@samsung.com>",
            },
            "agent_verification": verified,
        },
    )
    ownerless_finding, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/ownerless/.env",
        asset_kind="repository_file",
        severity="high",
        summary="ownerless live token",
        extra={
            "metadata": {"repo": "org/ownerless", "path": ".env"},
            "agent_verification": verified,
        },
    )
    monkeypatch.setenv("DEFAULT_CHARTER_REF", "SECOPS-GITHUB-REPORT")
    services = fanout.FanoutServices(
        store=GithubStateGateway(),
        runtime=_Runtime(tmp_path),
    )
    adapter = fanout._make_report_adapter(services)

    async def _go():
        target = await adapter.claim_next()
        spec = await adapter.build_spec(target)
        second = await adapter.claim_next()
        return target, spec, second

    target, spec, second = asyncio.run(_go())
    payload = json.loads((spec.evidence_dir / "task_spec.json").read_text(encoding="utf-8"))
    owner_thread = sd.github_report_thread_get(int(target.payload["id"]))
    ownerless_threads = sd.github_report_threads_overview(repo="org/ownerless")

    assert owner_thread is not None
    assert owner_thread["repo"] == "org/synced"
    assert owner_thread["owner_recipient"] == "repo.owner@samsung.com"
    assert sd.github_report_thread_finding_ids(int(owner_thread["id"])) == [owner_finding]
    assert payload["skill"] == "github_report"
    assert payload["charter_ref"] == "SECOPS-GITHUB-REPORT"
    assert payload["target"]["repo"] == "org/synced"
    assert second is None
    assert len(ownerless_threads) == 1
    assert ownerless_threads[0]["status"] == "reported"
    assert ownerless_threads[0]["owner_recipient"] in (None, "")
    assert sd.github_report_thread_finding_ids(int(ownerless_threads[0]["id"])) == [ownerless_finding]
    assert sd.github_report_thread_claim_next(
        session_id=GITHUB_REPORT_SESSION_ID,
        status="reported",
    ) is None


@pytest.mark.parametrize("kind", ["report", "recheck"])
def test_github_thread_adapter_failure_backoff_prevents_same_pass_reclaim(
    tmp_db,
    tmp_path,
    monkeypatch,
    kind,
) -> None:
    import service.state_domain as sd
    from domains.services.github.application import fanout
    from domains.services.github.application.contracts import (
        GITHUB_RECHECK_SESSION_ID,
        GITHUB_REPORT_SESSION_ID,
    )
    from domains.services.github.infrastructure.runtime import GithubStateGateway
    from secu_agent import state as core_state
    from secu_agent.agent.fanout import FanoutTarget

    case = {
        "report": {
            "name": fanout.ADAPTER_GITHUB_REPORT,
            "status": "reported",
            "session_id": GITHUB_REPORT_SESSION_ID,
            "worker_module": "service.agents.github_report_worker",
            "timeout_env": "GITHUB_REPORT_WORKER_TIMEOUT_SEC",
            "timeout_default": 600,
            "failure_retry_env": "GITHUB_REPORT_FAILURE_RETRY_SECONDS",
        },
        "recheck": {
            "name": fanout.ADAPTER_GITHUB_RECHECK,
            "status": "recheck_requested",
            "session_id": GITHUB_RECHECK_SESSION_ID,
            "worker_module": "service.agents.github_recheck_worker",
            "timeout_env": "GITHUB_RECHECK_WORKER_TIMEOUT_SEC",
            "timeout_default": 900,
            "failure_retry_env": "GITHUB_RECHECK_FAILURE_RETRY_SECONDS",
        },
    }[kind]
    monkeypatch.setenv("DEFAULT_CHARTER_REF", f"SECOPS-GITHUB-{kind.upper()}")
    monkeypatch.setenv(case["timeout_env"], "123")
    monkeypatch.setenv(case["failure_retry_env"], "42")
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repo_file",
        severity="high",
        summary="live secret",
        extra={"metadata": {"repo": "org/repo", "path": ".env"}},
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="repo.owner@samsung.com",
        owner_recipient="repo.owner@samsung.com",
        status="reported",
    )
    if case["status"] != "reported":
        sd.github_report_thread_set_status(thread_id, case["status"])
    services = fanout.FanoutServices(
        store=GithubStateGateway(),
        runtime=_Runtime(tmp_path),
    )
    adapter = fanout._GithubThreadAdapter(
        services=services,
        name=case["name"],
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

    assert spec.timeout_sec == 123
    assert payload["charter_ref"] == f"SECOPS-GITHUB-{kind.upper()}"
    assert payload["target"]["repo"] == "org/repo"
    updated = sd.github_report_thread_get(thread_id)
    assert updated["status"] == case["status"]
    assert updated["retry_after"] >= before + 41
    assert "worker failed before completion" in updated["last_reason"]
    assert sd.github_report_thread_claim_next(
        session_id=case["session_id"],
        status=case["status"],
    ) is None
