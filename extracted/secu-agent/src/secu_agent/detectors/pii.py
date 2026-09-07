"""PII detectors — 한국 환경 기준.

한국 주민등록번호(RRN)는 마지막 자리에 체크섬이 있어 checksum 검증으로 오탐 거의 0.
전화/카드/이메일은 흔한 패턴이라 컨텍스트(주변 키워드) 가중치는 호출 측에서 부여.
"""
from __future__ import annotations

import datetime
import re
from collections.abc import Iterable
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class PIIHit:
    kind: str
    matched: str
    span: tuple[int, int]


# 앞뒤가 숫자/소수점이면 매칭 안 함 — 계측 소수값(18.38118732…)의 소수부를 RRN 으로
# 오인하던 \b 버그 차단. RRN 은 더 긴 수치 리터럴의 일부일 수 없다.
_RRN_RE = re.compile(r"(?<![\d.])(\d{6})-?([1-8]\d{6})(?![\d.])")
_PHONE_RE = re.compile(r"\b(?:0(?:1[016789]|2|[3-6][1-5]|70))-?\d{3,4}-?\d{4}\b")
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
_PERSON_NAME_LABEL_RE = re.compile(
    r"(?i)(?:^|[^\w])['\"]?(?:full\s*name|customer\s*name|employee\s*name|"
    r"owner\s*name|person\s*name|name|성명|이름)['\"]?\s*[:=]\s*['\"]?"
    r"([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}|[가-힣]{2,5})\b"
)
_ADDRESS_LABEL_RE = re.compile(
    r"(?i)(?:^|[^\w])['\"]?(?:shipping\s*address|billing\s*address|"
    r"home\s*address|office\s*address|address|addr|street|주소)['\"]?"
    r"\s*[:=]\s*(?:['\"](?P<quoted_address>[^'\"\n\r]{8,180})['\"]|"
    r"(?P<bare_address>[^\n\r,;}{\]]{8,180}))"
)
_ADDRESS_HINT_RE = re.compile(
    r"(?i)\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|"
    r"boulevard|blvd\.?|suite|ste\.?|apt|apartment|unit|building|bldg|"
    r"postal|postcode|zip|city|district|province|state|suwon|seoul|"
    r"ro|gil|dong|gu|si|do)\b|[가-힣]+(?:로|길|동|구|시|도)"
)
# 카드번호 — 단순 16자리. Luhn으로 한 번 더 거른다.
_CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
# 한국 은행 계좌번호 (자유 포맷 너무 다양해서 키워드 prefix 기반만 잡음)
_ACCOUNT_RE = re.compile(
    r"(?i)(?:계좌|account|acct)[^\d]{0,10}(\d{3,6}-\d{2,6}-\d{4,8}(?:-\d{1,6})?)"
)


# 성별/세기 코드(7번째 자리) → 출생 세기. 1900/2000 은 윤년 규칙이 달라(1900 비윤년,
# 2000 윤년) Feb-29 판정에 세기가 필요하다. 9/0 은 1800 년대(정규식은 [1-8] 만 잡지만 방어).
_RRN_CENTURY = {"1": 1900, "2": 1900, "5": 1900, "6": 1900,
                "3": 2000, "4": 2000, "7": 2000, "8": 2000,
                "9": 1800, "0": 1800}


def _rrn_valid(rrn_digits: str) -> bool:
    """13자리 한국 주민등록번호 — 생년월일 실재성 + checksum.

    checksum 만으론 38년 11월 87일 같은 불가능 날짜가 우연히 통과한다(오탐).
    앞 6자리(YYMMDD)가 실재하는 날짜여야 하고, 세기는 7번째 성별코드로 확정한다."""
    if len(rrn_digits) != 13 or not rrn_digits.isdigit():
        return False
    century = _RRN_CENTURY.get(rrn_digits[6])
    if century is None:
        return False
    try:
        datetime.date(century + int(rrn_digits[0:2]),
                      int(rrn_digits[2:4]), int(rrn_digits[4:6]))
    except ValueError:
        return False
    weights = (2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5)
    s = sum(int(rrn_digits[i]) * weights[i] for i in range(12))
    check = (11 - (s % 11)) % 10
    return check == int(rrn_digits[12])


