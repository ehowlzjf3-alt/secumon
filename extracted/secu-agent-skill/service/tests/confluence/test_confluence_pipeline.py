"""Confluence E2E pipeline projection and route checks."""
from __future__ import annotations

import datetime as dt
import json
import re
import time
from html import unescape


def _operator_evidence(message: dict) -> dict:
    body_html = str(message.get("body_html") or "")
    match = re.search(r"<pre[^>]*>(.*)</pre>", body_html, re.DOTALL)
    assert match is not None
    return json.loads(unescape(match.group(1)))


def test_confluence_pipeline_counts_space_sso_and_report(tmp_db) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application.contracts import (
        CONFLUENCE_SPACE_TASK_SESSION_ID,
        CONFLUENCE_SSO_TASK_SESSION_ID,
    )
    from domains.services.confluence.webapp.pipeline_view import pipeline_overview

    pending_space = sd.confluence_space_target_upsert("OPS")
    done_space = sd.confluence_space_target_upsert("ENG")
    active_space = sd.confluence_space_target_upsert("SEC")
    sd.confluence_space_target_set_status(done_space, "tasked", finding_count=2)
    sd.confluence_space_target_set_status(
        active_space,
        "in_progress",
        claimed_by=CONFLUENCE_SPACE_TASK_SESSION_ID,
        claimed_at=time.time(),
    )

    day = dt.date.today().isoformat()
    pending_url = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/OPS",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=5,
    )
    active_url = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/SEC",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=3,
    )
    sd.devops_target_set_status(
        active_url,
        "in_progress",
        claimed_by=CONFLUENCE_SSO_TASK_SESSION_ID,
        claimed_at=time.time(),
    )

    from secu_agent import state

    finding_id, _ = state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:100",
        asset_kind="page",
        severity="high",
        summary="secret in page",
        evidence_ref="evidence.json",
        extra={"metadata": {"space_key": "OPS"}},
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="reported",
    )
    sd.confluence_report_thread_set_status(thread_id, "report_ready")

    body = pipeline_overview()
    by_key = {stage["key"]: stage for stage in body["stages"]}

    assert by_key["space_task"]["queue"] >= 1
    assert by_key["space_task"]["processing"] >= 1
    assert by_key["space_task"]["done"] >= 1
    assert any(t["session_ref"] == f"space-{active_space}" for t in by_key["space_task"]["targets"]["active"])
    assert any(t["session_ref"] == f"space-{pending_space}" for t in by_key["space_task"]["targets"]["next"])

    assert by_key["sso_task"]["queue"] >= 1
    assert by_key["sso_task"]["processing"] >= 1
    assert any(t["session_ref"] == f"devops-{active_url}" for t in by_key["sso_task"]["targets"]["active"])
    assert any(t["session_ref"] == f"devops-{pending_url}" for t in by_key["sso_task"]["targets"]["next"])

    assert by_key["report"]["done"] == 1
    assert by_key["report"]["metrics"][1]["value"] == 1
    assert body["findings_total"] == 1

    sd.confluence_report_thread_set_status(thread_id, "partially_remediated")
    body = pipeline_overview()
    by_key = {stage["key"]: stage for stage in body["stages"]}
    assert by_key["recheck"]["done"] >= 1
    assert any(m["label"] == "부분 조치" and m["value"] >= 1 for m in by_key["recheck"]["metrics"])


def test_webapp_exposes_confluence_pipeline_route(tmp_db) -> None:
    from fastapi.testclient import TestClient

    import service.state_domain as sd
    from domains.services.confluence.application.contracts import (
        COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
        COMPONENT_CONFLUENCE_SSO_DISCOVERY,
    )
    from domains.services.confluence.webapp.app import create_app

    sd.confluence_space_target_upsert("OPS")
    client = TestClient(create_app())

    response = client.get("/api/pipeline/overview")

    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "confluence_pipeline_overview"
    assert {stage["key"] for stage in body["stages"]} >= {
        "space_discovery",
        "space_task",
        "sso_discovery",
        "sso_task",
        "owner",
        "report",
        "reply",
        "recheck",
        "done",
    }
    by_key = {stage["key"]: stage for stage in body["stages"]}
    assert by_key["space_discovery"]["control_key"] == COMPONENT_CONFLUENCE_SPACE_DISCOVERY
    assert by_key["sso_discovery"]["control_key"] == COMPONENT_CONFLUENCE_SSO_DISCOVERY
    assert COMPONENT_CONFLUENCE_SPACE_DISCOVERY in body["control"]
    assert COMPONENT_CONFLUENCE_SSO_DISCOVERY in body["control"]


def test_confluence_pipeline_task_stages_move_stale_claims_back_to_queue(tmp_db) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application.contracts import (
        CONFLUENCE_SPACE_TASK_SESSION_ID,
        CONFLUENCE_SSO_TASK_SESSION_ID,
    )
    from domains.services.confluence.webapp.pipeline_view import pipeline_overview

    ready_space = sd.confluence_space_target_upsert("READY")
    stale_space = sd.confluence_space_target_upsert("STALE")
    fresh_space = sd.confluence_space_target_upsert("FRESH")
    cooling_space = sd.confluence_space_target_upsert("COOLING")
    with sd.connect() as c:
        c.execute(
            "UPDATE confluence_space_target SET retry_after=? WHERE id=?",
            (time.time() + 3600, cooling_space),
        )
    sd.confluence_space_target_set_status(
        stale_space,
        "in_progress",
        claimed_by=CONFLUENCE_SPACE_TASK_SESSION_ID,
        claimed_at=1000.0,
    )
    sd.confluence_space_target_set_status(
        fresh_space,
        "in_progress",
        claimed_by=CONFLUENCE_SPACE_TASK_SESSION_ID,
        claimed_at=time.time(),
    )

    day = dt.date.today().isoformat()
    ready_url = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/READY",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=3,
    )
    stale_url = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/STALE",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=2,
    )
    fresh_url = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/FRESH",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=1,
    )
    cooling_url = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/COOLING",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=9,
    )
    with sd.connect() as c:
        c.execute(
            "UPDATE devops_target SET retry_after=? WHERE id=?",
            (time.time() + 3600, cooling_url),
        )
    sd.devops_target_set_status(
        stale_url,
        "in_progress",
        claimed_by=CONFLUENCE_SSO_TASK_SESSION_ID,
        claimed_at=1000.0,
    )
    sd.devops_target_set_status(
        fresh_url,
        "in_progress",
        claimed_by=CONFLUENCE_SSO_TASK_SESSION_ID,
        claimed_at=time.time(),
    )

    body = pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    space_metrics = {m["label"]: m["value"] for m in stages["space_task"]["metrics"]}
    sso_metrics = {m["label"]: m["value"] for m in stages["sso_task"]["metrics"]}
    space_active = {target["session_ref"] for target in stages["space_task"]["targets"]["active"]}
    space_next = {target["session_ref"] for target in stages["space_task"]["targets"]["next"]}
    sso_active = {target["session_ref"] for target in stages["sso_task"]["targets"]["active"]}
    sso_next = {target["session_ref"] for target in stages["sso_task"]["targets"]["next"]}

    assert stages["space_task"]["queue"] == 2
    assert stages["space_task"]["processing"] == 1
    assert stages["space_task"]["stuck"] == 1
    assert space_metrics["대기 space"] == 2
    assert space_metrics["처리중 space"] == 1
    assert space_metrics["멈춘 claim"] == 1
    assert space_active == {f"space-{fresh_space}"}
    assert space_next == {f"space-{ready_space}", f"space-{stale_space}"}
    assert f"space-{cooling_space}" not in space_next
    assert {target["session_ref"] for target in stages["space_task"]["targets"]["stuck"]} == {
        f"space-{stale_space}",
    }

    assert stages["sso_task"]["queue"] == 2
    assert stages["sso_task"]["processing"] == 1
    assert stages["sso_task"]["stuck"] == 1
    assert sso_metrics["대기 URL"] == 2
    assert sso_metrics["처리중 URL"] == 1
    assert sso_metrics["멈춘 claim"] == 1
    assert sso_active == {f"devops-{fresh_url}"}
    assert sso_next == {f"devops-{ready_url}", f"devops-{stale_url}"}
    assert f"devops-{cooling_url}" not in sso_next
    assert {target["session_ref"] for target in stages["sso_task"]["targets"]["stuck"]} == {
        f"devops-{stale_url}",
    }


