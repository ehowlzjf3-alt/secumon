"""GET /api/health — 헬스체크 (v3.82 U3b: 토큰 필수 — 무인증 수리 일괄)."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from secu_agent.web.auth import require_token
from secu_agent.web.services.health import health_snapshot

router = APIRouter()


@router.get("/api/health", dependencies=[Depends(require_token)])
def health() -> dict:
    return health_snapshot()
