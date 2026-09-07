"""GoalTool — operator 가 chat session 의 long-running goal 관리.

action:
  - set    : 새 goal 박기 (이전 active 는 자동 cleared)
  - clear  : active goal 종료
  - pause  : agent loop 멈춤 (사용자 수동 개입 위해)
  - resume : paused 풀음
  - status : 현재 goal + checklist 표시
  - add_criteria / remove_criteria / clear_criteria : 진행 중 사용자 완료 기준 관리

session_id 는 ToolContext.metadata["session_id"] 로 주입 — ChatSession 만이 호출.

운영 시나리오:
  사용자가 "이 범위 점검을 끝까지 진행하고 보고까지" 하면 operator 가:
    goal(action="set", text="지정된 범위 전체 점검, severity 별 보고까지")
  ChatSession 의 outer loop 이 자동 decompose → checklist → continuation 진행.
"""
from __future__ import annotations

from typing import ClassVar, Literal

from pydantic import BaseModel, Field

from secu_agent import state
from secu_agent.agent.goal_manager import ChecklistItem
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


class GoalInput(BaseModel):
    action: Literal[
        "set", "clear", "pause", "resume", "status",
        "add_criteria", "remove_criteria", "clear_criteria",
    ] = "status"
    text: str = Field(default="", max_length=4000)
    index: int | None = Field(default=None, ge=1)
    max_turns: int = Field(default=0, ge=0, description="turn 캡. 0=무제한 (권장 — pending=0/완료 또는 ESC 로만 종료)")


def _fmt_status(goal: dict) -> str:
    items_raw = goal["checklist"]
    parts = [
        f"goal: {goal['goal_text']}",
        f"status: {goal['status']}",
        f"turns: {goal['turns_used']}/{goal['max_turns']}",
    ]
    if goal.get("paused_reason"):
        parts.append(f"pause reason: {goal['paused_reason']}")
    if goal.get("last_reason"):
        parts.append(f"last judge reason: {goal['last_reason']}")
    criteria = goal.get("criteria") or []
    parts.append(f"criteria ({len(criteria)}):")
    if not criteria:
        parts.append("  (추가 criteria 없음)")
    else:
        for i, text in enumerate(criteria, start=1):
            parts.append(f"  {i}. {text}")
    parts.append(f"checklist ({len(items_raw)}):")
    if not items_raw:
        parts.append("  (아직 분해 안 됨 — 다음 turn 에 decompose)")
    else:
        marker = {"pending": "[ ]", "completed": "[x]", "impossible": "[!]"}
        for i, d in enumerate(items_raw, start=1):
            it = ChecklistItem.from_dict(d)
            parts.append(f"  {i}. {marker.get(it.status, '[?]')} {it.text}")
    return "\n".join(parts)


