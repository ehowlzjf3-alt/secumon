"""strategy role 스킬 도구 — 타깃 열거·수집 전략. 관측(observe) + 권고(recommend)만.

codex 경계: LLM은 승인된 타깃 인벤토리 안에서 우선순위·타이밍만 자율. claim=share/host·read-only·egress는
매 tool-call 결정론 검증(엔진 §6). 신규 타깃 발견은 **제안만**, scope 편입·실 스캔은 별도 승인. strategy는
digisecu에 mutate 표면이 없다(collector 실행=엔진 소관) → 관측 + 우선순위 권고(advisory) 출력만 한다.
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import BaseModel, Field

from roles._shared import gw_get
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess


class ObserveQueueInput(BaseModel):
    pass


class ObserveQueueTool(Tool[ObserveQueueInput]):
    """전 도메인 수집·실행 큐 대기 관측(gateway read-only)."""
    name: ClassVar[str] = "observe_queue"
    description: ClassVar[str] = "gateway에서 도메인별 큐 대기(수집·점검·리포트·재검증)를 read-only 관측. 전략 근거."
    input_model: ClassVar[type[BaseModel]] = ObserveQueueInput
    is_read_only: ClassVar[bool] = True
    domain: ClassVar[str] = "strategy"

    async def execute(self, i: ObserveQueueInput, ctx: ToolContext) -> ToolResult:
        code, q = await gw_get("/gw/queue/depth")
        if code != 200 or not isinstance(q, dict):
            return ToolError("execution", f"큐 관측 실패({code}): {str(q)[:300]}")
        items = q.get("items", [])
        lines = [
            f"{x.get('agentType')}: 수집대기={x.get('strategy')} 점검={x.get('task')} 리포트={x.get('report')} 재검증={x.get('verify')}"
            for x in items
        ]
        return ToolSuccess("도메인별 큐 대기(gateway):\n" + "\n".join(lines) + "\n실 수집 실행은 엔진 collector 소관 — 나는 우선순위를 권고만 한다.")


class RecommendScanPriorityInput(BaseModel):
    domain: str = Field(..., description="우선순위를 권고할 도메인: smb | dev_web | github | confluence")
    priority: str = Field(..., description="권고 우선순위: high | normal | low")
    rationale: str = Field(..., max_length=500, description="근거(큐 대기·업무량). 승인된 인벤토리 내에서만.")
    proposed_new_targets: str | None = Field(default=None, max_length=500, description="신규 타깃 제안(있으면). scope 편입·실 스캔은 별도 승인 대상.")


class RecommendScanPriorityTool(Tool[RecommendScanPriorityInput]):
    """수집 우선순위 **권고**(advisory) — 직접 스캔/편입 없음. 신규 타깃은 제안만."""
    name: ClassVar[str] = "recommend_scan_priority"
    description: ClassVar[str] = "도메인 수집 우선순위를 권고한다(advisory). 실 스캔·신규타깃 scope 편입은 별도 승인. 직접 실행 없음."
    input_model: ClassVar[type[BaseModel]] = RecommendScanPriorityInput
    is_read_only: ClassVar[bool] = True
    domain: ClassVar[str] = "strategy"

    async def execute(self, i: RecommendScanPriorityInput, ctx: ToolContext) -> ToolResult:
        note = f" · 신규타깃 제안(별도 승인 필요): {i.proposed_new_targets}" if i.proposed_new_targets else ""
        return ToolSuccess(
            f"[권고] {i.domain} 수집 우선순위={i.priority}. 근거: {i.rationale}.{note} "
            "이는 권고일 뿐 — 실 수집/스캔은 엔진 collector가 §6(read-only·claim=share/host)를 강제하며, "
            "신규 타깃 scope 편입은 사람 승인 뒤에만."
        )


def strategy_tools() -> list[type[Tool]]:
    return [ObserveQueueTool, RecommendScanPriorityTool]
