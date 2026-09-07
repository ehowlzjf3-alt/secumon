"""Confluence E2E standalone control and report routes."""
from __future__ import annotations

import json
import re
import time
from email.utils import getaddresses
from html import escape
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from domains.services.application.report_cycles import report_cycle_summary
from domains.services.confluence.application.contracts import (
    CONFLUENCE_RECHECK_SESSION_ID,
    CONFLUENCE_REPORT_SESSION_ID,
    CONFLUENCE_SPACE_TASK_SESSION_ID,
    CONFLUENCE_SSO_TASK_SESSION_ID,
    COMPONENT_CONFLUENCE_RECHECK,
    COMPONENT_CONFLUENCE_REPORT,
    COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
    COMPONENT_CONFLUENCE_SPACE_TASK,
    COMPONENT_CONFLUENCE_SSO_DISCOVERY,
    COMPONENT_CONFLUENCE_SSO_TASK,
)
from service import state_domain as state
from secu_agent import state as core_state
from service.services import owner_recipients as orx

router = APIRouter()

_COMPONENTS = {
    COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
    COMPONENT_CONFLUENCE_SPACE_TASK,
    COMPONENT_CONFLUENCE_SSO_DISCOVERY,
    COMPONENT_CONFLUENCE_SSO_TASK,
    COMPONENT_CONFLUENCE_REPORT,
    COMPONENT_CONFLUENCE_RECHECK,
}
_FINDING_TAG_LABELS = {
    "credential": "크리덴셜",
    "api_key": "API Key",
    "password": "Password",
    "private_key": "Private Key",
    "current_page": "현재 페이지",
    "attachment": "첨부",
    "comment": "댓글",
    "history": "히스토리",
}
_FINDING_TAG_ORDER = tuple(_FINDING_TAG_LABELS)
# 담당자 수신자 해석 — SSOT 위임(service.services.owner_recipients).
# 이 사본은 dict 를 str() 로 훑는 shallow 판본이라 application 사본과 답이 달랐다.
_is_internal_owner_email = orx.is_internal
_owner_recipient_list = orx.recipient_list
_REASSIGNABLE_STATUSES = {
    "reported",
    "report_ready",
    "awaiting_owner",
    "recheck_requested",
    "still_open",
    "partially_remediated",
    "exception_review",
    "owner_update_needed",
    "owner_reassignment_review",
    "reassigned",
    "escalated",
    "error",
}
_RECHECK_REQUESTABLE_STATUSES = {
    "report_ready",
    "awaiting_owner",
    "recheck_requested",
    "still_open",
    "partially_remediated",
    "exception_review",
    "owner_update_needed",
    "owner_reassignment_review",
    "reassigned",
    "escalated",
    "error",
}


class ControlInput(BaseModel):
    component: str
    enabled: bool | None = None
    run_now: bool | None = None
    interval_seconds: float | None = None


class OwnerReassignInput(BaseModel):
    recipient: str
    reason: str | None = None


class ReviewInput(BaseModel):
    reason: str | None = None
    approved_by: str | None = None


class ResetClaimInput(BaseModel):
    component: str
    session_ref: str | None = None
    target_id: int | None = None
    reason: str | None = None


@router.get("/api/cron/status")
def cron_status() -> dict:
    return {c: state.control_flag_get(c) for c in sorted(_COMPONENTS)}


@router.post("/api/cron/set")
def set_flag(body: ControlInput) -> dict:
    if body.component not in _COMPONENTS:
        raise HTTPException(400, f"unknown Confluence component: {body.component}")
    return state.control_flag_set(
        body.component,
        enabled=body.enabled,
        run_now=body.run_now,
        interval_seconds=body.interval_seconds,
        updated_by="confluence-webapp",
    )


@router.post("/api/cron/run-now")
def run_now(component: str) -> dict:
    if component not in _COMPONENTS:
        raise HTTPException(400, f"unknown Confluence component: {component}")
    return state.control_flag_set(component, run_now=True, updated_by="confluence-webapp")


