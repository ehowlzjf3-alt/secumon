from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest



@pytest.fixture(autouse=True)
def _initial_gate_open(monkeypatch):
    """이 파일은 **수신처/본문 정책**을 검증한다 — 최초 발송 게이트는 관심사가 다르다.

    게이트가 닫힌 채로 두면 모든 케이스가 `initial_closed`(수신처 없음)로 뭉개져
    정작 검증하려던 정책을 못 본다. 게이트 자체는
    `service/tests/test_initial_send_gate.py` 가 따로 고정한다(2026-08-31).
    """
    from service.services.owner_recipients import INITIAL_AUTOSEND_ENV

    monkeypatch.setenv(INITIAL_AUTOSEND_ENV, "1")

def _agent_verification() -> dict:
    from service.services.finding_verification import make_agent_verification

    return make_agent_verification(
        method="github_unit_fixture_scan",
        source="unit_test",
        checks=("candidate_detail_collected", "detector_hits_present"),
    )


def _raise_github_api_unavailable(*args, **kwargs):
    raise RuntimeError("GITHUB_BASE_URL / GITHUB_TOKEN 미설정")

# ══════════════════════════════════════════════════════════════════════════════
# 결정론 스캔 경로 테스트 49건을 지웠다 (2026-08-27)
# ══════════════════════════════════════════════════════════════════════════════
#
# `scanner.scan_repo_target()` / `_persist_scan_findings()` / `_clone_and_scan_repo()`
# 와 `github_scan_agent._handle_target()` 이 **코드에서 삭제됐다**(967줄).
#
# 그 경로는 정규식 스캔 결과를 `finding_upsert` 로 바로 DB 에 넣었다 — LLM 이 한 번도
# 안 돌았다. 오늘까지 github finding 27,414건이 그렇게 들어왔고 그중 판정을 거친 것은
# 7건뿐이었다(`high_entropy_string` 6,850 · `kr_phone` 2,692 · `credit_card` 1,044).
#
# 사용자 결정: **모든 finding 은 등록 전에 LLM 판정을 타야 한다.**
# 이제 스캔은 후보만 돌려주고, 등록은 에이전트가 `github_submit_finding` 을 부를 때
# 일어난다. 스캔 패스는 `github_scan_worker`(에이전트)를 띄운다.
#
# ★ 없어진 동작을 고정하는 테스트를 남기면 "이 코드가 아직 그렇게 돈다" 는 거짓말이
#   된다. 그래서 지웠다. 대체 경로의 성질은 다른 데서 잰다:
#
#     service/tests/agents/test_github_fanout.py          패스가 워커를 띄우는가
#     service/tests/agents/test_github_scan_worker_agent.py  우회로가 없는가
#     service/tests/agents/test_github_task_scan_tool.py  스캔이 등록을 안 하는가
#     domains/services/tests/test_service_task_scan_tools.py  후보에 판단 재료가 실리는가
# ══════════════════════════════════════════════════════════════════════════════

def test_github_recheck_body_does_not_label_unknown_as_clean() -> None:
    from domains.services.github.application import scanner

    body = scanner._github_recheck_body(
        {"repo": "org/repo"},
        {
            "repo": "org/repo",
            "final_status": "recheck_requested",
            "scan": {"head_sha": "abcdef1234567890"},
            "results": [
                {
                    "finding_id": 1,
                    "path": ".env",
                    "verdict": "unknown",
                    "verification": {
                        "method": "api_head_detail_refetch",
                        "matched": False,
                        "detail_fetched": False,
                        "status_code": 403,
                        "limit_failed": True,
                    },
                    "error": "HTTP 403 Forbidden",
                },
                {
                    "finding_id": 2,
                    "path": ".npmrc",
                    "verdict": "unknown",
                    "verification": {
                        "method": "api_head_detail_refetch",
                        "matched": False,
                        "detail_fetched": False,
                        "status_code": 401,
                        "auth_failed": True,
                    },
                    "error": "HTTP 401 Unauthorized",
                },
            ],
        },
    )

    # ⚠️ 계약 변경(2026-08-24): 재확인 회신에서 **내부 진단 문자열**(scan method·
    #    HTTP 코드·auth_failed)을 뺐다. 우리 진단이지 담당자가 할 일이 아니다 —
    #    조치요청 메일에서 `스캔 방식`·`후보 출처` 를 뺀 것과 같은 이유.
    #    ★ 이 테스트의 **본체 불변식**(unknown 을 clean 으로 표기하지 않는다)은 그대로다.
    assert "재검증 보류" in body
    assert "현재 HEAD 재확인이 보류되었습니다" in body
    # 본체: 판단 못 한 것이 "깨끗함" 으로 읽히면 안 된다.
    assert "미검출" not in body
    assert "clean" not in body
    # 내부 진단은 이제 안 나간다.
    for internal in ("api_head_detail_refetch", "detail not fetched", "HTTP 403",
                     "limit_failed", "HTTP 401", "auth_failed"):
        assert internal not in body, f"{internal!r} 는 담당자 메일에 나가지 않는다"


def test_github_report_thread_lifecycle(tmp_db) -> None:
    from service import state_domain as sd
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="medium",
        summary="GitHub file exposure",
        extra={"metadata": {"repo": "org/repo", "path": ".env"}},
    )

    action, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="medium",
        recipient="repo.owner@samsung.com",
        owner_recipient="repo.owner@samsung.com",
        status="reported",
    )
    assert action == "new"
    assert sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="medium",
        recipient="repo.owner@samsung.com",
        owner_recipient="repo.owner@samsung.com",
        status="reported",
    )[0] == "dup"

    claimed = sd.github_report_thread_claim_next(session_id=42, status="reported")
    assert claimed is not None
    assert int(claimed["id"]) == thread_id
    sd.github_report_thread_set_status(thread_id, "report_ready", report_html="<h1>org/repo</h1>")
    assert sd.github_report_thread_status_counts()["report_ready"] == 1

    sd.github_report_thread_set_status(thread_id, "recheck_requested")
    sd.github_recheck_result_add(
        thread_id=thread_id,
        finding_id=finding_id,
        repo="org/repo",
        path=".env",
        verdict="now_closed",
        verification={"method": "unit"},
    )
    assert sd.github_recheck_results_for_thread(thread_id)[0]["verdict"] == "now_closed"
    sd.github_report_thread_set_status(thread_id, "partially_remediated")
    assert sd.github_report_thread_get(thread_id)["status"] == "partially_remediated"
    sd.github_report_thread_set_status(thread_id, "owner_update_needed")
    assert sd.github_report_thread_status_counts()["owner_update_needed"] == 1


