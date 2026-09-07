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
from secu_agent.agent.events import GoalChecklistUpdated, GoalDone, LoopEvent
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
    # v3.88 de-domain: goal 오케스트레이션(decompose/evaluate)만 ChatSession→RalphController
    # 로 이동해 코어에 잔류. 도메인 batch driver(_web/_smb/_devops_batch_phase 등)는 코어에서
    # 완전히 적출돼 skill 의 register_fanout_adapter(domains/*/application/fanout.py)로 재공급됨.
    moved = ["_goal_decompose_phase", "_goal_evaluate_phase"]
    for m in moved:
        assert not hasattr(ChatSession, m), f"ChatSession 에 {m} 가 아직 남아있음"
        assert hasattr(RalphController, m), f"RalphController 에 {m} 없음"
    # de-domain: 도메인 batch phase 는 두 클래스 모두에서 제거됨(코어 소유 아님).
    for m in ("_web_batch_phase", "_smb_batch_phase", "_smb_subnet_phase",
              "_devops_batch_phase", "_github_batch_phase", "_confluence_batch_phase"):
        assert not hasattr(ChatSession, m), f"ChatSession 에 de-domained {m} 잔존"
        assert not hasattr(RalphController, m), f"RalphController 에 de-domained {m} 잔존"
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


# v3.88 de-domain: test_web_batch_done_when_no_targets 삭제됨.
# web-batch "대상 0 → 코드 결정론 GoalDone" 은 더 이상 RalphController._web_batch_phase
# 소유가 아니라 skill 의 register_fanout_adapter(domains/web/application/fanout.py) +
# collector(service/collector/runner.py) 로 이동. 해당 커버리지는 skill fanout 테스트가 담당.


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
    # v3.81 T1a: judge 실행 턴(0,3,6)만 parse_fail=False, 게이트 턴은 parse_fail=None
    # (게이트 턴이 streak 을 건드리면 parse-fail 3x 탈출구가 영원히 미발동).
    judged_idx = {0, 3, 6}
    for i, call in enumerate(record_calls):
        assert call[3] is (False if i in judged_idx else None)
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


# v3.88 de-domain: test_batch_goal_dispatch_never_calls_goal_judge 삭제됨.
# RalphController.run() 은 더 이상 goal_text 를 도메인 batch phase(_web/_smb/_subnet/
# _github/_confluence/_devops_batch_phase)로 디스패치하지 않는다(ralph_controller.py 의
# "de-domain: 도메인 batch driver ... 디스패치는 secu-agent-skill 로 적출됨" 주석 참조).
# batch goal 라우팅은 skill 의 register_task_type_canonicalizer + register_fanout_adapter 로
# 이동했고, "batch goal 은 generic judge 를 부르지 않는다" 커버리지는 skill fanout 테스트가 담당.