@router.post("/api/pipeline/reset-claim")
def reset_claim(body: ResetClaimInput) -> dict:
    reason = (body.reason or "operator reset stuck claim from confluence webapp").strip()[:500]
    if body.component == COMPONENT_CONFLUENCE_SPACE_TASK:
        target_id = _target_id(body, prefix="space-")
        return _reset_target_claim(
            table="confluence_space_target",
            target_id=target_id,
            expected_session=CONFLUENCE_SPACE_TASK_SESSION_ID,
            stale_seconds=state.CONFLUENCE_SPACE_CLAIM_STALE_SECONDS,
            cycle_column="cycle_key",
            service=None,
            reason=reason,
            reset_status="pending",
            session_ref=f"space-{target_id}",
        )
    if body.component == COMPONENT_CONFLUENCE_SSO_TASK:
        target_id = _target_id(body, prefix="devops-")
        return _reset_target_claim(
            table="devops_target",
            target_id=target_id,
            expected_session=CONFLUENCE_SSO_TASK_SESSION_ID,
            stale_seconds=state.DEVOPS_CLAIM_STALE_SECONDS,
            cycle_column="cycle_key",
            service="confluence",
            reason=reason,
            reset_status="pending",
            session_ref=f"devops-{target_id}",
            clear_cycle_result=True,
        )
    if body.component == COMPONENT_CONFLUENCE_REPORT:
        target_id = _target_id(body, prefix="confluence-thread-")
        return _reset_thread_claim(
            target_id=target_id,
            component=body.component,
            expected_session=CONFLUENCE_REPORT_SESSION_ID,
            stale_seconds=state.CONFLUENCE_REPORT_THREAD_CLAIM_STALE_SECONDS,
            reason=reason,
            session_ref=f"confluence-thread-{target_id}",
        )
    if body.component == COMPONENT_CONFLUENCE_RECHECK:
        target_id = _target_id(body, prefix="confluence-thread-")
        return _reset_thread_claim(
            target_id=target_id,
            component=body.component,
            expected_session=CONFLUENCE_RECHECK_SESSION_ID,
            stale_seconds=state.CONFLUENCE_REPORT_THREAD_CLAIM_STALE_SECONDS,
            reason=reason,
            session_ref=f"confluence-thread-{target_id}",
        )
    raise HTTPException(400, f"unsupported Confluence reset component: {body.component}")


@router.get("/api/reports")
def reports(
    status: str | None = Query(None),
    space_key: str | None = Query(None),
    cycle_key: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
) -> dict:
    selected_cycle = _selected_cycle_key(cycle_key)
    items = state.confluence_report_threads_overview(
        status=status,
        space_key=space_key,
        cycle_key=selected_cycle,
        limit=limit,
    )
    return {
        "items": [_thread_summary(t) for t in items],
        "status_counts": state.confluence_report_thread_status_counts(cycle_key=selected_cycle),
        "cycle_key": selected_cycle,
        "current_cycle_key": state.smb_current_cycle_key(),
        "cycles": state.confluence_report_thread_cycle_keys(),
    }


def _selected_cycle_key(value: str | None) -> str | None:
    raw = str(value or "").strip()
    if raw.lower() == "all":
        return None
    if not raw:
        return state.smb_current_cycle_key()
    if not (len(raw) == 8 and raw[:4].isdigit() and raw[4:6] == "-W" and raw[6:].isdigit()):
        raise HTTPException(400, f"invalid cycle_key: {raw}")
    return raw


@router.get("/api/reports/{thread_id}")
def report_detail(thread_id: int, cycle_key: str | None = Query(None)) -> dict:
    thread = state.confluence_report_thread_get(thread_id)
    if thread is None:
        raise HTTPException(404, f"confluence report thread not found: {thread_id}")
    selected_cycle = _selected_cycle_key(cycle_key)
    if selected_cycle is not None and not _thread_in_cycle(thread, selected_cycle):
        raise HTTPException(404, f"confluence report thread not found in cycle: {selected_cycle}")
    findings = []
    for fid in state.confluence_report_thread_finding_ids(thread_id):
        row = core_state.finding_get(fid)
        if row:
            findings.append(row)
    return {
        "thread": _thread_summary(thread, include_report=True),
        "findings": findings,
        "rechecks": state.confluence_recheck_results_for_thread(thread_id),
        "messages": state.service_reply_messages_for_thread("confluence", thread_id),
    }


@router.post("/api/reports/{thread_id}/request-recheck")
def request_recheck(thread_id: int) -> dict:
    thread = _require_thread(thread_id)
    _ensure_recheck_requestable(thread)
    reason = "manual recheck requested from confluence webapp"
    state.confluence_report_thread_set_status(
        thread_id,
        "recheck_requested",
        last_reason=reason,
    )
    _record_operator_audit(
        thread,
        verdict="operator_manual_recheck_requested",
        reason=reason,
        after={
            "status": "recheck_requested",
            "claimed_by": None,
            "claimed_at": None,
            "retry_after": None,
            "last_reason": reason,
        },
        body_excerpt=(
            f"Manual recheck requested from {thread.get('status')}; "
            "thread queued for current-cycle recheck."
        ),
    )
    return {"ok": True, "thread": _thread_summary(state.confluence_report_thread_get(thread_id) or {})}


