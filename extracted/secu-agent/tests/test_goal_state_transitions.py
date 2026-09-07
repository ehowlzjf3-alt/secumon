"""v3.80 1주차-#2: goal 상태전이 검증 — 매트릭스 스펙, SQL guard 일치, 로드 검증, race 로깅.

01 리포트 #2 경량판의 행동 계약:
- GOAL_STATUS_TRANSITIONS 매트릭스가 명시 스펙이고, 각 전이 함수의 SQL WHERE
  guard 와 일치해야 한다 (전이 함수 4종의 4×4 전수 + goal_set CTE 스윕 +
  zombie 복구 escape hatch — status 를 바꾸는 SQL 5개 전부).
- goal_get_active 는 미지 status 를 error 로그로 가시화하되 반환은 유지한다
  (행동 무변경 — 호출부 `!= "active"` guard 가 안전하게 처리).
- ralph_controller 의 pause/mark_done 래퍼는 rowcount=0 을 warning 으로
  가시화하되 이벤트/시스템노트 동작은 기존 그대로 둔다 (race 자체는 WHERE
  guard 가 원자적으로 처리 — 침묵만 제거).
"""
from __future__ import annotations

import asyncio
import logging

import pytest

from secu_agent import state
from secu_agent.agent import ralph_controller
from secu_agent.agent.chat_session import ChatSession
from secu_agent.agent.events import GoalDone
from secu_agent.agent.ralph_controller import RalphController

_KNOWN = ("active", "paused", "done", "cleared")


def _force_status(gid: int, status: str) -> None:
    """테스트 전용 — 전이 함수를 우회해 임의 status 를 직접 주입."""
    with state.connect() as c:
        c.execute("UPDATE chat_goal SET status=? WHERE id=?", (status, gid))


def _status_of(gid: int) -> str:
    with state.connect() as c:
        r = c.execute("SELECT status FROM chat_goal WHERE id=?", (gid,)).fetchone()
    return r["status"]


# ---------------------------------------------------------------- 매트릭스 스펙


def test_matrix_covers_known_statuses_and_terminals():
    assert set(state.GOAL_STATUS_TRANSITIONS) == set(_KNOWN)
    # terminal 상수와 매트릭스의 terminal(나가는 전이 없음)이 일치
    for t in state._GOAL_TERMINAL_STATUSES:
        assert state.GOAL_STATUS_TRANSITIONS[t] == frozenset()
    non_terminal = set(_KNOWN) - set(state._GOAL_TERMINAL_STATUSES)
    for s in non_terminal:
        assert state.GOAL_STATUS_TRANSITIONS[s]


def test_matrix_destinations_are_known_statuses():
    for dests in state.GOAL_STATUS_TRANSITIONS.values():
        assert dests <= set(state.GOAL_STATUS_TRANSITIONS)


def test_validate_accepts_all_matrix_transitions():
    for old, dests in state.GOAL_STATUS_TRANSITIONS.items():
        for new in dests:
            state.validate_goal_status_transition(old, new)  # no raise


@pytest.mark.parametrize("old,new", [
    ("done", "active"),       # terminal 부활 금지
    ("cleared", "active"),
    ("done", "paused"),
    ("active", "active"),     # self-transition 은 매트릭스에 없음
    ("paused", "paused"),
])
def test_validate_rejects_disallowed(old, new):
    with pytest.raises(ValueError, match="transition"):
        state.validate_goal_status_transition(old, new)


@pytest.mark.parametrize("old,new", [
    ("zombie", "paused"),
    ("active", "zombie"),
    ("", "active"),
])
def test_validate_rejects_unknown_statuses(old, new):
    with pytest.raises(ValueError, match="unknown goal status"):
        state.validate_goal_status_transition(old, new)


# ------------------------------------------------- SQL WHERE guard ↔ 매트릭스


_OPS_BY_TARGET = {
    "paused": lambda sid: state.goal_pause(sid, reason="전이 테스트"),
    "active": lambda sid: state.goal_resume(sid),
    "done": lambda sid: state.goal_mark_done(sid, reason="전이 테스트"),
    "cleared": lambda sid: state.goal_clear(sid),
}


@pytest.mark.parametrize("start", _KNOWN)
@pytest.mark.parametrize("target", _KNOWN)
def test_sql_guard_matches_matrix(tmp_db, start, target):
    """4×4 전수: 전이 함수의 rowcount 결과 == 매트릭스 허용 여부."""
    sess = state.chat_session_new(agent_type="smb")
    gid = state.goal_set(sess, goal_text="전이 테스트", max_turns=0)
    _force_status(gid, start)

    ok = _OPS_BY_TARGET[target](sess)
    expected = target in state.GOAL_STATUS_TRANSITIONS[start]
    assert ok is expected
    # DB 도 일치: 성공이면 target, 실패면 start 그대로
    assert _status_of(gid) == (target if expected else start)


# --------------------------------------- goal_set CTE 스윕 + escape hatch
# status 를 바꾸는 SQL 은 전이 함수 4종 + goal_set 의 CTE 스윕까지 5개다.
# 스윕(비terminal → cleared)과 zombie 복구는 CONTRACTS.md 가 명시한 계약 —
# 리뷰에서 4×4 만으론 이 둘의 회귀를 못 잡는다고 확인돼 별도 고정.


