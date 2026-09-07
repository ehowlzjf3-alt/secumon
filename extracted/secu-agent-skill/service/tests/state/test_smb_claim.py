"""v3.60: smb_host_claim_next — host 단위 atomic claim (web_target_claim_next 대응).

동시 smb-batch 세션이 같은 host 를 중복 점검하지 않도록 host 의 pending share 전부를
한 UPDATE 로 in_progress 점유. 세션 15~18 web 중복 사고의 SMB 판 방지.
"""
from __future__ import annotations

import time

import pytest

from domains.smb.application.contracts import SA_SESSION_ID
from service.collector import walk_core
import service.state_domain as sd
from secu_agent import state


@pytest.fixture(autouse=True)
def _isolated_db(tmp_db):
    yield


def _seed(*specs):
    """specs = (host, share, subnet). scan 하나 만들고 upsert. share_id 리스트 반환."""
    sid = sd.scan_start("smb", ["10.0.0.0/24"])
    ids = []
    for host, share, subnet in specs:
        _, share_id = sd.upsert_smb_share(sid, subnet, host, share, share_read=True)
        ids.append(share_id)
    return ids


# ─── 기본 claim ────────────────────────────────────────────


def test_claim_returns_host_with_most_shares_and_marks_in_progress():
    _seed(
        ("10.0.0.5", "data", "10.0.0.0/24"),
        ("10.0.0.5", "backup", "10.0.0.0/24"),
        ("10.0.0.9", "lone", "10.0.0.0/24"),
    )
    row = sd.smb_host_claim_next(session_id=15)
    assert row is not None
    assert row["host"] == "10.0.0.5"  # share 2개 → 우선
    assert len(row["share_ids"]) == 2
    # 그 host 의 share 전부 in_progress + claim
    for sh in sd.smb_shares_of_host("10.0.0.5"):
        assert sh["status"] == "in_progress"
        assert sh["claimed_by"] == 15
        assert sh["claimed_at"] is not None
    # 다른 host 는 그대로 pending
    assert sd.smb_shares_of_host("10.0.0.9")[0]["status"] == "pending"


def test_direct_host_claim_marks_specific_host_in_progress():
    _seed(
        ("10.0.0.5", "data", "10.0.0.0/24"),
        ("10.0.0.9", "other", "10.0.0.0/24"),
    )
    row = sd.smb_host_claim(host="10.0.0.9", session_id=22)
    assert row is not None
    assert row["host"] == "10.0.0.9"
    claimed = sd.smb_shares_of_host("10.0.0.9")[0]
    assert claimed["status"] == "in_progress"
    assert claimed["claimed_by"] == 22
    assert sd.smb_shares_of_host("10.0.0.5")[0]["status"] == "pending"


def test_concurrent_claims_get_distinct_hosts():
    """두 세션 연달아 claim → 다른 host (핵심 회귀)."""
    _seed(
        ("10.0.0.5", "a", "10.0.0.0/24"),
        ("10.0.0.9", "b", "10.0.0.0/24"),
    )
    r1 = sd.smb_host_claim_next(session_id=15)
    r2 = sd.smb_host_claim_next(session_id=16)
    assert r1["host"] != r2["host"]
    assert {r1["host"], r2["host"]} == {"10.0.0.5", "10.0.0.9"}


def test_claim_returns_none_when_no_pending():
    _seed(("10.0.0.5", "a", "10.0.0.0/24"))
    sd.smb_host_claim_next(session_id=15)
    assert sd.smb_host_claim_next(session_id=16) is None


def test_claim_empty_pool_returns_none():
    assert sd.smb_host_claim_next(session_id=1) is None


def test_host_claim_skips_future_communication_retry():
    ids = _seed(("10.0.0.5", "a", "10.0.0.0/24"))
    sd.smb_share_schedule_communication_retry(
        ids[0],
        reason="host off",
        retry_seconds=3600,
        status="pending",
    )

    assert sd.smb_host_claim_next(session_id=15) is None

    sd.share_set_status(ids[0], "pending", retry_after=time.time() - 1)
    row = sd.smb_host_claim_next(session_id=15)
    assert row is not None
    assert row["host"] == "10.0.0.5"