@router.post("/api/reports/{thread_id}/reassign-owner")
def reassign_owner(thread_id: int, body: OwnerReassignInput) -> dict:
    thread = _require_thread(thread_id)
    _ensure_current_cycle(thread)
    if str(thread.get("status")) not in _REASSIGNABLE_STATUSES:
        raise HTTPException(400, "thread status does not allow owner reassignment")
    owners = _owner_recipient_list(body.recipient)
    if not owners:
        raise HTTPException(400, "valid internal Samsung owner recipient is required")
    recipient = ", ".join(owners)
    reason = (body.reason or "").strip()
    audit_reason = (
        f"operator reassigned owner to {recipient}; report requeued"
        + (f": {reason}" if reason else "")
    )[:1000]
    state.confluence_report_thread_set_status(
        int(thread["id"]),
        "reported",
        recipient=recipient,
        owner_recipient=recipient,
        notified_at=None,
        last_reason=audit_reason,
    )
    _record_operator_audit(
        thread,
        verdict="operator_owner_reassigned",
        reason=audit_reason,
        after={
            "status": "reported",
            "recipient": recipient,
            "owner_recipient": recipient,
            "claimed_by": None,
            "claimed_at": None,
            "retry_after": None,
            "notified_at": None,
            "last_reason": audit_reason,
        },
        body_excerpt=(
            f"Owner reassigned from HITL status {thread.get('status')} to {recipient}; "
            "report queued for resend."
        ),
        extracted_owner={"email": owners[0], "emails": owners},
    )
    return {"ok": True, "thread": _thread_summary(state.confluence_report_thread_get(thread_id) or {})}


@router.post("/api/reports/{thread_id}/close-exception")
def close_exception(thread_id: int, body: ReviewInput) -> dict:
    thread = _require_thread(thread_id)
    _ensure_current_cycle(thread)
    if str(thread.get("status")) != "exception_review":
        raise HTTPException(400, "thread is not in exception review status")
    reason = (body.reason or "operator approved exception").strip()
    approved_by = (body.approved_by or "operator").strip()
    audit_reason = f"exception approved by {approved_by}: {reason}"[:1000]
    state.confluence_report_thread_set_status(
        int(thread["id"]),
        "closed",
        last_reason=audit_reason,
    )
    _record_operator_audit(
        thread,
        verdict="operator_exception_approved",
        reason=audit_reason,
        actor=approved_by,
        after={
            "status": "closed",
            "claimed_by": None,
            "claimed_at": None,
            "retry_after": None,
            "last_reason": audit_reason,
        },
        body_excerpt=(
            f"Business exception approved by {approved_by}; "
            f"thread closed from {thread.get('status')}."
        ),
    )
    return {"ok": True, "thread": _thread_summary(state.confluence_report_thread_get(thread_id) or {})}


@router.post("/api/reports/{thread_id}/reject-exception")
def reject_exception(thread_id: int, body: ReviewInput) -> dict:
    thread = _require_thread(thread_id)
    _ensure_current_cycle(thread)
    if str(thread.get("status")) != "exception_review":
        raise HTTPException(400, "thread is not in exception review status")
    reason = (body.reason or "operator rejected HITL exception; recheck requested").strip()
    state.confluence_report_thread_set_status(
        int(thread["id"]),
        "recheck_requested",
        last_reason=reason[:1000],
    )
    _record_operator_audit(
        thread,
        verdict="operator_exception_rejected",
        reason=reason[:1000],
        after={
            "status": "recheck_requested",
            "claimed_by": None,
            "claimed_at": None,
            "retry_after": None,
            "last_reason": reason[:1000],
        },
        body_excerpt=(
            f"HITL exception rejected from {thread.get('status')}; "
            "thread queued for recheck."
        ),
    )
    return {"ok": True, "thread": _thread_summary(state.confluence_report_thread_get(thread_id) or {})}


def _require_thread(thread_id: int) -> dict[str, Any]:
    thread = state.confluence_report_thread_get(thread_id)
    if thread is None:
        raise HTTPException(404, f"confluence report thread not found: {thread_id}")
    return thread


