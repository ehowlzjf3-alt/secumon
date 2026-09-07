"""Knox in-chat 텍스트 승인 — 웹의 _WebSocketApprovalResolver 에 대응.

Knox 메신저엔 승인 모달이 없으므로, 승인 필요 시 방에 짧은 프롬프트를 올리고
사용자가 `approve <id>` / `deny <id>` 로 회신하면 그 결정을 도구 실행에 반영한다.

lockout 방지(feedback-security): 타임아웃이면 **deny** 로 fail-closed.
감사기록은 기존 state.approval_audit_* 를 그대로 재사용.

승인 대기는 KnoxApprovalRegistry 가 방 경계로 격리해 보관한다(브릿지 1개 보유, 리졸버 공유).
인바운드 디스패처가 승인 회신을 받으면 registry.resolve(...) 로 future 를 깨운다.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Awaitable, Callable

from secu_agent import state
from secu_agent.agent.tools.approval import ApprovalDecision, ApprovalRequest

SendFn = Callable[[str, str], Awaitable[object]]


def short_id_for(invocation_id: str) -> str:
    """invocation_id → 사용자가 타이핑하기 쉬운 짧은 토큰. (디스패처도 동일 함수로 계산)"""
    return invocation_id[-6:] if len(invocation_id) >= 6 else invocation_id


@dataclass(slots=True)
class _Pending:
    future: "asyncio.Future[bool]"
    chatroom_id: str


class KnoxApprovalRegistry:
    """방 경계로 격리된 승인 대기 레지스트리."""

    def __init__(self) -> None:
        self._pending: dict[str, _Pending] = {}

    def register(self, short_id: str, chatroom_id: str) -> "asyncio.Future[bool]":
        fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._pending[short_id] = _Pending(future=fut, chatroom_id=chatroom_id)
        return fut

    def unregister(self, short_id: str) -> None:
        self._pending.pop(short_id, None)

    def has_pending(self, chatroom_id: str) -> bool:
        return any(p.chatroom_id == chatroom_id for p in self._pending.values())

    def resolve(self, short_id: str, chatroom_id: str, approved: bool) -> bool:
        """승인 회신 반영. 같은 방의 대기 건이면 future 를 깨우고 True, 아니면 False."""
        p = self._pending.get(short_id)
        if p is None or p.chatroom_id != chatroom_id:
            return False
        if not p.future.done():
            p.future.set_result(approved)
        return True


class KnoxApprovalResolver:
    """ToolContext.approval_resolver 로 주입되는 Knox 텍스트 승인 리졸버."""

    def __init__(
        self,
        *,
        registry: KnoxApprovalRegistry,
        chatroom_id: str,
        send: SendFn,
        mode: str,
        timeout_seconds: float,
        session_id: int | None,
        agent_type: str,
        actor: str,
    ) -> None:
        self._registry = registry
        self._chatroom_id = chatroom_id
        self._send = send
        self._mode = (mode or "ask").strip().lower()
        self._timeout = timeout_seconds
        self._session_id = session_id
        self._agent_type = agent_type
        self._actor = actor

    async def resolve(self, request: ApprovalRequest) -> ApprovalDecision | None:
        await asyncio.to_thread(
            state.approval_audit_record_request,
            approval_id=request.invocation_id,
            session_id=self._session_id,
            agent_type=self._agent_type,
            actor=self._actor,
            tool_name=request.tool_name,
            tool_input=request.tool_input,
            reason=request.reason,
        )

        if self._mode == "auto":
            return await self._finalize(request, "allow", "auto approval mode")
        if self._mode == "deny":
            return await self._finalize(request, "deny", "deny approval mode")

        # ask (smart 등 그 외 모드도 안전하게 사람 확인으로 폴백)
        short = short_id_for(request.invocation_id)
        fut = self._registry.register(short, self._chatroom_id)
        await self._send(self._chatroom_id, self._prompt(request, short))
        try:
            approved = await asyncio.wait_for(fut, self._timeout)
        except (asyncio.TimeoutError, TimeoutError):
            await self._send(
                self._chatroom_id, f"⏱ 승인 시간초과 — 거부 처리 [{short}]",
            )
            return await self._finalize(
                request, "deny", "approval timeout", audit_decision="timeout",
            )
        finally:
            self._registry.unregister(short)

        if approved:
            return await self._finalize(
                request, "allow", f"approved via knox by {self._actor}",
            )
        return await self._finalize(
            request, "deny", f"denied via knox by {self._actor}",
        )

    def _prompt(self, request: ApprovalRequest, short: str) -> str:
        return (
            f"⚠ 승인 필요 [{short}]\n"
            f"tool: {request.tool_name}\n"
            f"이유: {request.reason}\n"
            f"허용: `approve {short}`  /  거부: `deny {short}`"
        )

    async def _finalize(
        self,
        request: ApprovalRequest,
        behavior: str,
        reason: str,
        *,
        audit_decision: str | None = None,
    ) -> ApprovalDecision:
        await asyncio.to_thread(
            state.approval_audit_resolve,
            request.invocation_id,
            decision=audit_decision or behavior,
            decision_reason=reason,
            actor=self._actor,
        )
        return ApprovalDecision(behavior=behavior, reason=reason)  # type: ignore[arg-type]
