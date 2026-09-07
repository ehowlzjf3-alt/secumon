"""Pipeline report stage separates queued and claimed mail threads."""
from __future__ import annotations

import time

from domains.smb.application.contracts import MAIL_SESSION_ID, REVERIFY_SESSION_ID
from domains.smb.webapp.pipeline_view import pipeline_overview


def test_pipeline_report_stage_uses_mail_claim_for_processing(tmp_db) -> None:
    import service.state_domain as sd

    sd.mail_thread_upsert(
        finding_id=99,
        host="10.0.0.9",
        subject_tag="[tag](10.0.0.9)",
        status="draft",
    )
    sd.mail_thread_upsert(
        finding_id=100,
        host="10.0.0.10",
        subject_tag="[tag](10.0.0.10)",
        status="reported",
    )
    claimed = sd.mail_thread_claim_next(session_id=MAIL_SESSION_ID, status="reported")
    assert claimed is not None
    assert claimed["host"] == "10.0.0.10"

    sd.mail_thread_upsert(
        finding_id=101,
        host="10.0.0.11",
        subject_tag="[tag](10.0.0.11)",
        status="reported",
    )
    sd.mail_thread_upsert(
        finding_id=102,
        host="10.0.0.12",
        subject_tag="[tag](10.0.0.12)",
        status="awaiting_reply",
    )

    report = next(s for s in pipeline_overview()["stages"] if s["key"] == "report")

    assert report["queue"] == 2
    assert report["processing"] == 1
    assert report["done"] == 1
    assert report["targets"]["active"] == ["10.0.0.10"]
    assert report["targets"]["next"] == ["10.0.0.11", "10.0.0.9"]
    metrics = {m["label"]: m["value"] for m in report["metrics"]}
    assert metrics["리포트 준비 IP"] == 1
    assert metrics["발송 대기 IP"] == 1
    assert metrics["발송 처리중 IP"] == 1
    assert metrics["발송 완료 IP"] == 1


def test_pipeline_owner_stage_counts_splunk_error_as_failed(tmp_db) -> None:
    import service.state_domain as sd

    scan_id = sd.scan_start("smb", ["10.0.0.0/24"])
    _, share_id = sd.upsert_smb_share(scan_id, "10.0.0.0/24", "10.0.0.30", "Data")
    sd.share_set_status(share_id, "walked")
    sd.asset_owner_upsert(
        "10.0.0.30",
        source="splunk:LOOKUP_CONTEXT_ASSET_LIST_V2:error",
    )

    owner = next(s for s in pipeline_overview()["stages"] if s["key"] == "owner")
    metrics = {m["label"]: m["value"] for m in owner["metrics"]}

    assert owner["queue"] == 0
    assert owner["processing"] == 0
    assert owner["done"] == 0
    assert metrics["담당자 대상 IP"] == 1
    assert metrics["담당자 매핑 성공"] == 0
    assert metrics["담당자 매핑 실패"] == 1


def test_pipeline_counts_partial_and_hitl_reply_statuses(tmp_db) -> None:
    import service.state_domain as sd

    sd.mail_thread_upsert(
        finding_id=110,
        host="10.0.0.20",
        subject_tag="[tag](10.0.0.20)",
        status="partially_remediated",
    )
    sd.mail_thread_upsert(
        finding_id=111,
        host="10.0.0.21",
        subject_tag="[tag](10.0.0.21)",
        status="owner_reassignment_review",
    )

    stages = {s["key"]: s for s in pipeline_overview()["stages"]}
    report_metrics = {m["label"]: m["value"] for m in stages["report"]["metrics"]}
    reply_metrics = {m["label"]: m["value"] for m in stages["reply"]["metrics"]}
    reverify_metrics = {m["label"]: m["value"] for m in stages["reverify"]["metrics"]}
    done_metrics = {m["label"]: m["value"] for m in stages["done"]["metrics"]}

    assert report_metrics["발송 완료 IP"] == 2
    assert reply_metrics["답장 수신 IP"] == 2
    assert reverify_metrics["부분 조치 IP"] == 1
    assert reverify_metrics["HITL 검토 IP"] == 1
    assert done_metrics["부분 조치 IP"] == 1
    assert done_metrics["HITL 검토 IP"] == 1


