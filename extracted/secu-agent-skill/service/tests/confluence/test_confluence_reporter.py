"""Confluence E2E report/recheck service checks."""
from __future__ import annotations

import pytest

import asyncio
import json
import time
from pathlib import Path



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
        method="confluence_unit_fixture_scan",
        source="unit_test",
        checks=("candidate_detail_collected", "detector_hits_present"),
    )


def test_confluence_recheck_body_does_not_label_unknown_as_clean() -> None:
    from domains.services.confluence.application import reporter

    body = reporter._confluence_recheck_body(
        {"space_key": "OPS"},
        {
            "space_key": "OPS",
            "final_status": "recheck_requested",
            "results": [
                {
                    "finding_id": 1,
                    "asset": "confluence:OPS:100",
                    "verdict": "unknown",
                    "verification": {
                        "method": "confluence_surface_refetch",
                        "matched": False,
                        "surface_count": 0,
                        "surface_labels": [],
                        "status_code": 403,
                        "limit_failed": True,
                    },
                    "error": "HTTP 403 Forbidden",
                },
                {
                    "finding_id": 2,
                    "asset": "confluence:OPS:101",
                    "verdict": "unknown",
                    "verification": {
                        "method": "confluence_surface_refetch",
                        "matched": False,
                        "surface_count": 0,
                        "surface_labels": [],
                        "status_code": 401,
                        "auth_failed": True,
                    },
                    "error": "HTTP 401 Unauthorized",
                },
            ],
        },
    )

    # ⚠️ 계약 변경(2026-08-24): 재확인 회신에서 **내부 진단 문자열**(scan method·HTTP 코드·
    #    auth_failed)을 뺐다. 우리 진단이지 담당자가 할 일이 아니다.
    #    ★ 본체 불변식(unknown 을 clean 으로 표기하지 않는다)은 그대로다.
    assert "재검증 보류" in body
    assert "현재 콘텐츠 재확인이 보류되었습니다" in body
    assert "미검출" not in body
    assert "clean" not in body
    for internal in ("confluence_surface_refetch", "HTTP 403", "limit_failed",
                     "HTTP 401", "auth_failed"):
        assert internal not in body, f"{internal!r} 는 담당자 메일에 나가지 않는다"


def test_confluence_report_thread_lifecycle(tmp_db) -> None:
    import service.state_domain as sd
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="medium",
        summary="Confluence page exposure",
        extra={"metadata": {"space_key": "OPS", "page_id": "100"}},
    )

    action, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="medium",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
    )
    assert action == "new"
    assert sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="medium",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
    )[0] == "dup"

    claimed = sd.confluence_report_thread_claim_next(session_id=42, status="reported")
    assert claimed is not None
    assert int(claimed["id"]) == thread_id
    sd.confluence_report_thread_set_status(thread_id, "report_ready", report_html="<h1>OPS</h1>")
    assert sd.confluence_report_thread_status_counts()["report_ready"] == 1

    sd.confluence_report_thread_set_status(thread_id, "recheck_requested")
    sd.confluence_recheck_result_add(
        thread_id=thread_id,
        finding_id=finding_id,
        space_key="OPS",
        asset="confluence:OPS:100",
        verdict="now_closed",
        verification={"method": "unit"},
    )
    assert sd.confluence_recheck_results_for_thread(thread_id)[0]["verdict"] == "now_closed"
    sd.confluence_report_thread_set_status(thread_id, "partially_remediated")
    assert sd.confluence_report_thread_get(thread_id)["status"] == "partially_remediated"
    sd.confluence_report_thread_set_status(thread_id, "owner_update_needed")
    assert sd.confluence_report_thread_status_counts()["owner_update_needed"] == 1


def test_confluence_reporter_sync_build_and_recheck(tmp_db, tmp_path, monkeypatch) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {
                "space_key": "OPS",
                "page_id": "100",
                "title": "Runbook",
                "scan_method": "api_cql_search_detail_scan",
                "candidate_source": "space_cql",
                "candidate_query": 'space = "OPS" AND type = page AND text ~ "password"',
            },
            "recommended_actions": ["move value to secret storage"],
            "agent_verification": _agent_verification(),
        },
    )

    sync = reporter.sync_report_threads()
    assert sync["seen"] == 1
    thread = sd.confluence_report_threads_overview(space_key="OPS")[0]
    assert thread["status"] == "reported"

    report = reporter.build_report_for_thread(thread)
    assert report["space_key"] == "OPS"
    assert report["finding_count"] == 1
    assert report["findings"][0]["scan_trace"] == {
        "scan_method": "api_cql_search_detail_scan",
        "candidate_source": "space_cql",
        "candidate_query": 'space = "OPS" AND type = page AND text ~ "password"',
    }
    # ⚠️ 계약 변경(2026-08-24): 마스킹 값·스캔 방식·후보 질의 전부 메일에서 뺐다.
    #    특히 CQL 질의에는 검색어("password")가 들어 있어 우리 탐지 방식을 그대로 노출한다.
    #    `report_json` 에는 남는다 — 줄이는 건 메일 본문뿐이다.
    for internal in ("sk_live_****", "api_cql_search_detail_scan", "space_cql",
                     "space = &quot;OPS&quot;"):
        assert internal not in report["html"], f"{internal!r} 가 메일에 실렸다"
    reporter.mark_report_ready(thread, report)
    ready_thread = sd.confluence_report_thread_get(int(thread["id"]))
    assert ready_thread["status"] == "report_ready"
    report_json = json.loads(ready_thread["report_json"])
    assert report_json["findings"][0]["scan_trace"]["scan_method"] == "api_cql_search_detail_scan"
    assert report_json["findings"][0]["scan_trace"]["candidate_source"] == "space_cql"

    # 재조회 이음매가 REST → 브라우저로 바뀌었다(2026-08-26). 주입 지점도 그쪽이다.
    import domains.services.confluence.plugin.tools.confluence_browser_refetch as _br

    monkeypatch.setattr(
        _br, "browser_fetch_recheck_text",
        # 라벨은 실제 구현과 같아야 한다 — page 는 `label_hint`(=page_id) 를 쓴다.
        lambda **kw: ([{"label": kw.get("label_hint") or "100", "text": "no credential remains"}], None))
    result = reporter.recheck_thread(thread, evidence_dir=tmp_path, finalize=False)
    assert result["final_status"] == "remediated"
    assert sd.confluence_report_thread_get(int(thread["id"]))["status"] == "report_ready"
    assert core_state.finding_get(finding_id)["status"] != "remediated"
    rows = sd.confluence_recheck_results_for_thread(int(thread["id"]))
    assert rows[0]["finding_id"] == finding_id
    assert rows[0]["verdict"] == "now_closed"
    assert rows[0]["verification"] == {
        "method": "confluence_surface_refetch",
        "matched": False,
        "surface_count": 1,
        "surface_labels": ["100"],
    }


def test_confluence_report_renders_weekly_accumulation_for_recurring_finding(tmp_db) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Recurring Confluence secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_RECUR****"}],
            "metadata": {
                "space_key": "OPS",
                "page_id": "100",
                "title": "Runbook",
                "scan_method": "api_cql_search_detail_scan",
                "candidate_source": "space_cql",
                "candidate_query": 'space = "OPS" AND text ~ "secret"',
            },
        },
    )
    _, old_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    sd.confluence_report_thread_set_status(old_id, "awaiting_owner")

    action, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="reported",
        cycle_key="2026-W28",
    )
    assert action == "recurred"

    thread = sd.confluence_report_thread_get(thread_id)
    report = reporter.build_report_for_thread(thread)

    assert report["cycle_keys"] == ["2026-W27", "2026-W28"]
    assert report["accumulated_week_count"] == 2
    assert report["recurrence_count"] == 1
    # ★ 2026-08-31 규칙 변경: 재확인 문구의 근거는 **스캔 주차가 아니라 발송 횟수**다.
    #   우리가 두 주 연속 본 것과 담당자가 두 번 들은 것은 다르다 — 첫 발송인데도
    #   "2주 누적 확인" 이 실제로 나갔다. 주차 집계 자체는 그대로 살아 있다(아래).
    assert "번째 안내" not in report["html"], "발송한 적이 없으면 '이전에 안내드린' 을 말하면 안 된다"

    sd.service_reply_message_add(domain="confluence", direction="out", thread_id=int(thread_id),
                                 subject="s", subject_tag="[tag]", mail_from="dssoc",
                                 mail_to="owner@samsung.com", body_excerpt="b",
                                 agent_verdict="sent")
    report = reporter.build_report_for_thread(thread)
    assert "2번째 안내 · 이전 1회 안내" in report["html"]
    assert "이번 주 점검에서도 다시 확인" in report["html"]

    reporter.mark_report_ready(thread, report)
    ready_thread = sd.confluence_report_thread_get(thread_id)
    saved = json.loads(ready_thread["report_json"])
    assert saved["cycle_keys"] == ["2026-W27", "2026-W28"]
    assert saved["accumulated_week_count"] == 2
    assert saved["recurrence_count"] == 1
    assert "2번째 안내 · 이전 1회 안내" in ready_thread["report_html"]