def test_subnet_sweep_due_includes_due_communication_retry_before_weekly_cooldown():
    sd.smb_target_add("10.0.0.0/24", charter_ref="c", added_by="d")
    ids = _seed(("10.0.0.5", "a", "10.0.0.0/24"))
    sd.subnet_mark_swept("10.0.0.0/24", scan_id=1)
    sd.smb_share_schedule_communication_retry(
        ids[0],
        reason="host off",
        retry_seconds=-1,
        status="pending",
    )

    rows = sd.subnets_pending_sweep(limit=10, cooldown_seconds=7 * 86400)
    assert [r["subnet"] for r in rows] == ["10.0.0.0/24"]

    claimed = sd.smb_subnet_claim_next(session_id=15, cooldown_seconds=7 * 86400)
    assert claimed is not None
    assert claimed["subnet"] == "10.0.0.0/24"


def test_subnet_sweep_skips_future_communication_retry_before_weekly_cooldown():
    sd.smb_target_add("10.0.0.0/24", charter_ref="c", added_by="d")
    ids = _seed(("10.0.0.5", "a", "10.0.0.0/24"))
    sd.subnet_mark_swept("10.0.0.0/24", scan_id=1)
    sd.smb_share_schedule_communication_retry(
        ids[0],
        reason="host off",
        retry_seconds=3600,
        status="pending",
    )

    assert sd.subnets_pending_sweep(limit=10, cooldown_seconds=7 * 86400) == []
    assert sd.smb_subnet_claim_next(session_id=15, cooldown_seconds=7 * 86400) is None


# ─── stale reclaim ─────────────────────────────────────────


def test_stale_in_progress_host_is_reclaimed():
    ids = _seed(("10.0.0.5", "a", "10.0.0.0/24"))
    sd.smb_host_claim_next(session_id=15)
    sd.share_set_status(ids[0], "in_progress", claimed_at=time.time() - 99999)
    r = sd.smb_host_claim_next(session_id=16, stale_seconds=1800)
    assert r is not None
    assert r["host"] == "10.0.0.5"
    assert sd.smb_shares_of_host("10.0.0.5")[0]["claimed_by"] == 16


def test_fresh_in_progress_not_reclaimed():
    _seed(("10.0.0.5", "a", "10.0.0.0/24"))
    sd.smb_host_claim_next(session_id=15)
    assert sd.smb_host_claim_next(session_id=16, stale_seconds=1800) is None


def test_reclaim_stale_host_claims_releases_paused_goal_claim():
    sess = state.chat_session_new(agent_type="agent")
    state.goal_set(sess, goal_text="SMB batch", max_turns=0)
    _seed(("10.0.0.5", "a", "10.0.0.0/24"))
    sd.smb_host_claim_next(session_id=sess)
    assert sd.smb_hosts_summary()["in_progress_hosts"] == 1

    state.goal_pause(sess, reason="user paused")
    reclaimed = sd.smb_reclaim_stale_host_claims(stale_seconds=1800)

    assert reclaimed == 1
    row = sd.smb_shares_of_host("10.0.0.5")[0]
    assert row["status"] == "pending"
    assert row["claimed_by"] is None


def test_reclaim_stale_host_claims_keeps_active_fresh_claim():
    sess = state.chat_session_new(agent_type="agent")
    state.goal_set(sess, goal_text="SMB batch", max_turns=0)
    _seed(("10.0.0.5", "a", "10.0.0.0/24"))
    sd.smb_host_claim_next(session_id=sess)

    assert sd.smb_reclaim_stale_host_claims(stale_seconds=1800) == 0
    row = sd.smb_shares_of_host("10.0.0.5")[0]
    assert row["status"] == "in_progress"
    assert row["claimed_by"] == sess


# ─── terminal → claim 해제 ─────────────────────────────────


def test_host_set_status_terminal_clears_claim():
    _seed(
        ("10.0.0.5", "a", "10.0.0.0/24"),
        ("10.0.0.5", "b", "10.0.0.0/24"),
    )
    sd.smb_host_claim_next(session_id=15)
    sd.smb_host_set_status("10.0.0.5", "triaged_completed", hits_count=3)
    for sh in sd.smb_shares_of_host("10.0.0.5"):
        assert sh["status"] == "triaged_completed"
        assert sh["claimed_by"] is None
        assert sh["claimed_at"] is None