def _ensure_recheck_requestable(thread: dict[str, Any]) -> None:
    _ensure_current_cycle(thread)
    status = str(thread.get("status") or "")
    if status not in _RECHECK_REQUESTABLE_STATUSES:
        raise HTTPException(400, "thread status does not allow manual recheck")


def _ensure_current_cycle(thread: dict[str, Any]) -> None:
    if not _is_current_cycle(thread):
        raise HTTPException(400, "thread is not in current cycle")


def _is_current_cycle(thread: dict[str, Any]) -> bool:
    cycle_key = str(thread.get("last_cycle_key") or thread.get("first_cycle_key") or "").strip()
    return bool(cycle_key and cycle_key == state.smb_current_cycle_key())


def _thread_in_cycle(thread: dict[str, Any], cycle_key: str) -> bool:
    return str(thread.get("last_cycle_key") or "").strip() == cycle_key


def _target_id(body: ResetClaimInput, *, prefix: str) -> int:
    if body.target_id is not None:
        if int(body.target_id) <= 0:
            raise HTTPException(400, "target_id must be positive")
        return int(body.target_id)
    ref = str(body.session_ref or "").strip()
    if not ref.startswith(prefix):
        raise HTTPException(400, f"session_ref must start with {prefix!r}")
    raw = ref[len(prefix):]
    if not raw.isdigit() or int(raw) <= 0:
        raise HTTPException(400, "session_ref target id must be positive")
    return int(raw)


def _claim_is_stuck(row: dict[str, Any], *, expected_session: int, stale_cutoff: float) -> bool:
    claimed_at = row.get("claimed_at")
    if claimed_at is None:
        return True
    try:
        stale = float(claimed_at) < stale_cutoff
    except Exception:
        stale = True
    try:
        claimed_by = int(row.get("claimed_by"))
    except Exception:
        claimed_by = -1
    return stale or claimed_by != expected_session


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def _reset_target_claim(
    *,
    table: str,
    target_id: int,
    expected_session: int,
    stale_seconds: float,
    cycle_column: str,
    service: str | None,
    reason: str,
    reset_status: str,
    session_ref: str,
    clear_cycle_result: bool = False,
) -> dict:
    cycle_key = state.smb_current_cycle_key()
    stale_cutoff = time.time() - stale_seconds
    service_where = "AND service=? " if service is not None else ""
    args: list[Any] = [target_id, cycle_key]
    if service is not None:
        args.append(service)
    with state.connect() as c:
        row = c.execute(
            f"SELECT * FROM {table} WHERE id=? AND {cycle_column}=? {service_where}",
            args,
        ).fetchone()
        if row is None:
            raise HTTPException(404, f"confluence target not found for {session_ref}")
        data = _row_dict(row)
        if str(data.get("status")) != "in_progress" or not _claim_is_stuck(
            data,
            expected_session=expected_session,
            stale_cutoff=stale_cutoff,
        ):
            raise HTTPException(409, f"target is not a stuck claim: {session_ref}")
        sets = [
            "status=?",
            "claimed_by=NULL",
            "claimed_at=NULL",
            "last_reason=?",
        ]
        values: list[Any] = [reset_status, reason]
        if clear_cycle_result:
            sets.extend(["cycle_scanned_at=NULL", "cycle_finding_count=0"])
        values.append(target_id)
        c.execute(
            f"UPDATE {table} SET {', '.join(sets)} WHERE id=?",
            values,
        )
    return {
        "ok": True,
        "reset": True,
        "component": COMPONENT_CONFLUENCE_SSO_TASK if service else COMPONENT_CONFLUENCE_SPACE_TASK,
        "session_ref": session_ref,
        "status": reset_status,
    }


