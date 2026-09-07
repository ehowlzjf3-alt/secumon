"""smb_reverify_walk — 조치 주장 후 실제 재검증 (smb_domain_e2e 요구 9).

finding 의 **이전 노출 share/path 만 좁게** 재검증한다(신규 prefix-filter — walk_share 에
path-scope 인자 없음). "실제 닫혔는지"는 LLM 이 아니라 이 코드가 결정한다.

KEEP 불변식:
- HOST claim (`smb_host_claim`, file-level 금지 — 다중로그인 lockout 회피).
- `_AUTH_DISABLED_REASON` set 이면 abort(reset 호출 안 함).
- **3모드 전부 테스트**(null/guest/auth). auth-read 는 DSSOC 검증 계정 접근 가능 상태이므로 still_open.
- read-only.

반환: still_open | now_closed | partially_closed (+ 모드별 접근 상세).
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


class SmbReverifyInput(BaseModel):
    host: str
    share: str = Field(..., description="재검증할 공유 이름.")
    path_prefix: str = Field(
        "", description="이전 노출 경로 prefix(share-root 기준). 비우면 share 루트 전체.",
    )
    finding_id: int | None = Field(None, description="선택: 관련 finding_lifecycle.id (추적).")
    max_files: int = Field(500, ge=1, le=5000)


def _access_summary(modes: dict[str, dict[str, bool]]) -> dict[str, Any]:
    """3모드 read/write 요약 + 위험 해석(auth-read이면 still 노출)."""
    null_r = bool((modes.get("null") or {}).get("read"))
    guest_r = bool((modes.get("guest") or {}).get("read"))
    auth_r = bool((modes.get("auth") or {}).get("read"))
    any_write = any((m or {}).get("write") for m in modes.values())
    # KEEP 5: auth-read 는 DSSOC 검증 계정 접근 가능 상태이므로 노출로 간주.
    still_open = null_r or guest_r or auth_r or any_write
    return {
        "null_read": null_r, "guest_read": guest_r, "auth_read": auth_r,
        "any_write": any_write, "still_readable": still_open,
    }


class SmbReverifyWalkTool(Tool[SmbReverifyInput]):
    name: ClassVar[str] = "smb_reverify_walk"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "smb reverify walk remediation closed still open 재검증"
    description: ClassVar[str] = (
        "조치 주장 후 finding 의 이전 노출 share/path 를 좁게 재검증한다(read-only). "
        "HOST claim·3모드(null/guest/auth) 전부 테스트·lockout 존중. "
        "auth-read 만 남아도 DSSOC 검증 계정 접근 가능 상태이므로 still_open 으로 본다. "
        "반환: verdict=still_open|now_closed|partially_closed."
    )
    input_model: ClassVar[type[BaseModel]] = SmbReverifyInput

    async def execute(self, vi: SmbReverifyInput, ctx: ToolContext) -> ToolResult:
        from domains.smb.plugin.agent_types import smb
        from service import state_domain as state

        if smb._AUTH_DISABLED_REASON:
            return ToolError(
                kind="forbidden",
                message=f"SMB auth locked out — reverify abort. reason: {smb._AUTH_DISABLED_REASON}",
            )

        # HOST claim (file-level 금지 — KEEP 2). 재검증 sentinel session.
        # claim 실패/예외여도 read-only 재검증은 진행(다른 세션이 host 점유 중일 수 있음).
        try:
            claim = await asyncio.to_thread(
                state.smb_host_claim, host=vi.host, session_id=_REVERIFY_SESSION_ID,
            )
        except Exception:  # noqa: BLE001 — claim 실패는 재검증을 막지 않음
            claim = None
        communication_retry_reason: str | None = None
        try:
            # 1) 3모드 접근 재측정.
            try:
                mm = await asyncio.to_thread(smb.list_shares_modes, vi.host)
            except Exception as e:  # noqa: BLE001
                if smb.is_communication_unavailable(e):
                    communication_retry_reason = f"list_shares_modes communication unavailable: {e!r}"
                    return await _schedule_communication_retry(
                        state=state,
                        host=vi.host,
                        share=vi.share,
                        path_prefix=vi.path_prefix,
                        finding_id=vi.finding_id,
                        reason=communication_retry_reason,
                    )
                return ToolError(kind="execution", message=f"list_shares_modes 실패: {e!r}")

            if smb.host_communication_unavailable(mm):
                communication_retry_reason = f"SMB communication unavailable: {mm.login_errors}"
                return await _schedule_communication_retry(
                    state=state,
                    host=vi.host,
                    share=vi.share,
                    path_prefix=vi.path_prefix,
                    finding_id=vi.finding_id,
                    reason=communication_retry_reason,
                )

            share_access = None
            for sa in mm.shares:
                if sa.share == vi.share:
                    share_access = sa
                    break

            if share_access is None:
                # 공유가 더 이상 안 보임 = 닫힘(혹은 권한 제거).
                verdict = "now_closed"
                access = {"null_read": False, "guest_read": False, "auth_read": False,
                          "any_write": False, "still_readable": False}
                files_visible = 0
            else:
                access = _access_summary(share_access.modes)
                # 2) prefix 범위 파일 존재 재확인 (read 가능할 때만).
                files_visible = 0
                if access["still_readable"]:
                    try:
                        prefix = vi.path_prefix.strip("/")
                        for f in smb.walk_share(vi.host, vi.share, max_files=vi.max_files):
                            if not prefix or f.path.startswith(prefix):
                                files_visible += 1
                    except Exception as e:  # noqa: BLE001 — walk 실패해도 접근판정은 유효
                        if smb.is_communication_unavailable(e):
                            communication_retry_reason = f"walk communication unavailable: {e!r}"
                            return await _schedule_communication_retry(
                                state=state,
                                host=vi.host,
                                share=vi.share,
                                path_prefix=vi.path_prefix,
                                finding_id=vi.finding_id,
                                reason=communication_retry_reason,
                            )
                        files_visible = -1
                if not access["still_readable"]:
                    verdict = "now_closed"
                elif vi.path_prefix and files_visible == 0:
                    # 접근은 되나 해당 경로 파일이 사라짐 = 부분 조치.
                    verdict = "partially_closed"
                else:
                    verdict = "still_open"
        finally:
            # claim 해제 (reset_auth_lockout_flag 는 호출 안 함 — KEEP).
            if claim is not None:
                try:
                    if communication_retry_reason:
                        await asyncio.to_thread(
                            state.smb_host_schedule_communication_retry,
                            vi.host,
                            reason=communication_retry_reason,
                            status="pending",
                        )
                    else:
                        await asyncio.to_thread(
                            state.smb_host_set_status, vi.host, "triaged_completed",
                        )
                except Exception:  # noqa: BLE001
                    pass

        # verdict 를 finding 의 mail_thread 에 영속 → #3 드라이버가 structured result 로
        # remediated / partially_remediated / awaiting_reply 를 결정한다.
        if vi.finding_id is not None:
            try:
                for t in state.mail_thread_find_by_subject_tag(_subject_tag(vi.host)):
                    fids = state.mail_thread_finding_ids(int(t["id"])) or [
                        int(t.get("finding_id") or 0)
                    ]
                    if int(vi.finding_id) in fids:
                        await asyncio.to_thread(
                            state.mail_reverify_result_add,
                            thread_id=int(t["id"]),
                            finding_id=int(vi.finding_id),
                            share=vi.share,
                            path_prefix=vi.path_prefix,
                            verdict=verdict,
                            access=access,
                            files_visible=files_visible,
                        )
                        await asyncio.to_thread(
                            state.mail_thread_set_status, t["id"], "reverifying",
                            last_reason=f"reverify:{verdict}",
                            claimed_by=t.get("claimed_by"), claimed_at=t.get("claimed_at"),
                        )
                        break
            except Exception:  # noqa: BLE001 — 영속 실패가 검증 결과 반환을 막지 않음
                pass

        return ToolSuccess(content=json.dumps({
            "kind": "smb_reverify_walk",
            "host": vi.host, "share": vi.share, "path_prefix": vi.path_prefix,
            "finding_id": vi.finding_id,
            "verdict": verdict,
            "access": access,
            "files_visible_in_scope": files_visible,
            "note": "auth-read 만 남아도 DSSOC 검증 계정 접근 가능 상태이므로 still_open.",
        }, ensure_ascii=False))


_REVERIFY_SESSION_ID = -464646


async def _schedule_communication_retry(
    *,
    state: Any,
    host: str,
    share: str,
    path_prefix: str,
    finding_id: int | None,
    reason: str,
) -> ToolSuccess:
    access = {
        "null_read": False,
        "guest_read": False,
        "auth_read": False,
        "any_write": False,
        "still_readable": None,
        "communication_unavailable": True,
    }
    thread_id: int | None = None
    if finding_id is not None:
        try:
            for t in state.mail_thread_find_by_subject_tag(_subject_tag(host)):
                fids = state.mail_thread_finding_ids(int(t["id"])) or [
                    int(t.get("finding_id") or 0)
                ]
                if int(finding_id) not in fids:
                    continue
                thread_id = int(t["id"])
                await asyncio.to_thread(
                    state.mail_reverify_result_add,
                    thread_id=thread_id,
                    finding_id=int(finding_id),
                    share=share,
                    path_prefix=path_prefix,
                    verdict="communication_unavailable",
                    access=access,
                    files_visible=None,
                    error=reason,
                )
                await asyncio.to_thread(
                    state.mail_thread_schedule_communication_retry,
                    thread_id,
                    reason=reason,
                    status="reply_received",
                )
                break
        except Exception:  # noqa: BLE001
            pass
    return ToolSuccess(content=json.dumps({
        "kind": "smb_reverify_walk",
        "host": host,
        "share": share,
        "path_prefix": path_prefix,
        "finding_id": finding_id,
        "thread_id": thread_id,
        "verdict": "communication_unavailable",
        "access": access,
        "files_visible_in_scope": None,
        "retry_after": "8h",
        "note": (
            "SMB 통신 불가로 조치 완료/미완료를 판정하지 않고 8시간 후 재검증합니다."
        ),
    }, ensure_ascii=False))


def _subject_tag(host: str) -> str:
    from domains.smb.plugin.tools.smb_submit_finding_tool import normalize_subject_tag
    return normalize_subject_tag(host)