def test_confluence_pipeline_surfaces_wrong_session_claims_as_stuck(tmp_db) -> None:
    import service.state_domain as sd
    from domains.services.confluence.webapp.pipeline_view import pipeline_overview

    now = time.time()
    space_id = sd.confluence_space_target_upsert("CLAIMEDBYOTHER")
    sd.confluence_space_target_set_status(
        space_id,
        "in_progress",
        claimed_by=999_001,
        claimed_at=now,
    )
    url_id = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/CLAIMEDBYOTHER",
        service="confluence",
        source="proxy",
        day_bucket=dt.date.today().isoformat(),
        access_count=4,
    )
    sd.devops_target_set_status(
        url_id,
        "in_progress",
        claimed_by=999_002,
        claimed_at=now,
    )
    _, report_id = sd.confluence_report_thread_upsert(
        finding_id=330,
        space_key="REPORTCLAIMED",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
    )
    _, recheck_id = sd.confluence_report_thread_upsert(
        finding_id=331,
        space_key="RECHECKCLAIMED",
        severity="high",
        status="recheck_requested",
    )
    _, guidance_id = sd.confluence_report_thread_upsert(
        finding_id=332,
        space_key="GUIDANCECLAIMED",
        severity="medium",
        status="awaiting_owner",
    )
    with sd.connect() as c:
        c.execute(
            "UPDATE confluence_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (999_003, now, report_id),
        )
        c.execute(
            "UPDATE confluence_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (999_004, now, recheck_id),
        )
        c.execute(
            "UPDATE confluence_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (999_005, now, guidance_id),
        )

    body = pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    space_stuck = {target["session_ref"] for target in stages["space_task"]["targets"]["stuck"]}
    sso_stuck = {target["session_ref"] for target in stages["sso_task"]["targets"]["stuck"]}
    report_stuck = {target["session_ref"] for target in stages["report"]["targets"]["stuck"]}
    reply_stuck = {target["session_ref"] for target in stages["reply"]["targets"]["stuck"]}
    recheck_stuck = {target["session_ref"] for target in stages["recheck"]["targets"]["stuck"]}
    space_metrics = {m["label"]: m["value"] for m in stages["space_task"]["metrics"]}
    sso_metrics = {m["label"]: m["value"] for m in stages["sso_task"]["metrics"]}
    report_metrics = {m["label"]: m["value"] for m in stages["report"]["metrics"]}
    reply_metrics = {m["label"]: m["value"] for m in stages["reply"]["metrics"]}
    recheck_metrics = {m["label"]: m["value"] for m in stages["recheck"]["metrics"]}
    reply_next = {target["session_ref"] for target in stages["reply"]["targets"]["next"]}
    recheck_next = {target["session_ref"] for target in stages["recheck"]["targets"]["next"]}

    assert stages["space_task"]["queue"] == 0
    assert stages["space_task"]["processing"] == 0
    assert stages["space_task"]["stuck"] == 1
    assert space_metrics["멈춘 claim"] == 1
    assert space_stuck == {f"space-{space_id}"}

    assert stages["sso_task"]["queue"] == 0
    assert stages["sso_task"]["processing"] == 0
    assert stages["sso_task"]["stuck"] == 1
    assert sso_metrics["멈춘 claim"] == 1
    assert sso_stuck == {f"devops-{url_id}"}

    assert stages["report"]["queue"] == 0
    assert stages["report"]["processing"] == 0
    assert stages["report"]["stuck"] == 1
    assert report_metrics["멈춘 claim"] == 1
    assert report_stuck == {f"confluence-thread-{report_id}"}

    assert stages["reply"]["queue"] == 0
    assert stages["reply"]["processing"] == 0
    assert stages["reply"]["stuck"] == 1
    assert reply_metrics["답장 대기"] == 0
    assert reply_metrics["멈춘 claim"] == 1
    assert f"confluence-thread-{guidance_id}" not in reply_next
    assert reply_stuck == {f"confluence-thread-{guidance_id}"}

    assert stages["recheck"]["queue"] == 0
    assert stages["recheck"]["processing"] == 0
    assert stages["recheck"]["stuck"] == 1
    assert recheck_metrics["재검증 대기"] == 0
    assert recheck_metrics["멈춘 claim"] == 1
    assert f"confluence-thread-{recheck_id}" not in recheck_next
    assert recheck_stuck == {f"confluence-thread-{recheck_id}"}
    assert all(
        target["session_ref"] != f"confluence-thread-{recheck_id}"
        for target in stages["reply"]["targets"].get("active", [])
    )


