"""ScheduleTool — operator agent 자율 schedule 생성/관리 단일 도구.

action 디스패치:
  - create    : prompt + cron_expr → schedule row 생성
  - list      : 현재 schedule 목록
  - get       : schedule 1개 + 최근 fire 들
  - pause     : status=paused
  - resume    : status=active
  - remove    : 행 삭제
  - update    : prompt / cron_expr / deliver / repeat 변경
  - run_now   : next_run 을 과거로 — 다음 tick 에서 즉시 fire

방어:
- prompt 는 scan_cron_prompt 통과해야 (평문 비번 / injection 차단)
- cron_expr 는 croniter 로 validate
- origin 은 항상 'operator_agent' (이 도구가 호출하니까)
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field

from secu_agent import state
from secu_agent.agent.scheduler import (
    compute_next_run, scan_cron_prompt, validate_cron_expr,
)
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


# de-domain (v3.81 T4): agent_type 는 string + agent_type_registry 런타임 검증 —
# 도메인 agent_type 는 plugin 재부착이 register_agent_type 로 등록.
_DELIVER = Literal["chat", "silent"]
_ACTION = Literal["create", "list", "get", "pause", "resume",
                  "remove", "update", "run_now"]


class ScheduleInput(BaseModel):
    action: _ACTION
    # create / update 용
    agent_type: str | None = Field(None, max_length=64)
    prompt: str | None = Field(None, max_length=4000)
    cron_expr: str | None = Field(None, max_length=200)
    deliver: _DELIVER | None = None
    repeat: int | None = Field(None, ge=1, le=10_000,
                               description="이 횟수만큼 fire 후 자동 paused")
    charter_ref: str | None = Field(None, max_length=200)
    # 식별
    schedule_id: int | None = None
    # list 필터
    agent_type_filter: str | None = Field(None, max_length=64)
    status_filter: Literal["active", "paused"] | None = None


def _fmt_row(r: dict[str, Any]) -> str:
    status = r["status"]
    rep = r.get("repeat")
    rep_s = f"{r['fire_count']}/{rep}" if rep else f"{r['fire_count']}/∞"
    nxt = r.get("next_run") or 0
    nxt_iso = (
        time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(nxt))
        if nxt else "-"
    )
    return (
        f"  - id={r['id']} agent_type={r['agent_type']} status={status} "
        f"cron='{r['cron_expr']}' next={nxt_iso} fires={rep_s} "
        f"deliver={r['deliver']}\n"
        f"      prompt: {r['prompt'][:120]}"
    )


class ScheduleTool(Tool[ScheduleInput]):
    name: ClassVar[str] = "schedule"
    description: ClassVar[str] = (
        "자율 schedule (cron job) 생성/관리. 단일 도구로 action 디스패치.\n"
        "사용 예:\n"
        "  - agent 전체 작업 재개/점검: action='create' agent_type='agent' "
        "prompt='지정된 범위의 발견 정보를 갱신하고 필요한 도메인 리포트를 작성해줘' cron_expr='0 * * * *'\n"
        "  - 특정 도메인 정기 점검: action='create' agent_type='<domain>' "
        "prompt='해당 도메인 skill 절차에 따라 pending 대상을 점검하고 보고해줘' cron_expr='0 * * * *'\n"
        "  - 매일 새벽 3시 finding 요약: cron_expr='0 3 * * *'\n"
        "  - 일회성 (10분 뒤): action='create' + repeat=1 + 임시 cron_expr\n"
        "actions: create | list | get | pause | resume | remove | update | run_now\n"
        "보안: prompt 안에 평문 비번 (password=...), 'ignore previous instructions' 같은 "
        "injection 시도는 거부. 자격증명은 'env:VAR_NAME' 형태로만 언급."
    )
    input_model: ClassVar[type[BaseModel]] = ScheduleInput
    is_read_only: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "자동", "매시간", "매일", "정기적으로",
    )
    prompt_section: ClassVar[str] = (
        "### schedule(action, ...)\n"
        "**자율 cron job 생성/관리.** 사용자가 \"매시간 자동으로\", \"매일 새벽에\" 같은 "
        "정기 작업을 요청하면 너가 직접 schedule 만든다. "
        "background tick (1분 주기) 이 due 인 schedule 의 prompt 를 sub-ChatSession 으로 실행.\n"
        "- 만들기: 범용 agent 작업은 `schedule(action=\"create\", agent_type=\"agent\", "
        "prompt=\"지정된 범위의 발견 정보를 갱신하고 추가 분석 리포트를 작성해줘\", "
        "cron_expr=\"0 * * * *\")`; 특정 도메인에 한정된 작업은 해당 agent_type 사용.\n"
        "- 특정 도메인 prompt 에는 해당 skill 에서 정의한 용어와 절차를 쓴다.\n"
        "- 보기: `schedule(action=\"list\")` / `schedule(action=\"get\", schedule_id=N)`\n"
        "- 멈추기/재개: `pause` / `resume`. 삭제: `remove`. 수정: `update`. "
        "즉시 실행: `run_now` (다음 1분 tick 에 fire).\n"
        "- cron_expr 예: `\"0 * * * *\"` 매시간, `\"0 3 * * *\"` 매일 새벽 3시, "
        "`\"*/15 * * * *\"` 15분마다.\n"
        "- repeat=N 으로 N번 fire 후 자동 paused. 일회성 일정은 repeat=1.\n"
        "- **남발 금지**: 운영자가 명시적 주기 표현 (\"매시간\", \"매일\") 썼을 때만. "
        "막혔다고 schedule 로 도망가지 마라.\n"
        "- **보안**: schedule prompt 안에 평문 비번 / 'ignore previous instructions' 같은 "
        "injection 토큰 넣지 마라 — 거부됨."
    )

    async def execute(self, validated_input: ScheduleInput,
                      context: ToolContext) -> ToolResult:
        a = validated_input.action
        if a == "create":
            return await asyncio.to_thread(self._create, validated_input, context)
        if a == "list":
            return await asyncio.to_thread(self._list, validated_input)
        if a == "get":
            return await asyncio.to_thread(self._get, validated_input)
        if a == "pause":
            return await asyncio.to_thread(self._set_status, validated_input,
                                            "paused")
        if a == "resume":
            return await asyncio.to_thread(self._set_status, validated_input,
                                            "active")
        if a == "remove":
            return await asyncio.to_thread(self._remove, validated_input)
        if a == "update":
            return await asyncio.to_thread(self._update, validated_input)
        if a == "run_now":
            return await asyncio.to_thread(self._run_now, validated_input)
        return ToolError(kind="validation",
                         message=f"unknown action: {a!r}")

    # -------- action handlers --------

    def _create(self, vi: ScheduleInput, context: ToolContext) -> ToolResult:
        if not vi.agent_type:
            return ToolError(kind="validation",
                             message="create: agent_type required")
        from secu_agent.agent_type_registry import valid_agent_types
        if vi.agent_type not in valid_agent_types():
            return ToolError(
                kind="validation",
                message=(
                    f"미등록 agent_type {vi.agent_type!r} — 사용 가능: "
                    f"{', '.join(sorted(valid_agent_types()))} "
                    f"(도메인 agent_type 는 plugin 재부착 시 등록됨)"
                ),
            )
        if not vi.prompt:
            return ToolError(kind="validation",
                             message="create: prompt required")
        if not vi.cron_expr:
            return ToolError(kind="validation",
                             message="create: cron_expr required")

        reason = scan_cron_prompt(vi.prompt)
        if reason:
            return ToolError(
                kind="forbidden",
                message=f"prompt 차단됨: {reason}",
            )
        try:
            validate_cron_expr(vi.cron_expr)
            nxt = compute_next_run(vi.cron_expr)
        except ValueError as e:
            return ToolError(kind="validation",
                             message=f"cron_expr invalid: {e}")

        charter = vi.charter_ref or os.environ.get(
            "DEFAULT_CHARTER_REF", "CHARTER-PLACEHOLDER-001",
        )
        source_session_id = context.metadata.get("session_id")
        if not isinstance(source_session_id, int):
            source_session_id = None
        sid = state.schedule_create(
            agent_type=vi.agent_type,
            prompt=vi.prompt,
            cron_expr=vi.cron_expr,
            next_run=nxt,
            origin="operator_agent",
            deliver=vi.deliver or "chat",
            repeat=vi.repeat,
            charter_ref=charter,
            created_by="operator",
            source_session_id=source_session_id,
        )
        nxt_iso = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(nxt))
        return ToolSuccess(content=(
            f"schedule_id={sid} 생성됨 (agent_type={vi.agent_type} cron='{vi.cron_expr}' "
            f"deliver={vi.deliver or 'chat'} next={nxt_iso} "
            f"repeat={vi.repeat or '∞'})"
        ))

    def _list(self, vi: ScheduleInput) -> ToolResult:
        rows = state.schedule_list(
            agent_type=vi.agent_type_filter, status=vi.status_filter,
        )
        if not rows:
            return ToolSuccess(content="schedule 없음")
        lines = [f"schedules ({len(rows)}):"]
        for r in rows:
            lines.append(_fmt_row(r))
        return ToolSuccess(content="\n".join(lines))

    def _get(self, vi: ScheduleInput) -> ToolResult:
        if not vi.schedule_id:
            return ToolError(kind="validation",
                             message="get: schedule_id required")
        r = state.schedule_get(vi.schedule_id)
        if not r:
            return ToolError(kind="not_found",
                             message=f"schedule_id={vi.schedule_id} not found")
        fires = state.schedule_fires_for(vi.schedule_id, limit=10)
        out = [_fmt_row(r), f"  recent fires ({len(fires)}):"]
        for f in fires:
            fired = time.strftime("%Y-%m-%d %H:%M:%S",
                                  time.localtime(f["fired_at"]))
            out.append(
                f"    - id={f['id']} status={f['status']} fired={fired} "
                f"summary={(f.get('result_summary') or '')[:80]}"
            )
        return ToolSuccess(content="\n".join(out))

    def _set_status(self, vi: ScheduleInput, status: str) -> ToolResult:
        if not vi.schedule_id:
            return ToolError(kind="validation",
                             message=f"{status} action 은 schedule_id 필요")
        if not state.schedule_get(vi.schedule_id):
            return ToolError(kind="not_found",
                             message=f"schedule_id={vi.schedule_id} not found")
        if status == "paused":
            state.schedule_pause(vi.schedule_id)
        else:
            state.schedule_resume(vi.schedule_id)
        return ToolSuccess(content=f"schedule_id={vi.schedule_id} → {status}")

    def _remove(self, vi: ScheduleInput) -> ToolResult:
        if not vi.schedule_id:
            return ToolError(kind="validation",
                             message="remove: schedule_id required")
        if not state.schedule_get(vi.schedule_id):
            return ToolError(kind="not_found",
                             message=f"schedule_id={vi.schedule_id} not found")
        state.schedule_delete(vi.schedule_id)
        return ToolSuccess(content=f"schedule_id={vi.schedule_id} 삭제됨")

    def _update(self, vi: ScheduleInput) -> ToolResult:
        if not vi.schedule_id:
            return ToolError(kind="validation",
                             message="update: schedule_id required")
        if not state.schedule_get(vi.schedule_id):
            return ToolError(kind="not_found",
                             message=f"schedule_id={vi.schedule_id} not found")

        fields: dict[str, Any] = {}
        if vi.prompt is not None:
            reason = scan_cron_prompt(vi.prompt)
            if reason:
                return ToolError(kind="forbidden",
                                 message=f"prompt 차단됨: {reason}")
            fields["prompt"] = vi.prompt
        if vi.cron_expr is not None:
            try:
                validate_cron_expr(vi.cron_expr)
            except ValueError as e:
                return ToolError(kind="validation",
                                 message=f"cron_expr invalid: {e}")
            fields["cron_expr"] = vi.cron_expr
            fields["next_run"] = compute_next_run(vi.cron_expr)
        if vi.deliver is not None:
            fields["deliver"] = vi.deliver
        if vi.repeat is not None:
            fields["repeat"] = vi.repeat
        if vi.charter_ref is not None:
            fields["charter_ref"] = vi.charter_ref
        if not fields:
            return ToolError(kind="validation",
                             message="update: 바꿀 필드가 없음")
        state.schedule_update(vi.schedule_id, **fields)
        return ToolSuccess(content=(
            f"schedule_id={vi.schedule_id} 업데이트: "
            f"{', '.join(fields.keys())}"
        ))

    def _run_now(self, vi: ScheduleInput) -> ToolResult:
        if not vi.schedule_id:
            return ToolError(kind="validation",
                             message="run_now: schedule_id required")
        if not state.schedule_get(vi.schedule_id):
            return ToolError(kind="not_found",
                             message=f"schedule_id={vi.schedule_id} not found")
        # next_run 을 과거로 → 다음 background tick 에서 fire
        state.schedule_update(vi.schedule_id, next_run=time.time() - 1)
        return ToolSuccess(content=(
            f"schedule_id={vi.schedule_id} 다음 tick (≤1분) 에 fire 예정"
        ))
