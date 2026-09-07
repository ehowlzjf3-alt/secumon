from __future__ import annotations

import json
import re
import time
from html import unescape

from fastapi.testclient import TestClient


def _operator_evidence(message: dict) -> dict:
    body_html = str(message.get("body_html") or "")
    match = re.search(r"<pre[^>]*>(.*)</pre>", body_html, re.DOTALL)
    assert match is not None
    return json.loads(unescape(match.group(1)))


def test_github_webapp_is_standalone_and_git_only(tmp_db) -> None:
    from domains.services.github.webapp.app import create_app

    client = TestClient(create_app())

    assert client.get("/api/health").json()["service"] == "github-e2e"
    assert client.post(
        "/api/cron/set",
        json={"component": "task", "enabled": False},
    ).status_code == 400
    ok = client.post(
        "/api/cron/set",
        json={"component": "github.scan", "enabled": False},
    )
    assert ok.status_code == 200
    assert ok.json()["component"] == "github.scan"
    assert ok.json()["enabled"] == 0


def test_github_webapp_reports_and_recheck_request(tmp_db) -> None:
    from domains.services.github.webapp.app import create_app
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
            "metadata": {
                "repo": "org/repo",
                "path": ".env",
                "scan_method": "api_code_search_detail_scan",
                "candidate_source": "code_search",
                "candidate_query": "repo:org/repo AKIA",
            },
        },
    )
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=finding_id,
        repo="org/repo",
        severity="high",
        status="reported",
    )
    sd.github_report_thread_set_status(
        thread_id,
        "report_ready",
        report_json=json.dumps({"repo": "org/repo", "finding_count": 1}),
        report_html="<h1>org/repo</h1>",
    )
    sd.service_reply_message_add(
        domain="github",
        direction="in",
        thread_id=thread_id,
        message_id="github-reply-1",
        subject="[GitHub 보안취약점 조치요청](org/repo)",
        subject_tag="[GitHub 보안취약점 조치요청](org/repo)",
        mail_from="owner@samsung.com",
        mail_to="dssoc@samsung.com",
        body_excerpt="조치 완료했습니다.",
        body_html="<p>조치 완료했습니다.</p><table><tr><td>증적</td></tr></table>",
        agent_verdict="classified_remediation_claim",
        decision_reason="답장 신규 본문에서 조치 완료 주장을 확인함",
        extracted_owner={"email": "owner@samsung.com"},
        received_at=1000.0,
    )
    sd.service_reply_message_add(
        domain="confluence",
        direction="in",
        thread_id=thread_id,
        message_id="wrong-domain-reply",
        subject="[Confluence 보안취약점 조치요청](OPS)",
        subject_tag="[Confluence 보안취약점 조치요청](OPS)",
        mail_from="owner@samsung.com",
        mail_to="dssoc@samsung.com",
        body_excerpt="다른 도메인 메시지",
        body_html="<p>wrong domain html</p>",
        agent_verdict="pending",
        received_at=1001.0,
    )
    sd.github_recheck_result_add(
        thread_id=thread_id,
        finding_id=finding_id,
        repo="org/repo",
        path=".env",
        verdict="now_closed",
        verification={
            "method": "api_head_detail_refetch",
            "matched": False,
            "head_sha": "head-api",
            "detail_fetched": True,
        },
    )

    client = TestClient(create_app())
    listing = client.get("/api/reports").json()
    assert listing["items"][0]["repo"] == "org/repo"
    assert listing["items"][0]["finding_count"] == 1
    assert listing["items"][0]["verification_counts"] == {"live_in_HEAD": 1}
    assert listing["items"][0]["scan_method_counts"] == {"api_code_search_detail_scan": 1}
    assert listing["items"][0]["finding_tags"] == [
        {"key": "github_pat", "label": "GitHub PAT"},
        {"key": "live_head", "label": "HEAD Live"},
    ]

    detail = client.get(f"/api/reports/{thread_id}").json()
    assert detail["thread"]["report"]["repo"] == "org/repo"
    assert detail["thread"]["scan_method_counts"] == {"api_code_search_detail_scan": 1}
    assert detail["thread"]["has_report"] is True
    assert detail["findings"][0]["asset"] == "github:org/repo/.env"
    assert detail["findings"][0]["extra"]["metadata"]["candidate_source"] == "code_search"
    assert detail["findings"][0]["extra"]["metadata"]["candidate_query"] == "repo:org/repo AKIA"
    assert [m["message_id"] for m in detail["messages"]] == ["github-reply-1"]
    assert detail["messages"][0]["body_excerpt"] == "조치 완료했습니다."
    assert detail["messages"][0]["body_html"] == (
        "<p>조치 완료했습니다.</p><table><tr><td>증적</td></tr></table>"
    )
    assert "wrong domain html" not in detail["messages"][0]["body_html"]
    assert detail["messages"][0]["decision_reason"] == "답장 신규 본문에서 조치 완료 주장을 확인함"
    assert detail["messages"][0]["extracted_owner"] == {"email": "owner@samsung.com"}
    assert detail["rechecks"][0]["verification"]["method"] == "api_head_detail_refetch"
    assert detail["rechecks"][0]["verification"]["matched"] is False
    assert detail["rechecks"][0]["verification"]["head_sha"] == "head-api"
    assert detail["rechecks"][0]["verification"]["detail_fetched"] is True
    assert detail["rechecks"][0]["verdict"] == "now_closed"

    requested = client.post(f"/api/reports/{thread_id}/request-recheck")
    assert requested.status_code == 200
    assert requested.json()["thread"]["status"] == "recheck_requested"


def test_github_webapp_has_report_ignores_empty_report_payload(tmp_db) -> None:
    from domains.services.github.webapp.app import create_app
    from service import state_domain as sd

    _, thread_id = sd.github_report_thread_upsert(
        finding_id=901,
        repo="org/empty-report",
        severity="medium",
        status="reported",
    )

    client = TestClient(create_app())
    detail = client.get(f"/api/reports/{thread_id}").json()["thread"]
    assert detail["report"] == {}
    assert detail["has_report"] is False

    sd.github_report_thread_set_status(
        thread_id,
        "report_ready",
        report_json=json.dumps({"repo": "org/empty-report", "finding_count": 1}),
        report_html=None,
    )

    detail = client.get(f"/api/reports/{thread_id}").json()["thread"]
    assert detail["has_report"] is True


