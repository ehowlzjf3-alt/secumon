"""triage_candidates — 후보 기각을 사유와 함께 감사가능하게 기록.

candidate ledger 침묵 게이트의 합법적 출구: 후보를 deep-dive 한 뒤 finding 이
아니라고 판단했으면, 조용히 버리는 대신 여기로 후보별 사유를 남긴다.
evidence_dir/candidate_triage.jsonl 에 append (F3: 영속 표현은 마스킹).
"""
from __future__ import annotations

import json
import unicodedata
from typing import ClassVar

from pydantic import BaseModel, Field, field_validator

from secu_agent.agent.candidate_ledger import (
    candidate_ledger_stats,
    record_candidates_accounted,
)
from secu_agent.agent.tools._arg_coercion import _coerce_json_container
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess
from secu_agent.detectors.text_scan import mask_scanned_text

TRIAGE_FILENAME = "candidate_triage.jsonl"

_MAX_DISPOSITIONS = 100
_MIN_REASON_CHARS = 12


def _visible(text: str) -> str:
    """가시 base 문자만 남긴다 — 공백(Z*)·제어/포맷(C*)·결합표시(M*) 제거.

    str.strip()은 U+200B(zero-width space)·U+FEFF(BOM) 같은 Cf 를 못 지운다
    (codex 2R #5). 또 U+034F(CGJ)·U+FE00(변이선택자) 같은 결합표시(Mn)도 비가시라
    이것만으로 채운 가짜 disposition 이 통과할 수 있다(codex 4R #2). 정상 텍스트는
    항상 base 문자(L*/N*/So 등)를 갖고 결합표시는 그 위에 얹히므로, base 문자
    존재 여부로 '실제 보이는 내용'을 판정한다(이모지 base=So 는 보존).
    """
    return "".join(
        ch for ch in str(text or "")
        if unicodedata.category(ch)[0] not in ("Z", "C", "M")
    )


_MASK_MAX_PASSES = 6


def _mask_triage(text: str) -> str:
    """영속 표현 마스킹 — 고엔트로피 토큰(세션 토큰/키)까지, **안정될 때까지 반복**.

    codex #13: 기본 mask_scanned_text(include_entropy=False)는 키워드 없는 랜덤
    토큰을 놓친다 → include_entropy=True.
    codex 2R #1(치명): 엔트로피 스캐너는 스캔당 최대 4 hit(_ENTROPY_HIT_LIMIT_PER_
    SCAN, 공유 상수)만 마스킹 → free-text reason 에 서로 다른 토큰 5개+면 평문
    영속. 공유 상수를 건드리지 않고, 마스킹된 토큰은 저엔트로피가 되어 다음 패스가
    그 다음 4개를 잡는 성질을 이용해 fixpoint 까지 반복(상한 6).

    경계(codex 3R #1): **동일** 고엔트로피 토큰이 여러 번 반복되면 detector 가
    span 을 중복제거해 패스당 1개만 마스킹 → 반복해도 안 줄 수 있다. 또 저엔트로피
    구조적 secret(짧은 base64·PEM 본문)도 경계 밖 — 이는 F3 전 영속 sink(예:
    submit_finding 의 masked summary)와 **동일한** best-effort 마스킹 경계다.
    triage 가 더 안전하다고 주장하지 않는다. reason 은 값이 아니라 사유이고(도구
    설명이 강제), 산출물은 evidence_dir 0700 로컬(비-egress)이다.
    """
    prev = str(text or "")
    for _ in range(_MASK_MAX_PASSES):
        masked = mask_scanned_text(prev, include_entropy=True)
        if masked == prev:
            return masked
        prev = masked
    return prev