def _reset_thread_claim(
    *,
    target_id: int,
    component: str,
    expected_session: int,
    stale_seconds: float,
    reason: str,
    session_ref: str,
) -> dict:
    cycle_key = state.smb_current_cycle_key()
    stale_cutoff = time.time() - stale_seconds
    with state.connect() as c:
        row = c.execute(
            "SELECT * FROM confluence_report_thread WHERE id=? AND last_cycle_key=?",
            (target_id, cycle_key),
        ).fetchone()
        if row is None:
            raise HTTPException(404, f"confluence thread not found for {session_ref}")
        data = _row_dict(row)
        status = str(data.get("status") or "")
        if component == COMPONENT_CONFLUENCE_REPORT:
            is_stuck = (
                status == "reported"
                and data.get("claimed_at") is not None
                and _claim_is_stuck(data, expected_session=expected_session, stale_cutoff=stale_cutoff)
            )
            next_status = "reported"
        else:
            if status == "awaiting_owner":
                is_stuck = (
                    data.get("claimed_at") is not None
                    and _claim_is_stuck(data, expected_session=expected_session, stale_cutoff=stale_cutoff)
                )
                next_status = "awaiting_owner"
            else:
                is_stuck = (
                    (
                        status == "recheck_requested"
                        and data.get("claimed_at") is not None
                        and _claim_is_stuck(data, expected_session=expected_session, stale_cutoff=stale_cutoff)
                    )
                    or (
                        status == "rechecking"
                        and _claim_is_stuck(data, expected_session=expected_session, stale_cutoff=stale_cutoff)
                    )
                )
                next_status = "recheck_requested"
        if not is_stuck:
            raise HTTPException(409, f"thread is not a stuck claim: {session_ref}")
        c.execute(
            "UPDATE confluence_report_thread SET status=?, claimed_by=NULL, claimed_at=NULL, "
            "retry_after=NULL, last_reason=?, updated_at=? WHERE id=?",
            (next_status, reason, time.time(), target_id),
        )
    _record_operator_audit(
        data,
        verdict="operator_claim_reset",
        reason=reason,
        after={
            "status": next_status,
            "claimed_by": None,
            "claimed_at": None,
            "retry_after": None,
            "last_reason": reason,
            "component": component,
        },
        body_excerpt=(
            f"Stuck claim reset from {status}; "
            f"thread queued as {next_status} for current-cycle processing."
        ),
    )
    return {
        "ok": True,
        "reset": True,
        "component": component,
        "session_ref": session_ref,
        "status": next_status,
    }


def _record_operator_audit(
    thread: dict[str, Any],
    *,
    verdict: str,
    reason: str,
    body_excerpt: str,
    actor: str = "operator",
    extracted_owner: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
) -> None:
    space_key = str(thread.get("space_key") or "").strip()
    subject_tag = str(
        thread.get("subject_tag") or state.normalize_confluence_subject_tag(space_key),
    )
    state.service_reply_message_add(
        domain="confluence",
        direction="operator",
        thread_id=int(thread["id"]),
        subject=f"[operator] {verdict} {space_key or subject_tag}",
        subject_tag=subject_tag,
        mail_from=actor,
        mail_to="dssoc",
        body_excerpt=body_excerpt,
        body_html=_operator_evidence_html(
            thread,
            verdict=verdict,
            actor=actor,
            reason=reason,
            after=after or {},
            extracted_owner=extracted_owner or {},
        ),
        agent_verdict=verdict,
        decision_reason=reason,
        extracted_owner=extracted_owner or {},
    )


def _operator_evidence_html(
    thread: dict[str, Any],
    *,
    verdict: str,
    actor: str,
    reason: str,
    after: dict[str, Any],
    extracted_owner: dict[str, Any],
) -> str:
    cycle_summary = report_cycle_summary(thread)
    evidence = {
        "domain": "confluence",
        "action": verdict,
        "actor": actor,
        "reason": reason,
        "target": {
            "thread_id": thread.get("id"),
            "space_key": thread.get("space_key"),
            "subject_tag": thread.get("subject_tag"),
            "finding_ids": _thread_finding_ids(thread),
            "cycle_key": thread.get("last_cycle_key") or thread.get("first_cycle_key"),
            **cycle_summary,
        },
        "before": {
            "status": thread.get("status"),
            "recipient": thread.get("recipient"),
            "owner_recipient": thread.get("owner_recipient"),
            "claimed_by": thread.get("claimed_by"),
            "claimed_at": thread.get("claimed_at"),
            "retry_after": thread.get("retry_after"),
            "notified_at": thread.get("notified_at"),
            "last_reason": thread.get("last_reason"),
        },
        "after": after,
        "extracted_owner": extracted_owner,
    }
    payload = json.dumps(evidence, ensure_ascii=False, sort_keys=True)
    return f'<pre data-operator-evidence="confluence">{escape(payload)}</pre>'