def test_confluence_sync_preserves_internal_owner_metadata_as_recipient(tmp_db) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {
                "space_key": "OPS",
                "page_id": "100",
                "owner_email": "Space Owner <space.owner@samsung.com>",
                "maintainer_emails": [
                    "space.backup@partner.samsung.com",
                    "attacker@example.com",
                ],
            },
            "agent_verification": _agent_verification(),
        },
    )

    sync = reporter.sync_report_threads()

    assert sync["seen"] == 1
    assert sync["owner_recipient_count"] == 1
    assert sync["owner_missing_count"] == 0
    thread = sd.confluence_report_threads_overview(space_key="OPS")[0]
    assert thread["recipient"] == "space.owner@samsung.com, space.backup@partner.samsung.com"
    assert thread["owner_recipient"] == "space.owner@samsung.com, space.backup@partner.samsung.com"


def test_confluence_report_sync_skips_closed_lifecycle_findings(tmp_db) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    for idx, status in enumerate(("remediated", "false_positive", "accepted_risk"), start=1):
        finding_id, _ = core_state.finding_upsert(
            task_type="confluence",
            asset=f"confluence:OLD{idx}:100",
            asset_kind="page",
            severity="high",
            summary=f"closed Confluence finding {idx}",
            extra={
                "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
                "metadata": {"space_key": f"OLD{idx}", "page_id": "100"},
                "agent_verification": _agent_verification(),
            },
        )
        core_state.finding_set_status(finding_id, status, reason="unit closed")

    active_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:ACTIVE:100",
        asset_kind="page",
        severity="high",
        summary="active Confluence finding",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {
                "space_key": "ACTIVE",
                "page_id": "100",
                "owner_email": "External Owner <owner@example.com>",
            },
            "agent_verification": _agent_verification(),
        },
    )
    core_state.finding_set_status(active_id, "triaged", reason="still active")

    sync = reporter.sync_report_threads()

    assert sync["seen"] == 1
    assert sync["new"] == 1
    assert sync["owner_recipient_count"] == 0
    assert sync["owner_missing_count"] == 1
    active_thread = sd.confluence_report_threads_overview(space_key="ACTIVE")[0]
    assert active_thread["status"] == "reported"
    assert active_thread["owner_recipient"] is None
    assert sd.confluence_report_thread_finding_ids(
        int(active_thread["id"])
    ) == [active_id]
    for idx in range(1, 4):
        assert sd.confluence_report_threads_overview(space_key=f"OLD{idx}") == []


def test_confluence_report_sync_skips_unknown_scope_findings(tmp_db) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    unknown_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:",
        asset_kind="page",
        severity="high",
        summary="Confluence finding without space scope",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_unknown_****"}],
            "metadata": {"page_id": "100", "title": "Unknown Space"},
            "agent_verification": _agent_verification(),
        },
    )
    active_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:ACTIVE:100",
        asset_kind="page",
        severity="high",
        summary="active Confluence finding with space scope",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_active_****"}],
            "metadata": {"space_key": "ACTIVE", "page_id": "100"},
            "agent_verification": _agent_verification(),
        },
    )

    sync = reporter.sync_report_threads()

    assert sync["seen"] == 2
    assert sync["new"] == 1
    assert sync["skipped_unknown_scope"] == 1
    assert sd.confluence_report_threads_overview(space_key="unknown") == []
    assert sd.confluence_report_threads_overview(space_key="ACTIVE")[0]["status"] == "reported"
    assert sd.confluence_report_thread_finding_ids(
        int(sd.confluence_report_threads_overview(space_key="ACTIVE")[0]["id"])
    ) == [active_id]
    assert unknown_id not in sd.confluence_report_thread_finding_ids(
        int(sd.confluence_report_threads_overview(space_key="ACTIVE")[0]["id"])
    )


def test_confluence_report_sync_skips_unverified_findings(tmp_db) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:UNVERIFIED:100",
        asset_kind="page",
        severity="high",
        summary="unverified Confluence finding",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_unverified_****"}],
            "metadata": {"space_key": "UNVERIFIED", "page_id": "100"},
        },
    )
    verified_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:VERIFIED:100",
        asset_kind="page",
        severity="high",
        summary="verified Confluence finding",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_verified_****"}],
            "metadata": {"space_key": "VERIFIED", "page_id": "100"},
            "agent_verification": _agent_verification(),
        },
    )

    sync = reporter.sync_report_threads()

    assert sync["seen"] == 2
    assert sync["skipped_unverified"] == 1
    assert sync["new"] == 1
    assert sd.confluence_report_threads_overview(space_key="UNVERIFIED") == []
    thread = sd.confluence_report_threads_overview(space_key="VERIFIED")[0]
    assert sd.confluence_report_thread_finding_ids(int(thread["id"])) == [verified_id]


def test_confluence_report_builder_filters_out_of_scope_findings(tmp_db) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    in_scope_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="in-scope Confluence secret",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_ops_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "OPS Runbook"},
        },
    )
    out_scope_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OTHER:200",
        asset_kind="page",
        severity="critical",
        summary="out-of-scope Confluence secret",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_other_****"}],
            "metadata": {"space_key": "OTHER", "page_id": "200", "title": "Other Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=in_scope_id,
        space_key="OPS",
        severity="high",
        status="reported",
    )
    with sd.connect() as c:
        c.execute(
            "UPDATE confluence_report_thread SET finding_ids=? WHERE id=?",
            (json.dumps([in_scope_id, out_scope_id]), thread_id),
        )

    report = reporter.build_report_for_thread(sd.confluence_report_thread_get(thread_id))

    assert report["finding_count"] == 1
    assert report["out_of_scope_count"] == 1
    assert [item["id"] for item in report["findings"]] == [in_scope_id]
    assert report["findings"][0]["space_key"] == "OPS"
    # in-scope 판별은 **위치**로 한다 — 값은 이제 메일에 없다(계약 변경 2026-08-24).
    assert "sk_ops_****" not in report["html"]
    assert "sk_other_****" not in report["html"]
    assert "Other Runbook" not in report["html"]
    assert "out-of-scope Confluence secret" not in report["html"]


def test_confluence_mark_report_ready_skips_empty_scope_filtered_report(tmp_db) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OTHER:100",
        asset_kind="page",
        severity="high",
        summary="Confluence finding outside thread space",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_other_****"}],
            "metadata": {"space_key": "OTHER", "page_id": "100", "title": "Other Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
    )
    thread = sd.confluence_report_thread_get(thread_id)
    report = reporter.build_report_for_thread(thread)

    assert report["finding_count"] == 0
    assert report["out_of_scope_count"] == 1
    reporter.mark_report_ready(thread, report)

    updated = sd.confluence_report_thread_get(thread_id)
    assert updated["status"] == "error"
    assert updated["report_json"] == "{}"
    assert updated["report_html"] is None
    assert updated["notified_at"] is None
    assert int(updated["attempt_count"] or 0) == int(thread["attempt_count"] or 0)
    assert "no in-scope findings" in updated["last_reason"]
    assert "out_of_scope_count=1" in updated["last_reason"]


def test_confluence_recheck_partial_remediation(tmp_db, tmp_path, monkeypatch) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    live_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="live secret",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100"},
        },
    )
    closed_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:200",
        asset_kind="page",
        severity="high",
        summary="closed secret",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_old_****"}],
            "metadata": {"space_key": "OPS", "page_id": "200"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=live_id,
        space_key="OPS",
        severity="high",
        status="reported",
    )
    sd.confluence_report_thread_upsert(
        finding_id=closed_id,
        space_key="OPS",
        severity="high",
        status="reported",
    )
    sd.confluence_report_thread_set_status(thread_id, "recheck_requested")
    thread = sd.confluence_report_thread_get(thread_id)

    def fake_fetch(row):
        return [
            {
                "label": "100" if row["id"] == live_id else "200",
                "text": "live" if row["id"] == live_id else "closed",
            },
        ], None

    monkeypatch.setattr(reporter, "_fetch_recheck_text", fake_fetch)
    monkeypatch.setattr(
        reporter,
        "_current_hit_signatures",
        lambda text: {("api_key", "sk_live_****")} if text == "live" else set(),
    )

    result = reporter.recheck_thread(thread, evidence_dir=tmp_path, finalize=False)

    assert result["final_status"] == "partially_remediated"
    assert sd.confluence_report_thread_get(thread_id)["status"] == "recheck_requested"
    verdicts = {r["finding_id"]: r["verdict"] for r in sd.confluence_recheck_results_for_thread(thread_id)}
    assert verdicts[live_id] == "still_open"
    assert verdicts[closed_id] == "now_closed"
    verifications = {
        r["finding_id"]: r["verification"]
        for r in sd.confluence_recheck_results_for_thread(thread_id)
    }
    assert verifications[live_id]["method"] == "confluence_surface_refetch"
    assert verifications[live_id]["matched"] is True
    assert verifications[live_id]["surface_labels"] == ["100"]
    assert verifications[closed_id]["matched"] is False
    assert verifications[closed_id]["surface_labels"] == ["200"]


