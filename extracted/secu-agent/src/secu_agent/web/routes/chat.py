"""/ws/chat WebSocket + /api/chat/history.

단일 채널 multi-viewer 모델:
- 같은 chat_session 에 여러 ws 가 동시에 join 가능
- 누구나 input 보내고 누구나 events 받음
- token 인증 (env SA_CHAT_TOKEN — default 'devtoken')

server → browser JSON 이벤트 (event 필드 + payload):
- TurnStarted: {event, turn}
- TextChunk: {event, text}
- ToolCallStarted: {event, id, name, input}
- ToolCallCompleted: {event, id, name, ok, result}
- LoopCompleted: {event, reason, total_turns}
- LoopError: {event, message}
"""
from __future__ import annotations

import asyncio
import dataclasses
import functools
import json
import os
import psycopg
import time
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import Depends, APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from secu_agent import state
from secu_agent.agent_type_registry import valid_agent_types
from secu_agent.agent.approval_policy import (
    ApprovalMode,
    SmartApprovalPolicy,
    normalize_approval_mode,
)
from secu_agent.agent.busy_input_policy import classify_busy_input
from secu_agent.agent.chat_session import ChatSession
from secu_agent.agent.goal_manager import pause_goal_for_user_cancel
from secu_agent.agent.paste_stub import maybe_stub
from secu_agent.agent.events import (
    LoopCompleted, LoopError, LoopEvent,
    BgTaskCompleted,
    GoalChecklistUpdated, GoalContinuation, GoalDecomposed, GoalDone, GoalPaused,
    ReasoningChunk, TextChunk, ToolCallCompleted, ToolCallStarted, TurnStarted,
)
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.session_runtime import (
    evidence_dir as _evidence_dir,
    make_llm_client as _make_llm_client,
    runtime_task_type as _runtime_task_type,
)
from secu_agent.agent.tools.approval import ApprovalDecision, ApprovalRequest
from secu_agent.agent.tools.base import ToolSuccess


router = APIRouter()


class ChatSessionCreateRequest(BaseModel):
    agent_type: str = Field(default="agent", max_length=40)
    label: str | None = Field(default=None, max_length=120)
    # v3.82 U5: per-session skill 선택 — 이름 또는 추가 dir (SkillsSelection 시맨틱).
    skills: list[str] | None = Field(default=None, max_length=20)


class ChatSessionUpdateRequest(BaseModel):
    label: str | None = Field(default=None, max_length=120)
    status: str | None = Field(default=None, max_length=40)
    skills: list[str] | None = Field(default=None, max_length=20)


# v3.82 U3b: 토큰 검사는 web/auth.py 로 일원화 (REST 헤더 인증 의존성 포함).
from secu_agent.web.auth import check_token as _check_token
from secu_agent.web.auth import require_token  # noqa: E402
from secu_agent.web.auth import expected_token as _expected_token  # noqa: E402,F401


# v3.79 ② 보안: WS 토큰을 URL query 대신 Sec-WebSocket-Protocol 로.
# 브라우저는 WS 에 커스텀 헤더를 못 실음 — 표준 우회가 subprotocol smuggling.
# URL query 토큰은 access log/프록시 로그에 남아 유출 표면. query 는 구버전
# 클라이언트 폴백으로만 유지.
_WS_TOKEN_PROTO_PREFIX = "th-token."


def _ws_token_and_subprotocol(ws: Any) -> tuple[str, str | None]:
    """WS 인증 토큰 추출. 반환: (token, 핸드셰이크에 에코할 subprotocol 또는 None)."""
    import base64

    raw = ""
    try:
        raw = ws.headers.get("sec-websocket-protocol") or ""
    except Exception:
        raw = ""
    for part in raw.split(","):
        offer = part.strip()
        if not offer.startswith(_WS_TOKEN_PROTO_PREFIX):
            continue
        enc = offer[len(_WS_TOKEN_PROTO_PREFIX):]
        try:
            pad = "=" * (-len(enc) % 4)
            tok = base64.urlsafe_b64decode(enc + pad).decode("utf-8")
        except Exception:
            continue  # 깨진 offer — query 폴백으로
        return tok, offer
    return ws.query_params.get("token", ""), None


def _project_root() -> Path:
    # src/secu_agent/web/routes/chat.py → parents[4] == repo root
    return Path(__file__).resolve().parents[4]


@functools.cache
def _ensure_dotenv() -> None:
    # v3.79-perf: .env 파싱 + os.environ 주입은 프로세스당 1회면 충분 —
    # 기존엔 WS 접속마다(_approval_mode_for_ws) 파일을 재파싱했다. functools.cache
    # 로 첫 호출에만 실행(→ env 는 첫 사용 전 로드 보장), 이후엔 no-op.
    # (테스트가 재적용을 원하면 _ensure_dotenv.cache_clear() 로 리셋.)
    import re
    env_path = _project_root() / ".env"
    if not env_path.exists():
        return
    pat = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)")

    def _expand(s: str) -> str:
        def _sub(m):
            name = m.group(1) or m.group(2)
            return os.environ.get(name, m.group(0))
        for _ in range(2):
            s = pat.sub(_sub, s)
        return s

    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = _expand(v)


def _make_smart_approval_client() -> LLMClient:
    """Separate factory hook so tests can isolate the smart approval judge."""
    return _make_llm_client()


def _approval_mode_for_ws(ws: WebSocket) -> ApprovalMode:
    _ensure_dotenv()
    raw = (
        ws.query_params.get("approval_mode")
        or ws.query_params.get("approval")
        or os.environ.get("SA_CHAT_APPROVAL_MODE")
    )
    return normalize_approval_mode(raw)


# ============================================================
# pub/sub broadcaster (단일 채널, multi-viewer)
# ============================================================

# de-domain (v3.81 T4): agent_type 는 등록형 — 코어 'agent' + plugin 등록 (agent_type_registry)


def _ws_queue_max() -> int:
    try:
        return max(1, int(os.environ.get("SA_WS_QUEUE_MAX", "500")))
    except ValueError:
        return 500


