"""v3.76: enrich_finding — 기존 finding 에 4부 위험내용/증거해설/pivot 해석을 채워넣는 전용 도구.

finding_narrator subagent(및 operator)가 백필에 사용. resubmit_finding 과 달리:
- pivot/evidence-gate 를 **재실행하지 않는다** (record-only / GET-only 보존)
- 제공된 narrative 키만 partial 하게 merge_extra=True 로 적재
- 평문 시크릿/PII 값을 넣지 마라 — '유형/분류' 로만 (스키마 description + skill 룰로 강제)
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent import state
from secu_agent.agent.schema.finding import EvidenceNote, RiskNarrative
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


class EnrichFindingInput(BaseModel):
    finding_id: int = Field(..., ge=1, description="채워넣을 기존 finding 의 id")
    risk_narrative: RiskNarrative | None = Field(
        None,
        description=(
            "4부 위험내용(데이터 정체/발견 방법/악용 경로·왜 위험/확인 방법). 한국어. "
            "값 아닌 유형만 — 평문 시크릿/PII 금지, 마스킹 유지. 못 채우는 부분은 비워둠."
        ),
    )
    evidence_notes: dict[str, EvidenceNote] | None = Field(
        None,
        description=(
            "증거 location → 해설(what_this_is/sensitive_fields[필드명만]/context_note). "
            "sensitive_fields 는 필드명/유형만 — 실제 값 금지."
        ),
    )
    pivot_interpretation: str | None = Field(
        None,
        description="pivot probe 결과 해석 — 도달 확인된 표면이 무엇을 의미/허용하는지(유형/행위만).",
    )


class EnrichFindingTool(Tool[EnrichFindingInput]):
    name: ClassVar[str] = "enrich_finding"
    domain: ClassVar[str] = "core"
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = False
    input_model: ClassVar[type[BaseModel]] = EnrichFindingInput
    search_hint: ClassVar[str] = (
        "enrich finding risk narrative backfill evidence notes pivot interpretation 위험내용"
    )
    description: ClassVar[str] = (
        "기존 finding 1건에 4부 위험내용(risk_narrative)/증거해설(evidence_notes)/"
        "pivot 해석(pivot_interpretation)을 채워넣는다. resubmit 이 아니라 narrative 백필 전용 — "
        "pivot/gate 를 재실행하지 않고 제공한 키만 merge 한다. **마스킹 필수**: 평문 시크릿/"
        "PII/비밀번호 값을 적지 말고 '유형/분류'(데이터 종류·필드명)로만 서술. 못 만드는 항목은 "
        "비워둔다(가짜 템플릿 금지)."
    )

    async def execute(
        self, validated_input: EnrichFindingInput, context: ToolContext,
    ) -> ToolResult:
        del context
        vi = validated_input
        existing = state.finding_get(vi.finding_id)
        if existing is None:
            return ToolError(
                kind="not_found",
                message=f"finding {vi.finding_id} not found",
            )
        # 제공된 키만 partial extra (None 은 생략 — 기존 값 보존).
        patch: dict[str, object] = {}
        applied: list[str] = []
        if vi.risk_narrative is not None:
            patch["risk_narrative"] = vi.risk_narrative.model_dump(mode="json")
            applied.append("risk_narrative")
        if vi.evidence_notes is not None:
            patch["evidence_notes"] = {
                loc: note.model_dump(mode="json")
                for loc, note in vi.evidence_notes.items()
            }
            applied.append("evidence_notes")
        if vi.pivot_interpretation is not None:
            patch["pivot_interpretation"] = vi.pivot_interpretation
            applied.append("pivot_interpretation")
        if not patch:
            return ToolSuccess(
                content=f"finding {vi.finding_id}: no narrative fields provided — nothing to update",
            )
        try:
            state.finding_update(vi.finding_id, extra=patch, merge_extra=True)
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="io_error", message=f"finding enrich failed: {e}")
        return ToolSuccess(
            content=f"finding {vi.finding_id} enriched: {', '.join(applied)}",
        )
