"""Deterministic execution contract for persisted todo state.

The contract is intentionally state-based. It does not ask another model to
judge the assistant answer; it only checks whether there are active todo items
that make a text-only final answer invalid.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any


ACTIVE_TODO_STATUSES = frozenset({"pending", "in_progress"})
TERMINAL_TODO_STATUSES = frozenset({"completed", "cancelled", "blocked"})


def _status(item: dict[str, Any]) -> str:
    return str(item.get("status") or "pending").strip().lower()


def active_todo_items(items: Iterable[dict[str, Any]] | object) -> list[dict[str, Any]]:
    """Return todo items that still require execution or explicit closure."""
    if not isinstance(items, list):
        return []
    active: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, dict) and _status(item) in ACTIVE_TODO_STATUSES:
            active.append(dict(item))
    return active


def format_active_todo_snapshot(
    items: Iterable[dict[str, Any]] | object, *, max_items: int = 8,
) -> str | None:
    """Build a compact system note for active todo restoration."""
    active = active_todo_items(items)
    if not active:
        return None
    lines = [
        "[SYSTEM NOTE] Active execution todo state is still open. "
        "Do not treat the work as complete until all items are completed, "
        "cancelled, or blocked.",
    ]
    for item in active[:max_items]:
        iid = str(item.get("id") or "?")
        status = _status(item)
        content = str(item.get("content") or "(no description)")
        lines.append(f"- {iid}: {status} - {content}")
    if len(active) > max_items:
        lines.append(f"- ... {len(active) - max_items} more active item(s)")
    return "\n".join(lines)


def build_execution_contract_reminder(metadata: dict[str, object]) -> str | None:
    """Return a reminder when text-only completion would violate active todos."""
    snapshot = format_active_todo_snapshot(metadata.get("todo_items"))
    if snapshot is None:
        return None
    return (
        snapshot
        + "\n\nExecution contract: you cannot end this turn with text only while "
        "active todo items remain. Continue with concrete tool calls now. If an "
        "item is done, blocked, or cancelled, update it with "
        'todo(action="write", merge=True, todos=[...]) before finalizing. '
        "A final answer is allowed only after all todo items are terminal."
    )