def test_confluence_webapp_resets_only_stuck_claims_and_preserves_domain(
    tmp_db,
    monkeypatch,
) -> None:
    from fastapi.testclient import TestClient

    import service.state_domain as sd
    from domains.services.confluence.application.contracts import (
        COMPONENT_CONFLUENCE_RECHECK,
        COMPONENT_CONFLUENCE_REPORT,
        COMPONENT_CONFLUENCE_SPACE_TASK,
        COMPONENT_CONFLUENCE_SSO_TASK,
        CONFLUENCE_SPACE_TASK_SESSION_ID,
    )
    from domains.services.confluence.webapp.app import create_app

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    now = time.time()
    day = "2026-06-30"
    space_stuck = sd.confluence_space_target_upsert("RESETSTUCK")
    space_active = sd.confluence_space_target_upsert("RESETACTIVE")
    sd.confluence_space_target_set_status(
        space_stuck,
        "in_progress",
        claimed_by=999_201,
        claimed_at=now,
    )
    sd.confluence_space_target_set_status(
        space_active,
        "in_progress",
        claimed_by=CONFLUENCE_SPACE_TASK_SESSION_ID,
        claimed_at=now,
    )
    confluence_sso = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/RESETSTUCK",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=5,
    )
    github_sso = sd.devops_target_upsert(
        "https://github.samsungds.net/org/reset-stuck",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=9,
    )
    sd.devops_target_set_status(confluence_sso, "in_progress", claimed_by=999_202, claimed_at=now)
    sd.devops_target_set_status(github_sso, "in_progress", claimed_by=999_203, claimed_at=now)
    _, report_id = sd.confluence_report_thread_upsert(
        finding_id=701,
        space_key="REPORTRESET",
        severity="high",
        status="reported",
        cycle_key="2026-W28",
    )
    _, recheck_id = sd.confluence_report_thread_upsert(
        finding_id=702,
        space_key="RECHECKRESET",
        severity="high",
        status="rechecking",
        cycle_key="2026-W28",
    )
    _, guidance_id = sd.confluence_report_thread_upsert(
        finding_id=703,
        space_key="GUIDANCERESET",
        severity="medium",
        status="awaiting_owner",
        cycle_key="2026-W28",
    )
    with sd.connect() as c:
        c.execute(
            "UPDATE confluence_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (999_204, now, report_id),
        )
        c.execute(
            "UPDATE confluence_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (999_205, now, recheck_id),
        )
        c.execute(
            "UPDATE confluence_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (999_206, now, guidance_id),
        )

    client = TestClient(create_app())

    active = client.post(
        "/api/pipeline/reset-claim",
        json={"component": COMPONENT_CONFLUENCE_SPACE_TASK, "session_ref": f"space-{space_active}"},
    )
    assert active.status_code == 409

    unsupported = client.post(
        "/api/pipeline/reset-claim",
        json={"component": "task", "session_ref": f"space-{space_stuck}"},
    )
    assert unsupported.status_code == 400

    wrong_prefix = client.post(
        "/api/pipeline/reset-claim",
        json={"component": COMPONENT_CONFLUENCE_SPACE_TASK, "session_ref": f"devops-{confluence_sso}"},
    )
    assert wrong_prefix.status_code == 400

    for component, ref in [
        (COMPONENT_CONFLUENCE_SPACE_TASK, f"space-{space_stuck}"),
        (COMPONENT_CONFLUENCE_SSO_TASK, f"devops-{confluence_sso}"),
        (COMPONENT_CONFLUENCE_REPORT, f"confluence-thread-{report_id}"),
        (COMPONENT_CONFLUENCE_RECHECK, f"confluence-thread-{recheck_id}"),
        (COMPONENT_CONFLUENCE_RECHECK, f"confluence-thread-{guidance_id}"),
    ]:
        response = client.post(
            "/api/pipeline/reset-claim",
            json={"component": component, "session_ref": ref, "reason": "test reset"},
        )
        assert response.status_code == 200
        assert response.json()["session_ref"] == ref

    assert sd.confluence_space_target_get(space_stuck)["status"] == "pending"
    assert sd.confluence_space_target_get(space_stuck)["claimed_by"] is None
    assert sd.confluence_space_target_get(space_active)["status"] == "in_progress"
    assert sd.confluence_space_target_get(space_active)["claimed_by"] == CONFLUENCE_SPACE_TASK_SESSION_ID
    assert sd.devops_target_get(confluence_sso)["status"] == "pending"
    assert sd.devops_target_get(confluence_sso)["claimed_by"] is None
    assert sd.devops_target_get(github_sso)["status"] == "in_progress"
    assert sd.devops_target_get(github_sso)["claimed_by"] == 999_203
    assert sd.confluence_report_thread_get(report_id)["status"] == "reported"
    assert sd.confluence_report_thread_get(report_id)["claimed_by"] is None
    assert sd.confluence_report_thread_get(recheck_id)["status"] == "recheck_requested"
    assert sd.confluence_report_thread_get(recheck_id)["claimed_by"] is None
    assert sd.confluence_report_thread_get(guidance_id)["status"] == "awaiting_owner"
    assert sd.confluence_report_thread_get(guidance_id)["claimed_by"] is None
    for thread_id, before_status, before_claimed_by, after_status in [
        (report_id, "reported", 999_204, "reported"),
        (recheck_id, "rechecking", 999_205, "recheck_requested"),
        (guidance_id, "awaiting_owner", 999_206, "awaiting_owner"),
    ]:
        messages = sd.service_reply_messages_for_thread("confluence", thread_id)
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
        assert evidence["after"]["component"] in {
            COMPONENT_CONFLUENCE_REPORT,
            COMPONENT_CONFLUENCE_RECHECK,
        }