def test_confluence_recheck_refetch_failure_stays_retryable(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="recheck_requested",
    )
    thread = sd.confluence_report_thread_get(thread_id)
    monkeypatch.setattr(
        reporter,
        "_fetch_recheck_text",
        lambda row: ([], "page body not found"),
    )

    result = reporter.recheck_thread(thread, evidence_dir=tmp_path)

    assert result["final_status"] == "recheck_requested"
    assert sd.confluence_report_thread_get(thread_id)["status"] == "recheck_requested"
    assert core_state.finding_get(finding_id)["status"] != "remediated"
    rows = sd.confluence_recheck_results_for_thread(thread_id)
    assert rows[0]["verdict"] == "unknown"
    assert rows[0]["error"] == "page body not found"
    assert rows[0]["verification"] == {
        "method": "confluence_surface_refetch",
        "matched": False,
        "surface_count": 0,
        "surface_labels": [],
    }


def test_confluence_recheck_evidence_path_sanitizes_space_key(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS/../../escape",
        severity="high",
        status="recheck_requested",
    )
    thread = sd.confluence_report_thread_get(thread_id)
    monkeypatch.setattr(
        reporter,
        "_fetch_recheck_text",
        lambda row: ([], "page body not found"),
    )

    result = reporter.recheck_thread(
        thread,
        evidence_dir=tmp_path,
        finalize=False,
        charter_ref="SECOPS-CONFLUENCE-RECHECK-EVIDENCE",
    )

    evidence_ref = Path(result["evidence_ref"])
    assert result["charter_ref"] == "SECOPS-CONFLUENCE-RECHECK-EVIDENCE"
    assert evidence_ref.parent == tmp_path
    assert evidence_ref.exists()
    assert ".." not in evidence_ref.name
    assert "/" not in evidence_ref.name
    assert evidence_ref.name.startswith("confluence_recheck_OPS_")
    assert "escape" in evidence_ref.name
    payload = json.loads(evidence_ref.read_text(encoding="utf-8"))
    assert payload["charter_ref"] == "SECOPS-CONFLUENCE-RECHECK-EVIDENCE"
    assert payload["space_key"] == "OPS/../../escape"
    assert payload["results"][0]["verdict"] == "unknown"


# ══════════════════════════════════════════════════════════════════════
# 재검증 재조회 — REST → 브라우저 (2026-08-26)
# ══════════════════════════════════════════════════════════════════════
#
# 여기 있던 테스트 13건은 **REST 고유 의미**를 고정하고 있었다:
#   · HTTP 401/403/429 를 auth_failed/limit_failed 로 분류
#   · 첨부 다운로드 URL 이 부모 page 것인지 검증
#   · 댓글 인덱스 단위 선택
#
# confluence REST 는 이 인스턴스에서 죽었다(실측 2026-08-26, `/rest/api/content`):
#   Basic  403 "Basic Authentication has been disabled on this instance."
#   Bearer 429 "속도 제한이 초과되었습니다."
#
# 그래서 재조회를 브라우저로 옮겼고, 위 능력들이 함께 사라졌다. 없어진 동작을
# 고정하던 테스트를 남겨두면 "이 코드가 아직 그렇게 동작한다" 는 거짓말이 된다.
#
# ★ 잃은 것을 정직하게 적는다 — 특히 **첨부는 재검증할 수 없다**. 브라우저로 xlsx/pdf
#   본문을 못 뽑기 때문이다. 실측 기준 첨부 finding 은 0건이라 지금 손실은 없지만,
#   생기면 그 스레드는 자동 종결되지 않고 사람이 봐야 한다.


