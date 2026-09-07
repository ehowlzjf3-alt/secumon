"""GET/PATCH /api/findings — generic finding lifecycle view/update.

v3.82 U3b: 도메인 표면 분리 — /aggregate(4도메인 병합 projection)와
owner-mail 3종(SMB·Knox)은 도메인 서비스(secu-agent-skill service/)로 이관.
코어는 finding_lifecycle 테이블의 generic CRUD 만 소유한다 (코어 = generic
finding 생산자, 결정 ④). 전 라우트 토큰 필수 (구 GET/PATCH /{id} 무인증 수리).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from secu_agent.web.auth import require_token
from secu_agent.web.services.findings import (
    get_finding,
    list_findings,
    update_finding,
)

router = APIRouter(prefix="/api/findings", dependencies=[Depends(require_token)])


class FindingUpdateRequest(BaseModel):
    status: str | None = Field(default=None)
    owner: str | None = Field(default=None, max_length=200)
    ticket_ref: str | None = Field(default=None, max_length=200)
    sla_due: float | None = Field(default=None, ge=0)
    summary: str | None = Field(default=None, max_length=2000)


@router.get("")
def findings(
    status: str | None = None,
    task_type: str | None = None,
    limit: int = Query(50, ge=1, le=500),
) -> dict:
    return list_findings(status=status, task_type=task_type, limit=limit)


@router.get("/{finding_id}")
def finding_detail(finding_id: int) -> dict:
    row = get_finding(finding_id)
    if row is None:
        raise HTTPException(404, f"finding {finding_id} not found")
    return row


@router.patch("/{finding_id}")
def finding_update(finding_id: int, req: FindingUpdateRequest) -> dict:
    try:
        row = update_finding(
            finding_id,
            status=req.status,
            owner=req.owner,
            ticket_ref=req.ticket_ref,
            sla_due=req.sla_due,
            summary=req.summary,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if row is None:
        raise HTTPException(404, f"finding {finding_id} not found")
    return row
