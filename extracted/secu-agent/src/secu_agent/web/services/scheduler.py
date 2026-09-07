"""Scheduler run history service for the web API."""
from __future__ import annotations

import json
from typing import Any

from secu_agent import state
from secu_agent.agent_type_registry import valid_agent_types


# de-domain (v3.81 T4): agent_type 는 등록형 — agent_type_registry.valid_agent_types()
_VALID_SCHEDULE_STATUSES = {"active", "paused"}
_VALID_RUN_STATUSES = {"running", "ok", "error", "skipped", "queued"}


def _validate_agent_type(agent_type: str | None) -> None:
    if agent_type and agent_type not in valid_agent_types():
        raise ValueError(f"invalid agent_type: {agent_type!r}")


def _duration(row: dict[str, Any]) -> float | None:
    fired = row.get("fired_at")
    finished = row.get("finished_at")
    if fired is None or finished is None:
        return None
    return max(0.0, float(finished) - float(fired))


def _shape_recent_fire(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "id": int(row["id"]),
        "schedule_id": int(row["schedule_id"]),
        "status": row["status"],
        "fired_at": row.get("fired_at"),
        "finished_at": row.get("finished_at"),
        "result_summary": row.get("result_summary"),
        "child_session_id": row.get("child_session_id"),
        "duration_seconds": _duration(row),
    }


def _shape_schedule(row: dict[str, Any]) -> dict[str, Any]:
    recent = state.schedule_fires_for(int(row["id"]), limit=1)
    return {
        "id": int(row["id"]),
        "agent_type": row["agent_type"],
        "prompt": row["prompt"],
        "cron_expr": row["cron_expr"],
        "status": row["status"],
        "origin": row["origin"],
        "deliver": row["deliver"],
        "repeat": row.get("repeat"),
        "fire_count": int(row.get("fire_count") or 0),
        "next_run": row.get("next_run"),
        "last_run": row.get("last_run"),
        "charter_ref": row.get("charter_ref"),
        "created_by": row.get("created_by"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "recent_fire": _shape_recent_fire(recent[0] if recent else None),
    }


def _shape_run(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "schedule_id": int(row["schedule_id"]),
        "agent_type": row["agent_type"],
        "schedule_prompt": row["schedule_prompt"],
        "cron_expr": row["cron_expr"],
        "schedule_status": row["schedule_status"],
        "origin": row["origin"],
        "deliver": row["deliver"],
        "status": row["status"],
        "fired_at": row.get("fired_at"),
        "finished_at": row.get("finished_at"),
        "result_summary": row.get("result_summary"),
        "child_session_id": row.get("child_session_id"),
        "duration_seconds": _duration(row),
        "delivery_count": int(row.get("delivery_count") or 0),
    }


def _shape_delivery(row: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = json.loads(row.get("payload_json") or "{}")
    except json.JSONDecodeError:
        payload = {}
    return {
        "id": int(row["id"]),
        "fire_id": int(row["fire_id"]),
        "schedule_id": int(row["schedule_id"]),
        "channel": row["channel"],
        "status": row["status"],
        "destination": row["destination"],
        "payload_hash": row["payload_hash"],
        "payload": payload,
        "created_at": row.get("created_at"),
    }


def _run_status_counts() -> dict[str, int]:
    with state.connect() as c:
        rows = c.execute(
            "SELECT status, COUNT(*) AS n FROM schedule_fire GROUP BY status",
        ).fetchall()
    return {r["status"]: int(r["n"]) for r in rows}


def list_schedules(
    *,
    agent_type: str | None = None,
    status: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    _validate_agent_type(agent_type)
    if status and status not in _VALID_SCHEDULE_STATUSES:
        raise ValueError(f"invalid schedule status: {status!r}")
    rows = state.schedule_list(agent_type=agent_type or None, status=status or None)
    items = [_shape_schedule(row) for row in rows[:limit]]
    return {
        "total": len(items),
        "items": items,
        "statuses": sorted(_VALID_SCHEDULE_STATUSES),
        "agent_types": sorted(valid_agent_types()),
    }


def list_runs(
    *,
    agent_type: str | None = None,
    status: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    _validate_agent_type(agent_type)
    if status and status not in _VALID_RUN_STATUSES:
        raise ValueError(f"invalid run status: {status!r}")
    items = [
        _shape_run(row)
        for row in state.schedule_fire_history(
            agent_type=agent_type or None,
            status=status or None,
            limit=limit,
        )
    ]
    return {
        "total": len(items),
        "items": items,
        "status_counts": _run_status_counts(),
        "statuses": sorted(_VALID_RUN_STATUSES),
        "agent_types": sorted(valid_agent_types()),
    }


def get_run(fire_id: int) -> dict[str, Any] | None:
    row = state.schedule_fire_get(fire_id)
    if row is None:
        return None
    shaped = _shape_run(row)
    shaped["deliveries"] = [
        _shape_delivery(d)
        for d in state.schedule_deliveries_for_fire(fire_id, limit=50)
    ]
    return shaped
