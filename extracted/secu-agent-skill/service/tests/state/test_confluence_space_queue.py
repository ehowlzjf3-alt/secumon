"""v3.76: confluence_space_target rolling 큐 — github_repo_target 미러.

bounded, oldest-first(never 먼저), cooldown 재스캔, stale 재claim, batch claim, summary.
"""
from __future__ import annotations

import service.state_domain as sd

import time


def test_upsert_is_bounded_and_preserves_scan_history(tmp_db):
    from secu_agent import state  # noqa: F401

    a = sd.confluence_space_target_upsert(
        "RSIP", space_name="Recipe SIP", space_type="global")
    sd.confluence_space_target_set_status(
        a, "tasked", last_scanned_at=1000.0, finding_count=2)
    # 재upsert: 같은 id · 메타 갱신 · last_scanned_at/status 보존
    a2 = sd.confluence_space_target_upsert(
        "RSIP", space_name="Recipe v2", space_type="global")
    assert a2 == a
    row = sd.confluence_space_target_get(a)
    assert row["space_name"] == "Recipe v2"
    assert row["last_scanned_at"] == 1000.0
    assert row["status"] == "tasked"
    assert row["finding_count"] == 2
    # bounded: space 수 = row 수 (누적 X)
    sd.confluence_space_target_upsert("RSIP")
    assert sd.confluence_space_targets_summary()["total"] == 1


def test_claim_never_first_then_oldest(tmp_db):
    from secu_agent import state

    sd.confluence_space_target_upsert("NEVER")
    s_old = sd.confluence_space_target_upsert("OLD")
    s_new = sd.confluence_space_target_upsert("RECENT_BUT_DUE")
    sd.confluence_space_target_set_status(s_old, "tasked", last_scanned_at=100.0)
    sd.confluence_space_target_set_status(
        s_new, "tasked", last_scanned_at=time.time() - 200000)

    c1 = sd.confluence_space_target_claim_next(session_id=7, limit=1)
    assert [r["space_key"] for r in c1] == ["NEVER"]      # never(NULL) 먼저
    assert c1[0]["status"] == "in_progress" and c1[0]["claimed_by"] == 7
    c2 = sd.confluence_space_target_claim_next(session_id=7, limit=1)
    assert [r["space_key"] for r in c2] == ["OLD"]        # 그다음 가장 오래된
    c3 = sd.confluence_space_target_claim_next(session_id=7, limit=1)
    assert [r["space_key"] for r in c3] == ["RECENT_BUT_DUE"]


def test_cooldown_excludes_recently_scanned(tmp_db):
    from secu_agent import state

    r = sd.confluence_space_target_upsert("FRESH")
    sd.confluence_space_target_set_status(r, "tasked")  # last_scanned_at = now
    # 기본 cooldown(86400) 내 → 제외
    assert sd.confluence_space_target_claim_next(session_id=1) == []
    # cooldown 0 → 즉시 재claim (rolling 재스캔)
    again = sd.confluence_space_target_claim_next(session_id=1, cooldown_seconds=0)
    assert [x["space_key"] for x in again] == ["FRESH"]


def test_retry_after_excludes_pending_until_due(tmp_db):
    from secu_agent import state

    r = sd.confluence_space_target_upsert("RETRY")
    with sd.connect() as c:
        c.execute(
            "UPDATE confluence_space_target SET retry_after=? WHERE id=?",
            (time.time() + 3600, r),
        )

    assert sd.confluence_space_target_claim_next(session_id=1) == []

    with sd.connect() as c:
        c.execute(
            "UPDATE confluence_space_target SET retry_after=? WHERE id=?",
            (time.time() - 1, r),
        )
    claimed = sd.confluence_space_target_claim_next(session_id=1)
    assert [x["space_key"] for x in claimed] == ["RETRY"]


