"""F2-B: evidence-delta pre-gate — judge 스킵 회귀 테스트.

증거 digest 가 직전 judge 이후 변하지 않았고 비어있지 않으면(=findings 기반 goal) judge
LLM 호출을 스킵한다. 빈 digest(informational goal)는 굶기지 않고, 상한(skip_max)으로 지연을
묶으며, parse_fail 은 캐시하지 않아(재판정) streak 이 정상 진행한다.
"""
from __future__ import annotations

import asyncio

import pytest

from secu_agent import state
from secu_agent.agent import ralph_controller as rc_mod
from secu_agent.agent.goal_manager import ChecklistItem, EvaluateResult
from secu_agent.agent.ralph_controller import RalphController


class _EvalPhaseSession:
    def __init__(self, session_id: int):
        self.session_id = session_id
        self.client = object()


def _seed_goal(goal_text: str = "g") -> tuple[int, int]:
    sid = state.chat_session_new(agent_type="operator")
    gid = state.goal_set(sid, goal_text=goal_text, max_turns=0)
    state.goal_update_checklist(
        gid, checklist=[ChecklistItem(text="A").to_dict()], decomposed=True,
    )
    return sid, gid


def _run_phase(rc: RalphController, sid: int, text: str = "working"):
    async def _go():
        goal = state.goal_get_active(sid)
        assert goal is not None
        return [ev async for ev in rc._goal_evaluate_phase(goal, text)]
    return asyncio.run(_go())


@pytest.fixture(autouse=True)
def _clear_gate():
    rc_mod._LAST_JUDGE_HASH.clear()
    rc_mod._LAST_JUDGE_TURN.clear()
    yield
    rc_mod._LAST_JUDGE_HASH.clear()
    rc_mod._LAST_JUDGE_TURN.clear()


def _count_judge(monkeypatch, *, parse_fail: bool = False) -> dict:
    calls = {"n": 0}

    async def fake_eval(**kw):
        calls["n"] += 1
        return EvaluateResult(
            updates=[], new_items=[], reason="x", parse_failed=parse_fail,
        )

    monkeypatch.setattr(rc_mod, "goal_evaluate", fake_eval)
    return calls


def _isolate_gates(monkeypatch):
    # % N 게이트·no-progress pause 를 제거해 evidence-delta 게이트만 관찰.
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "1")
    monkeypatch.setenv("SA_GOAL_NO_PROGRESS_LIMIT", "0")


def test_unchanged_nonempty_evidence_skips_judge(tmp_db, monkeypatch):
    _isolate_gates(monkeypatch)
    monkeypatch.setenv("SA_GOAL_EVIDENCE_SKIP_MAX", "5")
    monkeypatch.setattr(rc_mod, "_build_evidence_digest", lambda **kw: "- [high] web @ x: y")
    sid, _gid = _seed_goal()
    rc = RalphController(_EvalPhaseSession(sid))
    calls = _count_judge(monkeypatch)
    for _ in range(4):
        _run_phase(rc, sid)
    assert calls["n"] == 1  # 첫 턴만 judge, 나머지 3턴 evidence unchanged → skip


def test_evidence_change_triggers_judge(tmp_db, monkeypatch):
    _isolate_gates(monkeypatch)
    monkeypatch.setenv("SA_GOAL_EVIDENCE_SKIP_MAX", "5")
    digests = ["A", "A", "B", "B"]
    seq = {"i": 0}

    def digest(**kw):
        v = digests[seq["i"]] if seq["i"] < len(digests) else "B"
        seq["i"] += 1
        return v

    monkeypatch.setattr(rc_mod, "_build_evidence_digest", digest)
    sid, _gid = _seed_goal()
    rc = RalphController(_EvalPhaseSession(sid))
    calls = _count_judge(monkeypatch)
    for _ in range(4):
        _run_phase(rc, sid)
    # judge A(turn0), skip A(turn1), judge B changed(turn2), skip B(turn3) → 2회
    assert calls["n"] == 2


def test_empty_digest_never_skips(tmp_db, monkeypatch):
    _isolate_gates(monkeypatch)
    monkeypatch.setenv("SA_GOAL_EVIDENCE_SKIP_MAX", "5")
    monkeypatch.setattr(rc_mod, "_build_evidence_digest", lambda **kw: "")
    sid, _gid = _seed_goal()
    rc = RalphController(_EvalPhaseSession(sid))
    calls = _count_judge(monkeypatch)
    for _ in range(4):
        _run_phase(rc, sid)
    assert calls["n"] == 4  # informational goal(빈 증거) 은 매 턴 judge — 안 굶김


