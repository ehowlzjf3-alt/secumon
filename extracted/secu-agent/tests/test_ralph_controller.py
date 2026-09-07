"""v3.64 (H2): RalphController 추출 — ChatSession 위임 + 구조 검증.

순수 relocation 이므로 동작 spec 은 test_chat_session_goal_loop / batch_driver /
continuation 이 담당. 여기서는 (1) 오케스트레이션이 ChatSession 에서 빠지고
RalphController 로 이동했는지 (2) turn() 이 컨트롤러에 위임하는지를 확인.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest

from secu_agent import state
from secu_agent.agent.events import (
    GoalChecklistUpdated, GoalDone, GoalPaused, LoopEvent,
)
from secu_agent.agent.goal_manager import ChecklistItem, EvaluateResult
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.types import (
    LLMRequest, StreamMessageStop, StreamTextDelta, StreamUsage,
)
from secu_agent.agent import ralph_controller as ralph_controller_mod
from secu_agent.agent.ralph_controller import RalphController


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


def _sess(client, evidence_dir):
    from secu_agent.agent.chat_session import ChatSession
    return ChatSession.load(client=client, evidence_dir=evidence_dir)


class _EvalPhaseSession:
    def __init__(self, session_id: int):
        self.session_id = session_id
        self.client = object()


def _seed_decomposed_goal(goal_text: str = "generic goal") -> tuple[int, int]:
    sid = state.chat_session_new(agent_type="operator")
    gid = state.goal_set(sid, goal_text=goal_text, max_turns=0)
    state.goal_update_checklist(
        gid, checklist=[ChecklistItem(text="A").to_dict()], decomposed=True,
    )
    return sid, gid


def _run_eval_phase(rc: RalphController, sid: int, assistant_text: str):
    async def _go():
        goal = state.goal_get_active(sid)
        assert goal is not None
        return [ev async for ev in rc._goal_evaluate_phase(goal, assistant_text)]
    return asyncio.run(_go())


# ---- 구조: 오케스트레이션이 ChatSession 에서 RalphController 로 이동 ----

def test_orchestration_methods_moved_off_chatsession():
    from secu_agent.agent.chat_session import ChatSession
    moved = [
        "_goal_decompose_phase", "_goal_evaluate_phase",
    ]
    for m in moved:
        assert not hasattr(ChatSession, m), f"ChatSession 에 {m} 가 아직 남아있음"
        assert hasattr(RalphController, m), f"RalphController 에 {m} 없음"
    # de-domain: 도메인 batch phase 는 엔진 어디에도 없어야 한다 (plugin 소유)
    for m in ("_web_batch_phase", "_smb_batch_phase", "_smb_subnet_phase",
              "_github_batch_phase", "_confluence_batch_phase", "_devops_batch_phase"):
        assert not hasattr(ChatSession, m), f"ChatSession 에 도메인 phase {m} 잔존"
        assert not hasattr(RalphController, m), f"RalphController 에 도메인 phase {m} 잔존"
    # 세션관리 메서드는 ChatSession 에 잔류
    for m in ("load", "turn", "_run_engine_pass", "_persist_last_assistant",
              "maybe_compress"):
        assert hasattr(ChatSession, m)


def test_controller_holds_session_ref(tmp_db, tmp_path):
    sess = _sess(_ScriptedFakeLLM(["hi"]), tmp_path)
    rc = RalphController(sess)
    assert rc._s is sess


# ---- 위임: turn() 이 컨트롤러 run() 을 타고 동일 동작 ----

def test_turn_no_goal_single_pass(tmp_db, tmp_path):
    """goal 없으면 1 pass 후 종료 (goal lifecycle 이벤트 없음)."""
    sess = _sess(_ScriptedFakeLLM(["assistant 답변"]), tmp_path)
    events = _collect(sess.turn("안녕"))
    names = {type(e).__name__ for e in events}
    assert "GoalDecomposed" not in names
    assert "GoalDone" not in names


def test_turn_delegates_to_controller(tmp_db, tmp_path, monkeypatch):
    """turn() 이 RalphController.run() 에 위임함을 spy 로 확인."""
    sess = _sess(_ScriptedFakeLLM(["x"]), tmp_path)
    called = {"n": 0}
    real_run = RalphController.run

    def spy_run(self):
        called["n"] += 1
        return real_run(self)

    monkeypatch.setattr(RalphController, "run", spy_run)
    _collect(sess.turn("hello"))
    assert called["n"] == 1


# de-domain: 도메인 batch phase 직접 호출 테스트는 secu-agent-skill/tests 로 이동


# ---- v3.71: run() 루프가 매 iteration 압축 점검 ----

def test_run_loop_calls_maybe_compress_each_iteration(tmp_db, tmp_path, monkeypatch):
    """run() 의 while 루프가 engine pass 직전 maybe_compress 를 호출(컨텍스트 무한증가 방지)."""
    sess = _sess(_ScriptedFakeLLM(["답변"]), tmp_path)
    calls = {"n": 0}

    async def _fake_compress(*a, **k):
        calls["n"] += 1
        return None

    monkeypatch.setattr(sess, "maybe_compress", _fake_compress)
    # goal 없음 → 1 pass 후 종료. 루프 top 의 maybe_compress 가 최소 1회.
    _collect(RalphController(sess).run())
    assert calls["n"] >= 1


# ---- generic goal judge gate ------------------------------------------------

def test_goal_evaluate_phase_gates_judge_but_records_every_turn(tmp_db, monkeypatch):
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "3")
    monkeypatch.setenv("SA_GOAL_NO_PROGRESS_LIMIT", "0")  # 게이팅 spec 에 집중
    sid, gid = _seed_decomposed_goal()
    rc = RalphController(_EvalPhaseSession(sid))
    judge_calls = {"n": 0}
    record_calls = []
    real_record_turn = state.goal_record_turn

    async def fake_goal_evaluate(**kwargs):
        judge_calls["n"] += 1
        return EvaluateResult(updates=[], new_items=[], reason="still working")

    def spy_record_turn(goal_id, *, verdict, reason, parse_fail, progress=None):
        record_calls.append((goal_id, verdict, reason, parse_fail))
        return real_record_turn(
            goal_id, verdict=verdict, reason=reason, parse_fail=parse_fail,
            progress=progress,
        )

    monkeypatch.setattr(ralph_controller_mod, "goal_evaluate", fake_goal_evaluate)
    monkeypatch.setattr(state, "goal_record_turn", spy_record_turn)

    events = []
    for _ in range(8):
        events.extend(_run_eval_phase(rc, sid, "working"))

    assert judge_calls["n"] == 3  # pre-turns 0, 3, 6
    assert len(record_calls) == 8
    assert state.goal_get_active(sid)["turns_used"] == 8
    # v3.81 T1a: judge 실행 턴만 False, 게이트 턴은 None(streak 보존)
    judged = [record_calls[i][3] for i in (0, 3, 6)]
    gated = [c[3] for i, c in enumerate(record_calls) if i not in (0, 3, 6)]
    assert all(v is False for v in judged)
    assert all(v is None for v in gated)
    assert sum(isinstance(ev, GoalChecklistUpdated) for ev in events) == 3
    assert all(call[1] == "continue" for call in record_calls)
    assert {call[0] for call in record_calls} == {gid}


def test_goal_evaluate_phase_detects_done_within_gate_window(tmp_db, monkeypatch):
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "3")
    sid, _gid = _seed_decomposed_goal()
    rc = RalphController(_EvalPhaseSession(sid))
    judge_texts = []

    async def fake_goal_evaluate(**kwargs):
        assistant_text = kwargs["assistant_text"]
        judge_texts.append(assistant_text)
        if "done" in assistant_text:
            return EvaluateResult(
                updates=[{"index": 1, "status": "completed", "evidence": "done"}],
                new_items=[],
                reason="all done",
            )
        return EvaluateResult(updates=[], new_items=[], reason="continue")

    monkeypatch.setattr(ralph_controller_mod, "goal_evaluate", fake_goal_evaluate)

    _run_eval_phase(rc, sid, "working")
    done_after = None
    for i in range(1, 4):
        events = _run_eval_phase(rc, sid, "done now")
        if any(isinstance(ev, GoalDone) for ev in events):
            done_after = i
            break

    assert done_after is not None and done_after <= 3
    assert judge_texts == ["working", "done now"]
    assert state.goal_get_active(sid) is None


def test_goal_evaluate_phase_every_one_preserves_old_cadence(tmp_db, monkeypatch):
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "1")
    monkeypatch.setenv("SA_GOAL_NO_PROGRESS_LIMIT", "0")  # cadence spec 에 집중
    sid, _gid = _seed_decomposed_goal()
    rc = RalphController(_EvalPhaseSession(sid))
    judge_calls = {"n": 0}

    async def fake_goal_evaluate(**kwargs):
        judge_calls["n"] += 1
        return EvaluateResult(updates=[], new_items=[], reason="still working")

    monkeypatch.setattr(ralph_controller_mod, "goal_evaluate", fake_goal_evaluate)

    for _ in range(4):
        _run_eval_phase(rc, sid, "working")

    assert judge_calls["n"] == 4
    assert state.goal_get_active(sid)["turns_used"] == 4


# ---- v3.81 T1a: termination_gap — parse-fail streak 보존 + 무진전 안전종료 ----


def test_parse_fail_streak_survives_gate_turns(tmp_db, monkeypatch):
    """게이트 턴이 parse_fail_streak 을 리셋하지 않아 judge_every>1 에서도
    parse-fail 3x 탈출구가 실제로 도달 가능해야 한다 (termination_gap 핵심)."""
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "3")
    sid, _gid = _seed_decomposed_goal()
    rc = RalphController(_EvalPhaseSession(sid))

    async def broken_goal_evaluate(**kwargs):
        raise RuntimeError("judge down")

    monkeypatch.setattr(ralph_controller_mod, "goal_evaluate", broken_goal_evaluate)

    # judge 턴 = pre-turn 0, 3, 6 → 7 iteration 에 judge 3회 + 게이트 4회
    for _ in range(7):
        _run_eval_phase(rc, sid, "working")

    g = state.goal_get_active(sid)
    assert g["parse_fail_streak"] == 3  # 이전 동작: 게이트 턴 리셋으로 영원히 1


def test_no_progress_judge_pauses_goal(tmp_db, monkeypatch):
    """연속 무진전 judge 턴(flips=0 ∧ new_items=0) N회면 GoalPaused —
    max_turns=0 무한루프의 in-loop 안전 종료."""
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "1")
    sid, _gid = _seed_decomposed_goal()
    rc = RalphController(_EvalPhaseSession(sid))

    async def stuck_goal_evaluate(**kwargs):
        return EvaluateResult(updates=[], new_items=[], reason="still working")

    monkeypatch.setattr(ralph_controller_mod, "goal_evaluate", stuck_goal_evaluate)

    events = []
    for _ in range(3):
        events.extend(_run_eval_phase(rc, sid, "working"))

    assert any(isinstance(ev, GoalPaused) for ev in events)
    g = state.goal_get_active(sid)
    assert g["status"] == "paused"
    assert "무진전" in (g["paused_reason"] or "")
    assert g["no_progress_streak"] == 3


def test_no_progress_streak_resets_on_progress(tmp_db, monkeypatch):
    """flip 또는 신규 item 이 있으면 무진전 streak 리셋 — 진행 중 goal 오살 방지."""
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "1")
    sid, _gid = _seed_decomposed_goal()
    rc = RalphController(_EvalPhaseSession(sid))
    calls = {"n": 0}

    async def sometimes_progress(**kwargs):
        calls["n"] += 1
        if calls["n"] == 3:
            return EvaluateResult(
                updates=[], new_items=[ChecklistItem(text="B")],
                reason="new scope",
            )
        return EvaluateResult(updates=[], new_items=[], reason="no change")

    monkeypatch.setattr(ralph_controller_mod, "goal_evaluate", sometimes_progress)

    events = []
    for _ in range(5):
        events.extend(_run_eval_phase(rc, sid, "working"))

    assert not any(isinstance(ev, GoalPaused) for ev in events)
    g = state.goal_get_active(sid)
    assert g["status"] == "active"
    assert g["no_progress_streak"] == 2  # 3번째 judge 의 진전이 리셋, 이후 2회 누적


def test_no_progress_limit_zero_disables(tmp_db, monkeypatch):
    """SA_GOAL_NO_PROGRESS_LIMIT=0 = 비활성(운영자 명시 선택) — pause 없음."""
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "1")
    monkeypatch.setenv("SA_GOAL_NO_PROGRESS_LIMIT", "0")
    sid, _gid = _seed_decomposed_goal()
    rc = RalphController(_EvalPhaseSession(sid))

    async def stuck_goal_evaluate(**kwargs):
        return EvaluateResult(updates=[], new_items=[], reason="still working")

    monkeypatch.setattr(ralph_controller_mod, "goal_evaluate", stuck_goal_evaluate)

    events = []
    for _ in range(6):
        events.extend(_run_eval_phase(rc, sid, "working"))

    assert not any(isinstance(ev, GoalPaused) for ev in events)
    g = state.goal_get_active(sid)
    assert g["status"] == "active"
    assert g["no_progress_streak"] == 6


def test_run_loop_terminates_on_stuck_judge_max_turns_zero(tmp_db, tmp_path, monkeypatch):
    """termination_gap 회귀 가드: max_turns=0 + judge 무진전 continue 반복이어도
    run() 이 유한 턴 안에 GoalPaused 로 종료해야 한다 (이전: 무한루프)."""
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "1")
    sess = _sess(_ScriptedFakeLLM(["작업중"]), tmp_path)
    gid = state.goal_set(sess.session_id, goal_text="끝없는 goal", max_turns=0)
    state.goal_update_checklist(
        gid, checklist=[ChecklistItem(text="A").to_dict()], decomposed=True,
    )

    async def stuck_goal_evaluate(**kwargs):
        return EvaluateResult(updates=[], new_items=[], reason="still working")

    monkeypatch.setattr(ralph_controller_mod, "goal_evaluate", stuck_goal_evaluate)

    async def _go():
        out: list[LoopEvent] = []

        async def _drain():
            async for ev in RalphController(sess).run():
                out.append(ev)

        # 회귀 시 무한루프 → hang 대신 TimeoutError 로 fail
        await asyncio.wait_for(_drain(), timeout=30)
        return out

    events = asyncio.run(_go())
    assert any(isinstance(ev, GoalPaused) for ev in events)
    g = state.goal_get_active(sess.session_id)
    assert g["status"] == "paused"
    assert "무진전" in (g["paused_reason"] or "")


# ---- v3.81 T1c: judge 역할 모델 라우팅 배선 ----


def test_goal_judge_uses_role_client(tmp_db, monkeypatch):
    """judge 호출이 make_role_client('judge', default=세션 client) 를 경유 —
    SA_JUDGE_PROFILE 설정 시 별도 모델로 오프로드 가능."""
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "1")
    sid, _gid = _seed_decomposed_goal()
    rc = RalphController(_EvalPhaseSession(sid))
    sentinel = object()
    seen = {}

    monkeypatch.setattr(
        ralph_controller_mod, "make_role_client",
        lambda role, *, default: sentinel if role == "judge" else default,
    )

    async def fake_goal_evaluate(**kwargs):
        seen["client"] = kwargs["client"]
        return EvaluateResult(
            updates=[{"index": 1, "status": "completed", "evidence": "x"}],
            new_items=[], reason="done",
        )

    monkeypatch.setattr(ralph_controller_mod, "goal_evaluate", fake_goal_evaluate)
    _run_eval_phase(rc, sid, "working")
    assert seen["client"] is sentinel


# de-domain: 도메인 batch goal 디스패치 테스트는 plugin 재부착 후 secu-agent-skill 에서 복원
