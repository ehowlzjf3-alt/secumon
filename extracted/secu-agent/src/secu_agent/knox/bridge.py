"""KnoxBridge — Knox 메신저를 secu-agent 의 또 하나의 프론트엔드로 연결.

수신(SSE) → 인가 → chatroom↔ChatSession 바인딩 → sess.turn() → 렌더 → /send.
웹(WS) 의 turn 드라이버(web/routes/chat.py)를 메신저용으로 미러링한 것.

동시성 설계(중요): 메인 루프는 iter_events 만 빠르게 읽고 라우팅한다.
  - 점검 메시지 → **방별 워커 태스크**의 큐로 enqueue (방끼리 동시, 방 안에선 직렬)
  - 승인 회신("approve <id>"/"deny <id>") → 메인 루프에서 **즉시** registry.resolve
turn 이 승인 대기로 블록돼 있어도 메인 루프는 계속 이벤트를 읽으므로, 같은 방의
승인 회신이 그 turn 을 깨울 수 있다(인라인으로 await 하면 데드락).
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import os
import re
from typing import Any, Awaitable, Callable

from secu_agent import state
from secu_agent.knox.approval import KnoxApprovalRegistry, KnoxApprovalResolver
from secu_agent.knox.client import KnoxMessage
from secu_agent.knox.config import KnoxConfig, RoomConfig, authorize
from secu_agent.knox.render import KnoxTurnRenderer

_log = logging.getLogger("secu_agent.knox")

# session_loader(session_id, agent_type) -> session (sync 또는 async). session 은
# .context.approval_resolver 를 가지며 async def turn(text) -> AsyncIterator[ev].
SessionLoader = Callable[[int, str], Any]

_APPROVAL_RE = re.compile(r"^\s*(approve|deny|승인|거부)\s+(\S+)\s*$", re.IGNORECASE)


def parse_approval_reply(text: str) -> tuple[bool, str] | None:
    """'approve <id>'/'deny <id>'(승인/거부) → (approved, id). 아니면 None."""
    m = _APPROVAL_RE.match(text or "")
    if not m:
        return None
    verb = m.group(1).lower()
    approved = verb in ("approve", "승인")
    return (approved, m.group(2))


class KnoxBridge:
    def __init__(
        self,
        *,
        client: Any,
        config: KnoxConfig,
        own_singleid: str | None = None,
        registry: KnoxApprovalRegistry | None = None,
        approval_timeout: float = 300.0,
        verbose: bool = False,
        session_loader: SessionLoader | None = None,
    ) -> None:
        self._client = client
        self._config = config
        self._own = own_singleid or os.environ.get("KNOX_OWN_SINGLEID")
        self._registry = registry or KnoxApprovalRegistry()
        self._approval_timeout = approval_timeout
        self._verbose = verbose
        self._session_loader = session_loader
        self._queues: dict[str, asyncio.Queue] = {}
        self._workers: dict[str, asyncio.Task] = {}

    # --------------------------------------------------------------- main loop
    async def run(self) -> None:
        _log.info("knox bridge start: rooms=%s own=%s", sorted(self._config.rooms), self._own)
        # 기본은 폴링(/messages 드레인) — SSE 는 장시간 뒤 stale(데몬 phantom subscriber)
        # 되어 메시지 유실. 폴링은 stateless 라 안정적. SA_KNOX_TRANSPORT=sse 로 옛 방식 선택.
        if os.environ.get("SA_KNOX_TRANSPORT", "poll").lower() == "sse":
            async for msg in self._client.iter_events():
                try:
                    await self.handle(msg)
                except Exception:  # noqa: BLE001 — 한 메시지 실패가 루프를 죽이지 않게
                    _log.exception("knox handle failed")
            return
        # 폴링: 시작 시 백로그 1회 비워(중복 응답 방지) 새 메시지만 처리.
        poll_interval = float(os.environ.get("SA_KNOX_POLL_INTERVAL", "3"))
        try:
            drained = await self._client.poll_messages()
            if drained:
                _log.info("knox startup: discarded %d backlog message(s)", len(drained))
        except Exception:  # noqa: BLE001
            _log.exception("knox initial drain failed")
        _log.info("knox poll loop start (interval=%ss)", poll_interval)
        while True:
            try:
                await self._poll_once()
            except Exception:  # noqa: BLE001 — 폴 실패가 루프를 죽이지 않게
                _log.exception("knox poll failed")
            await asyncio.sleep(poll_interval)

    async def _poll_once(self) -> int:
        """/messages 1회 드레인 → 각 메시지 라우팅. 처리한 메시지 수 반환."""
        msgs = await self._client.poll_messages()
        for msg in msgs:
            try:
                await self.handle(msg)
            except Exception:  # noqa: BLE001
                _log.exception("knox handle failed")
        return len(msgs)

    async def handle(self, msg: KnoxMessage) -> None:
        # 1) 승인 회신은 turn 으로 처리하지 않고 메인 루프에서 즉시 해소.
        reply = parse_approval_reply(msg.text)
        if reply is not None:
            approved, token = reply
            room = authorize(msg, self._config, own_singleid=self._own)
            if room is not None:
                self._registry.resolve(token, msg.chatroom_id, approved)
            return
        # 2) 점검 메시지 — 인가 통과해야 방 워커로 enqueue. 실패 시 무응답.
        room = authorize(msg, self._config, own_singleid=self._own)
        if room is None:
            return
        self._enqueue(room, msg)

    # ------------------------------------------------------------ room workers
    def _enqueue(self, room: RoomConfig, msg: KnoxMessage) -> None:
        q = self._queues.get(room.chatroom_id)
        if q is None:
            q = asyncio.Queue()
            self._queues[room.chatroom_id] = q
            self._workers[room.chatroom_id] = asyncio.create_task(
                self._worker(room.chatroom_id, q),
            )
        q.put_nowait((room, msg))

    async def _worker(self, chatroom_id: str, q: asyncio.Queue) -> None:
        while True:
            room, msg = await q.get()
            try:
                await self._process(room, msg)
            except Exception as e:  # noqa: BLE001 — turn 실패는 방에 알리고 계속
                _log.exception("knox turn failed: room=%s", chatroom_id)
                try:
                    await self._client.send(chatroom_id, f"⚠ 오류: {e}")
                except Exception:  # noqa: BLE001
                    pass
            finally:
                q.task_done()

    async def _process(self, room: RoomConfig, msg: KnoxMessage) -> None:
        sid = await asyncio.to_thread(
            state.knox_room_session_get_or_create,
            msg.chatroom_id, agent_type=room.agent_type, charter_ref=room.charter_ref,
        )
        sess = await self._load_session(sid, room.agent_type)
        resolver = KnoxApprovalResolver(
            registry=self._registry,
            chatroom_id=msg.chatroom_id,
            send=self._client.send,
            mode=room.approval_mode,
            timeout_seconds=self._approval_timeout,
            session_id=sid,
            agent_type=room.agent_type,
            actor=msg.sender_singleid or "knox",
        )
        ctx = getattr(sess, "context", None)
        if ctx is not None:
            ctx.approval_resolver = resolver
        renderer = KnoxTurnRenderer(verbose=self._verbose)
        async for ev in sess.turn(msg.text):
            for out in renderer.on_event(ev):
                await self._client.send(msg.chatroom_id, out)
        for out in renderer.finalize():
            await self._client.send(msg.chatroom_id, out)

    async def _load_session(self, session_id: int, agent_type: str) -> Any:
        if self._session_loader is not None:
            res = self._session_loader(session_id, agent_type)
            if inspect.isawaitable(res):
                return await res
            return res
        return await asyncio.to_thread(self._default_load_session, session_id, agent_type)

    @staticmethod
    def _default_load_session(session_id: int, agent_type: str) -> Any:
        # 웹과 동일 경로: ChatSession.load(...) → sess.turn(). 무거운 import 는 지연.
        from secu_agent.agent.chat_session import ChatSession
        from secu_agent.agent.session_runtime import (
            evidence_dir,
            make_llm_client,
            runtime_task_type,
        )
        return ChatSession.load(
            client=make_llm_client(),
            evidence_dir=evidence_dir(),
            task_type=runtime_task_type(agent_type),
            frontend_capabilities={"interactive_approval"},
            session_id=session_id,
            session_agent_type=agent_type,
        )

    # ----------------------------------------------------------------- helpers
    async def join(self) -> None:
        """모든 방 큐가 비워질 때까지 대기(테스트/그레이스풀 종료용)."""
        for q in list(self._queues.values()):
            await q.join()

    async def aclose(self) -> None:
        for t in self._workers.values():
            t.cancel()
        for t in list(self._workers.values()):
            try:
                await t
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._workers.clear()
        self._queues.clear()