def test_turn_cap_forces_periodic_judge(tmp_db, monkeypatch):
    _isolate_gates(monkeypatch)
    monkeypatch.setenv("SA_GOAL_EVIDENCE_SKIP_MAX", "2")  # turn-gap>=2 면 강제 judge
    monkeypatch.setattr(rc_mod, "_build_evidence_digest", lambda **kw: "CONST")
    sid, _gid = _seed_goal()  # max_turns=0(무제한) → boundary 강제 없음
    rc = RalphController(_EvalPhaseSession(sid))
    calls = _count_judge(monkeypatch)
    for _ in range(6):
        _run_phase(rc, sid)
    # judge(turn0)·skip(1,gap1)·judge(turn2,gap2)·skip(3,gap1)·judge(turn4,gap2)·skip(5)
    # → turn 0,2,4 judge = 3회 (turn-cap 이 judge_every 곱셈 없이 gap 을 2턴으로 상한)
    assert calls["n"] == 3


def test_max_turns_boundary_forces_final_judge(tmp_db, monkeypatch):
    _isolate_gates(monkeypatch)
    monkeypatch.setenv("SA_GOAL_EVIDENCE_SKIP_MAX", "10")  # cap 커도 boundary 는 우선
    monkeypatch.setattr(rc_mod, "_build_evidence_digest", lambda **kw: "CONST")

    def _seed_bounded(max_turns):
        sid = state.chat_session_new(agent_type="operator")
        gid = state.goal_set(sid, goal_text="g", max_turns=max_turns)
        state.goal_update_checklist(
            gid, checklist=[ChecklistItem(text="A").to_dict()], decomposed=True,
        )
        return sid

    # max_turns=2: turn0 judge, turn1 은 (1+1)>=2 = boundary → 강제 judge(스킵 안 함).
    rc_mod._LAST_JUDGE_HASH.clear(); rc_mod._LAST_JUDGE_TURN.clear()
    sid_b = _seed_bounded(2)
    rc = RalphController(_EvalPhaseSession(sid_b))
    calls_b = _count_judge(monkeypatch)
    for _ in range(2):
        _run_phase(rc, sid_b)
    assert calls_b["n"] == 2  # 경계 턴이 강제 judge 라 완료 놓치지 않음

    # 대조: max_turns=0(무제한) 동일 2턴 → turn1 은 gap1<10 → skip → 1회.
    rc_mod._LAST_JUDGE_HASH.clear(); rc_mod._LAST_JUDGE_TURN.clear()
    sid_u, _ = _seed_goal()
    rc2 = RalphController(_EvalPhaseSession(sid_u))
    calls_u = _count_judge(monkeypatch)
    for _ in range(2):
        _run_phase(rc2, sid_u)
    assert calls_u["n"] == 1


def _seed_bounded_goal(max_turns: int) -> int:
    sid = state.chat_session_new(agent_type="operator")
    gid = state.goal_set(sid, goal_text="g", max_turns=max_turns)
    state.goal_update_checklist(
        gid, checklist=[ChecklistItem(text="A").to_dict()], decomposed=True,
    )
    return sid


def test_boundary_bypasses_judge_every_gate(tmp_db, monkeypatch):
    # R1: max_turns 경계 턴은 % N 스로틀도 우회해 반드시 judge(완료 놓침 방지).
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "3")      # % N 스로틀 켜짐
    monkeypatch.setenv("SA_GOAL_NO_PROGRESS_LIMIT", "0")
    monkeypatch.setenv("SA_GOAL_EVIDENCE_SKIP_MAX", "10")
    monkeypatch.setattr(rc_mod, "_build_evidence_digest", lambda **kw: "CONST")
    sid = _seed_bounded_goal(2)  # 경계=turn1((1+1)>=2)
    rc = RalphController(_EvalPhaseSession(sid))
    calls = _count_judge(monkeypatch)
    for _ in range(2):
        _run_phase(rc, sid)
    # turn0: 0%3==0 eligible → judge. turn1: %N 이면 gate(1%3!=0)지만 boundary 라 강제 judge.
    assert calls["n"] == 2