def test_github_webapp_reports_default_to_current_cycle(tmp_db, monkeypatch) -> None:
    from domains.services.github.webapp.app import create_app
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, old_id = sd.github_report_thread_upsert(
        finding_id=101,
        repo="org/old",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    _, current_id = sd.github_report_thread_upsert(
        finding_id=102,
        repo="org/current",
        severity="medium",
        status="reported",
        cycle_key="2026-W28",
    )

    client = TestClient(create_app())
    current = client.get("/api/reports")

    assert current.status_code == 200
    body = current.json()
    ids = {item["id"] for item in body["items"]}
    assert body["cycle_key"] == "2026-W28"
    assert body["current_cycle_key"] == "2026-W28"
    assert current_id in ids
    assert old_id not in ids
    assert body["status_counts"]["reported"] == 1
    assert body["cycles"][:2] == ["2026-W28", "2026-W27"]

    previous = client.get("/api/reports?cycle_key=2026-W27")
    previous_body = previous.json()
    previous_ids = {item["id"] for item in previous_body["items"]}
    assert previous_body["cycle_key"] == "2026-W27"
    assert previous_body["current_cycle_key"] == "2026-W28"
    assert old_id in previous_ids
    assert current_id not in previous_ids
    all_cycles = client.get("/api/reports?cycle_key=all")
    all_body = all_cycles.json()
    all_ids = {item["id"] for item in all_body["items"]}
    assert all_cycles.status_code == 200
    assert all_body["cycle_key"] is None
    assert all_body["current_cycle_key"] == "2026-W28"
    assert all_body["status_counts"]["reported"] == 2
    assert old_id in all_ids
    assert current_id in all_ids
    invalid = client.get("/api/reports?cycle_key=not-a-week")
    assert invalid.status_code == 400
    assert "invalid cycle_key" in invalid.json()["detail"]

    filtered = client.get(
        "/api/reports?cycle_key=2026-W28&status=reported&repo=org/current",
    )
    filtered_body = filtered.json()
    assert [item["id"] for item in filtered_body["items"]] == [current_id]

    cross_cycle = client.get(
        "/api/reports?cycle_key=2026-W28&status=reported&repo=org/old",
    )
    assert cross_cycle.json()["items"] == []


def test_github_report_api_exposes_weekly_recurrence_summary(tmp_db, monkeypatch) -> None:
    from domains.services.github.webapp.app import create_app
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, old_id = sd.github_report_thread_upsert(
        finding_id=120,
        repo="org/recur-api",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    sd.github_report_thread_set_status(old_id, "awaiting_owner")
    action, current_id = sd.github_report_thread_upsert(
        finding_id=120,
        repo="org/recur-api",
        severity="critical",
        status="reported",
        cycle_key="2026-W28",
    )
    assert action == "recurred"

    client = TestClient(create_app())
    listing = client.get("/api/reports?cycle_key=2026-W28")
    assert listing.status_code == 200
    item = next(row for row in listing.json()["items"] if row["id"] == current_id)

    assert item["cycle_keys"] == ["2026-W27", "2026-W28"]
    assert item["first_cycle_key"] == "2026-W27"
    assert item["last_cycle_key"] == "2026-W28"
    assert item["accumulated_week_count"] == 2
    assert item["recurrence_count"] == 1
    assert item["is_recurring"] is True
    assert item["is_current_cycle"] is True

    detail = client.get(f"/api/reports/{current_id}").json()["thread"]
    assert detail["cycle_keys"] == ["2026-W27", "2026-W28"]
    assert detail["first_cycle_key"] == "2026-W27"
    assert detail["last_cycle_key"] == "2026-W28"
    assert detail["accumulated_week_count"] == 2
    assert detail["recurrence_count"] == 1
    assert detail["is_recurring"] is True


def test_github_report_detail_honors_explicit_cycle_filter(tmp_db, monkeypatch) -> None:
    from domains.services.github.webapp.app import create_app
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, old_id = sd.github_report_thread_upsert(
        finding_id=130,
        repo="org/old-detail",
        severity="high",
        status="report_ready",
        cycle_key="2026-W27",
    )
    _, current_id = sd.github_report_thread_upsert(
        finding_id=131,
        repo="org/current-detail",
        severity="high",
        status="report_ready",
        cycle_key="2026-W28",
    )

    client = TestClient(create_app())

    assert client.get(f"/api/reports/{current_id}?cycle_key=2026-W28").status_code == 200
    assert client.get(f"/api/reports/{current_id}").status_code == 200
    default_old = client.get(f"/api/reports/{old_id}")
    assert default_old.status_code == 404
    assert "not found in cycle" in default_old.json()["detail"]
    assert client.get(f"/api/reports/{old_id}?cycle_key=2026-W27").status_code == 200
    assert client.get(f"/api/reports/{old_id}?cycle_key=all").status_code == 200
    mismatch = client.get(f"/api/reports/{old_id}?cycle_key=2026-W28")
    assert mismatch.status_code == 404
    assert "not found in cycle" in mismatch.json()["detail"]


def test_confluence_report_detail_honors_explicit_cycle_filter(tmp_db, monkeypatch) -> None:
    from domains.services.confluence.webapp.app import create_app
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, old_id = sd.confluence_report_thread_upsert(
        finding_id=140,
        space_key="OLDDET",
        severity="high",
        status="report_ready",
        cycle_key="2026-W27",
    )
    _, current_id = sd.confluence_report_thread_upsert(
        finding_id=141,
        space_key="CURDET",
        severity="high",
        status="report_ready",
        cycle_key="2026-W28",
    )

    client = TestClient(create_app())

    assert client.get(f"/api/reports/{current_id}?cycle_key=2026-W28").status_code == 200
    assert client.get(f"/api/reports/{current_id}").status_code == 200
    default_old = client.get(f"/api/reports/{old_id}")
    assert default_old.status_code == 404
    assert "not found in cycle" in default_old.json()["detail"]
    assert client.get(f"/api/reports/{old_id}?cycle_key=2026-W27").status_code == 200
    assert client.get(f"/api/reports/{old_id}?cycle_key=all").status_code == 200
    mismatch = client.get(f"/api/reports/{old_id}?cycle_key=2026-W28")
    assert mismatch.status_code == 404
    assert "not found in cycle" in mismatch.json()["detail"]


def test_github_webapp_request_recheck_is_current_cycle_and_active_status_only(
    tmp_db,
    monkeypatch,
) -> None:
    from domains.services.github.webapp.app import create_app
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, current_id = sd.github_report_thread_upsert(
        finding_id=121,
        repo="org/current-recheck",
        severity="high",
        status="report_ready",
        cycle_key="2026-W28",
    )
    sd.github_report_thread_set_status(
        current_id,
        "report_ready",
        claimed_by=99,
        claimed_at=time.time(),
        retry_after=time.time() + 3600,
    )
    _, old_id = sd.github_report_thread_upsert(
        finding_id=122,
        repo="org/old-recheck",
        severity="high",
        status="report_ready",
        cycle_key="2026-W27",
    )
    _, closed_id = sd.github_report_thread_upsert(
        finding_id=123,
        repo="org/closed-recheck",
        severity="low",
        status="closed",
        cycle_key="2026-W28",
    )
    _, reported_id = sd.github_report_thread_upsert(
        finding_id=124,
        repo="org/reported-recheck",
        severity="medium",
        status="reported",
        cycle_key="2026-W28",
    )

    client = TestClient(create_app())
    ok = client.post(f"/api/reports/{current_id}/request-recheck")
    old = client.post(f"/api/reports/{old_id}/request-recheck")
    terminal = client.post(f"/api/reports/{closed_id}/request-recheck")
    pre_report = client.post(f"/api/reports/{reported_id}/request-recheck")

    assert ok.status_code == 200
    thread = sd.github_report_thread_get(current_id)
    assert thread["status"] == "recheck_requested"
    assert thread["claimed_by"] is None
    assert thread["claimed_at"] is None
    assert thread["retry_after"] is None
    assert thread["last_reason"] == "manual recheck requested from github webapp"
    messages = sd.service_reply_messages_for_thread("github", current_id)
    assert messages[-1]["direction"] == "operator"
    assert messages[-1]["agent_verdict"] == "operator_manual_recheck_requested"
    evidence = _operator_evidence(messages[-1])
    assert evidence["before"]["status"] == "report_ready"
    assert evidence["before"]["claimed_by"] == 99
    assert evidence["after"]["status"] == "recheck_requested"
    assert evidence["after"]["claimed_by"] is None
    assert evidence["after"]["claimed_at"] is None
    assert evidence["after"]["retry_after"] is None
    assert evidence["after"]["last_reason"] == "manual recheck requested from github webapp"
    assert ok.json()["thread"]["is_current_cycle"] is True
    assert ok.json()["thread"]["can_request_recheck"] is True

    assert old.status_code == 400
    assert terminal.status_code == 400
    assert pre_report.status_code == 400
    assert sd.github_report_thread_get(old_id)["status"] == "report_ready"
    assert sd.github_report_thread_get(closed_id)["status"] == "closed"
    assert sd.github_report_thread_get(reported_id)["status"] == "reported"
    old_detail = client.get(f"/api/reports/{old_id}?cycle_key=2026-W27").json()["thread"]
    closed_detail = client.get(f"/api/reports/{closed_id}").json()["thread"]
    assert old_detail["is_current_cycle"] is False
    assert old_detail["can_request_recheck"] is False
    assert closed_detail["is_current_cycle"] is True
    assert closed_detail["can_request_recheck"] is False


def test_github_reports_ui_exposes_cycle_filter(tmp_db) -> None:
    from domains.services.github.webapp.app import create_app

    response = TestClient(create_app()).get("/")

    assert response.status_code == 200
    html = response.text
    assert "cycleKey" in html
    assert "applyReportCycle" in html
    assert "cycle_key:reportState.cycleKey||''" in html
    assert 'id="rcycle"' in html
    assert "d.cycles" in html
    assert "resetClaim" in html
    assert "/api/pipeline/reset-claim" in html
    assert "operator reset from dashboard" in html


def test_github_pipeline_report_stage_is_current_cycle_only(tmp_db, monkeypatch) -> None:
    from domains.services.github.webapp.pipeline_view import github_pipeline_overview
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    sd.github_report_thread_upsert(
        finding_id=301,
        repo="org/old",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    _, current_id = sd.github_report_thread_upsert(
        finding_id=302,
        repo="org/current",
        severity="medium",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        status="reported",
        cycle_key="2026-W28",
    )
    _, cooling_id = sd.github_report_thread_upsert(
        finding_id=303,
        repo="org/report-cooling",
        severity="high",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        status="reported",
        cycle_key="2026-W28",
    )
    sd.github_report_thread_set_status(
        cooling_id,
        "reported",
        retry_after=time.time() + 3600,
    )

    body = github_pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    next_refs = {target["session_ref"] for target in stages["report"]["targets"]["next"]}

    assert body["cycle_key"] == "2026-W28"
    assert body["report_thread_status_counts"]["reported"] == 2
    assert stages["report"]["queue"] == 1
    assert f"github-thread-{current_id}" in next_refs
    assert f"github-thread-{cooling_id}" not in next_refs


def test_github_pipeline_scan_stage_moves_stale_claims_back_to_queue(tmp_db) -> None:
    from domains.services.github.application.contracts import GITHUB_SCAN_SESSION_ID
    from domains.services.github.webapp.pipeline_view import github_pipeline_overview
    from service import state_domain as sd

    ready_id = sd.github_repo_target_upsert("org/ready")
    stale_id = sd.github_repo_target_upsert("org/stale")
    fresh_id = sd.github_repo_target_upsert("org/fresh")
    null_claim_id = sd.github_repo_target_upsert("org/null-claim")
    cooling_id = sd.github_repo_target_upsert("org/cooling")
    with sd.connect() as c:
        c.execute(
            "UPDATE github_repo_target SET retry_after=? WHERE id=?",
            (time.time() + 3600, cooling_id),
        )
    sd.github_repo_target_set_status(
        stale_id,
        "in_progress",
        claimed_by=GITHUB_SCAN_SESSION_ID,
        claimed_at=1000.0,
    )
    sd.github_repo_target_set_status(
        fresh_id,
        "in_progress",
        claimed_by=GITHUB_SCAN_SESSION_ID,
        claimed_at=time.time(),
    )
    with sd.connect() as c:
        c.execute(
            "UPDATE github_repo_target SET status='in_progress', claimed_by=?, claimed_at=NULL WHERE id=?",
            (GITHUB_SCAN_SESSION_ID, null_claim_id),
        )

    body = github_pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    scan_metrics = {m["label"]: m["value"] for m in stages["scan"]["metrics"]}
    active_refs = {target["session_ref"] for target in stages["scan"]["targets"]["active"]}
    next_refs = {target["session_ref"] for target in stages["scan"]["targets"]["next"]}

    assert stages["scan"]["queue"] == 2
    assert stages["scan"]["processing"] == 1
    assert scan_metrics["스캔 대기 repo"] == 2
    assert scan_metrics["스캔 중 repo"] == 1
    assert active_refs == {f"repo-{fresh_id}"}
    assert next_refs == {f"repo-{ready_id}", f"repo-{stale_id}"}
    assert f"repo-{cooling_id}" not in next_refs
    assert f"repo-{null_claim_id}" not in next_refs
    assert stages["scan"]["stuck"] == 2
    assert {target["session_ref"] for target in stages["scan"]["targets"]["stuck"]} == {
        f"repo-{stale_id}",
        f"repo-{null_claim_id}",
    }


def test_github_pipeline_surfaces_wrong_session_claims_as_stuck(tmp_db) -> None:
    from domains.services.github.webapp.pipeline_view import github_pipeline_overview
    from service import state_domain as sd

    now = time.time()
    scan_id = sd.github_repo_target_upsert("org/claimed-by-other")
    sd.github_repo_target_set_status(
        scan_id,
        "in_progress",
        claimed_by=999_001,
        claimed_at=now,
    )
    _, report_id = sd.github_report_thread_upsert(
        finding_id=330,
        repo="org/report-claimed-by-other",
        severity="high",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        status="reported",
    )
    _, recheck_id = sd.github_report_thread_upsert(
        finding_id=331,
        repo="org/recheck-claimed-by-other",
        severity="high",
        status="recheck_requested",
    )
    _, guidance_id = sd.github_report_thread_upsert(
        finding_id=332,
        repo="org/guidance-claimed-by-other",
        severity="medium",
        status="awaiting_owner",
    )
    with sd.connect() as c:
        c.execute(
            "UPDATE github_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (999_002, now, report_id),
        )
        c.execute(
            "UPDATE github_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (999_003, now, recheck_id),
        )
        c.execute(
            "UPDATE github_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (999_004, now, guidance_id),
        )

    body = github_pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    scan_stuck = {target["session_ref"] for target in stages["scan"]["targets"]["stuck"]}
    report_stuck = {target["session_ref"] for target in stages["report"]["targets"]["stuck"]}
    reply_stuck = {target["session_ref"] for target in stages["reply"]["targets"]["stuck"]}
    recheck_stuck = {target["session_ref"] for target in stages["recheck"]["targets"]["stuck"]}
    scan_metrics = {m["label"]: m["value"] for m in stages["scan"]["metrics"]}
    report_metrics = {m["label"]: m["value"] for m in stages["report"]["metrics"]}
    reply_metrics = {m["label"]: m["value"] for m in stages["reply"]["metrics"]}
    recheck_metrics = {m["label"]: m["value"] for m in stages["recheck"]["metrics"]}
    reply_next = {target["session_ref"] for target in stages["reply"]["targets"]["next"]}
    recheck_next = {target["session_ref"] for target in stages["recheck"]["targets"]["next"]}

    assert stages["scan"]["queue"] == 0
    assert stages["scan"]["processing"] == 0
    assert stages["scan"]["stuck"] == 1
    assert scan_metrics["멈춘 claim"] == 1
    assert scan_stuck == {f"repo-{scan_id}"}

    assert stages["report"]["queue"] == 0
    assert stages["report"]["processing"] == 0
    assert stages["report"]["stuck"] == 1
    assert report_metrics["멈춘 claim"] == 1
    assert report_stuck == {f"github-thread-{report_id}"}

    assert stages["reply"]["queue"] == 0
    assert stages["reply"]["processing"] == 0
    assert stages["reply"]["stuck"] == 1
    assert reply_metrics["답장 대기 repo"] == 0
    assert reply_metrics["멈춘 claim"] == 1
    assert f"github-thread-{guidance_id}" not in reply_next
    assert reply_stuck == {f"github-thread-{guidance_id}"}

    assert stages["recheck"]["queue"] == 0
    assert stages["recheck"]["processing"] == 0
    assert stages["recheck"]["stuck"] == 1
    assert recheck_metrics["재검증 대기"] == 0
    assert recheck_metrics["멈춘 claim"] == 1
    assert f"github-thread-{recheck_id}" not in recheck_next
    assert recheck_stuck == {f"github-thread-{recheck_id}"}
    assert all(
        target["session_ref"] != f"github-thread-{recheck_id}"
        for target in stages["reply"]["targets"].get("active", [])
    )


def test_github_pipeline_exposes_sso_url_lane_without_service_overlap(
    tmp_db,
    monkeypatch,
) -> None:
    from domains.services.github.application.contracts import GITHUB_SSO_TASK_SESSION_ID
    from domains.services.github.webapp.pipeline_view import github_pipeline_overview
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    day = "2026-06-30"
    ready_id = sd.devops_target_upsert(
        "https://github.samsungds.net/org/ready",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=10,
    )
    active_id = sd.devops_target_upsert(
        "https://github.samsungds.net/org/active",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=5,
    )
    stuck_id = sd.devops_target_upsert(
        "https://github.samsungds.net/org/stuck",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=1,
    )
    cooling_id = sd.devops_target_upsert(
        "https://github.samsungds.net/org/cooling",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=50,
    )
    sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/OPS",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=99,
    )
    sd.devops_target_set_status(
        active_id,
        "in_progress",
        claimed_by=GITHUB_SSO_TASK_SESSION_ID,
        claimed_at=time.time(),
    )
    sd.devops_target_set_status(
        stuck_id,
        "in_progress",
        claimed_by=999_004,
        claimed_at=time.time(),
    )
    with sd.connect() as c:
        c.execute(
            "UPDATE devops_target SET retry_after=? WHERE id=?",
            (time.time() + 3600, cooling_id),
        )

    body = github_pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    sso_discovery_metrics = {m["label"]: m["value"] for m in stages["sso_discovery"]["metrics"]}
    sso_task_metrics = {m["label"]: m["value"] for m in stages["sso_task"]["metrics"]}
    sso_active = {target["session_ref"] for target in stages["sso_task"]["targets"]["active"]}
    sso_next = {target["session_ref"] for target in stages["sso_task"]["targets"]["next"]}
    sso_stuck = {target["session_ref"] for target in stages["sso_task"]["targets"]["stuck"]}

    assert body["cycle_key"] == "2026-W28"
    assert body["sso_status_counts"]["total"] == 4
    assert stages["sso_discovery"]["done"] == 4
    assert sso_discovery_metrics["SSO URL 전체"] == 4
    assert stages["sso_task"]["queue"] == 1
    assert stages["sso_task"]["processing"] == 1
    assert stages["sso_task"]["stuck"] == 1
    assert sso_task_metrics["SSO 점검 대기"] == 1
    assert sso_task_metrics["SSO 점검 중"] == 1
    assert sso_task_metrics["멈춘 claim"] == 1
    assert sso_active == {f"devops-{active_id}"}
    assert sso_next == {f"devops-{ready_id}"}
    assert f"devops-{cooling_id}" not in sso_next
    assert sso_stuck == {f"devops-{stuck_id}"}


def test_github_webapp_resets_only_stuck_claims_and_preserves_domain(
    tmp_db,
    monkeypatch,
) -> None:
    from domains.services.github.application.contracts import (
        COMPONENT_GITHUB_RECHECK,
        COMPONENT_GITHUB_REPORT,
        COMPONENT_GITHUB_SCAN,
        COMPONENT_GITHUB_SSO_TASK,
        GITHUB_SCAN_SESSION_ID,
    )
    from domains.services.github.webapp.app import create_app
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    now = time.time()
    day = "2026-06-30"
    scan_stuck = sd.github_repo_target_upsert("org/reset-stuck")
    scan_active = sd.github_repo_target_upsert("org/reset-active")
    sd.github_repo_target_set_status(
        scan_stuck,
        "in_progress",
        claimed_by=999_101,
        claimed_at=now,
    )
    sd.github_repo_target_set_status(
        scan_active,
        "in_progress",
        claimed_by=GITHUB_SCAN_SESSION_ID,
        claimed_at=now,
    )
    github_sso = sd.devops_target_upsert(
        "https://github.samsungds.net/org/reset-stuck",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=5,
    )
    confluence_sso = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/RESET",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=9,
    )
    sd.devops_target_set_status(github_sso, "in_progress", claimed_by=999_102, claimed_at=now)
    sd.devops_target_set_status(confluence_sso, "in_progress", claimed_by=999_103, claimed_at=now)
    _, report_id = sd.github_report_thread_upsert(
        finding_id=701,
        repo="org/report-reset",
        severity="high",
        status="reported",
        cycle_key="2026-W28",
    )
    _, recheck_id = sd.github_report_thread_upsert(
        finding_id=702,
        repo="org/recheck-reset",
        severity="high",
        status="rechecking",
        cycle_key="2026-W28",
    )
    _, guidance_id = sd.github_report_thread_upsert(
        finding_id=703,
        repo="org/guidance-reset",
        severity="medium",
        status="awaiting_owner",
        cycle_key="2026-W28",
    )
    with sd.connect() as c:
        c.execute(
            "UPDATE github_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (999_104, now, report_id),
        )
        c.execute(
            "UPDATE github_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (999_105, now, recheck_id),
        )
        c.execute(
            "UPDATE github_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (999_106, now, guidance_id),
        )

    client = TestClient(create_app())

    active = client.post(
        "/api/pipeline/reset-claim",
        json={"component": COMPONENT_GITHUB_SCAN, "session_ref": f"repo-{scan_active}"},
    )
    assert active.status_code == 409

    unsupported = client.post(
        "/api/pipeline/reset-claim",
        json={"component": "task", "session_ref": f"repo-{scan_stuck}"},
    )
    assert unsupported.status_code == 400

    wrong_prefix = client.post(
        "/api/pipeline/reset-claim",
        json={"component": COMPONENT_GITHUB_SCAN, "session_ref": f"devops-{github_sso}"},
    )
    assert wrong_prefix.status_code == 400

    for component, ref in [
        (COMPONENT_GITHUB_SCAN, f"repo-{scan_stuck}"),
        (COMPONENT_GITHUB_SSO_TASK, f"devops-{github_sso}"),
        (COMPONENT_GITHUB_REPORT, f"github-thread-{report_id}"),
        (COMPONENT_GITHUB_RECHECK, f"github-thread-{recheck_id}"),
        (COMPONENT_GITHUB_RECHECK, f"github-thread-{guidance_id}"),
    ]:
        response = client.post(
            "/api/pipeline/reset-claim",
            json={"component": component, "session_ref": ref, "reason": "test reset"},
        )
        assert response.status_code == 200
        assert response.json()["session_ref"] == ref

    assert sd.github_repo_target_get(scan_stuck)["status"] == "pending"
    assert sd.github_repo_target_get(scan_stuck)["claimed_by"] is None
    assert sd.github_repo_target_get(scan_active)["status"] == "in_progress"
    assert sd.github_repo_target_get(scan_active)["claimed_by"] == GITHUB_SCAN_SESSION_ID
    assert sd.devops_target_get(github_sso)["status"] == "pending"
    assert sd.devops_target_get(github_sso)["claimed_by"] is None
    assert sd.devops_target_get(confluence_sso)["status"] == "in_progress"
    assert sd.devops_target_get(confluence_sso)["claimed_by"] == 999_103
    assert sd.github_report_thread_get(report_id)["status"] == "reported"
    assert sd.github_report_thread_get(report_id)["claimed_by"] is None
    assert sd.github_report_thread_get(recheck_id)["status"] == "recheck_requested"
    assert sd.github_report_thread_get(recheck_id)["claimed_by"] is None
    assert sd.github_report_thread_get(guidance_id)["status"] == "awaiting_owner"
    assert sd.github_report_thread_get(guidance_id)["claimed_by"] is None
    for thread_id, before_status, before_claimed_by, after_status in [
        (report_id, "reported", 999_104, "reported"),
        (recheck_id, "rechecking", 999_105, "recheck_requested"),
        (guidance_id, "awaiting_owner", 999_106, "awaiting_owner"),
    ]:
        messages = sd.service_reply_messages_for_thread("github", thread_id)
        assert messages[-1]["direction"] == "operator"
        assert messages[-1]["agent_verdict"] == "operator_claim_reset"
        assert messages[-1]["decision_reason"] == "test reset"
        evidence = _operator_evidence(messages[-1])
        assert evidence["action"] == "operator_claim_reset"
        assert evidence["before"]["status"] == before_status
        assert evidence["before"]["claimed_by"] == before_claimed_by
        assert evidence["after"]["status"] == after_status
        assert evidence["after"]["claimed_by"] is None
        assert evidence["after"]["claimed_at"] is None
        assert evidence["after"]["retry_after"] is None
        assert evidence["after"]["last_reason"] == "test reset"
        assert evidence["after"]["component"] in {COMPONENT_GITHUB_REPORT, COMPONENT_GITHUB_RECHECK}


def test_github_webapp_reset_claim_rejects_old_cycle_targets_and_threads(
    tmp_db,
    monkeypatch,
) -> None:
    from domains.services.github.application.contracts import (
        COMPONENT_GITHUB_RECHECK,
        COMPONENT_GITHUB_REPORT,
        COMPONENT_GITHUB_SCAN,
        COMPONENT_GITHUB_SSO_TASK,
    )
    from domains.services.github.webapp.app import create_app
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    now = time.time()
    old_scan = sd.github_repo_target_upsert("org/old-reset-stuck")
    old_sso = sd.devops_target_upsert(
        "https://github.samsungds.net/org/old-reset-stuck",
        service="github",
        source="proxy",
        day_bucket="2026-06-23",
        access_count=5,
    )
    sd.github_repo_target_set_status(
        old_scan,
        "in_progress",
        claimed_by=999_111,
        claimed_at=now,
        cycle_key="2026-W27",
    )
    sd.devops_target_set_status(
        old_sso,
        "in_progress",
        claimed_by=999_112,
        claimed_at=now,
        cycle_key="2026-W27",
    )
    _, old_report = sd.github_report_thread_upsert(
        finding_id=711,
        repo="org/old-report-reset",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    _, old_recheck = sd.github_report_thread_upsert(
        finding_id=712,
        repo="org/old-recheck-reset",
        severity="high",
        status="rechecking",
        cycle_key="2026-W27",
    )
    _, old_guidance = sd.github_report_thread_upsert(
        finding_id=713,
        repo="org/old-guidance-reset",
        severity="medium",
        status="awaiting_owner",
        cycle_key="2026-W27",
    )
    with sd.connect() as c:
        for thread_id, claimed_by in [
            (old_report, 999_113),
            (old_recheck, 999_114),
            (old_guidance, 999_115),
        ]:
            c.execute(
                "UPDATE github_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
                (claimed_by, now, thread_id),
            )

    client = TestClient(create_app())
    blocked = [
        (COMPONENT_GITHUB_SCAN, f"repo-{old_scan}"),
        (COMPONENT_GITHUB_SSO_TASK, f"devops-{old_sso}"),
        (COMPONENT_GITHUB_REPORT, f"github-thread-{old_report}"),
        (COMPONENT_GITHUB_RECHECK, f"github-thread-{old_recheck}"),
        (COMPONENT_GITHUB_RECHECK, f"github-thread-{old_guidance}"),
    ]
    for component, ref in blocked:
        response = client.post(
            "/api/pipeline/reset-claim",
            json={"component": component, "session_ref": ref, "reason": "old reset"},
        )
        assert response.status_code == 404

    assert sd.github_repo_target_get(old_scan)["status"] == "in_progress"
    assert sd.github_repo_target_get(old_scan)["claimed_by"] == 999_111
    assert sd.devops_target_get(old_sso)["status"] == "in_progress"
    assert sd.devops_target_get(old_sso)["claimed_by"] == 999_112
    assert sd.github_report_thread_get(old_report)["status"] == "reported"
    assert sd.github_report_thread_get(old_report)["claimed_by"] == 999_113
    assert sd.github_report_thread_get(old_recheck)["status"] == "rechecking"
    assert sd.github_report_thread_get(old_recheck)["claimed_by"] == 999_114
    assert sd.github_report_thread_get(old_guidance)["status"] == "awaiting_owner"
    assert sd.github_report_thread_get(old_guidance)["claimed_by"] == 999_115


def test_github_pipeline_ui_exposes_stuck_claim_reset(tmp_db) -> None:
    from domains.services.github.webapp.app import create_app

    response = TestClient(create_app()).get("/")

    assert response.status_code == 200
    html = response.text
    assert "resetClaim" in html
    assert "/api/pipeline/reset-claim" in html
    assert "operator reset from dashboard" in html


def test_github_pipeline_scan_stage_resets_on_new_week(tmp_db, monkeypatch) -> None:
    from domains.services.github.webapp.pipeline_view import github_pipeline_overview
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    repo_id = sd.github_repo_target_upsert("org/weekly")
    sd.github_repo_target_set_status(repo_id, "tasked", finding_count=1)

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    body = github_pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    discover_metrics = {m["label"]: m["value"] for m in stages["discover"]["metrics"]}
    scan_metrics = {m["label"]: m["value"] for m in stages["scan"]["metrics"]}
    next_refs = {target["session_ref"] for target in stages["scan"]["targets"]["next"]}

    assert body["cycle_key"] == "2026-W28"
    assert discover_metrics["미스캔 repo"] == 1
    assert discover_metrics["스캔 완료 repo"] == 0
    assert stages["scan"]["queue"] == 1
    assert stages["scan"]["done"] == 0
    assert scan_metrics["스캔 대기 repo"] == 1
    assert f"repo-{repo_id}" in next_refs


def test_github_pipeline_sso_stage_resets_on_new_week_without_confluence_overlap(
    tmp_db,
    monkeypatch,
) -> None:
    from domains.services.github.webapp.pipeline_view import github_pipeline_overview
    from service import state_domain as sd

    day = "2026-06-30"
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    github_id = sd.devops_target_upsert(
        "https://github.samsungds.net/org/weekly",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=17,
    )
    confluence_id = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/WEEKLY",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=99,
    )
    sd.devops_target_set_status(github_id, "tasked", finding_count=1)
    sd.devops_target_set_status(confluence_id, "tasked", finding_count=2)

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    body = github_pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    discovery_metrics = {m["label"]: m["value"] for m in stages["sso_discovery"]["metrics"]}
    task_metrics = {m["label"]: m["value"] for m in stages["sso_task"]["metrics"]}
    next_refs = {target["session_ref"] for target in stages["sso_task"]["targets"]["next"]}

    assert body["cycle_key"] == "2026-W28"
    assert body["sso_status_counts"]["total"] == 1
    assert discovery_metrics["SSO URL 전체"] == 1
    assert discovery_metrics["미점검 URL"] == 1
    assert discovery_metrics["점검 완료 URL"] == 0
    assert stages["sso_task"]["queue"] == 1
    assert stages["sso_task"]["done"] == 0
    assert task_metrics["SSO 점검 대기"] == 1
    assert f"devops-{github_id}" in next_refs

    github = sd.devops_target_get(github_id)
    confluence = sd.devops_target_get(confluence_id)
    assert github["cycle_key"] == "2026-W28"
    assert github["status"] == "pending"
    assert confluence["cycle_key"] == "2026-W27"
    assert confluence["status"] == "tasked"


def test_github_pipeline_owner_stage_is_current_cycle_only(tmp_db, monkeypatch) -> None:
    from domains.services.github.webapp.pipeline_view import github_pipeline_overview
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    sd.github_report_thread_upsert(
        finding_id=350,
        repo="org/old-owner",
        severity="high",
        recipient="old.owner@samsung.com",
        status="reported",
        cycle_key="2026-W27",
    )
    _, missing_id = sd.github_report_thread_upsert(
        finding_id=351,
        repo="org/missing-owner",
        severity="medium",
        status="reported",
        cycle_key="2026-W28",
    )
    _, owner_id = sd.github_report_thread_upsert(
        finding_id=352,
        repo="org/owner-ready",
        severity="high",
        recipient="owner.ready@samsung.com",
        status="reported",
        cycle_key="2026-W28",
    )
    sd.github_report_thread_set_status(
        owner_id,
        "awaiting_owner",
        recipient="dssoc@samsung.com",
        last_reason="report mailed",
    )
    _, fallback_id = sd.github_report_thread_upsert(
        finding_id=353,
        repo="org/fallback-only",
        severity="low",
        status="reported",
        cycle_key="2026-W28",
    )
    sd.github_report_thread_set_status(
        fallback_id,
        "report_ready",
        recipient="dssoc@samsung.com",
    )
    _, escalated_id = sd.github_report_thread_upsert(
        finding_id=354,
        repo="org/escalated-missing-owner",
        severity="high",
        status="escalated",
        cycle_key="2026-W28",
    )

    body = github_pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    owner_metrics = {m["label"]: m["value"] for m in stages["owner"]["metrics"]}
    owner_next = {target["session_ref"] for target in stages["owner"]["targets"]["next"]}
    report_next = {target["session_ref"] for target in stages["report"]["targets"]["next"]}
    done_metrics = {m["label"]: m["value"] for m in stages["done"]["metrics"]}

    assert stages["owner"]["queue"] == 3
    assert stages["owner"]["done"] == 1
    assert stages["report"]["queue"] == 0
    assert owner_metrics["담당자 대상 repo"] == 4
    assert owner_metrics["담당자 후보 있음"] == 1
    assert owner_metrics["담당자 후보 없음"] == 3
    assert owner_metrics["발송 수신자만 있음"] == 1
    assert f"github-thread-{missing_id}" in owner_next
    assert f"github-thread-{fallback_id}" in owner_next
    assert f"github-thread-{escalated_id}" in owner_next
    assert f"github-thread-{missing_id}" not in report_next
    assert f"github-thread-{fallback_id}" not in report_next
    assert f"github-thread-{escalated_id}" not in report_next
    assert f"github-thread-{owner_id}" not in owner_next
    assert done_metrics["에스컬레이션 repo"] == 1


def test_github_pipeline_report_done_counts_closed_current_cycle_threads(
    tmp_db, monkeypatch,
) -> None:
    from domains.services.github.webapp.pipeline_view import github_pipeline_overview
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, ready_id = sd.github_report_thread_upsert(
        finding_id=371,
        repo="org/report-ready-done",
        severity="high",
        status="report_ready",
        cycle_key="2026-W28",
    )
    _, closed_id = sd.github_report_thread_upsert(
        finding_id=372,
        repo="org/closed-done",
        severity="medium",
        status="closed",
        cycle_key="2026-W28",
    )
    sd.github_report_thread_upsert(
        finding_id=373,
        repo="org/old-closed-done",
        severity="low",
        status="closed",
        cycle_key="2026-W27",
    )

    body = github_pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    report_metrics = {m["label"]: m["value"] for m in stages["report"]["metrics"]}
    done_refs = {target["session_ref"] for target in stages["done"]["targets"]["next"]}

    assert body["cycle_key"] == "2026-W28"
    assert stages["report"]["done"] == 2
    assert report_metrics["리포트 작성"] == 2
    assert f"github-thread-{ready_id}" not in done_refs
    assert f"github-thread-{closed_id}" in done_refs


def test_github_pipeline_splits_reply_and_recheck_without_overlap(
    tmp_db, monkeypatch,
) -> None:
    from domains.services.github.webapp.pipeline_view import github_pipeline_overview
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    sd.github_report_thread_upsert(
        finding_id=401,
        repo="org/old",
        severity="high",
        status="awaiting_owner",
        cycle_key="2026-W27",
    )
    _, waiting_id = sd.github_report_thread_upsert(
        finding_id=402,
        repo="org/waiting",
        severity="medium",
        status="awaiting_owner",
        cycle_key="2026-W28",
    )
    _, recheck_id = sd.github_report_thread_upsert(
        finding_id=403,
        repo="org/recheck",
        severity="high",
        status="recheck_requested",
        cycle_key="2026-W28",
    )
    _, hitl_id = sd.github_report_thread_upsert(
        finding_id=404,
        repo="org/hitl",
        severity="high",
        status="owner_update_needed",
        cycle_key="2026-W28",
    )
    _, escalated_id = sd.github_report_thread_upsert(
        finding_id=405,
        repo="org/escalated-after-reply",
        severity="high",
        status="escalated",
        cycle_key="2026-W28",
    )

    body = github_pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    reply_metrics = {m["label"]: m["value"] for m in stages["reply"]["metrics"]}
    recheck_metrics = {m["label"]: m["value"] for m in stages["recheck"]["metrics"]}
    reply_next = {target["session_ref"] for target in stages["reply"]["targets"]["next"]}
    recheck_next = {target["session_ref"] for target in stages["recheck"]["targets"]["next"]}

    assert body["cycle_key"] == "2026-W28"
    assert stages["reply"]["queue"] == 1
    assert stages["reply"]["processing"] == 0
    assert stages["reply"]["done"] == 3
    assert reply_metrics["답장 대기 repo"] == 1
    assert reply_metrics["답장 수신 repo"] == 3
    assert f"github-thread-{waiting_id}" in reply_next
    assert stages["recheck"]["queue"] == 1
    assert recheck_metrics["재검증 대기"] == 1
    assert recheck_metrics["HITL 검토"] == 1
    assert f"github-thread-{recheck_id}" in recheck_next
    assert f"github-thread-{hitl_id}" not in recheck_next
    assert f"github-thread-{escalated_id}" not in recheck_next


def test_github_pipeline_recheck_claim_counts_do_not_overlap_reply_or_queue(
    tmp_db,
    monkeypatch,
) -> None:
    from domains.services.github.application.contracts import GITHUB_RECHECK_SESSION_ID
    from domains.services.github.webapp.pipeline_view import github_pipeline_overview
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, waiting_id = sd.github_report_thread_upsert(
        finding_id=501,
        repo="org/waiting",
        severity="medium",
        status="awaiting_owner",
        cycle_key="2026-W28",
    )
    _, guidance_cooling_id = sd.github_report_thread_upsert(
        finding_id=508,
        repo="org/guidance-cooling",
        severity="medium",
        status="awaiting_owner",
        cycle_key="2026-W28",
    )
    sd.github_report_thread_set_status(
        guidance_cooling_id,
        "awaiting_owner",
        retry_after=time.time() + 3600,
    )
    _, queued_id = sd.github_report_thread_upsert(
        finding_id=502,
        repo="org/queued",
        severity="high",
        status="recheck_requested",
        cycle_key="2026-W28",
    )
    _, cooling_id = sd.github_report_thread_upsert(
        finding_id=506,
        repo="org/cooling",
        severity="high",
        status="recheck_requested",
        cycle_key="2026-W28",
    )
    sd.github_report_thread_set_status(
        cooling_id,
        "recheck_requested",
        retry_after=time.time() + 3600,
    )
    _, claimed_id = sd.github_report_thread_upsert(
        finding_id=503,
        repo="org/claimed",
        severity="high",
        status="recheck_requested",
        cycle_key="2026-W28",
    )
    _, guidance_claimed_id = sd.github_report_thread_upsert(
        finding_id=507,
        repo="org/guidance-claimed",
        severity="medium",
        status="awaiting_owner",
        cycle_key="2026-W28",
    )
    _, rechecking_id = sd.github_report_thread_upsert(
        finding_id=504,
        repo="org/rechecking",
        severity="high",
        status="rechecking",
        cycle_key="2026-W28",
    )
    sd.github_report_thread_upsert(
        finding_id=505,
        repo="org/done",
        severity="low",
        status="remediated",
        cycle_key="2026-W28",
    )
    with sd.connect() as c:
        claimed_at = time.time()
        c.execute(
            "UPDATE github_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (GITHUB_RECHECK_SESSION_ID, claimed_at, claimed_id),
        )
        c.execute(
            "UPDATE github_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (GITHUB_RECHECK_SESSION_ID, claimed_at, guidance_claimed_id),
        )
        c.execute(
            "UPDATE github_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (GITHUB_RECHECK_SESSION_ID, claimed_at, rechecking_id),
        )

    body = github_pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    reply_metrics = {m["label"]: m["value"] for m in stages["reply"]["metrics"]}
    recheck_metrics = {m["label"]: m["value"] for m in stages["recheck"]["metrics"]}
    reply_active = {target["session_ref"] for target in stages["reply"]["targets"]["active"]}
    reply_next = {target["session_ref"] for target in stages["reply"]["targets"]["next"]}
    recheck_active = {target["session_ref"] for target in stages["recheck"]["targets"]["active"]}
    recheck_next = {target["session_ref"] for target in stages["recheck"]["targets"]["next"]}

    assert stages["reply"]["queue"] == 1
    assert stages["reply"]["processing"] == 1
    assert stages["reply"]["done"] == 4
    assert reply_metrics["답장 대기 repo"] == 1
    assert reply_metrics["답장 처리중 repo"] == 1
    assert reply_metrics["답장 수신 repo"] == 4
    assert f"github-thread-{claimed_id}" not in reply_active
    assert f"github-thread-{guidance_claimed_id}" in reply_active
    assert f"github-thread-{waiting_id}" in reply_next
    assert f"github-thread-{guidance_claimed_id}" not in reply_next
    assert f"github-thread-{guidance_cooling_id}" not in reply_next

    assert stages["recheck"]["queue"] == 1
    assert stages["recheck"]["processing"] == 2
    assert recheck_metrics["재검증 대기"] == 1
    assert recheck_metrics["재검증 중"] == 2
    assert f"github-thread-{queued_id}" in recheck_next
    assert f"github-thread-{cooling_id}" not in recheck_next
    assert f"github-thread-{claimed_id}" not in recheck_next
    assert f"github-thread-{claimed_id}" in recheck_active
    assert f"github-thread-{rechecking_id}" in recheck_active
    assert f"github-thread-{guidance_claimed_id}" not in recheck_active


def test_github_webapp_hitl_owner_reassign_requeues_report_and_filters_recipients(
    tmp_db,
    monkeypatch,
) -> None:
    from domains.services.github.webapp.app import create_app
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, previous_cycle_id = sd.github_report_thread_upsert(
        finding_id=601,
        repo="org/hitl-owner",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    sd.github_report_thread_set_status(previous_cycle_id, "awaiting_owner")
    action, thread_id = sd.github_report_thread_upsert(
        finding_id=601,
        repo="org/hitl-owner",
        severity="high",
        status="owner_reassignment_review",
        cycle_key="2026-W28",
    )
    assert action == "recurred"
    _, closed_id = sd.github_report_thread_upsert(
        finding_id=602,
        repo="org/closed-owner",
        severity="low",
        status="closed",
        cycle_key="2026-W28",
    )
    _, old_id = sd.github_report_thread_upsert(
        finding_id=603,
        repo="org/old-owner-action",
        severity="medium",
        status="owner_reassignment_review",
        cycle_key="2026-W27",
    )
    sd.github_report_thread_set_status(
        thread_id,
        "owner_reassignment_review",
        recipient="dssoc@samsung.com",
        owner_recipient=None,
        claimed_by=123,
        claimed_at=time.time(),
        retry_after=time.time() + 3600,
    )

    client = TestClient(create_app())
    external = client.post(
        f"/api/reports/{thread_id}/reassign-owner",
        json={"recipient": "attacker@example.com"},
    )
    dssoc = client.post(
        f"/api/reports/{thread_id}/reassign-owner",
        json={"recipient": "DS SOC <dssoc@samsung.com>"},
    )
    terminal = client.post(
        f"/api/reports/{closed_id}/reassign-owner",
        json={"recipient": "owner.one@samsung.com"},
    )
    old_cycle = client.post(
        f"/api/reports/{old_id}/reassign-owner",
        json={"recipient": "owner.one@samsung.com"},
    )
    current_detail = client.get(f"/api/reports/{thread_id}").json()["thread"]
    closed_detail = client.get(f"/api/reports/{closed_id}").json()["thread"]
    old_detail = client.get(f"/api/reports/{old_id}?cycle_key=2026-W27").json()["thread"]
    assert external.status_code == 400
    assert dssoc.status_code == 400
    assert terminal.status_code == 400
    assert old_cycle.status_code == 400
    assert current_detail["is_current_cycle"] is True
    assert current_detail["can_reassign_owner"] is True
    assert closed_detail["is_current_cycle"] is True
    assert closed_detail["can_reassign_owner"] is False
    assert old_detail["is_current_cycle"] is False
    assert old_detail["can_reassign_owner"] is False
    assert sd.github_report_thread_get(old_id)["status"] == "owner_reassignment_review"
    assert sd.service_reply_messages_for_thread("github", old_id) == []

    ok = client.post(
        f"/api/reports/{thread_id}/reassign-owner",
        json={
            "recipient": (
                "Owner One <owner.one@samsung.com>, attacker@example.com, "
                "owner.two@partner.samsung.com, dssoc@samsung.com"
            ),
            "reason": "reply identified a new maintainer",
        },
    )

    assert ok.status_code == 200
    thread = sd.github_report_thread_get(thread_id)
    assert thread["status"] == "reported"
    assert thread["recipient"] == "owner.one@samsung.com, owner.two@partner.samsung.com"
    assert thread["owner_recipient"] == "owner.one@samsung.com, owner.two@partner.samsung.com"
    assert thread["claimed_by"] is None
    assert thread["claimed_at"] is None
    assert thread["retry_after"] is None
    assert thread["notified_at"] is None
    assert "report requeued" in thread["last_reason"]
    messages = sd.service_reply_messages_for_thread("github", thread_id)
    assert messages[-1]["direction"] == "operator"
    assert messages[-1]["agent_verdict"] == "operator_owner_reassigned"
    assert "report requeued" in messages[-1]["decision_reason"]
    assert messages[-1]["extracted_owner"] == {
        "email": "owner.one@samsung.com",
        "emails": ["owner.one@samsung.com", "owner.two@partner.samsung.com"],
    }
    evidence = _operator_evidence(messages[-1])
    assert evidence["domain"] == "github"
    assert evidence["action"] == "operator_owner_reassigned"
    assert evidence["target"]["thread_id"] == thread_id
    assert evidence["target"]["repo"] == "org/hitl-owner"
    assert evidence["target"]["cycle_key"] == "2026-W28"
    assert evidence["target"]["cycle_keys"] == ["2026-W27", "2026-W28"]
    assert evidence["target"]["first_cycle_key"] == "2026-W27"
    assert evidence["target"]["last_cycle_key"] == "2026-W28"
    assert evidence["target"]["accumulated_week_count"] == 2
    assert evidence["target"]["recurrence_count"] == 1
    assert evidence["target"]["is_recurring"] is True
    assert evidence["before"]["status"] == "owner_reassignment_review"
    assert evidence["before"]["recipient"] == "dssoc@samsung.com"
    assert evidence["before"]["claimed_by"] == 123
    assert evidence["after"]["status"] == "reported"
    assert evidence["after"]["recipient"] == "owner.one@samsung.com, owner.two@partner.samsung.com"
    assert evidence["after"]["owner_recipient"] == "owner.one@samsung.com, owner.two@partner.samsung.com"
    assert evidence["after"]["claimed_by"] is None
    assert evidence["after"]["claimed_at"] is None
    assert evidence["after"]["retry_after"] is None
    assert evidence["after"]["notified_at"] is None
    assert evidence["after"]["last_reason"] == thread["last_reason"]
    assert evidence["extracted_owner"]["emails"] == [
        "owner.one@samsung.com",
        "owner.two@partner.samsung.com",
    ]


def test_github_webapp_reassigns_ownerless_reported_thread_into_report_queue(
    tmp_db,
    monkeypatch,
) -> None:
    from domains.services.github.webapp.app import create_app
    from domains.services.github.webapp.pipeline_view import github_pipeline_overview
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=621,
        repo="org/ownerless-reported",
        severity="high",
        status="reported",
        cycle_key="2026-W28",
    )
    _, old_id = sd.github_report_thread_upsert(
        finding_id=622,
        repo="org/old-ownerless-reported",
        severity="medium",
        status="reported",
        cycle_key="2026-W27",
    )

    before = {stage["key"]: stage for stage in github_pipeline_overview()["stages"]}
    assert before["owner"]["queue"] == 1
    assert before["report"]["queue"] == 0
    assert sd.github_report_thread_claim_next(session_id=908, status="reported") is None
    assert sd.github_report_thread_get(thread_id)["claimed_by"] is None

    client = TestClient(create_app())
    detail = client.get(f"/api/reports/{thread_id}").json()["thread"]
    old_detail = client.get(f"/api/reports/{old_id}?cycle_key=2026-W27").json()["thread"]
    assert detail["status"] == "reported"
    assert detail["owner_recipient"] is None
    assert detail["can_reassign_owner"] is True
    assert old_detail["is_current_cycle"] is False
    assert old_detail["can_reassign_owner"] is False

    old_cycle = client.post(
        f"/api/reports/{old_id}/reassign-owner",
        json={"recipient": "owner.one@samsung.com"},
    )
    ok = client.post(
        f"/api/reports/{thread_id}/reassign-owner",
        json={
            "recipient": "Owner One <owner.one@samsung.com>, dssoc@samsung.com",
            "reason": "owner filled from owner stage",
        },
    )

    assert old_cycle.status_code == 400
    assert ok.status_code == 200
    thread = sd.github_report_thread_get(thread_id)
    assert thread["status"] == "reported"
    assert thread["recipient"] == "owner.one@samsung.com"
    assert thread["owner_recipient"] == "owner.one@samsung.com"
    messages = sd.service_reply_messages_for_thread("github", thread_id)
    assert messages[-1]["agent_verdict"] == "operator_owner_reassigned"
    evidence = _operator_evidence(messages[-1])
    assert evidence["before"]["status"] == "reported"
    assert evidence["before"]["owner_recipient"] is None
    assert evidence["after"]["owner_recipient"] == "owner.one@samsung.com"

    after = {stage["key"]: stage for stage in github_pipeline_overview()["stages"]}
    report_next = {target["session_ref"] for target in after["report"]["targets"]["next"]}
    owner_next = {target["session_ref"] for target in after["owner"]["targets"]["next"]}
    assert after["owner"]["queue"] == 0
    assert after["report"]["queue"] == 1
    assert f"github-thread-{thread_id}" in report_next
    assert f"github-thread-{thread_id}" not in owner_next
    claimed = sd.github_report_thread_claim_next(session_id=909, status="reported")
    assert claimed is not None
    assert int(claimed["id"]) == thread_id


def test_github_webapp_reassigns_owner_update_needed_thread(
    tmp_db,
    monkeypatch,
) -> None:
    from domains.services.github.webapp.app import create_app
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=631,
        repo="org/not-owner-reply",
        severity="high",
        status="owner_update_needed",
        cycle_key="2026-W28",
    )
    sd.github_report_thread_set_status(
        thread_id,
        "owner_update_needed",
        recipient="dssoc@samsung.com",
        owner_recipient=None,
        last_reason="reply indicated current recipient is not owner",
    )

    client = TestClient(create_app())
    detail = client.get(f"/api/reports/{thread_id}").json()["thread"]
    assert detail["can_reassign_owner"] is True

    ok = client.post(
        f"/api/reports/{thread_id}/reassign-owner",
        json={
            "recipient": "Owner Next <owner.next@samsung.com>",
            "reason": "not-owner reply supplied replacement owner",
        },
    )

    assert ok.status_code == 200
    thread = sd.github_report_thread_get(thread_id)
    assert thread["status"] == "reported"
    assert thread["recipient"] == "owner.next@samsung.com"
    assert thread["owner_recipient"] == "owner.next@samsung.com"
    messages = sd.service_reply_messages_for_thread("github", thread_id)
    assert messages[-1]["agent_verdict"] == "operator_owner_reassigned"
    evidence = _operator_evidence(messages[-1])
    assert evidence["before"]["status"] == "owner_update_needed"
    assert evidence["after"]["status"] == "reported"
    assert evidence["after"]["owner_recipient"] == "owner.next@samsung.com"
    assert evidence["target"]["repo"] == "org/not-owner-reply"


