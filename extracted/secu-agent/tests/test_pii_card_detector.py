"""v3.55: 카드번호 검출 — Luhn + IIN(카드사 prefix) 이중 검증.

배경: Luhn 만으론 13자리 epoch 밀리초 타임스탬프·긴 ID 가 ~10% 확률로 통과해
credit_card 오탐 (라이브: idea--family-prod 시간값이 카드로 잡힘).
IIN prefix 검증을 추가해 타임스탬프/ID 를 걸러낸다.
"""
from __future__ import annotations

from secu_agent.detectors.pii import find_pii


def _card_hits(text: str) -> list[str]:
    return [h.matched for h in find_pii(text) if h.kind == "credit_card"]


def test_timestamp_not_flagged_as_card():
    # 13자리 epoch-ms — Luhn 은 통과하지만 카드사 prefix(17..) 없음 → 카드 아님.
    text = "created_at=1779800000000 updated=1779800012345"
    assert _card_hits(text) == []


def test_long_numeric_id_not_flagged():
    # 16자리 순번 ID (Luhn 우연 통과해도 발급망 prefix 없으면 제외).
    text = "order_no=1234567890123452"  # starts with 1 → 어떤 발급망에도 없음
    assert _card_hits(text) == []


def test_visa_detected():
    assert "4111111111111111" in _card_hits("card: 4111111111111111")


def test_visa_with_spaces_detected():
    assert _card_hits("4111 1111 1111 1111")


def test_mastercard_detected():
    assert "5555555555554444" in _card_hits("mc 5555555555554444")


def test_amex_detected():
    assert "378282246310005" in _card_hits("amex 378282246310005")


def test_mastercard_2series_detected():
    # 2221-2720 대역 Mastercard
    assert _card_hits("2223000048410010")