class GoalTool(Tool[GoalInput]):
    name: ClassVar[str] = "goal"
    description: ClassVar[str] = (
        "Long-running session goal 관리 (Ralph loop). set 하면 agent 가 매 "
        "응답 후 judge LLM 으로 checklist 검증 + 미완료면 자동 continuation. "
        "사용자가 멈출 때까지 (또는 pending=0/완료) 진행.\n"
        "\n"
        "action:\n"
        "  - set(text='...'): goal 박기. text 는 사용자 의도 한 문장. max_turns 는 "
        "생략(=0=무제한) 권장 — 완료/ESC 로만 끝낸다.\n"
        "  - clear: active goal 종료.\n"
        "  - pause: 현재 active 의 자동 진행 멈춤 (사용자가 개입).\n"
        "  - resume: paused → active.\n"
        "  - status: 현재 goal + checklist 진행 상태.\n"
        "  - add_criteria(text='...'): 진행 중 사용자가 추가한 완료 기준 추가.\n"
        "  - remove_criteria(index=1): 1-base criteria 제거.\n"
        "  - clear_criteria: criteria 전체 제거.\n"
        "\n"
        "주의: goal 모드 켜지면 너의 매 응답을 judge 가 평가한다. 응답에 작업 흔적이 "
        "분명히 보여야 항목이 done 으로 flip. 단순 의도 narration 으로는 X."
    )
    input_model: ClassVar[type[BaseModel]] = GoalInput
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    search_hint: ClassVar[str] = (
        "long running goal continuation ralph loop autonomous"
    )
    prompt_section: ClassVar[str] = (
        "### goal(action, text=..., max_turns=20)\n"
        "**Persistent session goal** — 사용자가 큰 의도 (예: \"지정 범위 점검 끝까지\") "
        "를 주면 `set` 으로 박는다. agent 가 매 응답 후 judge 가 checklist 검증 + 미완료면 "
        "다음 iteration 자동 진행 (Ralph loop). 사용자가 멈출 때까지.\n"
        "\n"
        "사용 패턴:\n"
        "1) 사용자 의도가 multi-step (수십~수백 turn 예상) 이면 `goal(action='set', text=...)` "
        "박고 일 시작.\n"
        "2) 진행 중 `goal(action='status')` 로 진행 확인.\n"
        "3) 사용자가 중간에 완료 기준/하위 목표를 추가하면 "
        "`goal(action='add_criteria', text=...)` 로 goal 에 붙인다.\n"
        "4) 막혔거나 사용자 입력 필요하면 그 응답에 명확히 적고 stop — judge 가 paused 마크.\n"
        "5) 끝났으면 judge 가 자동으로 모든 항목 terminal 처리 + GoalDone emit.\n"
        "\n"
        "주의: 일반 1-turn 작업에 goal 박지 마라 — 오버킬. set 은 \"끝까지\" / \"전부\" / "
        "\"수십 분 진행\" 같은 의도일 때만."
    )

    async def execute(self, vi: GoalInput, ctx: ToolContext) -> ToolResult:
        sid = ctx.metadata.get("session_id") if ctx.metadata else None
        if not isinstance(sid, int):
            return ToolError(
                kind="validation",
                message="goal tool: ctx.metadata.session_id 없음 — ChatSession 만 호출",
            )

        if vi.action == "set":
            if not vi.text.strip():
                return ToolError(
                    kind="validation",
                    message="action='set' 은 text 필수 (goal 본문)",
                )
            gid = state.goal_set(
                sid, goal_text=vi.text.strip(), max_turns=vi.max_turns,
            )
            return ToolSuccess(content=(
                f"✓ goal 박힘 (id={gid}, max_turns={vi.max_turns}).\n"
                f"다음 turn 부터 judge 가 자동으로 decompose + continuation. "
                f"checklist 진행은 `goal(action='status')` 로 확인."
            ))

        if vi.action == "clear":
            cleared = state.goal_clear(sid)
            if cleared:
                return ToolSuccess(content="✓ active goal cleared.")
            return ToolSuccess(content="active goal 없음 — no-op.")

        if vi.action == "add_criteria":
            if not vi.text.strip():
                return ToolError(
                    kind="validation",
                    message="action='add_criteria' 은 text 필수",
                )
            ok, idx = state.goal_add_criteria(sid, vi.text.strip())
            if ok:
                return ToolSuccess(content=f"✓ criteria added #{idx}.")
            return ToolSuccess(content="active goal 없음 — criteria 추가 안 됨.")

        if vi.action == "remove_criteria":
            if vi.index is None:
                return ToolError(
                    kind="validation",
                    message="action='remove_criteria' 은 index 필수 (1-base)",
                )
            removed = state.goal_remove_criteria(sid, vi.index)
            if removed is not None:
                return ToolSuccess(content=f"✓ criteria removed #{vi.index}: {removed}")
            return ToolSuccess(content="criteria 제거 대상 없음 — no-op.")

        if vi.action == "clear_criteria":
            count = state.goal_clear_criteria(sid)
            return ToolSuccess(content=f"✓ criteria cleared ({count}).")

        if vi.action == "pause":
            paused = state.goal_pause(sid, reason="manual pause via goal tool")
            if paused:
                return ToolSuccess(content="✓ goal paused. resume 으로 재개.")
            return ToolSuccess(content="active goal 없음 — no-op.")

        if vi.action == "resume":
            resumed = state.goal_resume(sid)
            if resumed:
                return ToolSuccess(content=(
                    "✓ goal resumed. 다음 user turn 시 자동 진행 재개."
                ))
            return ToolSuccess(content="paused goal 없음 — no-op.")

        # status
        goal = state.goal_get_active(sid)
        if not goal:
            return ToolSuccess(content="active goal 없음.")
        return ToolSuccess(content=_fmt_status(goal))