def _recheck_fixture(sd, core_state, *, asset, asset_kind, metadata, hits=None):
    """finding + recheck 대기 스레드 하나."""
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset=asset,
        asset_kind=asset_kind,
        severity="high",
        summary="Confluence exposure",
        extra={
            "hits": hits or [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": metadata,
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="recheck_requested",
    )
    return finding_id, thread_id, sd.confluence_report_thread_get(thread_id)


def _stub_browser_refetch(monkeypatch, fn):
    """새 이음매를 갈아끼운다. `_fetch_recheck_text` 가 함수 안에서 지연 import 하므로
    모듈 속성을 바꾸면 다음 호출부터 반영된다."""
    import domains.services.confluence.plugin.tools.confluence_browser_refetch as br

    monkeypatch.setattr(br, "browser_fetch_recheck_text", fn)


def test_confluence_recheck_attachment_cannot_be_verified_and_says_so(
    tmp_db, tmp_path, monkeypatch,
) -> None:
    """★ 첨부는 브라우저로 본문을 못 뽑는다 — '조치됨' 으로 접으면 안 된다.

    조용히 빈 텍스트를 돌려주면 원래 값이 안 보이니 `now_closed`(조치됨)로 판정되고,
    유출이 열린 채 스레드만 닫힌다. 그래서 사유를 남기고 `unknown` 으로 둔다.
    """
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    finding_id, thread_id, thread = _recheck_fixture(
        sd, core_state,
        asset="confluence:OPS:100/attachment/runbook.xlsx",
        asset_kind="attachment",
        metadata={"space_key": "OPS", "page_id": "100", "filename": "runbook.xlsx"},
    )

    result = reporter.recheck_thread(thread, evidence_dir=tmp_path)

    assert result["final_status"] == "recheck_requested"
    assert core_state.finding_get(finding_id)["status"] != "remediated"
    rows = sd.confluence_recheck_results_for_thread(thread_id)
    assert rows[0]["verdict"] == "unknown"
    assert "attachment refetch unsupported" in rows[0]["error"]
    assert "not remediated" in rows[0]["error"], "사유가 '조치 아님' 을 명시해야 한다"


def test_confluence_recheck_page_body_still_open_when_the_value_remains(
    tmp_db, tmp_path, monkeypatch,
) -> None:
    """판정 로직은 그대로다 — 원래 값이 본문에 남아 있으면 still_open."""
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    finding_id, thread_id, thread = _recheck_fixture(
        sd, core_state,
        asset="confluence:OPS:100", asset_kind="page",
        metadata={"space_key": "OPS", "page_id": "100"},
        # ⚠️ 판정은 `(kind, masked)` 쌍을 **재스캔 결과와 대조**한다
        #    (`_original_hit_signatures` ↔ `_current_hit_signatures`).
        #    그래서 원래 hit 의 kind/masked 가 스캐너가 실제로 내는 값이어야 한다 —
        #    아무 값이나 넣으면 대조가 안 맞아 `now_closed`(조치됨)로 판정된다.
        #    ⚠️ masked 값은 **재스캔이 실제로 내는 것과 같아야** 한다. 탐지기가 값 뒤
        #       공백까지 삼키므로, 본문에 군더더기를 붙이면 마스킹 결과가 달라져
        #       대조가 어긋나고 `now_closed` 로 판정된다(실제로 여기서 두 번 걸렸다).
        hits=[{"kind": "generic_password_assignment", "masked": "abcd****3456"}],
    )
    _stub_browser_refetch(
        monkeypatch,
        lambda **kw: ([{"label": "100/page", "text": "token=abcdef123456"}], None),
    )

    reporter.recheck_thread(thread, evidence_dir=tmp_path)
    rows = sd.confluence_recheck_results_for_thread(thread_id)
    assert rows[0]["verdict"] == "still_open", (
        "본문에 원래 값이 그대로인데 조치됨으로 판정됐다")
    assert core_state.finding_get(finding_id)["status"] != "remediated"


def test_confluence_recheck_browser_failure_is_unknown_not_closed(
    tmp_db, tmp_path, monkeypatch,
) -> None:
    """★ 못 읽은 것과 사라진 것은 다르다.

    예전엔 HTTP 상태(401/403/429)로 갈랐다. 브라우저엔 그 신호가 없으므로 **사유 문자열**
    을 그대로 보존해 `unknown` 으로 남긴다. 여기가 무너지면 로그인벽이 '조치됨' 이 된다.
    """
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    finding_id, thread_id, thread = _recheck_fixture(
        sd, core_state,
        asset="confluence:OPS:100", asset_kind="page",
        metadata={"space_key": "OPS", "page_id": "100"},
    )
    _stub_browser_refetch(
        monkeypatch,
        lambda **kw: ([], "page body not readable in browser (login wall or off-origin redirect)"),
    )

    result = reporter.recheck_thread(thread, evidence_dir=tmp_path)

    assert result["final_status"] == "recheck_requested"
    assert core_state.finding_get(finding_id)["status"] != "remediated"
    rows = sd.confluence_recheck_results_for_thread(thread_id)
    assert rows[0]["verdict"] == "unknown"
    assert "not readable" in rows[0]["error"]


def test_confluence_recheck_rejects_finding_space_outside_thread_scope_before_fetch(
    tmp_db, tmp_path, monkeypatch,
) -> None:
    """★ scope 검사는 재조회 **전에** 돈다 — 브라우저 전환과 무관하게 살아 있어야 한다."""
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    finding_id, thread_id, thread = _recheck_fixture(
        sd, core_state,
        asset="confluence:OTHER:200", asset_kind="page",
        metadata={"space_key": "OTHER", "page_id": "200"},
    )

    def _must_not_fetch(**kw):
        raise AssertionError("scope 밖 finding 인데 재조회가 돌았다")

    _stub_browser_refetch(monkeypatch, _must_not_fetch)
    reporter.recheck_thread(thread, evidence_dir=tmp_path)

    rows = sd.confluence_recheck_results_for_thread(thread_id)
    assert rows[0]["verdict"] == "unknown"
    assert "outside thread scope" in rows[0]["error"]
    assert core_state.finding_get(finding_id)["status"] != "remediated"


def test_confluence_recheck_invalid_page_id_is_unknown_before_fetch(
    tmp_db, tmp_path, monkeypatch,
) -> None:
    """page id 가 이상하면 재조회를 시도하지 않는다(SSRF/오조회 방지)."""
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    finding_id, thread_id, thread = _recheck_fixture(
        sd, core_state,
        asset="confluence:OPS:../../etc/passwd", asset_kind="page",
        metadata={"space_key": "OPS", "page_id": "../../etc/passwd"},
    )

    def _must_not_fetch(**kw):
        raise AssertionError("잘못된 page id 인데 재조회가 돌았다")

    _stub_browser_refetch(monkeypatch, _must_not_fetch)
    reporter.recheck_thread(thread, evidence_dir=tmp_path)

    rows = sd.confluence_recheck_results_for_thread(thread_id)
    assert rows[0]["verdict"] == "unknown"
    assert core_state.finding_get(finding_id)["status"] != "remediated"


def test_confluence_recheck_comment_is_covered_by_the_page_text(
    tmp_db, tmp_path, monkeypatch,
) -> None:
    """★ 댓글은 page 에 함께 렌더된다 — 인덱스 단위 선택은 사라졌다.

    판정에는 영향이 없다(원래 값이 이 텍스트 안에 있으면 still_open). 라벨이 그 사실을
    말해야 나중에 인덱스를 신뢰하는 코드가 안 생긴다.
    """
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    _finding_id, thread_id, thread = _recheck_fixture(
        sd, core_state,
        asset="confluence:OPS:100/comment/5", asset_kind="comment",
        metadata={"space_key": "OPS", "page_id": "100", "comment_index": 5},
    )
    seen: dict = {}

    def _fake(**kw):
        seen.update(kw)
        return [{"label": "100/page+comments", "text": "댓글 포함 본문"}], None

    _stub_browser_refetch(monkeypatch, _fake)
    reporter.recheck_thread(thread, evidence_dir=tmp_path)

    assert seen.get("kind") == "comment"
    rows = sd.confluence_recheck_results_for_thread(thread_id)
    assert "page+comments" in str(rows[0]["verification"]["surface_labels"])


def test_confluence_recheck_page_version_passes_the_version_through(
    tmp_db, tmp_path, monkeypatch,
) -> None:
    """옛 버전 재검증은 살아 있다 — `?pageVersion=<N>` 으로 연다."""
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    _finding_id, thread_id, thread = _recheck_fixture(
        sd, core_state,
        asset="confluence:OPS:100/version/3", asset_kind="page_version",
        metadata={"space_key": "OPS", "page_id": "100", "version": 3},
    )
    seen: dict = {}

    def _fake(**kw):
        seen.update(kw)
        return [{"label": "100/version/3", "text": "옛 버전 본문"}], None

    _stub_browser_refetch(monkeypatch, _fake)
    reporter.recheck_thread(thread, evidence_dir=tmp_path)

    assert seen.get("version") == 3 and seen.get("kind") == "page_version"
    rows = sd.confluence_recheck_results_for_thread(thread_id)
    assert rows[0]["verification"]["surface_labels"] == ["100/version/3"]


def test_reporter_recheck_no_longer_touches_rest():
    """★ REST 로 되돌아가면 재검증이 다시 403 으로 전량 실패한다."""
    import inspect

    from domains.services.confluence.application import reporter

    src = inspect.getsource(reporter._fetch_recheck_text)
    for fn in ("cf.fetch_page_body", "cf.list_comments", "cf.list_attachments",
               "cf.fetch_attachment_text", "cf.fetch_page_body_version"):
        assert f"{fn}(" not in src, f"reporter 가 아직 REST 를 부른다: {fn}"
    assert "browser_fetch_recheck_text(" in src


def test_confluence_recheck_agent_does_not_mail_unknown_results(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from service.agents import confluence_recheck_agent
    from secu_agent import state as core_state

    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "41")
    monkeypatch.setattr(confluence_recheck_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(
        confluence_recheck_agent,
        "deliver_recheck_result_for_thread",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("unknown recheck must not mail")),
    )
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="recheck_requested",
    )
    monkeypatch.setattr(
        reporter,
        "_fetch_recheck_text",
        lambda row: ([], "page body not found"),
    )

    before = time.time()
    result = confluence_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["handled"] == 1
    assert result["retryable"] == 1
    assert result["sent"] == 0
    assert result["dry_run"] == 0
    updated = sd.confluence_report_thread_get(thread_id)
    assert updated["status"] == "recheck_requested"
    assert "unknown results" in updated["last_reason"]
    assert updated["retry_after"] >= before + 40
    assert sd.service_reply_messages_for_thread("confluence", thread_id) == []

    second = confluence_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )
    assert second["handled"] == 0


def test_confluence_recheck_empty_structured_results_stays_retryable(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="recheck_requested",
    )
    with sd.connect() as c:
        c.execute("UPDATE confluence_report_thread SET finding_ids='[]' WHERE id=?", (thread_id,))
    thread = sd.confluence_report_thread_get(thread_id)
    monkeypatch.setattr(
        reporter,
        "_fetch_recheck_text",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("no finding rows means no detail fetch")
        ),
    )

    result = reporter.recheck_thread(thread, evidence_dir=tmp_path)

    assert result["final_status"] == "recheck_requested"
    assert result["results"] == []
    assert sd.confluence_report_thread_get(thread_id)["status"] == "recheck_requested"
    assert core_state.finding_get(finding_id)["status"] != "remediated"
    assert sd.confluence_recheck_results_for_thread(thread_id) == []


def test_confluence_recheck_delivery_skips_empty_structured_results(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    async def fail_deliver(*args, **kwargs):
        raise AssertionError("empty recheck results must not be mailed")

    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "37")
    monkeypatch.setattr(reporter, "deliver", fail_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="recheck_requested",
    )
    thread = sd.confluence_report_thread_get(thread_id)
    before = time.time()

    delivery = asyncio.run(
        reporter.deliver_recheck_result_for_thread(
            thread,
            {
                "space_key": "OPS",
                "thread_id": thread_id,
                "final_status": "remediated",
                "results": [],
            },
            evidence_dir=tmp_path,
            charter_ref="SECOPS-TEST",
        )
    )

    updated = sd.confluence_report_thread_get(thread_id)
    assert delivery["mode"] == "skipped_retryable_recheck"
    assert delivery["policy"] == "blocked_retryable_recheck"
    assert delivery["final_status"] == "recheck_requested"
    assert delivery["retry_after"] >= before + 36
    assert updated["status"] == "recheck_requested"
    assert "no conclusive structured results" in updated["last_reason"]
    assert core_state.finding_get(finding_id)["status"] != "remediated"
    assert sd.service_reply_messages_for_thread("confluence", thread_id) == []


def test_confluence_recheck_direct_finalize_requires_sent_delivery(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="recheck_requested",
    )
    thread = sd.confluence_report_thread_get(thread_id)
    monkeypatch.setattr(reporter, "_fetch_recheck_text", lambda row: ([{"label": "100", "text": "clean"}], None))
    monkeypatch.setattr(reporter, "_current_hit_signatures", lambda text: set())

    before = time.time()
    result = reporter.recheck_thread(thread, evidence_dir=tmp_path)

    updated = sd.confluence_report_thread_get(thread_id)
    assert result["final_status"] == "recheck_requested"
    assert result["results"][0]["verdict"] == "now_closed"
    assert updated["status"] == "recheck_requested"
    assert updated["retry_after"] >= before
    assert "blocked until result mail is sent" in updated["last_reason"]
    assert core_state.finding_get(finding_id)["status"] != "remediated"
    assert sd.service_reply_messages_for_thread("confluence", thread_id) == []


