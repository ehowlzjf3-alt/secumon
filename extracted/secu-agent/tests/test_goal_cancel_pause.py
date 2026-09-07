"""v3.79 ④: 명시적 cancel → active goal pause — '취소했는데 다음 메시지에 재동작' 제거.

배경: ESC/X/새채팅 cancel 은 signal.set + turn_task.cancel + cancel note 만 남기고
goal 은 DB 에 active 로 잔존했다. batch driver(web/smb/github/confluence)는 LLM 을
거치지 않는 코드 결정론이라 cancel note 를 못 보고, 다음 아무 user 메시지에서
RalphController 가 active goal 을 발견해 batch 를 재가동했다.

수정: (1) goal_manager.pause_goal_for_user_cancel — 공용 헬퍼.
(2) RalphController.run 의 signal 감지 분기에서 호출 (knox/scheduler 포함 전 호출자).
(3) chat.py 의 명시적 cancel 4개 사이트에서도 호출 (task.cancel 레이스 보완).
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from secu_agent import state
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.types import (
    LLMRequest, StreamMessageStop, StreamTextDelta, StreamUsage,
)


class _ScriptedFakeLLM(LLMClient):
    def __init__(self, replies: list[str]):
        self._replies = list(replies)
        self._idx = 0

    @property
    def name(self) -> str:
        return "scripted"

    async def stream(self, request: LLMRequest) -> AsyncIterator:
        text = self._replies[self._idx] if self._idx < len(self._replies) else "(done)"
        self._idx += 1
        yield StreamTextDelta(text=text)
        yield StreamMessageStop(
            stop_reason="end_turn",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        )


def _collect(aiter):
    async def _go():
        return [x async for x in aiter]
    return asyncio.run(_go())


# ---- 공용 헬퍼 ----

def test_pause_goal_for_user_cancel_pauses_active(tmp_db):
    from secu_agent.agent.goal_manager import pause_goal_for_user_cancel
    sid = state.chat_session_get_or_create()
    state.goal_set(sid, goal_text="[web-batch] 전부 점검", max_turns=0)
    assert pause_goal_for_user_cancel(sid) is True
    g = state.goal_get_active(sid)
    assert g is not None and g["status"] == "paused"
    assert "cancel" in (g.get("paused_reason") or "")


def test_pause_goal_for_user_cancel_noop_without_goal(tmp_db):
    from secu_agent.agent.goal_manager import pause_goal_for_user_cancel
    sid = state.chat_session_get_or_create()
    assert pause_goal_for_user_cancel(sid) is False


def test_pause_goal_for_user_cancel_noop_on_paused(tmp_db):
    """이미 paused 면 사유 안 덮어씀 (idempotent no-op)."""
    from secu_agent.agent.goal_manager import pause_goal_for_user_cancel
    sid = state.chat_session_get_or_create()
    state.goal_set(sid, goal_text="x")
    state.goal_pause(sid, reason="max_turns 소진")
    assert pause_goal_for_user_cancel(sid) is False
    g = state.goal_get_active(sid)
    assert g["paused_reason"] == "max_turns 소진"


# ---- RalphController: signal 감지 시 goal pause ----

def test_ralph_run_pauses_goal_on_cancel_signal(tmp_db, tmp_path):
    from secu_agent.agent.chat_session import ChatSession
    from secu_agent.agent.ralph_controller import RalphController

    sid = state.chat_session_new(agent_type="operator")
    state.goal_set(sid, goal_text="[web-batch] 발견된 도메인 전부 점검", max_turns=0)
    sess = ChatSession.load(client=_ScriptedFakeLLM(["진행 중"]), evidence_dir=tmp_path)
    sess.session_id = sid
    sess.context.metadata["session_id"] = sid
    sess.context.signal.set()  # 사용자 cancel (ESC) 도착 상태

    _collect(RalphController(sess).run())

    g = state.goal_get_active(sid)
    assert g is not None, "goal 이 사라지면 안 됨 (pause 가 맞음)"
    assert g["status"] == "paused", (
        f"cancel 후 goal 이 {g['status']} — active 로 남으면 다음 메시지에 batch 재가동"
    )


def test_ralph_run_without_signal_goal_not_cancel_paused(tmp_db, tmp_path):
    """signal 없으면 사용자-cancel pause 를 타지 않는다 — 회귀 가드.

    de-domain: 원형은 web-batch driver 의 결정론 done(대상 0)에 의존했으나 driver 는
    plugin 소유로 이동. 코어 계약: signal 부재 시 pause_goal_for_user_cancel 미호출 —
    max_turns 소진 pause 는 정상 경로라 허용.
    """
    from secu_agent.agent.chat_session import ChatSession
    from secu_agent.agent.ralph_controller import RalphController

    sid = state.chat_session_new(agent_type="operator")
    state.goal_set(sid, goal_text="등록된 점검 항목 전체를 순차 처리한다", max_turns=1)
    sess = ChatSession.load(client=_ScriptedFakeLLM(["대상 없음"]), evidence_dir=tmp_path)
    sess.session_id = sid
    sess.context.metadata["session_id"] = sid

    _collect(RalphController(sess).run())

    g = state.goal_get_active(sid)
    assert g is not None
    assert (g.get("paused_reason") or "") != "사용자 cancel — 자동 진행 중단"


def test_paused_goal_does_not_resume_on_next_user_turn(tmp_db, tmp_path):
    """paused goal 은 명시 resume 전까지 다음 메시지에서 batch driver 를 재가동하지 않는다."""
    from secu_agent.agent.chat_session import ChatSession
    from secu_agent.agent.events import GoalContinuation

    sid = state.chat_session_new(agent_type="operator")
    state.goal_set(
        sid,
        goal_text=(
            "오피스영역 전체 SMB 점검을 처음부터 다시 시작한다. "
            "등록된 오피스 SMB pending subnet 큐를 확인하고 subnet discovery를 수행한다."
        ),
        max_turns=0,
    )
    state.goal_pause(sid, reason="사용자 cancel — 자동 진행 중단")

    sess = ChatSession.load(client=_ScriptedFakeLLM(["상태 확인만 보고"]), evidence_dir=tmp_path)
    sess.session_id = sid
    sess.context.metadata["session_id"] = sid

    events = _collect(sess.turn("상태만 확인"))

    assert not any(isinstance(e, GoalContinuation) for e in events)
    g = state.goal_get_active(sid)
    assert g is not None
    assert g["status"] == "paused"
    assert "cancel" in (g.get("paused_reason") or "")


def test_explicit_continue_resumes_paused_goal_and_injects_continuation(tmp_db, tmp_path):
    """사용자가 '계속 진행'을 명시하면 paused goal 을 resume 하고 루프를 재개한다.

    de-domain: SMB driver 재가동 원형 테스트는 secu-agent-skill/tests 로 이동 —
    코어 계약은 resume 전이 + 시스템 노트 + generic continuation + max_turns pause.
    """
    from secu_agent.agent.chat_session import ChatSession
    from secu_agent.agent.events import GoalContinuation

    sid = state.chat_session_new(agent_type="operator")
    state.goal_set(
        sid, goal_text="등록된 점검 항목 전체를 순차 처리한다", max_turns=2,
    )
    state.goal_pause(sid, reason="fallback checklist reached terminal")

    sess = ChatSession.load(client=_ScriptedFakeLLM(["재개 확인"]), evidence_dir=tmp_path)
    sess.session_id = sid
    sess.context.metadata["session_id"] = sid

    events = _collect(sess.turn("계속 진행"))

    assert any(isinstance(e, GoalContinuation) for e in events)
    g = state.goal_get_active(sid)
    assert g is not None
    assert g["status"] == "paused"
    assert g["paused_reason"] == "max_turns 소진"
    with state.connect() as c:
        note = c.execute(
            "SELECT content FROM chat_message WHERE session_id=? AND role='system' "
            "AND content LIKE ? ORDER BY created_at DESC LIMIT 1",
            (sid, '%goal resume%'),
        ).fetchone()["content"]
    assert "goal resume" in str(note)


# ---- goal_set 단일 active 불변식 (원자화 회귀 가드) ----

def test_goal_set_leaves_single_nonterminal_row(tmp_db):
    sid = state.chat_session_get_or_create()
    state.goal_set(sid, goal_text="첫번째")
    gid2 = state.goal_set(sid, goal_text="두번째")
    with state.connect() as c:
        rows = c.execute(
            "SELECT id, status FROM chat_goal WHERE session_id=? "
            "AND status NOT IN (?, ?)",
            (sid, *state._GOAL_TERMINAL_STATUSES),
        ).fetchall()
    assert len(rows) == 1
    assert int(rows[0]["id"]) == gid2