def test_github_webapp_hitl_exception_actions_close_or_recheck(tmp_db, monkeypatch) -> None:
    from domains.services.github.webapp.app import create_app
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, close_id = sd.github_report_thread_upsert(
        finding_id=611,
        repo="org/exception-close",
        severity="medium",
        status="exception_review",
        cycle_key="2026-W28",
    )
    _, reject_id = sd.github_report_thread_upsert(
        finding_id=612,
        repo="org/exception-reject",
        severity="medium",
        status="exception_review",
        cycle_key="2026-W28",
    )
    _, non_hitl_id = sd.github_report_thread_upsert(
        finding_id=613,
        repo="org/not-hitl",
        severity="low",
        status="reported",
        cycle_key="2026-W28",
    )
    _, owner_hitl_id = sd.github_report_thread_upsert(
        finding_id=614,
        repo="org/not-owner",
        severity="medium",
        status="owner_update_needed",
        cycle_key="2026-W28",
    )
    _, old_close_id = sd.github_report_thread_upsert(
        finding_id=615,
        repo="org/old-exception-close",
        severity="medium",
        status="exception_review",
        cycle_key="2026-W27",
    )
    _, old_reject_id = sd.github_report_thread_upsert(
        finding_id=616,
        repo="org/old-exception-reject",
        severity="medium",
        status="exception_review",
        cycle_key="2026-W27",
    )

    client = TestClient(create_app())
    exception_detail = client.get(f"/api/reports/{close_id}").json()["thread"]
    owner_detail = client.get(f"/api/reports/{owner_hitl_id}").json()["thread"]
    old_exception_detail = client.get(
        f"/api/reports/{old_close_id}?cycle_key=2026-W27"
    ).json()["thread"]
    closed = client.post(
        f"/api/reports/{close_id}/close-exception",
        json={"reason": "accepted business exception", "approved_by": "reviewer"},
    )
    rejected = client.post(
        f"/api/reports/{reject_id}/reject-exception",
        json={"reason": "exception evidence insufficient"},
    )
    blocked = client.post(
        f"/api/reports/{non_hitl_id}/close-exception",
        json={"reason": "not applicable"},
    )
    owner_close_blocked = client.post(
        f"/api/reports/{owner_hitl_id}/close-exception",
        json={"reason": "not an exception"},
    )
    owner_reject_blocked = client.post(
        f"/api/reports/{owner_hitl_id}/reject-exception",
        json={"reason": "not an exception"},
    )
    old_close_blocked = client.post(
        f"/api/reports/{old_close_id}/close-exception",
        json={"reason": "old exception"},
    )
    old_reject_blocked = client.post(
        f"/api/reports/{old_reject_id}/reject-exception",
        json={"reason": "old exception"},
    )

    assert closed.status_code == 200
    assert rejected.status_code == 200
    assert blocked.status_code == 400
    assert owner_close_blocked.status_code == 400
    assert owner_reject_blocked.status_code == 400
    assert old_close_blocked.status_code == 400
    assert old_reject_blocked.status_code == 400
    assert exception_detail["is_current_cycle"] is True
    assert exception_detail["can_close_exception"] is True
    assert exception_detail["can_reject_exception"] is True
    assert owner_detail["is_current_cycle"] is True
    assert owner_detail["can_close_exception"] is False
    assert owner_detail["can_reject_exception"] is False
    assert old_exception_detail["is_current_cycle"] is False
    assert old_exception_detail["can_close_exception"] is False
    assert old_exception_detail["can_reject_exception"] is False
    assert sd.github_report_thread_get(owner_hitl_id)["status"] == "owner_update_needed"
    assert sd.service_reply_messages_for_thread("github", owner_hitl_id) == []
    assert sd.github_report_thread_get(old_close_id)["status"] == "exception_review"
    assert sd.github_report_thread_get(old_reject_id)["status"] == "exception_review"
    assert sd.service_reply_messages_for_thread("github", old_close_id) == []
    assert sd.service_reply_messages_for_thread("github", old_reject_id) == []
    assert sd.github_report_thread_get(close_id)["status"] == "closed"
    assert "reviewer" in sd.github_report_thread_get(close_id)["last_reason"]
    assert sd.github_report_thread_get(reject_id)["status"] == "recheck_requested"
    assert sd.github_report_thread_get(reject_id)["last_reason"] == "exception evidence insufficient"
    closed_messages = sd.service_reply_messages_for_thread("github", close_id)
    rejected_messages = sd.service_reply_messages_for_thread("github", reject_id)
    assert closed_messages[-1]["direction"] == "operator"
    assert closed_messages[-1]["agent_verdict"] == "operator_exception_approved"
    assert closed_messages[-1]["mail_from"] == "reviewer"
    assert "accepted business exception" in closed_messages[-1]["decision_reason"]
    closed_evidence = _operator_evidence(closed_messages[-1])
    assert closed_evidence["actor"] == "reviewer"
    assert closed_evidence["before"]["status"] == "exception_review"
    assert closed_evidence["after"]["status"] == "closed"
    assert closed_evidence["after"]["claimed_by"] is None
    assert closed_evidence["after"]["claimed_at"] is None
    assert closed_evidence["after"]["retry_after"] is None
    assert "reviewer" in closed_evidence["after"]["last_reason"]
    assert closed_evidence["target"]["repo"] == "org/exception-close"
    assert rejected_messages[-1]["direction"] == "operator"
    assert rejected_messages[-1]["agent_verdict"] == "operator_exception_rejected"
    assert rejected_messages[-1]["decision_reason"] == "exception evidence insufficient"
    rejected_evidence = _operator_evidence(rejected_messages[-1])
    assert rejected_evidence["before"]["status"] == "exception_review"
    assert rejected_evidence["after"]["status"] == "recheck_requested"
    assert rejected_evidence["after"]["claimed_by"] is None
    assert rejected_evidence["after"]["claimed_at"] is None
    assert rejected_evidence["after"]["retry_after"] is None
    assert rejected_evidence["after"]["last_reason"] == "exception evidence insufficient"
    assert rejected_evidence["reason"] == "exception evidence insufficient"


