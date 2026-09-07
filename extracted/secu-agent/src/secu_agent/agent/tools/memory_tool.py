"""Generic enterprise-security memory tool."""
from __future__ import annotations

import asyncio
import json
from typing import ClassVar, Literal

from pydantic import BaseModel, Field

from secu_agent import state
from secu_agent.agent.tools.base import (
    PermissionDecision,
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    ToolSuccess,
)


MemoryAction = Literal["save", "search", "get", "delete", "recall"]
# de-domain v3.84 #5: scope 는 개방형 문자열 — 코어 base(global/operator) + plugin 이
# register_memory_scope 로 등록한 도메인 scope. 유효성은 state.memory_add 가 등록
# 레지스트리로 검증하고, _save 가 그 ValueError 를 ToolError 로 변환한다.
MemoryScope = str
MemorySeverity = Literal["critical", "high", "medium", "low", "clean", "informational"]


class MemoryInput(BaseModel):
    action: MemoryAction
    memory_id: int | None = Field(default=None)
    scope: str | None = Field(
        default=None,
        description="memory scope: 코어 global/operator + 등록된 도메인 scope",
    )
    key: str | None = Field(default=None, max_length=200)
    rule: str | None = Field(default=None, max_length=500)
    severity_hint: MemorySeverity | None = None
    tags: list[str] = Field(default_factory=list, max_length=10)
    query: str | None = Field(default=None, max_length=300)
    context: str | None = Field(default=None, max_length=4000)
    include_expired: bool = False
    limit: int = Field(default=20, ge=1, le=200)


def _format_memory(row: dict) -> str:
    tags = ",".join(row.get("tags") or [])
    sev = row.get("severity_hint") or ""
    return (
        f"- memory_id={row['id']} scope={row['scope']} key={row['key']} "
        f"severity={sev} tags={tags} hits={row.get('hit_count', 0)}\n"
        f"  rule={row['rule']}"
    )


def _filter_query(rows: list[dict], query: str | None) -> list[dict]:
    q = (query or "").strip().lower()
    if not q:
        return rows
    out: list[dict] = []
    for row in rows:
        hay = " ".join([
            str(row.get("scope") or ""),
            str(row.get("key") or ""),
            str(row.get("rule") or ""),
            " ".join(row.get("tags") or []),
        ]).lower()
        if q in hay:
            out.append(row)
    return out


def _recall_rows(context_text: str, *, include_expired: bool, limit: int) -> list[dict]:
    text = context_text.lower()
    rows = state.memory_search(include_expired=include_expired, limit=1000)
    matched: list[dict] = []
    for row in rows:
        scope = row["scope"]
        key = str(row["key"])
        if scope in {"global", "operator"} or key.lower() in text:
            matched.append(row)
            if len(matched) >= limit:
                break
    for row in matched:
        state.memory_touch(int(row["id"]))
    return matched


