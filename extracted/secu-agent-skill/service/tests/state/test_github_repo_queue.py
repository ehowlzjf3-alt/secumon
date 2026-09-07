"""v3.75-1: github_repo_target rolling 큐 — bounded, oldest-first(never 먼저), cooldown 재스캔."""
from __future__ import annotations

import service.state_domain as sd

import time


def test_upsert_is_bounded_and_preserves_scan_history(tmp_db):
    from secu_agent import state  # noqa: F401

    a = sd.github_repo_target_upsert(
        "org/a", default_branch="main", pushed_at="2026-05-01T00:00:00Z")
    sd.github_repo_target_set_status(a, "tasked", last_scanned_at=1000.0, finding_count=2)
    # 재upsert: 같은 id · 메타 갱신 · last_scanned_at/status 보존
    a2 = sd.github_repo_target_upsert(
        "org/a", default_branch="dev", pushed_at="2026-06-01T00:00:00Z")
    assert a2 == a
    row = sd.github_repo_target_get(a)
    assert row["default_branch"] == "dev"
    assert row["pushed_at"] == "2026-06-01T00:00:00Z"
    assert row["last_scanned_at"] == 1000.0
    assert row["status"] == "tasked"
    assert row["finding_count"] == 2
    # bounded: repo 수 = row 수 (누적 X)
    sd.github_repo_target_upsert("org/a")
    assert sd.github_repo_targets_summary()["total"] == 1


def test_claim_never_first_then_oldest(tmp_db):
    from secu_agent import state

    sd.github_repo_target_upsert("o/never")
    s_old = sd.github_repo_target_upsert("o/old")
    s_new = sd.github_repo_target_upsert("o/recent_but_due")
    # 둘 다 cooldown 지난 과거 시각이지만 old < recent
    sd.github_repo_target_set_status(s_old, "tasked", last_scanned_at=100.0)
    sd.github_repo_target_set_status(s_new, "tasked", last_scanned_at=time.time() - 200000)

    c1 = sd.github_repo_target_claim_next(session_id=7, limit=1)
    assert [r["repo"] for r in c1] == ["o/never"]          # never(NULL) 먼저
    assert c1[0]["status"] == "in_progress" and c1[0]["claimed_by"] == 7
    c2 = sd.github_repo_target_claim_next(session_id=7, limit=1)
    assert [r["repo"] for r in c2] == ["o/old"]            # 그다음 가장 오래된
    c3 = sd.github_repo_target_claim_next(session_id=7, limit=1)
    assert [r["repo"] for r in c3] == ["o/recent_but_due"]


def test_cooldown_excludes_recently_scanned(tmp_db):
    from secu_agent import state

    r = sd.github_repo_target_upsert("o/fresh")
    sd.github_repo_target_set_status(r, "tasked")  # last_scanned_at = now
    # 기본 cooldown(86400) 내 → 제외
    assert sd.github_repo_target_claim_next(session_id=1) == []
    # cooldown 0 → 즉시 재claim (rolling 재스캔)
    again = sd.github_repo_target_claim_next(session_id=1, cooldown_seconds=0)
    assert [r["repo"] for r in again] == ["o/fresh"]


def test_retry_after_excludes_pending_until_due(tmp_db):
    from secu_agent import state

    r = sd.github_repo_target_upsert("o/retry")
    with sd.connect() as c:
        c.execute(
            "UPDATE github_repo_target SET retry_after=? WHERE id=?",
            (time.time() + 3600, r),
        )

    assert sd.github_repo_target_claim_next(session_id=1) == []

    with sd.connect() as c:
        c.execute(
            "UPDATE github_repo_target SET retry_after=? WHERE id=?",
            (time.time() - 1, r),
        )
    claimed = sd.github_repo_target_claim_next(session_id=1)
    assert [x["repo"] for x in claimed] == ["o/retry"]


def test_stale_in_progress_reclaimed(tmp_db):
    from secu_agent import state

    r = sd.github_repo_target_upsert("o/stuck")
    # in_progress 로 claim 됐는데 오래 묵음 → stale 재claim
    sd.github_repo_target_set_status(
        r, "in_progress", claimed_by=99, claimed_at=time.time() - 99999)
    claimed = sd.github_repo_target_claim_next(session_id=2, stale_seconds=1800)
    assert [x["repo"] for x in claimed] == ["o/stuck"]
    assert claimed[0]["claimed_by"] == 2
    # 방금 claim 한 fresh in_progress 는 다시 안 잡힘
    assert sd.github_repo_target_claim_next(session_id=3, stale_seconds=1800) == []