class _Hub:
    """v3.79 ② U3 full: per-sub queue + sender task.

    broadcast = enqueue-only(I/O 없음) → 뷰어 TCP backpressure 가 에이전트 turn 을
    못 잡음. sender 가 큐를 drain 하며 연속 TextChunk/ReasoningChunk 를 한 프레임으로
    coalesce(프론트는 둘 다 append 렌더 — 병합 무손실). 큐 가득 → drop-oldest
    (라이브 뷰는 최신 우선). send 실패/timeout → 구독자 self-remove.
    """

    def __init__(self):
        self._lock = asyncio.Lock()
        self._subs: dict[WebSocket, tuple[asyncio.Queue, asyncio.Task]] = {}
        # 한 turn 만 동시에 — operator agent loop 가 동시에 둘 돌면 메시지 꼬임
        self._turn_lock = asyncio.Lock()

    async def join(self, ws: WebSocket) -> None:
        async with self._lock:
            if ws in self._subs:
                return
            q: asyncio.Queue = asyncio.Queue(maxsize=_ws_queue_max())
            task = asyncio.create_task(self._sender(ws, q))
            self._subs[ws] = (q, task)

    async def leave(self, ws: WebSocket) -> None:
        async with self._lock:
            entry = self._subs.pop(ws, None)
        if entry is not None:
            entry[1].cancel()

    async def _remove(self, ws: WebSocket) -> None:
        async with self._lock:
            self._subs.pop(ws, None)

    async def is_empty(self) -> bool:
        """구독자가 하나도 없으면 True — 채널 회수(GC) 판단용."""
        async with self._lock:
            return not self._subs

    async def _sender(self, ws: WebSocket, q: asyncio.Queue) -> None:
        timeout = float(os.environ.get("SA_WS_SEND_TIMEOUT", "5"))
        pending: dict[str, Any] | None = None
        try:
            while True:
                payload = pending if pending is not None else await q.get()
                pending = None
                ev = payload.get("event")
                if ev in ("TextChunk", "ReasoningChunk"):
                    # drain-burst coalesce — 큐에 쌓인 연속 같은-타입 델타 병합.
                    text_acc = payload.get("text") or ""
                    while not q.empty():
                        nxt = q.get_nowait()
                        if nxt.get("event") == ev:
                            text_acc += nxt.get("text") or ""
                        else:
                            pending = nxt  # 타입 경계 — 순서 보존
                            break
                    payload = {**payload, "text": text_acc}
                try:
                    await asyncio.wait_for(
                        ws.send_text(json.dumps(payload, ensure_ascii=False)),
                        timeout=timeout,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    break  # dead/hung 뷰어 — self-remove
        except asyncio.CancelledError:
            return  # leave() 가 정리
        await self._remove(ws)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        async with self._lock:
            queues = [q for (q, _t) in self._subs.values()]
        for q in queues:
            while True:
                try:
                    q.put_nowait(payload)
                    break
                except asyncio.QueueFull:
                    try:
                        q.get_nowait()  # drop-oldest
                    except asyncio.QueueEmpty:
                        pass

    @property
    def turn_lock(self) -> asyncio.Lock:
        return self._turn_lock


# agent_type 별 별도 Hub — broadcast 격리
_hubs: dict[str, _Hub] = {}
_hubs_lock = asyncio.Lock()


def _chat_channel(agent_type: str, session_id: int | None = None) -> str:
    return f"{agent_type}:{session_id}" if session_id is not None else agent_type


async def _get_hub(agent_type: str) -> _Hub:
    async with _hubs_lock:
        h = _hubs.get(agent_type)
        if h is None:
            h = _Hub()
            _hubs[agent_type] = h
        return h


async def _release_session_channel(
    channel: str, session_ids: set[int], hub: _Hub,
) -> None:
    """v3.79-perf: 마지막 구독자가 떠난 세션 채널의 Hub + 세션별 stop/cancel
    엔트리를 회수한다. 장수 서버에서 세션마다 _hubs/_SESSION_STOP/_SESSION_CANCEL
    엔트리가 쌓여 새던 메모리 누수를 막는다.

    이 시점(ws_chat finally)엔 백그라운드 turn 도 이미 drain 완료라 활성 세션
    스트리밍 시맨틱엔 영향 없음. 재접속하면 _get_hub 가 새 Hub 를,
    _session_stop_event/_session_cancel_event 가 새 Event 를 재생성한다.

    아직 다른 구독자가 남아 있으면(다중 뷰어) 아무것도 하지 않는다. 회수는
    _hubs_lock 하에서 원자적으로 판정 — 회수 대상이 등록된 그 Hub 객체일 때만.
    """
    async with _hubs_lock:
        if _hubs.get(channel) is not hub:
            return  # 이미 교체됨(재생성) — 건드리지 않음
        if not await hub.is_empty():
            return  # 아직 구독자 존재
        _hubs.pop(channel, None)
    for sid in session_ids:
        _SESSION_STOP.pop(sid, None)
        _SESSION_CANCEL.pop(sid, None)


def _persist_cancel_note_best_effort(session_id: int, note: str) -> None:
    try:
        state.chat_message_add(session_id, role="system", content={"text": note})
    except psycopg.errors.IntegrityError:
        # Tests may inject lightweight ChatSession doubles with synthetic ids.
        # Real sessions are created through state.chat_session_get_or_create().
        return


# v3.76.4: 재접속 자동재개 dormancy 가드 — 오래 휴면한 세션의 active goal 은 자동으로
# 부활시키지 않는다(옛 web-batch 좀비 goal 이 재접속마다 되살아나 'web 만' 도배되던 문제).
_RECONNECT_RESUME_MAX_DORMANT_SEC = float(
    os.environ.get("SA_RECONNECT_RESUME_MAX_DORMANT_SEC", "21600")  # 기본 6h
)


def _session_recently_active(session_id: int) -> bool:
    """세션이 최근(_RECONNECT_RESUME_MAX_DORMANT_SEC 이내) 활동했는지. 불확실하면 True."""
    try:
        with state.connect() as c:
            row = c.execute(
                "SELECT max(created_at) AS m FROM chat_message WHERE session_id=?",
                (session_id,),
            ).fetchone()
        last = row["m"] if row else None
        if not last:
            return False
        return (time.time() - float(last)) < _RECONNECT_RESUME_MAX_DORMANT_SEC
    except Exception:
        return True


def _is_new_chat_command(text: str) -> bool:
    cmd = text.strip().lower()
    return (
        cmd in {"/new", "/reset", "/clear", "/새대화"}
        or cmd.startswith("/new ")
        or cmd.startswith("/reset ")
    )


async def _start_new_chat_session(
    hub: _Hub,
    agent_type: str,
    *,
    reason: str = "user_requested",
    label: str | None = None,
) -> int:
    session_id = await asyncio.to_thread(
        state.chat_session_new, source="web", agent_type=agent_type, label=label,
    )
    await hub.broadcast({
        "event": "ChatSessionReset",
        "agent_type": agent_type,
        "session_id": session_id,
        "reason": reason,
    })
    return session_id


def _shape_chat_session(row: dict[str, Any]) -> dict[str, Any]:
    message_count = row.get("message_count")
    last_message_at = row.get("last_message_at")
    if message_count is None or last_message_at is None:
        with state.connect() as c:
            stats = c.execute(
                "SELECT COUNT(*) AS n, MAX(created_at) AS last_message_at "
                "FROM chat_message WHERE session_id=?",
                (int(row["id"]),),
            ).fetchone()
            message_count = int(stats["n"] or 0)
            last_message_at = stats["last_message_at"]
    return {
        "id": int(row["id"]),
        "agent_type": row["agent_type"],
        "label": row.get("label"),
        "status": row.get("status") or "active",
        "source": row.get("source"),
        "started_at": row.get("started_at"),
        "updated_at": row.get("updated_at"),
        "archived_at": row.get("archived_at"),
        "message_count": int(message_count or 0),
        "last_message_at": last_message_at,
        "settings": row.get("settings") or {},
    }


def _validated_skills_settings(skills: list[str] | None) -> dict[str, Any] | None:
    """v3.82 U5: skills 선택값 검증 — parse + 실제 로드로 미존재 이름 즉시 400."""
    if not skills:
        return None
    from secu_agent.agent.skills import load_skills_all, parse_skills_selection
    try:
        sel = parse_skills_selection(skills)
        if sel is not None:
            load_skills_all(selection=sel)  # 미존재 이름/디렉토리 = ValueError
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"skills": list(skills)}


