"""GET /api/pipeline/* — 6단계 종합 대시보드 (요구 12)."""
from __future__ import annotations

from fastapi import APIRouter, Query

from domains.smb.webapp.pipeline_view import pipeline_overview

router = APIRouter(prefix="/api/pipeline")


@router.get("/overview")
def overview(live: int = Query(0)) -> dict:
    return pipeline_overview(live=bool(live))
