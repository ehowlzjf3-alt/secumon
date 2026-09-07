"""DeepModeTool — v3.72 하이브리드 reasoning 승급.

자율 점검 base reasoning 은 medium(throughput 우선). 에이전트가 '이 타깃은 깊이
봐야 한다'고 판단하면 deep_mode 를 호출 → 다음 N pass 를 xhigh 정밀추론으로 승급
(engine 이 metadata 카운터를 매 콜 소진). finding_followup 안전망도 HIGH severity
신호에서 같은 카운터를 세팅하므로, 에이전트가 깜빡해도 진짜 위험 신호는 자동 승급된다.

카운터 holder = `ToolContext.metadata['deep_passes_remaining']` (ClarifyTool 패턴과 동일).
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolResult,
    ToolSuccess,
)

_MAX_PASSES = 8


class DeepModeInput(BaseModel):
    reason: str = Field(description="왜 깊이 분석이 필요한지 — 한 문장 (audit).")
    passes: int = Field(
        default=3,
        ge=1,
        le=_MAX_PASSES,
        description=f"xhigh 정밀추론으로 돌릴 다음 pass 수 (1-{_MAX_PASSES}, 기본 3).",
    )


class DeepModeTool(Tool[DeepModeInput]):
    name: ClassVar[str] = "deep_mode"
    description: ClassVar[str] = (
        "다음 N pass 를 xhigh 정밀추론으로 승급. 의심 타깃 정밀 분석/판정 직전에만 사용. "
        "평소 triage 는 빠른 모드(medium) — 시크릿/취약/인증우회 후보가 보이거나 흩어진 "
        "단서를 엮어 판단해야 할 때 호출."
    )
    input_model: ClassVar[type[BaseModel]] = DeepModeInput
    is_read_only: ClassVar[bool] = True
    is_destructive: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    prompt_section: ClassVar[str] = (
        "**deep_mode** — 시크릿/취약/인증우회 후보 정밀분석·확정 직전 호출 → 다음 N pass "
        "xhigh. 평소 triage 는 빠른 medium. 남발 금지."
    )

    async def execute(self, payload: DeepModeInput, context: ToolContext) -> ToolResult:
        n = max(1, min(int(payload.passes), _MAX_PASSES))
        try:
            prev = int(context.metadata.get("deep_passes_remaining", 0) or 0)
        except (TypeError, ValueError):
            prev = 0
        context.metadata["deep_passes_remaining"] = max(prev, n)
        reason = payload.reason.strip() or "(no reason given)"
        return ToolSuccess(content=(
            f"deep mode ON — 다음 {n} pass 를 xhigh 정밀추론으로 분석합니다. "
            f"reason: {reason}"
        ))