def _session_skills_selection(session_id: int):
    """세션 settings 의 skills → SkillsSelection (없으면 None). 깨진 값은 무시."""
    from secu_agent.agent.skills import parse_skills_selection
    row = state.chat_session_get(session_id)
    if not row:
        return None
    skills = (row.get("settings") or {}).get("skills")
    if not skills:
        return None
    from secu_agent.agent.skills import load_skills_all
    try:
        sel = parse_skills_selection(skills)
        if sel is not None:
            load_skills_all(selection=sel)  # 미존재 이름 검증
        return sel
    except ValueError:
        return None  # 저장 후 skill 이 사라진 경우 — 전체 로드로 폴백 (세션은 살린다)


def _get_session_or_404(session_id: int, agent_type: str | None = None) -> dict[str, Any]:
    row = state.chat_session_get(session_id)
    if row is None:
        raise HTTPException(404, f"chat session {session_id} not found")
    if agent_type is not None and row.get("agent_type") != agent_type:
        raise HTTPException(400, f"chat session {session_id} is not agent_type={agent_type}")
    return row


# v3.79 ② U2: ToolCallStarted.input 에서 "지금 점검 중인 대상" 정규화.
# 도구별 input 키가 제각각이라 UI 가 직접 못 뽑음 — 서버에서 한 줄로.
# v3.85: 도메인-특화 input 키는 register_target_extractor 등록형 — 코어는 generic
# 키(path/query/target + url/host 등 공통)만 안다. 도메인 plugin 이 자기 도구의
# 대상 필드(예: dns 'zone'/'nameserver')를 뽑는 추출기를 등록한다.
_TARGET_LIST_KEYS = ("repo_names", "space_keys", "hosts", "urls", "target_ids")
_TARGET_KEYS = (
    "host", "url", "seed", "domain", "repo", "repo_full_name", "path",
    "share", "subnet", "space_key", "entity_value", "query", "target",
)
_TARGET_MAX = 80

_TARGET_EXTRACTORS: list[Any] = []


def register_target_extractor(fn: Any) -> None:
    """도메인 도구의 '대상' 필드 추출기 등록 (plugin API).

    fn(name: str, tool_input: dict) -> str | None. _extract_target 이 코어 generic
    키보다 먼저 등록 추출기를 순회한다(도메인 필드 우선). 절대 raise 하면 안 되며,
    raise 해도 코어가 삼켜 UI 라벨만 None 이 된다.
    """
    if not callable(fn):
        raise TypeError("target extractor 는 callable 이어야 한다")
    _TARGET_EXTRACTORS.append(fn)


def unregister_all_target_extractors() -> None:
    """등록 전체 해제 (테스트/재부착 멱등용)."""
    _TARGET_EXTRACTORS.clear()


def _truncate_target(s: str) -> str:
    s = s.strip()
    return s if len(s) <= _TARGET_MAX else s[: _TARGET_MAX - 1] + "…"


def _extract_target(name: str, tool_input: Any) -> str | None:
    """tool input → 사람용 대상 한 줄 (없으면 None). 절대 raise 하지 않음."""
    if not isinstance(tool_input, dict):
        return None
    try:
        # 도메인 등록 추출기 우선 (자기 도구 필드를 뽑을 기회).
        for fn in _TARGET_EXTRACTORS:
            try:
                r = fn(name, tool_input)
            except Exception:
                continue
            if r:
                return _truncate_target(str(r))
        for k in _TARGET_LIST_KEYS:
            v = tool_input.get(k)
            if isinstance(v, (list, tuple)) and v:
                first = str(v[0]).strip()
                if not first:
                    continue
                if len(first) > _TARGET_MAX:
                    first = first[: _TARGET_MAX - 1] + "…"
                return first if len(v) == 1 else f"{first} 외 {len(v) - 1}"
        for k in _TARGET_KEYS:
            v = tool_input.get(k)
            if isinstance(v, (str, int)) and str(v).strip():
                return _truncate_target(str(v))
    except Exception:
        return None
    return None


# v3.79 ② U4: ToolCallCompleted 전문 broadcast 상한 — 큰 walk/fetch 결과가
# WS 를 범람시키고 느린 뷰어를 막음. 전체 본문은 LLM context/DB tool_event 에 있음.
_WS_RESULT_MAX = int(os.environ.get("SA_WS_RESULT_MAX", "6000"))


def _truncate_ws_result(text: str) -> str:
    if len(text) <= _WS_RESULT_MAX:
        return text
    omitted = len(text) - _WS_RESULT_MAX
    return text[:_WS_RESULT_MAX] + f"\n…[{omitted}자 생략 — 전체는 tool_event/DB]"


def _token_meter_payload(session_id: int) -> dict[str, Any] | None:
    """v3.79 ② U1: 세션 누적 토큰 미터 프레임. 기록 없으면 None. 절대 raise 안 함."""
    try:
        s = state.token_usage_summary(session_id)
    except Exception:
        return None
    if not s or not s.get("calls"):
        return None
    return {
        "event": "TokenMeter",
        "calls": s["calls"],
        "input_tokens": s["input_tokens"],
        "output_tokens": s["output_tokens"],
        "cache_read_input_tokens": s.get("cache_read_input_tokens", 0),
        "cache_hit_pct": s.get("cache_hit_pct", 0.0),
    }


def _event_to_payload(ev: LoopEvent) -> dict[str, Any]:
    name = type(ev).__name__
    if isinstance(ev, TurnStarted):
        return {"event": name, "turn": ev.turn}
    if isinstance(ev, TextChunk):
        return {"event": name, "text": ev.text}
    if isinstance(ev, ReasoningChunk):
        return {"event": name, "text": ev.text}
    if isinstance(ev, ToolCallStarted):
        return {"event": name, "id": ev.tool_use_id,
                "name": ev.name, "input": ev.input,
                "target": _extract_target(ev.name, ev.input)}
    if isinstance(ev, ToolCallCompleted):
        is_ok = isinstance(ev.result, ToolSuccess)
        content_text = (
            ev.result.content if is_ok
            else getattr(ev.result, "message", "")
        )
        return {"event": name, "id": ev.tool_use_id, "name": ev.name,
                "ok": is_ok, "result": _truncate_ws_result(content_text)}
    if isinstance(ev, LoopCompleted):
        return {"event": name, "reason": ev.reason,
                "total_turns": ev.total_turns}
    if isinstance(ev, LoopError):
        return {"event": name, "message": ev.message}
    # v3.35-F: goal lifecycle events
    if isinstance(ev, GoalDecomposed):
        return {"event": name, "goal_text": ev.goal_text,
                "item_count": ev.item_count}
    if isinstance(ev, GoalChecklistUpdated):
        return {"event": name, "flipped": ev.flipped, "pending": ev.pending,
                "completed": ev.completed, "total": ev.total,
                "reason": ev.reason}
    if isinstance(ev, GoalDone):
        return {"event": name, "goal_text": ev.goal_text, "reason": ev.reason}
    if isinstance(ev, GoalPaused):
        return {"event": name, "goal_text": ev.goal_text, "reason": ev.reason}
    if isinstance(ev, GoalContinuation):
        return {"event": name, "turn_used": ev.turn_used,
                "max_turns": ev.max_turns}
    # v3.43-P5: bg task completion push
    if isinstance(ev, BgTaskCompleted):
        return {
            "event": name,
            "process_id": ev.process_id,
            "command": ev.command,
            "exit_code": ev.exit_code,
            "output_path": ev.output_path,
            "output_tail": ev.output_tail,
            "duration_sec": ev.duration_sec,
        }
    return {"event": name}


