"""dev_web discovery and target status tools."""
from __future__ import annotations

import datetime as dt
import json
import re
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    ToolSuccess,
)

from domains.dev_web.application.discovery import (
    DevWebDiscoveryConfig,
    build_discovery_spl,
    ingest_discovery_rows,
)
from service import state_domain as state
from _shared.queue_ownership import is_delegated_inspector, write_recommendation


class DevWebTargetSetStatusInput(BaseModel):
    target_id: int
    status: str = Field(..., description="pending|in_progress|tasked|skipped|error")
    finding_count: int | None = Field(default=None, ge=0)
    reason: str | None = Field(default=None, max_length=300)
    evidence_ref: str | None = Field(default=None, max_length=1000)


class DevWebTargetSetStatusTool(Tool[DevWebTargetSetStatusInput]):
    name: ClassVar[str] = "dev_web_target_set_status"
    domain: ClassVar[str] = "dev_web"
    input_model: ClassVar[type[BaseModel]] = DevWebTargetSetStatusInput
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "dev_web target status mark tasked skipped"
    description: ClassVar[str] = "dev_web_target status와 finding_count/reason/evidence_ref를 갱신한다."

    async def execute(self, vi: DevWebTargetSetStatusInput, ctx: ToolContext) -> ToolResult:
        target = state.dev_web_target_get(vi.target_id)
        if target is None:
            return ToolError(kind="not_found", message=f"dev_web_target not found: {vi.target_id}")
        fields: dict[str, Any] = {}
        if vi.finding_count is not None:
            fields["finding_count"] = vi.finding_count
        if vi.reason is not None:
            fields["last_reason"] = vi.reason
        if vi.evidence_ref is not None:
            fields["evidence_ref"] = vi.evidence_ref
        # 큐 소유권(Phase 2): 위임된 검토원은 닫지 않는다 — 리드가 닫는다.
        if is_delegated_inspector():
            payload = write_recommendation(
                ctx.evidence_dir, target_ids=[vi.target_id], status=vi.status,
                finding_count=vi.finding_count, reason=vi.reason,
                evidence_ref=vi.evidence_ref, queue="dev_web_target",
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))
        try:
            state.dev_web_target_set_status(vi.target_id, vi.status, **fields)
        except ValueError as e:
            return ToolError(kind="validation", message=str(e))
        return ToolSuccess(content=json.dumps({
            "kind": "dev_web_target_status",
            "target_id": vi.target_id,
            "status": vi.status,
            **fields,
        }, ensure_ascii=False))
