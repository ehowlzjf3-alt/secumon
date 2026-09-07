"""PII 정오탐(true/false-positive) 증거 게이트 — category 축 등록형.

배경: 코어 `judge_task_finding` 의 PII 기본 계약은 "preview 가 비어있지 않거나
masked 가 플레이스홀더가 아니면 confirmed" 수준이라, 탐지기(예: pii.kr_rrn)가
뱉은 **구조적 오탐**을 걸러내지 못한다. 실제 사고:

  hit.kind=kr_rrn, masked="38118732******",
  preview="...,MTS,X,18.38118732******,nm,18.4,5.8,21.3,..." (반도체 계측 CSV)

  → 부동소수 `18.38118732` 의 소수부가 RRN 으로 오탐. 코어 검사기는 체크섬만
    보고(_rrn_valid), preview 가 비어있지 않으니 confirmed 0.9 로 영속됐다.

이 판정기는 코어 `register_category_evidence_judge("pii", ...)` 로 등록되어
**모든 task_type(smb/dev_web/github/confluence)** 의 PII hit 을 코어 하드코딩
계약보다 **먼저** 소비한다(evidence_judgment.judge_task_finding 디스패치 순서).

정책(약화 금지 — 오탐만 거부, 진짜 PII 는 손대지 않음):
  R1 소수부(decimal-fraction) 거부 — 숫자 식별자가 `<digit>.` 바로 뒤에 붙은
     부동소수 소수부면 절대 RRN/카드/계좌가 아니다 → rejected.
  R2 RRN 날짜 유효성 — kr_rrn 마스킹 앞 6자리 YYMMDD 가 유효한 월/일이
     아니면(예: 11월 87일) 실 RRN 이 아니다 → rejected.
  R3 계측/공정 맥락 힌트 — preview 에 계측 단위(nm/µm/mV…)·수치 테이블이
     보이면 rejected 사유+required_actions 에 "semiconductor_process 로
     재분류" 를 지시(공정정보 미탐 교정).

  위 R1/R2 어디에도 안 걸리는 정상형 PII → None(코어 계약 폴백, 동작 불변).

import 부수효과 없음 — bootstrap 이 register_category_evidence_judge 로 등록,
테스트는 직접 import 해 등록/해제한다.
"""
from __future__ import annotations

import re

from secu_agent.agent.evidence_judgment import EvidenceJudgment, _rejected

# 숫자 식별자 kind — R1(소수부) 거부 대상. formatted(전화 010-…) 은 소수부로
# 붙을 일이 없으니 자연히 제외된다(선행 마스킹 문자가 숫자가 아님).
_NUMERIC_ID_KINDS = frozenset({
    "kr_rrn", "credit_card", "bank_account_with_label", "kr_phone",
})

# 계측/공정 단위·컬럼 시그널 — 수치 데이터가 PII 가 아니라 공정정보임을 시사.
_MEASUREMENT_UNIT_RE = re.compile(
    r"(?i)(?<![a-z])("
    r"nm|µm|um|μm|mm|Å|angstrom|"          # 길이/두께(반도체 계측 핵심)
    r"mv|mV|ma|mA|kv|kV|"                    # 전기
    r"sccm|mbar|torr|pa|kpa|"               # 압력/유량
    r"ohm|Ω|Ω|"                             # 저항
    r"cd|critical\s*dimension|thickness|width|depth|overlay|cd_"  # 계측 항목
    r")(?![a-z])"
)
# 콤마/탭 구분 수치 테이블(CSV 계측 로우) — 부동소수 3개 이상 나열.
_NUMERIC_TABLE_RE = re.compile(r"(?:[-+]?\d+\.\d+[,\t;][ \t]*){2,}[-+]?\d")

_DAYS_IN_MONTH = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def _leading_digits(masked: str) -> str:
    """마스킹 문자열의 선행 연속 숫자열(예: '38118732******' → '38118732')."""
    out = []
    for ch in masked.strip():
        if ch.isdigit():
            out.append(ch)
        else:
            break
    return "".join(out)


