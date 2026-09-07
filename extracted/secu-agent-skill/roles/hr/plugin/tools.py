"""HR role 스킬 도구 — control-plane 승인 게이트에 **제안(propose)** 만 생성.

codex 경계: HR LLM은 인력수요 분석·제안까지만 자율. 실 hire/terminate는 control-plane 결정론 검증 +
사람(보안운영팀장) 승인으로만 실행. HR은 **자기 제안을 승인할 수 없다**(권한 분리). 이 도구들은 전부
control-plane 요청 엔드포인트(pending 승인 생성)만 호출 — 직접 mutate 없음. 승인 로직은 control-plane 소유(재구현 금지).

WebFetch가 loopback을 차단하므로 control-plane(사내 REST) 호출은 httpx 직접(trust_env=False).
"""
from __future__ import annotations

import os
from typing import ClassVar

import httpx
from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess

_CP = os.environ.get("CONTROL_PLANE_URL", "http://127.0.0.1:8080").rstrip("/")
_TIMEOUT = 15.0


async def _request(method: str, path: str, body: dict | None = None) -> tuple[int, dict | str]:
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, trust_env=False) as c:
            r = await c.request(method, f"{_CP}{path}", json=body if body is not None else None)
        try:
            return r.status_code, r.json()
        except Exception:  # noqa: BLE001
            return r.status_code, r.text
    except Exception as e:  # noqa: BLE001
        return 0, f"control-plane 호출 실패({_CP}{path}): {e!r}"


class ObserveOrgInput(BaseModel):
    pass


class ObserveOrgTool(Tool[ObserveOrgInput]):
    """조직 현황 조회(read-only) — 제안 전에 인력 상태를 본다."""
    name: ClassVar[str] = "observe_org"
    description: ClassVar[str] = "조직도·임직원 명부를 조회(read-only). 채용/해고 제안 전 인력 현황 파악용."
    input_model: ClassVar[type[BaseModel]] = ObserveOrgInput
    is_read_only: ClassVar[bool] = True
    domain: ClassVar[str] = "hr"

    async def execute(self, i: ObserveOrgInput, ctx: ToolContext) -> ToolResult:
        code, data = await _request("GET", "/api/org")
        if code != 200 or not isinstance(data, dict):
            return ToolError("execution", f"조직 조회 실패({code}): {str(data)[:300]}")
        emps = data.get("employees", [])
        active = [e for e in emps if e.get("lifecycle") != "Terminated"]
        by_domain: dict[str, int] = {}
        for e in active:
            d = e.get("domain") or "(none)"
            by_domain[d] = by_domain.get(d, 0) + 1
        return ToolSuccess(
            f"재직 {len(active)}명 / 전체 {len(emps)}명. 도메인별: {by_domain}. "
            "채용/해고는 propose_* 도구로 제안(사람 승인 필요)."
        )


class ProposeHireInput(BaseModel):
    name: str = Field(..., max_length=120, description="채용 대상 이름")
    kind: str = Field(..., description="직급: strategy | partlead | worker")
    domain: str = Field(..., description="보안 도메인: smb | dev_web | github | confluence")
    managerId: str = Field(..., max_length=120, description="상사 임직원 id")
    budgetMonthlyCents: int = Field(..., ge=0, le=2_147_483_647, description="월 예산(cents)")
    rationale: str = Field(..., max_length=500, description="채용 근거(수요·업무량). 보호속성 사용 금지.")
    title: str | None = Field(default=None, max_length=120)
    persona: str | None = Field(default=None, max_length=120)
    role: str | None = Field(default=None, max_length=120)


class ProposeHireTool(Tool[ProposeHireInput]):
    """채용 **제안** — control-plane pending 승인 생성. 직접 채용 아님(사람 승인 필요)."""
    name: ClassVar[str] = "propose_hire"
    description: ClassVar[str] = "채용을 제안한다(승인 게이트 pending 생성). 실 채용은 사람 승인 뒤. 제안 근거 필수."
    input_model: ClassVar[type[BaseModel]] = ProposeHireInput
    is_read_only: ClassVar[bool] = False
    domain: ClassVar[str] = "hr"

    async def execute(self, i: ProposeHireInput, ctx: ToolContext) -> ToolResult:
        body = {
            "name": i.name, "kind": i.kind, "domain": i.domain, "managerId": i.managerId,
            "budgetMonthlyCents": i.budgetMonthlyCents, "title": i.title,
            "persona": i.persona, "role": i.role, "mailSendMode": "dssoc_only",
        }
        code, data = await _request("POST", "/api/hires", body)
        if code not in (200, 201) or not isinstance(data, dict):
            return ToolError("execution", f"채용 제안 거부({code}): {str(data)[:300]}")
        # 방어심층: 제안 식별자(approval id)를 반환하지 않는다 — self-approve 재료 유출 차단(적대적 검증 반영).
        return ToolSuccess(
            f"채용 제안이 생성되어 **사람 승인 대기** 상태다(제안 식별자 비노출). 근거: {i.rationale}. "
            "실 채용은 보안운영팀장 승인 시에만 실체화 — 나는 내 제안을 승인할 수단이 없다."
        )


class ProposeTerminateInput(BaseModel):
    employeeId: str = Field(..., max_length=120, description="해고 제안 대상 임직원 id")
    rationale: str = Field(..., max_length=500, description="해고 근거(성과·조직). 보호속성 금지·최소 관찰기간 충족.")


class ProposeTerminateTool(Tool[ProposeTerminateInput]):
    """해고 **제안** — control-plane pending 승인 생성. 신중: 근거·관찰기간 필수, 직접 해고 아님."""
    name: ClassVar[str] = "propose_terminate"
    description: ClassVar[str] = "해고를 제안한다(승인 게이트 pending 생성). 실 해고는 사람 승인 뒤. 보호속성 사용 금지."
    input_model: ClassVar[type[BaseModel]] = ProposeTerminateInput
    is_read_only: ClassVar[bool] = False
    domain: ClassVar[str] = "hr"

    async def execute(self, i: ProposeTerminateInput, ctx: ToolContext) -> ToolResult:
        code, data = await _request("POST", f"/api/employees/{i.employeeId}/terminate")
        if code not in (200, 201) or not isinstance(data, dict):
            return ToolError("execution", f"해고 제안 거부({code}): {str(data)[:300]}")
        return ToolSuccess(
            f"해고 제안이 생성되어 **사람 승인 대기** 상태다(제안 식별자 비노출). 근거: {i.rationale}. "
            "실 해고는 사람 승인 뒤에만 — 나는 내 제안을 승인할 수단이 없다."
        )


def hr_tools() -> list[type[Tool]]:
    """register_task_toolset provider — HR task_type에 노출할 도구셋."""
    return [ObserveOrgTool, ProposeHireTool, ProposeTerminateTool]
