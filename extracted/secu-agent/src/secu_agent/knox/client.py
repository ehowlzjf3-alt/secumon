"""KnoxDaemonClient — `~/project/knox` 릴레이 데몬(기본 127.0.0.1:8771) HTTP 래퍼.

데몬 API (localhost 전용·무인증):
  GET  /health
  GET  /messages?peek=1        — 버퍼 드레인(폴백 수신)
  GET  /events                 — SSE 푸시(기본 수신)
  POST /send     {chatroomId, text}
  POST /resolve  {single_ids}
  POST /chatroom {single_ids|user_ids, group, title}
  POST /search   {query, page}

수신은 SSE 단일 경로(/events)를 기본으로 쓴다 — /messages 드레인과 섞으면 메시지 유실.
reconnect 시 중복 방지를 위해 msgid(또는 msgkey) 기반 _SeenSet 으로 dedup.
"""
from __future__ import annotations

import asyncio
import json
import os
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx

DEFAULT_DAEMON = "http://127.0.0.1:8771"
# Knox 메시지 한 건의 텍스트 상한(데몬/upstream 보호). 넘으면 청크 분할 전송.
DEFAULT_MAX_CHARS = 3500


@dataclass(slots=True)
class KnoxMessage:
    """데몬 메시지 1건을 정규화."""
    chatroom_id: str
    text: str
    msgid: int | None = None
    msgkey: str | None = None
    sender: int | None = None
    sender_singleid: str | None = None
    sent_time: int | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_raw(cls, d: dict[str, Any]) -> "KnoxMessage":
        prof = d.get("sender_profile") or {}
        cid = d.get("chatroomId")
        return cls(
            chatroom_id="" if cid is None else str(cid),
            text=d.get("text") or "",
            msgid=d.get("msgid"),
            msgkey=d.get("msgkey"),
            sender=d.get("sender"),
            sender_singleid=prof.get("singleID"),
            sent_time=d.get("sentTime"),
            raw=d,
        )

    def dedup_key(self) -> tuple:
        if self.msgid is not None:
            return ("msgid", self.msgid)
        return ("msgkey", self.chatroom_id, self.msgkey)


class _SeenSet:
    """본 메시지 dedup — 최근 cap 개만 유지(무한 증가 방지)."""

    def __init__(self, cap: int = 5000) -> None:
        self._cap = cap
        self._set: set[tuple] = set()
        self._order: deque[tuple] = deque()

    def seen(self, key: tuple) -> bool:
        """이미 본 키면 True. 아니면 기록하고 False."""
        if key in self._set:
            return True
        self._set.add(key)
        self._order.append(key)
        if len(self._order) > self._cap:
            old = self._order.popleft()
            self._set.discard(old)
        return False


def _chunk_text(text: str, max_chars: int) -> list[str]:
    """줄 경계 우선으로 max_chars 이하 청크 분할. 한 줄이 더 길면 강제 분할."""
    if len(text) <= max_chars:
        return [text]
    chunks: list[str] = []
    buf = ""
    for line in text.split("\n"):
        while len(line) > max_chars:  # 단일 라인이 상한 초과 → 강제 컷
            if buf:
                chunks.append(buf)
                buf = ""
            chunks.append(line[:max_chars])
            line = line[max_chars:]
        add = line if not buf else "\n" + line
        if len(buf) + len(add) > max_chars:
            chunks.append(buf)
            buf = line
        else:
            buf += add
    if buf:
        chunks.append(buf)
    return chunks


async def _parse_sse_payload(payload: str) -> KnoxMessage | None:
    try:
        d = json.loads(payload)
    except (ValueError, TypeError):
        return None
    if not isinstance(d, dict):
        return None
    return KnoxMessage.from_raw(d)