def test_github_pipeline_runner_consumes_only_github_control_flags(tmp_db, monkeypatch) -> None:
    from domains.services.github.application.contracts import (
        COMPONENT_GITHUB_DISCOVERY,
        COMPONENT_GITHUB_OWNER,
        COMPONENT_GITHUB_RECHECK,
        COMPONENT_GITHUB_REPORT,
        COMPONENT_GITHUB_SCAN,
        COMPONENT_GITHUB_SSO_TASK,
    )
    from domains.services.confluence.application.contracts import (
        COMPONENT_CONFLUENCE_SSO_DISCOVERY,
    )
    from service import state_domain as sd
    from service.agents import github_pipeline_runner as runner

    called: list[tuple[str, str | None, int | None]] = []
    monkeypatch.setattr(runner, "load_runtime_env", lambda load_plugins=True: None)
    monkeypatch.setattr(
        runner,
        "run_discovery_pass",
        lambda max_repos=None: (
            called.append((COMPONENT_GITHUB_DISCOVERY, None, max_repos)) or {"ok": "discover"}
        ),
    )
    monkeypatch.setattr(
        runner,
        "run_scan_pass",
        lambda max_repos=None: called.append((COMPONENT_GITHUB_SCAN, None, max_repos))
        or {"ok": "scan"},
    )
    # ⚠️ 담당자 패스는 조직 저장소마다 **SSO 브라우저를 연다.** 목킹을 빠뜨리면 스위트가
    #    네트워크에서 멈춘다(2026-08-30 에 실제로 5시간 넘게 정지했다).
    monkeypatch.setattr(
        runner,
        "_run_owner_pass",
        lambda org_limit=None: called.append((COMPONENT_GITHUB_OWNER, None, org_limit))
        or {"ok": "owner"},
    )
    for component in (
        COMPONENT_GITHUB_DISCOVERY,
        COMPONENT_GITHUB_SCAN,
        COMPONENT_GITHUB_SSO_TASK,
        COMPONENT_GITHUB_OWNER,
        COMPONENT_GITHUB_REPORT,
        COMPONENT_GITHUB_RECHECK,
    ):
        sd.control_flag_set(component, enabled=False, run_now=False)
    sd.control_flag_set("task", enabled=True, run_now=True)
    # ★ 메일 큐(리포트·재검증)는 2026-08-31 부터 **공용 러너**가 돈다
    #   (`service/agents/thread_pipeline_runner.py`). 켜져 있고 지금 돌라고 해도
    #   이 러너는 손대면 안 된다 — 둘이 같은 스레드를 잡는다.
    for mail_component in (COMPONENT_GITHUB_REPORT, COMPONENT_GITHUB_RECHECK):
        sd.control_flag_set(mail_component, enabled=True, run_now=True)
    sd.control_flag_set(COMPONENT_GITHUB_SCAN, enabled=False, run_now=True)
    sd.control_flag_set(COMPONENT_CONFLUENCE_SSO_DISCOVERY, enabled=False, run_now=True)

    result = runner.run_once()

    assert called == [
        (COMPONENT_GITHUB_SCAN, None, None),
    ]
    assert result == {
        COMPONENT_GITHUB_SCAN: {"ok": "scan"},
    }
    assert sd.control_flag_get(COMPONENT_GITHUB_SCAN)["run_now"] == 0
    assert sd.control_flag_get(COMPONENT_CONFLUENCE_SSO_DISCOVERY)["run_now"] == 1
    assert sd.control_flag_get("task")["run_now"] == 1


def test_github_runner_keeps_api_search_and_detail_scan_before_report(
    tmp_db,
    monkeypatch,
) -> None:
    from domains.services.github.application.contracts import (
        COMPONENT_GITHUB_DISCOVERY,
        COMPONENT_GITHUB_OWNER,
        COMPONENT_GITHUB_RECHECK,
        COMPONENT_GITHUB_REPORT,
        COMPONENT_GITHUB_SCAN,
        COMPONENT_GITHUB_SSO_TASK,
    )
    from service.agents import github_pipeline_runner as runner

    order: list[str] = []
    monkeypatch.setattr(runner, "load_runtime_env", lambda load_plugins=True: None)
    monkeypatch.setattr(
        runner,
        "run_discovery_pass",
        lambda max_repos=None: order.append(COMPONENT_GITHUB_DISCOVERY) or {"ok": "discover"},
    )
    monkeypatch.setattr(
        runner,
        "run_scan_pass",
        lambda max_repos=None: order.append(COMPONENT_GITHUB_SCAN) or {"ok": "scan"},
    )
    # ⚠️ 담당자 패스는 SSO 브라우저를 연다 — 목킹을 빠뜨리면 스위트가 네트워크에서 멈춘다.
    monkeypatch.setattr(
        runner,
        "_run_owner_pass",
        lambda org_limit=None: order.append(COMPONENT_GITHUB_OWNER) or {"ok": "owner"},
    )

    result = runner.run_once()

    # sso_task 는 빠졌다 — 평면 SSO 레인 은퇴(2026-08-28).
    # 리포트·재검증도 빠졌다 — 공용 러너로 이관(2026-08-31).
    #
    # ★ "담당자 해석은 리포트 앞" 이라는 2026-08-29 불변식은 이제 **순서로 지켜지지
    #   않는다** — 둘이 다른 프로세스다. 확인해 보니 손해는 원래 주석이 말한 그대로
    #   한 주기다: `sync_report_threads` 가 매 패스 저장소를 전량 다시 upsert 하고
    #   `owner_recipient` 를 병합하므로, 늦게 풀린 담당자는 다음 패스에 실린다.
    assert order == [
        COMPONENT_GITHUB_DISCOVERY,
        COMPONENT_GITHUB_SCAN,
        COMPONENT_GITHUB_OWNER,
    ]
    assert COMPONENT_GITHUB_REPORT not in order
    assert COMPONENT_GITHUB_RECHECK not in order
    assert COMPONENT_GITHUB_SSO_TASK not in order
    assert list(result) == order


# ── sso 플랜 패스 테스트는 지웠다 (2026-08-28) ─────────────────────────────
# `github_pipeline_runner._run_plan_pass` 와 `GITHUB_SSO_TASK_PLAN` 등록이
# 평면 SSO 레인 은퇴와 함께 사라졌다. `devops_target(service='github')` 큐의
# 시작점은 `github.lead` 다. 되찾으려면 태그 `flat-lane-last`.

