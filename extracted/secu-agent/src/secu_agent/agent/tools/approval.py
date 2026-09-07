"""Approval primitives for tools that return PermissionDecision(ask).

This module is intentionally independent from FastAPI/WebSocket. Callers can
inject an ApprovalResolver into ToolContext, and the invoker remains responsible
for fail-closed execution when no approval is available.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Literal, Protocol


ApprovalBehavior = Literal["allow", "deny"]


@dataclass(frozen=True, slots=True)
class ApprovalRequest:
    invocation_id: str
    tool_name: str
    tool_input: dict[str, object]
    reason: str


@dataclass(frozen=True, slots=True)
class ApprovalDecision:
    behavior: ApprovalBehavior
    reason: str = ""
    updated_input: dict[str, object] | None = None


class ApprovalResolver(Protocol):
    async def resolve(self, request: ApprovalRequest) -> ApprovalDecision | None:
        """Return a decision for this request, or None when no approval exists."""


class InMemoryApprovalStore:
    """Small one-shot approval store used by tests and interactive frontends.

    Approvals are consumed on match. Invocation approvals are matched first, then
    tool-level one-shot approvals. The store is process-local by design; durable
    approval history should live in the chat/session layer.
    """

    def __init__(self) -> None:
        self._by_invocation: dict[str, ApprovalDecision] = {}
        self._by_tool_once: dict[str, list[ApprovalDecision]] = defaultdict(list)

    def allow_invocation(
        self, invocation_id: str, *, reason: str = "",
        updated_input: dict[str, object] | None = None,
    ) -> None:
        self._by_invocation[invocation_id] = ApprovalDecision(
            behavior="allow", reason=reason, updated_input=updated_input,
        )

    def deny_invocation(self, invocation_id: str, *, reason: str = "") -> None:
        self._by_invocation[invocation_id] = ApprovalDecision(
            behavior="deny", reason=reason,
        )

    def allow_tool_once(
        self, tool_name: str, *, reason: str = "",
        updated_input: dict[str, object] | None = None,
    ) -> None:
        self._by_tool_once[tool_name].append(ApprovalDecision(
            behavior="allow", reason=reason, updated_input=updated_input,
        ))

    def deny_tool_once(self, tool_name: str, *, reason: str = "") -> None:
        self._by_tool_once[tool_name].append(ApprovalDecision(
            behavior="deny", reason=reason,
        ))

    async def resolve(self, request: ApprovalRequest) -> ApprovalDecision | None:
        by_id = self._by_invocation.pop(request.invocation_id, None)
        if by_id is not None:
            return by_id
        queue = self._by_tool_once.get(request.tool_name)
        if not queue:
            return None
        decision = queue.pop(0)
        if not queue:
            self._by_tool_once.pop(request.tool_name, None)
        return decision
