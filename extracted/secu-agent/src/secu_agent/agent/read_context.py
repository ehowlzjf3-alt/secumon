"""Short-lived read-result state for host source navigation.

The state is intentionally scoped to the active tool context. It lets read
tools avoid re-emitting the same unchanged range while that prior result is
still expected to be present in the LLM context. It is not a persistent cache.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any


READ_STATE_KEY = "_host_read_state"
READ_STATE_MAX_ENTRIES = 256


@dataclass(frozen=True, slots=True)
class ReadStateHit:
    path: str
    offset: int
    limit: int
    size: int
    mtime_ns: int
    total_lines: int
    returned_chars: int


def _state(metadata: dict[str, object]) -> OrderedDict[str, dict[str, Any]]:
    raw = metadata.get(READ_STATE_KEY)
    if isinstance(raw, OrderedDict):
        return raw
    if isinstance(raw, dict):
        converted: OrderedDict[str, dict[str, Any]] = OrderedDict()
        for key, value in raw.items():
            if isinstance(key, str) and isinstance(value, dict):
                converted[key] = value
        metadata[READ_STATE_KEY] = converted
        return converted
    state: OrderedDict[str, dict[str, Any]] = OrderedDict()
    metadata[READ_STATE_KEY] = state
    return state


def _key(path: Path, offset: int, limit: int) -> str:
    return f"{path}\0{offset}\0{limit}"


def clear_read_state(metadata: dict[str, object]) -> None:
    """Drop transient host read dedup state without touching read-before-edit."""
    metadata.pop(READ_STATE_KEY, None)


def forget_read_path(metadata: dict[str, object], path: Path) -> None:
    """Drop dedup entries for one path after a local mutation."""
    raw = metadata.get(READ_STATE_KEY)
    if not isinstance(raw, dict):
        return
    prefix = f"{path}\0"
    for key in list(raw.keys()):
        if isinstance(key, str) and key.startswith(prefix):
            raw.pop(key, None)


def check_unchanged_read(
    metadata: dict[str, object],
    path: Path,
    *,
    offset: int,
    limit: int,
) -> ReadStateHit | None:
    """Return a hit when the exact range was already read and file is unchanged."""
    try:
        stat = path.stat()
    except OSError:
        return None

    state = _state(metadata)
    key = _key(path, offset, limit)
    entry = state.get(key)
    if not isinstance(entry, dict):
        return None
    if (
        entry.get("size") != stat.st_size
        or entry.get("mtime_ns") != stat.st_mtime_ns
    ):
        state.pop(key, None)
        return None
    state.move_to_end(key)
    return ReadStateHit(
        path=str(path),
        offset=offset,
        limit=limit,
        size=stat.st_size,
        mtime_ns=stat.st_mtime_ns,
        total_lines=int(entry.get("total_lines") or 0),
        returned_chars=int(entry.get("returned_chars") or 0),
    )


def record_read(
    metadata: dict[str, object],
    path: Path,
    *,
    offset: int,
    limit: int,
    total_lines: int,
    returned_chars: int,
) -> None:
    """Record the exact range that was emitted by host_read."""
    try:
        stat = path.stat()
    except OSError:
        return
    state = _state(metadata)
    state[_key(path, offset, limit)] = {
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "total_lines": total_lines,
        "returned_chars": returned_chars,
    }
    state.move_to_end(_key(path, offset, limit))
    while len(state) > READ_STATE_MAX_ENTRIES:
        state.popitem(last=False)


def unchanged_read_stub(hit: ReadStateHit) -> str:
    return (
        f"[unchanged: host_read {hit.path} offset={hit.offset} limit={hit.limit}]\n"
        f"File fingerprint unchanged (size={hit.size}, mtime_ns={hit.mtime_ns}). "
        "The same range was already returned in this active tool context, "
        "so content_returned=false. Use the earlier host_read output or request "
        "a different offset/limit."
    )


__all__ = [
    "READ_STATE_KEY",
    "ReadStateHit",
    "check_unchanged_read",
    "clear_read_state",
    "forget_read_path",
    "record_read",
    "unchanged_read_stub",
]