def test_batch_claim_limit(tmp_db):
    from secu_agent import state

    for i in range(5):
        sd.github_repo_target_upsert(f"o/r{i}")
    claimed = sd.github_repo_target_claim_next(session_id=1, limit=3)
    assert len(claimed) == 3
    assert all(x["status"] == "in_progress" for x in claimed)
    # 남은 2개
    assert len(sd.github_repo_target_claim_next(session_id=1, limit=10)) == 2


def test_set_status_tasked_sets_scan_and_releases_claim(tmp_db):
    from secu_agent import state

    r = sd.github_repo_target_upsert("o/x")
    sd.github_repo_target_claim_next(session_id=1)
    sd.github_repo_target_set_status(r, "tasked", finding_count=3)
    row = sd.github_repo_target_get(r)
    assert row["status"] == "tasked"
    assert row["finding_count"] == 3
    assert row["last_scanned_at"] is not None
    assert row["claimed_by"] is None and row["claimed_at"] is None


def test_summary_never_and_scanned(tmp_db):
    from secu_agent import state

    sd.github_repo_target_upsert("o/n1")
    sd.github_repo_target_upsert("o/n2")
    s = sd.github_repo_target_upsert("o/done")
    sd.github_repo_target_set_status(s, "tasked")
    summ = sd.github_repo_targets_summary()
    assert summ["total"] == 3
    assert summ["never_scanned"] == 2
    assert summ["scanned"] == 1
    assert summ["tasked"] == 1
    assert summ["pending"] == 2


def test_weekly_cycle_resets_completed_repos_to_fresh_queue(tmp_db, monkeypatch):
    from secu_agent import state

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    r = sd.github_repo_target_upsert("o/weekly")
    sd.github_repo_target_set_status(r, "tasked", finding_count=2)
    done = sd.github_repo_target_get(r)
    assert done["cycle_key"] == "2026-W27"
    assert done["cycle_scanned_at"] is not None
    assert done["cycle_finding_count"] == 2
    assert sd.github_repo_targets_summary()["scanned"] == 1

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    reset = sd.github_repo_cycle_ensure_current()
    row = sd.github_repo_target_get(r)
    assert reset["targets_reset"] == 1
    assert row["status"] == "pending"
    assert row["cycle_key"] == "2026-W28"
    assert row["cycle_scanned_at"] is None
    assert row["cycle_finding_count"] == 0
    # 지난 주에 방금 스캔했어도 새 주차 fresh queue 는 cooldown 을 무시하고 시작한다.
    claimed = sd.github_repo_target_claim_next(session_id=77)
    assert [x["repo"] for x in claimed] == ["o/weekly"]


def test_existing_repo_upsert_enters_new_cycle_without_losing_history(tmp_db, monkeypatch):
    from secu_agent import state

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    r = sd.github_repo_target_upsert("o/rediscovered", default_branch="main")
    sd.github_repo_target_set_status(r, "tasked", last_scanned_at=1234.0, finding_count=5)

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    same = sd.github_repo_target_upsert("o/rediscovered", default_branch="develop")
    row = sd.github_repo_target_get(r)
    assert same == r
    assert row["default_branch"] == "develop"
    assert row["last_scanned_at"] == 1234.0
    assert row["finding_count"] == 5
    assert row["status"] == "pending"
    assert row["cycle_key"] == "2026-W28"
    assert row["cycle_scanned_at"] is None


def test_scanned_sha_setter_getter_roundtrip(tmp_db):
    """v3.78 G1: commit dedup 커서 set/get."""
    from secu_agent import state

    tid = sd.github_repo_target_upsert("org/cursor", default_branch="main")
    assert sd.github_repo_get_scanned_sha("org/cursor") is None  # 초기 None
    sd.github_repo_set_scanned_sha("org/cursor", "deadbeef")
    assert sd.github_repo_get_scanned_sha("org/cursor") == "deadbeef"
    # claim row 에도 포함
    row = sd.github_repo_target_get(tid)
    assert row["last_scanned_sha"] == "deadbeef"


def test_scanned_sha_set_creates_cursor_row_for_unknown_repo(tmp_db):
    """row 없는 explicit repo scan 도 commit cursor 를 보존한다."""
    from secu_agent import state

    sd.github_repo_set_scanned_sha("org/missing", "abc")
    assert sd.github_repo_get_scanned_sha("org/missing") == "abc"
    claimed = sd.github_repo_target_claim_next(session_id=42, limit=1)
    assert claimed[0]["repo"] == "org/missing"
    assert claimed[0]["last_scanned_sha"] == "abc"