def test_confluence_webapp_reset_claim_rejects_old_cycle_targets_and_threads(
    tmp_db,
    monkeypatch,
) -> None:
    from fastapi.testclient import TestClient

    import service.state_domain as sd
    from domains.services.confluence.application.contracts import (
        COMPONENT_CONFLUENCE_RECHECK,
        COMPONENT_CONFLUENCE_REPORT,
        COMPONENT_CONFLUENCE_SPACE_TASK,
        COMPONENT_CONFLUENCE_SSO_TASK,
    )
    from domains.services.confluence.webapp.app import create_app

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    now = time.time()
    old_space = sd.confluence_space_target_upsert("OLDRESET")
    old_sso = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/OLDRESET",
        service="confluence",
        source="proxy",
        day_bucket="2026-06-23",
        access_count=5,
    )
    sd.confluence_space_target_set_status(
        old_space,
        "in_progress",
        claimed_by=999_211,
        claimed_at=now,
        cycle_key="2026-W27",
    )
    sd.devops_target_set_status(
        old_sso,
        "in_progress",
        claimed_by=999_212,
        claimed_at=now,
        cycle_key="2026-W27",
    )
    _, old_report = sd.confluence_report_thread_upsert(
        finding_id=711,
        space_key="OLDREPORTRESET",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    _, old_recheck = sd.confluence_report_thread_upsert(
        finding_id=712,
        space_key="OLDRECHECKRESET",
        severity="high",
        status="rechecking",
        cycle_key="2026-W27",
    )
    _, old_guidance = sd.confluence_report_thread_upsert(
        finding_id=713,
        space_key="OLDGUIDANCERESET",
        severity="medium",
        status="awaiting_owner",
        cycle_key="2026-W27",
    )
    with sd.connect() as c:
        for thread_id, claimed_by in [
            (old_report, 999_213),
            (old_recheck, 999_214),
            (old_guidance, 999_215),
        ]:
            c.execute(
                "UPDATE confluence_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
                (claimed_by, now, thread_id),
            )

    client = TestClient(create_app())
    blocked = [
        (COMPONENT_CONFLUENCE_SPACE_TASK, f"space-{old_space}"),
        (COMPONENT_CONFLUENCE_SSO_TASK, f"devops-{old_sso}"),
        (COMPONENT_CONFLUENCE_REPORT, f"confluence-thread-{old_report}"),
        (COMPONENT_CONFLUENCE_RECHECK, f"confluence-thread-{old_recheck}"),
        (COMPONENT_CONFLUENCE_RECHECK, f"confluence-thread-{old_guidance}"),
    ]
    for component, ref in blocked:
        response = client.post(
            "/api/pipeline/reset-claim",
            json={"component": component, "session_ref": ref, "reason": "old reset"},
        )
        assert response.status_code == 404

    assert sd.confluence_space_target_get(old_space)["status"] == "in_progress"
    assert sd.confluence_space_target_get(old_space)["claimed_by"] == 999_211
    assert sd.devops_target_get(old_sso)["status"] == "in_progress"
    assert sd.devops_target_get(old_sso)["claimed_by"] == 999_212
    assert sd.confluence_report_thread_get(old_report)["status"] == "reported"
    assert sd.confluence_report_thread_get(old_report)["claimed_by"] == 999_213
    assert sd.confluence_report_thread_get(old_recheck)["status"] == "rechecking"
    assert sd.confluence_report_thread_get(old_recheck)["claimed_by"] == 999_214
    assert sd.confluence_report_thread_get(old_guidance)["status"] == "awaiting_owner"
    assert sd.confluence_report_thread_get(old_guidance)["claimed_by"] == 999_215


def test_webapp_exposes_confluence_reports_and_recheck_request(tmp_db) -> None:
    import json

    from fastapi.testclient import TestClient

    import service.state_domain as sd
    from domains.services.confluence.webapp.app import create_app
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
            },
        },
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=finding_id,
        space_key="OPS",
        severity="high",
        status="reported",
    )
    sd.confluence_report_thread_set_status(
        thread_id,
        "report_ready",
        report_json=json.dumps({"space_key": "OPS", "finding_count": 1}),
        report_html="<h1>OPS</h1>",
    )
    sd.service_reply_message_add(
        domain="confluence",
        direction="in",
        thread_id=thread_id,
        message_id="confluence-reply-1",
        subject="[Confluence 보안취약점 조치요청](OPS)",
        subject_tag="[Confluence 보안취약점 조치요청](OPS)",
        mail_from="owner@samsung.com",
        mail_to="dssoc@samsung.com",
        body_excerpt="페이지 권한 조치 완료",
        body_html="<p>페이지 권한 조치 완료</p><table><tr><td>증적</td></tr></table>",
        agent_verdict="classified_remediation_claim",
        decision_reason="답장 신규 본문에서 조치 완료 주장을 확인함",
        extracted_owner={"email": "owner@samsung.com"},
        received_at=1000.0,
    )
    sd.service_reply_message_add(
        domain="github",
        direction="in",
        thread_id=thread_id,
        message_id="wrong-domain-reply",
        subject="[GitHub 보안취약점 조치요청](org/repo)",
        subject_tag="[GitHub 보안취약점 조치요청](org/repo)",
        mail_from="owner@samsung.com",
        mail_to="dssoc@samsung.com",
        body_excerpt="다른 도메인 메시지",
        body_html="<p>wrong domain html</p>",
        agent_verdict="pending",
        received_at=1001.0,
    )
    sd.confluence_recheck_result_add(
        thread_id=thread_id,
        finding_id=finding_id,
        space_key="OPS",
        asset="confluence:OPS:100",
        verdict="now_closed",
        verification={
            "method": "confluence_surface_refetch",
            "matched": False,
            "surface_count": 1,
            "surface_labels": ["100"],
        },
    )

    client = TestClient(create_app())
    listing = client.get("/api/reports").json()
    assert listing["items"][0]["space_key"] == "OPS"
    assert listing["items"][0]["finding_count"] == 1
    assert listing["items"][0]["verification_counts"] == {"current_page": 1}
    assert listing["items"][0]["scan_method_counts"] == {"api_cql_search_detail_scan": 1}
    assert listing["items"][0]["finding_tags"] == [
        {"key": "api_key", "label": "API Key"},
        {"key": "current_page", "label": "현재 페이지"},
    ]

    detail = client.get(f"/api/reports/{thread_id}").json()
    assert detail["thread"]["report"]["space_key"] == "OPS"
    assert detail["thread"]["scan_method_counts"] == {"api_cql_search_detail_scan": 1}
    assert detail["thread"]["has_report"] is True
    assert detail["findings"][0]["asset"] == "confluence:OPS:100"
    assert [m["message_id"] for m in detail["messages"]] == ["confluence-reply-1"]
    assert detail["messages"][0]["body_excerpt"] == "페이지 권한 조치 완료"
    assert detail["messages"][0]["body_html"] == (
        "<p>페이지 권한 조치 완료</p><table><tr><td>증적</td></tr></table>"
    )
    assert "wrong domain html" not in detail["messages"][0]["body_html"]
    assert detail["messages"][0]["decision_reason"] == "답장 신규 본문에서 조치 완료 주장을 확인함"
    assert detail["messages"][0]["extracted_owner"] == {"email": "owner@samsung.com"}
    assert detail["rechecks"][0]["verification"]["method"] == "confluence_surface_refetch"
    assert detail["rechecks"][0]["verification"]["surface_labels"] == ["100"]
    assert detail["rechecks"][0]["verdict"] == "now_closed"

    requested = client.post(f"/api/reports/{thread_id}/request-recheck")
    assert requested.status_code == 200
    assert requested.json()["thread"]["status"] == "recheck_requested"


def test_confluence_webapp_has_report_ignores_empty_report_payload(tmp_db) -> None:
    from fastapi.testclient import TestClient

    import service.state_domain as sd
    from domains.services.confluence.webapp.app import create_app

    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=801,
        space_key="EMPTYREPORT",
        severity="medium",
        status="reported",
    )

    client = TestClient(create_app())
    detail = client.get(f"/api/reports/{thread_id}").json()["thread"]
    assert detail["report"] == {}
    assert detail["has_report"] is False

    sd.confluence_report_thread_set_status(
        thread_id,
        "report_ready",
        report_json=json.dumps({"space_key": "EMPTYREPORT", "finding_count": 1}),
        report_html=None,
    )

    detail = client.get(f"/api/reports/{thread_id}").json()["thread"]
    assert detail["has_report"] is True


