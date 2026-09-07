"""GET /api/smb/* — SMB 에이전트 view 엔드포인트."""
from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, Field
from fastapi import APIRouter, HTTPException, Query

from service import state_domain as state
from service.services.dashboard import smb_dashboard
from service.services.files import (
    get_file_detail, list_files_in_share, share_exists,
)
from service.services.smb_reports import (
    parse_smb_asset, smb_host_report, smb_report_for_asset,
)
from service.services.shares import get_share, list_hosts, list_shares

router = APIRouter(prefix="/api/smb")

_CYCLE_RE = r"^\d{4}-W\d{2}$"


class ShareExceptionInput(BaseModel):
    reason: str = Field(..., min_length=1, max_length=1000)
    thread_id: int | None = None
    approved_by: str = Field("operator", max_length=120)


def _selected_cycle_key(value: str | None) -> str | None:
    raw = str(value or "").strip()
    if not raw or raw.lower() == "all":
        return None
    if not re.match(_CYCLE_RE, raw):
        raise HTTPException(400, f"invalid cycle_key: {raw}")
    return raw


def _thread_finding_ids(thread: dict[str, Any]) -> list[int]:
    out: list[int] = []
    try:
        raw = json.loads(thread.get("finding_ids") or "[]")
    except (TypeError, ValueError):
        raw = []
    if isinstance(raw, list):
        for value in raw:
            try:
                fid = int(value)
            except (TypeError, ValueError):
                continue
            if fid not in out:
                out.append(fid)
    try:
        representative = int(thread.get("finding_id"))
    except (TypeError, ValueError):
        representative = None
    if representative is not None and representative not in out:
        out.append(representative)
    return out


def _thread_report_scope(
    *,
    host: str,
    thread_id: int | None,
    cycle_key: str | None,
) -> tuple[str | None, list[int] | None]:
    selected_cycle = _selected_cycle_key(cycle_key)
    if thread_id is None:
        return selected_cycle, None
    thread = state.mail_thread_get(thread_id)
    if thread is None:
        raise HTTPException(404, f"mail thread {thread_id} not found")
    if str(thread.get("host") or "") != str(host):
        raise HTTPException(404, f"mail thread {thread_id} not found for host {host}")
    thread_cycle = str(thread.get("last_cycle_key") or thread.get("first_cycle_key") or "").strip()
    if cycle_key is None and thread_cycle:
        selected_cycle = thread_cycle
    if selected_cycle is not None and thread_cycle and selected_cycle != thread_cycle:
        raise HTTPException(404, f"mail thread {thread_id} not found in cycle: {selected_cycle}")
    return selected_cycle, _thread_finding_ids(thread)


@router.get("/dashboard")
def dashboard() -> dict:
    return smb_dashboard()


@router.get("/reports/{host}")
def host_report(
    host: str,
    findings_only: bool = True,
    limit_per_share: int = Query(5000, ge=1, le=5000),
    cycle_key: str | None = None,
    thread_id: int | None = None,
) -> dict:
    selected_cycle, finding_ids = _thread_report_scope(
        host=host,
        thread_id=thread_id,
        cycle_key=cycle_key,
    )
    report = smb_host_report(
        host,
        findings_only=findings_only,
        limit_per_share=limit_per_share,
        cycle_key=selected_cycle,
        finding_ids=finding_ids,
    )
    if report["summary"]["share_total"] == 0:
        raise HTTPException(404, f"SMB host {host} not found")
    return report


@router.get("/report-by-asset")
def report_by_asset(
    asset: str,
    findings_only: bool = True,
    limit_per_share: int = Query(5000, ge=1, le=5000),
    cycle_key: str | None = None,
) -> dict:
    try:
        parsed = parse_smb_asset(asset)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    report = smb_report_for_asset(
        asset,
        findings_only=findings_only,
        limit_per_share=limit_per_share,
        cycle_key=_selected_cycle_key(cycle_key),
    )
    if report["summary"]["share_total"] == 0:
        raise HTTPException(404, f"SMB asset host/share not found: {parsed.host}")
    return report


@router.get("/shares")
def shares(
    status: str | None = None,
    q: str | None = None,
    exposure: str | None = None,
    severity: str | None = None,
    open_only: bool = False,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict:
    return list_shares(
        status=status,
        q=q,
        exposure=exposure,
        severity=severity,
        open_only=open_only,
        limit=limit,
        offset=offset,
    )


@router.get("/hosts")
def hosts(
    status: str | None = None,
    q: str | None = None,
    exposure: str | None = None,
    severity: str | None = None,
    open_only: bool = False,
    report_ready: bool = False,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict:
    return list_hosts(
        status=status,
        q=q,
        exposure=exposure,
        severity=severity,
        open_only=open_only,
        report_ready=report_ready,
        limit=limit,
        offset=offset,
    )


@router.get("/shares/{share_id}")
def share_detail(share_id: int) -> dict:
    row = get_share(share_id)
    if row is None:
        raise HTTPException(404, f"share {share_id} not found")
    return row


@router.post("/shares/{share_id}/exception")
def approve_share_exception(share_id: int, body: ShareExceptionInput) -> dict:
    existing = get_share(share_id)
    if existing is None:
        raise HTTPException(404, f"share {share_id} not found")
    thread = state.mail_thread_get(body.thread_id) if body.thread_id is not None else None
    if body.thread_id is not None and thread is None:
        raise HTTPException(404, f"thread {body.thread_id} not found")
    row = state.share_mark_exception(
        share_id,
        reason=body.reason,
        thread_id=body.thread_id,
        approved_by=body.approved_by,
    )
    if row is None:
        raise HTTPException(404, f"share {share_id} not found")
    if thread is not None:
        state.mail_thread_set_status(
            int(thread["id"]),
            str(thread["status"] or "exception_review"),
            last_reason=f"share exception approved: \\\\{row['host']}\\{row['share']}",
        )
    shaped = get_share(share_id)
    return {
        "ok": True,
        "share": shaped,
        "thread": state.mail_thread_get(body.thread_id) if body.thread_id is not None else None,
    }


@router.get("/shares/{share_id}/files")
def share_files(
    share_id: int,
    suspicious_only: bool = False,
    hits_only: bool = False,
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict:
    if not share_exists(share_id):
        raise HTTPException(404, f"share {share_id} not found")
    return list_files_in_share(
        share_id,
        suspicious_only=suspicious_only, hits_only=hits_only,
        limit=limit, offset=offset,
    )


@router.get("/files/{file_id}")
def file_detail(file_id: int) -> dict:
    row = get_file_detail(file_id)
    if row is None:
        raise HTTPException(404, f"file {file_id} not found")
    return row
