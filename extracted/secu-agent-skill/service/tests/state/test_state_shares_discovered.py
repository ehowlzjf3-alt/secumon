"""v3.44 H6: shares_discovered_not_walked helper 검증.

Root cause of "0 결과" 거짓 보고 — agent 가 shares_pending_listing_review (이미
walked 된 share 만) 를 walk loop 입력으로 사용. 새 helper 는 status='pending' 인
share (discovery 만 됨, walk 대기) 만 반환.
"""
from __future__ import annotations

import time

import service.state_domain as sd
from secu_agent import state


def test_discovered_not_walked_returns_pending_status_only(tmp_db):
    sid = sd.scan_start("smb", ["10.0.0.0/24"])
    # 3 share — pending, walked, listing_reviewed
    _, p1 = sd.upsert_smb_share(sid, "10.0.0.0/24", "10.0.0.1", "share_a")
    _, p2 = sd.upsert_smb_share(sid, "10.0.0.0/24", "10.0.0.2", "share_b")
    _, w1 = sd.upsert_smb_share(sid, "10.0.0.0/24", "10.0.0.3", "share_c")
    sd.share_set_status(w1, "walked")

    rows = sd.shares_discovered_not_walked()
    ids = {r["id"] for r in rows}
    assert p1 in ids and p2 in ids
    assert w1 not in ids


def test_discovered_not_walked_subnet_filter(tmp_db):
    sid = sd.scan_start("smb", ["10.0.0.0/24", "10.0.1.0/24"])
    _, a = sd.upsert_smb_share(sid, "10.0.0.0/24", "10.0.0.1", "share_a")
    _, b = sd.upsert_smb_share(sid, "10.0.1.0/24", "10.0.1.1", "share_b")

    rows = sd.shares_discovered_not_walked(subnet="10.0.0.0/24")
    ids = {r["id"] for r in rows}
    assert a in ids
    assert b not in ids


def test_discovered_not_walked_respects_limit(tmp_db):
    sid = sd.scan_start("smb", ["10.0.0.0/24"])
    for i in range(5):
        sd.upsert_smb_share(sid, "10.0.0.0/24", f"10.0.0.{i}", "share")
    assert len(sd.shares_discovered_not_walked(limit=3)) == 3


def test_discovered_not_walked_empty_when_only_walked(tmp_db):
    sid = sd.scan_start("smb", ["10.0.0.0/24"])
    _, wid = sd.upsert_smb_share(sid, "10.0.0.0/24", "10.0.0.1", "share_a")
    sd.share_set_status(wid, "walked")
    assert sd.shares_discovered_not_walked() == []


def test_discovered_not_walked_skips_future_communication_retry(tmp_db):
    sid = sd.scan_start("smb", ["10.0.0.0/24"])
    _, share_id = sd.upsert_smb_share(
        sid, "10.0.0.0/24", "10.0.0.1", "share_a",
    )
    sd.smb_share_schedule_communication_retry(
        share_id,
        reason="host off",
        retry_seconds=3600,
        status="pending",
    )

    assert sd.shares_discovered_not_walked() == []

    sd.share_set_status(share_id, "pending", retry_after=time.time() - 1)
    rows = sd.shares_discovered_not_walked()
    assert [r["id"] for r in rows] == [share_id]


def test_unseen_discovery_closes_alive_hosts_and_retries_offline_hosts(tmp_db):
    sid1 = sd.scan_start("smb", ["10.0.0.0/24"])
    _, alive_missing = sd.upsert_smb_share(
        sid1, "10.0.0.0/24", "10.0.0.5", "old_share",
    )
    _, offline = sd.upsert_smb_share(
        sid1, "10.0.0.0/24", "10.0.0.9", "old_share",
    )

    sid2 = sd.scan_start("smb", ["10.0.0.0/24"])
    res = sd.smb_unseen_since_scan_apply(
        sid2,
        subnets=["10.0.0.0/24"],
        alive_hosts=["10.0.0.5"],
        retry_seconds=3600,
    )

    rows = {
        row["id"]: row
        for host in ("10.0.0.5", "10.0.0.9")
        for row in sd.smb_shares_of_host(host)
    }
    assert res == {"closed": 1, "retry_scheduled": 1}
    assert rows[alive_missing]["status"] == "closed"
    assert rows[offline]["status"] == "pending"
    assert rows[offline]["last_error_kind"] == "communication_unavailable"
    assert rows[offline]["retry_after"] > time.time()


def test_listing_review_on_pending_share_makes_terminal(tmp_db):
    sid = sd.scan_start("smb", ["10.0.0.0/24"])
    _, share_id = sd.upsert_smb_share(
        sid, "10.0.0.0/24", "10.0.0.1", "print$",
    )
    sd.share_set_listing_review(share_id, {
        "severity": "informational",
        "summary": "driver files only",
        "top_findings": [],
    })

    row = sd.smb_shares_of_host("10.0.0.1")[0]
    assert row["status"] == "listing_reviewed"
    assert row["listing_review_at"] is not None
    assert sd.shares_discovered_not_walked() == []


# ---- v3.72 H1: shares_pending_listing_review HAVING 호환 -----------------

def _seed_walked_share_with_suspicious(sid, host, *, n_suspicious):
    """walked + listing_review NULL 인 share + suspicious file n개 시드."""
    _, sh = sd.upsert_smb_share(sid, "10.0.0.0/24", host, "share")
    for i in range(n_suspicious):
        sd.upsert_smb_file(
            sh, f"/secret_{i}.env",
            size=10, is_text_candidate=True, suspicious_name=True,
        )
    sd.share_set_status(sh, "walked")
    return sh


def test_pending_listing_review_returns_walked_with_enough_suspicious(tmp_db):
    """sqlite 로직 회귀: min_suspicious 임계 위/아래 share 구분."""
    sid = sd.scan_start("smb", ["10.0.0.0/24"])
    hi = _seed_walked_share_with_suspicious(sid, "10.0.0.1", n_suspicious=5)
    _lo = _seed_walked_share_with_suspicious(sid, "10.0.0.2", n_suspicious=2)

    rows = sd.shares_pending_listing_review(min_suspicious=5, limit=10)
    ids = {r["id"] for r in rows}
    assert hi in ids        # 5 >= 5
    assert _lo not in ids    # 2 < 5


def test_pending_listing_review_postgres_no_having_alias_error():
    """HAVING 절 SELECT 별칭 회귀 — PostgreSQL 에서 helper 가 죽지 않아야 한다.

    세션 25 에서 `HAVING susp_count` 가 pg 에서 'column susp_count does not exist'
    로 실패했음 (v3.76: 단일 pg → 항상 실행).
    """
    sid = sd.scan_start("smb", ["10.0.0.0/24"])
    hi = _seed_walked_share_with_suspicious(sid, "10.99.0.1", n_suspicious=5)
    rows = sd.shares_pending_listing_review(min_suspicious=5, limit=10)
    assert hi in {r["id"] for r in rows}
    below = sd.shares_pending_listing_review(min_suspicious=99, limit=10)
    assert hi not in {r["id"] for r in below}
