from __future__ import annotations

from _shared.detectors.document_sensitivity import (
    path_has_document_signal,
    scan_document_sensitivity,
)
from secu_agent.detectors.text_scan import scan_file, scan_text
from domains.smb.plugin.agent_types.listing_patterns import suspicious


PROCESS_TEXT = """공정 레시피 검토
Lot ID: L12345
Wafer ID: W07
implant dose 조건과 etch rate 변경안
CD uniformity, overlay, defect density, yield loss 확인
수율 분석 및 불량률 개선 계획
"""


BUSINESS_TEXT = """2026 사업계획
매출 계획 및 영업이익 전망
주요 고객사별 단가, 견적, 계약금액 정리
gross margin, revenue forecast, customer pipeline
분기 실적과 투자계획 보고
"""


def test_document_signals_are_opt_in_for_scan_text():
    default = scan_text(PROCESS_TEXT, label="smb://h/data/공정레시피.xlsx")
    enabled = scan_text(
        PROCESS_TEXT,
        label="smb://h/data/공정레시피.xlsx",
        include_document_signals=True,
    )

    assert not any(h.category == "semiconductor_process" for h in default.hits)
    assert any(h.category == "semiconductor_process" for h in enabled.hits)


def test_process_path_title_body_and_classifier_signals():
    result = scan_text(
        PROCESS_TEXT,
        label="smb://h/data/fab/공정조건_recipe.xlsx",
        include_document_signals=True,
    )
    by_kind = {(h.category, h.kind) for h in result.hits}

    assert ("semiconductor_process", "path_keyword") in by_kind
    assert ("semiconductor_process", "document_title_keyword") in by_kind
    assert ("semiconductor_process", "document_body_keyword") in by_kind
    assert ("semiconductor_process", "sample_body_classifier") in by_kind


def test_business_title_body_and_classifier_signals():
    signals = scan_document_sensitivity(
        BUSINESS_TEXT,
        label="smb://h/exec/경영자료/사업계획_매출.xlsx",
    )
    by_kind = {(s.category, s.kind) for s in signals}

    assert ("business_confidential", "path_keyword") in by_kind
    assert ("business_confidential", "document_title_keyword") in by_kind
    assert ("business_confidential", "document_body_keyword") in by_kind
    assert ("business_confidential", "sample_body_classifier") in by_kind


def test_confidential_marker_alone_does_not_create_document_category():
    result = scan_text(
        "대외비 confidential internal only\n일반 공지 문서입니다.",
        label="smb://h/share/대외비/notice.txt",
        include_document_signals=True,
    )

    assert not {
        h.category
        for h in result.hits
        if h.category in {"semiconductor_process", "business_confidential"}
    }


def test_listing_path_suspicious_includes_process_and_business_keywords():
    assert path_has_document_signal("fab/공정조건/recipe.xlsx")
    assert suspicious("fab/공정조건/recipe.xlsx")
    assert suspicious("finance/매출계획/고객사_단가.xlsx")


def test_scan_file_keeps_synthetic_document_signals_once(tmp_path):
    path = tmp_path / "process.txt"
    path.write_text(PROCESS_TEXT + ("\nordinary line" * 200), encoding="utf-8")

    result = scan_file(
        path,
        label="smb://h/data/fab/공정조건_recipe.xlsx",
        include_document_signals=True,
        chunk_chars=256,
        overlap_chars=32,
    )
    synthetic = [
        h for h in result.hits
        if h.category == "semiconductor_process"
        and h.kind in {"path_keyword", "sample_body_classifier"}
    ]

    assert {h.kind for h in synthetic} >= {"path_keyword", "sample_body_classifier"}
    assert sum(1 for h in synthetic if h.kind == "path_keyword") == 1


# ── ASCII 단어 경계 (2026-08-29) ───────────────────────────────────────────

def test_short_ascii_terms_do_not_match_inside_hex_or_guid():
    """★ `fab`·`fdc` 가 SHA256·GUID 안에서 상시 걸렸다.

    실측 2026-08-29 (`smb_file_hit`, semiconductor_process):
        path_keyword  1,588건 중 1,185(74.6%) 오탐 — 전부 SHA256 파일명
        body/title    2,519건 중   933(37.0%) 오탐 — GUID 안의 fdc
        합계 4,107건 중 2,118(51.6%)

    이 목록에 3~4글자 ASCII(`fab fdc etch cmp euv ald nda p&l m&a`)가 있는 한
    경계 없는 substring 매치는 hex 를 상시 잡는다.
    """
    from _shared.detectors.document_sensitivity import _find_phrase

    # 실제 DB 에서 뽑은 오탐 표본
    assert _find_phrase("A7F5DC73DE317F972AFDCC3830C882076627B59", "fdc") is None
    assert _find_phrase("C02923D0F3757BD93FFABE6FB6C598.INI", "fab") is None
    assert _find_phrase("fafdc473-4353-484d-93fb-0", "fdc") is None
    assert _find_phrase("etching", "etch") is None
    assert _find_phrase("helpful", "p&l") is None


def test_real_terms_still_match():
    from _shared.detectors.document_sensitivity import _find_phrase

    assert _find_phrase("/data/FAB/recipe.xlsx", "fab")
    assert _find_phrase("etch chamber log", "etch")
    assert _find_phrase("P&L 2026.xlsx", "p&l")


def test_korean_terms_keep_matching_when_agglutinated():
    """⚠️ 한글에 경계를 걸면 안 된다 — 교착어라 붙여 쓴다.

    `(?<![A-Za-z0-9])` 는 한글 앞뒤를 막지 않으므로 `fab공정` 같은 혼용도 계속 잡힌다.
    """
    from _shared.detectors.document_sensitivity import _find_phrase

    assert _find_phrase("공정자료 최종본", "공정")
    assert _find_phrase("fab공정 레시피", "fab"), "한글이 붙어 ASCII 용어가 막히면 안 된다"


def test_boundary_uses_the_engine_convention_not_word_char_b():
    """`\\b` 는 `_` 를 단어문자로 봐서 `p&l`·`m&a` 처럼 비단어 문자가 든 용어에서 어긋난다.

    엔진 전례(`secu_agent/detectors/secrets.py:36`,
    `agent/evidence_judgment.py:131`)와 같은 lookaround 를 쓴다.
    """
    import inspect

    from _shared.detectors import document_sensitivity as ds

    src = inspect.getsource(ds._find_phrase)
    assert "_ASCII_BOUNDARY_PRE" in src and "_ASCII_BOUNDARY_POST" in src
    assert ds._ASCII_BOUNDARY_PRE == r"(?<![A-Za-z0-9])"
    assert ds._ASCII_BOUNDARY_POST == r"(?![A-Za-z0-9])"
    # 한글은 경계 없이 간다
    assert "phrase.isascii()" in src
