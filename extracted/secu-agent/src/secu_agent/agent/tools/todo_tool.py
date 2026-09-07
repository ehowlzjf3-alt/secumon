"""TodoTool — operator 가 plan / sequential task list 관리.

단일 도구, action 디스패치.

action:
  - write : todos 영속 (replace 또는 merge)
  - read  : 현재 list 반환

session_id 는 ToolContext.metadata["session_id"] 로 주입 — ChatSession 이 setup.
이렇게 하면 multi-session/multi-agent_type 환경에서도 todo 충돌 없음.

큰 작업을 받았을 때 패턴:
  1) todo(action="write", todos=[{id:"1", content:"asset batch 1 처리", status:"pending"}, ...])
  2) 각 step 시작 시 merge 로 status="in_progress"
  3) 도구 호출
  4) 완료 시 status="completed"
  5) 다음 pending item 진행
"""
from __future__ import annotations

import asyncio
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field

from secu_agent import state
from secu_agent.agent.finding_followup import mark_finding_followup_addressed
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


_STATUS = Literal["pending", "in_progress", "completed", "cancelled", "blocked"]
_VALID_STATUSES = {"pending", "in_progress", "completed", "cancelled", "blocked"}


class TodoItemModel(BaseModel):
    id: str = Field(..., max_length=80)
    content: str | None = Field(None, max_length=500)
    status: _STATUS | None = None


class TodoInput(BaseModel):
    action: Literal["write", "read"]
    todos: list[TodoItemModel] | None = None
    merge: bool = False


def _fmt(items: list[dict[str, Any]]) -> str:
    if not items:
        return "todo: (없음)"
    markers = {
        "completed": "[x]", "in_progress": "[>]",
        "pending": "[ ]", "cancelled": "[~]", "blocked": "[!]",
    }
    pending = sum(1 for i in items if i["status"] == "pending")
    ip = sum(1 for i in items if i["status"] == "in_progress")
    done = sum(1 for i in items if i["status"] == "completed")
    cx = sum(1 for i in items if i["status"] == "cancelled")
    blocked = sum(1 for i in items if i["status"] == "blocked")
    lines = [
        f"todo ({len(items)}): pending={pending} in_progress={ip} "
        f"completed={done} cancelled={cx} blocked={blocked}",
    ]
    for it in items:
        m = markers.get(it["status"], "[?]")
        lines.append(f"  {m} {it['id']}. {it['content']}")
    return "\n".join(lines)


def _normalize_status(raw: object) -> str:
    status = str(raw or "pending").strip().lower()
    return status if status in _VALID_STATUSES else "pending"