def _thread_summary(thread: dict[str, Any], *, include_report: bool = False) -> dict[str, Any]:
    out = dict(thread)
    out.update(report_cycle_summary(out))
    status = str(out.get("status") or "")
    is_current = _is_current_cycle(out)
    out["is_current_cycle"] = is_current
    out["can_request_recheck"] = is_current and status in _RECHECK_REQUESTABLE_STATUSES
    out["can_reassign_owner"] = is_current and status in _REASSIGNABLE_STATUSES
    out["can_close_exception"] = is_current and status == "exception_review"
    out["can_reject_exception"] = is_current and status == "exception_review"
    ids = _thread_finding_ids(out)
    out["finding_count"] = len(ids) or (1 if out.get("finding_id") else 0)
    out["verification_counts"] = _verification_counts(ids)
    out["scan_method_counts"] = _scan_method_counts(ids)
    out["finding_tags"] = _thread_finding_tags(ids)
    out["has_report"] = _has_report_payload(out.get("report_json"), out.get("report_html"))
    if include_report:
        try:
            out["report"] = json.loads(out.get("report_json") or "{}")
        except Exception:
            out["report"] = {}
    else:
        out.pop("report_html", None)
    return out


def _has_report_payload(report_json: Any, report_html: Any) -> bool:
    if str(report_html or "").strip():
        return True
    raw = str(report_json or "").strip()
    if not raw:
        return False
    try:
        parsed = json.loads(raw)
    except Exception:
        return bool(raw)
    if isinstance(parsed, (dict, list)):
        return bool(parsed)
    return parsed not in (None, "", False)


def _thread_finding_ids(thread: dict[str, Any]) -> list[int]:
    try:
        raw = json.loads(thread.get("finding_ids") or "[]")
    except Exception:
        raw = []
    ids = [int(value) for value in raw if str(value).strip().isdigit()]
    if not ids and thread.get("finding_id"):
        try:
            ids = [int(thread["finding_id"])]
        except Exception:
            ids = []
    return ids


def _finding_rows(ids: list[int]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for fid in ids:
        row = core_state.finding_get(int(fid))
        if row:
            rows.append(row)
    return rows


def _default_verification_status(row: dict[str, Any]) -> str:
    kind = str(row.get("asset_kind") or "")
    asset = str(row.get("asset") or "")
    if kind == "page_version" or "/version/" in asset:
        return "historical_version"
    if kind == "comment" or "/comment/" in asset:
        return "comment_surface"
    if kind == "attachment" or "/attachment/" in asset:
        return "attachment_surface"
    if kind == "page":
        return "current_page"
    return "submitted_surface"


def _verification_counts(ids: list[int]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in _finding_rows(ids):
        extra = row.get("extra") or {}
        verification = extra.get("verification") if isinstance(extra.get("verification"), dict) else {}
        status = str(verification.get("status") or _default_verification_status(row))
        counts[status] = counts.get(status, 0) + 1
    return counts


def _scan_method_counts(ids: list[int]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in _finding_rows(ids):
        extra = row.get("extra") or {}
        metadata = extra.get("metadata") if isinstance(extra.get("metadata"), dict) else {}
        method = str(metadata.get("scan_method") or "unknown")
        counts[method] = counts.get(method, 0) + 1
    return counts


def _normalize_finding_tag(value: object) -> str | None:
    raw = str(value or "").strip().lower()
    if not raw:
        return None
    if raw in {"api_key", "apikey", "token", "secret", "credential", "credentials"}:
        return "api_key" if raw in {"api_key", "apikey"} else "credential"
    if "private" in raw and "key" in raw:
        return "private_key"
    if "password" in raw or "passwd" in raw:
        return "password"
    return raw if raw in _FINDING_TAG_LABELS else None


def _surface_tag(row: dict[str, Any]) -> str | None:
    kind = str(row.get("asset_kind") or "")
    asset = str(row.get("asset") or "")
    if kind == "page_version" or "/version/" in asset:
        return "history"
    if kind == "comment" or "/comment/" in asset:
        return "comment"
    if kind == "attachment" or "/attachment/" in asset:
        return "attachment"
    if kind == "page":
        return "current_page"
    return None


def _thread_finding_tags(ids: list[int]) -> list[dict[str, str]]:
    keys: set[str] = set()
    for row in _finding_rows(ids):
        surface = _surface_tag(row)
        if surface:
            keys.add(surface)
        extra = row.get("extra") or {}
        for hit in extra.get("hits") or []:
            if not isinstance(hit, dict):
                continue
            for field in ("kind", "category"):
                tag = _normalize_finding_tag(hit.get(field))
                if tag:
                    keys.add(tag)
    ordered = [key for key in _FINDING_TAG_ORDER if key in keys]
    return [{"key": key, "label": _FINDING_TAG_LABELS[key]} for key in ordered]
