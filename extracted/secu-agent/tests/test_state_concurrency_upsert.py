"""state.py read-modify-write 원자성 회귀 테스트 (v3.79-perf-cache).

autocommit postgres 에서 SELECT-후-INSERT/UPDATE 는 동일 키로 동시 진입 시
(a) 두 번째 INSERT 가 UNIQUE 위반으로 크래시하거나 (b) 두 UPDATE 가 서로를
덮어써 데이터를 유실한다. per-key advisory xact lock 직렬화가 이를 막는지
실제 스레드 동시성 + 실 postgres 로 검증한다.

pre-fix 였다면 finding 은 IntegrityError/관측유실, goal streak 은 과소집계로
간헐 실패한다. post-fix 는 결정론적으로 아래 불변을 만족한다.
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

from secu_agent import state


def _query_one(sql: str, args: tuple):
    with state.connect() as c:
        return c.execute(sql, args).fetchone()


def test_finding_upsert_concurrent_same_fingerprint_is_atomic():
    """동일 fingerprint 로 N 스레드 동시 upsert → 1 row, seen_count==N,
    모든 agent 관측 보존(lost update 없음), 예외 없음."""
    n = 8
    fp = "concurrent-fp-xyz"
    barrier = threading.Barrier(n)
    errors: list[BaseException] = []
    created_flags: list[bool] = []
    lock = threading.Lock()

    def worker(i: int) -> None:
        barrier.wait()  # 전원 동시 진입 → race 창 극대화
        try:
            _fid, created = state.finding_upsert(
                task_type="th", asset="asset-a", asset_kind="host",
                severity="high", summary=f"s{i}", fingerprint=fp,
                extra={"agent_provenance": {
                    "session_id": str(i), "agent_type": "h",
                    "llm_profile": "p", "llm_client": "c", "llm_model": "m",
                }},
            )
            with lock:
                created_flags.append(created)
        except BaseException as e:  # noqa: BLE001 - 레이스 크래시 포착
            with lock:
                errors.append(e)

    with ThreadPoolExecutor(max_workers=n) as ex:
        list(ex.map(worker, range(n)))

    assert errors == [], f"동시 upsert 가 크래시하면 안 된다: {errors!r}"
    # 정확히 1개 행, insert 1회 + update N-1회
    rows = _query_one(
        "SELECT count(*) AS n FROM finding_lifecycle WHERE fingerprint=?", (fp,),
    )
    assert int(rows["n"]) == 1
    assert created_flags.count(True) == 1
    assert created_flags.count(False) == n - 1

    row = _query_one(
        "SELECT seen_count, extra_json FROM finding_lifecycle WHERE fingerprint=?",
        (fp,),
    )
    assert int(row["seen_count"]) == n  # 모든 turn 반영 (lost increment 없음)
    obs = state._load_finding_extra(row["extra_json"]).get("agent_observations") or []
    seen_sids = {o.get("session_id") for o in obs}
    # 8명 관측이 전부 병합돼야 한다 — advisory lock 이 없으면 read-modify-write 유실.
    assert seen_sids == {str(i) for i in range(n)}


def test_goal_record_turn_concurrent_streaks_no_lost_update():
    """동일 goal 로 N 스레드 동시 기록 → streak/turns 가 정확히 N (과소집계 없음).

    parse_fail/no_progress streak 은 termination_gap 안전종료의 근거라 lost
    update 로 과소집계되면 자동 루프가 예정보다 오래 돈다.
    """
    n = 8
    sid = state.chat_session_new(agent_type="operator")
    goal_id = state.goal_set(sid, goal_text="g", max_turns=100)
    barrier = threading.Barrier(n)
    errors: list[BaseException] = []
    lock = threading.Lock()

    def worker(_i: int) -> None:
        barrier.wait()
        try:
            state.goal_record_turn(
                goal_id, verdict="continue", reason="r",
                parse_fail=True, progress=False,
            )
        except BaseException as e:  # noqa: BLE001
            with lock:
                errors.append(e)

    with ThreadPoolExecutor(max_workers=n) as ex:
        list(ex.map(worker, range(n)))

    assert errors == [], f"동시 기록이 크래시하면 안 된다: {errors!r}"
    row = _query_one(
        "SELECT parse_fail_streak, no_progress_streak, turns_used "
        "FROM chat_goal WHERE id=?", (goal_id,),
    )
    assert int(row["parse_fail_streak"]) == n
    assert int(row["no_progress_streak"]) == n
    assert int(row["turns_used"]) == n
