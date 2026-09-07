"""v3.35-A: chat_goal state helpers — Ralph loop persistence."""
from __future__ import annotations

from secu_agent import state


def test_goal_get_active_returns_none_initially(tmp_db):
    sid = state.chat_session_get_or_create()
    assert state.goal_get_active(sid) is None


def test_goal_set_creates_active_goal(tmp_db):
    sid = state.chat_session_get_or_create()
    gid = state.goal_set(sid, goal_text="203.0.113.0/16 점검 끝까지")
    assert gid > 0
    g = state.goal_get_active(sid)
    assert g is not None
    assert g["id"] == gid
    assert g["goal_text"] == "203.0.113.0/16 점검 끝까지"
    assert g["status"] == "active"
    assert g["checklist"] == []
    assert g["decomposed"] is False
    assert g["turns_used"] == 0
    assert g["max_turns"] == 20


def test_goal_set_clears_previous_active(tmp_db):
    sid = state.chat_session_get_or_create()
    state.goal_set(sid, goal_text="첫번째")
    gid2 = state.goal_set(sid, goal_text="두번째")
    g = state.goal_get_active(sid)
    assert g["id"] == gid2
    assert g["goal_text"] == "두번째"


def test_goal_clear_marks_cleared(tmp_db):
    sid = state.chat_session_get_or_create()
    state.goal_set(sid, goal_text="x")
    assert state.goal_clear(sid) is True
    assert state.goal_get_active(sid) is None
    # idempotent — 두번째 clear 는 False
    assert state.goal_clear(sid) is False


def test_goal_pause_resume(tmp_db):
    sid = state.chat_session_get_or_create()
    state.goal_set(sid, goal_text="x")
    assert state.goal_pause(sid, reason="budget") is True
    g = state.goal_get_active(sid)
    # paused 도 active 검색에 포함 (terminal 아니라서)
    assert g["status"] == "paused"
    assert g["paused_reason"] == "budget"
    assert state.goal_resume(sid) is True
    g2 = state.goal_get_active(sid)
    assert g2["status"] == "active"
    assert g2["paused_reason"] is None


def test_goal_mark_done(tmp_db):
    sid = state.chat_session_get_or_create()
    state.goal_set(sid, goal_text="x")
    assert state.goal_mark_done(sid, reason="all done") is True
    # done 은 terminal → active 조회 시 None
    assert state.goal_get_active(sid) is None


def test_goal_update_checklist(tmp_db):
    sid = state.chat_session_get_or_create()
    gid = state.goal_set(sid, goal_text="x")
    items = [
        {"text": "subnet A discover", "status": "pending"},
        {"text": "share B walk", "status": "pending"},
    ]
    state.goal_update_checklist(gid, checklist=items, decomposed=True)
    g = state.goal_get_active(sid)
    assert g["checklist"] == items
    assert g["decomposed"] is True


def test_goal_criteria_lifecycle(tmp_db):
    sid = state.chat_session_get_or_create()
    gid = state.goal_set(sid, goal_text="x")
    assert gid > 0

    ok, idx = state.goal_add_criteria(sid, "finding 있으면 deep dive")
    assert ok is True
    assert idx == 1
    state.goal_add_criteria(sid, "최종 레포트 작성")

    g = state.goal_get_active(sid)
    assert g["criteria"] == ["finding 있으면 deep dive", "최종 레포트 작성"]

    removed = state.goal_remove_criteria(sid, 1)
    assert removed == "finding 있으면 deep dive"
    assert state.goal_get_active(sid)["criteria"] == ["최종 레포트 작성"]

    assert state.goal_clear_criteria(sid) == 1
    assert state.goal_get_active(sid)["criteria"] == []


def test_goal_record_turn_increments_and_streak(tmp_db):
    sid = state.chat_session_get_or_create()
    gid = state.goal_set(sid, goal_text="x")
    state.goal_record_turn(gid, verdict="continue", reason="more work",
                           parse_fail=False)
    g = state.goal_get_active(sid)
    assert g["turns_used"] == 1
    assert g["last_verdict"] == "continue"
    assert g["last_reason"] == "more work"
    assert g["parse_fail_streak"] == 0

    # parse_fail 누적
    state.goal_record_turn(gid, verdict=None, reason=None, parse_fail=True)
    state.goal_record_turn(gid, verdict=None, reason=None, parse_fail=True)
    g = state.goal_get_active(sid)
    assert g["turns_used"] == 3
    assert g["parse_fail_streak"] == 2
    # 성공 한 번이면 streak 리셋
    state.goal_record_turn(gid, verdict="continue", reason="ok",
                           parse_fail=False)
    g = state.goal_get_active(sid)
    assert g["parse_fail_streak"] == 0


def test_goal_record_turn_gate_preserves_streaks(tmp_db):
    """v3.81 T1a: parse_fail=None(게이트 턴)은 두 streak 모두 보존 —
    리셋하면 judge_every>1 에서 탈출구가 영구 미발동(termination_gap)."""
    sid = state.chat_session_get_or_create()
    gid = state.goal_set(sid, goal_text="x")
    state.goal_record_turn(gid, verdict=None, reason=None, parse_fail=True)
    state.goal_record_turn(gid, verdict="continue", reason="judged",
                           parse_fail=False, progress=False)
    # 게이트 턴 2개 — turns_used 만 증가, streak 불변
    r1 = state.goal_record_turn(gid, verdict="continue", reason="gated",
                                parse_fail=None)
    r2 = state.goal_record_turn(gid, verdict="continue", reason="gated",
                                parse_fail=None)
    g = state.goal_get_active(sid)
    assert g["turns_used"] == 4
    assert g["parse_fail_streak"] == 0  # 마지막 judge 성공값 유지
    assert g["no_progress_streak"] == 1  # 마지막 judge 무진전값 유지
    assert r1 == r2 == {"parse_fail_streak": 0, "no_progress_streak": 1}
    # 다음 judge parse fail → 보존된 위에 누적
    out = state.goal_record_turn(gid, verdict=None, reason=None, parse_fail=True)
    assert out["parse_fail_streak"] == 1
    assert out["no_progress_streak"] == 1  # progress=None 보존


def test_goal_record_turn_no_progress_streak(tmp_db):
    """progress: False=+1 누적 / True=0 리셋 / None=보존."""
    sid = state.chat_session_get_or_create()
    gid = state.goal_set(sid, goal_text="x")
    out = state.goal_record_turn(gid, verdict="continue", reason="r",
                                 parse_fail=False, progress=False)
    assert out["no_progress_streak"] == 1
    out = state.goal_record_turn(gid, verdict="continue", reason="r",
                                 parse_fail=False, progress=False)
    assert out["no_progress_streak"] == 2
    assert state.goal_get_active(sid)["no_progress_streak"] == 2
    # 진전 한 번이면 리셋
    out = state.goal_record_turn(gid, verdict="continue", reason="r",
                                 parse_fail=False, progress=True)
    assert out["no_progress_streak"] == 0
    assert state.goal_get_active(sid)["no_progress_streak"] == 0
