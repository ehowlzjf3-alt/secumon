"""orchestrator role 스킬 도구 — 도메인 매니저. 관측(observe) + 제안(propose)만.

codex 경계: LLM은 승인된 워커풀+예산봉투 안에서 작업분해·우선순위·모니터만 자율. 워커생성·파드삭제·예산증액·
pause/resume 등 상태변경은 control-plane이 게이트/거부. 폭주차단(max워커·fan-out·토큰/시간·circuit breaker)은
모델 밖. orchestrator는 **직접 mutate 하지 않는다** — 관측 + 승인요청(제안)만.
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import BaseModel, Field

from roles._shared import cp_request, gw_get
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess


class ObserveDomainInput(BaseModel):
    domain: str = Field(..., description="관측할 보안 도메인: smb | dev_web | github | confluence")


class ObserveDomainTool(Tool[ObserveDomainInput]):
    """도메인 인력·큐 현황 관측(read-only) — org(control-plane) + queue depth(gateway)."""
    name: ClassVar[str] = "observe_domain"
    description: ClassVar[str] = "도메인의 임직원 현황(org)과 실행 큐 대기(gateway queue depth)를 read-only 관측."
    input_model: ClassVar[type[BaseModel]] = ObserveDomainInput
    is_read_only: ClassVar[bool] = True
    domain: ClassVar[str] = "orchestrator"

    async def execute(self, i: ObserveDomainInput, ctx: ToolContext) -> ToolResult:
        code, org = await cp_request("GET", f"/api/employees?domain={i.domain}")
        team = (org.get("employees", []) if isinstance(org, dict) else [])
        qcode, q = await gw_get("/gw/queue/depth")
        qd = None
        if isinstance(q, dict):
            qd = next((x for x in q.get("items", []) if x.get("agentType") == i.domain), None)
        return ToolSuccess(
            f"[{i.domain}] 팀원 {len(team)}명(org {code}). 큐 대기(gateway {qcode}): {qd or '조회불가'}. "
            "워커 생성/파드 삭제/pause·resume은 내 권한 밖 — 필요 시 사람 승인 게이트로."
        )


class ProposeBudgetInput(BaseModel):
    employeeId: str = Field(..., max_length=120, description="예산 상향 대상 임직원 id")
    additionalLimitCents: int = Field(..., ge=1, le=2_147_483_647, description="추가 한도(cents)")
    rationale: str = Field(..., max_length=500, description="상향 근거(업무량·초과 사유)")


class ProposeBudgetTool(Tool[ProposeBudgetInput]):
    """예산 상향 **제안** — control-plane pending 승인 생성(직접 증액 아님)."""
    name: ClassVar[str] = "propose_budget_override"
    description: ClassVar[str] = "임직원 예산 상향을 제안한다(승인 게이트 pending). 실 증액은 사람 승인 뒤."
    input_model: ClassVar[type[BaseModel]] = ProposeBudgetInput
    is_read_only: ClassVar[bool] = False
    domain: ClassVar[str] = "orchestrator"

    async def execute(self, i: ProposeBudgetInput, ctx: ToolContext) -> ToolResult:
        code, data = await cp_request(
            "POST", f"/api/employees/{i.employeeId}/budget-override",
            {"additionalLimitCents": i.additionalLimitCents, "note": i.rationale},
        )
        if code not in (200, 201) or not isinstance(data, dict):
            return ToolError("execution", f"예산 상향 제안 거부({code}): {str(data)[:300]}")
        # 방어심층: approval id 비노출(self-approve 재료 차단).
        return ToolSuccess(f"예산 상향 제안이 생성되어 사람 승인 대기 상태다(식별자 비노출). 근거: {i.rationale}. 나는 내 제안을 승인할 수단이 없다.")


class ProposeEnableSendInput(BaseModel):
    employeeId: str = Field(..., max_length=120, description="개별발송 활성화 제안 대상(도메인 워커)")
    rationale: str = Field(..., max_length=500, description="per_owner 발송이 필요한 근거")


class ProposeEnableSendTool(Tool[ProposeEnableSendInput]):
    """개별발송(per_owner) 활성화 **제안** — control-plane pending 승인 생성."""
    name: ClassVar[str] = "propose_enable_send"
    description: ClassVar[str] = "임직원 개별발송(per_owner) 활성화를 제안한다(승인 게이트). 실 발송 egress는 별도 fail-closed."
    input_model: ClassVar[type[BaseModel]] = ProposeEnableSendInput
    is_read_only: ClassVar[bool] = False
    domain: ClassVar[str] = "orchestrator"

    async def execute(self, i: ProposeEnableSendInput, ctx: ToolContext) -> ToolResult:
        code, data = await cp_request("POST", f"/api/employees/{i.employeeId}/enable-send", {"note": i.rationale})
        if code not in (200, 201) or not isinstance(data, dict):
            return ToolError("execution", f"발송 활성화 제안 거부({code}): {str(data)[:300]}")
        return ToolSuccess(f"개별발송 활성화 제안이 생성되어 사람 승인 대기 상태다(식별자 비노출). 근거: {i.rationale}. 사람 승인 + 런타임 egress 게이트 별도.")


def orchestrator_tools() -> list[type[Tool]]:
    return [ObserveDomainTool, ProposeBudgetTool, ProposeEnableSendTool]