def test_github_report_pass_syncs_unthreaded_finding_before_claim(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_report_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(github_report_agent, "load_runtime_env", lambda load_plugins=False: None)
    captured: dict[str, dict] = {}

    async def fake_delivery(thread, report, *, evidence_dir, charter_ref=""):
        captured["thread"] = dict(thread)
        captured["report"] = dict(report)
        sd.github_report_thread_set_status(
            int(thread["id"]),
            "awaiting_owner",
            recipient="owner.two@samsung.com",
            notified_at=123.0,
            last_reason="report mailed",
        )
        return {"mode": "sent", "recipients": ["owner.two@samsung.com"]}

    monkeypatch.setattr(github_report_agent, "deliver_report_for_thread", fake_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/synced/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {
                "repo": "org/synced",
                "path": ".env",
                "owner_email": "Owner Two <owner.two@samsung.com>",
            },
            "agent_verification": _agent_verification(),
        },
    )
    assert sd.github_report_threads_overview(repo="org/synced") == []

    result = github_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    threads = sd.github_report_threads_overview(repo="org/synced")
    assert len(threads) == 1
    thread = sd.github_report_thread_get(int(threads[0]["id"]))
    assert result["sync"]["seen"] == 1
    assert result["sync"]["new"] == 1
    assert result["sync"]["owner_recipient_count"] == 1
    assert result["sync"]["owner_missing_count"] == 0
    assert result["handled"] == 1
    assert result["sent"] == 1
    assert thread["status"] == "awaiting_owner"
    assert thread["recipient"] == "owner.two@samsung.com"
    assert thread["owner_recipient"] == "owner.two@samsung.com"
    assert sd.github_report_thread_finding_ids(int(thread["id"])) == [finding_id]
    assert captured["thread"]["owner_recipient"] == "owner.two@samsung.com"
    assert captured["report"]["finding_count"] == 1


def test_github_report_sync_skips_closed_lifecycle_findings(tmp_db) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state

    for idx, status in enumerate(("remediated", "false_positive", "accepted_risk"), start=1):
        finding_id, _ = core_state.finding_upsert(
            task_type="github",
            asset=f"github:org/closed-{idx}/.env",
            asset_kind="repository_file",
            severity="high",
            summary=f"closed GitHub finding {idx}",
            extra={
                "verification": {"status": "live_in_HEAD"},
                "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
                "metadata": {"repo": f"org/closed-{idx}", "path": ".env"},
                "agent_verification": _agent_verification(),
            },
        )
        core_state.finding_set_status(finding_id, status, reason="unit closed")

    active_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/active/.env",
        asset_kind="repository_file",
        severity="high",
        summary="active GitHub finding",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {
                "repo": "org/active",
                "path": ".env",
                "owner_email": "External Owner <owner@example.com>",
            },
            "agent_verification": _agent_verification(),
        },
    )
    core_state.finding_set_status(active_id, "triaged", reason="still active")

    sync = scanner.sync_report_threads()

    assert sync["seen"] == 1
    assert sync["new"] == 1
    assert sync["owner_recipient_count"] == 0
    assert sync["owner_missing_count"] == 1
    active_thread = sd.github_report_threads_overview(repo="org/active")[0]
    assert active_thread["status"] == "reported"
    assert active_thread["owner_recipient"] is None
    assert sd.github_report_thread_finding_ids(
        int(active_thread["id"])
    ) == [active_id]
    for idx in range(1, 4):
        assert sd.github_report_threads_overview(repo=f"org/closed-{idx}") == []


def test_github_report_sync_skips_unknown_scope_findings(tmp_db) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state

    unknown_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub finding without repo scope",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_UNKNOWN****"}],
            "metadata": {"path": ".env"},
            "agent_verification": _agent_verification(),
        },
    )
    active_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/active/.env",
        asset_kind="repository_file",
        severity="high",
        summary="active GitHub finding with repo scope",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_ACTIVE****"}],
            "metadata": {"repo": "org/active", "path": ".env"},
            "agent_verification": _agent_verification(),
        },
    )

    sync = scanner.sync_report_threads()

    assert sync["seen"] == 2
    assert sync["new"] == 1
    assert sync["skipped_unknown_scope"] == 1
    assert sd.github_report_threads_overview(repo="unknown") == []
    assert sd.github_report_threads_overview(repo="org/active")[0]["status"] == "reported"
    assert sd.github_report_thread_finding_ids(
        int(sd.github_report_threads_overview(repo="org/active")[0]["id"])
    ) == [active_id]
    assert unknown_id not in sd.github_report_thread_finding_ids(
        int(sd.github_report_threads_overview(repo="org/active")[0]["id"])
    )


def test_github_report_sync_skips_unverified_findings(tmp_db) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state

    core_state.finding_upsert(
        task_type="github",
        asset="github:org/unverified/.env",
        asset_kind="repository_file",
        severity="high",
        summary="unverified GitHub finding",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_UNVERIFIED****"}],
            "metadata": {"repo": "org/unverified", "path": ".env"},
        },
    )
    verified_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/verified/.env",
        asset_kind="repository_file",
        severity="high",
        summary="verified GitHub finding",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_VERIFIED****"}],
            "metadata": {"repo": "org/verified", "path": ".env"},
            "agent_verification": _agent_verification(),
        },
    )

    sync = scanner.sync_report_threads()

    assert sync["seen"] == 2
    assert sync["skipped_unverified"] == 1
    assert sync["new"] == 1
    assert sd.github_report_threads_overview(repo="org/unverified") == []
    thread = sd.github_report_threads_overview(repo="org/verified")[0]
    assert sd.github_report_thread_finding_ids(int(thread["id"])) == [verified_id]


def test_github_report_builder_filters_out_of_scope_findings(tmp_db) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state

    in_scope_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="in-scope GitHub secret",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_IN****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    out_scope_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:other/repo/other.env",
        asset_kind="repository_file",
        severity="critical",
        summary="out-of-scope GitHub secret",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_OUT****"}],
            "metadata": {"repo": "other/repo", "path": "other.env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=in_scope_id,
        repo="org/repo",
        severity="high",
        status="reported",
    )
    with sd.connect() as c:
        c.execute(
            "UPDATE github_report_thread SET finding_ids=? WHERE id=?",
            (json.dumps([in_scope_id, out_scope_id]), thread_id),
        )

    report = scanner.build_report_for_thread(sd.github_report_thread_get(thread_id))

    assert report["finding_count"] == 1
    assert report["out_of_scope_count"] == 1
    assert [item["id"] for item in report["findings"]] == [in_scope_id]
    assert report["findings"][0]["asset"] == "github:org/repo/.env"
    # ⚠️ 계약 변경(2026-08-24): 마스킹 값도 메일에 싣지 않는다("그릇은 보여주고 내용물은
    #    감춘다"). in-scope 판별은 **위치**로 한다 — 그게 담당자에게 남는 정보다.
    assert "<code>.env</code>" in report["html"]
    assert "ghp_IN****" not in report["html"]
    assert "ghp_OUT****" not in report["html"]
    assert "other.env" not in report["html"]
    assert "out-of-scope GitHub secret" not in report["html"]


