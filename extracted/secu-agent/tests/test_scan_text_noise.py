"""v3.78.1: scan_text 노이즈 처리 회귀가드.

v3.78 F1 의 '라이선스 컨텍스트 secret 드랍'은 진짜 secret 손실 위험(minified JS·HTML
footer·PEM 의 키가 copyright 단어와 같은 줄에 있으면 삭제)으로 **제거**됐다. 이 파일은
그 회귀가드 — copyright/license 줄에 있어도 진짜 secret 은 절대 안 죽인다. 이메일 노이즈
제거는 finding 게이트(is_low_value_only)가 담당하므로 scan_text 는 이메일도 탐지만 한다.
"""
from __future__ import annotations

from secu_agent.detectors.text_scan import scan_text


def test_secret_on_copyright_line_is_kept():
    """라이선스/저작권 단어와 같은 줄의 진짜 secret 은 유지 (silent drop 금지)."""
    text = 'password = "Tr0ub4dor3xKpzQ"  # Copyright 2026 Acme, all rights reserved'
    kinds = {h.kind for h in scan_text(text).hits}
    assert "generic_password_assignment" in kinds


def test_aws_key_on_spdx_line_is_kept():
    text = 'aws = "AKIA1234567890ABCDEF"  // SPDX-License-Identifier: Apache-2.0'
    kinds = {h.kind for h in scan_text(text).hits}
    assert "aws_access_key_id" in kinds


def test_secret_outside_license_still_detected():
    text = 'password = "Tr0ub4dor3xKpzQ"'
    kinds = {h.kind for h in scan_text(text).hits}
    assert "generic_password_assignment" in kinds


def test_email_still_detected_in_authors_block():
    """이메일은 scan_text 단계에서 탐지됨(노이즈 제거는 finding 게이트 담당)."""
    text = "Maintainer: hong.gildong@samsung.com\nContact: jane.doe@samsung.com\n"
    kinds = {(h.category, h.kind) for h in scan_text(text).hits}
    assert ("pii", "email") in kinds
