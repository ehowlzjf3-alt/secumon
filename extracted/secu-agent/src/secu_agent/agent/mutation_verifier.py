"""Track unresolved host file mutation failures across an agent turn."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from secu_agent.agent.tools.base import ToolError, ToolResult, ToolSuccess


STATE_KEY = "_mutation_verifier"
MUTATION_TOOLS = frozenset({"host_write", "host_edit", "host_copy", "host_move"})


def _state(metadata: dict[str, object]) -> dict[str, Any]:
    raw = metadata.setdefault(STATE_KEY, {"failures": {}})
    if not isinstance(raw, dict):
        raw = {"failures": {}}
        metadata[STATE_KEY] = raw
    failures = raw.setdefault("failures", {})
    if not isinstance(failures, dict):
        raw["failures"] = {}
    return raw


def _path_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def mutation_target_path(tool_name: str, tool_input: dict[str, object]) -> str | None:
    if tool_name in {"host_write", "host_edit"}:
        return _path_text(tool_input.get("path"))
    if tool_name in {"host_copy", "host_move"}:
        dest = _path_text(tool_input.get("dest_path"))
        if dest:
            return dest
        dest_dir = _path_text(tool_input.get("dest_dir"))
        source = _path_text(tool_input.get("source_path"))
        if dest_dir and source:
            return str(Path(dest_dir).expanduser() / Path(source).name)
    return None


def record_mutation_result(
    metadata: dict[str, object],
    *,
    tool_name: str,
    tool_input: dict[str, object],
    result: ToolResult,
) -> None:
    if tool_name not in MUTATION_TOOLS:
        return
    path = mutation_target_path(tool_name, tool_input)
    if path is None:
        return
    state = _state(metadata)
    failures = state["failures"]
    if isinstance(result, ToolSuccess):
        failures.pop(path, None)
        return
    if isinstance(result, ToolError):
        failures[path] = {
            "tool": tool_name,
            "path": path,
            "kind": result.kind,
            "message": result.message,
        }


def unresolved_mutation_failures(metadata: dict[str, object]) -> list[dict[str, str]]:
    raw = metadata.get(STATE_KEY)
    if not isinstance(raw, dict):
        return []
    failures = raw.get("failures")
    if not isinstance(failures, dict):
        return []
    out: list[dict[str, str]] = []
    for entry in failures.values():
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("path") or "").strip()
        tool = str(entry.get("tool") or "").strip()
        if not path or not tool:
            continue
        out.append({
            "tool": tool,
            "path": path,
            "kind": str(entry.get("kind") or "error"),
            "message": str(entry.get("message") or ""),
        })
    return sorted(out, key=lambda x: (x["path"], x["tool"]))


def build_mutation_verifier_footer(metadata: dict[str, object]) -> str:
    failures = unresolved_mutation_failures(metadata)
    if not failures:
        return ""
    lines = [
        "",
        "",
        "[mutation verifier] unresolved file mutation failures remain. "
        "Do not claim these changes succeeded until they are fixed or explicitly waived:",
    ]
    for item in failures[:5]:
        message = " ".join(item["message"].split())
        if len(message) > 180:
            message = message[:177] + "..."
        lines.append(
            f"- {item['tool']} {item['path']} failed ({item['kind']}): {message}"
        )
    if len(failures) > 5:
        lines.append(f"- ... {len(failures) - 5} more unresolved mutation failure(s)")
    return "\n".join(lines)
