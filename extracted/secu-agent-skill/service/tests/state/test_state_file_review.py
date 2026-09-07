"""file-level agent review 컬럼 + 큐 + setter — repository 레벨."""
from __future__ import annotations

import service.state_domain as sd

import pytest


def test_new_columns_exist(tmp_db):
    """migration이 4개 컬럼을 만들어야 한다."""
    from secu_agent import state  # noqa: F401
    with sd.connect() as c:
        cols = {r["column_name"] for r in c.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='smb_file'"
        ).fetchall()}
    assert "review_severity" in cols
    assert "review_summary" in cols
    assert "review_status" in cols
    assert "reviewed_at" in cols


def test_files_pending_review_only_returns_readable_unreviewed(tmp_db, seed):
    from secu_agent import state
    sid = seed.share(status="walked")
    # 1) text + readable + unreviewed → 포함
    f_text = seed.file(sid, path="a/notes.txt", fetch_status="text", read=True)
    # 2) binary + readable + unreviewed → 포함
    f_bin = seed.file(sid, path="a/chip.xlsx", fetch_status="binary", read=True)
    # 3) empty + readable + unreviewed → 포함
    f_empty = seed.file(sid, path="a/empty.log", fetch_status="empty", read=True)
    # 4) denied → 제외
    f_denied = seed.file(sid, path="a/locked", fetch_status="denied", read=False)
    # 5) not_found → 제외
    f_nf = seed.file(sid, path="a/gone", fetch_status="not_found", read=False)
    # 6) error → 제외
    f_err = seed.file(sid, path="a/err", fetch_status="error", read=False)

    rows = sd.files_pending_review(limit=10)
    ids = {r["id"] for r in rows}
    assert ids == {f_text, f_bin, f_empty}


def test_files_pending_review_skips_already_reviewed(tmp_db, seed):
    from secu_agent import state
    sid = seed.share(status="walked")
    f1 = seed.file(sid, path="a", fetch_status="text", read=True)
    f2 = seed.file(sid, path="b", fetch_status="text", read=True)
    sd.file_set_review(f1, severity="low", summary="ok")

    rows = sd.files_pending_review(limit=10)
    assert {r["id"] for r in rows} == {f2}


def test_file_set_review_persists_all_fields(tmp_db, seed):
    from secu_agent import state
    sid = seed.share(status="walked")
    fid = seed.file(sid, path="design.xlsx", fetch_status="binary", read=True)

    sd.file_set_review(
        fid,
        severity="high",
        summary="internal chip design (BUCK2 register map)",
        tags=["internal_asset", "design_doc"],
        note="filename + ext indicates classified asset",
    )

    with sd.connect() as c:
        row = c.execute("SELECT * FROM smb_file WHERE id=?", (fid,)).fetchone()
    assert row["review_severity"] == "high"
    assert row["review_summary"] == "internal chip design (BUCK2 register map)"
    assert row["review_status"] == "reviewed"
    assert row["reviewed_at"] is not None
    # agent_tags 는 set_file_note 와 같은 컬럼 재사용 (JSON)
    import json
    assert json.loads(row["agent_tags"]) == ["internal_asset", "design_doc"]
    assert row["agent_note"] == "filename + ext indicates classified asset"


def test_file_set_review_force_overwrites(tmp_db, seed):
    from secu_agent import state
    sid = seed.share(status="walked")
    fid = seed.file(sid, path="a", fetch_status="text", read=True)
    sd.file_set_review(fid, severity="low", summary="first")
    sd.file_set_review(fid, severity="high", summary="second", overwrite=True)

    with sd.connect() as c:
        row = c.execute("SELECT review_severity, review_summary FROM smb_file WHERE id=?",
                        (fid,)).fetchone()
    assert row["review_severity"] == "high"
    assert row["review_summary"] == "second"


def test_files_pending_review_orders_by_suspicious_first(tmp_db, seed):
    """suspicious_name=1 + 본문 있는 파일이 우선순위 위."""
    from secu_agent import state
    sid = seed.share(status="walked")
    f1 = seed.file(sid, path="boring.txt", fetch_status="text",
                   read=True, suspicious=False)
    f2 = seed.file(sid, path=".env", fetch_status="text",
                   read=True, suspicious=True)
    f3 = seed.file(sid, path="other.dat", fetch_status="binary",
                   read=True, suspicious=False)

    rows = sd.files_pending_review(limit=10)
    # .env (suspicious) 가 가장 먼저, 그 다음 text vs binary 는 stable
    assert rows[0]["id"] == f2


def test_files_pending_review_filters_by_share(tmp_db, seed):
    from secu_agent import state
    s1 = seed.share(host="1.1.1.1", share="a")
    s2 = seed.share(host="1.1.1.2", share="b")
    f1 = seed.file(s1, path="a", fetch_status="text", read=True)
    f2 = seed.file(s2, path="b", fetch_status="text", read=True)

    rows = sd.files_pending_review(share_id=s1, limit=10)
    assert {r["id"] for r in rows} == {f1}
