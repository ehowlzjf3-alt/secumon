# [REORG 3축=P/G] enum(cf.list_spaces)은 confluence API 라이드(P), status setter·큐 upsert 는
#   generic state CRUD(G). TODO: discovery 절차를 domains/services/confluence/SKILL.md 흡수.
"""v3.76: RunConfluenceSpaceDiscoveryTool — 전사 confluence space enum → rolling 스윕 큐.

github_repo_discovery_tool.py 의 near-exact 미러. 토큰이 보는 모든 space(`cf.list_spaces`)를
`confluence_space_target` 에 upsert. 신규 space 는 '한 번도 안 봄'(last_scanned_at NULL)으로
큐 head 에 들어가고, 이후 "confluence 점검" 이 oldest-first API 스윕(+SSO 교대)한다.
bounded — space당 1 row.
"""
from __future__ import annotations

import asyncio
import json
from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)
from service import state_domain as state
from _shared.queue_ownership import is_delegated_inspector, write_recommendation

_TERMINAL_STATUSES = {"tasked", "skipped", "error"}


class ConfluenceSpaceSetStatusInput(BaseModel):
    target_ids: list[int] = Field(
        ..., min_length=1, description="confluence_space_target id 목록")
    status: str = Field(..., description="tasked | skipped | error | pending")
    finding_count: int = Field(default=0, ge=0)
    reason: str | None = Field(default=None)


class ConfluenceSpaceSetStatusTool(Tool[ConfluenceSpaceSetStatusInput]):
    name: ClassVar[str] = "confluence_space_set_status"
    domain: ClassVar[str] = "confluence"
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = True
    input_model: ClassVar[type[BaseModel]] = ConfluenceSpaceSetStatusInput
    search_hint: ClassVar[str] = (
        "confluence space target status tasked skipped rolling sweep"
    )
    description: ClassVar[str] = (
        "API space 스윕에서 스캔한 space 들의 상태 전이(tasked/skipped/error). "
        "confluence_task_scan 후 claim 된 target_ids 를 'tasked'(접근불가/404 는 'skipped')로 "
        "마킹 → 큐에서 빠지고 cooldown 후 재스윕. driver 가 다음 배치를 준다."
    )

    async def execute(
        self, validated_input: ConfluenceSpaceSetStatusInput, context: ToolContext,
    ) -> ToolResult:
        valid = {"tasked", "skipped", "error", "pending"}
        try:
            target_ids = [int(tid) for tid in validated_input.target_ids]
        except (TypeError, ValueError):
            return ToolError(kind="validation", message="target_ids must be integers")
        targets: dict[int, dict] = {}
        missing: list[int] = []
        for tid in target_ids:
            target = state.confluence_space_target_get(tid)
            if target is None:
                missing.append(tid)
                continue
            targets[tid] = target
        if missing:
            return ToolError(
                kind="not_found",
                message=f"confluence_space_target not found: {missing}",
            )
        status = validated_input.status
        reason = validated_input.reason
        metadata = context.metadata or {}
        space_statuses_raw = metadata.get("_confluence_task_scan_space_statuses") or {}
        space_statuses = space_statuses_raw if isinstance(space_statuses_raw, dict) else {}
        per_space = {
            str(space_key or "").strip().lower(): value
            for space_key, value in space_statuses.items()
            if isinstance(value, dict)
        }
        if status in valid and status != "pending":
            scan_metadata_present = any(
                key in metadata
                for key in (
                    "_confluence_task_scan_status",
                    "_confluence_task_scan_recommended_status",
                    "_confluence_task_scan_status_reason",
                    "_confluence_task_scan_space_statuses",
                )
            )
            recommended = str(
                metadata.get("_confluence_task_scan_recommended_status") or "",
            ).strip()
            if scan_metadata_present and recommended not in _TERMINAL_STATUSES:
                return ToolError(
                    kind="validation",
                    message=(
                        "invalid confluence_task_scan recommended status "
                        f"{recommended or 'missing'!r}; refusing to close target"
                    ),
                )
            if recommended in {"error", "skipped"}:
                status = recommended
                reason = str(
                    metadata.get("_confluence_task_scan_status_reason") or "",
                ) or reason
        if status not in valid:
            return ToolError(
                kind="validation",
                message=f"invalid status {validated_input.status!r} — {sorted(valid)}",
            )
        # 큐 소유권(Phase 2): 위임된 검토원은 닫지 않는다 — 리드가 닫는다.
        if is_delegated_inspector():
            payload = write_recommendation(
                context.evidence_dir, target_ids=target_ids, status=status,
                finding_count=validated_input.finding_count, reason=reason,
                requested_status=validated_input.status,
                queue="confluence_space_target",
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))
        n = 0
        status_counts: dict[str, int] = {}
        for tid in target_ids:
            target = targets[tid]
            item_status = status
            item_reason = reason
            item_finding_count = validated_input.finding_count
            if status != "pending":
                space_key = str(target.get("space_key") or "").strip().lower()
                per = per_space.get(space_key)
                if per:
                    per_status = str(per.get("status") or "").strip()
                    if per_status in valid and per_status != "pending":
                        item_status = per_status
                        item_reason = str(per.get("reason") or "").strip() or item_reason
                        try:
                            item_finding_count = int(per.get("finding_count") or 0)
                        except (TypeError, ValueError):
                            item_finding_count = 0
            fields: dict = {"finding_count": item_finding_count}
            if item_reason:
                fields["last_reason"] = item_reason[:500]
            try:
                state.confluence_space_target_set_status(
                    tid, item_status, **fields)
                n += 1
                status_counts[item_status] = status_counts.get(item_status, 0) + 1
            except Exception:  # noqa: BLE001 — 개별 id 실패는 건너뜀
                continue
        suffix = ""
        if status != validated_input.status:
            suffix = f" (requested {validated_input.status}; scan recommended {status})"
        if len(status_counts) > 1:
            suffix = f"{suffix} per-space={status_counts}"
        return ToolSuccess(
            content=f"confluence_space_target {n}개 → {status}.{suffix}",
        )