def test_confluence_recheck_delivery_dry_run_keeps_retryable_and_unresolved(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "41")
    monkeypatch.setenv("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["payload"] = payload
        return DeliveryResult(
            sink_id=sink_id,
            mode="dry_run",
            detail="dry-run recheck draft",
            draft_path=str(tmp_path / "draft.json"),
        )

    monkeypatch.setattr(reporter, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="recheck_requested",
    )
    thread = sd.confluence_report_thread_get(thread_id)
    monkeypatch.setattr(reporter, "_fetch_recheck_text", lambda row: ([{"text": "clean"}], None))
    monkeypatch.setattr(reporter, "_current_hit_signatures", lambda text: set())

    result = reporter.recheck_thread(thread, evidence_dir=tmp_path, finalize=False)
    before = time.time()
    delivery = asyncio.run(
        reporter.deliver_recheck_result_for_thread(thread, result, evidence_dir=tmp_path)
    )

    updated = sd.confluence_report_thread_get(thread_id)
    assert result["final_status"] == "remediated"
    assert delivery["mode"] == "dry_run"
    assert delivery["final_status"] == "recheck_requested"
    assert captured["payload"].recipients == ("dssoc@samsung.com",)
    assert updated["status"] == "recheck_requested"
    assert updated["retry_after"] >= before + 40
    assert delivery["retry_after"] == updated["retry_after"]
    assert sd.confluence_report_thread_claim_next(
        session_id=12345,
        status="recheck_requested",
    ) is None
    assert updated["notified_at"] is None
    assert core_state.finding_get(finding_id)["status"] != "remediated"
    assert sd.service_reply_messages_for_thread("confluence", thread_id) == []


def test_confluence_recheck_agent_delivery_error_schedules_retry(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from service.agents import confluence_recheck_agent
    from secu_agent import state as core_state

    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "41")
    monkeypatch.setattr(confluence_recheck_agent, "load_runtime_env", lambda load_plugins=False: None)

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={"metadata": {"space_key": "OPS", "page_id": "100"}},
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="recheck_requested",
    )
    monkeypatch.setattr(
        confluence_recheck_agent,
        "recheck_thread",
        lambda thread, *, evidence_dir, finalize=False, charter_ref="": {
            "thread_id": thread["id"],
            "space_key": thread["space_key"],
            "final_status": "still_open",
            "results": [],
        },
    )

    async def fail_delivery(*args, **kwargs):
        raise RuntimeError("knox mail unavailable")

    monkeypatch.setattr(
        confluence_recheck_agent,
        "deliver_recheck_result_for_thread",
        fail_delivery,
    )

    before = time.time()
    result = confluence_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["handled"] == 1
    assert result["retryable"] == 1
    assert result["sent"] == 0
    assert result["dry_run"] == 0
    updated = sd.confluence_report_thread_get(thread_id)
    assert updated["status"] == "recheck_requested"
    assert "delivery failed" in updated["last_reason"]
    assert updated["retry_after"] >= before + 40
    assert int(updated["attempt_count"] or 0) == 1

    second = confluence_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )
    assert second["handled"] == 0


def test_confluence_recheck_agent_pass_exception_schedules_retry(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from service.agents import confluence_recheck_agent
    from secu_agent import state as core_state

    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "41")
    monkeypatch.setattr(confluence_recheck_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(
        confluence_recheck_agent,
        "run_guidance_pass",
        lambda *args, **kwargs: {"handled": 0, "sent": 0, "dry_run": 0, "errors": 0},
    )

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={"metadata": {"space_key": "OPS", "page_id": "100"}},
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="recheck_requested",
    )

    def fail_recheck(*args, **kwargs):
        raise RuntimeError("confluence recheck parser exploded")

    async def fail_delivery(*args, **kwargs):
        raise AssertionError("delivery must not run after recheck exception")

    monkeypatch.setattr(confluence_recheck_agent, "recheck_thread", fail_recheck)
    monkeypatch.setattr(
        confluence_recheck_agent,
        "deliver_recheck_result_for_thread",
        fail_delivery,
    )

    before = time.time()
    result = confluence_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["handled"] == 1
    assert result["errors"] == 1
    assert result["retryable"] == 1
    updated = sd.confluence_report_thread_get(thread_id)
    assert updated["status"] == "recheck_requested"
    assert "recheck pass failed" in updated["last_reason"]
    assert "confluence recheck parser exploded" in updated["last_reason"]
    assert updated["retry_after"] >= before + 40
    assert int(updated["attempt_count"] or 0) == 1
    assert sd.confluence_report_thread_claim_next(
        session_id=12345,
        status="recheck_requested",
    ) is None

    second = confluence_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )
    assert second["handled"] == 0


def test_confluence_recheck_attempt_cap_escalates_without_recheck_or_delivery(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from service.agents import confluence_recheck_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(confluence_recheck_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(
        confluence_recheck_agent,
        "run_guidance_pass",
        lambda *args, **kwargs: {"handled": 0, "sent": 0, "dry_run": 0, "errors": 0},
    )
    monkeypatch.setattr(
        confluence_recheck_agent,
        "recheck_thread",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attempt-capped thread must not recheck")
        ),
    )

    async def fail_delivery(*args, **kwargs):
        raise AssertionError("attempt-capped thread must not deliver")

    monkeypatch.setattr(confluence_recheck_agent, "deliver_recheck_result_for_thread", fail_delivery)

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={"metadata": {"space_key": "OPS", "page_id": "100"}},
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="recheck_requested",
    )
    with sd.connect() as c:
        c.execute("UPDATE confluence_report_thread SET attempt_count=5 WHERE id=?", (thread_id,))

    result = confluence_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    updated = sd.confluence_report_thread_get(thread_id)
    assert result["handled"] == 1
    assert result["escalated"] == 1
    assert result["retryable"] == 0
    assert result["errors"] == 0
    assert updated["status"] == "escalated"
    assert updated["claimed_by"] is None
    assert updated["claimed_at"] is None
    assert updated["last_reason"] == "confluence recheck attempt cap exceeded"
    assert int(updated["attempt_count"] or 0) == 5
    assert sd.confluence_recheck_results_for_thread(thread_id) == []
    assert sd.service_reply_messages_for_thread("confluence", thread_id) == []
    assert core_state.finding_get(finding_id)["status"] != "remediated"


