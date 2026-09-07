"""GET /api/domains/* — domain overview for autonomous agents."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from secu_agent.web.auth import check_token

from service.services.domains import domain_overview


router = APIRouter(prefix="/api/domains")


@router.get("/overview")
def overview(token: str = Query("")) -> dict:
    if not check_token(token):
        raise HTTPException(status_code=401, detail="invalid token")
    return domain_overview()