def test_turn_cap_bypasses_judge_every_gate(tmp_db, monkeypatch):
    # R2: cap 이 판정 간격을 turn 기준으로 상한 — judge_every 와 곱해지지 않는다.
    monkeypatch.setenv("SA_GOAL_JUDGE_EVERY", "3")
    monkeypatch.setenv("SA_GOAL_NO_PROGRESS_LIMIT", "0")
    monkeypatch.setenv("SA_GOAL_EVIDENCE_SKIP_MAX", "2")  # gap>=2 강제
    monkeypatch.setattr(rc_mod, "_build_evidence_digest", lambda **kw: "CONST")
    sid, _gid = _seed_goal()  # max_turns=0
    rc = RalphController(_EvalPhaseSession(sid))
    calls = _count_judge(monkeypatch)
    for _ in range(6):
        _run_phase(rc, sid)
    # judge_every=3 이면 % N 만으로는 0,3 판정(gap 3). cap=2 강제로 turn2·turn4 도 판정 →
    # 실 judge 는 turn 0,2,4 = 3회 (gap 이 judge_every 아닌 cap=2 턴으로 상한됨).
    assert calls["n"] == 3


def test_parse_fail_clears_stale_cache(tmp_db, monkeypatch):
    # R3: 판정 실패는 이전 clean 캐시를 무효화 → 다음 턴 재판정(stale 스킵 방지).
    _isolate_gates(monkeypatch)
    monkeypatch.setenv("SA_GOAL_EVIDENCE_SKIP_MAX", "10")
    digest = {"v": "CONST"}
    monkeypatch.setattr(rc_mod, "_build_evidence_digest", lambda **kw: digest["v"])
    sid, gid = _seed_goal()
    rc = RalphController(_EvalPhaseSession(sid))

    seq = {"i": 0}

    async def eval_fn(**kw):
        seq["i"] += 1
        return EvaluateResult(
            updates=[], new_items=[], reason="x", parse_failed=(seq["i"] >= 2),
        )

    monkeypatch.setattr(rc_mod, "goal_evaluate", eval_fn)
    _run_phase(rc, sid)                       # turn0 clean judge → 캐시 채움
    assert gid in rc_mod._LAST_JUDGE_HASH
    digest["v"] = "CHANGED"                    # 증거 변경 → 다음 턴 강제 judge
    _run_phase(rc, sid)                        # turn1 judge → parse_fail → 해시만 무효화
    assert gid not in rc_mod._LAST_JUDGE_HASH  # R3: stale 해시 스킵 방지
    assert gid in rc_mod._LAST_JUDGE_TURN      # Z2: cap 마감선(last_turn)은 보존


def test_skip_max_zero_disables_pregate(tmp_db, monkeypatch):
    _isolate_gates(monkeypatch)
    monkeypatch.setenv("SA_GOAL_EVIDENCE_SKIP_MAX", "0")
    monkeypatch.setattr(rc_mod, "_build_evidence_digest", lambda **kw: "CONST")
    sid, _gid = _seed_goal()
    rc = RalphController(_EvalPhaseSession(sid))
    calls = _count_judge(monkeypatch)
    for _ in range(3):
        _run_phase(rc, sid)
    assert calls["n"] == 3  # 0 = 비활성 → 매 턴 judge


def test_parse_fail_not_cached_so_retries(tmp_db, monkeypatch):
    _isolate_gates(monkeypatch)
    monkeypatch.setenv("SA_GOAL_EVIDENCE_SKIP_MAX", "5")
    monkeypatch.setattr(rc_mod, "_build_evidence_digest", lambda **kw: "CONST")
    sid, _gid = _seed_goal()
    rc = RalphController(_EvalPhaseSession(sid))
    calls = _count_judge(monkeypatch, parse_fail=True)
    for _ in range(3):
        _run_phase(rc, sid)
    # parse_fail 은 해시 미갱신 → 다음 턴 재판정(스킵 안 함) → 매 턴 judge
    assert calls["n"] == 3


def test_skip_turn_preserves_streak_parse_fail_none(tmp_db, monkeypatch):
    _isolate_gates(monkeypatch)
    monkeypatch.setenv("SA_GOAL_EVIDENCE_SKIP_MAX", "5")
    monkeypatch.setattr(rc_mod, "_build_evidence_digest", lambda **kw: "CONST")
    sid, _gid = _seed_goal()
    rc = RalphController(_EvalPhaseSession(sid))
    _count_judge(monkeypatch)
    records = []
    real = state.goal_record_turn

    def spy(goal_id, *, verdict, reason, parse_fail, progress=None):
        records.append((verdict, parse_fail, reason))
        return real(goal_id, verdict=verdict, reason=reason,
                    parse_fail=parse_fail, progress=progress)

    monkeypatch.setattr(state, "goal_record_turn", spy)
    for _ in range(3):
        _run_phase(rc, sid)
    # turn0 = judge(parse_fail=False), turn1·2 = skip(parse_fail=None, verdict continue)
    assert records[0][1] is False
    assert records[1][1] is None and records[1][0] == "continue"
    assert records[2][1] is None
    assert "evidence unchanged" in records[1][2]
