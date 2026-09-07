"""Approval audit service for the web API."""
from __future__ import annotations

from typing import Any

from secu_agent import state


_VALID_DECISIONS = {"pending", "allow", "deny", "timeout", "invalid"}


def _shape(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "approval_id": row["approval_id"],
        "session_id": row.get("session_id"),
        "agent_type": row["agent_type"],
        "actor": row["actor"],
        "tool_name": row["tool_name"],
        "tool_input_hash": row["tool_input_hash"],
        "tool_input_size": int(row.get("tool_input_size") or 0),
        "updated_input_hash": row.get("updated_input_hash"),
        "updated_input_size": row.get("updated_input_size"),
        "request_reason": row.get("request_reason") or "",
        "decision": row["decision"],
        "decision_reason": row.get("decision_reason") or "",
        "requested_at": row.get("requested_at"),
        "resolved_at": row.get("resolved_at"),
    }


def list_approvals(
    *,
    agent_type: str | None = None,
    decision: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    if decision and decision not in _VALID_DECISIONS:
        raise ValueError(f"invalid approval decision: {decision!r}")
    items = [
        _shape(row)
        for row in state.approval_audit_list(
            agent_type=agent_type or None,
            decision=decision or None,
            limit=limit,
        )
    ]
    return {
        "total": len(items),
        "items": items,
        "decision_counts": state.approval_audit_counts(),
        "decisions": sorted(_VALID_DECISIONS),
    }


def get_approval(approval_id: str) -> dict[str, Any] | None:
    row = state.approval_audit_get(approval_id)
    return _shape(row) if row is not None else None
