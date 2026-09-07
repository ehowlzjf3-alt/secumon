"""SubmitTaskResultTool — generic sub-agent 의 terminal 도구.

agent_result.json 박고 종료. AgentTool 이 이걸 읽어서 operator 에 본문 반환.
"""
from __future__ import annotations

import json as _json
from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


class SubmitTaskResultInput(BaseModel):
    summary: str = Field(..., min_length=1, max_length=2000)
    severity: str = Field("informational", max_length=20,
                          description="critical/high/medium/low/informational")
    findings_count: int = Field(0, ge=0)
    follow_up_actions: list[str] = Field(default_factory=list, max_length=20)
    details: dict = Field(default_factory=dict,
                          description="추가 메타 — operator 에 그대로 노출")


class SubmitTaskResultTool(Tool[SubmitTaskResultInput]):
    name: ClassVar[str] = "submit_task_result"
    description: ClassVar[str] = (
        "TERMINAL — sub-agent 의 종료 도구.\n"
        "evidence_dir/agent_result.json 에 result 박고 sub-agent 종료.\n"
        "한 번 호출하면 agent loop 종료. summary 는 운영자에게 그대로 노출."
    )
    input_model: ClassVar[type[BaseModel]] = SubmitTaskResultInput
    is_read_only: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    prompt_section: ClassVar[str] = (
        "### submit_task_result(summary, severity, findings_count, follow_up_actions, details)\n"
        "**TERMINAL** — sub-agent 종료. 마지막 turn 에 호출.\n"
        "- summary: 운영자에게 보여줄 한국어 요약 (≤2000자)\n"
        "- severity: critical/high/medium/low/informational\n"
        "- findings_count: 박은 finding 개수\n"
        "- follow_up_actions: 기업 보안 후속 액션 list\n"
        "- details: 임의 dict — share_id / file_id 별 결과 등"
    )

    async def execute(self, vi: SubmitTaskResultInput,
                      ctx: ToolContext) -> ToolResult:
        result = {
            "summary": vi.summary,
            "severity": vi.severity,
            "findings_count": vi.findings_count,
            "follow_up_actions": vi.follow_up_actions,
            "details": vi.details,
        }
        try:
            path = ctx.evidence_dir / "agent_result.json"
            path.write_text(_json.dumps(result, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        except OSError as e:
            return ToolError(kind="execution",
                             message=f"agent_result.json write 실패: {e!r}")
        return ToolSuccess(content=(
            f"task result submitted: severity={vi.severity}, "
            f"findings={vi.findings_count}, follow_up={len(vi.follow_up_actions)}"
        ))