def test_webapp_confluence_reports_default_to_current_cycle(tmp_db, monkeypatch) -> None:
    from fastapi.testclient import TestClient

    import service.state_domain as sd
    from domains.services.confluence.webapp.app import create_app

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, old_id = sd.confluence_report_thread_upsert(
        finding_id=201,
        space_key="OLD",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    _, current_id = sd.confluence_report_thread_upsert(
        finding_id=202,
        space_key="OPS",
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


def test_confluence_report_api_exposes_weekly_recurrence_summary(tmp_db, monkeypatch) -> None:
    from fastapi.testclient import TestClient

    import service.state_domain as sd
    from domains.services.confluence.webapp.app import create_app

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, old_id = sd.confluence_report_thread_upsert(
        finding_id=215,
        space_key="RECURAPI",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    sd.confluence_report_thread_set_status(old_id, "awaiting_owner")
    action, current_id = sd.confluence_report_thread_upsert(
        finding_id=215,
        space_key="RECURAPI",
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


def test_confluence_webapp_request_recheck_is_current_cycle_and_active_status_only(
    tmp_db,
    monkeypatch,
) -> None:
    from fastapi.testclient import TestClient

    import service.state_domain as sd
    from domains.services.confluence.webapp.app import create_app

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, current_id = sd.confluence_report_thread_upsert(
        finding_id=221,
        space_key="CURRENTRECHECK",
        severity="high",
        status="report_ready",
        cycle_key="2026-W28",
    )
    sd.confluence_report_thread_set_status(
        current_id,
        "report_ready",
        claimed_by=99,
        claimed_at=time.time(),
        retry_after=time.time() + 3600,
    )
    _, old_id = sd.confluence_report_thread_upsert(
        finding_id=222,
        space_key="OLDRECHECK",
        severity="high",
        status="report_ready",
        cycle_key="2026-W27",
    )
    _, closed_id = sd.confluence_report_thread_upsert(
        finding_id=223,
        space_key="CLOSEDRECHECK",
        severity="low",
        status="closed",
        cycle_key="2026-W28",
    )
    _, reported_id = sd.confluence_report_thread_upsert(
        finding_id=224,
        space_key="REPORTEDRECHECK",
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
    thread = sd.confluence_report_thread_get(current_id)
    assert thread["status"] == "recheck_requested"
    assert thread["claimed_by"] is None
    assert thread["claimed_at"] is None
    assert thread["retry_after"] is None
    assert thread["last_reason"] == "manual recheck requested from confluence webapp"
    messages = sd.service_reply_messages_for_thread("confluence", current_id)
    assert messages[-1]["direction"] == "operator"
    assert messages[-1]["agent_verdict"] == "operator_manual_recheck_requested"
    evidence = _operator_evidence(messages[-1])
    assert evidence["before"]["status"] == "report_ready"
    assert evidence["before"]["claimed_by"] == 99
    assert evidence["after"]["status"] == "recheck_requested"
    assert evidence["after"]["claimed_by"] is None
    assert evidence["after"]["claimed_at"] is None
    assert evidence["after"]["retry_after"] is None
    assert evidence["after"]["last_reason"] == "manual recheck requested from confluence webapp"
    assert ok.json()["thread"]["is_current_cycle"] is True
    assert ok.json()["thread"]["can_request_recheck"] is True

    assert old.status_code == 400
    assert terminal.status_code == 400
    assert pre_report.status_code == 400
    assert sd.confluence_report_thread_get(old_id)["status"] == "report_ready"
    assert sd.confluence_report_thread_get(closed_id)["status"] == "closed"
    assert sd.confluence_report_thread_get(reported_id)["status"] == "reported"
    old_detail = client.get(f"/api/reports/{old_id}?cycle_key=all").json()["thread"]
    closed_detail = client.get(f"/api/reports/{closed_id}").json()["thread"]
    assert old_detail["is_current_cycle"] is False
    assert old_detail["can_request_recheck"] is False
    assert closed_detail["is_current_cycle"] is True
    assert closed_detail["can_request_recheck"] is False


def test_confluence_reports_ui_exposes_cycle_filter(tmp_db) -> None:
    from fastapi.testclient import TestClient

    from domains.services.confluence.webapp.app import create_app

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


def test_confluence_pipeline_report_stage_is_current_cycle_only(tmp_db, monkeypatch) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application.contracts import CONFLUENCE_REPORT_SESSION_ID
    from domains.services.confluence.webapp.pipeline_view import pipeline_overview

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    sd.confluence_report_thread_upsert(
        finding_id=301,
        space_key="OLD",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    _, current_id = sd.confluence_report_thread_upsert(
        finding_id=302,
        space_key="OPS",
        severity="medium",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
        cycle_key="2026-W28",
    )
    _, cooling_id = sd.confluence_report_thread_upsert(
        finding_id=303,
        space_key="COOLINGREPORT",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
        cycle_key="2026-W28",
    )
    _, processing_id = sd.confluence_report_thread_upsert(
        finding_id=304,
        space_key="PROCESSINGREPORT",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
        cycle_key="2026-W28",
    )
    sd.confluence_report_thread_set_status(
        cooling_id,
        "reported",
        retry_after=time.time() + 3600,
    )
    sd.confluence_report_thread_set_status(
        processing_id,
        "reported",
        claimed_by=CONFLUENCE_REPORT_SESSION_ID,
        claimed_at=time.time(),
    )

    body = pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    next_refs = {target["session_ref"] for target in stages["report"]["targets"]["next"]}
    active_refs = {target["session_ref"] for target in stages["report"]["targets"]["active"]}
    report_metrics = {m["label"]: m["value"] for m in stages["report"]["metrics"]}

    assert body["cycle_key"] == "2026-W28"
    assert body["report_thread_status_counts"]["reported"] == 3
    assert stages["report"]["queue"] == 1
    assert stages["report"]["processing"] == 1
    assert report_metrics["리포트 대기"] == 1
    assert report_metrics["리포트 처리중"] == 1
    assert f"confluence-thread-{current_id}" in next_refs
    assert f"confluence-thread-{cooling_id}" not in next_refs
    assert active_refs == {f"confluence-thread-{processing_id}"}


def test_confluence_pipeline_space_stage_resets_on_new_week(tmp_db, monkeypatch) -> None:
    import service.state_domain as sd
    from domains.services.confluence.webapp.pipeline_view import pipeline_overview

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    space_id = sd.confluence_space_target_upsert("WEEKLY", space_name="Weekly")
    sd.confluence_space_target_set_status(space_id, "tasked", finding_count=1)

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    body = pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    discovery_metrics = {m["label"]: m["value"] for m in stages["space_discovery"]["metrics"]}
    task_metrics = {m["label"]: m["value"] for m in stages["space_task"]["metrics"]}
    next_refs = {target["session_ref"] for target in stages["space_task"]["targets"]["next"]}

    assert body["cycle_key"] == "2026-W28"
    assert discovery_metrics["미검사 space"] == 1
    assert discovery_metrics["검사 이력 space"] == 0
    assert stages["space_task"]["queue"] == 1
    assert stages["space_task"]["done"] == 0
    assert task_metrics["대기 space"] == 1
    assert f"space-{space_id}" in next_refs


def test_confluence_pipeline_sso_stage_resets_on_new_week_without_github_overlap(
    tmp_db,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.webapp.pipeline_view import pipeline_overview

    day = dt.date.today().isoformat()
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    target_id = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/WEEKLY",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=7,
    )
    sd.devops_target_set_status(target_id, "tasked", finding_count=1)
    github_id = sd.devops_target_upsert(
        "https://github.samsungds.net/org/repo",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=100,
    )
    sd.devops_target_set_status(github_id, "tasked", finding_count=2)

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    body = pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    discovery_metrics = {m["label"]: m["value"] for m in stages["sso_discovery"]["metrics"]}
    task_metrics = {m["label"]: m["value"] for m in stages["sso_task"]["metrics"]}
    next_refs = {target["session_ref"] for target in stages["sso_task"]["targets"]["next"]}

    assert body["cycle_key"] == "2026-W28"
    assert body["sso_status_counts"]["total"] == 1
    assert discovery_metrics["미검사 URL"] == 1
    assert discovery_metrics["검사 이력 URL"] == 0
    assert stages["sso_task"]["queue"] == 1
    assert stages["sso_task"]["done"] == 0
    assert task_metrics["대기 URL"] == 1
    assert f"devops-{target_id}" in next_refs
    assert f"devops-{github_id}" not in next_refs

    confluence = sd.devops_target_get(target_id)
    github = sd.devops_target_get(github_id)
    assert confluence["cycle_key"] == "2026-W28"
    assert confluence["status"] == "pending"
    assert github["cycle_key"] == "2026-W27"
    assert github["status"] == "tasked"


def test_confluence_pipeline_owner_stage_is_current_cycle_only(tmp_db, monkeypatch) -> None:
    import service.state_domain as sd
    from domains.services.confluence.webapp.pipeline_view import pipeline_overview

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    sd.confluence_report_thread_upsert(
        finding_id=350,
        space_key="OLD",
        severity="high",
        recipient="old.owner@samsung.com",
        status="reported",
        cycle_key="2026-W27",
    )
    _, missing_id = sd.confluence_report_thread_upsert(
        finding_id=351,
        space_key="MISS",
        severity="medium",
        status="reported",
        cycle_key="2026-W28",
    )
    _, owner_id = sd.confluence_report_thread_upsert(
        finding_id=352,
        space_key="READY",
        severity="high",
        recipient="space.owner@samsung.com",
        status="reported",
        cycle_key="2026-W28",
    )
    sd.confluence_report_thread_set_status(
        owner_id,
        "awaiting_owner",
        recipient="dssoc@samsung.com",
        last_reason="report mailed",
    )
    _, fallback_id = sd.confluence_report_thread_upsert(
        finding_id=353,
        space_key="FALLBACK",
        severity="low",
        status="reported",
        cycle_key="2026-W28",
    )
    sd.confluence_report_thread_set_status(
        fallback_id,
        "report_ready",
        recipient="dssoc@samsung.com",
    )
    _, escalated_id = sd.confluence_report_thread_upsert(
        finding_id=354,
        space_key="ESCALATED",
        severity="high",
        status="escalated",
        cycle_key="2026-W28",
    )

    body = pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    owner_metrics = {m["label"]: m["value"] for m in stages["owner"]["metrics"]}
    owner_next = {target["session_ref"] for target in stages["owner"]["targets"]["next"]}
    report_next = {target["session_ref"] for target in stages["report"]["targets"]["next"]}
    done_metrics = {m["label"]: m["value"] for m in stages["done"]["metrics"]}

    assert stages["owner"]["queue"] == 3
    assert stages["owner"]["done"] == 1
    assert stages["report"]["queue"] == 0
    assert owner_metrics["담당자 대상"] == 4
    assert owner_metrics["담당자 후보 있음"] == 1
    assert owner_metrics["담당자 후보 없음"] == 3
    assert owner_metrics["발송 수신자만 있음"] == 1
    assert f"confluence-thread-{missing_id}" in owner_next
    assert f"confluence-thread-{fallback_id}" in owner_next
    assert f"confluence-thread-{escalated_id}" in owner_next
    assert f"confluence-thread-{missing_id}" not in report_next
    assert f"confluence-thread-{fallback_id}" not in report_next
    assert f"confluence-thread-{escalated_id}" not in report_next
    assert f"confluence-thread-{owner_id}" not in owner_next
    assert done_metrics["에스컬레이션"] == 1


def test_confluence_pipeline_splits_reply_and_recheck_without_overlap(
    tmp_db, monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.webapp.pipeline_view import pipeline_overview

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    sd.confluence_report_thread_upsert(
        finding_id=401,
        space_key="OLD",
        severity="high",
        status="awaiting_owner",
        cycle_key="2026-W27",
    )
    _, waiting_id = sd.confluence_report_thread_upsert(
        finding_id=402,
        space_key="WAITING",
        severity="medium",
        status="awaiting_owner",
        cycle_key="2026-W28",
    )
    _, recheck_id = sd.confluence_report_thread_upsert(
        finding_id=403,
        space_key="RECHECK",
        severity="high",
        status="recheck_requested",
        cycle_key="2026-W28",
    )
    _, hitl_id = sd.confluence_report_thread_upsert(
        finding_id=404,
        space_key="HITL",
        severity="high",
        status="owner_update_needed",
        cycle_key="2026-W28",
    )
    _, escalated_id = sd.confluence_report_thread_upsert(
        finding_id=405,
        space_key="ESCALATEDREPLY",
        severity="high",
        status="escalated",
        cycle_key="2026-W28",
    )

    body = pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}
    reply_metrics = {m["label"]: m["value"] for m in stages["reply"]["metrics"]}
    recheck_metrics = {m["label"]: m["value"] for m in stages["recheck"]["metrics"]}
    reply_next = {target["session_ref"] for target in stages["reply"]["targets"]["next"]}
    recheck_next = {target["session_ref"] for target in stages["recheck"]["targets"]["next"]}

    assert body["cycle_key"] == "2026-W28"
    assert stages["reply"]["queue"] == 1
    assert stages["reply"]["processing"] == 0
    assert stages["reply"]["done"] == 3
    assert reply_metrics["답장 대기"] == 1
    assert reply_metrics["답장 수신"] == 3
    assert f"confluence-thread-{waiting_id}" in reply_next
    assert stages["recheck"]["queue"] == 1
    assert recheck_metrics["재검증 대기"] == 1
    assert recheck_metrics["HITL 검토"] == 1
    assert f"confluence-thread-{recheck_id}" in recheck_next
    assert f"confluence-thread-{hitl_id}" not in recheck_next
    assert f"confluence-thread-{escalated_id}" not in recheck_next


def test_confluence_pipeline_recheck_claim_counts_do_not_overlap_reply_or_queue(
    tmp_db,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.application.contracts import CONFLUENCE_RECHECK_SESSION_ID
    from domains.services.confluence.webapp.pipeline_view import pipeline_overview

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, waiting_id = sd.confluence_report_thread_upsert(
        finding_id=501,
        space_key="WAITING",
        severity="medium",
        status="awaiting_owner",
        cycle_key="2026-W28",
    )
    _, guidance_cooling_id = sd.confluence_report_thread_upsert(
        finding_id=508,
        space_key="GUIDANCECOOLING",
        severity="medium",
        status="awaiting_owner",
        cycle_key="2026-W28",
    )
    sd.confluence_report_thread_set_status(
        guidance_cooling_id,
        "awaiting_owner",
        retry_after=time.time() + 3600,
    )
    _, queued_id = sd.confluence_report_thread_upsert(
        finding_id=502,
        space_key="QUEUED",
        severity="high",
        status="recheck_requested",
        cycle_key="2026-W28",
    )
    _, cooling_id = sd.confluence_report_thread_upsert(
        finding_id=506,
        space_key="COOLING",
        severity="high",
        status="recheck_requested",
        cycle_key="2026-W28",
    )
    sd.confluence_report_thread_set_status(
        cooling_id,
        "recheck_requested",
        retry_after=time.time() + 3600,
    )
    _, claimed_id = sd.confluence_report_thread_upsert(
        finding_id=503,
        space_key="CLAIMED",
        severity="high",
        status="recheck_requested",
        cycle_key="2026-W28",
    )
    _, guidance_claimed_id = sd.confluence_report_thread_upsert(
        finding_id=507,
        space_key="GUIDANCECLAIMED",
        severity="medium",
        status="awaiting_owner",
        cycle_key="2026-W28",
    )
    _, rechecking_id = sd.confluence_report_thread_upsert(
        finding_id=504,
        space_key="RECHECKING",
        severity="high",
        status="rechecking",
        cycle_key="2026-W28",
    )
    sd.confluence_report_thread_upsert(
        finding_id=505,
        space_key="DONE",
        severity="low",
        status="remediated",
        cycle_key="2026-W28",
    )
    with sd.connect() as c:
        claimed_at = time.time()
        c.execute(
            "UPDATE confluence_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (CONFLUENCE_RECHECK_SESSION_ID, claimed_at, claimed_id),
        )
        c.execute(
            "UPDATE confluence_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (CONFLUENCE_RECHECK_SESSION_ID, claimed_at, guidance_claimed_id),
        )
        c.execute(
            "UPDATE confluence_report_thread SET claimed_by=?, claimed_at=? WHERE id=?",
            (CONFLUENCE_RECHECK_SESSION_ID, claimed_at, rechecking_id),
        )

    body = pipeline_overview()
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
    assert reply_metrics["답장 대기"] == 1
    assert reply_metrics["답장 처리중"] == 1
    assert reply_metrics["답장 수신"] == 4
    assert f"confluence-thread-{claimed_id}" not in reply_active
    assert f"confluence-thread-{guidance_claimed_id}" in reply_active
    assert f"confluence-thread-{waiting_id}" in reply_next
    assert f"confluence-thread-{guidance_claimed_id}" not in reply_next
    assert f"confluence-thread-{guidance_cooling_id}" not in reply_next

    assert stages["recheck"]["queue"] == 1
    assert stages["recheck"]["processing"] == 2
    assert recheck_metrics["재검증 대기"] == 1
    assert recheck_metrics["재검증 중"] == 2
    assert f"confluence-thread-{queued_id}" in recheck_next
    assert f"confluence-thread-{cooling_id}" not in recheck_next
    assert f"confluence-thread-{claimed_id}" not in recheck_next
    assert f"confluence-thread-{claimed_id}" in recheck_active
    assert f"confluence-thread-{rechecking_id}" in recheck_active
    assert f"confluence-thread-{guidance_claimed_id}" not in recheck_active


def test_confluence_recheck_agent_pass_exception_schedules_retry(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from service.agents import confluence_recheck_agent

    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "41")
    monkeypatch.setattr(confluence_recheck_agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(
        confluence_recheck_agent,
        "run_guidance_pass",
        lambda *args, **kwargs: {"handled": 0, "sent": 0, "dry_run": 0, "errors": 0},
    )
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=701,
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


def test_confluence_webapp_hitl_owner_reassign_requeues_report_and_filters_recipients(
    tmp_db,
    monkeypatch,
) -> None:
    from fastapi.testclient import TestClient

    import service.state_domain as sd
    from domains.services.confluence.webapp.app import create_app

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, previous_cycle_id = sd.confluence_report_thread_upsert(
        finding_id=601,
        space_key="HITLOWNER",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    sd.confluence_report_thread_set_status(previous_cycle_id, "awaiting_owner")
    action, thread_id = sd.confluence_report_thread_upsert(
        finding_id=601,
        space_key="HITLOWNER",
        severity="high",
        status="owner_reassignment_review",
        cycle_key="2026-W28",
    )
    assert action == "recurred"
    _, closed_id = sd.confluence_report_thread_upsert(
        finding_id=602,
        space_key="CLOSEDOWNER",
        severity="low",
        status="closed",
        cycle_key="2026-W28",
    )
    _, old_id = sd.confluence_report_thread_upsert(
        finding_id=603,
        space_key="OLDOWNERACTION",
        severity="medium",
        status="owner_reassignment_review",
        cycle_key="2026-W27",
    )
    sd.confluence_report_thread_set_status(
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
        json={"recipient": "space.owner@samsung.com"},
    )
    old_cycle = client.post(
        f"/api/reports/{old_id}/reassign-owner",
        json={"recipient": "space.owner@samsung.com"},
    )
    current_detail = client.get(f"/api/reports/{thread_id}").json()["thread"]
    closed_detail = client.get(f"/api/reports/{closed_id}").json()["thread"]
    old_detail = client.get(f"/api/reports/{old_id}?cycle_key=all").json()["thread"]
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
    assert sd.confluence_report_thread_get(old_id)["status"] == "owner_reassignment_review"
    assert sd.service_reply_messages_for_thread("confluence", old_id) == []

    ok = client.post(
        f"/api/reports/{thread_id}/reassign-owner",
        json={
            "recipient": (
                "Space Owner <space.owner@samsung.com>, attacker@example.com, "
                "space.two@partner.samsung.com, dssoc@samsung.com"
            ),
            "reason": "reply identified a new space owner",
        },
    )

    assert ok.status_code == 200
    thread = sd.confluence_report_thread_get(thread_id)
    assert thread["status"] == "reported"
    assert thread["recipient"] == "space.owner@samsung.com, space.two@partner.samsung.com"
    assert thread["owner_recipient"] == "space.owner@samsung.com, space.two@partner.samsung.com"
    assert thread["claimed_by"] is None
    assert thread["claimed_at"] is None
    assert thread["retry_after"] is None
    assert thread["notified_at"] is None
    assert "report requeued" in thread["last_reason"]
    messages = sd.service_reply_messages_for_thread("confluence", thread_id)
    assert messages[-1]["direction"] == "operator"
    assert messages[-1]["agent_verdict"] == "operator_owner_reassigned"
    assert "report requeued" in messages[-1]["decision_reason"]
    assert messages[-1]["extracted_owner"] == {
        "email": "space.owner@samsung.com",
        "emails": ["space.owner@samsung.com", "space.two@partner.samsung.com"],
    }
    evidence = _operator_evidence(messages[-1])
    assert evidence["domain"] == "confluence"
    assert evidence["action"] == "operator_owner_reassigned"
    assert evidence["target"]["thread_id"] == thread_id
    assert evidence["target"]["space_key"] == "HITLOWNER"
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
    assert evidence["after"]["recipient"] == "space.owner@samsung.com, space.two@partner.samsung.com"
    assert evidence["after"]["owner_recipient"] == "space.owner@samsung.com, space.two@partner.samsung.com"
    assert evidence["after"]["claimed_by"] is None
    assert evidence["after"]["claimed_at"] is None
    assert evidence["after"]["retry_after"] is None
    assert evidence["after"]["notified_at"] is None
    assert evidence["after"]["last_reason"] == thread["last_reason"]
    assert evidence["extracted_owner"]["emails"] == [
        "space.owner@samsung.com",
        "space.two@partner.samsung.com",
    ]


def test_confluence_webapp_reassigns_ownerless_reported_thread_into_report_queue(
    tmp_db,
    monkeypatch,
) -> None:
    from fastapi.testclient import TestClient

    import service.state_domain as sd
    from domains.services.confluence.webapp.app import create_app
    from domains.services.confluence.webapp.pipeline_view import pipeline_overview

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=621,
        space_key="OWNERLESS",
        severity="high",
        status="reported",
        cycle_key="2026-W28",
    )
    _, old_id = sd.confluence_report_thread_upsert(
        finding_id=622,
        space_key="OLDOWNERLESS",
        severity="medium",
        status="reported",
        cycle_key="2026-W27",
    )

    before = {stage["key"]: stage for stage in pipeline_overview()["stages"]}
    assert before["owner"]["queue"] == 1
    assert before["report"]["queue"] == 0
    assert sd.confluence_report_thread_claim_next(session_id=908, status="reported") is None
    assert sd.confluence_report_thread_get(thread_id)["claimed_by"] is None

    client = TestClient(create_app())
    detail = client.get(f"/api/reports/{thread_id}").json()["thread"]
    old_detail = client.get(f"/api/reports/{old_id}?cycle_key=all").json()["thread"]
    assert detail["status"] == "reported"
    assert detail["owner_recipient"] is None
    assert detail["can_reassign_owner"] is True
    assert old_detail["is_current_cycle"] is False
    assert old_detail["can_reassign_owner"] is False

    old_cycle = client.post(
        f"/api/reports/{old_id}/reassign-owner",
        json={"recipient": "space.owner@samsung.com"},
    )
    ok = client.post(
        f"/api/reports/{thread_id}/reassign-owner",
        json={
            "recipient": "Space Owner <space.owner@samsung.com>, dssoc@samsung.com",
            "reason": "owner filled from owner stage",
        },
    )

    assert old_cycle.status_code == 400
    assert ok.status_code == 200
    thread = sd.confluence_report_thread_get(thread_id)
    assert thread["status"] == "reported"
    assert thread["recipient"] == "space.owner@samsung.com"
    assert thread["owner_recipient"] == "space.owner@samsung.com"
    messages = sd.service_reply_messages_for_thread("confluence", thread_id)
    assert messages[-1]["agent_verdict"] == "operator_owner_reassigned"
    evidence = _operator_evidence(messages[-1])
    assert evidence["before"]["status"] == "reported"
    assert evidence["before"]["owner_recipient"] is None
    assert evidence["after"]["owner_recipient"] == "space.owner@samsung.com"

    after = {stage["key"]: stage for stage in pipeline_overview()["stages"]}
    report_next = {target["session_ref"] for target in after["report"]["targets"]["next"]}
    owner_next = {target["session_ref"] for target in after["owner"]["targets"]["next"]}
    assert after["owner"]["queue"] == 0
    assert after["report"]["queue"] == 1
    assert f"confluence-thread-{thread_id}" in report_next
    assert f"confluence-thread-{thread_id}" not in owner_next
    claimed = sd.confluence_report_thread_claim_next(session_id=909, status="reported")
    assert claimed is not None
    assert int(claimed["id"]) == thread_id


def test_confluence_webapp_reassigns_owner_update_needed_thread(
    tmp_db,
    monkeypatch,
) -> None:
    from fastapi.testclient import TestClient

    import service.state_domain as sd
    from domains.services.confluence.webapp.app import create_app

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=631,
        space_key="NOTOWNERREPLY",
        severity="high",
        status="owner_update_needed",
        cycle_key="2026-W28",
    )
    sd.confluence_report_thread_set_status(
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
            "recipient": "Space Next <space.next@samsung.com>",
            "reason": "not-owner reply supplied replacement owner",
        },
    )

    assert ok.status_code == 200
    thread = sd.confluence_report_thread_get(thread_id)
    assert thread["status"] == "reported"
    assert thread["recipient"] == "space.next@samsung.com"
    assert thread["owner_recipient"] == "space.next@samsung.com"
    messages = sd.service_reply_messages_for_thread("confluence", thread_id)
    assert messages[-1]["agent_verdict"] == "operator_owner_reassigned"
    evidence = _operator_evidence(messages[-1])
    assert evidence["before"]["status"] == "owner_update_needed"
    assert evidence["after"]["status"] == "reported"
    assert evidence["after"]["owner_recipient"] == "space.next@samsung.com"
    assert evidence["target"]["space_key"] == "NOTOWNERREPLY"


def test_confluence_webapp_hitl_exception_actions_close_or_recheck(tmp_db, monkeypatch) -> None:
    from fastapi.testclient import TestClient

    import service.state_domain as sd
    from domains.services.confluence.webapp.app import create_app

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, close_id = sd.confluence_report_thread_upsert(
        finding_id=611,
        space_key="EXCLOSE",
        severity="medium",
        status="exception_review",
        cycle_key="2026-W28",
    )
    _, reject_id = sd.confluence_report_thread_upsert(
        finding_id=612,
        space_key="EXREJECT",
        severity="medium",
        status="exception_review",
        cycle_key="2026-W28",
    )
    _, non_hitl_id = sd.confluence_report_thread_upsert(
        finding_id=613,
        space_key="NOTHITL",
        severity="low",
        status="reported",
        cycle_key="2026-W28",
    )
    _, owner_hitl_id = sd.confluence_report_thread_upsert(
        finding_id=614,
        space_key="NOTOWNER",
        severity="medium",
        status="owner_update_needed",
        cycle_key="2026-W28",
    )
    _, old_close_id = sd.confluence_report_thread_upsert(
        finding_id=615,
        space_key="OLDEXCLOSE",
        severity="medium",
        status="exception_review",
        cycle_key="2026-W27",
    )
    _, old_reject_id = sd.confluence_report_thread_upsert(
        finding_id=616,
        space_key="OLDEXREJECT",
        severity="medium",
        status="exception_review",
        cycle_key="2026-W27",
    )

    client = TestClient(create_app())
    exception_detail = client.get(f"/api/reports/{close_id}").json()["thread"]
    owner_detail = client.get(f"/api/reports/{owner_hitl_id}").json()["thread"]
    old_exception_detail = client.get(f"/api/reports/{old_close_id}?cycle_key=all").json()["thread"]
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
    assert sd.confluence_report_thread_get(owner_hitl_id)["status"] == "owner_update_needed"
    assert sd.service_reply_messages_for_thread("confluence", owner_hitl_id) == []
    assert sd.confluence_report_thread_get(old_close_id)["status"] == "exception_review"
    assert sd.confluence_report_thread_get(old_reject_id)["status"] == "exception_review"
    assert sd.service_reply_messages_for_thread("confluence", old_close_id) == []
    assert sd.service_reply_messages_for_thread("confluence", old_reject_id) == []
    assert sd.confluence_report_thread_get(close_id)["status"] == "closed"
    assert "reviewer" in sd.confluence_report_thread_get(close_id)["last_reason"]
    assert sd.confluence_report_thread_get(reject_id)["status"] == "recheck_requested"
    assert sd.confluence_report_thread_get(reject_id)["last_reason"] == "exception evidence insufficient"
    closed_messages = sd.service_reply_messages_for_thread("confluence", close_id)
    rejected_messages = sd.service_reply_messages_for_thread("confluence", reject_id)
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
    assert closed_evidence["target"]["space_key"] == "EXCLOSE"
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


def test_smb_webapp_does_not_expose_confluence_pipeline(tmp_db) -> None:
    from fastapi.testclient import TestClient

    from domains.smb.webapp.app import create_app

    client = TestClient(create_app())

    assert client.get("/api/pipeline/confluence/overview").status_code == 404
    assert client.get("/api/reports").status_code == 404
