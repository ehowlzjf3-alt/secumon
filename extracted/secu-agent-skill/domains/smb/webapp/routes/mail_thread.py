"""GET /api/mail-threads/* — 조치요청 스레드/추적 (요구 8·9·12)."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query

from service import state_domain as state

router = APIRouter(prefix="/api/mail-threads")

_REPORT_THREAD_STATUSES = {
    "reported",
    "awaiting_reply",
    "reply_received",
    "reverifying",
    "re_requested",
    "partially_remediated",
    "exception_review",
    "owner_update_needed",
    "owner_reassignment_review",
    "reassigned",
    "remediated",
    "escalated",
    "closed",
}
_REPORT_VIEW_COMPONENT = "report_view"
_FINDING_TAG_LABELS = {
    "pii": "개인정보",
    "semiconductor_process": "공정자료",
    "credential": "크리덴셜",
    "business_confidential": "경영자료",
    "internal_system": "시스템정보",
    "misconfig": "권한설정",
}
_FINDING_TAG_ALIASES = {
    "personal_information": "pii",
    "privacy": "pii",
    "employee_contact_roster": "pii",
    "secret": "credential",
    "secrets": "credential",
    "token": "credential",
    "password": "credential",
    "credential": "credential",
    "credentials": "credential",
    "semiconductor": "semiconductor_process",
    "process": "semiconductor_process",
    "process_data": "semiconductor_process",
    "business": "business_confidential",
    "confidential": "business_confidential",
    "internal": "internal_system",
    "internal_system": "internal_system",
    "permission": "misconfig",
    "access_control": "misconfig",
    "misconfiguration": "misconfig",
    "misconfig": "misconfig",
}
_FINDING_TAG_ORDER = tuple(_FINDING_TAG_LABELS)


def _looks_html(value: str | None) -> bool:
    return "<" in (value or "") and ">" in (value or "")


def _message_body_html(thread: dict, message: dict) -> str | None:
    if message.get("direction") != "out":
        return None
    body = str(message.get("body_excerpt") or "")
    if _looks_html(body):
        return body
    try:
        from service.services import smb_remediation_report

        report = smb_remediation_report.build_remediation_report(
            finding_id=int(thread["finding_id"]),
            host=str(thread["host"]),
        )
    except Exception:  # noqa: BLE001
        return None
    html = report.get("html")
    return str(html) if html else None


def _finding_count(thread: dict) -> int:
    ids = _finding_ids(thread)
    return len(ids) if ids else 1


def _finding_ids(thread: dict) -> list[int]:
    try:
        ids = json.loads(thread.get("finding_ids") or "[]")
    except (TypeError, ValueError):
        ids = []
    out: list[int] = []
    if isinstance(ids, list):
        for value in ids:
            try:
                out.append(int(value))
            except (TypeError, ValueError):
                pass
    if not out and thread.get("finding_id") is not None:
        try:
            out.append(int(thread["finding_id"]))
        except (TypeError, ValueError):
            pass
    return out


def _normalize_finding_tag(value: object) -> str | None:
    raw = str(value or "").strip().lower()
    if not raw:
        return None
    raw = raw.removesuffix("_hit")
    key = _FINDING_TAG_ALIASES.get(raw, raw)
    return key if key in _FINDING_TAG_LABELS else None


def _tag_candidates_from_extra(extra: object) -> set[str]:
    if not isinstance(extra, dict):
        return set()
    raw: set[str] = set()
    for hit in extra.get("hits") or []:
        if not isinstance(hit, dict):
            continue
        raw.add(str(hit.get("category") or ""))
        raw.add(str(hit.get("kind") or ""))
    classification = extra.get("classification")
    if isinstance(classification, dict):
        for key in ("key", "category", "type", "label"):
            raw.add(str(classification.get(key) or ""))
    elif classification:
        raw.add(str(classification))
    for key in ("tags", "risk_flags"):
        values = extra.get(key)
        if isinstance(values, list):
            raw.update(str(v) for v in values)
    return {tag for value in raw if (tag := _normalize_finding_tag(value))}


def _thread_finding_tags(thread: dict) -> list[dict[str, str]]:
    from secu_agent import state as core_state

    keys: set[str] = set()
    for fid in _finding_ids(thread):
        finding = core_state.finding_get(fid)
        if not finding:
            continue
        keys.update(_tag_candidates_from_extra(finding.get("extra") or {}))
    ordered = [key for key in _FINDING_TAG_ORDER if key in keys]
    return [{"key": key, "label": _FINDING_TAG_LABELS[key]} for key in ordered]


def _attach_thread_mail_summary(thread: dict) -> dict:
    out = dict(thread)
    messages = state.mail_messages_for_thread(int(thread["id"]))
    outbound = [m for m in messages if m.get("direction") == "out"]
    sent_outbound = [m for m in outbound if m.get("agent_verdict") == "sent"]
    last_out = sent_outbound[-1] if sent_outbound else None
    out["finding_count"] = _finding_count(thread)
    out["ticket_no"] = state.mail_thread_ticket_no(int(thread["id"]))
    out["display_title"] = f"({out['ticket_no']}){thread.get('host') or ''}"
    out["message_count"] = len(messages)
    out["has_outbound_mail"] = last_out is not None
    out["sent_at"] = last_out.get("received_at") if last_out else None
    out["mail_to"] = last_out.get("mail_to") if last_out else None
    out["sent_subject"] = last_out.get("subject") if last_out else None
    out["finding_tags"] = _thread_finding_tags(thread)
    return out


def _float_or_none(value: object) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _report_view_min_ts() -> float | None:
    """Optional report-list reset point stored in control_flag.interval_seconds."""
    try:
        flag = state.control_flag_get(_REPORT_VIEW_COMPONENT)
    except Exception:  # noqa: BLE001
        return None
    value = _float_or_none(flag.get("interval_seconds"))
    return value if value and value > 0 else None


def _is_current_report_thread(thread: dict, min_ts: float | None) -> bool:
    if not min_ts:
        return True
    for key in ("created_at", "sent_at", "claimed_at"):
        value = _float_or_none(thread.get(key))
        if value is not None and value >= min_ts:
            return True
    return False


def _status_counts(items: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        status = str(item.get("status") or "")
        counts[status] = counts.get(status, 0) + 1
    return counts


def _ticket_sort_key(thread: dict) -> int:
    try:
        return int(thread.get("id") or 0)
    except (TypeError, ValueError):
        return 0


def _selected_cycle_key(value: str | None) -> str | None:
    raw = str(value or "").strip()
    if raw.lower() == "all":
        return None
    if not raw:
        return state.smb_current_cycle_key()
    if not (len(raw) == 8 and raw[:4].isdigit() and raw[4:6] == "-W" and raw[6:].isdigit()):
        raise HTTPException(400, f"invalid cycle_key: {raw}")
    return raw


@router.get("")
def list_threads(
    status: str | None = None,
    scope: str | None = None,
    cycle_key: str | None = None,
    limit: int = Query(100, ge=1, le=1000),
) -> dict:
    selected_cycle = _selected_cycle_key(cycle_key)
    raw_limit = 1000 if scope == "report" else limit
    items = state.mail_threads_overview(
        status=status,
        limit=raw_limit,
        cycle_key=selected_cycle,
    )
    if scope == "report":
        items = [t for t in items if t.get("status") in _REPORT_THREAD_STATUSES]
    items = [_attach_thread_mail_summary(t) for t in items]
    if scope == "report":
        items = [t for t in items if _is_current_report_thread(t, _report_view_min_ts())]
        items.sort(key=_ticket_sort_key, reverse=True)
        status_counts = _status_counts(items)
        items = items[:limit]
    else:
        status_counts = state.mail_thread_status_counts(cycle_key=selected_cycle)
    return {
        "cycle_key": selected_cycle,
        "current_cycle_key": state.smb_current_cycle_key(),
        "cycles": state.mail_thread_cycle_keys(),
        "status_counts": status_counts,
        "items": items,
    }


@router.get("/{thread_id}")
def thread_detail(thread_id: int) -> dict:
    thread = state.mail_thread_get(thread_id)
    if thread is None:
        raise HTTPException(404, f"thread {thread_id} not found")
    thread = dict(thread)
    thread["ticket_no"] = state.mail_thread_ticket_no(thread_id)
    thread["display_title"] = f"({thread['ticket_no']}){thread.get('host') or ''}"
    messages = state.mail_messages_for_thread(thread_id)
    for message in messages:
        message["body_html"] = _message_body_html(thread, message)
    return {
        "thread": thread,
        "messages": messages,
    }
