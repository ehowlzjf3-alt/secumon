"""github_repo_set_status — repo 스캔 워커의 **종료 도구**.

## 왜 이제야 생겼나

`domains/services/github/skills/github_scan/worker.md` 8항이 이 도구를 이름으로
지시하고 있었다:

    github_repo_set_status(target_ids=…, status=…, finding_count=…, reason=…)

그리고 `github_task_scan` 은 이 도구가 읽을 인계 메타데이터를 이미 쓰고 있었다
(`service_task_tools.py:5995-5997`):

    context.metadata["_github_task_scan_status"]
    context.metadata["_github_task_scan_recommended_status"]
    context.metadata["_github_task_scan_status_reason"]

**그런데 도구가 없었다.** 계약은 부르고 생산자는 쓰는데 소비자가 없어서, 저 세 줄은
지금까지 죽은 쓰기였다. 워커도 계약을 안 읽고 `_handle_target()` 을 직접 불러
에이전트 없이 돌았다(2026-08-26 실측: github 3단계 전부 `run_agent` 호출 0).

`ConfluenceSpaceSetStatusTool` 의 미러다 — 큐 테이블과 메타데이터 접두어만 다르다.

## ★ 스캐너의 분류를 워커가 못 덮는다

worker.md 8항이 못박은 계약이다:

> The status tool preserves classified `error`/`skipped` recommendations even if a
> worker mistakenly requests another terminal status.

스캐너가 "이 repo 는 detail fetch 가 전부 비었다(error)" 로 분류했는데 모델이
`tasked` 로 닫으면, **못 본 것을 봤다고 닫는 것**이다. 그러면 큐에서 빠지고 다시
안 온다. 그래서 추천이 error/skipped 면 그쪽이 이긴다.

⚠️ 반대 방향은 막지 않는다 — 스캐너가 `tasked` 를 추천해도 모델은 `error` 로 닫을 수
   있다. 덜 닫는 것은 안전하고, 더 닫는 것만 위험하다.
"""
from __future__ import annotations

import json
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)
from service import state_domain as state
from _shared.queue_ownership import is_delegated_inspector, write_recommendation

#: 큐에서 빼는 상태. `pending` 은 되돌리기라 추천 보존 대상이 아니다.
_TERMINAL_STATUSES = {"tasked", "skipped", "error"}
_VALID = {"tasked", "skipped", "error", "pending"}


class GithubRepoSetStatusInput(BaseModel):
    target_ids: list[int] = Field(
        ..., min_length=1, description="github_repo_target id 목록")
    status: str = Field(..., description="tasked | skipped | error | pending")
    finding_count: int = Field(default=0, ge=0)
    reason: str | None = Field(default=None)


