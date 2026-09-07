from __future__ import annotations

import time

from fastapi.testclient import TestClient


def _client() -> TestClient:
    from domains.smb.webapp.app import create_app

    return TestClient(create_app())


def test_mail_thread_detail_exposes_outbound_html_body(tmp_db) -> None:
    from service import state_domain as state

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="high",
        status="awaiting_reply",
    )
    html = "<html><body><p>조치 요청 본문</p></body></html>"
    state.mail_message_add(
        direction="out",
        thread_id=thread_id,
        subject="SMB 조치요청",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        mail_from="dssoc",
        mail_to="dssoc",
        body_excerpt=html,
        agent_verdict="sent",
    )

    r = _client().get(f"/api/mail-threads/{thread_id}")

    assert r.status_code == 200
    message = r.json()["messages"][0]
    assert message["body_excerpt"] == html
    assert message["body_html"] == html


def test_mail_thread_report_scope_includes_mail_summary(tmp_db) -> None:
    from service import state_domain as state

    _, reported_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="high",
        status="reported",
    )
    _, mailed_id = state.mail_thread_upsert(
        finding_id=11,
        host="10.0.0.6",
        subject_tag="[보안취약점 조치요청](10.0.0.6)",
        severity="medium",
        status="awaiting_reply",
    )
    state.mail_message_add(
        direction="out",
        thread_id=mailed_id,
        subject="SMB 조치요청",
        subject_tag="[보안취약점 조치요청](10.0.0.6)",
        mail_from="dssoc",
        mail_to="dssoc",
        body_excerpt="<p>발송 본문</p>",
        agent_verdict="sent",
    )

    r = _client().get("/api/mail-threads?scope=report")

    assert r.status_code == 200
    by_id = {item["id"]: item for item in r.json()["items"]}
    assert reported_id in by_id
    assert mailed_id in by_id
    assert by_id[reported_id]["has_outbound_mail"] is False
    assert by_id[reported_id]["mail_to"] is None
    assert by_id[reported_id]["finding_count"] == 1
    assert by_id[reported_id]["ticket_no"] == f"SMB{reported_id:05d}"
    assert by_id[reported_id]["display_title"] == f"(SMB{reported_id:05d})10.0.0.5"
    assert by_id[mailed_id]["has_outbound_mail"] is True
    assert by_id[mailed_id]["mail_to"] == "dssoc"
    assert by_id[mailed_id]["sent_subject"] == "SMB 조치요청"


def test_mail_thread_report_scope_sorts_by_ticket_desc(tmp_db) -> None:
    from service import state_domain as state

    _, low_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="high",
        status="awaiting_reply",
    )
    _, high_id = state.mail_thread_upsert(
        finding_id=11,
        host="10.0.0.6",
        subject_tag="[보안취약점 조치요청](10.0.0.6)",
        severity="medium",
        status="awaiting_reply",
    )
    with state.connect() as c:
        c.execute(
            "UPDATE mail_thread SET updated_at=updated_at+1000 WHERE id=?",
            (low_id,),
        )

    r = _client().get("/api/mail-threads?scope=report")

    assert r.status_code == 200
    ids = [item["id"] for item in r.json()["items"]]
    assert ids[:2] == [high_id, low_id]


def test_mail_thread_report_scope_does_not_count_dry_run_as_sent(tmp_db) -> None:
    from service import state_domain as state

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="high",
        status="reported",
    )
    state.mail_message_add(
        direction="out",
        thread_id=thread_id,
        subject="[보안취약점 조치요청](10.0.0.5) 공유폴더 접근권한 관리",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        mail_from="dssoc",
        mail_to="dssoc",
        body_excerpt="<p>차단된 본문</p>",
        agent_verdict="dry_run",
    )

    r = _client().get("/api/mail-threads?scope=report")

    assert r.status_code == 200
    item = next(item for item in r.json()["items"] if item["id"] == thread_id)
    assert item["message_count"] == 1
    assert item["has_outbound_mail"] is False
    assert item["sent_at"] is None
    assert item["sent_subject"] is None


