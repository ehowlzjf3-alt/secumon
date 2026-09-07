"""session_search — FTS5 통합 finding 검색.

대상:
- file_finding (review_summary + path + tags + note)
- share_review (listing_review.summary + follow_up_actions)
- memory_rule (rule + scope/key)

master agent 가 "정유준 본 적 있나?" "RSA private key 발견 사례?" 같은 cross-share 검색.
"""
from __future__ import annotations

import service.state_domain as sd

import pytest


def test_session_search_finds_indexed_file_review(tmp_db, seed):
    from secu_agent import state
    sid = seed.share(host="1.1.1.1", share="A")
    fid = seed.file(sid, path="정유준님/PMIC_design.xlsx")

    sd.file_set_review(
        fid, severity="high",
        summary="정유준님 폴더 안 칩 설계 자산 — PMIC BUCK 회로 데이터",
        tags=["internal_asset", "design_doc"],
        note=None,
    )

    rows = state.session_search("정유준")
    assert any(r["ref_id"] == fid and r["kind"] == "file_review" for r in rows)
    # path / summary 둘 다 인덱싱 — '칩 설계' 로도 찾혀야
    rows2 = state.session_search("칩 설계")
    assert any(r["ref_id"] == fid for r in rows2)


def test_session_search_finds_indexed_share_review(tmp_db, seed):
    from secu_agent import state
    sid = seed.share(host="2.2.2.2", share="팀공유")
    sd.share_set_listing_review(sid, {
        "severity": "medium",
        "summary": "팀 문서 공유 — 분기별 사내 분류 자산 confirm 필요",
        "follow_up_actions": ["owner 통보", "permission 좁히기"],
        "reviewer": "smb_share_master",
    })
    rows = state.session_search("팀 문서")
    assert any(r["ref_id"] == sid and r["kind"] == "share_review" for r in rows)


def test_session_search_finds_indexed_memory_rule(tmp_db):
    from secu_agent import state
    state.memory_add(scope="path_pattern", key="정유준님",
                     rule="개인 폴더 — 칩 설계 자산, high default",
                     severity_hint="high")
    rows = state.session_search("개인 폴더")
    assert any(r["kind"] == "memory_rule" for r in rows)


def test_session_search_filter_by_kind(tmp_db, seed):
    from secu_agent import state
    sid = seed.share(host="3.3.3.3", share="X")
    fid = seed.file(sid, path="a/b/secret.env")
    sd.file_set_review(fid, severity="critical",
                          summary="AWS access key 발견",
                          tags=["secret"], note=None)
    state.memory_add(scope="global", key="*",
                     rule="AWS access key 발견 시 즉시 owner 통보")

    file_only = state.session_search("AWS", kind="file_review")
    assert all(r["kind"] == "file_review" for r in file_only)
    assert len(file_only) >= 1

    mem_only = state.session_search("AWS", kind="memory_rule")
    assert all(r["kind"] == "memory_rule" for r in mem_only)
    assert len(mem_only) >= 1


def test_session_search_filter_by_share_excluded(tmp_db, seed):
    """master agent 가 '내 share 빼고 다른 share 들 검색' 가능."""
    from secu_agent import state
    s1 = seed.share(host="1.1.1.1", share="A")
    s2 = seed.share(host="2.2.2.2", share="B")
    f1 = seed.file(s1, path="design1.xlsx")
    f2 = seed.file(s2, path="design2.xlsx")
    sd.file_set_review(f1, severity="high",
                          summary="칩 설계 자산", tags=[], note=None)
    sd.file_set_review(f2, severity="high",
                          summary="칩 설계 자산", tags=[], note=None)

    rows = state.session_search("칩 설계", exclude_share_id=s1)
    assert all(r["share_id"] != s1 for r in rows)
    assert any(r["share_id"] == s2 for r in rows)


def test_session_search_returns_path_and_share_metadata(tmp_db, seed):
    from secu_agent import state
    sid = seed.share(host="1.1.1.1", share="DESIGN")
    fid = seed.file(sid, path="chip/PMIC_BUCK.xlsx")
    sd.file_set_review(fid, severity="high", summary="PMIC 설계",
                          tags=[], note=None)
    rows = state.session_search("PMIC")
    r = next(r for r in rows if r["ref_id"] == fid)
    assert r["share_id"] == sid
    assert r["host"] == "1.1.1.1"
    assert r["share_name"] == "DESIGN"
    assert "PMIC" in r["path"]


def test_session_search_limit(tmp_db, seed):
    from secu_agent import state
    sid = seed.share(host="1.1.1.1", share="A")
    for i in range(15):
        fid = seed.file(sid, path=f"f{i}.txt")
        sd.file_set_review(fid, severity="low",
                              summary=f"테스트 finding {i}",
                              tags=[], note=None)
    rows = state.session_search("테스트", limit=5)
    assert len(rows) == 5


def test_session_search_empty_query_returns_empty(tmp_db):
    from secu_agent import state
    rows = state.session_search("")
    assert rows == []


def test_session_search_overwrite_file_review_reindexes(tmp_db, seed):
    """file_set_review 가 overwrite 되면 인덱스도 새 summary 로."""
    from secu_agent import state
    sid = seed.share(host="1.1.1.1", share="A")
    fid = seed.file(sid, path="a.txt")
    sd.file_set_review(fid, severity="low",
                          summary="old summary 옛날 내용",
                          tags=[], note=None)
    sd.file_set_review(fid, severity="high",
                          summary="새 summary 업데이트된 내용",
                          tags=[], note=None, overwrite=True)
    rows_old = state.session_search("옛날")
    assert all(r["ref_id"] != fid for r in rows_old)
    rows_new = state.session_search("업데이트")
    assert any(r["ref_id"] == fid for r in rows_new)