class GithubRepoSetStatusTool(Tool[GithubRepoSetStatusInput]):
    name: ClassVar[str] = "github_repo_set_status"
    domain: ClassVar[str] = "github"
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = True
    input_model: ClassVar[type[BaseModel]] = GithubRepoSetStatusInput
    search_hint: ClassVar[str] = (
        "github repo target status tasked skipped error rolling sweep close claim"
    )
    description: ClassVar[str] = (
        "repo 스캔을 끝낸 target 의 상태 전이(tasked/skipped/error). github_task_scan 뒤에 "
        "claim 된 target_ids 를 닫아 큐에서 빼고 cooldown 후 재스윕되게 한다. "
        "접근불가/메타 없음은 'skipped', 스캔이 불완전하면 'error'."
    )

    async def execute(
        self, validated_input: GithubRepoSetStatusInput, context: ToolContext,
    ) -> ToolResult:
        try:
            target_ids = [int(tid) for tid in validated_input.target_ids]
        except (TypeError, ValueError):
            return ToolError(kind="validation", message="target_ids must be integers")

        targets: dict[int, dict[str, Any]] = {}
        missing: list[int] = []
        for tid in target_ids:
            target = state.github_repo_target_get(tid)
            if target is None:
                missing.append(tid)
                continue
            targets[tid] = target
        if missing:
            return ToolError(
                kind="not_found",
                message=f"github_repo_target not found: {missing}",
            )

        status = validated_input.status
        reason = validated_input.reason
        metadata = context.metadata or {}

        if status in _VALID and status != "pending":
            # 스캔 도구가 돌았다면 그 분류가 있다. 있는데 종료값이 아니면 닫지 않는다 —
            # "스캔이 무슨 상태인지 모르는 채 닫기" 를 막는 가드다.
            scan_metadata_present = any(
                key in metadata
                for key in (
                    "_github_task_scan_status",
                    "_github_task_scan_recommended_status",
                    "_github_task_scan_status_reason",
                )
            )
            recommended = str(
                metadata.get("_github_task_scan_recommended_status") or "",
            ).strip()
            if scan_metadata_present and recommended not in _TERMINAL_STATUSES:
                return ToolError(
                    kind="validation",
                    message=(
                        "invalid github_task_scan recommended status "
                        f"{recommended or 'missing'!r}; refusing to close target"
                    ),
                )
            if recommended in {"error", "skipped"}:
                status = recommended
                reason = str(
                    metadata.get("_github_task_scan_status_reason") or "",
                ) or reason

        if status not in _VALID:
            return ToolError(
                kind="validation",
                message=f"invalid status {validated_input.status!r} — {sorted(_VALID)}",
            )

        # 큐 소유권(Phase 2): 위임된 검토원은 닫지 않는다 — 리드가 닫는다.
        if is_delegated_inspector():
            payload = write_recommendation(
                context.evidence_dir, target_ids=target_ids, status=status,
                finding_count=validated_input.finding_count, reason=reason,
                requested_status=validated_input.status,
                queue="github_repo_target",
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))

        n = 0
        for tid in target_ids:
            fields: dict[str, Any] = {"finding_count": validated_input.finding_count}
            if reason:
                fields["last_reason"] = reason[:500]
            try:
                state.github_repo_target_set_status(tid, status, **fields)
                n += 1
            except Exception:  # noqa: BLE001 — 개별 id 실패는 건너뜀
                continue

        # ── commit dedup 커서 전진 ────────────────────────────────────────────
        #
        # `github_task_scan` 은 이제 커서를 **직접 전진시키지 않는다**. 후보만 돌려주고
        # 등록은 에이전트가 하기 때문에, 스캔 시점의 전진은 "제출이 거부돼도 그 커밋을
        # 다시 안 본다" 를 뜻했다 — 오늘 진짜 시크릿 하나가 그렇게 사라졌다.
        #
        # 여기서 전진시킨다: target 을 실제로 닫는 시점이고, 그 시점이면 워커가 후보를
        # 제출했거나 기각했다. 워커가 죽으면 metadata 와 함께 사라져 전진하지 않는다.
        #
        # ⚠️ `error` 로 닫을 때는 전진시키지 않는다 — 스캔이 불완전했다는 뜻이므로
        #    그 커밋들을 다시 봐야 한다. `pending` 은 애초에 여기 도달하지 않는다.
        # ⚠️ 세 가지를 지킨다 (codex 적대검증 2026-08-27):
        #   ① 실제로 닫힌 target 이 있을 때만 전진한다(`n > 0`). 상태 변경이 전부
        #      실패했는데 커서만 전진하면 그 커밋을 다시 못 본다.
        #   ② **이번에 닫은 target 의 repo 만** 전진한다. 무관한 target 하나를 닫았다고
        #      pending 에 있는 모든 repo 커서를 밀면 안 된다.
        #   ③ `pending` 은 스캔 도구가 호출마다 덮어쓰므로, 여기서 본 것만 처리한다.
        advanced = 0
        if status in {"tasked", "skipped"} and n > 0:
            pending = metadata.get("_github_pending_scanned_sha")
            closed_repos = {
                str(targets[tid].get("repo") or "").strip()
                for tid in target_ids if tid in targets
            }
            closed_repos.discard("")
            if isinstance(pending, dict):
                for repo_name, sha in pending.items():
                    name = str(repo_name or "").strip()
                    if not name or not sha or name not in closed_repos:
                        continue
                    try:
                        state.github_repo_set_scanned_sha(name, str(sha))
                        advanced += 1
                    except Exception:  # noqa: BLE001 — 커서 실패가 종료를 막지 않는다
                        continue

        suffix = ""
        if status != validated_input.status:
            suffix = f" (requested {validated_input.status}; scan recommended {status})"
        if advanced:
            suffix += f" commit cursor {advanced}건 전진."
        return ToolSuccess(content=f"github_repo_target {n}개 → {status}.{suffix}")
