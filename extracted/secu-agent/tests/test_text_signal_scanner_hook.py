"""de-domain v3.84 #6: 문서-신호 스캐너 등록형 훅 회귀 테스트.

코어 text_scan 은 특정 plugin 모듈 경로(document_sensitivity)를 import 하지 않고
register_text_signal_scanner 로 등록된 스캐너만 순회한다. 코어 단독(등록 없음)이면
include_document_signals=True 라도 문서 신호가 붙지 않는다(graceful degrade).
"""
from __future__ import annotations

import pytest

from secu_agent.detectors.text_scan import (
    register_text_signal_scanner,
    scan_text,
    unregister_all_text_signal_scanners,
)


class _Sig:
    def __init__(self, category: str) -> None:
        self.category = category
        self.kind = "doc_signal"
        self.matched = "SENSITIVE-DOC-TERM"
        self.span = None
        self.source = "path"


@pytest.fixture(autouse=True)
def _clean_scanners():
    unregister_all_text_signal_scanners()
    yield
    unregister_all_text_signal_scanners()


def test_core_only_no_document_signals():
    """등록된 스캐너가 없으면(코어 단독) 문서 신호 없이 동작 — 도메인-프리 기본."""
    r = scan_text("plain text no secrets", label="f", include_document_signals=True)
    assert not any(h.kind == "doc_signal" for h in r.hits)


def test_registered_scanner_signals_included_when_flag_on():
    register_text_signal_scanner(lambda text, label="": [_Sig("business_confidential")])
    r = scan_text("plain text", label="f", include_document_signals=True)
    assert any(h.category == "business_confidential" for h in r.hits)


def test_registered_scanner_not_called_without_flag():
    register_text_signal_scanner(lambda text, label="": [_Sig("business_confidential")])
    r = scan_text("plain text", label="f", include_document_signals=False)
    assert not any(h.category == "business_confidential" for h in r.hits)


def test_scanner_exception_is_swallowed():
    def _boom(text, label=""):
        raise RuntimeError("scanner blew up")

    register_text_signal_scanner(_boom)
    # 예외를 삼키고 코어 secret/pii 결과는 정상 반환.
    r = scan_text("token=AKIAIOSFODNN7EXAMPLE", label="f", include_document_signals=True)
    assert r is not None


def test_multiple_scanners_all_invoked():
    register_text_signal_scanner(lambda text, label="": [_Sig("cat_a")])
    register_text_signal_scanner(lambda text, label="": [_Sig("cat_b")])
    r = scan_text("plain", label="f", include_document_signals=True)
    cats = {h.category for h in r.hits}
    assert {"cat_a", "cat_b"} <= cats
