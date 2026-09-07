"""GET /api/approvals — destructive-tool approval audit history."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from secu_agent.web.auth import require_token
from secu_agent.web.services.approvals import get_approval, list_approvals


router = APIRouter(prefix="/api/approvals", dependencies=[Depends(require_token)])


@router.get("")
def approvals(
    agent_type: str | None = None,
    decision: str | None = None,
    limit: int = Query(50, ge=1, le=500),
) -> dict:
    try:
        return list_approvals(
            agent_type=agent_type,
            decision=decision,
            limit=limit,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/{approval_id}")
def approval_detail(approval_id: str) -> dict:
    row = get_approval(approval_id)
    if row is None:
        raise HTTPException(404, f"approval {approval_id} not found")
    return row
