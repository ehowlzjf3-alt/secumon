from __future__ import annotations

import json
import time

import service.state_domain as sd
from service.services import smb_remediation_report


def test_weekly_cycle_resets_subnet_board_without_deleting_history(tmp_db, monkeypatch):
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    sd.smb_target_add("10.0.0.0/24", charter_ref="c", added_by="d")
    sd.subnet_mark_swept("10.0.0.0/24", scan_id=1, hosts_found=2, shares_found=3)

    assert sd.subnets_sweep_overview() == {"total": 1, "swept": 1, "pending": 0}
    assert sd.subnets_pending_sweep(limit=10) == []

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    reset = sd.smb_cycle_ensure_current()

    assert reset["subnets_reset"] == 1
    assert sd.subnets_sweep_overview() == {"total": 1, "swept": 0, "pending": 1}
    rows = sd.subnets_pending_sweep(limit=10)
    assert [r["subnet"] for r in rows] == ["10.0.0.0/24"]


def test_gap_rescan_does_not_rework_completed_share_unless_access_changed(tmp_db, monkeypatch):
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    scan_id = sd.scan_start("smb", ["10.0.0.0/24"])
    _, share_id = sd.upsert_smb_share(
        scan_id,
        "10.0.0.0/24",
        "10.0.0.5",
        "data",
        share_read=True,
        share_write=False,
    )
    sd.share_set_status(share_id, "triaged_completed", processed_at=time.time())

    scan_again = sd.scan_start("smb", ["10.0.0.0/24"])
    sd.upsert_smb_share(
        scan_again,
        "10.0.0.0/24",
        "10.0.0.5",
        "data",
        share_read=True,
        share_write=False,
    )
    same = sd.smb_shares_of_host("10.0.0.5")[0]
    assert same["status"] == "triaged_completed"
    assert sd.smb_task_claim_next(session_id=101) is None

    changed_scan = sd.scan_start("smb", ["10.0.0.0/24"])
    sd.upsert_smb_share(
        changed_scan,
        "10.0.0.0/24",
        "10.0.0.5",
        "data",
        share_read=True,
        share_write=True,
    )
    changed = sd.smb_shares_of_host("10.0.0.5")[0]
    assert changed["status"] == "pending"
    assert sd.smb_host_claim_next(session_id=102)["host"] == "10.0.0.5"


def test_mail_thread_recurrence_counts_only_new_weekly_cycle(tmp_db, monkeypatch):
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    _, thread_id = sd.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        status="reported",
        cycle_key="2026-W27",
    )
    sd.mail_thread_set_status(thread_id, "awaiting_reply")

    same_action, same_id = sd.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        status="reported",
        cycle_key="2026-W27",
    )
    assert (same_action, same_id) == ("dup", thread_id)
    assert sd.mail_thread_get(thread_id)["recurrence_count"] == 0

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    recur_action, recur_id = sd.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        status="reported",
        cycle_key="2026-W28",
    )

    old_thread = sd.mail_thread_get(thread_id)
    recur_thread = sd.mail_thread_get(recur_id)
    assert recur_action == "recurred"
    assert recur_id != thread_id
    assert old_thread["status"] == "awaiting_reply"
    assert old_thread["recurrence_count"] == 0
    assert old_thread["last_cycle_key"] == "2026-W27"
    assert recur_thread["status"] == "reported"
    assert recur_thread["recurrence_count"] == 1
    assert recur_thread["last_cycle_key"] == "2026-W28"
    assert json.loads(recur_thread["cycle_keys"]) == ["2026-W27", "2026-W28"]
    assert [t["id"] for t in sd.mail_threads_overview(cycle_key="2026-W27")] == [thread_id]
    assert [t["id"] for t in sd.mail_threads_overview(cycle_key="2026-W28")] == [recur_id]


def test_report_claim_skips_previous_week_threads(tmp_db, monkeypatch):
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    sd.mail_thread_upsert(
        finding_id=20,
        host="10.0.0.20",
        subject_tag="[보안취약점 조치요청](10.0.0.20)",
        status="reported",
        cycle_key="2026-W27",
    )

    assert sd.mail_thread_claim_next(session_id=202, status="reported") is None

    _, current_id = sd.mail_thread_upsert(
        finding_id=21,
        host="10.0.0.21",
        subject_tag="[보안취약점 조치요청](10.0.0.21)",
        status="reported",
        cycle_key="2026-W28",
    )

    claimed = sd.mail_thread_claim_next(session_id=202, status="reported")
    assert claimed is not None
    assert int(claimed["id"]) == current_id


def test_remediation_report_renders_weekly_accumulation(tmp_db, monkeypatch):
    scan_id = sd.scan_start("smb", ["10.0.0.0/24"])
    _, share_id = sd.upsert_smb_share(
        scan_id,
        "10.0.0.0/24",
        "10.0.0.8",
        "data",
        auth_login_ok=True,
        share_read=True,
    )
    sd.share_set_status(share_id, "triaged_completed", processed_at=time.time())
    finding_id = 1001
    finding = {
        "id": finding_id,
        "task_type": "smb",
        "asset": r"\\10.0.0.8\data",
        "asset_kind": "location",
        "severity": "high",
        "summary": "공유 폴더 권한 확인 필요",
        "extra": {"recommended_actions": ["공유 폴더 접근 권한을 제한한다."]},
    }

    from secu_agent import state as core_state
    monkeypatch.setattr(
        core_state,
        "finding_get",
        lambda fid: finding if int(fid) == finding_id else None,
    )

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    _, thread_id = sd.mail_thread_upsert(
        finding_id=finding_id,
        host="10.0.0.8",
        share_id=share_id,
        subject_tag="[보안취약점 조치요청](10.0.0.8)",
        status="reported",
        cycle_key="2026-W27",
    )
    sd.mail_thread_set_status(thread_id, "closed")
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    # ⚠️ 위 `thread_id` 는 **닫은 W27 스레드**다. 새 주차는 새 스레드를 만든다 —
    #    발송 기록을 옛 스레드에 붙이면 리포트(현행 스레드를 본다)가 못 센다.
    _, w28_thread_id = sd.mail_thread_upsert(
        finding_id=finding_id,
        host="10.0.0.8",
        share_id=share_id,
        subject_tag="[보안취약점 조치요청](10.0.0.8)",
        status="reported",
        cycle_key="2026-W28",
    )

    report = smb_remediation_report.build_remediation_report(finding_id=finding_id)

    # ★ 2026-08-31 규칙 변경: 재확인 문구의 근거는 **스캔 주차가 아니라 발송 횟수**다.
    #   우리가 두 주 연속 본 것과 담당자가 두 번 들은 것은 다르다 — 첫 발송인데도
    #   "2주 누적 확인" 이 실제로 나갔다. 주차 집계 자체는 그대로 살아 있다(아래).
    assert report["cycle_count"] == 2
    assert "번째 안내" not in report["html"], "발송한 적이 없으면 '이전에 안내드린' 을 말하면 안 된다"

    # 실제로 한 번 나갔다고 기록하면 그때부터 말한다.
    sd.mail_message_add(direction="out", thread_id=int(w28_thread_id), subject="s",
                        subject_tag="[보안취약점 조치요청](10.0.0.8)", mail_from="dssoc",
                        mail_to="owner@samsung.com", body_excerpt="b", agent_verdict="sent")
    again = smb_remediation_report.build_remediation_report(finding_id=finding_id)
    assert "2번째 안내 · 이전 1회 안내" in again["html"]