def test_smb_webapp_does_not_expose_github_reports(tmp_db) -> None:
    from domains.smb.webapp.app import create_app

    client = TestClient(create_app())
    assert client.get("/api/reports").status_code == 404


def test_보고목록이_잘리면_잘렸다고_말한다(tmp_db) -> None:
    """운영자 화면이 조용히 저장소를 떨어뜨리지 않는다.

    보고 스레드가 저장소 축으로 바뀌면서(f61021f) 한 주 대상이 저장소 85곳 → 607곳이
    됐다. 그때 이 라우트는 `limit` 기본값 100 으로 잘랐고, 잘렸다는 사실이 응답에
    없어서 **운영자가 507곳이 빠진 걸 알 방법이 없었다.**

    상한 자체는 남긴다(화면은 무한히 그릴 수 없다). 다만 잘렸으면 말해야 한다.
    """
    from domains.services.github.webapp.app import create_app
    from service import state_domain as sd
    from secu_agent import state as core_state

    for i in range(5):
        repo = f"org/many-{i}"
        finding_id, _ = core_state.finding_upsert(
            task_type="github",
            asset=f"github:{repo}/.env",
            asset_kind="repository_file",
            severity="high",
            summary=f"seeded {repo}",
            extra={"metadata": {"repo": repo, "path": ".env"}},
        )
        sd.github_report_thread_upsert(
            finding_id=finding_id,
            repo=repo,
            severity="high",
            recipient="owner@samsung.com",
            owner_recipient="owner@samsung.com",
            status="reported",
        )

    client = TestClient(create_app())

    full = client.get("/api/reports").json()
    assert full["count"] == 5
    assert full["total"] == 5
    assert full["truncated"] is False

    cut = client.get("/api/reports?limit=2").json()
    assert cut["count"] == 2
    assert cut["total"] == 5, "총계를 모르면 운영자는 잘린 걸 못 본다"
    assert cut["truncated"] is True

    # repo 필터가 걸리면 그 저장소만의 총계는 이 응답으로 셀 수 없다.
    # ⚠️ 모르는 값을 len(items) 로 채우면 "잘리지 않았다" 는 거짓말이 된다 — None 이 정직하다.
    scoped = client.get("/api/reports?repo=org/many-0").json()
    assert scoped["total"] is None
    assert scoped["truncated"] is False
    assert scoped["count"] == 1
