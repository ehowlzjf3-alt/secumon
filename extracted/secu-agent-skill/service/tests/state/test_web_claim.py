"""v3.59: web_target_claim_next — 동시 web-batch 세션이 같은 대상을 중복 점검하지
않도록 atomic claim (pending → in_progress, FOR UPDATE SKIP LOCKED on pg).

배경: 세션 15~18 이 전부 event_count 1등인 target_id=184 만 물고 있었던 race 재현 방지.
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


def _seed(day: str, *specs):
    """specs = (domain, event_count) → upsert. id 리스트 반환."""
    ids = []
    for domain, ec in specs:
        ids.append(
            sd.web_target_upsert(domain, source="splunk", day_bucket=day, event_count=ec)
        )
    return ids


# ─── 기본 claim ────────────────────────────────────────────


def test_claim_returns_highest_event_count_and_marks_in_progress():
    day = _today()
    _seed(day, ("low.cdep.samsungds.net", 5), ("hot.cdep.samsungds.net", 99))
    row = sd.web_target_claim_next(session_id=15, day_bucket=day)
    assert row is not None
    assert row["domain"] == "hot.cdep.samsungds.net"  # event_count desc
    assert row["status"] == "in_progress"
    assert row["claimed_by"] == 15
    assert row["claimed_at"] is not None
    # DB 에도 반영
    got = sd.web_target_get(row["id"])
    assert got["status"] == "in_progress"
    assert got["claimed_by"] == 15


def test_concurrent_claims_get_distinct_targets():
    """두 세션이 연달아 claim → 같은 대상 X (이게 핵심 회귀)."""
    day = _today()
    _seed(day, ("a.cdep.samsungds.net", 50), ("b.cdep.samsungds.net", 40))
    r1 = sd.web_target_claim_next(session_id=15, day_bucket=day)
    r2 = sd.web_target_claim_next(session_id=16, day_bucket=day)
    assert r1["id"] != r2["id"]
    assert {r1["domain"], r2["domain"]} == {"a.cdep.samsungds.net", "b.cdep.samsungds.net"}
    assert r1["claimed_by"] == 15
    assert r2["claimed_by"] == 16


def test_claim_returns_none_when_no_pending():
    day = _today()
    ids = _seed(day, ("only.cdep.samsungds.net", 7))
    sd.web_target_claim_next(session_id=15, day_bucket=day)
    # 유일 대상이 in_progress → 더 claim 할 pending 없음
    assert sd.web_target_claim_next(session_id=16, day_bucket=day) is None


def test_claim_empty_pool_returns_none():
    assert sd.web_target_claim_next(session_id=1, day_bucket=_today()) is None


# ─── stale reclaim (hang 회수) ─────────────────────────────


def test_stale_in_progress_is_reclaimed():
    day = _today()
    ids = _seed(day, ("hang.cdep.samsungds.net", 10))
    sd.web_target_claim_next(session_id=15, day_bucket=day)
    # claimed_at 을 과거로 — 세션 15 가 hang 한 상황 시뮬
    sd.web_target_set_status(ids[0], "in_progress", claimed_at=time.time() - 99999)
    reclaimed = sd.web_target_claim_next(
        session_id=16, day_bucket=day, stale_seconds=1800,
    )
    assert reclaimed is not None
    assert reclaimed["id"] == ids[0]
    assert reclaimed["claimed_by"] == 16  # 소유권 이전


def test_fresh_in_progress_not_reclaimed():
    day = _today()
    _seed(day, ("busy.cdep.samsungds.net", 10))
    sd.web_target_claim_next(session_id=15, day_bucket=day)  # 방금 claim (fresh)
    # 다른 세션은 못 가져감 (아직 hang 아님)
    assert sd.web_target_claim_next(
        session_id=16, day_bucket=day, stale_seconds=1800,
    ) is None


# ─── terminal status → claim 해제 ──────────────────────────


def test_set_status_terminal_clears_claim():
    day = _today()
    ids = _seed(day, ("done.cdep.samsungds.net", 10))
    sd.web_target_claim_next(session_id=15, day_bucket=day)
    sd.web_target_set_status(ids[0], "tasked", finding_count=2)
    got = sd.web_target_get(ids[0])
    assert got["status"] == "tasked"
    assert got["claimed_by"] is None
    assert got["claimed_at"] is None


def test_set_status_in_progress_keeps_claim():
    """in_progress 로의 갱신(예: claimed_at 보정)은 claim 안 지움."""
    day = _today()
    ids = _seed(day, ("x.cdep.samsungds.net", 10))
    sd.web_target_claim_next(session_id=15, day_bucket=day)
    sd.web_target_set_status(ids[0], "in_progress", claimed_at=12345.0)
    got = sd.web_target_get(ids[0])
    assert got["claimed_by"] == 15


# ─── day_bucket 격리 ───────────────────────────────────────


def test_claim_respects_day_bucket():
    _seed("2026-05-25", ("old.cdep.samsungds.net", 99))
    _seed("2026-05-27", ("new.cdep.samsungds.net", 1))
    row = sd.web_target_claim_next(session_id=15, day_bucket="2026-05-27")
    assert row["domain"] == "new.cdep.samsungds.net"


# ─── v3.76 rolling 통일: never-first → oldest, cooldown 재헌트 ──────────────


def _set_last_task(target_id, ts):
    with sd.connect() as c:
        c.execute("UPDATE web_target_domain SET last_task_at=? WHERE id=?", (ts, target_id))


def test_claim_never_first_then_oldest_event_count_secondary():
    """안 본 것(last_task_at NULL) 우선 → 그다음 event_count 높은 것 → 본 지 오래된 순."""
    day = _today()
    ids = _seed(day, ("never.x", 1), ("tasked_hot.x", 99), ("tasked_low.x", 50))
    # 둘은 tasked(=본 적 있음), never 는 안 봄
    sd.web_target_set_status(ids[1], "tasked")
    sd.web_target_set_status(ids[2], "tasked")
    _set_last_task(ids[1], time.time() - 200000)
    _set_last_task(ids[2], time.time() - 200000)
    # cooldown 풀린 tasked 도 재claim 대상이지만, never 가 먼저 나와야 함
    c1 = sd.web_target_claim_next(session_id=1, day_bucket=day, cooldown_seconds=0)
    assert c1["domain"] == "never.x"


def test_cooldown_re_task_of_terminal():
    """terminal(tasked) row 도 cooldown 지나면 재헌트, 안 지났으면 제외."""
    day = _today()
    ids = _seed(day, ("done.x", 10))
    sd.web_target_set_status(ids[0], "tasked")  # last_task_at = now
    # 기본 cooldown(86400) 내 → claim 없음
    assert sd.web_target_claim_next(session_id=1, day_bucket=day) is None
    # cooldown 0 → 재헌트
    again = sd.web_target_claim_next(session_id=1, day_bucket=day, cooldown_seconds=0)
    assert again is not None and again["domain"] == "done.x"