def test_stale_in_progress_reclaimed(tmp_db):
    from secu_agent import state

    r = sd.confluence_space_target_upsert("STUCK")
    sd.confluence_space_target_set_status(
        r, "in_progress", claimed_by=99, claimed_at=time.time() - 99999)
    claimed = sd.confluence_space_target_claim_next(session_id=2, stale_seconds=1800)
    assert [x["space_key"] for x in claimed] == ["STUCK"]
    assert claimed[0]["claimed_by"] == 2
    # 방금 claim 한 fresh in_progress 는 다시 안 잡힘
    assert sd.confluence_space_target_claim_next(session_id=3, stale_seconds=1800) == []


def test_batch_claim_limit(tmp_db):
    from secu_agent import state

    for i in range(5):
        sd.confluence_space_target_upsert(f"S{i}")
    claimed = sd.confluence_space_target_claim_next(session_id=1, limit=3)
    assert len(claimed) == 3
    assert all(x["status"] == "in_progress" for x in claimed)
    assert len(sd.confluence_space_target_claim_next(session_id=1, limit=10)) == 2


def test_set_status_tasked_sets_scan_and_releases_claim(tmp_db):
    from secu_agent import state

    r = sd.confluence_space_target_upsert("X")
    sd.confluence_space_target_claim_next(session_id=1)
    sd.confluence_space_target_set_status(r, "tasked", finding_count=3)
    row = sd.confluence_space_target_get(r)
    assert row["status"] == "tasked"
    assert row["finding_count"] == 3
    assert row["last_scanned_at"] is not None
    assert row["claimed_by"] is None and row["claimed_at"] is None


def test_summary_never_and_scanned(tmp_db):
    from secu_agent import state

    sd.confluence_space_target_upsert("N1")
    sd.confluence_space_target_upsert("N2")
    s = sd.confluence_space_target_upsert("DONE")
    sd.confluence_space_target_set_status(s, "tasked")
    summ = sd.confluence_space_targets_summary()
    assert summ["total"] == 3
    assert summ["never_scanned"] == 2
    assert summ["scanned"] == 1
    assert summ["tasked"] == 1
    assert summ["pending"] == 2


def test_weekly_cycle_resets_completed_spaces_to_fresh_queue(tmp_db, monkeypatch):
    from secu_agent import state

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    s = sd.confluence_space_target_upsert("WEEKLY", space_name="Weekly Space")
    sd.confluence_space_target_set_status(s, "tasked", finding_count=3)
    done = sd.confluence_space_target_get(s)
    assert done["cycle_key"] == "2026-W27"
    assert done["cycle_scanned_at"] is not None
    assert done["cycle_finding_count"] == 3
    assert sd.confluence_space_targets_summary()["scanned"] == 1

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    reset = sd.confluence_space_cycle_ensure_current()
    row = sd.confluence_space_target_get(s)
    assert reset["targets_reset"] == 1
    assert row["status"] == "pending"
    assert row["cycle_key"] == "2026-W28"
    assert row["cycle_scanned_at"] is None
    assert row["cycle_finding_count"] == 0
    claimed = sd.confluence_space_target_claim_next(session_id=88)
    assert [x["space_key"] for x in claimed] == ["WEEKLY"]


def test_existing_space_upsert_enters_new_cycle_without_losing_history(tmp_db, monkeypatch):
    from secu_agent import state

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    s = sd.confluence_space_target_upsert("REDISC", space_name="Old")
    sd.confluence_space_target_set_status(s, "tasked", last_scanned_at=2345.0, finding_count=4)

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    same = sd.confluence_space_target_upsert("REDISC", space_name="New")
    row = sd.confluence_space_target_get(s)
    assert same == s
    assert row["space_name"] == "New"
    assert row["last_scanned_at"] == 2345.0
    assert row["finding_count"] == 4
    assert row["status"] == "pending"
    assert row["cycle_key"] == "2026-W28"
    assert row["cycle_scanned_at"] is None


def test_upsert_rejects_empty_space_key(tmp_db):
    import pytest

    from secu_agent import state
    with pytest.raises(ValueError):
        sd.confluence_space_target_upsert("")