@pytest.mark.parametrize("prior", ["active", "paused"])
def test_goal_set_sweeps_prior_non_terminal_to_cleared(tmp_db, prior):
    """goal_set 스윕도 매트릭스 적합 전이(active/paused → cleared)여야 한다."""
    sess = state.chat_session_new(agent_type="smb")
    gid_old = state.goal_set(sess, goal_text="이전 goal", max_turns=0)
    _force_status(gid_old, prior)
    gid_new = state.goal_set(sess, goal_text="새 goal", max_turns=0)
    assert gid_new != gid_old
    assert _status_of(gid_old) == "cleared"
    g = state.goal_get_active(sess)
    assert g["id"] == gid_new
    assert g["status"] == "active"


@pytest.mark.parametrize("prior", ["done", "cleared"])
def test_goal_set_leaves_terminal_rows_untouched(tmp_db, prior):
    sess = state.chat_session_new(agent_type="smb")
    gid_old = state.goal_set(sess, goal_text="이전 goal", max_turns=0)
    _force_status(gid_old, prior)
    state.goal_set(sess, goal_text="새 goal", max_turns=0)
    assert _status_of(gid_old) == prior


def test_zombie_status_recovered_by_goal_clear(tmp_db):
    """CONTRACTS.md escape hatch: goal_clear 는 미지(손상) status 도 회수한다.

    goal_clear 를 매트릭스-적합하게 status IN ('active','paused') 로 "고치면"
    이 문서화된 복구 경로가 죽는다 — 그 회귀를 여기서 잡는다.
    """
    sess = state.chat_session_new(agent_type="smb")
    gid = state.goal_set(sess, goal_text="zombie goal", max_turns=0)
    _force_status(gid, "zombiestate")
    assert state.goal_clear(sess) is True
    assert _status_of(gid) == "cleared"
    assert state.goal_get_active(sess) is None


def test_zombie_status_swept_by_goal_set(tmp_db):
    """escape hatch 2: goal_set 의 NOT IN(terminal) 스윕도 zombie 를 회수."""
    sess = state.chat_session_new(agent_type="smb")
    gid = state.goal_set(sess, goal_text="zombie goal", max_turns=0)
    _force_status(gid, "zombiestate")
    gid_new = state.goal_set(sess, goal_text="새 goal", max_turns=0)
    assert _status_of(gid) == "cleared"
    assert state.goal_get_active(sess)["id"] == gid_new


# ------------------------------------------------- goal_get_active 로드 검증


def test_goal_get_active_logs_unknown_status_but_returns_row(tmp_db, caplog):
    sess = state.chat_session_new(agent_type="smb")
    gid = state.goal_set(sess, goal_text="zombie 상태 goal", max_turns=0)
    _force_status(gid, "zombiestate")
    with caplog.at_level(logging.ERROR, logger="secu_agent.state"):
        g = state.goal_get_active(sess)
    # 행동 무변경: row 는 그대로 반환 (호출부 guard 가 처리)
    assert g is not None
    assert g["status"] == "zombiestate"
    assert any("미지 status" in r.message for r in caplog.records)


def test_goal_get_active_known_status_no_error_log(tmp_db, caplog):
    sess = state.chat_session_new(agent_type="smb")
    state.goal_set(sess, goal_text="정상 goal", max_turns=0)
    with caplog.at_level(logging.ERROR, logger="secu_agent.state"):
        g = state.goal_get_active(sess)
    assert g is not None and g["status"] == "active"
    assert not [r for r in caplog.records if r.name == "secu_agent.state"]


# ----------------------------------------- ralph_controller 래퍼 race 가시화


def test_pause_checked_warns_on_rowcount_zero(monkeypatch, caplog):
    monkeypatch.setattr(state, "goal_pause", lambda sid, *, reason=None: False)
    with caplog.at_level(
        logging.WARNING, logger="secu_agent.agent.ralph_controller",
    ):
        ok = ralph_controller._goal_pause_checked(7, reason="max_turns 소진")
    assert ok is False
    assert any("goal_pause 무효과" in r.message for r in caplog.records)


def test_pause_checked_silent_on_success(monkeypatch, caplog):
    monkeypatch.setattr(state, "goal_pause", lambda sid, *, reason=None: True)
    with caplog.at_level(
        logging.WARNING, logger="secu_agent.agent.ralph_controller",
    ):
        ok = ralph_controller._goal_pause_checked(7, reason="max_turns 소진")
    assert ok is True
    assert not caplog.records


def test_mark_done_checked_warns_on_rowcount_zero(monkeypatch, caplog):
    monkeypatch.setattr(
        state, "goal_mark_done", lambda sid, *, reason=None: False,
    )
    with caplog.at_level(
        logging.WARNING, logger="secu_agent.agent.ralph_controller",
    ):
        ok = ralph_controller._goal_mark_done_checked(7, reason="batch 완료")
    assert ok is False
    assert any("goal_mark_done 무효과" in r.message for r in caplog.records)


def test_mark_done_checked_silent_on_success(monkeypatch, caplog):
    monkeypatch.setattr(
        state, "goal_mark_done", lambda sid, *, reason=None: True,
    )
    with caplog.at_level(
        logging.WARNING, logger="secu_agent.agent.ralph_controller",
    ):
        ok = ralph_controller._goal_mark_done_checked(7, reason="batch 완료")
    assert ok is True
    assert not caplog.records


# de-domain: batch driver 경유 race 테스트는 plugin 소유로 이동 — 핵심 계약은
# test_mark_done_checked_warns_on_rowcount_zero 가 커버 (원형: secu-agent-skill/tests)
