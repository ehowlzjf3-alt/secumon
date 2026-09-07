"""GET /api/domain-reports/* — domain finding report projections."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from secu_agent.web.auth import check_token

from service.services.domain_reports import (
    get_domain_report,
    list_domain_reports,
)


router = APIRouter(prefix="/api/domain-reports")


def _require_token(token: str) -> None:
    if not check_token(token):
        raise HTTPException(status_code=401, detail="invalid token")


@router.get("")
def domain_reports(
    token: str = Query(""),
    limit: int = Query(100, ge=1, le=500),
) -> dict:
    _require_token(token)
    return list_domain_reports(limit=limit)


@router.get("/{domain_key}")
def domain_report_detail(
    domain_key: str,
    token: str = Query(""),
    limit: int = Query(100, ge=1, le=500),
) -> dict:
    _require_token(token)
    try:
        return get_domain_report(domain_key, limit=limit)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