class _WebSocketApprovalResolver:
    """Bridge tool approval requests to websocket clients subscribed to a hub."""

    def __init__(
        self,
        *,
        hub: _Hub,
        waiters: dict[str, asyncio.Future[dict[str, Any]]],
        timeout_seconds: float,
        session_id: int,
        agent_type: str,
        actor: str,
        mode: ApprovalMode,
        smart_policy: SmartApprovalPolicy | None = None,
    ) -> None:
        self._hub = hub
        self._waiters = waiters
        self._timeout_seconds = timeout_seconds
        self._session_id = session_id
        self._agent_type = agent_type
        self._actor = actor
        self._mode = mode
        self._smart_policy = smart_policy

    async def resolve(self, request: ApprovalRequest) -> ApprovalDecision | None:
        approval_id = request.invocation_id
        await asyncio.to_thread(
            state.approval_audit_record_request,
            approval_id=approval_id,
            session_id=self._session_id,
            agent_type=self._agent_type,
            actor=self._actor,
            tool_name=request.tool_name,
            tool_input=request.tool_input,
            reason=request.reason,
        )

        if self._mode == "auto":
            decision = ApprovalDecision(
                behavior="allow",
                reason="auto approval mode",
            )
            return await self._finalize_policy_decision(
                approval_id, decision, mode="auto", source="policy",
            )

        if self._mode == "deny":
            decision = ApprovalDecision(
                behavior="deny",
                reason="deny approval mode",
            )
            return await self._finalize_policy_decision(
                approval_id, decision, mode="deny", source="policy",
            )

        if self._mode == "smart":
            policy = self._smart_policy or SmartApprovalPolicy(
                client_factory=_make_smart_approval_client,
                timeout_seconds=float(os.environ.get(
                    "SA_CHAT_SMART_APPROVAL_TIMEOUT", "20")),
            )
            outcome = await policy.resolve(request)
            return await self._finalize_policy_decision(
                approval_id,
                outcome.decision,
                mode="smart",
                source=outcome.source,
            )

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._waiters[approval_id] = fut
        await self._hub.broadcast({
            "event": "ApprovalRequested",
            "approval_id": approval_id,
            "invocation_id": request.invocation_id,
            "tool_name": request.tool_name,
            "tool_input": request.tool_input,
            "reason": request.reason,
        })
        try:
            payload = await asyncio.wait_for(fut, timeout=self._timeout_seconds)
        except asyncio.TimeoutError:
            await asyncio.to_thread(
                state.approval_audit_resolve,
                approval_id,
                decision="timeout",
                decision_reason="approval timeout",
            )
            await self._hub.broadcast({
                "event": "ApprovalResolved",
                "approval_id": approval_id,
                "decision": "timeout",
                "reason": "approval timeout",
            })
            return None
        finally:
            self._waiters.pop(approval_id, None)

        decision = str(payload.get("decision") or "").lower()
        reason = str(payload.get("reason") or "")
        updated_input = payload.get("updated_input")
        if not isinstance(updated_input, dict):
            updated_input = None
        if decision not in {"allow", "deny"}:
            await asyncio.to_thread(
                state.approval_audit_resolve,
                approval_id,
                decision="invalid",
                decision_reason="invalid approval decision",
                actor=self._actor,
            )
            await self._hub.broadcast({
                "event": "ApprovalResolved",
                "approval_id": approval_id,
                "decision": "deny",
                "reason": "invalid approval decision",
            })
            return ApprovalDecision(
                behavior="deny",
                reason="invalid approval decision",
            )
        await asyncio.to_thread(
            state.approval_audit_resolve,
            approval_id,
            decision=decision,
            decision_reason=reason,
            updated_input=updated_input,
            actor=self._actor,
        )
        await self._hub.broadcast({
            "event": "ApprovalResolved",
            "approval_id": approval_id,
            "decision": decision,
            "reason": reason,
        })
        return ApprovalDecision(
            behavior=decision,  # type: ignore[arg-type]
            reason=reason,
            updated_input=updated_input,
        )

    async def _finalize_policy_decision(
        self,
        approval_id: str,
        decision: ApprovalDecision,
        *,
        mode: str,
        source: str,
    ) -> ApprovalDecision:
        await asyncio.to_thread(
            state.approval_audit_resolve,
            approval_id,
            decision=decision.behavior,
            decision_reason=decision.reason,
            updated_input=decision.updated_input,
            actor=self._actor,
        )
        await self._hub.broadcast({
            "event": "ApprovalResolved",
            "approval_id": approval_id,
            "decision": decision.behavior,
            "reason": decision.reason,
            "mode": mode,
            "source": source,
            "auto": mode in {"auto", "smart", "deny"},
        })
        return decision


# ============================================================
# REST: history
# ============================================================

@router.post("/api/chat/new")
async def chat_new(
    _auth: None = Depends(require_token),
    agent_type: str = Query("agent"),
    label: str | None = Query(None, max_length=120),
):
    if agent_type not in valid_agent_types():
        raise HTTPException(status_code=400, detail=f"invalid agent_type: {agent_type}")

    hub = await _get_hub(_chat_channel(agent_type))
    session_id = await _start_new_chat_session(
        hub, agent_type, reason="api_request", label=label,
    )
    return {"ok": True, "agent_type": agent_type, "session_id": session_id}


@router.get("/api/chat/sessions")
async def chat_sessions(
    _auth: None = Depends(require_token),
    agent_type: str | None = None,
    include_archived: bool = False,
    limit: int = Query(100, ge=1, le=500),
) -> dict:
    if agent_type is not None and agent_type not in valid_agent_types():
        raise HTTPException(status_code=400, detail=f"invalid agent_type: {agent_type}")
    rows = state.chat_session_list(
        agent_type=agent_type,
        include_archived=include_archived,
        limit=limit,
    )
    return {
        "total": len(rows),
        "items": [_shape_chat_session(row) for row in rows],
        "agent_types": sorted(valid_agent_types()),
    }


@router.get("/api/profile")
async def chat_profile(_auth: None = Depends(require_token)) -> dict:
    """v3.82 U5: 활성 LLM 프로파일/모델 — UI 칩 하드코딩 제거용. 민감값 미노출."""
    from secu_agent.agent.llm.profile import load_profiles

    name = os.environ.get("SA_CHAT_PROFILE", "gemma")
    path = Path(os.environ.get("SA_CHAT_PROFILES_PATH", "config/llm_profiles.yaml"))
    if not path.is_absolute():
        path = _project_root() / path
    try:
        profiles = load_profiles(path)
    except (FileNotFoundError, ValueError) as e:
        return {"profile": name, "model": None, "error": str(e)}
    prof = profiles.get(name)
    if prof is None and profiles:
        name, prof = next(iter(profiles.items()))
    return {
        "profile": name,
        "model": getattr(prof, "model", None),
        "transport": getattr(prof, "transport", None),
        "reasoning_effort": (
            os.environ.get("SA_CHAT_REASONING_EFFORT")
            or getattr(prof, "reasoning_effort", None)
        ),
    }


@router.post("/api/chat/sessions")
async def chat_session_create(
    req: ChatSessionCreateRequest,
    _auth: None = Depends(require_token),
) -> dict:
    if req.agent_type not in valid_agent_types():
        raise HTTPException(status_code=400, detail=f"invalid agent_type: {req.agent_type}")
    settings = _validated_skills_settings(req.skills)
    sid = await asyncio.to_thread(
        state.chat_session_new,
        source="web",
        agent_type=req.agent_type,
        label=req.label,
        settings=settings,
    )
    row = state.chat_session_get(sid)
    return {"ok": True, "session": _shape_chat_session(row or {"id": sid, "agent_type": req.agent_type})}


