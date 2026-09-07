"""Pure scheduled-run intent contract.

The scheduler decides whether a due row may execute before it creates a live
ChatSession. This keeps self-wakeup autonomy, but prevents old wakeups from
continuing a conversation after the operator has moved on.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class ScheduleDecision:
    should_run: bool
    reason: str
    detail: str = ""


def _as_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def evaluate_schedule_fire(
    job: dict[str, Any], *,
    now: float,
    latest_user_message_id: int | None = None,
    active_turn: bool = False,
) -> ScheduleDecision:
    """Return whether a due schedule row should execute now.

    Legacy and user-created recurring schedules keep existing behavior. The
    stricter stale checks apply only to `self_wakeup` rows.
    """
    schedule_kind = str(job.get("schedule_kind") or "legacy")
    stale_policy = str(job.get("stale_policy") or "run")

    if schedule_kind != "self_wakeup":
        return ScheduleDecision(True, "ready")

    if active_turn:
        return ScheduleDecision(False, "active_turn", "operator turn is still active")

    expires_at = _as_float(job.get("expires_at"))
    if expires_at is not None and now > expires_at:
        return ScheduleDecision(False, "expired", f"expires_at={expires_at}")

    source_session_id = _as_int(job.get("source_session_id"))
    if source_session_id is None:
        return ScheduleDecision(False, "source_missing", "self_wakeup has no source session")

    if stale_policy == "run":
        return ScheduleDecision(True, "ready")

    if stale_policy == "skip_if_superseded":
        source_message_id = _as_int(job.get("source_message_id"))
        if source_message_id is None:
            return ScheduleDecision(
                False,
                "source_boundary_missing",
                "self_wakeup has no source message boundary",
            )
        if (
            latest_user_message_id is not None
            and latest_user_message_id > source_message_id
        ):
            return ScheduleDecision(
                False,
                "superseded",
                (
                    f"latest_user_message_id={latest_user_message_id} "
                    f"> source_message_id={source_message_id}"
                ),
            )
        return ScheduleDecision(True, "ready")

    if stale_policy == "confirm_if_superseded":
        source_message_id = _as_int(job.get("source_message_id"))
        if (
            source_message_id is not None
            and latest_user_message_id is not None
            and latest_user_message_id > source_message_id
        ):
            return ScheduleDecision(
                False,
                "confirmation_required",
                "self_wakeup was superseded and requires operator confirmation",
            )
        return ScheduleDecision(True, "ready")

    return ScheduleDecision(False, "invalid_policy", f"stale_policy={stale_policy!r}")
