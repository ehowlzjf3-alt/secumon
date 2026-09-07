"""Tool-loop guardrails.

Hermes-style runtime guard for repeated tool failures and no-progress read loops.
The controller is intentionally pure and per-query: it observes tool calls,
emits warnings, and can block the next identical call when hard stops are on.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal


ToolGuardrailAction = Literal["allow", "warn", "block", "halt"]


@dataclass(frozen=True, slots=True)
class ToolCallGuardrailConfig:
    warnings_enabled: bool = True
    hard_stop_enabled: bool = False
    exact_failure_warn_after: int = 2
    exact_failure_block_after: int = 5
    same_tool_failure_warn_after: int = 3
    same_tool_failure_halt_after: int = 8
    no_progress_warn_after: int = 2
    no_progress_block_after: int = 5


@dataclass(frozen=True, slots=True)
class ToolGuardrailDecision:
    action: ToolGuardrailAction = "allow"
    code: str = "allow"
    message: str = ""
    tool_name: str = ""
    count: int = 0


def _stable_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
    except TypeError:
        return repr(value)


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def _args_hash(args: dict[str, object] | None) -> str:
    return _sha256_text(_stable_json(args or {}))


def _result_hash(result: Any) -> str:
    return _sha256_text(_stable_json(result))


class ToolCallGuardrailController:
    """Track repeated tool-loop patterns within one agent query."""

    def __init__(self, config: ToolCallGuardrailConfig | None = None) -> None:
        self.config = config or ToolCallGuardrailConfig()
        self._failure_by_signature: dict[tuple[str, str], int] = {}
        self._failure_by_tool: dict[str, int] = {}
        self._readonly_result_by_signature: dict[tuple[str, str], str] = {}
        self._readonly_repeat_by_signature: dict[tuple[str, str], int] = {}

    def reset_for_turn(self) -> None:
        self._failure_by_signature.clear()
        self._failure_by_tool.clear()
        self._readonly_result_by_signature.clear()
        self._readonly_repeat_by_signature.clear()

    def before_call(
        self,
        tool_name: str,
        args: dict[str, object] | None,
        *,
        is_read_only: bool = False,
    ) -> ToolGuardrailDecision:
        signature = (tool_name, _args_hash(args))
        cfg = self.config
        if cfg.hard_stop_enabled:
            failures = self._failure_by_signature.get(signature, 0)
            if failures >= cfg.exact_failure_block_after:
                return ToolGuardrailDecision(
                    action="block",
                    code="repeated_exact_failure_block",
                    message=(
                        f"{tool_name} has already failed with the same input "
                        f"{failures} time(s). Use a different tactic or inspect context."
                    ),
                    tool_name=tool_name,
                    count=failures,
                )
            if is_read_only:
                repeats = self._readonly_repeat_by_signature.get(signature, 0)
                if repeats >= cfg.no_progress_block_after:
                    return ToolGuardrailDecision(
                        action="block",
                        code="idempotent_no_progress_block",
                        message=(
                            f"{tool_name} has returned the same read-only result "
                            f"{repeats} time(s). Change inputs or summarize findings."
                        ),
                        tool_name=tool_name,
                        count=repeats,
                    )
        return ToolGuardrailDecision(tool_name=tool_name)

    def after_call(
        self,
        tool_name: str,
        args: dict[str, object] | None,
        result: Any,
        *,
        is_read_only: bool = False,
        failed: bool = False,
    ) -> ToolGuardrailDecision:
        signature = (tool_name, _args_hash(args))
        cfg = self.config
        if failed:
            exact_count = self._failure_by_signature.get(signature, 0) + 1
            self._failure_by_signature[signature] = exact_count
            tool_count = self._failure_by_tool.get(tool_name, 0) + 1
            self._failure_by_tool[tool_name] = tool_count
            if cfg.hard_stop_enabled and tool_count >= cfg.same_tool_failure_halt_after:
                return ToolGuardrailDecision(
                    action="halt",
                    code="same_tool_failure_halt",
                    message=(
                        f"{tool_name} has failed {tool_count} time(s) in this loop. "
                        "Stop and choose a different route."
                    ),
                    tool_name=tool_name,
                    count=tool_count,
                )
            if cfg.warnings_enabled and exact_count >= cfg.exact_failure_warn_after:
                return ToolGuardrailDecision(
                    action="warn",
                    code="repeated_exact_failure_warning",
                    message=(
                        f"{tool_name} failed with the same input {exact_count} time(s). "
                        "Do not repeat the identical call without changing inputs."
                    ),
                    tool_name=tool_name,
                    count=exact_count,
                )
            if cfg.warnings_enabled and tool_count >= cfg.same_tool_failure_warn_after:
                return ToolGuardrailDecision(
                    action="warn",
                    code="same_tool_failure_warning",
                    message=(
                        f"{tool_name} has failed {tool_count} time(s). "
                        "Try another tool or inspect the failure."
                    ),
                    tool_name=tool_name,
                    count=tool_count,
                )
            return ToolGuardrailDecision(tool_name=tool_name)

        self._failure_by_signature.pop(signature, None)
        self._failure_by_tool.pop(tool_name, None)
        if not is_read_only:
            return ToolGuardrailDecision(tool_name=tool_name)

        h = _result_hash(result)
        prev_hash = self._readonly_result_by_signature.get(signature)
        if prev_hash == h:
            repeat_count = self._readonly_repeat_by_signature.get(signature, 1) + 1
        else:
            repeat_count = 1
        self._readonly_result_by_signature[signature] = h
        self._readonly_repeat_by_signature[signature] = repeat_count
        if cfg.warnings_enabled and repeat_count >= cfg.no_progress_warn_after:
            return ToolGuardrailDecision(
                action="warn",
                code="idempotent_no_progress_warning",
                message=(
                    f"{tool_name} returned the same read-only result "
                    f"{repeat_count} time(s). Change inputs or move to synthesis."
                ),
                tool_name=tool_name,
                count=repeat_count,
            )
        return ToolGuardrailDecision(tool_name=tool_name)
