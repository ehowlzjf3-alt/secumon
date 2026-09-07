"""RRN 탐지기 회귀 — 날짜 실재성 검증 + 소수점 과매칭 차단 (v3.90).

두 결정론 버그:
  ① _rrn_valid 가 checksum 만 봐서 38년 11월 87일 같은 불가능 날짜가 통과.
  ② _RRN_RE 의 \\b 가 소수점 뒤를 매칭 → 계측 소수값 소수부를 RRN 으로 오인.
"""
from secu_agent.detectors.pii import _rrn_valid, find_pii


def _with_check(first12: str) -> str:
    """앞 12자리에 유효 checksum 자리를 붙여 checksum-valid RRN 생성."""
    weights = (2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5)
    s = sum(int(first12[i]) * weights[i] for i in range(12))
    return first12 + str((11 - (s % 11)) % 10)


def _rrns(text: str) -> list[str]:
    return [h.matched for h in find_pii(text) if h.kind == "kr_rrn"]


# ── Fix ①: 날짜 실재성 ────────────────────────────────────────────────
def test_valid_date_and_checksum_detected():
    rrn = _with_check("900101" + "1" + "23456")  # 1990-01-01, 남 → 유효
    assert _rrn_valid(rrn) is True
    assert _rrns(f"주민번호 {rrn} 유출") == [rrn]


def test_impossible_date_rejected_even_if_checksum_ok():
    bad = _with_check("381187" + "1" + "23456")  # 38년 11월 87일 — 날짜 불가
    # checksum 은 통과(구 코드는 여기서 True 반환했음) — 이제 날짜에서 걸림.
    assert _rrn_valid(bad) is False
    assert _rrns(f"값 {bad} 관측") == []


def test_month_and_day_out_of_range_rejected():
    assert _rrn_valid(_with_check("991301" + "1" + "23456")) is False  # 13월
    assert _rrn_valid(_with_check("990132" + "1" + "23456")) is False  # 32일
    assert _rrn_valid(_with_check("990100" + "1" + "23456")) is False  # 0일


def test_feb29_century_resolved_by_gender_code():
    # 2000-02-29 (윤년) → 성별코드 3(2000년대) 이면 유효
    assert _rrn_valid(_with_check("000229" + "3" + "34567")) is True
    # 1900-02-29 (1900 은 비윤년) → 성별코드 1(1900년대) 이면 무효
    assert _rrn_valid(_with_check("000229" + "1" + "34567")) is False


# ── Fix ②: 소수점/긴 숫자 과매칭 ─────────────────────────────────────
def test_decimal_fraction_not_matched_as_rrn():
    rrn = _with_check("900101" + "1" + "23456")  # 그 자체론 유효 RRN
    # 계측 소수값의 소수부로 등장하면 RRN 이 아니다 (앞이 '.')
    assert _rrns(f"BCAT_Fin_Btm_Width=18.{rrn} nm") == []


def test_embedded_in_longer_integer_not_matched():
    rrn = _with_check("900101" + "1" + "23456")
    assert _rrns(f"id=7{rrn}") == []          # 앞이 숫자
    assert _rrns(f"seq={rrn}0 done") == []     # 뒤가 숫자


def test_standalone_and_hyphenated_still_detected():
    rrn = _with_check("900101" + "1" + "23456")  # 9001011234568
    hyph = rrn[:6] + "-" + rrn[6:]
    assert _rrns(f"주민 {rrn} 확인") == [rrn]
    assert _rrns(f"주민 {hyph} 확인") == [hyph]