def test_mail_thread_report_scope_includes_deduped_finding_tags(tmp_db) -> None:
    from secu_agent import state as core_state
    from service import state_domain as state

    pii_id, _ = core_state.finding_upsert(
        task_type="smb",
        asset="smb://10.0.0.7/D$/contacts.csv",
        asset_kind="file",
        severity="high",
        summary="직원 연락처 명부 노출",
        extra={"hits": [{"category": "pii", "kind": "employee_contact_roster"}]},
    )
    proc_id, _ = core_state.finding_upsert(
        task_type="smb",
        asset="smb://10.0.0.7/D$/recipe.txt",
        asset_kind="file",
        severity="high",
        summary="공정 레시피 자료 노출",
        extra={"hits": [{"category": "semiconductor_process", "kind": "process_recipe"}]},
    )
    secret_id, _ = core_state.finding_upsert(
        task_type="smb",
        asset="smb://10.0.0.7/D$/app.env",
        asset_kind="file",
        severity="high",
        summary="크리덴셜 노출",
        extra={
            "hits": [
                {"category": "secret", "kind": "aws_access_key_id"},
                {"category": "credential", "kind": "credential_reachability"},
            ],
        },
    )
    _, thread_id = state.mail_thread_upsert(
        finding_id=pii_id,
        host="10.0.0.7",
        subject_tag="[보안취약점 조치요청](10.0.0.7)",
        severity="high",
        status="reported",
    )
    state.mail_thread_upsert(
        finding_id=proc_id,
        host="10.0.0.7",
        subject_tag="[보안취약점 조치요청](10.0.0.7)",
        severity="high",
        status="reported",
    )
    state.mail_thread_upsert(
        finding_id=secret_id,
        host="10.0.0.7",
        subject_tag="[보안취약점 조치요청](10.0.0.7)",
        severity="high",
        status="reported",
    )

    r = _client().get("/api/mail-threads?scope=report")

    assert r.status_code == 200
    item = next(item for item in r.json()["items"] if item["id"] == thread_id)
    assert item["finding_count"] == 3
    assert item["finding_tags"] == [
        {"key": "pii", "label": "개인정보"},
        {"key": "semiconductor_process", "label": "공정자료"},
        {"key": "credential", "label": "크리덴셜"},
    ]


def test_mail_thread_report_scope_honors_view_reset(tmp_db) -> None:
    from service import state_domain as state

    baseline = time.time()
    _, old_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="high",
        status="awaiting_reply",
    )
    _, new_id = state.mail_thread_upsert(
        finding_id=11,
        host="10.0.0.6",
        subject_tag="[보안취약점 조치요청](10.0.0.6)",
        severity="medium",
        status="awaiting_reply",
    )
    with state.connect() as c:
        c.execute(
            "UPDATE mail_thread SET created_at=?, updated_at=? WHERE id=?",
            (baseline - 100, baseline - 100, old_id),
        )
        c.execute(
            "UPDATE mail_thread SET created_at=?, updated_at=? WHERE id=?",
            (baseline - 100, baseline - 100, new_id),
        )
    state.mail_message_add(
        direction="out",
        thread_id=old_id,
        subject="old",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        mail_to="dssoc",
        agent_verdict="sent",
        received_at=baseline - 50,
    )
    state.mail_message_add(
        direction="out",
        thread_id=new_id,
        subject="new",
        subject_tag="[보안취약점 조치요청](10.0.0.6)",
        mail_to="dssoc",
        agent_verdict="sent",
        received_at=baseline + 50,
    )
    state.control_flag_set(
        "report_view",
        interval_seconds=baseline,
        updated_by="test",
    )

    r = _client().get("/api/mail-threads?scope=report")

    assert r.status_code == 200
    ids = {item["id"] for item in r.json()["items"]}
    assert old_id not in ids
    assert new_id in ids
    assert r.json()["status_counts"] == {"awaiting_reply": 1}


def test_mail_thread_report_scope_defaults_to_current_cycle_and_allows_cycle_lookup(
    tmp_db,
    monkeypatch,
) -> None:
    from service import state_domain as state

    monkeypatch.setattr(state, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, old_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.1.10",
        subject_tag="[보안취약점 조치요청](10.0.1.10)",
        severity="high",
        status="awaiting_reply",
        cycle_key="2026-W27",
    )
    _, current_id = state.mail_thread_upsert(
        finding_id=11,
        host="10.0.1.11",
        subject_tag="[보안취약점 조치요청](10.0.1.11)",
        severity="medium",
        status="reported",
        cycle_key="2026-W28",
    )

    current = _client().get("/api/mail-threads?scope=report")

    assert current.status_code == 200
    body = current.json()
    ids = {item["id"] for item in body["items"]}
    assert body["cycle_key"] == "2026-W28"
    assert current_id in ids
    assert old_id not in ids
    assert body["status_counts"] == {"reported": 1}
    assert body["cycles"][:2] == ["2026-W28", "2026-W27"]

    previous = _client().get("/api/mail-threads?scope=report&cycle_key=2026-W27")

    assert previous.status_code == 200
    previous_body = previous.json()
    previous_ids = {item["id"] for item in previous_body["items"]}
    assert previous_body["cycle_key"] == "2026-W27"
    assert old_id in previous_ids
    assert current_id not in previous_ids
    assert previous_body["status_counts"] == {"awaiting_reply": 1}