@router.patch("/api/chat/sessions/{session_id}")
async def chat_session_update(
    session_id: int,
    req: ChatSessionUpdateRequest,
    _auth: None = Depends(require_token),
) -> dict:
    _get_session_or_404(session_id)
    if req.status is not None and req.status not in {"active", "archived"}:
        raise HTTPException(status_code=400, detail=f"invalid status: {req.status}")
    # v3.55: archived 로 전환 = 세션 종료 → 진행 중 백그라운드 turn 멈춤.
    if req.status == "archived":
        request_session_stop(session_id)
    await asyncio.to_thread(
        state.chat_session_update,
        session_id,
        label=req.label,
        status=req.status,
        settings=_validated_skills_settings(req.skills),
    )
    row = _get_session_or_404(session_id)
    return {"ok": True, "session": _shape_chat_session(row)}


@router.delete("/api/chat/sessions/{session_id}")
async def chat_session_delete(
    session_id: int,
    _auth: None = Depends(require_token),
) -> dict:
    _get_session_or_404(session_id)
    # v3.55: X(세션 종료) — 진행 중이던 백그라운드 turn 을 명시적으로 멈춘다.
    # (네비게이션은 안 멈추지만 세션 종료는 멈춘다.)
    request_session_stop(session_id)
    ended = await asyncio.to_thread(state.chat_session_delete, session_id)
    if not ended:
        raise HTTPException(404, f"chat session {session_id} not found")
    return {
        "ok": True,
        "session_id": session_id,
        "deleted": False,
        "ended": True,
        "status": "archived",
    }


@router.get("/api/chat/history")
async def chat_history(
    _auth: None = Depends(require_token),
    agent_type: str = Query("agent"),
    session_id: int | None = None,
    limit: int = Query(100, ge=1, le=500),
):
    if agent_type not in valid_agent_types():
        raise HTTPException(status_code=400, detail=f"invalid agent_type: {agent_type}")

    if session_id is not None:
        row = _get_session_or_404(session_id, agent_type)
        rows = state.chat_messages_for(session_id, limit=limit)
        sid = int(row["id"])
    elif _session_exists_for(agent_type):
        sid = state.chat_session_get_or_create(agent_type=agent_type)
        rows = state.chat_messages_for(sid, limit=limit)
    else:
        sid = None
        rows = []
    return {"messages": rows, "agent_type": agent_type, "session_id": sid}


def _session_exists_for(agent_type: str) -> bool:
    with state.connect() as c:
        r = c.execute(
            "SELECT 1 FROM chat_session WHERE agent_type=? "
            "AND COALESCE(status, 'active') != 'archived' LIMIT 1", (agent_type,),
        ).fetchone()
        return r is not None


# ============================================================
# WebSocket
# ============================================================

# v3.55: 세션별 "명시적 종료" 신호. 네비게이션(WS drop)은 turn 을 안 멈추고
# 백그라운드로 계속 돌린다 — 오직 X(세션 DELETE) 만 이 이벤트를 set 해서 멈춘다.
# (web 서버는 단일 event loop 라 dict[int, Event] 로 충분.)
_SESSION_STOP: dict[int, tuple[asyncio.AbstractEventLoop, asyncio.Event]] = {}


def _session_stop_event(session_id: int) -> asyncio.Event:
    loop = asyncio.get_running_loop()
    entry = _SESSION_STOP.get(session_id)
    if entry is None or entry[0] is not loop:
        ev = asyncio.Event()
        _SESSION_STOP[session_id] = (loop, ev)
    else:
        ev = entry[1]
    return ev


def request_session_stop(session_id: int) -> None:
    """X(세션 DELETE) 등에서 호출 — 진행 중 백그라운드 turn 을 명시적으로 멈춤."""
    try:
        _session_stop_event(session_id).set()
    except Exception:
        pass


# v3.55: 세션별 cancel(ESC) 신호. cancel_event 는 핸들러 인스턴스마다 따로라,
# 네비게이션 후 재접속한 새 핸들러에서 ESC 눌러도 turn 을 들고 있는 (receiver 죽은)
# 옛 핸들러엔 안 닿는다. 세션 공유 이벤트로 두면 어느 핸들러가 turn 을 들고 있든 닿음.
_SESSION_CANCEL: dict[int, tuple[asyncio.AbstractEventLoop, asyncio.Event]] = {}


def _session_cancel_event(session_id: int) -> asyncio.Event:
    loop = asyncio.get_running_loop()
    entry = _SESSION_CANCEL.get(session_id)
    if entry is None or entry[0] is not loop:
        ev = asyncio.Event()
        _SESSION_CANCEL[session_id] = (loop, ev)
    else:
        ev = entry[1]
    return ev