def test_share_set_status_terminal_clears_claim():
    ids = _seed(("10.0.0.5", "a", "10.0.0.0/24"))
    sd.smb_host_claim_next(session_id=15)
    sd.share_set_status(ids[0], "walked")
    sh = sd.smb_shares_of_host("10.0.0.5")[0]
    assert sh["status"] == "walked"
    assert sh["claimed_by"] is None


def test_share_set_status_in_progress_keeps_claim():
    ids = _seed(("10.0.0.5", "a", "10.0.0.0/24"))
    sd.smb_host_claim_next(session_id=15)
    sd.share_set_status(ids[0], "in_progress", claimed_at=12345.0)
    assert sd.smb_shares_of_host("10.0.0.5")[0]["claimed_by"] == 15


# ─── subnet 필터 ───────────────────────────────────────────


def test_claim_respects_subnet_filter():
    _seed(
        ("10.0.0.5", "a", "10.0.0.0/24"),
        ("10.1.0.5", "b", "10.1.0.0/24"),
    )
    r = sd.smb_host_claim_next(session_id=15, subnet="10.1.0.0/24")
    assert r["host"] == "10.1.0.5"


# ─── summary ───────────────────────────────────────────────


def test_hosts_summary_counts_by_host_status():
    _seed(
        ("10.0.0.5", "a", "10.0.0.0/24"),
        ("10.0.0.5", "b", "10.0.0.0/24"),
        ("10.0.0.9", "c", "10.0.0.0/24"),
    )
    sd.smb_host_claim_next(session_id=15)  # 10.0.0.5 → in_progress
    summ = sd.smb_hosts_summary()
    assert summ["total_hosts"] == 2
    assert summ["in_progress_hosts"] == 1
    assert summ["pending_hosts"] == 1


# ─── subnet claim ─────────────────────────────────────────


def test_subnet_claim_next_marks_claim_and_pending_excludes_it():
    sd.smb_target_add("10.0.0.0/24", charter_ref="c", added_by="d")
    sd.smb_target_add("10.1.0.0/24", charter_ref="c", added_by="d")

    r1 = sd.smb_subnet_claim_next(session_id=15)
    r2 = sd.smb_subnet_claim_next(session_id=16)

    assert r1["subnet"] == "10.0.0.0/24"
    assert r1["claimed_by"] == 15
    assert r2["subnet"] == "10.1.0.0/24"
    assert sd.subnets_pending_sweep(limit=10) == []


def test_subnet_claim_stale_reclaimed():
    sd.smb_target_add("10.0.0.0/24", charter_ref="c", added_by="d")
    sd.smb_subnet_claim_next(session_id=15)
    with sd.connect() as c:
        c.execute(
            "UPDATE smb_target_subnet SET claimed_at=? WHERE subnet=?",
            (time.time() - 99999, "10.0.0.0/24"),
        )

    r = sd.smb_subnet_claim_next(session_id=16, stale_seconds=1800)
    assert r is not None
    assert r["subnet"] == "10.0.0.0/24"
    assert r["claimed_by"] == 16


def test_subnet_mark_swept_clears_claim():
    sd.smb_target_add("10.0.0.0/24", charter_ref="c", added_by="d")
    sd.smb_subnet_claim_next(session_id=15)
    sd.subnet_mark_swept("10.0.0.0/24", scan_id=1)
    row = sd.smb_target_list()[0]
    assert row["swept_at"] is not None
    assert row["claimed_by"] is None
    assert row["claimed_at"] is None


def test_partially_done_host_still_claimable():
    """host 의 일부 share 만 terminal 이면 남은 pending share 로 여전히 claim 가능."""
    ids = _seed(
        ("10.0.0.5", "a", "10.0.0.0/24"),
        ("10.0.0.5", "b", "10.0.0.0/24"),
    )
    sd.share_set_status(ids[0], "walked")  # a 완료, b 는 pending
    r = sd.smb_host_claim_next(session_id=15)
    assert r is not None
    assert r["host"] == "10.0.0.5"
    assert ids[1] in r["share_ids"]
    assert ids[0] not in r["share_ids"]  # 이미 terminal 인 건 claim 안 함


