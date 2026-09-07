"""dev_web reverify persistence tool."""
from __future__ import annotations

import json
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess

from service import state_domain as state


class DevWebRecordReverifyInput(BaseModel):
    thread_id: int
    verdict: str = Field(..., description="remediated|still_exposed|partial|inconclusive|error")
    evidence_ref: str | None = Field(default=None, max_length=1000)
    reason: str | None = Field(default=None, max_length=1000)
    verification: dict[str, Any] = Field(default_factory=dict)


class DevWebRecordReverifyTool(Tool[DevWebRecordReverifyInput]):
    name: ClassVar[str] = "dev_web_record_reverify_result"
    domain: ClassVar[str] = "dev_web"
    input_model: ClassVar[type[BaseModel]] = DevWebRecordReverifyInput
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "dev_web reverify result remediation status"
    description: ClassVar[str] = (
        "dev_web 재검증 결과를 dev_web_recheck_result에 기록하고 report thread 상태를 전이한다."
    )

    async def execute(self, vi: DevWebRecordReverifyInput, ctx: ToolContext) -> ToolResult:
        thread = state.dev_web_report_thread_get(vi.thread_id)
        if not thread:
            return ToolError(kind="not_found", message=f"thread_id={vi.thread_id} 없음")
        verdict = vi.verdict.strip().lower()
        if verdict not in {"remediated", "still_exposed", "partial", "inconclusive", "error"}:
            return ToolError(kind="validation", message=f"invalid verdict: {vi.verdict!r}")
        rid = state.dev_web_recheck_result_add(
            thread_id=vi.thread_id,
            target_id=thread.get("target_id"),
            finding_id=thread.get("finding_id"),
            domain=str(thread.get("domain") or ""),
            url=str(thread.get("url") or ""),
            verdict=verdict,
            verification_json=vi.verification,
            evidence_ref=vi.evidence_ref,
            error=vi.reason if verdict == "error" else None,
        )
        if verdict == "remediated":
            next_status = "remediated"
            if thread.get("finding_id"):
                try:
                    from secu_agent import state as core_state

                    # ⚠️ 윗줄 `next_status = "remediated"` 와 같은 말이어야 한다.
                    #    엔진 어휘에 "resolved" 는 없다 — ValueError 를 아래 except 가
                    #    삼켜서 6주간 finding 이 open 에 머물렀다(2026-08-28 발견).
                    core_state.finding_update(int(thread["finding_id"]), status="remediated")
                except Exception:  # noqa: BLE001
                    pass
            if thread.get("target_id"):
                state.dev_web_target_set_status(
                    int(thread["target_id"]),
                    "tasked",
                    last_reason="remediated",
                )
        elif verdict == "partial":
            next_status = "partially_remediated"
        elif verdict == "still_exposed":
            next_status = "re_requested"
        elif verdict == "inconclusive":
            next_status = "exception_review"
        else:
            next_status = "re_requested"
        state.dev_web_report_thread_set_status(
            vi.thread_id,
            next_status,
            last_reason=vi.reason,
        )
        return ToolSuccess(content=json.dumps({
            "kind": "dev_web_reverify_result",
            "result_id": rid,
            "thread_id": vi.thread_id,
            "verdict": verdict,
            "next_status": next_status,
        }, ensure_ascii=False))