class TriageDisposition(BaseModel):
    location: str = Field(
        ..., min_length=1, max_length=500,
        description="후보 위치 (URL/파일경로/문서 식별자) — 값이 아니라 위치",
    )
    reason: str = Field(
        ..., min_length=_MIN_REASON_CHARS, max_length=500,
        description="deep-dive 에서 관찰한 구체적 기각 사유 (한 줄, 후보별로 다르게)",
    )

    @field_validator("location", "reason")
    @classmethod
    def _reject_blank(cls, v: str) -> str:
        # codex #2: 공백-only 로 min_length 통과시켜 가짜 triage 로 게이트 무력화 차단.
        if not _visible(v):
            raise ValueError("보이는 내용이 없음 — 실제 위치/사유를 적어라")
        return v

    @field_validator("reason")
    @classmethod
    def _reason_meaningful(cls, v: str) -> str:
        # codex 2R #5: strip()이 못 지우는 zero-width/format 문자(U+200B 등)로
        # 보이지 않는 가짜 사유를 만드는 것 차단 — 가시 문자 길이로 판정.
        if len(_visible(v)) < _MIN_REASON_CHARS:
            raise ValueError(
                f"사유는 보이는 문자 최소 {_MIN_REASON_CHARS}자 — deep-dive 관찰을 적어라"
            )
        return v


class TriageCandidatesInput(BaseModel):
    dispositions: list[TriageDisposition] = Field(
        ..., min_length=1, max_length=_MAX_DISPOSITIONS,
        description="후보별 기각 기록 목록",
    )
    note: str | None = Field(
        None, max_length=500, description="배치 공통 맥락 (선택)",
    )

    # gauss/gpt-oss 가 list-of-objects 인자를 JSON 문자열로 직렬화하는 패턴 보정
    # (submit_finding CORE-ASK 와 동일 — 침묵 게이트가 이 도구 호출을 지시하므로
    # 여기가 막히면 게이트의 합법 출구가 같은 벽에 부딪힌다). 파싱 실패/평문은
    # 원문 보존 → 검증은 pydantic.
    _coerce_dispositions = field_validator("dispositions", mode="before")(
        staticmethod(_coerce_json_container)
    )


class TriageCandidatesTool(Tool[TriageCandidatesInput]):
    name: ClassVar[str] = "triage_candidates"
    domain: ClassVar[str] = "core"
    description: ClassVar[str] = (
        "finding 이 아니라고 판단한 후보를 **후보별 사유와 함께** 기각 기록한다.\n"
        "**반드시 deep-dive 후에만**: 원문을 읽거나 endpoint 를 열어 실제로 확인한 "
        "관찰을 사유에 적어라 (예: 'password 필드가 빈 템플릿', '로그인 요구 — 데이터 "
        "미노출', 'OSS LICENSE 의 연락처 이메일'). 확인 없이 일괄 기각은 정책 위반이며 "
        "기록은 전부 감사 대상이다.\n"
        "실제 노출이 확인된 후보는 여기가 아니라 submit_finding 으로 제출한다. "
        "애매하면 기각하지 말고 submit_finding(suspected) 으로 올려라.\n"
        "location = 후보 위치(URL/경로/식별자), 민감값 자체를 넣지 마라."
    )
    input_model: ClassVar[type[BaseModel]] = TriageCandidatesInput
    search_hint: ClassVar[str] = "triage dismiss candidate false-positive reason ledger"
    is_read_only: ClassVar[bool] = False

    async def execute(
        self, validated_input: TriageCandidatesInput, context: ToolContext,
    ) -> ToolResult:
        # F3: 영속 표현 마스킹 — 모델이 location/reason 에 평문 민감값을 넣어도
        # jsonl 에는 남지 않게 한다 (submit_finding 의 mask_deep 경계와 동일 원칙).
        records = [
            {
                "location": _mask_triage(d.location),
                "reason": _mask_triage(d.reason),
            }
            for d in validated_input.dispositions
        ]
        note = (
            _mask_triage(validated_input.note)
            if validated_input.note else None
        )
        out_path = context.evidence_dir / TRIAGE_FILENAME
        try:
            with out_path.open("a", encoding="utf-8") as fh:
                for rec in records:
                    if note:
                        rec = {**rec, "note": note}
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError as e:
            return ToolError(kind="io_error", message=str(e))
        record_candidates_accounted(
            context.metadata, bucket="triaged", count=len(records),
        )
        seen, submitted, triaged = candidate_ledger_stats(context.metadata)
        return ToolSuccess(
            content=(
                f"{len(records)} candidate(s) triaged → {TRIAGE_FILENAME}. "
                f"ledger: seen={seen}, submitted={submitted}, triaged={triaged}."
            ),
        )
