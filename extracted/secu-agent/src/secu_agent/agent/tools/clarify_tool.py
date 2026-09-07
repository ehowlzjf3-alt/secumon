"""ClarifyTool — agent 가 사용자에게 명시적 질문.

context.aborted / 모호한 user_input / 위험 결정 직전. frontend 가 이 도구 결과
에서 'QUESTION:' marker 발견하면 input UI 띄움.
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    ToolSuccess,
)


class ClarifyInput(BaseModel):
    question: str = Field(description="사용자에게 던질 질문 (한 문장 권장).")
    options: list[str] = Field(
        default_factory=list,
        description="선택지 (2-5개 권장). 비어있으면 free-text 응답.",
    )
    rationale: str = Field(default="", description="왜 묻는지 — audit.")


class ClarifyTool(Tool[ClarifyInput]):
    name: ClassVar[str] = "clarify"
    description: ClassVar[str] = (
        "사용자에게 명시 질문. 모호한 입력 / 위험 결정 직전에 사용. "
        "frontend 가 'QUESTION:' marker 잡아 input UI 띄움."
    )
    input_model: ClassVar[type[BaseModel]] = ClarifyInput
    is_destructive: ClassVar[bool] = False
    is_read_only: ClassVar[bool] = True
    domain: ClassVar[str] = "core"
    prompt_section: ClassVar[str] = (
        "**clarify** — 사용자 입력 모호 / 분기 결정 막힘 시 사용. 추측 X. "
        "선택지 (2-5개) 같이 주면 사용자 응답 빨라짐."
    )

    async def execute(self, payload: ClarifyInput, context: ToolContext) -> ToolResult:
        q = payload.question.strip()
        if not q:
            return ToolError(kind="validation", message="question 비어있음")

        context.metadata["pending_clarification"] = {
            "question": q,
            "options": list(payload.options),
            "rationale": payload.rationale,
        }

        lines = ["QUESTION: " + q]
        if payload.options:
            lines.append("OPTIONS:")
            for i, opt in enumerate(payload.options, 1):
                lines.append(f"  {i}. {opt}")
        if payload.rationale:
            lines.append(f"RATIONALE: {payload.rationale}")
        return ToolSuccess(content="\n".join(lines))