async def iter_sse_messages(
    lines: AsyncIterator[str], seen: _SeenSet,
) -> AsyncIterator[KnoxMessage]:
    """SSE 라인 스트림 → 정규화·dedup 된 KnoxMessage. (httpx 와 분리해 단위 테스트 용이)"""
    data_buf: list[str] = []

    async def _flush() -> KnoxMessage | None:
        if not data_buf:
            return None
        payload = "\n".join(data_buf)
        data_buf.clear()
        msg = await _parse_sse_payload(payload)
        if msg is None:
            return None
        if seen.seen(msg.dedup_key()):
            return None
        return msg

    async for raw in lines:
        line = raw.rstrip("\r\n")
        if line == "":
            msg = await _flush()
            if msg is not None:
                yield msg
            continue
        if line.startswith(":"):  # SSE 주석/keepalive
            continue
        if line.startswith("data:"):
            data_buf.append(line[len("data:"):].lstrip())
    # 스트림 종료 시 tail flush
    msg = await _flush()
    if msg is not None:
        yield msg


class KnoxDaemonClient:
    def __init__(
        self,
        base_url: str | None = None,
        *,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
        trust_env: bool = False,
    ) -> None:
        # 데몬은 loopback(127.0.0.1:8771) — 사내 http_proxy/https_proxy 를 타면 안 됨.
        # trust_env=False 로 프록시 환경변수 무시(기본). transport 주입 시엔 무관(테스트).
        self.base_url = base_url or os.environ.get("KM_DAEMON", DEFAULT_DAEMON)
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            transport=transport,
            trust_env=trust_env,
        )
        self.last_error: str | None = None

    async def aclose(self) -> None:
        await self._http.aclose()

    async def health(self) -> dict[str, Any]:
        r = await self._http.get("/health")
        r.raise_for_status()
        return r.json()

    async def send(
        self, chatroom_id: str, text: str, *, max_chars: int = DEFAULT_MAX_CHARS,
    ) -> list[dict[str, Any]]:
        """방에 텍스트 전송. 빈 텍스트는 무시. 긴 텍스트는 청크 분할해 순차 전송."""
        if not text or not text.strip():
            return []
        out: list[dict[str, Any]] = []
        for chunk in _chunk_text(text, max_chars):
            if not chunk:
                continue
            r = await self._http.post(
                "/send", json={"chatroomId": chatroom_id, "text": chunk},
            )
            r.raise_for_status()
            out.append(r.json())
        return out

    async def resolve(self, single_ids: list[str]) -> dict[str, Any]:
        r = await self._http.post("/resolve", json={"single_ids": single_ids})
        r.raise_for_status()
        return r.json()

    async def create_chatroom(
        self,
        *,
        single_ids: list[str] | None = None,
        user_ids: list[str] | None = None,
        group: bool = False,
        title: str = "",
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"group": group, "title": title}
        if single_ids is not None:
            body["single_ids"] = single_ids
        if user_ids is not None:
            body["user_ids"] = user_ids
        r = await self._http.post("/chatroom", json=body)
        r.raise_for_status()
        return r.json()

    async def search(self, query: str, *, page: int = 1) -> dict[str, Any]:
        r = await self._http.post("/search", json={"query": query, "page": page})
        r.raise_for_status()
        return r.json()

    async def poll_messages(self, *, peek: bool = False) -> list[KnoxMessage]:
        params = {"peek": "1"} if peek else None
        r = await self._http.get("/messages", params=params)
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, list):
            return []
        return [KnoxMessage.from_raw(d) for d in data if isinstance(d, dict)]

    async def iter_events(
        self, *, max_backoff: float = 30.0,
    ) -> AsyncIterator[KnoxMessage]:
        """/events SSE 무한 구독. 끊기면 backoff 후 자동 재연결(dedup 유지)."""
        seen = _SeenSet()
        backoff = 1.0
        while True:
            try:
                async with self._http.stream("GET", "/events") as resp:
                    resp.raise_for_status()
                    backoff = 1.0
                    async for msg in iter_sse_messages(resp.aiter_lines(), seen):
                        yield msg
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — 연결 오류는 재시도로 흡수
                self.last_error = str(e)
            await asyncio.sleep(min(backoff, max_backoff))
            backoff = min(backoff * 2, max_backoff)
