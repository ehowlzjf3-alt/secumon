"""GET /api/scheduler/* — schedule run history and delivery dry-runs."""
from __future__ import annotations

from fastapi import Depends, APIRouter, HTTPException, Query

from secu_agent.web.auth import require_token
from secu_agent.web.services.scheduler import (
    get_run,
    list_runs,
    list_schedules,
)


router = APIRouter(prefix="/api/scheduler")


@router.get("/schedules")
def schedules(
    _auth: None = Depends(require_token),
    agent_type: str | None = None,
    status: str | None = None,
    limit: int = Query(100, ge=1, le=500),
) -> dict:
    try:
        return list_schedules(
            agent_type=agent_type,
            status=status,
            limit=limit,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/runs")
def runs(
    _auth: None = Depends(require_token),
    agent_type: str | None = None,
    status: str | None = None,
    limit: int = Query(50, ge=1, le=500),
) -> dict:
    try:
        return list_runs(
            agent_type=agent_type,
            status=status,
            limit=limit,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/runs/{fire_id}")
def run_detail(fire_id: int, _auth: None = Depends(require_token)) -> dict:
    row = get_run(fire_id)
    if row is None:
        raise HTTPException(404, f"scheduler run {fire_id} not found")
    return row