def _apply_write_contract(
    *,
    requested: list[dict[str, Any]],
    existing: list[dict[str, Any]],
    merge: bool,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Constrain todo writes to sequential progress.

    The LLM can update todo state, but completed checkmarks should mean that a
    task actually ran. In merge mode, a pending item cannot jump directly to
    completed. It must be marked in_progress first and completed after the
    relevant work/tool call has finished.
    """
    warnings: list[str] = []
    if not merge:
        cleaned: list[dict[str, Any]] = []
        for item in requested:
            next_item = dict(item)
            if _normalize_status(next_item.get("status")) == "completed":
                next_item["status"] = "pending"
                warnings.append(
                    f"{next_item.get('id')}: initial write cannot seed completed status",
                )
            cleaned.append(next_item)
        return cleaned, warnings

    by_id = {str(item["id"]): item for item in existing}
    cleaned = [dict(item) for item in requested]
    accepted_terminal: set[str] = set()
    requested_in_progress: list[str] = []

    for item in cleaned:
        iid = str(item.get("id", "")).strip() or "?"
        if "status" not in item or item.get("status") is None:
            continue
        status = _normalize_status(item.get("status"))
        item["status"] = status
        current = by_id.get(iid)
        current_status = _normalize_status(current.get("status") if current else None)

        if status == "completed":
            if current_status not in {"in_progress", "completed"}:
                item.pop("status", None)
                warnings.append(
                    f"{iid}: ignored completed because current status is {current_status}; "
                    "mark in_progress and execute it first",
                )
                continue
            accepted_terminal.add(iid)
            continue
        if status in {"cancelled", "blocked"}:
            accepted_terminal.add(iid)
            continue
        if status == "in_progress":
            requested_in_progress.append(iid)

    if len(requested_in_progress) > 1:
        keep = requested_in_progress[0]
        for item in cleaned:
            iid = str(item.get("id", "")).strip() or "?"
            if iid != keep and item.get("status") == "in_progress":
                item.pop("status", None)
                warnings.append(
                    f"{iid}: ignored in_progress because {keep} is already starting",
                )

    active_existing = {
        str(item["id"])
        for item in existing
        if _normalize_status(item.get("status")) == "in_progress"
    }
    active_after_terminal = active_existing - accepted_terminal
    active_start = next(
        (
            str(item.get("id", "")).strip() or "?"
            for item in cleaned
            if item.get("status") == "in_progress"
        ),
        None,
    )
    if active_start and active_start not in active_existing and active_after_terminal:
        for item in cleaned:
            iid = str(item.get("id", "")).strip() or "?"
            if iid == active_start and item.get("status") == "in_progress":
                item.pop("status", None)
                warnings.append(
                    f"{iid}: ignored in_progress because "
                    f"{', '.join(sorted(active_after_terminal))} is still in_progress",
                )
                break

    return cleaned, warnings


class TodoTool(Tool[TodoInput]):
    name: ClassVar[str] = "todo"
    description: ClassVar[str] = (
        "Plan + sequential task list. 큰/복잡한 작업을 단계로 쪼개서 진행할 때 사용.\n"
        "\n"
        "**언제 쓰나** (반드시):\n"
        "  - 사용자가 한 메시지에 큰 batch 요청을 할 때 — "
        "todo(write) 로 단계 짠 뒤 진행.\n"
        "  - 여러 도구 호출이 필요한 multi-step 작업.\n"
        "  - tool 결과에서 finding / inconclusive evidence 가 나와 다음 검증, deep dive, "
        "report update 가 필요해졌을 때.\n"
        "  - 사용자가 명시적으로 '계획 세워서 해' 라고 할 때.\n"
        "\n"
        "**actions**:\n"
        "  - write: todos=[{id, content, status}] 쓰기. merge=False(기본) 전체 교체, "
        "merge=True id 매칭 update + 신규 append.\n"
        "  - read: 현재 list 반환.\n"
        "\n"
        "**status**: pending | in_progress | completed | cancelled | blocked.\n"
        "**진행 패턴**: write → in_progress 1개씩 → 도구 호출 → completed → 다음.\n"
        "한 번에 in_progress 는 1개만. finding follow-up 이 유효하지 않으면 "
        "blocked/cancelled todo 로 이유를 남긴다. 다 끝나면 read 로 확인 후 사용자에게 보고."
    )
    input_model: ClassVar[type[BaseModel]] = TodoInput
    is_read_only: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "계획 세워", "단계로 나눠", "todo",
    )
    prompt_section: ClassVar[str] = (
        "### todo(action, todos=[...], merge=False)\n"
        "**큰 / 복잡한 작업을 단계로 쪼개서 순차 진행할 때 반드시 사용.** "
        "대량 asset 처리, 여러 도구 chain 작업, finding 기반 추가 검증 / deep dive / "
        "report update 등.\n\n"
        "진행 패턴:\n"
        "1. 사용자가 큰 batch 요청 → 먼저 "
        "`todo(action=\"write\", todos=[{id:\"1\", content:\"...\"}, {id:\"2\", ...}])` 로 단계 짠다.\n"
        "2. 첫 step 시작 직전 "
        "`todo(action=\"write\", merge=True, todos=[{id:\"1\", status:\"in_progress\"}])`\n"
        "3. 실제 도구 호출\n"
        "4. 끝나면 `todo(action=\"write\", merge=True, todos=[{id:\"1\", status:\"completed\"}])`\n"
        "5. tool 결과에서 finding signal 이 나오면 기존 todo 를 merge/rewrite 해서 "
        "검증 / deep dive / report update 항목을 추가한다.\n"
        "6. 다음 pending item 으로. 모든 step 끝나면 사용자에게 짧게 결과 요약.\n\n"
        "actions: write (todos 영속, merge=True 면 id 매칭 update), read (현재 list).\n"
        "status: pending | in_progress | completed | cancelled | blocked.\n"
        "**한 번에 in_progress 는 1개만**. 사용자 메시지 1번에 todo 전체 처리 가능 — "
        "end_turn 으로 끊지 말고 도구 체인으로 진행."
    )

    async def execute(self, vi: TodoInput, ctx: ToolContext) -> ToolResult:
        sid = ctx.metadata.get("session_id") if ctx.metadata else None
        if not sid:
            return ToolError(
                kind="execution",
                message="todo tool: ctx.metadata.session_id 없음 — ChatSession 만이 호출 가능",
            )
        if vi.action == "read":
            items = await asyncio.to_thread(state.todo_read, sid)
            ctx.metadata["todo_items"] = items
            return ToolSuccess(content=_fmt(items))
        # write
        if not vi.todos:
            return ToolError(kind="validation",
                             message="write: todos 리스트 필요")
        payload = [t.model_dump(exclude_none=False) for t in vi.todos]
        existing = await asyncio.to_thread(state.todo_read, sid)
        payload, warnings = _apply_write_contract(
            requested=payload,
            existing=existing,
            merge=vi.merge,
        )
        items = await asyncio.to_thread(
            state.todo_write, sid, todos=payload, merge=vi.merge,
        )
        ctx.metadata["todo_items"] = items
        mark_finding_followup_addressed(ctx.metadata)
        content = _fmt(items)
        if warnings:
            content += "\ncontract_warning: " + " | ".join(warnings)
        return ToolSuccess(content=content)
