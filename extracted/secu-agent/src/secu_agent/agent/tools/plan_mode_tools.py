"""PlanMode 도구 — heavy task 전 사용자 승인 자동.

Claude Code 의 EnterPlanMode / ExitPlanMode 패턴. agent 가 무거운 batch (대량
review / 외부 영향 큰 schedule / sandbox 연쇄 호출 등) 시작 전 plan 을 사용자에게
보여주고 명시 승인을 받는다. is_destructive=True → permission ask 자동.
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent import state
from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    ToolSuccess,
)


def _session_id_from_context(context: ToolContext) -> int | None:
    raw = context.metadata.get("session_id")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


class EnterPlanModeInput(BaseModel):
    rationale: str = Field(description="왜 plan mode 가 필요한지 — 사용자가 보고 승인 판단할 근거.")
    steps: list[str] = Field(
        default_factory=list,
        description="실행할 step 들 (3-10 권장). step 별 도구 / 영향 명시. 빈 list 거부.",
    )
    estimated_minutes: float = Field(default=0.0, ge=0.0, le=600.0,
                                      description="예상 소요 시간 (분).")


class EnterPlanModeTool(Tool[EnterPlanModeInput]):
    name: ClassVar[str] = "enter_plan_mode"
    description: ClassVar[str] = (
        "heavy batch / 외부 영향 큰 작업 시작 전 plan 을 사용자에게 보여주고 승인 요구. "
        "is_destructive=True — 자동으로 사용자 ask. 승인되면 plan_mode_active 플래그 켜짐."
    )
    input_model: ClassVar[type[BaseModel]] = EnterPlanModeInput
    is_destructive: ClassVar[bool] = True
    domain: ClassVar[str] = "core"
    # is_destructive=True → frontend 가 사용자 keystroke approval 처리 가능해야 의미 있음.
    # chat WS 는 turn-based 라 redundant — capability gate 로 자동 제외.
    requires_capabilities: ClassVar[frozenset[str]] = frozenset({"interactive_approval"})
    prompt_section: ClassVar[str] = (
        "**enter_plan_mode** — 무거운 batch 전 사용자 승인. limit≥10 review / "
        "schedule 생성 / sandbox 연쇄 호출 / 자동 walk all 같은 경우 이걸로 plan 보여라."
    )

    async def execute(self, payload: EnterPlanModeInput, context: ToolContext) -> ToolResult:
        if not payload.steps:
            return ToolError(kind="validation", message="steps 비어있음. 최소 1개.")

        sid = _session_id_from_context(context)
        saved = state.chat_plan_mode_get(sid) if sid is not None else None
        already_active = bool(context.metadata.get("plan_mode_active")) or bool(
            saved and saved.get("active")
        )
        if already_active:
            if saved and saved.get("plan"):
                context.metadata["plan_mode_plan"] = saved["plan"]
            if saved and saved.get("status"):
                context.metadata["plan_mode_status"] = saved["status"]
            context.metadata["plan_mode_active"] = True
            return ToolError(
                kind="validation",
                message=(
                    "plan_mode 가 이미 active 입니다. enter_plan_mode 를 다시 호출하지 말고 "
                    "승인된 plan 의 실제 도구 실행으로 진행하세요. 완료 후 exit_plan_mode "
                    "를 호출하세요."
                ),
            )

        plan = {
            "rationale": payload.rationale,
            "steps": list(payload.steps),
            "estimated_minutes": payload.estimated_minutes,
        }
        context.metadata["plan_mode_active"] = True
        context.metadata["plan_mode_status"] = "approved"
        context.metadata["plan_mode_plan"] = plan
        if sid is not None:
            state.chat_plan_mode_set(sid, plan=plan)

        lines = [
            f"plan_mode_active=True (estimated_minutes={payload.estimated_minutes})",
            "approval already granted — proceed with the planned tool calls now; do not ask again.",
            f"rationale: {payload.rationale}",
            "steps:",
        ]
        for i, s in enumerate(payload.steps, 1):
            lines.append(f"  {i}. {s}")
        return ToolSuccess(content="\n".join(lines))


class ExitPlanModeInput(BaseModel):
    summary: str = Field(description="실행 결과 한 줄 요약.")
    executed_steps: list[str] = Field(
        default_factory=list,
        description="실제로 실행한 step (entry steps 와 같거나 부분집합).",
    )


class ExitPlanModeTool(Tool[ExitPlanModeInput]):
    name: ClassVar[str] = "exit_plan_mode"
    description: ClassVar[str] = (
        "plan mode 종료 — plan_mode_active 클리어. enter_plan_mode 이후에만 호출 가능."
    )
    input_model: ClassVar[type[BaseModel]] = ExitPlanModeInput
    is_destructive: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    # enter 와 짝 — enter 가 빠지는 frontend 에선 exit 도 의미 없음.
    requires_capabilities: ClassVar[frozenset[str]] = frozenset({"interactive_approval"})

    async def execute(self, payload: ExitPlanModeInput, context: ToolContext) -> ToolResult:
        sid = _session_id_from_context(context)
        saved = state.chat_plan_mode_get(sid) if sid is not None else None
        if not context.metadata.get("plan_mode_active") and not (
            saved and saved.get("active")
        ):
            return ToolError(
                kind="validation",
                message="plan_mode 가 active 가 아님. enter_plan_mode 먼저 호출.",
            )
        if sid is not None:
            todos = state.todo_read(sid)
            incomplete = [
                item for item in todos
                if item.get("status") in {"pending", "in_progress"}
            ]
            if incomplete:
                pending = sum(1 for item in incomplete if item["status"] == "pending")
                active = sum(1 for item in incomplete if item["status"] == "in_progress")
                preview = ", ".join(
                    f"{item['id']}:{item['status']}" for item in incomplete[:5]
                )
                return ToolError(
                    kind="validation",
                    message=(
                        "todo 미완료 상태라 plan_mode 를 완료 종료할 수 없습니다. "
                        f"pending={pending} in_progress={active}. "
                        f"미완료: {preview}. 완료하지 않은 항목은 completed 로 보고하지 마세요."
                    ),
                )
        context.metadata["plan_mode_active"] = False
        context.metadata["plan_mode_status"] = "completed"
        context.metadata["plan_mode_last_summary"] = payload.summary
        if sid is not None:
            state.chat_plan_mode_clear(sid, summary=payload.summary)
        return ToolSuccess(content=f"plan_mode_active=False\nsummary: {payload.summary}")
