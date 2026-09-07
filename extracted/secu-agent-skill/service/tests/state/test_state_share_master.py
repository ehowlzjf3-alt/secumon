"""master agent state helpers — share-scoped file 페이지네이션 + 파일 메타."""
from __future__ import annotations

import service.state_domain as sd


# ============================================================
# share_files_filtered — master가 share 안에서 paginate/filter
# ============================================================

def test_share_files_filtered_returns_total_and_items(tmp_db, seed):
    from secu_agent import state
    sid = seed.share()
    for i in range(5):
        seed.file(sid, path=f"a/f{i}.txt", fetch_status="text", read=True)

    result = sd.share_files_filtered(sid, offset=0, limit=3)
    assert result["total"] == 5
    assert len(result["items"]) == 3
    assert all(it["share_id"] == sid for it in result["items"])


def test_share_files_filtered_suspicious_only(tmp_db, seed):
    from secu_agent import state
    sid = seed.share()
    seed.file(sid, path="boring.txt", suspicious=False)
    seed.file(sid, path="secret.env", suspicious=True)
    seed.file(sid, path="creds.yaml", suspicious=True)

    result = sd.share_files_filtered(sid, suspicious_only=True)
    assert result["total"] == 2
    assert {it["path"] for it in result["items"]} == {"secret.env", "creds.yaml"}


def test_share_files_filtered_hits_only(tmp_db, seed):
    from secu_agent import state
    sid = seed.share()
    seed.file(sid, path="a", hits=0)
    f = seed.file(sid, path="b", hits=1)
    seed.hit(f)

    result = sd.share_files_filtered(sid, hits_only=True)
    assert {it["path"] for it in result["items"]} == {"b"}


def test_share_files_filtered_ext(tmp_db, seed):
    from secu_agent import state
    sid = seed.share()
    seed.file(sid, path="a/notes.txt")
    seed.file(sid, path="a/design.xlsx")
    seed.file(sid, path="a/secret.env")
    seed.file(sid, path="a/photo.JPG")  # 대소문자 무관

    r1 = sd.share_files_filtered(sid, ext="xlsx")
    assert {it["path"] for it in r1["items"]} == {"a/design.xlsx"}

    r2 = sd.share_files_filtered(sid, ext="jpg")
    assert {it["path"] for it in r2["items"]} == {"a/photo.JPG"}


def test_share_files_filtered_path_contains(tmp_db, seed):
    from secu_agent import state
    sid = seed.share()
    seed.file(sid, path="정유준님/buck2_a.tif")
    seed.file(sid, path="정유준님/buck2_b.tif")
    seed.file(sid, path="공유/스펙.docx")

    r = sd.share_files_filtered(sid, path_contains="정유준")
    assert r["total"] == 2


def test_share_files_filtered_review_status(tmp_db, seed):
    from secu_agent import state
    sid = seed.share()
    f1 = seed.file(sid, path="a", fetch_status="text", read=True)
    f2 = seed.file(sid, path="b", fetch_status="text", read=True)
    sd.file_set_review(f1, severity="low", summary="ok")

    r_pending = sd.share_files_filtered(sid, review_status="pending")
    assert {it["id"] for it in r_pending["items"]} == {f2}

    r_reviewed = sd.share_files_filtered(sid, review_status="reviewed")
    assert {it["id"] for it in r_reviewed["items"]} == {f1}


def test_share_files_filtered_combines_filters(tmp_db, seed):
    from secu_agent import state
    sid = seed.share()
    seed.file(sid, path="boring.env", suspicious=False)
    seed.file(sid, path="creds.env", suspicious=True, hits=0)
    f = seed.file(sid, path="dumped.env", suspicious=True, hits=1)
    seed.hit(f)

    r = sd.share_files_filtered(sid, suspicious_only=True, ext="env")
    assert r["total"] == 2

    r2 = sd.share_files_filtered(sid, suspicious_only=True, hits_only=True)
    assert {it["id"] for it in r2["items"]} == {f}


# ============================================================
# file_get_metadata — master 가 file 1개 메타 확인
# ============================================================

def test_file_get_metadata_returns_file_share_and_hits(tmp_db, seed):
    from secu_agent import state
    sid = seed.share(host="10.0.0.5", share="Public",
                     status="walked", severity="medium")
    fid = seed.file(sid, path="a/creds.env", size=256, fetch_status="text",
                    read=True, hits=2)
    seed.hit(fid, kind="aws_access_key_id", verdict="confirmed")
    seed.hit(fid, kind="kr_rrn", verdict="false_positive")

    meta = sd.file_get_metadata(fid)
    assert meta is not None
    assert meta["id"] == fid
    assert meta["path"] == "a/creds.env"
    assert meta["size"] == 256
    assert meta["fetch_status"] == "text"
    # parent share
    assert meta["share"]["host"] == "10.0.0.5"
    assert meta["share"]["share"] == "Public"
    # hits summary
    assert meta["hits"]["total"] == 2
    assert meta["hits"]["by_verdict"]["confirmed"] == 1
    assert meta["hits"]["by_verdict"]["false_positive"] == 1


def test_file_get_metadata_returns_none_for_unknown(tmp_db):
    from secu_agent import state
    assert sd.file_get_metadata(99999) is None
