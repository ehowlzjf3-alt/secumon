"""ScheduleWakeupTool — N초 후 1회 wake-up.

Claude Code 의 ScheduleWakeup 패턴. self-pacing — agent 가 "X초 후 다시 확인"
요청. 기존 schedule 시스템 위에 repeat=1 + next_run=now+N 으로 래핑.

운영 흐름:
1. agent 가 wakeup 호출 → schedule row 생성 (status=active, repeat=1).
2. scheduler_tick (web/app.py lifespan background) 이 due 발견 → sub-ChatSession spawn.
3. fire 후 repeat 도달 → 자동 paused.
"""
from __future__ import annotations

import time
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

_MIN_DELAY = 60
_MAX_DELAY = 3600
_EXPIRY_GRACE_SEC = 300


class ScheduleWakeupInput(BaseModel):
    delay_sec: int = Field(description=f"N초 후 wake-up ({_MIN_DELAY}~{_MAX_DELAY}).")
    prompt: str = Field(description="wake-up 시점에 agent 가 다시 실행할 prompt.")
    reason: str = Field(description="왜 N초 기다리는지 한 줄 — audit.")


class ScheduleWakeupTool(Tool[ScheduleWakeupInput]):
    name: ClassVar[str] = "schedule_wakeup"
    description: ClassVar[str] = (
        "N초 후 1회 자기 자신 wake-up. long-running scan 결과 polling / 단계적 task "
        "사이 대기에 사용. 생성 당시 chat session/user-message 경계에 묶이며, "
        "그 뒤 사용자가 새 지시를 보내면 stale 로 판단해 실행하지 않는다. "
        "1회 발동 또는 skip 후 자동 paused."
    )
    input_model: ClassVar[type[BaseModel]] = ScheduleWakeupInput
    is_destructive: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    prompt_section: ClassVar[str] = (
        "**schedule_wakeup** — delay_sec 후 1회 wake. cron schedule 과 별개 — 이건 "
        "ad-hoc one-shot timer. scan 결과 N분 후 확인 같은 경우 사용. "
        "self-wakeup 은 `skip_if_superseded` 계약을 갖는다: 생성 후 새 user message 가 "
        "있으면 scheduler 가 실행하지 않고 skipped audit 만 남긴다."
    )

    async def execute(self, payload: ScheduleWakeupInput, context: ToolContext) -> ToolResult:
        if not (_MIN_DELAY <= payload.delay_sec <= _MAX_DELAY):
            return ToolError(
                kind="validation",
                message=f"delay_sec {payload.delay_sec} out of [{_MIN_DELAY}, {_MAX_DELAY}]",
            )

        agent_type = str(context.metadata.get("agent_type") or "agent")
        next_run = time.time() + payload.delay_sec
        source_session_id = context.metadata.get("session_id")
        if not isinstance(source_session_id, int):
            source_session_id = None
        source_message_id = (
            state.chat_latest_message_id(source_session_id, role="user")
            if source_session_id is not None else None
        )
        expires_at = next_run + max(_EXPIRY_GRACE_SEC, payload.delay_sec)

        try:
            sid = state.schedule_create(
                agent_type=agent_type,
                prompt=payload.prompt,
                cron_expr="@once",  # placeholder — repeat=1 이라 발동 후 paused
                next_run=next_run,
                origin="operator_agent",
                deliver="chat",
                repeat=1,
                charter_ref=str(context.metadata.get("charter_ref") or "agent_self_wakeup"),
                created_by="agent",
                schedule_kind="self_wakeup",
                stale_policy="skip_if_superseded",
                source_session_id=source_session_id,
                source_message_id=source_message_id,
                expires_at=expires_at,
            )
        except ValueError as e:
            return ToolError(kind="validation", message=str(e))

        return ToolSuccess(content=(
            f"schedule_id={sid}\n"
            f"fires_in_sec={payload.delay_sec}\n"
            f"reason: {payload.reason}\n"
            f"prompt: {payload.prompt}"
        ))
