"""POST /api/cron/* — cron on/off · 수동 실행 (요구 1·12).

제어 = control_flag 폴링(HTTP 트리거 아님): UI 가 1-row UPDATE, 러너가 tick SELECT.
러너에 인바운드 서버 강제 안 함(런타임 표면 최소). 토큰 게이트 없음(사내망 단일 서비스).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from service import state_domain as state

router = APIRouter(prefix="/api/cron")

# 컴포넌트(러너 프로세스) + 세부 노드(단계별 on/off). 노드별로 개별 끄기/실행 가능.
_COMPONENTS = {
    "collector", "task", "mail", "reverify",          # 러너 프로세스 단위
    "collector.sweep", "collector.walk", "collector.owner",  # collector 세부 노드
}


class CronControlInput(BaseModel):
    component: str
    enabled: bool | None = None
    run_now: bool | None = None
    interval_seconds: float | None = None


@router.get("/status")
def status() -> dict:
    return {c: state.control_flag_get(c) for c in sorted(_COMPONENTS)}


@router.post("/set")
def set_flag(body: CronControlInput) -> dict:
    if body.component not in _COMPONENTS:
        raise HTTPException(400, f"unknown component: {body.component}")
    return state.control_flag_set(
        body.component,
        enabled=body.enabled, run_now=body.run_now,
        interval_seconds=body.interval_seconds, updated_by="webapp",
    )


@router.post("/run-now")
def run_now(component: str) -> dict:
    if component not in _COMPONENTS:
        raise HTTPException(400, f"unknown component: {component}")
    return state.control_flag_set(component, run_now=True, updated_by="webapp")