def _valid_kr_date_prefix(digits6: str) -> bool:
    """YYMMDD 6자리의 월/일 유효성(연/윤년 무시 — 2월 29 허용)."""
    if len(digits6) < 6 or not digits6[:6].isdigit():
        return True  # 판단 불가 → 이 규칙으로는 거부하지 않음(보수적)
    mm = int(digits6[2:4])
    dd = int(digits6[4:6])
    if not (1 <= mm <= 12):
        return False
    return 1 <= dd <= _DAYS_IN_MONTH[mm - 1]


def _is_decimal_fraction_context(digits: str, preview: str) -> bool:
    """preview 에서 digits 가 `<숫자>.` 바로 뒤에 붙어 나오면(=부동소수 소수부) True.

    예: preview="...,18.38118732******,..." · digits="38118732" →
        digits 앞이 '.' 이고 그 앞이 숫자 '8' → 소수부.
    """
    if len(digits) < 4:
        return False
    idx = 0
    while True:
        idx = preview.find(digits, idx)
        if idx < 0:
            return False
        if idx >= 2 and preview[idx - 1] == "." and preview[idx - 2].isdigit():
            return True
        idx += 1


def _has_measurement_context(preview: str) -> bool:
    return bool(_MEASUREMENT_UNIT_RE.search(preview) or _NUMERIC_TABLE_RE.search(preview))


_RECLASS_ACTION = (
    "이 값이 계측/공정 수치(nm·µm 등 단위, 웨이퍼/lot/recipe/CD 컬럼)라면 PII 가 "
    "아니라 semiconductor_process(공정 정보)다 — category 를 semiconductor_process 로 "
    "바꿔 재제출하고, 단순 수치 노이즈면 hit 를 빼라."
)


def judge_pii_hit(finding, hit) -> EvidenceJudgment | None:
    """PII hit 정오탐. None = 정상형 → 코어 PII 계약 폴백.

    구조적 오탐(부동소수 소수부·무효 날짜 RRN)만 거부한다. 진짜 RRN/카드/계좌/
    전화는 손대지 않아 기존 강도를 유지한다(약화 금지).
    """
    category = str(getattr(hit, "category", "") or "")
    if category != "pii":
        return None
    kind = str(getattr(hit, "kind", "") or "").strip().lower()
    masked = str(getattr(hit, "masked", "") or "")
    preview = str(getattr(hit, "preview", "") or "")

    digits = _leading_digits(masked)

    # R1: 부동소수 소수부로 매칭된 숫자 식별자 — 절대 실 PII 아님.
    if kind in _NUMERIC_ID_KINDS and digits and _is_decimal_fraction_context(digits, preview):
        reclass = f" {_RECLASS_ACTION}" if _has_measurement_context(preview) else ""
        return _rejected(
            f"pii hit '{kind}' 는 부동소수의 소수부(preview 상 '<숫자>.{digits}...')로 "
            "매칭된 오탐이다 — 주민번호/카드/계좌는 소수점 뒤 숫자열이 될 수 없다."
            + reclass,
            "소수부/수치 노이즈 매칭이므로 이 PII hit 를 제거하고, 계측·공정 "
            "데이터면 semiconductor_process 로 재분류해 재제출",
        )

    # R2: kr_rrn 날짜(YYMMDD) 무효 — 체크섬만 우연히 맞은 비-RRN.
    if kind == "kr_rrn" and len(digits) >= 6 and not _valid_kr_date_prefix(digits):
        reclass = f" {_RECLASS_ACTION}" if _has_measurement_context(preview) else ""
        return _rejected(
            f"pii hit 'kr_rrn' 의 앞 6자리 '{digits[:6]}' 가 유효한 생년월일(YYMMDD)이 "
            "아니다(월 01-12·일 01-말일 위반) — 체크섬만 우연히 통과한 오탐이다."
            + reclass,
            "유효 날짜가 아니므로 이 RRN hit 를 제거하고, 계측·공정 수치면 "
            "semiconductor_process 로 재분류해 재제출",
        )

    return None