def _luhn_valid(digits: str) -> bool:
    digs = [int(c) for c in digits if c.isdigit()]
    if not (13 <= len(digs) <= 19):
        return False
    total = 0
    for i, d in enumerate(reversed(digs)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _card_iin_valid(digits: str) -> bool:
    """카드사 발급자식별번호(IIN/BIN) + 길이 검증.

    Luhn 만으론 13자리 epoch 타임스탬프·긴 ID 가 ~10% 확률로 통과해 오탐.
    실제 카드는 발급망별 prefix + 길이가 정해져 있다 — 둘 다 맞아야 카드로 인정.
    타임스탬프(17xx…)·임의 ID 는 어떤 발급망 prefix 에도 안 맞아 걸러진다.
    """
    n = len(digits)
    if not digits.isdigit() or not (13 <= n <= 19):
        return False
    p2 = digits[:2]
    p3 = digits[:3]
    p4 = digits[:4]
    # Visa: 4, 길이 13/16/19
    if digits[0] == "4" and n in (13, 16, 19):
        return True
    # Mastercard: 51-55 또는 2221-2720, 길이 16
    if n == 16 and (p2 in {"51", "52", "53", "54", "55"}
                    or 2221 <= int(p4) <= 2720):
        return True
    # Amex: 34/37, 길이 15
    if n == 15 and p2 in {"34", "37"}:
        return True
    # Discover: 6011 / 65 / 644-649, 길이 16-19
    if 16 <= n <= 19 and (p4 == "6011" or p2 == "65"
                          or (p3.isdigit() and 644 <= int(p3) <= 649)):
        return True
    # JCB: 3528-3589, 길이 16-19
    if 16 <= n <= 19 and p4.isdigit() and 3528 <= int(p4) <= 3589:
        return True
    # Diners Club: 300-305 / 3095 / 36 / 38-39, 길이 14-19
    if 14 <= n <= 19 and (p2 in {"36", "38", "39"}
                          or p4 == "3095"
                          or (p3.isdigit() and 300 <= int(p3) <= 305)):
        return True
    return False


def find_pii(text: str) -> Iterable[PIIHit]:
    hits: list[PIIHit] = []

    for m in _PERSON_NAME_LABEL_RE.finditer(text):
        hits.append(PIIHit(
            kind="person_name_with_label",
            matched=m.group(1),
            span=(m.start(1), m.end(1)),
        ))

    for m in _ADDRESS_LABEL_RE.finditer(text):
        raw = (
            m.group("quoted_address") or m.group("bare_address") or ""
        ).strip().rstrip(",.;")
        if any(ch.isdigit() for ch in raw) and _ADDRESS_HINT_RE.search(raw):
            group_name = (
                "quoted_address" if m.group("quoted_address") is not None else "bare_address"
            )
            group_value = m.group(group_name) or ""
            start = m.start(group_name) + (
                len(group_value) - len(group_value.lstrip())
            )
            hits.append(PIIHit(
                kind="address_with_label",
                matched=raw,
                span=(start, start + len(raw)),
            ))

    for m in _RRN_RE.finditer(text):
        rrn = (m.group(1) + m.group(2))
        if _rrn_valid(rrn):
            hits.append(PIIHit(kind="kr_rrn", matched=m.group(0), span=(m.start(), m.end())))

    for m in _PHONE_RE.finditer(text):
        hits.append(PIIHit(kind="kr_phone", matched=m.group(0), span=(m.start(), m.end())))

    for m in _EMAIL_RE.finditer(text):
        hits.append(PIIHit(kind="email", matched=m.group(0), span=(m.start(), m.end())))

    for m in _CARD_RE.finditer(text):
        raw = m.group(0)
        digits = "".join(c for c in raw if c.isdigit())
        # Luhn + IIN(카드사 prefix) 둘 다 통과해야 카드. (timestamp/ID 오탐 차단)
        if _luhn_valid(digits) and _card_iin_valid(digits):
            hits.append(PIIHit(kind="credit_card", matched=raw, span=(m.start(), m.end())))

    for m in _ACCOUNT_RE.finditer(text):
        hits.append(PIIHit(
            kind="bank_account_with_label",
            matched=m.group(1),
            span=(m.start(1), m.end(1)),
        ))

    hits.sort(key=lambda h: h.span[0])
    return hits


def mask_pii(value: str, kind: str) -> str:
    if kind == "kr_rrn":
        return value[:8] + "******"
    if kind == "kr_phone":
        digits = "".join(c for c in value if c.isdigit())
        if len(digits) < 8:
            return "***"
        return f"{digits[:3]}-****-{digits[-4:]}"
    if kind == "email":
        local, _, domain = value.partition("@")
        return (local[:2] + "***@" + domain) if local else value
    if kind == "credit_card":
        digits = "".join(c for c in value if c.isdigit())
        return digits[:6] + "*" * (len(digits) - 10) + digits[-4:]
    if kind == "bank_account_with_label":
        return value[:3] + "-****-" + value[-4:]
    if kind == "person_name_with_label":
        stripped = value.strip()
        if not stripped:
            return "***"
        return stripped[:1] + "***"
    if kind == "address_with_label":
        return "<address>"
    return "***"
