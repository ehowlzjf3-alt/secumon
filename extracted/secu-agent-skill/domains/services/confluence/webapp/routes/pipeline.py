"""GET /api/pipeline/* — Confluence E2E pipeline dashboard."""
from __future__ import annotations

from fastapi import APIRouter, Query

from domains.services.confluence.webapp.pipeline_view import pipeline_overview

router = APIRouter(prefix="/api/pipeline")


@router.get("/overview")
def overview(live: int = Query(0)) -> dict:
    return pipeline_overview(live=bool(live))
