"""dev_web E2E state tables and claim/report transitions."""
from __future__ import annotations

import datetime as dt
import time

import service.state_domain as sd


def _today() -> str:
    return dt.date.today().isoformat()


def test_dev_web_target_claim_isolated_from_web_target(tmp_db) -> None:
    day = _today()
    dev_id = sd.dev_web_target_upsert(
        "dev-example.cdep.samsungds.net",
        source="splunk",
        day_bucket=day,
        event_count=20,
    )
    sd.web_target_upsert(
        "web-example.cdep.samsungds.net",
        source="splunk",
        day_bucket=day,
        event_count=99,
    )

    claimed = sd.dev_web_target_claim_next(session_id=101, day_bucket=day)

    assert claimed is not None
    assert int(claimed["id"]) == dev_id
    assert sd.dev_web_targets_summary(day_bucket=day)["in_progress"] == 1
    assert sd.web_targets_summary(day_bucket=day)["pending"] == 1


def test_dev_web_target_claim_defaults_to_current_cycle(tmp_db, monkeypatch) -> None:
    day = _today()
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    old_id = sd.dev_web_target_upsert(
        "https://old-cycle.example.test",
        source="manual",
        day_bucket=day,
        cycle_key="2026-W27",
    )
    current_id = sd.dev_web_target_upsert(
        "https://current-cycle.example.test",
        source="manual",
        day_bucket=day,
        cycle_key="2026-W28",
    )

    claimed = sd.dev_web_target_claim_next(session_id=101)

    assert claimed is not None
    assert int(claimed["id"]) == current_id
    assert sd.dev_web_target_get(old_id)["status"] == "pending"
    assert sd.dev_web_targets_summary(cycle_key="2026-W27")["pending"] == 1
    assert sd.dev_web_targets_summary(cycle_key="2026-W28")["in_progress"] == 1


def test_dev_web_target_cooldown_and_stale_claim(tmp_db) -> None:
    day = _today()
    target_id = sd.dev_web_target_upsert(
        "https://dev-old.example.test",
        source="manual",
        day_bucket=day,
        event_count=1,
    )
    sd.dev_web_target_claim_next(session_id=1, day_bucket=day)
    sd.dev_web_target_set_status(
        target_id,
        "in_progress",
        claimed_at=time.time() - 99999,
    )

    reclaimed = sd.dev_web_target_claim_next(
        session_id=2,
        day_bucket=day,
        stale_seconds=1800,
    )

    assert reclaimed is not None
    assert reclaimed["claimed_by"] == 2


def test_dev_web_target_retry_after_excludes_pending_until_due(tmp_db) -> None:
    day = _today()
    target_id = sd.dev_web_target_upsert(
        "https://dev-retry.example.test",
        source="manual",
        day_bucket=day,
        event_count=1,
    )
    sd.dev_web_target_set_status(target_id, "pending", retry_after=time.time() + 3600)

    assert sd.dev_web_target_claim_next(session_id=3, day_bucket=day) is None

    sd.dev_web_target_set_status(target_id, "pending", retry_after=time.time() - 1)
    claimed = sd.dev_web_target_claim_next(session_id=4, day_bucket=day)

    assert claimed is not None
    assert int(claimed["id"]) == target_id
    assert claimed["claimed_by"] == 4


def test_dev_web_report_thread_promote_claim_and_status_counts(tmp_db) -> None:
    day = _today()
    target_id = sd.dev_web_target_upsert(
        "https://dev-report.example.test",
        source="manual",
        day_bucket=day,
    )
    action, thread_id = sd.dev_web_report_thread_upsert(
        target_id=target_id,
        finding_id=7,
        domain="dev-report.example.test",
        url="https://dev-report.example.test",
        severity="high",
        status="draft",
        report_json={"summary": "unauthenticated dev endpoint"},
    )

    assert action == "new"
    assert sd.dev_web_report_thread_claim_next(session_id=5, status="reported") is None
    assert sd.dev_web_report_thread_promote_target(target_id) == 1
    claimed = sd.dev_web_report_thread_claim_next(session_id=5, status="reported")
    assert claimed is not None
    assert int(claimed["id"]) == thread_id
    assert sd.dev_web_report_thread_status_counts()["reported"] == 1


def test_dev_web_report_thread_claim_skips_future_retry_after(tmp_db) -> None:
    _, thread_id = sd.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=77,
        domain="dev-thread-retry.example.test",
        url="https://dev-thread-retry.example.test",
        severity="high",
        status="reported",
    )
    sd.dev_web_report_thread_set_status(thread_id, "reported", retry_after=time.time() + 3600)

    assert sd.dev_web_report_thread_claim_next(session_id=6, status="reported") is None

    sd.dev_web_report_thread_set_status(thread_id, "reported", retry_after=time.time() - 1)
    claimed = sd.dev_web_report_thread_claim_next(session_id=7, status="reported")

    assert claimed is not None
    assert int(claimed["id"]) == thread_id
    assert claimed["claimed_by"] == 7


def test_dev_web_report_threads_are_isolated_by_weekly_cycle(tmp_db, monkeypatch) -> None:
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    old_action, old_id = sd.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=88,
        domain="same.example.test",
        url="https://same.example.test",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    assert old_action == "new"
    sd.dev_web_report_thread_set_status(old_id, "awaiting_reply")

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    assert sd.dev_web_report_thread_claim_next(session_id=8, status="reported") is None
    recur_action, recur_id = sd.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=88,
        domain="same.example.test",
        url="https://same.example.test",
        severity="high",
        status="reported",
        cycle_key="2026-W28",
    )

    assert recur_action == "recurred"
    assert recur_id != old_id
    assert sd.dev_web_report_thread_get(old_id)["last_cycle_key"] == "2026-W27"
    assert sd.dev_web_report_thread_get(recur_id)["last_cycle_key"] == "2026-W28"
    assert [t["id"] for t in sd.dev_web_report_threads_overview(cycle_key="2026-W27")] == [old_id]
    assert [t["id"] for t in sd.dev_web_report_threads_overview(cycle_key="2026-W28")] == [recur_id]
    assert sd.dev_web_report_thread_status_counts(cycle_key="2026-W27")["awaiting_reply"] == 1
    assert sd.dev_web_report_thread_status_counts(cycle_key="2026-W28")["reported"] == 1

    claimed = sd.dev_web_report_thread_claim_next(session_id=9, status="reported")
    assert claimed is not None
    assert int(claimed["id"]) == recur_id


def test_dev_web_recheck_result_records_and_transitions(tmp_db) -> None:
    action, thread_id = sd.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=8,
        domain="dev-fixed.example.test",
        url="https://dev-fixed.example.test",
        severity="medium",
        status="reply_received",
    )
    assert action == "new"

    result_id = sd.dev_web_recheck_result_add(
        thread_id=thread_id,
        target_id=None,
        finding_id=8,
        domain="dev-fixed.example.test",
        url="https://dev-fixed.example.test",
        verdict="remediated",
        verification_json={"checked": True},
    )
    sd.dev_web_report_thread_set_status(thread_id, "remediated")

    assert result_id > 0
    assert sd.dev_web_report_thread_get(thread_id)["status"] == "remediated"
