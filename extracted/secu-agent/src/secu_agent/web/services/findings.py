"""Finding lifecycle service for the web API."""
from __future__ import annotations

from typing import Any

from secu_agent import state


_VALID_STATUSES = {
    "open",
    "triaged",
    "false_positive",
    "accepted_risk",
    "remediated",
}


def _shape(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "fingerprint": row["fingerprint"],
        "task_type": row["task_type"],
        "asset": row["asset"],
        "asset_kind": row["asset_kind"],
        "severity": row["severity"],
        "summary": row["summary"],
        "status": row["status"],
        "owner": row.get("owner"),
        "ticket_ref": row.get("ticket_ref"),
        "sla_due": row.get("sla_due"),
        "evidence_ref": row.get("evidence_ref"),
        "first_seen": row.get("first_seen"),
        "last_seen": row.get("last_seen"),
        "seen_count": int(row.get("seen_count") or 0),
        "extra": row.get("extra") or {},
    }


def _counts(column: str) -> dict[str, int]:
    if column not in {"status", "severity"}:
        raise ValueError(f"unsupported count column: {column}")
    with state.connect() as c:
        rows = c.execute(
            f"SELECT {column} AS k, COUNT(*) AS n "
            f"FROM finding_lifecycle GROUP BY {column}",
        ).fetchall()
    return {r["k"]: int(r["n"]) for r in rows if r["k"] is not None}


def list_findings(
    *,
    status: str | None = None,
    task_type: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    items = [
        _shape(row)
        for row in state.finding_list(
            status=status or None,
            task_type=task_type or None,
            limit=limit,
        )
    ]
    return {
        "total": len(items),
        "items": items,
        "status_counts": _counts("status"),
        "severity_counts": _counts("severity"),
        "statuses": sorted(_VALID_STATUSES),
    }


def get_finding(finding_id: int) -> dict[str, Any] | None:
    row = state.finding_get(finding_id)
    return _shape(row) if row is not None else None


def update_finding(
    finding_id: int,
    *,
    status: str | None = None,
    owner: str | None = None,
    ticket_ref: str | None = None,
    sla_due: float | None = None,
    summary: str | None = None,
) -> dict[str, Any] | None:
    if state.finding_get(finding_id) is None:
        return None
    state.finding_update(
        finding_id,
        status=status,
        owner=owner,
        ticket_ref=ticket_ref,
        sla_due=sla_due,
        summary=summary,
    )
    return get_finding(finding_id)
