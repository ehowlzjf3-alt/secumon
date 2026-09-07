from __future__ import annotations

from secu_agent import state as core_state

import service.state_domain as sd


def _share(
    *,
    host: str = "10.0.0.7",
    share: str = "D$",
    read: bool = True,
    guest: bool = False,
    auth: bool = True,
    excluded_reason: str | None = None,
) -> int:
    scan_id = sd.scan_start("smb", ["10.0.0.0/24"])
    _, share_id = sd.upsert_smb_share(
        scan_id,
        "10.0.0.0/24",
        host,
        share,
        guest_login_ok=guest,
        auth_login_ok=auth,
        share_read=read,
        share_write=False,
    )
    if excluded_reason:
        sd.share_mark_excluded(share_id, excluded_reason)
    return share_id


def test_open_share_exposure_finding_creates_low_mail_draft(tmp_db) -> None:
    share_id = _share(guest=True)

    finding_id = sd.smb_share_ensure_open_exposure_finding(share_id)

    assert finding_id is not None
    finding = core_state.finding_get(finding_id)
    assert finding is not None
    assert finding["asset"] == "smb://10.0.0.7/D$"
    assert finding["asset_kind"] == "smb_share"
    assert finding["severity"] == "low"
    assert finding["extra"]["classification"]["key"] == "misconfig"
    assert "open_share_exposure" in finding["extra"]["tags"]
    assert "guest_readable" in finding["extra"]["risk_flags"]

    threads = sd.mail_threads_overview(status="draft")
    assert len(threads) == 1
    assert threads[0]["host"] == "10.0.0.7"
    assert threads[0]["severity"] == "low"
    assert sd.mail_thread_finding_ids(int(threads[0]["id"])) == [finding_id]


def test_open_share_exposure_finding_is_deduped(tmp_db) -> None:
    share_id = _share()

    first = sd.smb_share_ensure_open_exposure_finding(share_id)
    second = sd.smb_share_ensure_open_exposure_finding(share_id)

    assert first == second
    rows = core_state.finding_list(task_type="smb")
    assert len(rows) == 1
    threads = sd.mail_threads_overview(status="draft")
    assert len(threads) == 1
    assert sd.mail_thread_finding_ids(int(threads[0]["id"])) == [first]


def test_open_share_exposure_finding_skips_print_share(tmp_db) -> None:
    share_id = _share(share="print$", guest=True, excluded_reason="print")

    assert sd.smb_share_ensure_open_exposure_finding(share_id) is None
    assert core_state.finding_list(task_type="smb") == []
    assert sd.mail_threads_overview(status="draft") == []


def test_open_share_exposure_preserves_sent_thread_status(tmp_db) -> None:
    _, thread_id = sd.mail_thread_upsert(
        finding_id=100,
        host="10.0.0.7",
        subject_tag="[보안취약점 조치요청](10.0.0.7)",
        severity="high",
        status="reported",
    )
    sd.mail_thread_set_status(thread_id, "awaiting_reply", last_reason="report mailed")
    share_id = _share(share="Users")

    finding_id = sd.smb_share_ensure_open_exposure_finding(share_id)

    thread = sd.mail_thread_get(thread_id)
    assert finding_id is not None
    assert thread is not None
    assert thread["status"] == "awaiting_reply"
    assert thread["severity"] == "high"
    assert sd.mail_thread_finding_ids(thread_id) == [100, finding_id]
    assert sd.mail_threads_overview(status="reported") == []
    assert sd.mail_threads_overview(status="draft") == []
