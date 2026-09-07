"""v3.80 Slice0b: *_reclaim_stale_claims — 진행 불능 claim 의 phase-진입 즉시 해제.

배경: 시간 기반 stale(30분)은 각 claim_next 의 pick_where 가 이미 회수하지만,
**paused goal / archived session** 이 물고 있는 claim 은 30분을 그대로 기다려야
했다 (smb 만 명시적 reclaim 보유 — 4/6 phase 무방비). 보장:
① 시간 stale 회수, ② paused goal claim 즉시 회수, ③ archived session claim
즉시 회수, ④ fresh+active claim 불변, ⑤ terminal row 불변.
"""
from __future__ import annotations

import datetime as dt
import time

import pytest

import service.state_domain as sd
from secu_agent import state


@pytest.fixture(autouse=True)
def _isolated_db(tmp_db):
    yield


def _today() -> str:
    return dt.date.today().isoformat()


def _session(*, archived: bool = False, paused_goal: bool = False) -> int:
    sid = state.chat_session_new(source="test", agent_type="smb")
    if paused_goal:
        state.goal_set(sid, goal_text="web-batch 점검", max_turns=10)
        assert state.goal_pause(sid, reason="test pause")
    if archived:
        state.chat_session_update(sid, status="archived")
    return sid


def _backdate_claim(table: str, target_id: int, *, seconds: float) -> None:
    with sd.connect() as c:
        c.execute(
            f"UPDATE {table} SET claimed_at=? WHERE id=?",
            (time.time() - seconds, target_id),
        )


# 도메인별 (reclaim_fn, claim_fn, get_status_fn) 파라미터화 ───────────────

def _web_seed() -> int:
    return sd.web_target_upsert(
        "x.cdep.samsungds.net", source="splunk",
        day_bucket=_today(), event_count=10,
    )


def _web_claim(sid: int) -> int:
    row = sd.web_target_claim_next(session_id=sid, day_bucket=_today())
    assert row is not None
    return int(row["id"])


def _web_status(tid: int) -> dict:
    row = sd.web_target_get(tid)
    assert row is not None
    return row


def _devops_seed() -> int:
    return sd.devops_target_upsert(
        "https://github.example.samsungds.net/org/repo",
        service="github", source="proxy", day_bucket=_today(), access_count=5,
    )


def _devops_claim(sid: int) -> int:
    row = sd.devops_target_claim_next(session_id=sid)
    assert row is not None
    return int(row["id"])


def _row_by_id(table: str, tid: int) -> dict:
    with sd.connect() as c:
        r = c.execute(f"SELECT * FROM {table} WHERE id=?", (tid,)).fetchone()
    assert r is not None
    return {k: r[k] for k in r.keys()}


def _github_seed() -> int:
    return sd.github_repo_target_upsert("org/repo-a")


def _github_claim(sid: int) -> int:
    rows = sd.github_repo_target_claim_next(session_id=sid, limit=1)
    assert rows
    return int(rows[0]["id"])


def _confluence_seed() -> int:
    return sd.confluence_space_target_upsert("SPACEA")


def _confluence_claim(sid: int) -> int:
    rows = sd.confluence_space_target_claim_next(session_id=sid, limit=1)
    assert rows
    return int(rows[0]["id"])


DOMAINS = [
    pytest.param(
        "web_target_domain", _web_seed, _web_claim,
        sd.web_reclaim_stale_claims, id="web",
    ),
    pytest.param(
        "devops_target", _devops_seed, _devops_claim,
        sd.devops_reclaim_stale_claims, id="devops",
    ),
    pytest.param(
        "github_repo_target", _github_seed, _github_claim,
        sd.github_repo_reclaim_stale_claims, id="github",
    ),
    pytest.param(
        "confluence_space_target", _confluence_seed, _confluence_claim,
        sd.confluence_space_reclaim_stale_claims, id="confluence",
    ),
]


@pytest.mark.parametrize("table,seed,claim,reclaim", DOMAINS)
def test_time_stale_claim_reclaimed(table, seed, claim, reclaim):
    tid = seed()
    sid = _session()
    assert claim(sid) == tid
    _backdate_claim(table, tid, seconds=3600)  # 30분 stale 초과
    assert reclaim() == 1
    row = _row_by_id(table, tid)
    assert row["status"] == "pending"
    assert row["claimed_by"] is None and row["claimed_at"] is None


@pytest.mark.parametrize("table,seed,claim,reclaim", DOMAINS)
def test_paused_goal_claim_reclaimed_immediately(table, seed, claim, reclaim):
    """핵심 신규 동작 — paused 면 30분 안 기다리고 즉시 회수."""
    tid = seed()
    sid = _session(paused_goal=True)
    assert claim(sid) == tid  # claimed_at = 방금 (fresh)
    assert reclaim() == 1
    row = _row_by_id(table, tid)
    assert row["status"] == "pending"
    assert row["claimed_by"] is None


@pytest.mark.parametrize("table,seed,claim,reclaim", DOMAINS)
def test_archived_session_claim_reclaimed_immediately(table, seed, claim, reclaim):
    tid = seed()
    sid = _session()
    assert claim(sid) == tid
    state.chat_session_update(sid, status="archived")
    assert reclaim() == 1
    assert _row_by_id(table, tid)["status"] == "pending"


@pytest.mark.parametrize("table,seed,claim,reclaim", DOMAINS)
def test_fresh_active_claim_untouched(table, seed, claim, reclaim):
    """active goal + fresh claim 은 회수 대상 아님 — 진행 중 세션 보호."""
    tid = seed()
    sid = _session()
    state.goal_set(sid, goal_text="배치 점검", max_turns=10)  # active goal
    assert claim(sid) == tid
    assert reclaim() == 0
    row = _row_by_id(table, tid)
    assert row["status"] == "in_progress"
    assert row["claimed_by"] == sid


@pytest.mark.parametrize("table,seed,claim,reclaim", DOMAINS)
def test_terminal_rows_untouched(table, seed, claim, reclaim):
    tid = seed()
    sid = _session(paused_goal=True)
    assert claim(sid) == tid
    # terminal 전이 (claim 해제 동반) 후 reclaim — 건드리면 안 됨.
    with sd.connect() as c:
        c.execute(
            f"UPDATE {table} SET status='tasked', claimed_by=NULL, claimed_at=NULL "
            "WHERE id=?",
            (tid,),
        )
    assert reclaim() == 0
    assert _row_by_id(table, tid)["status"] == "tasked"


def test_paused_then_new_goal_releases_pause_scope():
    """goal_set 이 paused 를 cleared 로 만들면 그 세션 claim 은 더 이상 회수 대상 아님.

    (_reclaim_stale_claims docstring 의 '과잉 회수 없음' 전제를 코드로 고정.)
    """
    tid = _web_seed()
    sid = _session(paused_goal=True)
    assert _web_claim(sid) == tid
    # 새 goal set → 이전 paused goal 은 cleared, 세션은 다시 active 작업 중.
    state.goal_set(sid, goal_text="새 배치", max_turns=10)
    assert sd.web_reclaim_stale_claims() == 0
    assert _row_by_id("web_target_domain", tid)["status"] == "in_progress"
