"""dev_web component control flags."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from domains.dev_web.application.contracts import (
    COMPONENT_DISCOVERY,
    COMPONENT_TASK,
    COMPONENT_REPORT,
    COMPONENT_REVERIFY,
)
from service import state_domain as state

router = APIRouter(prefix="/api/control")
_COMPONENTS = {
    COMPONENT_DISCOVERY,
    COMPONENT_TASK,
    COMPONENT_REPORT,
    COMPONENT_REVERIFY,
}


class ControlFlagPatch(BaseModel):
    enabled: bool | None = None
    interval_seconds: float | None = Field(default=None, ge=1)


@router.get("")
def control_flags() -> dict:
    return {component: state.control_flag_get(component) for component in sorted(_COMPONENTS)}


@router.post("/{component}")
def update_control(component: str, body: ControlFlagPatch) -> dict:
    if component not in _COMPONENTS:
        raise HTTPException(404, "unknown dev_web component")
    return state.control_flag_set(
        component,
        enabled=body.enabled,
        interval_seconds=body.interval_seconds,
        updated_by="dev_webapp",
    )


@router.post("/{component}/run-now")
def run_now(component: str) -> dict:
    if component not in _COMPONENTS:
        raise HTTPException(404, "unknown dev_web component")
    return state.control_flag_set(component, run_now=True, updated_by="dev_webapp")