def test_mail_thread_list_defaults_to_current_cycle(
    tmp_db,
    monkeypatch,
) -> None:
    from service import state_domain as state

    monkeypatch.setattr(state, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, old_id = state.mail_thread_upsert(
        finding_id=20,
        host="10.0.2.20",
        subject_tag="[보안취약점 조치요청](10.0.2.20)",
        severity="high",
        status="reply_received",
        cycle_key="2026-W27",
    )
    _, current_id = state.mail_thread_upsert(
        finding_id=21,
        host="10.0.2.21",
        subject_tag="[보안취약점 조치요청](10.0.2.21)",
        severity="medium",
        status="reported",
        cycle_key="2026-W28",
    )

    current = _client().get("/api/mail-threads")

    assert current.status_code == 200
    body = current.json()
    ids = {item["id"] for item in body["items"]}
    assert body["cycle_key"] == "2026-W28"
    assert current_id in ids
    assert old_id not in ids
    assert body["status_counts"] == {"reported": 1}

    previous = _client().get("/api/mail-threads?cycle_key=2026-W27")

    assert previous.status_code == 200
    previous_body = previous.json()
    previous_ids = {item["id"] for item in previous_body["items"]}
    assert previous_body["cycle_key"] == "2026-W27"
    assert old_id in previous_ids
    assert current_id not in previous_ids
    assert previous_body["status_counts"] == {"reply_received": 1}


def test_mail_thread_detail_keeps_inbound_body_as_text(tmp_db) -> None:
    from service import state_domain as state

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="high",
        status="reply_received",
    )
    state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="reply-1",
        subject="Re: SMB 조치요청",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        mail_from="owner.one@samsung.com",
        mail_to="dssoc",
        body_excerpt="<p>처리했습니다</p>",
        agent_verdict="pending",
    )

    r = _client().get(f"/api/mail-threads/{thread_id}")

    assert r.status_code == 200
    message = r.json()["messages"][0]
    assert message["body_excerpt"] == "<p>처리했습니다</p>"
    assert message["body_html"] is None


def test_share_exception_endpoint_marks_share_and_preserves_thread(tmp_db) -> None:
    from service import state_domain as state

    _, share_id = state.upsert_smb_share(
        1,
        "10.0.0.0/24",
        "10.0.0.8",
        "Data",
        auth_login_ok=True,
        share_read=True,
    )
    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.8",
        share_id=share_id,
        subject_tag="[보안취약점 조치요청](10.0.0.8)",
        severity="high",
        status="exception_review",
    )

    r = _client().post(
        f"/api/smb/shares/{share_id}/exception",
        json={
            "thread_id": thread_id,
            "reason": "담당자 확인 완료 - 예외 승인",
            "approved_by": "tester",
        },
    )

    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["share"]["status"] == "ignored"
    assert data["share"]["excluded_reason"] == "exception"
    assert data["share"]["exception"]["reason"] == "담당자 확인 완료 - 예외 승인"
    assert data["share"]["exception"]["thread_id"] == thread_id
    assert data["thread"]["status"] == "exception_review"
    assert "share exception approved" in data["thread"]["last_reason"]


def test_mail_thread_detail_backfills_html_for_legacy_outbound_text(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.services import smb_remediation_report

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="high",
        status="awaiting_reply",
    )
    state.mail_message_add(
        direction="out",
        thread_id=thread_id,
        subject="SMB 조치요청",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        mail_from="dssoc",
        mail_to="dssoc",
        body_excerpt="텍스트로 저장된 과거 발송분",
        agent_verdict="sent",
    )

    def fake_build_remediation_report(*, finding_id: int, host: str):
        assert finding_id == 10
        assert host == "10.0.0.5"
        return {"html": "<html><body><p>재구성된 HTML 본문</p></body></html>"}

    monkeypatch.setattr(
        smb_remediation_report,
        "build_remediation_report",
        fake_build_remediation_report,
    )

    r = _client().get(f"/api/mail-threads/{thread_id}")

    assert r.status_code == 200
    message = r.json()["messages"][0]
    assert message["body_excerpt"] == "텍스트로 저장된 과거 발송분"
    assert message["body_html"] == "<html><body><p>재구성된 HTML 본문</p></body></html>"
