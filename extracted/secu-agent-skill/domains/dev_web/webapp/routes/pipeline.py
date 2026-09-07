"""GET /api/pipeline/* — dev_web E2E dashboard data."""
from __future__ import annotations

from fastapi import APIRouter, Query

from domains.dev_web.webapp.pipeline_view import pipeline_overview

router = APIRouter(prefix="/api/pipeline")


@router.get("/overview")
def overview(live: int = Query(0)) -> dict:
    return pipeline_overview(live=bool(live))
