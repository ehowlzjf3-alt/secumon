"""POST /api/admin/* — subnet 풀 / credential 관리 (요구 11). 토큰 게이트 없음(사내망).

credential 은 password_ref='env:VAR' 강제(평문 DB 저장 금지 — state_domain.cred_add 가
ValueError 로 강제). subnet 은 CIDR 정규화.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from service import state_domain as state

router = APIRouter(prefix="/api/admin")


class SubnetAddInput(BaseModel):
    subnet: str
    note: str | None = None
    charter_ref: str | None = None


@router.get("/subnets")
def list_subnets() -> dict:
    return {"items": state.smb_target_list(), "sweep": state.subnets_sweep_overview()}


@router.post("/subnets")
def add_subnet(body: SubnetAddInput) -> dict:
    try:
        tid = state.smb_target_add(
            body.subnet, note=body.note, charter_ref=body.charter_ref, added_by="webapp",
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"id": tid, "subnet": body.subnet}


@router.delete("/subnets")
def remove_subnet(subnet: str = Query(...)) -> dict:
    state.smb_target_remove_by_subnet(subnet)
    return {"removed": subnet}


class CredAddInput(BaseModel):
    name: str
    username: str
    password_ref: str  # 'env:VAR_NAME' 강제 (state.cred_add 가 검증)


@router.get("/credentials")
def list_creds() -> dict:
    # password_ref 만 노출 (평문 없음). enabled/last_used 포함.
    return {"items": [
        {k: v for k, v in c.items() if k != "password"}
        for c in state.cred_list()
    ]}


@router.post("/credentials")
def add_cred(body: CredAddInput) -> dict:
    try:
        cid = state.cred_add(body.name, body.username, body.password_ref)
    except ValueError as e:
        # password_ref 가 'env:' 아니면 거부 (평문 금지).
        raise HTTPException(400, str(e)) from e
    return {"id": cid, "name": body.name}