def test_github_mark_report_ready_skips_empty_scope_filtered_report(tmp_db) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:other/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub finding outside thread repo",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_OUT****"}],
            "metadata": {"repo": "other/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        status="reported",
    )
    thread = sd.github_report_thread_get(thread_id)
    report = scanner.build_report_for_thread(thread)

    assert report["finding_count"] == 0
    assert report["out_of_scope_count"] == 1
    scanner.mark_report_ready(thread, report)

    updated = sd.github_report_thread_get(thread_id)
    assert updated["status"] == "error"
    assert updated["report_json"] == "{}"
    assert updated["report_html"] is None
    assert updated["notified_at"] is None
    assert int(updated["attempt_count"] or 0) == int(thread["attempt_count"] or 0)
    assert "no in-scope findings" in updated["last_reason"]
    assert "out_of_scope_count=1" in updated["last_reason"]


def test_github_report_renders_weekly_accumulation_for_recurring_finding(tmp_db) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="Recurring GitHub secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_RECUR****"}],
            "metadata": {
                "repo": "org/repo",
                "path": ".env",
                "scan_method": "api_code_search_detail_scan",
                "candidate_source": "code_search",
                "candidate_query": "repo:org/repo github_pat",
            },
        },
    )
    _, old_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    sd.github_report_thread_set_status(old_id, "awaiting_owner")

    action, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        status="reported",
        cycle_key="2026-W28",
    )
    assert action == "recurred"

    thread = sd.github_report_thread_get(thread_id)
    report = scanner.build_report_for_thread(thread)

    assert report["cycle_keys"] == ["2026-W27", "2026-W28"]
    assert report["accumulated_week_count"] == 2
    assert report["recurrence_count"] == 1
    # ★ 2026-08-31 규칙 변경: 재확인 문구의 근거는 **스캔 주차가 아니라 발송 횟수**다.
    #   우리가 두 주 연속 본 것과 담당자가 두 번 들은 것은 다르다.
    assert "번째 안내" not in report["html"], "발송한 적이 없으면 '이전에 안내드린' 을 말하면 안 된다"

    sd.service_reply_message_add(domain="github", direction="out", thread_id=int(thread_id),
                                 subject="s", subject_tag="[tag]", mail_from="dssoc",
                                 mail_to="owner@samsung.com", body_excerpt="b",
                                 agent_verdict="sent")
    report = scanner.build_report_for_thread(thread)
    assert "2번째 안내 · 이전 1회 안내" in report["html"]
    assert "이번 주 점검에서도 다시 확인" in report["html"]

    scanner.mark_report_ready(thread, report)
    ready_thread = sd.github_report_thread_get(thread_id)
    saved = json.loads(ready_thread["report_json"])
    assert saved["cycle_keys"] == ["2026-W27", "2026-W28"]
    assert saved["accumulated_week_count"] == 2
    assert saved["recurrence_count"] == 1
    assert "2번째 안내 · 이전 1회 안내" in ready_thread["report_html"]


def test_github_recheck_agent_does_not_mail_unknown_results(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from service.agents import github_recheck_agent
    from secu_agent import state as core_state

    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "41")
    monkeypatch.setattr(github_recheck_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(
        github_recheck_agent,
        "deliver_recheck_result_for_thread",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("unknown recheck must not mail")),
    )
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        status="recheck_requested",
    )
    monkeypatch.setattr(scanner.gh, "repo_head_sha", lambda repo, ref="HEAD": "head-api")
    monkeypatch.setattr(
        scanner.gh,
        "fetch_file_at_ref_detail",
        lambda repo, path, *, ref="HEAD": (None, "directory"),
    )

    before = time.time()
    result = github_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["handled"] == 1
    assert result["retryable"] == 1
    assert result["sent"] == 0
    assert result["dry_run"] == 0
    updated = sd.github_report_thread_get(thread_id)
    assert updated["status"] == "recheck_requested"
    assert "unknown results" in updated["last_reason"]
    assert updated["retry_after"] >= before + 40
    assert int(updated["attempt_count"] or 0) == 1
    assert sd.service_reply_messages_for_thread("github", thread_id) == []

    second = github_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )
    assert second["handled"] == 0


def test_github_recheck_empty_structured_results_stays_retryable(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        status="recheck_requested",
    )
    with sd.connect() as c:
        c.execute("UPDATE github_report_thread SET finding_ids='[]' WHERE id=?", (thread_id,))
    thread = sd.github_report_thread_get(thread_id)
    monkeypatch.setattr(scanner.gh, "repo_head_sha", lambda repo, ref="HEAD": "head-api")
    monkeypatch.setattr(
        scanner.gh,
        "fetch_file_at_ref_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("no finding rows means no detail fetch")
        ),
    )

    result = scanner.recheck_thread(thread, evidence_dir=tmp_path)

    assert result["final_status"] == "recheck_requested"
    assert result["results"] == []
    assert sd.github_report_thread_get(thread_id)["status"] == "recheck_requested"
    assert core_state.finding_get(finding_id)["status"] != "remediated"
    assert sd.github_recheck_results_for_thread(thread_id) == []


def test_github_recheck_delivery_skips_empty_structured_results(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state

    async def fail_deliver(*args, **kwargs):
        raise AssertionError("empty recheck results must not be mailed")

    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "37")
    monkeypatch.setattr(scanner, "deliver", fail_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        status="recheck_requested",
    )
    thread = sd.github_report_thread_get(thread_id)
    before = time.time()

    delivery = asyncio.run(
        scanner.deliver_recheck_result_for_thread(
            thread,
            {
                "repo": "org/repo",
                "thread_id": thread_id,
                "final_status": "remediated",
                "results": [],
            },
            evidence_dir=tmp_path,
            charter_ref="SECOPS-TEST",
        )
    )

    updated = sd.github_report_thread_get(thread_id)
    assert delivery["mode"] == "skipped_retryable_recheck"
    assert delivery["policy"] == "blocked_retryable_recheck"
    assert delivery["final_status"] == "recheck_requested"
    assert delivery["retry_after"] >= before + 36
    assert updated["status"] == "recheck_requested"
    assert "no conclusive structured results" in updated["last_reason"]
    assert core_state.finding_get(finding_id)["status"] != "remediated"
    assert sd.service_reply_messages_for_thread("github", thread_id) == []