class MemoryTool(Tool[MemoryInput]):
    name: ClassVar[str] = "memory"
    description: ClassVar[str] = (
        "Generic persistent memory for enterprise-security operation. "
        "Actions: save/search/get/delete/recall over memory_rule table. Use for "
        "cross-domain rules such as sensitive information categories, reporting "
        "preferences, internal asset context, and repeated false-positive rules."
    )
    input_model: ClassVar[type[BaseModel]] = MemoryInput
    is_read_only: ClassVar[bool] = False
    is_destructive: ClassVar[bool] = False
    deferred: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    search_hint: ClassVar[str] = "memory remember persistent rule recall save search delete"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "remember", "memory", "recall", "기억", "메모리", "룰 저장",
    )
    prompt_section: ClassVar[str] = (
        "### memory(action, ...)\n"
        "전사 보안 agent 공통 memory. `save`는 일반화 가능한 룰만 저장하고, "
        "`search/get/recall`로 다음 작업에 반영. 특정 도메인 전용이 아니라 "
        "조사/리포팅/중요정보 분류 전체에 사용. save/delete 는 approval 필요."
    )

    async def check_permission(
        self, validated_input: MemoryInput, context: ToolContext,
    ) -> PermissionDecision:
        if validated_input.action in {"save", "delete"}:
            if context.metadata.get("schedule_origin"):
                return PermissionDecision(
                    behavior="deny",
                    reason=f"scheduled execution cannot {validated_input.action} memory",
                )
            return PermissionDecision(
                behavior="ask",
                reason=f"memory {validated_input.action} mutates persistent memory",
            )
        return PermissionDecision(behavior="allow")

    async def execute(self, vi: MemoryInput, ctx: ToolContext) -> ToolResult:
        del ctx
        if vi.action == "save":
            return await self._save(vi)
        if vi.action == "search":
            return await self._search(vi)
        if vi.action == "get":
            return await self._get(vi)
        if vi.action == "delete":
            return await self._delete(vi)
        if vi.action == "recall":
            return await self._recall(vi)
        return ToolError(kind="validation", message=f"unknown action: {vi.action}")

    async def _save(self, vi: MemoryInput) -> ToolResult:
        if vi.scope is None:
            return ToolError(kind="validation", message="action=save 는 scope 필요")
        if not vi.key:
            return ToolError(kind="validation", message="action=save 는 key 필요")
        if not vi.rule or not vi.rule.strip():
            return ToolError(kind="validation", message="action=save 는 rule 필요")
        try:
            mid = await asyncio.to_thread(
                state.memory_add,
                scope=vi.scope,
                key=vi.key,
                rule=vi.rule,
                severity_hint=vi.severity_hint,
                tags=vi.tags,
                source="operator_agent",
            )
        except ValueError as e:
            return ToolError(kind="validation", message=str(e))
        return ToolSuccess(content=f"memory_id={mid} saved scope={vi.scope} key={vi.key}")

    async def _search(self, vi: MemoryInput) -> ToolResult:
        rows = await asyncio.to_thread(
            state.memory_search,
            scope=vi.scope,
            key_contains=None,
            include_expired=vi.include_expired,
            limit=1000,
        )
        rows = _filter_query(rows, vi.query)[:vi.limit]
        if not rows:
            return ToolSuccess(content="0 memory")
        return ToolSuccess(content=f"{len(rows)} memory:\n" + "\n".join(_format_memory(r) for r in rows))

    async def _get(self, vi: MemoryInput) -> ToolResult:
        if vi.memory_id is None:
            return ToolError(kind="validation", message="action=get 는 memory_id 필요")
        row = await asyncio.to_thread(state.memory_get, vi.memory_id)
        if row is None:
            return ToolError(kind="not_found", message=f"memory_id={vi.memory_id} not found")
        return ToolSuccess(content=json.dumps(row, ensure_ascii=False, indent=2))

    async def _delete(self, vi: MemoryInput) -> ToolResult:
        if vi.memory_id is None:
            return ToolError(kind="validation", message="action=delete 는 memory_id 필요")
        ok = await asyncio.to_thread(state.memory_delete, vi.memory_id)
        if not ok:
            return ToolError(kind="not_found", message=f"memory_id={vi.memory_id} not found")
        return ToolSuccess(content=f"memory_id={vi.memory_id} deleted")

    async def _recall(self, vi: MemoryInput) -> ToolResult:
        context_text = (vi.context or "").strip()
        if not context_text:
            return ToolError(kind="validation", message="action=recall 은 context 필요")
        rows = await asyncio.to_thread(
            _recall_rows,
            context_text,
            include_expired=vi.include_expired,
            limit=vi.limit,
        )
        if not rows:
            return ToolSuccess(content="0 memory recalled")
        return ToolSuccess(content=f"recalled {len(rows)} memory:\n" + "\n".join(_format_memory(r) for r in rows))


__all__ = ["MemoryTool", "MemoryInput"]
