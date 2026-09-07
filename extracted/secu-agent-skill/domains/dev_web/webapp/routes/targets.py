"""dev_web target and report-thread read APIs."""
from __future__ import annotations

import json
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from service import state_domain as state

router = APIRouter(prefix="/api/dev-web")

_FINDING_TAG_LABELS = {
    "credential": "크리덴셜",
    "pii": "개인정보",
    "internal_system": "시스템정보",
    "misconfig": "접근통제",
    "api_docs": "API 문서",
    "debug": "디버그",
}
_FINDING_TAG_ALIASES = {
    "secret": "credential",
    "secrets": "credential",
    "token": "credential",
    "password": "credential",
    "credential": "credential",
    "credentials": "credential",
    "personal_information": "pii",
    "privacy": "pii",
    "internal": "internal_system",
    "internal_system": "internal_system",
    "permission": "misconfig",
    "access_control": "misconfig",
    "misconfiguration": "misconfig",
    "misconfig": "misconfig",
    "swagger": "api_docs",
    "openapi": "api_docs",
    "api_docs": "api_docs",
    "actuator": "debug",
    "debug": "debug",
}
_FINDING_TAG_ORDER = tuple(_FINDING_TAG_LABELS)
_CYCLE_RE = re.compile(r"^\d{4}-W\d{2}$")


def _selected_cycle_key(value: str | None) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return state.smb_current_cycle_key()
    if raw.lower() == "all":
        return None
    if not _CYCLE_RE.match(raw):
        raise HTTPException(400, f"invalid cycle_key: {raw}")
    return raw


def _json_dict(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _normalize_finding_tag(value: object) -> str | None:
    raw = str(value or "").strip().lower().removesuffix("_hit")
    if not raw:
        return None
    key = _FINDING_TAG_ALIASES.get(raw, raw)
    return key if key in _FINDING_TAG_LABELS else None


def _tag_candidates(extra: dict[str, Any]) -> set[str]:
    raw: set[str] = set()
    for hit in extra.get("hits") or []:
        if isinstance(hit, dict):
            raw.add(str(hit.get("category") or ""))
            raw.add(str(hit.get("kind") or ""))
    for key in ("classification", "tags", "risk_flags", "finding_tags"):
        value = extra.get(key)
        if isinstance(value, dict):
            raw.update(str(v) for v in value.values())
        elif isinstance(value, list):
            raw.update(str(v) for v in value)
        elif value:
            raw.add(str(value))
    return {tag for value in raw if (tag := _normalize_finding_tag(value))}


def _finding_row(finding_id: Any) -> dict[str, Any] | None:
    if finding_id is None:
        return None
    with state.connect() as c:
        row = c.execute("SELECT * FROM finding_lifecycle WHERE id=?", (int(finding_id),)).fetchone()
    return {k: row[k] for k in row.keys()} if row else None


def _attach_report_summary(thread: dict[str, Any]) -> dict[str, Any]:
    out = dict(thread)
    finding = _finding_row(thread.get("finding_id"))
    keys: set[str] = set()
    if finding:
        keys.update(_tag_candidates(_json_dict(finding.get("extra_json"))))
    report_json = _json_dict(thread.get("report_json"))
    keys.update(_tag_candidates(report_json))
    ordered = [key for key in _FINDING_TAG_ORDER if key in keys]
    out["finding_count"] = 1 if thread.get("finding_id") is not None else 0
    out["finding_tags"] = [{"key": key, "label": _FINDING_TAG_LABELS[key]} for key in ordered]
    out["has_request_mail"] = bool(thread.get("request_message_id") or thread.get("recipient"))
    return out


@router.get("/targets")
def targets(
    status: str | None = Query(None),
    day_bucket: str | None = Query(None),
    cycle_key: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
) -> dict:
    selected_cycle = _selected_cycle_key(cycle_key)
    if status == "pending" or status is None:
        rows = state.dev_web_targets_pending(
            day_bucket=day_bucket,
            cycle_key=selected_cycle,
            limit=limit,
        )
    else:
        with state.connect() as c:
            args: list[object] = [status]
            where = ["status=?"]
            if selected_cycle is not None:
                where.append("cycle_key=?")
                args.append(selected_cycle)
            if day_bucket is not None:
                where.append("day_bucket=?")
                args.append(day_bucket)
            args.append(limit)
            got = c.execute(
                "SELECT * FROM dev_web_target "
                f"WHERE {' AND '.join(where)} "
                "ORDER BY last_seen_at DESC, id DESC LIMIT ?",
                args,
            ).fetchall()
        rows = [{k: r[k] for k in r.keys()} for r in got]
    return {
        "items": rows,
        "summary": state.dev_web_targets_summary(
            day_bucket=day_bucket,
            cycle_key=selected_cycle,
        ),
        "cycle_key": selected_cycle,
        "current_cycle_key": state.smb_current_cycle_key(),
    }


@router.get("/reports")
def reports(
    status: str | None = Query(None),
    cycle_key: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
) -> dict:
    selected_cycle = _selected_cycle_key(cycle_key)
    items = state.dev_web_report_threads_overview(
        status=status,
        cycle_key=selected_cycle,
        limit=limit,
    )
    return {
        "items": [_attach_report_summary(t) for t in items],
        "summary": state.dev_web_report_thread_status_counts(cycle_key=selected_cycle),
        "cycle_key": selected_cycle,
        "current_cycle_key": state.smb_current_cycle_key(),
        "cycles": state.dev_web_report_thread_cycle_keys(),
    }