def test_github_recheck_direct_finalize_requires_sent_delivery(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        status="recheck_requested",
    )
    thread = sd.github_report_thread_get(thread_id)
    monkeypatch.setattr(scanner.gh, "repo_head_sha", lambda repo, ref="HEAD": "head-api")
    monkeypatch.setattr(
        scanner.gh,
        "fetch_file_at_ref_detail",
        lambda repo, path, *, ref="HEAD": ("clean file", None),
    )

    before = time.time()
    result = scanner.recheck_thread(thread, evidence_dir=tmp_path)

    updated = sd.github_report_thread_get(thread_id)
    assert result["final_status"] == "recheck_requested"
    assert result["results"][0]["verdict"] == "now_closed"
    assert updated["status"] == "recheck_requested"
    assert updated["retry_after"] >= before
    assert "blocked until result mail is sent" in updated["last_reason"]
    assert core_state.finding_get(finding_id)["status"] != "remediated"
    assert sd.service_reply_messages_for_thread("github", thread_id) == []


def test_github_recheck_agent_delivery_error_schedules_retry(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_recheck_agent
    from secu_agent import state as core_state

    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "41")
    monkeypatch.setattr(github_recheck_agent, "load_runtime_env", lambda load_plugins=False: None)

    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={"metadata": {"repo": "org/repo", "path": ".env"}},
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        status="recheck_requested",
    )
    monkeypatch.setattr(
        github_recheck_agent,
        "recheck_thread",
        lambda thread, *, evidence_dir, finalize=False, charter_ref="": {
            "thread_id": thread["id"],
            "repo": thread["repo"],
            "final_status": "still_open",
            "results": [],
        },
    )

    async def fail_delivery(*args, **kwargs):
        raise RuntimeError("knox mail unavailable")

    monkeypatch.setattr(
        github_recheck_agent,
        "deliver_recheck_result_for_thread",
        fail_delivery,
    )

    before = time.time()
    result = github_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["handled"] == 1
    assert result["retryable"] == 1
    assert result["sent"] == 0
    assert result["dry_run"] == 0
    updated = sd.github_report_thread_get(thread_id)
    assert updated["status"] == "recheck_requested"
    assert "delivery failed" in updated["last_reason"]
    assert updated["retry_after"] >= before + 40
    assert int(updated["attempt_count"] or 0) == 1

    second = github_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )
    assert second["handled"] == 0


def test_github_recheck_agent_pass_exception_schedules_retry(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_recheck_agent
    from secu_agent import state as core_state

    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "41")
    monkeypatch.setattr(github_recheck_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(
        github_recheck_agent,
        "run_guidance_pass",
        lambda *args, **kwargs: {"handled": 0, "sent": 0, "dry_run": 0, "errors": 0},
    )

    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={"metadata": {"repo": "org/repo", "path": ".env"}},
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        status="recheck_requested",
    )

    def fail_recheck(*args, **kwargs):
        raise RuntimeError("github recheck parser exploded")

    async def fail_delivery(*args, **kwargs):
        raise AssertionError("delivery must not run after recheck exception")

    monkeypatch.setattr(github_recheck_agent, "recheck_thread", fail_recheck)
    monkeypatch.setattr(
        github_recheck_agent,
        "deliver_recheck_result_for_thread",
        fail_delivery,
    )

    before = time.time()
    result = github_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["handled"] == 1
    assert result["errors"] == 1
    assert result["retryable"] == 1
    updated = sd.github_report_thread_get(thread_id)
    assert updated["status"] == "recheck_requested"
    assert "recheck pass failed" in updated["last_reason"]
    assert "github recheck parser exploded" in updated["last_reason"]
    assert updated["retry_after"] >= before + 40
    assert int(updated["attempt_count"] or 0) == 1
    assert sd.github_report_thread_claim_next(
        session_id=12345,
        status="recheck_requested",
    ) is None

    second = github_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )
    assert second["handled"] == 0


def test_github_recheck_attempt_cap_escalates_without_recheck_or_delivery(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_recheck_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(github_recheck_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(
        github_recheck_agent,
        "run_guidance_pass",
        lambda *args, **kwargs: {"handled": 0, "sent": 0, "dry_run": 0, "errors": 0},
    )
    monkeypatch.setattr(
        github_recheck_agent,
        "recheck_thread",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attempt-capped thread must not recheck")
        ),
    )

    async def fail_delivery(*args, **kwargs):
        raise AssertionError("attempt-capped thread must not deliver")

    monkeypatch.setattr(github_recheck_agent, "deliver_recheck_result_for_thread", fail_delivery)

    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={"metadata": {"repo": "org/repo", "path": ".env"}},
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        status="recheck_requested",
    )
    with sd.connect() as c:
        c.execute("UPDATE github_report_thread SET attempt_count=5 WHERE id=?", (thread_id,))

    result = github_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    updated = sd.github_report_thread_get(thread_id)
    assert result["handled"] == 1
    assert result["escalated"] == 1
    assert result["retryable"] == 0
    assert result["errors"] == 0
    assert updated["status"] == "escalated"
    assert updated["claimed_by"] is None
    assert updated["claimed_at"] is None
    assert updated["last_reason"] == "github recheck attempt cap exceeded"
    assert int(updated["attempt_count"] or 0) == 5
    assert sd.github_recheck_results_for_thread(thread_id) == []
    assert sd.service_reply_messages_for_thread("github", thread_id) == []
    assert core_state.finding_get(finding_id)["status"] != "remediated"


