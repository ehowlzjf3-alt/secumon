# [REORG 3축=G/P] discovery 절차(splunk SPL → URL normalize → state upsert)는
#   generic web fetch + regex + state CRUD 로 재현 가능(G). splunk MCP 의존만 외부(P).
#   TODO: domains/services/SKILL.md 흡수.
"""v3.61 D2: RunDevopsDiscoveryTool — hq_prx_* 프록시로그 → DevOps 점검 타깃 적재.

사내 github.samsungds.net / confluence.samsungds.net 트래픽을 프록시로그(index=hq_prx_*)
에서 경로레벨로 뽑아(실측: full URL 이 _raw 에 있음) repo/space 단위로 정규화 →
devops_target 에 upsert. web-batch driver 와 동일한 단일타깃 점검을 위한 디스커버리.

실제 점검 접근은 MWG 우회 직결(v3.45) — 프록시 경유 시 samsungds.net 403 Block.
"""
from __future__ import annotations

import json
import os
import time
from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)
from domains.services.application.devops_discovery import (
    DevopsDiscoveryConfig,
    build_devops_discovery_spl,
    ingest_devops_discovery_rows,
    normalize_devops_url,
)
from service import state_domain as state
from _shared.queue_ownership import is_delegated_inspector, write_recommendation

_TERMINAL_STATUSES = {"tasked", "skipped", "error"}

# 우리 토큰으로 읽을 수 없다고 **판명된** 타깃의 사유 지문.
# 프록시 로그는 "누가 방문한 URL"이라 GitHub API 를 안 부르므로 private repo 도 등재된다
# (전수 481건이 source='proxy'). 그 결과 접근불가 270건 중 180건이 cooldown/주간 리셋마다
# pending 으로 되돌아와 무한 재순환했다 — 워커가 계속 물고 계속 실패한다.
_NO_ACCESS_REASON_MARKERS = (
    "repo metadata not found",
    "no_access",
    # 범위 밖(private/제외목록)도 재시도 가치가 같다 — 상태가 바뀌기 전엔 다시 봐야 소용없다.
    "out_of_scope",
)


def _no_access_reason(reason: str | None) -> bool:
    text = str(reason or "").lower()
    return any(marker in text for marker in _NO_ACCESS_REASON_MARKERS)


def _no_access_backoff_seconds() -> float:
    """접근불가 판명 타깃을 언제 다시 볼 것인가. 기본 30일.

    **영구 제외는 틀렸다** — 권한이 부여되거나 repo 가 internal 로 바뀌면 읽히게 된다.
    그래서 제외가 아니라 긴 백오프다. 0 이면 백오프 없음(기존 동작).
    """
    try:
        value = float((os.environ.get("SA_DEVOPS_NO_ACCESS_BACKOFF_SEC") or "").strip())
    except ValueError:
        return 30 * 86400.0
    return value if value >= 0 else 30 * 86400.0


class DevopsTargetSetStatusInput(BaseModel):
    target_id: int = Field(..., description="devops_target id")
    status: str = Field(..., description="tasked | skipped | error")
    finding_count: int | None = None
    reason: str | None = None


class DevopsTargetSetStatusTool(Tool[DevopsTargetSetStatusInput]):
    name: ClassVar[str] = "devops_target_set_status"
    domain: ClassVar[str] = "devops"
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = True
    input_model: ClassVar[type[BaseModel]] = DevopsTargetSetStatusInput
    search_hint: ClassVar[str] = "devops target status tasked skipped done"
    description: ClassVar[str] = (
        "DevOps 점검 타깃 상태 전이 (tasked/skipped/error). devops-batch driver 가 다음 "
        "대상 주입 전 호출 — claim 자동 해제."
    )

    @staticmethod
    def _scan_status_metadata(
        *,
        metadata: dict,
        service: str,
    ) -> tuple[str, str, str | None]:
        service_key = str(service or "").strip().lower()
        if service_key not in {"github", "confluence"}:
            return "", "", None
        prefix = f"_{service_key}_task_scan"
        scan_metadata_present = any(
            key in metadata
            for key in (
                f"{prefix}_status",
                f"{prefix}_recommended_status",
                f"{prefix}_status_reason",
            )
        )
        recommended = str(
            metadata.get(f"{prefix}_recommended_status") or "",
        ).strip()
        if scan_metadata_present and recommended not in _TERMINAL_STATUSES:
            return "", "", (
                f"invalid {service_key}_task_scan recommended status "
                f"{recommended or 'missing'!r}; refusing to close target"
            )
        if recommended not in {"error", "skipped"}:
            return "", "", None
        reason = str(metadata.get(f"{prefix}_status_reason") or "").strip()
        return recommended, reason, None

    async def execute(self, vi: DevopsTargetSetStatusInput, ctx: ToolContext) -> ToolResult:
        target = state.devops_target_get(vi.target_id)
        if target is None:
            return ToolError(
                kind="not_found",
                message=f"devops_target not found: {vi.target_id}",
            )
        status = vi.status
        reason = vi.reason
        if status in {"tasked", "skipped", "error"}:
            recommended, scan_reason, scan_error = self._scan_status_metadata(
                metadata=ctx.metadata or {},
                service=str(target.get("service") or ""),
            )
            if scan_error:
                return ToolError(kind="validation", message=scan_error)
            if recommended:
                status = recommended
                reason = scan_reason or reason
        fields: dict = {}
        if vi.finding_count is not None:
            fields["finding_count"] = vi.finding_count
        if reason is not None:
            fields["last_reason"] = reason
        # 접근불가로 판명된 타깃은 긴 백오프를 걸어 재순환을 끊는다. 이걸 안 하면 claim 쿼리의
        # "terminal row 도 cooldown 지나면 재헌트" 규칙에 걸려 못 읽는 repo 를 영원히 다시 문다.
        backoff = _no_access_backoff_seconds()
        no_access = _no_access_reason(reason) and status == "skipped" and backoff > 0
        if no_access:
            fields["retry_after"] = time.time() + backoff
        # 큐 소유권(Phase 2): 위임된 검토원은 닫지 않는다 — 리드가 닫는다.
        # 가드를 정규화(_scan_status_metadata / no_access 백오프) **뒤에** 둔 이유:
        # 리드가 받는 권고는 검토원이 실제로 쓰려던 값이어야 한다(요청값이 아니라).
        if is_delegated_inspector():
            payload = write_recommendation(
                ctx.evidence_dir, target_ids=[vi.target_id], status=status,
                finding_count=vi.finding_count, reason=reason,
                requested_status=vi.status, no_access=no_access,
                queue="devops_target",
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))
        try:
            state.devops_target_set_status(vi.target_id, status, **fields)
        except ValueError as e:
            return ToolError(kind="validation", message=str(e))
        suffix = ""
        if status != vi.status:
            suffix = f" (requested {vi.status}; scan recommended {status})"
        if no_access:
            suffix += f" [no_access: {int(backoff // 86400)}d 후 재시도]"
        return ToolSuccess(content=f"devops_target {vi.target_id} → {status}.{suffix}")