def test_confluence_recheck_pass_counts_partially_remediated(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from service.agents import confluence_recheck_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(confluence_recheck_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(
        confluence_recheck_agent,
        "run_guidance_pass",
        lambda *args, **kwargs: {"handled": 0, "sent": 0, "dry_run": 0, "errors": 0},
    )

    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={"metadata": {"space_key": "OPS", "page_id": "100"}},
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="recheck_requested",
    )

    def fake_handle(thread, *, evidence_dir=None, charter_ref=""):
        sd.confluence_report_thread_set_status(int(thread["id"]), "partially_remediated")
        return {
            "thread_id": thread["id"],
            "space_key": thread["space_key"],
            "final_status": "partially_remediated",
            "delivery": {"mode": "sent"},
        }

    monkeypatch.setattr(confluence_recheck_agent, "_handle_thread", fake_handle)

    result = confluence_recheck_agent.run_recheck_pass(
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
    assert sd.confluence_report_thread_get(thread_id)["status"] == "partially_remediated"


def test_confluence_recheck_delivery_sent_finalizes_closed_finding(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(reporter, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="recheck_requested",
    )
    thread = sd.confluence_report_thread_get(thread_id)
    monkeypatch.setattr(reporter, "_fetch_recheck_text", lambda row: ([{"label": "100", "text": "clean"}], None))
    monkeypatch.setattr(reporter, "_current_hit_signatures", lambda text: set())

    result = reporter.recheck_thread(thread, evidence_dir=tmp_path, finalize=False)
    assert result["results"][0]["verification"] == {
        "method": "confluence_surface_refetch",
        "matched": False,
        "surface_count": 1,
        "surface_labels": ["100"],
    }
    delivery = asyncio.run(
        reporter.deliver_recheck_result_for_thread(thread, result, evidence_dir=tmp_path)
    )

    updated = sd.confluence_report_thread_get(thread_id)
    assert delivery["mode"] == "sent"
    assert delivery["final_status"] == "remediated"
    assert updated["status"] == "remediated"
    assert updated["recipient"] == "dssoc@samsung.com"
    assert updated["notified_at"] is not None
    assert core_state.finding_get(finding_id)["status"] == "remediated"
    messages = sd.service_reply_messages_for_thread("confluence", thread_id)
    assert len(messages) == 1
    assert messages[0]["direction"] == "out"
    assert messages[0]["agent_verdict"] == "sent"
    assert messages[0]["decision_reason"] == "outbound_recheck_result_notice"
    assert messages[0]["mail_to"] == "dssoc@samsung.com"
    # ★ 티켓 번호가 RE: **앞**에 온다 — 접두가 쌓여도 표식이 살아남게.
    subj = messages[0]["subject"]
    assert subj.startswith("RE: [Confluence 보안취약점 조치요청](CF"), subj
    assert "(OPS)" in subj
    assert messages[0]["body_html"] == messages[0]["body_excerpt"]
    assert "Confluence 공간의 시크릿 조치 회신에 대한 재검증 결과" in messages[0]["body_html"]
    # 내부 진단은 안 나간다. 결과는 한국어 라벨로 전달된다(계약 변경 2026-08-24).
    for internal in ("confluence_surface_refetch", "clean", "1 surface", "surfaces 100"):
        assert internal not in messages[0]["body_html"]
    assert "현재 콘텐츠에서 미검출" in messages[0]["body_html"]


def test_confluence_recheck_delivery_replies_to_latest_inbound_message(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["sink_id"] = sink_id
        captured["payload"] = payload
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(reporter, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="recheck_requested",
    )
    inbound_id = sd.service_reply_message_add(
        domain="confluence",
        direction="in",
        thread_id=thread_id,
        message_id="confluence-inbound-recheck",
        references_header="<report-root> <confluence-inbound-recheck>",
        root_message_id="report-root",
        subject="RE:(2) [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청",
        subject_tag="[Confluence 보안취약점 조치요청](OPS)",
        mail_from="Space Owner <space.owner@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>",
        mail_cc="Reviewer <reviewer@samsung.com>",
        body_excerpt="조치완료했습니다.\n--------- Original Message ---------\n최초 요청",
        body_html=(
            "<!doctype html><html><body>"
            "<p onclick=\"alert(1)\">조치완료했습니다.</p>"
            "<table><tr><td>space.owner@samsung.com</td></tr></table>"
            "<img src=\"data:image/png;base64,AAAA\"/>"
            "<img src=\"data:text/html;base64,PHNjcmlwdA==\"/>"
            "<a href=\"javascript:alert(1)\">bad</a>"
            "<script>alert(1)</script>"
            "</body></html>"
        ),
        agent_verdict="classified_remediation_claim",
        decision_reason="답장 신규 본문에서 조치 완료 주장을 확인함",
        received_at=1_780_000_060.0,
    )
    thread = sd.confluence_report_thread_get(thread_id)
    monkeypatch.setattr(reporter, "_fetch_recheck_text", lambda row: ([{"text": "clean"}], None))
    monkeypatch.setattr(reporter, "_current_hit_signatures", lambda text: set())

    result = reporter.recheck_thread(thread, evidence_dir=tmp_path, finalize=False)
    delivery = asyncio.run(
        reporter.deliver_recheck_result_for_thread(thread, result, evidence_dir=tmp_path)
    )

    payload = captured["payload"]
    assert delivery["mode"] == "sent"
    assert delivery["policy"] == "reply_to_inbound_sender"
    assert payload.recipients == ("space.owner@samsung.com",)
    # ★ 회신도 담당자(To) + DSSOC(Cc) 다 — 정책상 우리 팀함이 사본을 받아야 한다.
    #   예전엔 DSSOC 를 To·Cc 양쪽에서 빼기만 해서 회신 사본이 안 남았다.
    assert payload.cc == ("reviewer@samsung.com", "dssoc@samsung.com")
    # ★ 담당자 답장에 회신하는 경로에도 티켓이 찍힌다 — 여기가 빠지면 다음
    #   왕복부터 1차 키가 조용히 사라진다.
    # ★ 담당자 답장에 회신하는 경로에도 티켓이 찍힌다 — 여기가 빠지면 다음
    #   왕복부터 1차 키가 조용히 사라진다.
    assert payload.subject.startswith("RE:(3) [Confluence 보안취약점 조치요청](CF"), payload.subject
    assert "(OPS)" in payload.subject
    assert "--------- Original Message ---------" in payload.body
    assert payload.metadata["reply_message_id"] == inbound_id
    assert payload.metadata["in_reply_to"] == "confluence-inbound-recheck"
    assert payload.metadata["references"] == "<report-root> <confluence-inbound-recheck>"
    assert payload.metadata["root_message_id"] == "report-root"
    assert payload.metadata["delivery_policy"] == "reply_to_inbound_sender"
    assert payload.metadata["content_type"] == "HTML"
    assert "space.owner@samsung.com" in payload.metadata["delivery_allowed_pii_values"]
    assert "<p>조치완료했습니다.</p>" in payload.body
    assert "<table>" in payload.body
    assert "data:image/png;base64,AAAA" in payload.body
    assert "<script" not in payload.body
    assert "onclick" not in payload.body
    assert "javascript:" not in payload.body
    assert "data:text/html" not in payload.body
    updated = sd.confluence_report_thread_get(thread_id)
    assert updated["status"] == "remediated"
    assert updated["recipient"] == "space.owner@samsung.com"
    messages = sd.service_reply_messages_for_thread("confluence", thread_id)
    assert [m["direction"] for m in messages] == ["in", "out"]
    outbound = messages[-1]
    assert outbound["mail_to"] == "space.owner@samsung.com"
    # ★ 저장된 Cc 에도 DSSOC 가 남는다 — payload 와 DB 가 같은 사실을 말해야 한다.
    assert outbound["mail_cc"] == "reviewer@samsung.com, dssoc@samsung.com"
    assert outbound["in_reply_to"] == "confluence-inbound-recheck"
    assert outbound["references_header"] == "<report-root> <confluence-inbound-recheck>"
    assert outbound["root_message_id"] == "report-root"
    assert "--------- Original Message ---------" in outbound["body_html"]
    assert "<p>조치완료했습니다.</p>" in outbound["body_html"]
    assert "<table>" in outbound["body_html"]
    assert "data:image/png;base64,AAAA" in outbound["body_html"]
    assert "<script" not in outbound["body_html"]
    assert "onclick" not in outbound["body_html"]
    assert "javascript:" not in outbound["body_html"]
    assert "data:text/html" not in outbound["body_html"]


def test_confluence_recheck_delivery_ignores_inbound_before_latest_outbound(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["payload"] = payload
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(reporter, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="recheck_requested",
    )
    sd.confluence_report_thread_set_status(
        thread_id,
        "recheck_requested",
        notified_at=200.0,
        recipient="dssoc@samsung.com",
    )
    sd.service_reply_message_add(
        domain="confluence",
        direction="in",
        thread_id=thread_id,
        message_id="confluence-stale-howto",
        references_header="<report-root> <confluence-stale-howto>",
        root_message_id="report-root",
        subject="RE: [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청",
        subject_tag="[Confluence 보안취약점 조치요청](OPS)",
        mail_from="Space Owner <space.owner@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>",
        body_excerpt="권한 제한 방법 문의",
        agent_verdict="classified_how_to_question",
        received_at=250.0,
    )
    sd.service_reply_message_add(
        domain="confluence",
        direction="out",
        thread_id=thread_id,
        subject="RE:(2) [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청",
        subject_tag="[Confluence 보안취약점 조치요청](OPS)",
        mail_from="dssoc",
        mail_to="space.owner@samsung.com",
        body_excerpt="<p>how-to guidance</p>",
        body_html="<p>how-to guidance</p>",
        agent_verdict="sent",
        decision_reason="outbound_how_to_guidance",
        received_at=300.0,
    )
    thread = sd.confluence_report_thread_get(thread_id)

    delivery = asyncio.run(
        reporter.deliver_recheck_result_for_thread(
            thread,
            {
                "space_key": "OPS",
                "thread_id": thread_id,
                "results": [{
                    "finding_id": finding_id,
                    "asset": "confluence:OPS:100",
                    "verdict": "now_closed",
                    "verification": {
                        "method": "confluence_surface_refetch",
                        "matched": False,
                        "surface_count": 1,
                        "surface_labels": ["100"],
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
    updated = sd.confluence_report_thread_get(thread_id)
    assert updated["status"] == "remediated"
    assert updated["recipient"] == "dssoc@samsung.com"
    messages = sd.service_reply_messages_for_thread("confluence", thread_id)
    assert [m["direction"] for m in messages] == ["in", "out", "out"]
    outbound = messages[-1]
    assert outbound["decision_reason"] == "outbound_recheck_result_notice"
    assert outbound["mail_to"] == "dssoc@samsung.com"
    assert outbound["in_reply_to"] is None
    assert outbound["references_header"] is None
    assert outbound["root_message_id"] is None
    assert "--------- Original Message ---------" not in outbound["body_html"]


def test_confluence_report_delivery_dry_run_stays_report_ready(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    monkeypatch.delenv("CONFLUENCE_REMEDIATION_MAIL_MODE", raising=False)
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

    monkeypatch.setattr(reporter, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="reported",
    )
    thread = sd.confluence_report_thread_get(thread_id)
    report = reporter.build_report_for_thread(thread)
    reporter.mark_report_ready(thread, report)

    result = asyncio.run(
        reporter.deliver_report_for_thread(
            thread,
            report,
            evidence_dir=tmp_path,
            charter_ref="SECOPS-TEST",
        )
    )

    updated = sd.confluence_report_thread_get(thread_id)
    payload = captured["payload"]
    assert result["mode"] == "dry_run"
    assert captured["sink_id"] == "knox_mail"
    assert captured["charter_ref"] == "SECOPS-TEST"
    assert payload.recipients == ("dssoc@samsung.com",)
    assert payload.cc == ()
    assert payload.metadata["requested_recipients"] == ["space.owner@samsung.com"]
    # ⚠️ 라벨이 바뀌었다: "dssoc_only" → "dry_run". 수신처는 동일(DSSOC)하고 **뜻이 분명해졌다** —
    #    예전 이름은 "DSSOC 에게만 보내는 정책" 처럼 읽혔는데, 실제 조건은 "자율발송이 꺼져
    #    있어 어차피 안 나간다" 다. 정책상 DSSOC 로만 실발송하는 상태는 이제 없다.
    assert payload.metadata["delivery_policy"] == "dry_run"
    assert updated["status"] == "report_ready"
    assert updated["notified_at"] is None
    assert "dry-run draft" in updated["last_reason"]
    assert sd.service_reply_messages_for_thread("confluence", thread_id) == []


def test_confluence_report_delivery_skips_empty_scope_filtered_report(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state

    async def fail_deliver(*args, **kwargs):
        raise AssertionError("empty report must not call deliver")

    monkeypatch.setattr(reporter, "deliver", fail_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OTHER:100",
        asset_kind="page",
        severity="high",
        summary="Confluence finding outside thread space",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_other_****"}],
            "metadata": {"space_key": "OTHER", "page_id": "100", "title": "Other Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
    )
    thread = sd.confluence_report_thread_get(thread_id)
    report = reporter.build_report_for_thread(thread)

    result = asyncio.run(
        reporter.deliver_report_for_thread(
            thread,
            report,
            evidence_dir=tmp_path,
            charter_ref="SECOPS-TEST",
        )
    )

    updated = sd.confluence_report_thread_get(thread_id)
    assert result["mode"] == "skipped_empty_report"
    assert result["policy"] == "blocked_empty_report"
    assert result["attached_replies"] == 0
    assert "no in-scope findings" in result["detail"]
    assert updated["status"] == "error"
    assert updated["report_json"] == "{}"
    assert updated["report_html"] is None
    assert updated["notified_at"] is None
    assert "out_of_scope_count=1" in updated["last_reason"]
    assert sd.service_reply_messages_for_thread("confluence", thread_id) == []


def test_confluence_report_delivery_normal_mode_filters_external_owner_recipients(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    monkeypatch.setenv("CONFLUENCE_REMEDIATION_MAIL_MODE", "normal")
    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["payload"] = payload
        return DeliveryResult(
            sink_id=sink_id,
            mode="dry_run",
            detail="dry-run draft created",
            draft_path=str(tmp_path / "draft.json"),
        )

    monkeypatch.setattr(reporter, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient=(
            "Space Owner <space.owner@samsung.com>, attacker@example.com, "
            "space.backup@partner.samsung.com, dssoc@samsung.com"
        ),
        status="reported",
    )
    thread = sd.confluence_report_thread_get(thread_id)
    report = reporter.build_report_for_thread(thread)

    result = asyncio.run(reporter.deliver_report_for_thread(thread, report, evidence_dir=tmp_path))

    payload = captured["payload"]
    assert result["mode"] == "dry_run"
    assert payload.recipients == ("space.owner@samsung.com", "space.backup@partner.samsung.com")
    assert payload.cc == ("dssoc@samsung.com",)
    assert payload.metadata["requested_recipients"] == [
        "space.owner@samsung.com",
        "space.backup@partner.samsung.com",
    ]
    assert payload.metadata["delivery_policy"] == "normal"


def test_confluence_report_delivery_sent_records_outbound_message(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    monkeypatch.delenv("CONFLUENCE_REMEDIATION_MAIL_MODE", raising=False)
    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["sink_id"] = sink_id
        captured["payload"] = payload
        captured["charter_ref"] = charter_ref
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(reporter, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="reported",
    )
    thread = sd.confluence_report_thread_get(thread_id)
    report = reporter.build_report_for_thread(thread)
    reporter.mark_report_ready(thread, report)

    result = asyncio.run(
        reporter.deliver_report_for_thread(
            thread,
            report,
            evidence_dir=tmp_path,
            charter_ref="SECOPS-TEST",
        )
    )

    updated = sd.confluence_report_thread_get(thread_id)
    payload = captured["payload"]
    assert result["mode"] == "sent"
    assert captured["sink_id"] == "knox_mail"
    assert captured["charter_ref"] == "SECOPS-TEST"
    assert payload.recipients == ("dssoc@samsung.com",)
    assert payload.cc == ()
    assert payload.metadata["requested_recipients"] == ["space.owner@samsung.com"]
    # ⚠️ 라벨이 바뀌었다: "dssoc_only" → "dry_run". 수신처는 동일(DSSOC)하고 **뜻이 분명해졌다** —
    #    예전 이름은 "DSSOC 에게만 보내는 정책" 처럼 읽혔는데, 실제 조건은 "자율발송이 꺼져
    #    있어 어차피 안 나간다" 다. 정책상 DSSOC 로만 실발송하는 상태는 이제 없다.
    assert payload.metadata["delivery_policy"] == "dry_run"
    assert updated["status"] == "awaiting_owner"
    assert updated["recipient"] == "dssoc@samsung.com"
    assert updated["owner_recipient"] == "space.owner@samsung.com"
    assert updated["notified_at"] is not None
    messages = sd.service_reply_messages_for_thread("confluence", thread_id)
    assert len(messages) == 1
    assert messages[0]["direction"] == "out"
    assert messages[0]["agent_verdict"] == "sent"
    assert messages[0]["decision_reason"] == "outbound_report_notice"
    assert messages[0]["mail_from"] == "dssoc"
    assert messages[0]["mail_to"] == "dssoc@samsung.com"
    assert messages[0]["mail_cc"] is None
    assert messages[0]["subject_tag"] == "[Confluence 보안취약점 조치요청](OPS)"
    # ★ 제목 앞에 티켓 번호가 붙는다(회신 매칭 1차 키, 2026-08-31).
    subj = messages[0]["subject"]
    assert "[Confluence 보안취약점 조치요청](CF" in subj, subj
    assert subj.endswith("(OPS) 콘텐츠 시크릿 조치 요청"), subj
    assert messages[0]["body_html"] == messages[0]["body_excerpt"]
    assert "OPS" in messages[0]["body_html"]


def test_confluence_report_pass_waits_for_owner_recipient_before_delivery(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from service.agents import confluence_report_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(confluence_report_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(confluence_report_agent, "sync_report_threads", lambda: {"synced": 0})
    monkeypatch.setattr(
        confluence_report_agent,
        "build_report_for_thread",
        lambda thread: (_ for _ in ()).throw(
            AssertionError("ownerless reported thread must not build a report")
        ),
    )

    async def fail_delivery(*args, **kwargs):
        raise AssertionError("ownerless reported thread must not deliver")

    monkeypatch.setattr(confluence_report_agent, "deliver_report_for_thread", fail_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:MISSOWNER:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure without owner",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "MISSOWNER", "page_id": "100"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="MISSOWNER",
        severity="high",
        status="reported",
    )

    result = confluence_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    updated = sd.confluence_report_thread_get(thread_id)
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
    assert sd.service_reply_messages_for_thread("confluence", thread_id) == []


def test_confluence_report_delivery_attaches_preexisting_reply(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(reporter, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="reported",
    )
    sd.service_reply_message_add(
        domain="confluence",
        direction="in",
        thread_id=None,
        message_id="preexisting-confluence-reply",
        subject="[Confluence 보안취약점 조치요청](OPS)",
        subject_tag="[Confluence 보안취약점 조치요청](OPS)",
        mail_from="space.owner@samsung.com",
        mail_to="dssoc@samsung.com",
        body_excerpt="조치 완료했습니다.",
        agent_verdict="classified_remediation_claim",
        decision_reason="답장 신규 본문에서 조치 완료 주장을 확인함",
        received_at=1001.0,
    )
    thread = sd.confluence_report_thread_get(thread_id)
    report = reporter.build_report_for_thread(thread)
    reporter.mark_report_ready(thread, report)
    monkeypatch.setattr(reporter.time, "time", lambda: 1000.0)

    result = asyncio.run(reporter.deliver_report_for_thread(thread, report, evidence_dir=tmp_path))

    updated = sd.confluence_report_thread_get(thread_id)
    assert result["mode"] == "sent"
    assert result["attached_replies"] == 1
    assert updated["status"] == "recheck_requested"
    assert "pre-existing inbound replies attached: 1" in updated["last_reason"]
    messages = sd.service_reply_messages_for_thread("confluence", thread_id)
    assert [m["direction"] for m in messages] == ["out", "in"]
    assert messages[1]["message_id"] == "preexisting-confluence-reply"


def test_confluence_report_delivery_does_not_attach_stale_unmatched_reply(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application import reporter
    from secu_agent import state as core_state
    from secu_agent.agent.delivery import DeliveryResult

    monkeypatch.setenv("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(reporter, "deliver", fake_deliver)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="reported",
    )
    sd.service_reply_message_add(
        domain="confluence",
        direction="in",
        thread_id=None,
        message_id="stale-confluence-reply",
        subject="[Confluence 보안취약점 조치요청](OPS)",
        subject_tag="[Confluence 보안취약점 조치요청](OPS)",
        mail_from="space.owner@samsung.com",
        mail_to="dssoc@samsung.com",
        body_excerpt="조치 완료했습니다.",
        agent_verdict="classified_remediation_claim",
        decision_reason="답장 신규 본문에서 조치 완료 주장을 확인함",
        received_at=999.0,
    )
    thread = sd.confluence_report_thread_get(thread_id)
    report = reporter.build_report_for_thread(thread)
    reporter.mark_report_ready(thread, report)
    monkeypatch.setattr(reporter.time, "time", lambda: 1000.0)

    result = asyncio.run(reporter.deliver_report_for_thread(thread, report, evidence_dir=tmp_path))

    updated = sd.confluence_report_thread_get(thread_id)
    assert result["mode"] == "sent"
    assert result["attached_replies"] == 0
    assert updated["status"] == "awaiting_owner"
    with sd.connect() as c:
        row = c.execute(
            "SELECT thread_id FROM service_reply_message WHERE message_id=?",
            ("stale-confluence-reply",),
        ).fetchone()
    assert row["thread_id"] is None


def test_confluence_report_pass_syncs_unthreaded_finding_before_claim(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from service.agents import confluence_report_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(confluence_report_agent, "load_runtime_env", lambda load_plugins=False: None)
    captured: dict[str, dict] = {}

    async def fake_delivery(thread, report, *, evidence_dir, charter_ref=""):
        captured["thread"] = dict(thread)
        captured["report"] = dict(report)
        sd.confluence_report_thread_set_status(
            int(thread["id"]),
            "awaiting_owner",
            recipient="space.owner@samsung.com",
            owner_recipient="space.owner@samsung.com",
            notified_at=123.0,
            last_reason="report mailed",
        )
        return {"mode": "sent", "recipients": ["space.owner@samsung.com"]}

    monkeypatch.setattr(confluence_report_agent, "deliver_report_for_thread", fake_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:SYNC:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {
                "space_key": "SYNC",
                "page_id": "100",
                "title": "Runbook",
                "owner_email": "Space Owner <space.owner@samsung.com>",
            },
            "agent_verification": _agent_verification(),
        },
    )
    assert sd.confluence_report_threads_overview(space_key="SYNC") == []

    result = confluence_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    threads = sd.confluence_report_threads_overview(space_key="SYNC")
    assert len(threads) == 1
    thread = sd.confluence_report_thread_get(int(threads[0]["id"]))
    assert result["sync"]["seen"] == 1
    assert result["sync"]["new"] == 1
    assert result["sync"]["owner_recipient_count"] == 1
    assert result["sync"]["owner_missing_count"] == 0
    assert result["handled"] == 1
    assert result["sent"] == 1
    assert thread["status"] == "awaiting_owner"
    assert thread["recipient"] == "space.owner@samsung.com"
    assert thread["owner_recipient"] == "space.owner@samsung.com"
    assert sd.confluence_report_thread_finding_ids(int(thread["id"])) == [finding_id]
    assert captured["thread"]["owner_recipient"] == "space.owner@samsung.com"
    assert captured["report"]["finding_count"] == 1


def test_confluence_report_pass_invokes_delivery_result(tmp_db, tmp_path, monkeypatch) -> None:
    import service.state_domain as sd
    from service.agents import confluence_report_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(confluence_report_agent, "load_runtime_env", lambda load_plugins=False: None)

    async def fake_delivery(thread, report, *, evidence_dir, charter_ref=""):
        sd.confluence_report_thread_set_status(
            int(thread["id"]),
            "awaiting_owner",
            recipient="dssoc@samsung.com",
            notified_at=123.0,
            last_reason="report mailed",
        )
        return {"mode": "sent", "recipients": ["dssoc@samsung.com"]}

    monkeypatch.setattr(confluence_report_agent, "deliver_report_for_thread", fake_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
    )

    result = confluence_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["sent"] == 1
    assert result["dry_run"] == 0
    assert sd.confluence_report_thread_get(thread_id)["status"] == "awaiting_owner"


def test_confluence_report_pass_counts_dry_run_without_sending(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from service.agents import confluence_report_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(confluence_report_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(confluence_report_agent, "sync_report_threads", lambda: {"synced": 0})

    async def fake_delivery(thread, report, *, evidence_dir, charter_ref=""):
        sd.confluence_report_thread_set_status(
            int(thread["id"]),
            "report_ready",
            last_reason="dry-run draft created",
        )
        return {"mode": "dry_run", "recipients": ["dssoc@samsung.com"]}

    monkeypatch.setattr(confluence_report_agent, "deliver_report_for_thread", fake_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
    )

    result = confluence_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    updated = sd.confluence_report_thread_get(thread_id)
    assert result["handled"] == 1
    assert result["reports"] == 1
    assert result["sent"] == 0
    assert result["dry_run"] == 1
    assert updated["status"] == "report_ready"
    assert updated["notified_at"] is None
    assert "dry-run draft" in updated["last_reason"]
    assert sd.service_reply_messages_for_thread("confluence", thread_id) == []


def test_confluence_report_pass_counts_delivery_error_without_sending(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from service.agents import confluence_report_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(confluence_report_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(confluence_report_agent, "sync_report_threads", lambda: {"synced": 0})

    async def fail_delivery(thread, report, *, evidence_dir, charter_ref=""):
        raise RuntimeError("knox mail unavailable")

    monkeypatch.setattr(confluence_report_agent, "deliver_report_for_thread", fail_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
    )

    result = confluence_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    updated = sd.confluence_report_thread_get(thread_id)
    assert result["handled"] == 1
    assert result["reports"] == 1
    assert result["sent"] == 0
    assert result["dry_run"] == 0
    assert result["errors"] == 1
    assert updated["status"] == "report_ready"
    assert updated["notified_at"] is None
    assert "delivery failed" in updated["last_reason"]
    assert "knox mail unavailable" in updated["last_reason"]
    assert sd.service_reply_messages_for_thread("confluence", thread_id) == []


def test_confluence_report_pass_skips_empty_scope_filtered_report(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from service.agents import confluence_report_agent
    from secu_agent import state as core_state

    monkeypatch.setattr(confluence_report_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(confluence_report_agent, "sync_report_threads", lambda: {"synced": 0})

    async def fail_delivery(*args, **kwargs):
        raise AssertionError("empty report must not be delivered")

    monkeypatch.setattr(confluence_report_agent, "deliver_report_for_thread", fail_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OTHER:100",
        asset_kind="page",
        severity="high",
        summary="Confluence finding outside thread space",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_other_****"}],
            "metadata": {"space_key": "OTHER", "page_id": "100", "title": "Other Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
    )

    result = confluence_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    updated = sd.confluence_report_thread_get(thread_id)
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
    assert sd.service_reply_messages_for_thread("confluence", thread_id) == []


def test_confluence_report_pass_exception_schedules_retry(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from service.agents import confluence_report_agent
    from secu_agent import state as core_state

    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "41")
    monkeypatch.setattr(confluence_report_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(confluence_report_agent, "sync_report_threads", lambda: {"synced": 0})
    monkeypatch.setattr(
        confluence_report_agent,
        "build_report_for_thread",
        lambda thread: (_ for _ in ()).throw(RuntimeError("confluence report renderer exploded")),
    )

    async def fail_delivery(*args, **kwargs):
        raise AssertionError("delivery must not run after report build exception")

    monkeypatch.setattr(confluence_report_agent, "deliver_report_for_thread", fail_delivery)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="Confluence page secret exposure",
        extra={
            "hits": [{"kind": "api_key", "masked": "sk_live_****"}],
            "metadata": {"space_key": "OPS", "page_id": "100", "title": "Runbook"},
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
    )

    before = time.time()
    result = confluence_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    updated = sd.confluence_report_thread_get(thread_id)
    assert result["handled"] == 1
    assert result["reports"] == 0
    assert result["errors"] == 1
    assert updated["status"] == "reported"
    assert "report pass failed" in updated["last_reason"]
    assert "confluence report renderer exploded" in updated["last_reason"]
    assert updated["retry_after"] >= before + 40
    assert sd.confluence_report_thread_claim_next(session_id=12345, status="reported") is None

    second = confluence_report_agent.run_report_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )
    assert second["handled"] == 0
