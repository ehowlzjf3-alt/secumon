"""F2-E: done-critic — 인용 증거 없는 '완료'를 needs_review 로 다운그레이드.

결정론 크리틱(LLM 없음): 완료를 주장하는데 확정 finding·항목 evidence 가 모두 없으면
자동 done 대신 GoalPaused(사람 검토). finding 이나 evidence 가 하나라도 있으면 done.
"""
from __future__ import annotations

import asyncio

import pytest

from secu_agent import state
from secu_agent.agent import ralph_controller as rc_mod
from secu_agent.agent.events import GoalDone, GoalPaused
from secu_agent.agent.goal_manager import ChecklistItem, EvaluateResult
from secu_agent.agent.ralph_controller import RalphController, _done_critic_reason


class _EvalPhaseSession:
    def __init__(self, session_id: int):
        self.session_id = session_id
        self.client = object()


def _seed_goal() -> tuple[int, int]:
    sid = state.chat_session_new(agent_type="operator")
    gid = state.goal_set(sid, goal_text="g", max_turns=0)
    state.goal_update_checklist(
        gid, checklist=[ChecklistItem(text="A").to_dict()], decomposed=True,
    )
    return sid, gid


def _run_phase(rc: RalphController, sid: int):
    async def _go():
        goal = state.goal_get_active(sid)
        assert goal is not None
        return [ev async for ev in rc._goal_evaluate_phase(goal, "done working")]
    return asyncio.run(_go())


@pytest.fixture(autouse=True)
def _clear_gate():
    rc_mod._LAST_JUDGE_HASH.clear()
    rc_mod._LAST_JUDGE_TURN.clear()
    yield
    rc_mod._LAST_JUDGE_HASH.clear()
    rc_mod._LAST_JUDGE_TURN.clear()


def _complete_item(monkeypatch, *, evidence: str):
    async def fake_eval(**kw):
        return EvaluateResult(
            updates=[{"index": 1, "status": "completed", "evidence": evidence}],
            new_items=[], reason="all done",
        )
    monkeypatch.setattr(rc_mod, "goal_evaluate", fake_eval)


def _isolate(monkeypatch, *, digest: str = ""):
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "1")
    monkeypatch.setenv("SA_GOAL_NO_PROGRESS_LIMIT", "0")
    monkeypatch.setenv("SA_GOAL_EVIDENCE_SKIP_MAX", "0")  # pre-gate 비활성(판정 매턴)
    monkeypatch.setattr(rc_mod, "_build_evidence_digest", lambda **kw: digest)


# ── 단위: _done_critic_reason ──────────────────────────────────────────────

def test_reason_none_when_no_completions():
    cl = [ChecklistItem(text="A", status="impossible", evidence="x")]
    assert _done_critic_reason(cl, "") is None


def test_reason_none_when_item_has_evidence():
    cl = [ChecklistItem(text="A", status="completed", evidence="found leaked key at /x")]
    assert _done_critic_reason(cl, "") is None


def test_reason_none_when_findings_present():
    cl = [ChecklistItem(text="A", status="completed", evidence="")]
    assert _done_critic_reason(cl, "- [high] web @ x: y") is None


def test_reason_fires_when_no_evidence_and_no_findings():
    cl = [
        ChecklistItem(text="A", status="completed", evidence=""),
        ChecklistItem(text="B", status="completed", evidence=None),
    ]
    r = _done_critic_reason(cl, "")
    assert r is not None
    assert "인용 증거 없음" in r


def test_reason_none_when_at_least_one_completed_has_evidence():
    cl = [
        ChecklistItem(text="A", status="completed", evidence=""),
        ChecklistItem(text="B", status="completed", evidence="cited"),
    ]
    assert _done_critic_reason(cl, "") is None


# ── 통합: _goal_evaluate_phase 종료 경로 ────────────────────────────────────

def test_done_without_evidence_downgraded_to_paused(tmp_db, monkeypatch):
    _isolate(monkeypatch, digest="")
    _complete_item(monkeypatch, evidence="")
    sid, gid = _seed_goal()
    events = _run_phase(RalphController(_EvalPhaseSession(sid)), sid)
    paused = [ev for ev in events if isinstance(ev, GoalPaused)]
    assert paused, "인용 증거 없는 done 은 GoalPaused 로 낮춰져야 함"
    assert "인용 증거 없음" in paused[0].reason
    assert not any(isinstance(ev, GoalDone) for ev in events)
    # goal 은 자동 done 처리 안 됨 → paused(사람 검토 대기).
    assert state.goal_get_active(sid)["status"] == "paused"


def test_done_with_item_evidence_stays_done(tmp_db, monkeypatch):
    _isolate(monkeypatch, digest="")
    _complete_item(monkeypatch, evidence="found exposed .env at https://corp.test/.env")
    sid, _gid = _seed_goal()
    events = _run_phase(RalphController(_EvalPhaseSession(sid)), sid)
    assert any(isinstance(ev, GoalDone) for ev in events)
    assert not any(isinstance(ev, GoalPaused) for ev in events)


def test_done_with_findings_stays_done(tmp_db, monkeypatch):
    _isolate(monkeypatch, digest="- [critical] web @ https://c.test/.env: 설정 노출")
    _complete_item(monkeypatch, evidence="")  # 항목 evidence 없어도 findings 로 접지
    sid, _gid = _seed_goal()
    events = _run_phase(RalphController(_EvalPhaseSession(sid)), sid)
    assert any(isinstance(ev, GoalDone) for ev in events)


def test_critic_disabled_stays_done(tmp_db, monkeypatch):
    _isolate(monkeypatch, digest="")
    monkeypatch.setenv("SA_GOAL_DONE_CRITIC", "0")  # 크리틱 끔
    _complete_item(monkeypatch, evidence="")
    sid, _gid = _seed_goal()
    events = _run_phase(RalphController(_EvalPhaseSession(sid)), sid)
    assert any(isinstance(ev, GoalDone) for ev in events)


def test_fire_once_resume_after_review_completes(tmp_db, monkeypatch):
    # G4: 인용증거 없는 done → 1회 pause(검토). resume(=검토완료) 후 재판정은 재-pause 없이 done.
    _isolate(monkeypatch, digest="")
    _complete_item(monkeypatch, evidence="")
    sid, gid = _seed_goal()
    rc = RalphController(_EvalPhaseSession(sid))

    events1 = _run_phase(rc, sid)
    assert any(isinstance(ev, GoalPaused) for ev in events1)      # 1회차: 검토 pause
    assert bool(state.goal_get_active(sid)["done_critic_flagged"])  # 플래그 영속

    state.goal_resume(sid)  # operator 검토 완료 → resume
    events2 = _run_phase(rc, sid)
    assert any(isinstance(ev, GoalDone) for ev in events2)         # 2회차: 재발동 없이 done
    assert not any(isinstance(ev, GoalPaused) for ev in events2)