def test_task_claim_next_claims_one_share_not_whole_host():
    ids = _seed(
        ("10.0.0.5", "a", "10.0.0.0/24"),
        ("10.0.0.5", "b", "10.0.0.0/24"),
    )
    for share_id in ids:
        sd.share_set_status(share_id, "walked")

    r1 = sd.smb_task_claim_next(session_id=SA_SESSION_ID)
    r2 = sd.smb_task_claim_next(session_id=SA_SESSION_ID)

    assert r1 is not None and r2 is not None
    assert r1["host"] == r2["host"] == "10.0.0.5"
    assert len(r1["share_ids"]) == 1
    assert len(r2["share_ids"]) == 1
    assert set(r1["share_ids"]) | set(r2["share_ids"]) == set(ids)
    assert sd.smb_task_claim_next(session_id=SA_SESSION_ID) is None


def test_task_claim_skips_future_communication_retry():
    ids = _seed(("10.0.0.5", "a", "10.0.0.0/24"))
    sd.share_set_status(ids[0], "walked")
    sd.smb_share_schedule_communication_retry(
        ids[0],
        reason="host off",
        retry_seconds=3600,
        status="walked",
    )

    assert sd.smb_task_claim_next(session_id=SA_SESSION_ID) is None

    sd.share_set_status(ids[0], "walked", retry_after=time.time() - 1)
    row = sd.smb_task_claim_next(session_id=SA_SESSION_ID)
    assert row is not None
    assert row["share_ids"] == [ids[0]]


def test_task_claim_includes_due_triaged_retry_before_weekly_rescan():
    ids = _seed(("10.0.0.5", "a", "10.0.0.0/24"))
    sd.share_set_status(ids[0], "triaged_completed", processed_at=time.time())
    sd.smb_share_schedule_communication_retry(
        ids[0],
        reason="host off",
        retry_seconds=-1,
        status="triaged_completed",
    )

    row = sd.smb_task_claim_next(
        session_id=SA_SESSION_ID,
        rescan_seconds=7 * 86400,
    )

    assert row is not None
    assert row["share_ids"] == [ids[0]]


def test_mail_thread_claim_skips_future_communication_retry():
    _, thread_id = sd.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        status="reply_received",
    )
    sd.mail_thread_schedule_communication_retry(
        thread_id,
        reason="host off",
        retry_seconds=3600,
        status="reply_received",
    )

    assert sd.mail_thread_claim_next(
        session_id=SA_SESSION_ID,
        status="reply_received",
    ) is None

    sd.mail_thread_set_status(
        thread_id,
        "reply_received",
        retry_after=time.time() - 1,
    )
    row = sd.mail_thread_claim_next(
        session_id=SA_SESSION_ID,
        status="reply_received",
    )
    assert row is not None
    assert int(row["id"]) == thread_id


def test_task_host_open_count_drops_to_zero_after_all_share_terminal():
    ids = _seed(
        ("10.0.0.5", "a", "10.0.0.0/24"),
        ("10.0.0.5", "b", "10.0.0.0/24"),
    )
    for share_id in ids:
        sd.share_set_status(share_id, "walked")
    r1 = sd.smb_task_claim_next(session_id=SA_SESSION_ID)
    r2 = sd.smb_task_claim_next(session_id=SA_SESSION_ID)
    assert sd.smb_task_host_open_count("10.0.0.5", session_id=SA_SESSION_ID) == 2

    sd.share_set_status(r1["share_ids"][0], "triaged_completed")
    assert sd.smb_task_host_open_count("10.0.0.5", session_id=SA_SESSION_ID) == 1
    sd.share_set_status(r2["share_ids"][0], "triaged_completed")
    assert sd.smb_task_host_open_count("10.0.0.5", session_id=SA_SESSION_ID) == 0


def test_print_share_walk_marks_share_level_excluded():
    sid = sd.scan_start("smb", ["10.0.0.0/24"])
    _, share_id = sd.upsert_smb_share(
        sid, "10.0.0.0/24", "10.0.0.5", "print$",
        share_read=False,
    )
    digest = sd.smb_host_claim_next(session_id=sd.COLLECTOR_SESSION_ID)
    counts = walk_core.walk_claimed_host(digest)

    row = sd.smb_shares_of_host("10.0.0.5")[0]
    assert row["id"] == share_id
    assert row["status"] == "ignored"
    assert row["excluded_reason"] == "print"
    assert row["excluded_at"] is not None
    assert counts["excluded_print"] == 1
    assert sd.smb_host_claim_next(session_id=15) is None