def test_github_recheck_pass_counts_partially_remediated(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_recheck_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(github_recheck_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(
        github_recheck_agent,
        "run_guidance_pass",
        lambda *args, **kwargs: {"handled": 0, "sent": 0, "dry_run": 0, "errors": 0},
    )

    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={"metadata": {"repo": "org/repo", "path": ".env"}},
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        status="recheck_requested",
    )

    def fake_handle(thread, *, evidence_dir=None, charter_ref=""):
        sd.github_report_thread_set_status(int(thread["id"]), "partially_remediated")
        return {
            "thread_id": thread["id"],
            "repo": thread["repo"],
            "final_status": "partially_remediated",
            "delivery": {"mode": "sent"},
        }

    monkeypatch.setattr(github_recheck_agent, "_handle_thread", fake_handle)

    result = github_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["handled"] == 1
    assert result["partially_remediated"] == 1
    assert result["remediated"] == 0
    assert result["still_open"] == 0
    assert result["retryable"] == 0
    assert result["sent"] == 1
    assert sd.github_report_thread_get(thread_id)["status"] == "partially_remediated"


def test_github_recheck_delivery_ignores_inbound_before_latest_outbound(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("GITHUB_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["payload"] = payload
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(scanner, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        status="recheck_requested",
    )
    sd.github_report_thread_set_status(
        thread_id,
        "recheck_requested",
        notified_at=200.0,
        recipient="dssoc@samsung.com",
    )
    sd.service_reply_message_add(
        domain="github",
        direction="in",
        thread_id=thread_id,
        message_id="github-stale-howto",
        references_header="<report-root> <github-stale-howto>",
        root_message_id="report-root",
        subject="RE: [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청",
        subject_tag="[GitHub 보안취약점 조치요청](org/repo)",
        mail_from="Owner One <owner.one@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>",
        body_excerpt="조치 방법 문의",
        agent_verdict="classified_how_to_question",
        received_at=250.0,
    )
    sd.service_reply_message_add(
        domain="github",
        direction="out",
        thread_id=thread_id,
        subject="RE:(2) [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청",
        subject_tag="[GitHub 보안취약점 조치요청](org/repo)",
        mail_from="dssoc",
        mail_to="owner.one@samsung.com",
        body_excerpt="<p>how-to guidance</p>",
        body_html="<p>how-to guidance</p>",
        agent_verdict="sent",
        decision_reason="outbound_how_to_guidance",
        received_at=300.0,
    )
    thread = sd.github_report_thread_get(thread_id)

    delivery = asyncio.run(
        scanner.deliver_recheck_result_for_thread(
            thread,
            {
                "repo": "org/repo",
                "thread_id": thread_id,
                "scan": {"head_sha": "def456"},
                "results": [{
                    "finding_id": finding_id,
                    "path": ".env",
                    "verdict": "now_closed",
                    "verification": {
                        "method": "api_head_detail_refetch",
                        "matched": False,
                        "detail_fetched": True,
                    },
                }],
            },
            evidence_dir=tmp_path,
        )
    )

    payload = captured["payload"]
    assert delivery["mode"] == "sent"
    # 라벨 변경: "dssoc_only" → "dry_run"(수신처 동일, 뜻이 분명해졌다).
    assert delivery["policy"] == "dry_run"
    assert payload.recipients == ("dssoc@samsung.com",)
    assert "--------- Original Message ---------" not in payload.body
    assert "reply_message_id" not in payload.metadata
    assert "in_reply_to" not in payload.metadata
    updated = sd.github_report_thread_get(thread_id)
    assert updated["status"] == "remediated"
    assert updated["recipient"] == "dssoc@samsung.com"
    messages = sd.service_reply_messages_for_thread("github", thread_id)
    assert [m["direction"] for m in messages] == ["in", "out", "out"]
    outbound = messages[-1]
    assert outbound["decision_reason"] == "outbound_recheck_result_notice"
    assert outbound["mail_to"] == "dssoc@samsung.com"
    assert outbound["in_reply_to"] is None
    assert outbound["references_header"] is None
    assert outbound["root_message_id"] is None
    assert "--------- Original Message ---------" not in outbound["body_html"]


def test_github_report_delivery_defaults_to_dssoc_and_awaits_on_sent(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("GITHUB_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    monkeypatch.delenv("GITHUB_REMEDIATION_MAIL_MODE", raising=False)
    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["sink_id"] = sink_id
        captured["payload"] = payload
        captured["charter_ref"] = charter_ref
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(scanner, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        status="reported",
    )
    thread = sd.github_report_thread_get(thread_id)
    report = scanner.build_report_for_thread(thread)
    scanner.mark_report_ready(thread, report)

    result = asyncio.run(
        scanner.deliver_report_for_thread(
            thread,
            report,
            evidence_dir=tmp_path,
            charter_ref="SECOPS-TEST",
        )
    )

    updated = sd.github_report_thread_get(thread_id)
    payload = captured["payload"]
    assert result["mode"] == "sent"
    assert captured["sink_id"] == "knox_mail"
    assert captured["charter_ref"] == "SECOPS-TEST"
    assert payload.recipients == ("dssoc@samsung.com",)
    assert payload.cc == ()
    assert payload.metadata["requested_recipients"] == ["owner@samsung.com"]
    # ⚠️ 라벨이 바뀌었다: "dssoc_only" → "dry_run". 수신처는 동일(DSSOC)하고 **뜻이 분명해졌다** —
    #    예전 이름은 "DSSOC 에게만 보내는 정책" 처럼 읽혔는데, 실제 조건은 "자율발송이 꺼져
    #    있어 어차피 안 나간다" 다. 정책상 DSSOC 로만 실발송하는 상태는 이제 없다.
    assert payload.metadata["delivery_policy"] == "dry_run"
    assert updated["status"] == "awaiting_owner"
    assert updated["recipient"] == "dssoc@samsung.com"
    assert updated["owner_recipient"] == "owner@samsung.com"
    assert updated["notified_at"] is not None
    messages = sd.service_reply_messages_for_thread("github", thread_id)
    assert len(messages) == 1
    assert messages[0]["direction"] == "out"
    assert messages[0]["agent_verdict"] == "sent"
    assert messages[0]["decision_reason"] == "outbound_report_notice"
    assert messages[0]["mail_from"] == "dssoc"
    assert messages[0]["mail_to"] == "dssoc@samsung.com"
    assert messages[0]["mail_cc"] is None
    assert messages[0]["subject_tag"] == "[GitHub 보안취약점 조치요청](org/repo)"
    # ★ 제목 앞에 티켓 번호가 붙는다(회신 매칭 1차 키, 2026-08-31).
    # ★ 티켓 번호는 태그 바로 뒤 괄호에 온다(2026-08-31 형식 통일).
    subj = messages[0]["subject"]
    assert "[GitHub 보안취약점 조치요청](GH" in subj, subj
    assert subj.endswith("(org/repo) 소스코드 시크릿 조치 요청"), subj
    assert messages[0]["body_html"] == messages[0]["body_excerpt"]
    assert "org/repo" in messages[0]["body_html"]


def test_github_report_pass_waits_for_owner_recipient_before_delivery(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_report_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(github_report_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(github_report_agent, "sync_report_threads", lambda: {"synced": 0})

    monkeypatch.setattr(
        github_report_agent,
        "build_report_for_thread",
        lambda thread: (_ for _ in ()).throw(
            AssertionError("ownerless reported thread must not build a report")
        ),
    )

    async def fail_delivery(*args, **kwargs):
        raise AssertionError("ownerless reported thread must not deliver")

    monkeypatch.setattr(github_report_agent, "deliver_report_for_thread", fail_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/missing-owner/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure without owner",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/missing-owner", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/missing-owner",
        severity="high",
        status="reported",
    )

    result = github_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    updated = sd.github_report_thread_get(thread_id)
    assert result["handled"] == 0
    assert result["reports"] == 0
    assert result["sent"] == 0
    assert result["dry_run"] == 0
    assert result["errors"] == 0
    assert updated["status"] == "reported"
    assert updated["owner_recipient"] is None
    assert updated["claimed_by"] is None
    assert updated["claimed_at"] is None
    assert updated["notified_at"] is None
    assert sd.service_reply_messages_for_thread("github", thread_id) == []


def test_github_report_delivery_dry_run_stays_report_ready(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("GITHUB_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    monkeypatch.delenv("GITHUB_REMEDIATION_MAIL_MODE", raising=False)
    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["sink_id"] = sink_id
        captured["payload"] = payload
        captured["charter_ref"] = charter_ref
        return DeliveryResult(
            sink_id=sink_id,
            mode="dry_run",
            detail="dry-run draft created",
            draft_path=str(tmp_path / "draft.json"),
        )

    monkeypatch.setattr(scanner, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        status="reported",
    )
    thread = sd.github_report_thread_get(thread_id)
    report = scanner.build_report_for_thread(thread)
    scanner.mark_report_ready(thread, report)

    result = asyncio.run(
        scanner.deliver_report_for_thread(
            thread,
            report,
            evidence_dir=tmp_path,
            charter_ref="SECOPS-TEST",
        )
    )

    updated = sd.github_report_thread_get(thread_id)
    payload = captured["payload"]
    assert result["mode"] == "dry_run"
    assert captured["sink_id"] == "knox_mail"
    assert captured["charter_ref"] == "SECOPS-TEST"
    assert payload.recipients == ("dssoc@samsung.com",)
    assert payload.cc == ()
    assert payload.metadata["requested_recipients"] == ["owner@samsung.com"]
    # ⚠️ 라벨이 바뀌었다: "dssoc_only" → "dry_run". 수신처는 동일(DSSOC)하고 **뜻이 분명해졌다** —
    #    예전 이름은 "DSSOC 에게만 보내는 정책" 처럼 읽혔는데, 실제 조건은 "자율발송이 꺼져
    #    있어 어차피 안 나간다" 다. 정책상 DSSOC 로만 실발송하는 상태는 이제 없다.
    assert payload.metadata["delivery_policy"] == "dry_run"
    assert updated["status"] == "report_ready"
    assert updated["notified_at"] is None
    assert "dry-run draft" in updated["last_reason"]
    assert sd.service_reply_messages_for_thread("github", thread_id) == []


def test_github_report_delivery_skips_empty_scope_filtered_report(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state

    async def fail_deliver(*args, **kwargs):
        raise AssertionError("empty report must not call deliver")

    monkeypatch.setattr(scanner, "deliver", fail_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:other/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub finding outside thread repo",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_OUT****"}],
            "metadata": {"repo": "other/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        status="reported",
    )
    thread = sd.github_report_thread_get(thread_id)
    report = scanner.build_report_for_thread(thread)

    result = asyncio.run(
        scanner.deliver_report_for_thread(
            thread,
            report,
            evidence_dir=tmp_path,
            charter_ref="SECOPS-TEST",
        )
    )

    updated = sd.github_report_thread_get(thread_id)
    assert result["mode"] == "skipped_empty_report"
    assert result["policy"] == "blocked_empty_report"
    assert result["attached_replies"] == 0
    assert "no in-scope findings" in result["detail"]
    assert updated["status"] == "error"
    assert updated["report_json"] == "{}"
    assert updated["report_html"] is None
    assert updated["notified_at"] is None
    assert "out_of_scope_count=1" in updated["last_reason"]
    assert sd.service_reply_messages_for_thread("github", thread_id) == []


def test_github_report_delivery_normal_mode_filters_external_owner_recipients(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("GITHUB_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    monkeypatch.setenv("GITHUB_REMEDIATION_MAIL_MODE", "normal")
    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["payload"] = payload
        return DeliveryResult(
            sink_id=sink_id,
            mode="dry_run",
            detail="dry-run draft created",
            draft_path=str(tmp_path / "draft.json"),
        )

    monkeypatch.setattr(scanner, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient=(
            "Owner One <owner.one@samsung.com>, attacker@example.com, "
            "owner.two@partner.samsung.com, dssoc@samsung.com"
        ),
        status="reported",
    )
    thread = sd.github_report_thread_get(thread_id)
    report = scanner.build_report_for_thread(thread)

    result = asyncio.run(scanner.deliver_report_for_thread(thread, report, evidence_dir=tmp_path))

    payload = captured["payload"]
    assert result["mode"] == "dry_run"
    assert payload.recipients == ("owner.one@samsung.com", "owner.two@partner.samsung.com")
    assert payload.cc == ("dssoc@samsung.com",)
    assert payload.metadata["requested_recipients"] == [
        "owner.one@samsung.com",
        "owner.two@partner.samsung.com",
    ]
    assert payload.metadata["delivery_policy"] == "normal"


def test_github_report_delivery_attaches_preexisting_reply(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("GITHUB_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(scanner, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        status="reported",
    )
    sd.service_reply_message_add(
        domain="github",
        direction="in",
        thread_id=None,
        message_id="preexisting-github-reply",
        subject="[GitHub 보안취약점 조치요청](org/repo)",
        subject_tag="[GitHub 보안취약점 조치요청](org/repo)",
        mail_from="owner@samsung.com",
        mail_to="dssoc@samsung.com",
        body_excerpt="조치완료했습니다.",
        agent_verdict="classified_remediation_claim",
        decision_reason="답장 신규 본문에서 조치 완료 주장을 확인함",
        received_at=1001.0,
    )
    thread = sd.github_report_thread_get(thread_id)
    report = scanner.build_report_for_thread(thread)
    scanner.mark_report_ready(thread, report)
    monkeypatch.setattr(scanner.time, "time", lambda: 1000.0)

    result = asyncio.run(scanner.deliver_report_for_thread(thread, report, evidence_dir=tmp_path))

    updated = sd.github_report_thread_get(thread_id)
    assert result["mode"] == "sent"
    assert result["attached_replies"] == 1
    assert updated["status"] == "recheck_requested"
    assert "pre-existing inbound replies attached: 1" in updated["last_reason"]
    messages = sd.service_reply_messages_for_thread("github", thread_id)
    assert [m["direction"] for m in messages] == ["out", "in"]
    assert messages[1]["message_id"] == "preexisting-github-reply"


def test_github_report_delivery_does_not_attach_stale_unmatched_reply(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.github.application import scanner
    from service import state_domain as sd
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("GITHUB_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(scanner, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        status="reported",
    )
    sd.service_reply_message_add(
        domain="github",
        direction="in",
        thread_id=None,
        message_id="stale-github-reply",
        subject="[GitHub 보안취약점 조치요청](org/repo)",
        subject_tag="[GitHub 보안취약점 조치요청](org/repo)",
        mail_from="owner@samsung.com",
        mail_to="dssoc@samsung.com",
        body_excerpt="조치완료했습니다.",
        agent_verdict="classified_remediation_claim",
        decision_reason="답장 신규 본문에서 조치 완료 주장을 확인함",
        received_at=999.0,
    )
    thread = sd.github_report_thread_get(thread_id)
    report = scanner.build_report_for_thread(thread)
    scanner.mark_report_ready(thread, report)
    monkeypatch.setattr(scanner.time, "time", lambda: 1000.0)

    result = asyncio.run(scanner.deliver_report_for_thread(thread, report, evidence_dir=tmp_path))

    updated = sd.github_report_thread_get(thread_id)
    assert result["mode"] == "sent"
    assert result["attached_replies"] == 0
    assert updated["status"] == "awaiting_owner"
    with sd.connect() as c:
        row = c.execute(
            "SELECT thread_id FROM service_reply_message WHERE message_id=?",
            ("stale-github-reply",),
        ).fetchone()
    assert row["thread_id"] is None


def test_github_report_pass_invokes_delivery_result(tmp_db, tmp_path, monkeypatch) -> None:
    from service import state_domain as sd
    from service.agents import github_report_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(github_report_agent, "load_runtime_env", lambda load_plugins=False: None)

    async def fake_delivery(thread, report, *, evidence_dir, charter_ref=""):
        sd.github_report_thread_set_status(
            int(thread["id"]),
            "awaiting_owner",
            recipient="dssoc@samsung.com",
            notified_at=123.0,
            last_reason="report mailed",
        )
        return {"mode": "sent", "recipients": ["dssoc@samsung.com"]}

    monkeypatch.setattr(github_report_agent, "deliver_report_for_thread", fake_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        status="reported",
    )

    result = github_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["sent"] == 1
    assert result["dry_run"] == 0
    assert sd.github_report_thread_get(thread_id)["status"] == "awaiting_owner"


def test_github_report_pass_counts_dry_run_without_sending(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_report_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(github_report_agent, "load_runtime_env", lambda load_plugins=False: None)

    async def fake_delivery(thread, report, *, evidence_dir, charter_ref=""):
        sd.github_report_thread_set_status(
            int(thread["id"]),
            "report_ready",
            last_reason="dry-run draft created",
        )
        return {"mode": "dry_run", "recipients": ["dssoc@samsung.com"]}

    monkeypatch.setattr(github_report_agent, "deliver_report_for_thread", fake_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        status="reported",
    )

    result = github_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    updated = sd.github_report_thread_get(thread_id)
    assert result["handled"] == 1
    assert result["reports"] == 1
    assert result["sent"] == 0
    assert result["dry_run"] == 1
    assert updated["status"] == "report_ready"
    assert updated["notified_at"] is None
    assert "dry-run draft" in updated["last_reason"]
    assert sd.service_reply_messages_for_thread("github", thread_id) == []


def test_github_report_pass_counts_delivery_error_without_sending(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_report_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(github_report_agent, "load_runtime_env", lambda load_plugins=False: None)

    async def fail_delivery(thread, report, *, evidence_dir, charter_ref=""):
        raise RuntimeError("knox mail unavailable")

    monkeypatch.setattr(github_report_agent, "deliver_report_for_thread", fail_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        status="reported",
    )

    result = github_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    updated = sd.github_report_thread_get(thread_id)
    assert result["handled"] == 1
    assert result["reports"] == 1
    assert result["sent"] == 0
    assert result["dry_run"] == 0
    assert result["errors"] == 1
    assert updated["status"] == "report_ready"
    assert updated["notified_at"] is None
    assert "delivery failed" in updated["last_reason"]
    assert "knox mail unavailable" in updated["last_reason"]
    assert sd.service_reply_messages_for_thread("github", thread_id) == []


def test_github_report_pass_skips_empty_scope_filtered_report(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_report_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(github_report_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(github_report_agent, "sync_report_threads", lambda: {"synced": 0})

    async def fail_delivery(*args, **kwargs):
        raise AssertionError("empty report must not be delivered")

    monkeypatch.setattr(github_report_agent, "deliver_report_for_thread", fail_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:other/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub finding outside thread repo",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_OUT****"}],
            "metadata": {"repo": "other/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        status="reported",
    )

    result = github_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    updated = sd.github_report_thread_get(thread_id)
    assert result["handled"] == 1
    assert result["reports"] == 0
    assert result["sent"] == 0
    assert result["dry_run"] == 0
    assert result["skipped_empty"] == 1
    assert result["errors"] == 0
    assert updated["status"] == "error"
    assert "no in-scope findings" in updated["last_reason"]
    assert "out_of_scope_count=1" in updated["last_reason"]
    assert updated["report_html"] is None
    assert sd.service_reply_messages_for_thread("github", thread_id) == []


def test_github_report_pass_exception_schedules_retry(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_report_agent
    from secu_agent import state as core_state

    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "41")
    monkeypatch.setattr(github_report_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(
        github_report_agent,
        "build_report_for_thread",
        lambda thread: (_ for _ in ()).throw(RuntimeError("github report renderer exploded")),
    )

    async def fail_delivery(*args, **kwargs):
        raise AssertionError("delivery must not run after report build exception")

    monkeypatch.setattr(github_report_agent, "deliver_report_for_thread", fail_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="github",
        asset="github:org/repo/.env",
        asset_kind="repository_file",
        severity="high",
        summary="GitHub HEAD secret exposure",
        extra={
            "verification": {"status": "live_in_HEAD"},
            "hits": [{"kind": "github_pat", "masked": "ghp_****"}],
            "metadata": {"repo": "org/repo", "path": ".env"},
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        status="reported",
    )

    before = time.time()
    result = github_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    updated = sd.github_report_thread_get(thread_id)
    assert result["handled"] == 1
    assert result["reports"] == 0
    assert result["errors"] == 1
    assert updated["status"] == "reported"
    assert "report pass failed" in updated["last_reason"]
    assert "github report renderer exploded" in updated["last_reason"]
    assert updated["retry_after"] >= before + 40
    assert sd.github_report_thread_claim_next(session_id=12345, status="reported") is None

    second = github_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )
    assert second["handled"] == 0