def test_pipeline_mail_and_reply_stages_are_current_cycle_only(tmp_db, monkeypatch) -> None:
    import service.state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    for idx, status in enumerate(
        ["reported", "awaiting_reply", "reply_received", "reverifying",
         "re_requested", "remediated", "partially_remediated", "escalated"],
        start=200,
    ):
        sd.mail_thread_upsert(
            finding_id=idx,
            host=f"10.0.1.{idx - 199}",
            subject_tag=f"[tag](10.0.1.{idx - 199})",
            status=status,
            cycle_key="2026-W27",
        )

    sd.mail_thread_upsert(
        finding_id=300,
        host="10.0.2.10",
        subject_tag="[tag](10.0.2.10)",
        status="reported",
        cycle_key="2026-W28",
    )
    sd.mail_thread_upsert(
        finding_id=301,
        host="10.0.2.11",
        subject_tag="[tag](10.0.2.11)",
        status="awaiting_reply",
        cycle_key="2026-W28",
    )
    sd.mail_thread_upsert(
        finding_id=302,
        host="10.0.2.12",
        subject_tag="[tag](10.0.2.12)",
        status="reply_received",
        cycle_key="2026-W28",
    )
    sd.mail_thread_upsert(
        finding_id=303,
        host="10.0.2.13",
        subject_tag="[tag](10.0.2.13)",
        status="reverifying",
        cycle_key="2026-W28",
    )
    sd.mail_thread_upsert(
        finding_id=304,
        host="10.0.2.14",
        subject_tag="[tag](10.0.2.14)",
        status="re_requested",
        cycle_key="2026-W28",
    )
    sd.mail_thread_upsert(
        finding_id=305,
        host="10.0.2.15",
        subject_tag="[tag](10.0.2.15)",
        status="remediated",
        cycle_key="2026-W28",
    )

    stages = {s["key"]: s for s in pipeline_overview()["stages"]}
    report_metrics = {m["label"]: m["value"] for m in stages["report"]["metrics"]}
    reply_metrics = {m["label"]: m["value"] for m in stages["reply"]["metrics"]}
    reverify_metrics = {m["label"]: m["value"] for m in stages["reverify"]["metrics"]}
    done_metrics = {m["label"]: m["value"] for m in stages["done"]["metrics"]}

    assert stages["report"]["queue"] == 1
    assert report_metrics["발송 완료 IP"] == 5
    assert stages["reply"]["queue"] == 1
    assert reply_metrics["답장 대기 IP"] == 1
    assert reply_metrics["답장 수신 IP"] == 4
    assert stages["reverify"]["queue"] == 1
    assert stages["reverify"]["processing"] == 1
    assert reverify_metrics["재검증 대기 IP"] == 1
    assert reverify_metrics["조치 확인 IP"] == 1
    assert reverify_metrics["재요청 IP"] == 1
    assert stages["done"]["done"] == 1
    assert done_metrics["에스컬레이션 IP"] == 0


def test_pipeline_reply_claim_counts_do_not_overlap_queue_processing_done(
    tmp_db,
    monkeypatch,
) -> None:
    import service.state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    cases = [
        (400, "10.0.3.10", "awaiting_reply"),
        (401, "10.0.3.11", "reply_received"),
        (402, "10.0.3.12", "reply_received"),
        (403, "10.0.3.13", "reverifying"),
        (404, "10.0.3.14", "re_requested"),
    ]
    for finding_id, host, status in cases:
        sd.mail_thread_upsert(
            finding_id=finding_id,
            host=host,
            subject_tag=f"[tag]({host})",
            status=status,
            cycle_key="2026-W28",
        )

    now = time.time()
    with sd.connect() as c:
        c.execute(
            "UPDATE mail_thread SET claimed_by=?, claimed_at=? WHERE host=?",
            (REVERIFY_SESSION_ID, now, "10.0.3.12"),
        )

    stages = {s["key"]: s for s in pipeline_overview()["stages"]}
    reply_metrics = {m["label"]: m["value"] for m in stages["reply"]["metrics"]}
    reverify_metrics = {m["label"]: m["value"] for m in stages["reverify"]["metrics"]}

    assert stages["reply"]["queue"] == 1
    assert stages["reply"]["processing"] == 1
    assert stages["reply"]["done"] == 3
    assert reply_metrics["답장 대기 IP"] == 1
    assert reply_metrics["답장 처리중 IP"] == 1
    assert reply_metrics["답장 수신 IP"] == 3
    assert stages["reply"]["targets"]["active"] == ["10.0.3.12"]
    assert stages["reply"]["targets"]["next"] == ["10.0.3.10"]

    assert stages["reverify"]["queue"] == 1
    assert stages["reverify"]["processing"] == 1
    assert stages["reverify"]["done"] == 1
    assert reverify_metrics["재검증 대기 IP"] == 1
    assert reverify_metrics["재검증 중 IP"] == 1
    assert stages["reverify"]["targets"]["active"] == ["10.0.3.13"]
    assert stages["reverify"]["targets"]["next"] == ["10.0.3.11"]


def test_pipeline_reverify_queue_excludes_future_retry_after(
    tmp_db,
    monkeypatch,
) -> None:
    import service.state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    sd.mail_thread_upsert(
        finding_id=501,
        host="10.0.4.11",
        subject_tag="[tag](10.0.4.11)",
        status="reply_received",
        cycle_key="2026-W28",
    )
    _, scheduled_id = sd.mail_thread_upsert(
        finding_id=502,
        host="10.0.4.12",
        subject_tag="[tag](10.0.4.12)",
        status="reply_received",
        cycle_key="2026-W28",
    )
    with sd.connect() as c:
        c.execute(
            "UPDATE mail_thread SET retry_after=? WHERE id=?",
            (time.time() + 3600, scheduled_id),
        )

    stages = {s["key"]: s for s in pipeline_overview()["stages"]}
    reply_metrics = {m["label"]: m["value"] for m in stages["reply"]["metrics"]}
    reverify_metrics = {m["label"]: m["value"] for m in stages["reverify"]["metrics"]}

    assert reply_metrics["답장 수신 IP"] == 2
    assert stages["reverify"]["queue"] == 1
    assert reverify_metrics["재검증 대기 IP"] == 1
    assert stages["reverify"]["targets"]["next"] == ["10.0.4.11"]