@router.websocket("/ws/chat")
async def ws_chat(ws: WebSocket):
    token, token_subprotocol = _ws_token_and_subprotocol(ws)
    agent_type = ws.query_params.get("agent_type", "agent")
    session_raw = ws.query_params.get("session_id")
    if not _check_token(token):
        await ws.close(code=4401)
        return
    if agent_type not in valid_agent_types():
        await ws.close(code=4400)
        return
    try:
        ws_session_id = int(session_raw) if session_raw else state.chat_session_get_or_create(
            source="web", agent_type=agent_type,
        )
    except (TypeError, ValueError):
        await ws.close(code=4400)
        return
    session_row = state.chat_session_get(ws_session_id)
    if session_row is None or session_row.get("agent_type") != agent_type:
        await ws.close(code=4400)
        return
    actor = (
        ws.query_params.get("operator")
        or os.environ.get("SA_CHAT_OPERATOR")
        or "web-operator"
    ).strip() or "web-operator"
    approval_mode = _approval_mode_for_ws(ws)

    # v1: SMB 만 실작동. 나머지는 connect 는 되지만 input 보내면 안내 메시지.
    # v3.79-perf: Hub 는 접속 초기 session_id 채널에 고정(하단 /new 로 ws_session_id
    # 가 바뀌어도 hub 객체는 그대로). finally 에서 이 채널을 회수하려고 채널을 기억.
    hub_channel = _chat_channel(agent_type, ws_session_id)
    # 이 연결이 사용한 모든 session_id — finally 에서 stop/cancel 엔트리 회수용.
    session_ids_seen: set[int] = {ws_session_id}
    hub = await _get_hub(hub_channel)
    # subprotocol 로 토큰이 왔으면 그 offer 를 에코해야 브라우저가 연결 유지
    await ws.accept(subprotocol=token_subprotocol)
    await hub.join(ws)

    # 단일 receiver task — WS 메시지를 받아 type 별로 queue/event 로 dispatch.
    # turn 진행 중에도 cancel 메시지 받을 수 있게.
    text_q: asyncio.Queue[str] = asyncio.Queue()
    cancel_event = asyncio.Event()
    disconnect_event = asyncio.Event()
    approval_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
    pending_texts: deque[str] = deque()
    meter_tasks: set[asyncio.Task] = set()

    async def _receiver() -> None:
        while True:
            try:
                raw_msg = await ws.receive_text()
            except (WebSocketDisconnect, RuntimeError):
                disconnect_event.set()
                return
            try:
                m = json.loads(raw_msg)
            except Exception:
                continue
            action = str(m.get("action") or "").strip().lower()
            if action == "cancel":
                cancel_event.set()
                # v3.55: 세션 공유 cancel 도 set — turn 이 (네비게이션 후 백그라운드로)
                # 다른 핸들러에서 돌고 있어도 닿게.
                try:
                    _session_cancel_event(ws_session_id).set()
                except Exception:
                    pass
                continue
            if action in {"new", "reset"}:
                await text_q.put("/new")
                continue
            if action == "approval":
                approval_id = str(m.get("approval_id") or "")
                fut = approval_waiters.get(approval_id)
                if fut is not None and not fut.done():
                    fut.set_result({
                        "decision": m.get("decision"),
                        "reason": m.get("reason") or "",
                        "updated_input": m.get("updated_input"),
                    })
                continue
            t = (m.get("text") or "").strip()
            if t:
                await text_q.put(t)

    receiver_task = asyncio.create_task(_receiver())

    # v3.43-P5: bg process 완료 push — subscribe + session_id 필터
    from secu_agent.agent.tools.process_tool import (
        subscribe_bg_completion, unsubscribe_bg_completion,
    )
    _ws_loop = asyncio.get_running_loop()

    def _on_bg(record, payload):
        if record.session_id != ws_session_id:
            return
        try:
            asyncio.run_coroutine_threadsafe(
                hub.broadcast({"event": "BgTaskCompleted", **payload}),
                _ws_loop,
            )
        except Exception:
            pass

    subscribe_bg_completion(_on_bg)

    async def _push_token_meter(session_id: int) -> None:
        try:
            meter = await asyncio.to_thread(_token_meter_payload, session_id)
            if meter is not None:
                await hub.broadcast(meter)
        except Exception:
            return

    def _schedule_token_meter(session_id: int) -> None:
        task = asyncio.create_task(_push_token_meter(session_id))
        meter_tasks.add(task)
        task.add_done_callback(meter_tasks.discard)

    # v3.53: watchdog 가 hang turn 을 죽인 뒤, active goal 이면 자동 재개한 횟수.
    # 연속 재개가 한도 넘으면(계속 hang) 멈춰 무한 hang-loop 방지. 정상 turn 시 reset.
    wd_resume_count = 0
    _WD_RESUME_LIMIT = int(os.environ.get("SA_CHAT_WD_RESUME_LIMIT", "8"))

    # v3.55: 재접속(다른 페이지 갔다 옴 등) 시 active goal 자동 이어가기.
    # disconnect 시 진행 중 turn 은 좀비방지로 죽으므로(위 disc_wait_task 분기),
    # 돌아오면 goal 이 active 인 채 멈춰 있다 → "다른 페이지 갔다 오면 멈춤" 증상.
    # 기존 세션 재접속 + active goal + 현재 turn 미진행이면 남은 pending 부터 재개.
    if session_raw and not pending_texts and not hub.turn_lock.locked():
        try:
            _reconnect_goal = state.goal_get_active(ws_session_id)
        except Exception:
            _reconnect_goal = None
        if (
            _reconnect_goal and _reconnect_goal.get("status") == "active"
            and _session_recently_active(ws_session_id)
        ):
            # v3.76.4: domain-agnostic resume — web 특정성(web_targets_pending) 제거.
            # goal_text 의 도메인(web/smb/github/confluence)/대화 맥락에 맞게 이어가게.
            # dormancy 가드(_session_recently_active)로 오래된 좀비 goal 부활 방지.
            pending_texts.append(
                "[재접속 재개] 진행 중이던 goal 을 그 도메인/대화 맥락에 맞게 이어서 계속하라 "
                "— 멈췄던 지점부터. 남은 대상은 해당 도메인의 pending 헬퍼로 확인. 직전 대상에서 "
                "또 멈췄던 거면 그 대상을 해당 도메인 set_status 로 skipped(reason='hang') 처리하고 다음으로."
            )
            await hub.broadcast({
                "event": "SystemNote",
                "text": "재접속 — 진행 중이던 goal 을 자동으로 이어갑니다.",
            })

    try:
        while True:
            # 다음 user text 또는 disconnect 까지 대기
            if pending_texts:
                user_text = pending_texts.popleft()
            else:
                get_task = asyncio.create_task(text_q.get())
                disc_task = asyncio.create_task(disconnect_event.wait())
                done, _pending = await asyncio.wait(
                    [get_task, disc_task], return_when=asyncio.FIRST_COMPLETED,
                )
                if disc_task in done:
                    get_task.cancel()
                    break
                disc_task.cancel()
                user_text = get_task.result()
            # 새 turn 시작 직전 이전 cancel signal 비우기
            cancel_event.clear()

            if _is_new_chat_command(user_text):
                pending_texts.clear()
                ws_session_id = await _start_new_chat_session(
                    hub, agent_type, reason="websocket_command",
                )
                session_ids_seen.add(ws_session_id)
                continue

            # v3.24-B: /compact slash command — 사용자 수동 압축 trigger.
            # "/compact [focus topic]" 형식. LLM turn 실행 안 함.
            if user_text.strip().startswith("/compact"):
                _focus = user_text.strip()[len("/compact"):].strip() or None
                client = _make_llm_client()
                sess = ChatSession.load(
                    client=client, evidence_dir=_evidence_dir(),
                    task_type=_runtime_task_type(agent_type),
                    frontend_capabilities={"interactive_approval"},
                    session_id=ws_session_id,
                    session_agent_type=agent_type,
                    # v3.82 U5: per-session skill 선택 (settings JSON — 턴마다
                    # 재적용: 웹은 매 턴 ChatSession.load 재호출이라 DB 영속 필요)
                    skills_selection=_session_skills_selection(ws_session_id)
                    if ws_session_id is not None else None,
                )
                try:
                    stats = await sess.maybe_compress(force=True, focus_topic=_focus)
                finally:
                    await client.aclose()
                if stats is None:
                    await hub.broadcast({
                        "event": "SystemNote",
                        "text": "압축 대상 없음 (summarizer 미활성 또는 메시지 너무 적음).",
                    })
                else:
                    note = (
                        f"/compact 실행: {stats['middle_count']}개 turn → summary, "
                        f"{stats['savings_pct']:.0f}% 절약."
                    )
                    if stats.get("summary_error"):
                        note += f" ⚠ {stats['summary_error']}"
                    await hub.broadcast({"event": "SystemNote", "text": note})
                continue

            # 거대 paste 면 stub 으로 replace — LLM input 작게 유지.
            # 원본은 paste_cache 에 저장, agent 가 python_exec 으로 fetch.
            paste_threshold = int(os.environ.get("SA_CHAT_PASTE_THRESHOLD", "4000"))
            stub_text, paste_id = await asyncio.to_thread(
                maybe_stub, user_text, threshold=paste_threshold,
            )
            raw_user_text = user_text

            async with hub.turn_lock:
                client = _make_llm_client()
                sess = ChatSession.load(
                    client=client, evidence_dir=_evidence_dir(),
                    task_type=_runtime_task_type(agent_type),
                    frontend_capabilities={"interactive_approval"},
                    session_id=ws_session_id,
                    session_agent_type=agent_type,
                    # v3.82 U5: per-session skill 선택 (settings JSON — 턴마다
                    # 재적용: 웹은 매 턴 ChatSession.load 재호출이라 DB 영속 필요)
                    skills_selection=_session_skills_selection(ws_session_id)
                    if ws_session_id is not None else None,
                )
                sess_context = getattr(sess, "context", None)
                if sess_context is not None:
                    sess_context.approval_resolver = _WebSocketApprovalResolver(
                        hub=hub,
                        waiters=approval_waiters,
                        timeout_seconds=float(os.environ.get(
                            "SA_CHAT_APPROVAL_TIMEOUT", "300")),
                        session_id=sess.session_id,
                        agent_type=agent_type,
                        actor=actor,
                        mode=approval_mode,
                    )
                await hub.broadcast({
                    "event": "UserMessage", "text": stub_text,
                    "original_chars": len(user_text),
                    "paste_id": paste_id,
                })
                # 실제 LLM/DB 영속 은 stub_text 로 진행 — agent context 작아짐.
                user_text = stub_text

                # 절대 타임아웃 대신 무활동 watchdog —
                # 이벤트 (token / reasoning / tool start/complete) 가 흐르면 살려두고,
                # N초 침묵이면 그때 cancel. 큰 tool (긴 walk 등) 도 살려둠.
                inactivity_limit = float(os.environ.get(
                    "SA_CHAT_INACTIVITY_TIMEOUT", "180"))
                check_interval = float(os.environ.get(
                    "SA_CHAT_INACTIVITY_CHECK_INTERVAL", "5"))
                last_ts = time.monotonic()

                async def _run_turn():
                    nonlocal last_ts
                    async for ev in sess.turn(user_text):
                        last_ts = time.monotonic()
                        await hub.broadcast(_event_to_payload(ev))
                        # v3.79 ② U1: LLM 호출 경계(TurnStarted)마다 누적 토큰
                        # 미터 push — 직전 호출의 token_usage 가 DB 에 이미 기록됨.
                        if isinstance(ev, TurnStarted):
                            _schedule_token_meter(sess.session_id)
                    # turn 종료 — 마지막 LLM 호출분까지 미터 반영
                    meter = await asyncio.to_thread(
                        _token_meter_payload, sess.session_id,
                    )
                    if meter is not None:
                        await hub.broadcast(meter)

                async def _watchdog(task: asyncio.Task) -> None:
                    while not task.done():
                        try:
                            await asyncio.sleep(check_interval)
                        except asyncio.CancelledError:
                            return
                        if time.monotonic() - last_ts > inactivity_limit:
                            task.cancel()
                            return

                import logging
                _clog = logging.getLogger("secu_agent.chat")
                turn_task = asyncio.create_task(_run_turn())
                wd_task = asyncio.create_task(_watchdog(turn_task))
                # v3.55: 네비게이션(WS drop)은 turn 을 안 멈춘다 — client_gone 으로
                # 표시만 하고 백그라운드로 계속 drain. 명시적 종료는 stop 이벤트(X/DELETE).
                _session_stop_event(sess.session_id).clear()
                _session_cancel_event(sess.session_id).clear()
                client_gone = False
                try:
                    while True:
                        cancel_wait_task = asyncio.create_task(cancel_event.wait())
                        busy_text_task = asyncio.create_task(text_q.get())
                        disc_wait_task = asyncio.create_task(disconnect_event.wait())
                        stop_wait_task = asyncio.create_task(
                            _session_stop_event(sess.session_id).wait())
                        # v3.55: 세션 공유 cancel(ESC) — 재접속 핸들러의 ESC 도 닿게.
                        scancel_wait_task = asyncio.create_task(
                            _session_cancel_event(sess.session_id).wait())
                        # client_gone 이후엔 죽은 receiver(cancel/busy/disc)는 안 기다림.
                        # 단 stop/scancel 은 세션 공유라 client_gone 이어도 계속 감시.
                        if client_gone:
                            wait_set = [turn_task, stop_wait_task, scancel_wait_task]
                        else:
                            wait_set = [turn_task, cancel_wait_task, busy_text_task,
                                        disc_wait_task, stop_wait_task, scancel_wait_task]
                        try:
                            done, _pending = await asyncio.wait(
                                wait_set, return_when=asyncio.FIRST_COMPLETED,
                            )

                            # v3.55: 명시적 종료(X/세션 DELETE) — ESC 와 동일하게 멈춘다.
                            if stop_wait_task in done and not turn_task.done():
                                _clog.warning(
                                    "session stop(X/DELETE) session=%s — cancel turn",
                                    sess.session_id,
                                )
                                sig = getattr(sess_context, "signal", None)
                                if sig is not None and hasattr(sig, "set"):
                                    sig.set()
                                turn_task.cancel()
                                try:
                                    await asyncio.wait_for(
                                        asyncio.shield(turn_task), timeout=8.0,
                                    )
                                except (asyncio.CancelledError, asyncio.TimeoutError,
                                        Exception):
                                    pass
                                # v3.79 ④: 명시적 종료 — active goal pause (재동작 방지)
                                await asyncio.to_thread(
                                    pause_goal_for_user_cancel, sess.session_id,
                                )
                                break

                            # v3.55: 네비게이션/탭이탈(WS drop) — turn 을 죽이지 않는다.
                            # client_gone 표시 후 백그라운드로 turn 을 끝까지 drain
                            # (web-batch goal 은 한 turn 안에서 자가연속). hub 는 영속이라
                            # 재접속하면 같은 채널의 라이브 이벤트를 다시 받는다.
                            # 멈추는 건 오직 X(세션 DELETE)→stop 이벤트 / ESC cancel /
                            # 무활동 watchdog.
                            if disc_wait_task in done and not turn_task.done():
                                if not client_gone:
                                    client_gone = True
                                    _clog.info(
                                        "client disconnected session=%s — "
                                        "turn 계속(백그라운드 drain)", sess.session_id,
                                    )
                                continue

                            if turn_task in done:
                                if busy_text_task in done:
                                    incoming = busy_text_task.result().strip()
                                    if incoming:
                                        pending_texts.appendleft(incoming)
                                # turn 종료. cancelled() == True 면 watchdog 발동.
                                # task.exception() 은 cancelled task 면 raise 하므로
                                # cancelled 먼저 체크.
                                if turn_task.cancelled():
                                    silent_for = time.monotonic() - last_ts
                                    # v3.53: hang 으로 죽였지만 active goal 이 있으면
                                    # 자동 재개 (자율 점검이라 매번 ESC 못 함). hang 단계는
                                    # 버리고 다음 대상부터 이어가도록 합성 continue 큐잉.
                                    _goal = None
                                    try:
                                        _goal = state.goal_get_active(sess.session_id)
                                    except Exception:
                                        _goal = None
                                    _goal_active = bool(_goal and _goal.get("status") == "active")
                                    if _goal_active and wd_resume_count < _WD_RESUME_LIMIT:
                                        wd_resume_count += 1
                                        await asyncio.to_thread(
                                            _persist_cancel_note_best_effort,
                                            sess.session_id,
                                            "직전 turn 이 무활동(hang)으로 자동 중단됐다. 그 "
                                            "단계는 버리고, goal 의 남은 pending 대상부터 "
                                            "이어서 진행하라. 같은 대상에서 또 멈추면 그 대상은 "
                                            "skipped(reason='hang') 처리하고 다음으로 넘어가라.",
                                        )
                                        pending_texts.append(
                                            "[자동 재개] 직전 단계가 hang 으로 중단됨. "
                                            "진행 중이던 goal 을 그 도메인/대화 맥락에 맞게 이어서 진행 "
                                            "— 남은 대상은 해당 도메인 pending 헬퍼로 확인."
                                        )
                                        await hub.broadcast({
                                            "event": "LoopError",
                                            "message": (
                                                f"무활동 {silent_for:.0f}s 초과 — turn 중단. "
                                                f"goal 자동 재개 ({wd_resume_count}/{_WD_RESUME_LIMIT})."
                                            ),
                                        })
                                    else:
                                        await hub.broadcast({
                                            "event": "LoopError",
                                            "message": (
                                                f"무활동 {silent_for:.0f}s 초과 — turn 중단. "
                                                + ("자동 재개 한도 초과 — 멈춤."
                                                   if _goal_active else
                                                   "LLM/도구 가 hang 한 것으로 판단.")
                                            ),
                                        })
                                else:
                                    wd_resume_count = 0  # 정상 완료 — 재개 카운터 reset
                                    exc = turn_task.exception()
                                    if exc is not None:
                                        await hub.broadcast({
                                            "event": "LoopError",
                                            "message": f"{type(exc).__name__}: {exc}",
                                        })
                                break

                            if (cancel_wait_task in done or scancel_wait_task in done) \
                                    and not turn_task.done():
                                # cancel 신호 도착 → turn 강제 종료
                                import logging
                                _clog = logging.getLogger("secu_agent.chat")
                                _clog.warning(
                                    "cancel received session=%s — signal.set + turn_task.cancel",
                                    sess.session_id,
                                )
                                sig = getattr(sess_context, "signal", None)
                                if sig is not None and hasattr(sig, "set"):
                                    sig.set()
                                turn_task.cancel()
                                # sync-blocking tool (to_thread) 이 CancelledError 를 즉시
                                # 안 받아 await 가 오래 걸릴 수 있음 → timeout 후 UI 는 풀어줌.
                                # signal 이 set 됐으므로 background turn 은 다음 boundary 에 멈춤.
                                try:
                                    await asyncio.wait_for(
                                        asyncio.shield(turn_task), timeout=8.0,
                                    )
                                except (asyncio.CancelledError, asyncio.TimeoutError, Exception) as e:
                                    _clog.warning(
                                        "cancel await session=%s ended via %s (turn_task.done=%s)",
                                        sess.session_id, type(e).__name__, turn_task.done(),
                                    )
                                # v3.23-I: DB 에 system note 박기 — 다음 turn 의 LLM
                                # context 에 들어가 "이전 작업 이어가지 마라" 명령.
                                cancel_note = (
                                    "사용자가 직전 turn 을 cancel 했습니다. 진행 중이던 도구 "
                                    "호출 / 단계는 중단됐고 결과 없습니다. 이전 작업 자동 이어가지 "
                                    "마라 — 사용자의 다음 메시지를 새 의도로 처리하라."
                                )
                                await asyncio.to_thread(
                                    _persist_cancel_note_best_effort,
                                    sess.session_id, cancel_note,
                                )
                                # v3.79 ④: cancel note 는 LLM 만 본다 — batch driver 는
                                # 코드 결정론으로 active goal 을 재가동하므로 goal 자체 pause.
                                await asyncio.to_thread(
                                    pause_goal_for_user_cancel, sess.session_id,
                                )
                                await hub.broadcast({
                                    "event": "LoopError",
                                    "message": "사용자 cancel — turn 중단.",
                                })
                                break

                            if busy_text_task in done:
                                incoming = busy_text_task.result().strip()
                                if not incoming:
                                    continue
                                if _is_new_chat_command(incoming):
                                    sig = getattr(sess_context, "signal", None)
                                    if sig is not None and hasattr(sig, "set"):
                                        sig.set()
                                    turn_task.cancel()
                                    try:
                                        await turn_task
                                    except (asyncio.CancelledError, Exception):
                                        pass
                                    reset_note = (
                                        "사용자가 새 대화를 시작했습니다. 진행 중이던 turn 과 "
                                        "대기 중 입력은 중단됐고, 이후 메시지는 새 chat_session "
                                        "컨텍스트에서 처리한다."
                                    )
                                    await asyncio.to_thread(
                                        _persist_cancel_note_best_effort,
                                        sess.session_id, reset_note,
                                    )
                                    # v3.79 ④: 새 채팅 시작 — 옛 세션 goal pause
                                    await asyncio.to_thread(
                                        pause_goal_for_user_cancel, sess.session_id,
                                    )
                                    pending_texts.clear()
                                    ws_session_id = await _start_new_chat_session(
                                        hub, agent_type,
                                        reason="websocket_command_during_turn",
                                    )
                                    session_ids_seen.add(ws_session_id)
                                    break
                                decision = classify_busy_input(raw_user_text, incoming)
                                if decision.disposition == "queue_after_current":
                                    pending_texts.append(incoming)
                                    await hub.broadcast({
                                        "event": "TurnInputQueued",
                                        "text": incoming,
                                        "queue_depth": len(pending_texts),
                                        "reason": decision.reason,
                                    })
                                    continue

                                sig = getattr(sess_context, "signal", None)
                                if sig is not None and hasattr(sig, "set"):
                                    sig.set()
                                turn_task.cancel()
                                try:
                                    await turn_task
                                except (asyncio.CancelledError, Exception):
                                    pass
                                revision_note = (
                                    "사용자가 진행 중 turn 을 새 지시로 수정했습니다. "
                                    "이전 작업은 자동으로 이어가지 말고 다음 사용자 메시지를 "
                                    "수정된 의도로 처리하라."
                                )
                                await asyncio.to_thread(
                                    _persist_cancel_note_best_effort,
                                    sess.session_id, revision_note,
                                )
                                # v3.79 ④: 지시 수정 — 진행 중 goal pause (사용자가
                                # resume 또는 새 goal set 으로만 재개)
                                await asyncio.to_thread(
                                    pause_goal_for_user_cancel, sess.session_id,
                                )
                                pending_texts.appendleft(incoming)
                                await hub.broadcast({
                                    "event": "TurnRevisionAccepted",
                                    "text": incoming,
                                    "reason": decision.reason,
                                })
                                break
                        finally:
                            for t in (cancel_wait_task, busy_text_task,
                                      disc_wait_task, stop_wait_task,
                                      scancel_wait_task):
                                if not t.done():
                                    t.cancel()
                                    try:
                                        await t
                                    except (asyncio.CancelledError, Exception):
                                        pass
                finally:
                    for t in (wd_task,):
                        if not t.done():
                            t.cancel()
                            try:
                                await t
                            except (asyncio.CancelledError, Exception):
                                pass
    finally:
        # v3.43-P5: bg subscriber 해제
        unsubscribe_bg_completion(_on_bg)
        if not receiver_task.done():
            receiver_task.cancel()
            try:
                await receiver_task
            except (asyncio.CancelledError, Exception):
                pass
        if meter_tasks:
            for t in list(meter_tasks):
                if not t.done():
                    t.cancel()
            await asyncio.gather(*meter_tasks, return_exceptions=True)
        await hub.leave(ws)
        # v3.79-perf: 마지막 구독자면 세션 채널(Hub + stop/cancel 엔트리) 회수 —
        # 장수 서버의 세션당 누적 메모리 누수 방지. 다중 뷰어가 남아 있으면 no-op.
        await _release_session_channel(hub_channel, session_ids_seen, hub)
