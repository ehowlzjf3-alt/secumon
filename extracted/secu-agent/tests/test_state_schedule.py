"""schedule / schedule_fire 영속 layer.

설계:
- schedule: cron 표현식 + prompt + agent_type + repeat/deliver/origin + next_run 캐시.
  operator agent 가 도구로 만든다 (자율생성). croniter 계산은 caller (Step B) 책임 —
  state.py 는 next_run REAL 컬럼만 갖고 due 판단.
- schedule_fire: 매번 trigger 될 때마다 audit row — running/ok/error + result_summary +
  child_session_id (그 fire 가 spawn 한 ChatSession).
- repeat: NULL = 무한, 정수 = 그만큼 fire 후 자동 paused.

운영 보안:
- prompt 평문 저장 (사람이 검토 가능). 비번/평문 자격증명 같은 secret 들어가지 않게
  Step B 의 _scan_cron_prompt 가 거른다. state 는 그냥 받는다.
- origin: 'operator_agent' | 'user' | 'system' — 누가 만들었는지 audit.
"""
from __future__ import annotations

import time


def test_schedule_create_returns_id_and_persists_fields(tmp_db):
    from secu_agent import state
    sid = state.schedule_create(
        agent_type="agent",
        prompt="walked share 전부 review 해줘",
        cron_expr="0 * * * *",
        next_run=time.time() + 3600,
        origin="operator_agent",
        deliver="chat",
        repeat=None,
        charter_ref="charter-2026Q2",
        created_by="operator",
    )
    assert isinstance(sid, int)

    row = state.schedule_get(sid)
    assert row is not None
    assert row["agent_type"] == "agent"
    assert row["prompt"] == "walked share 전부 review 해줘"
    assert row["cron_expr"] == "0 * * * *"
    assert row["status"] == "active"
    assert row["origin"] == "operator_agent"
    assert row["deliver"] == "chat"
    assert row["repeat"] is None
    assert row["fire_count"] == 0
    assert row["charter_ref"] == "charter-2026Q2"
    assert row["created_by"] == "operator"
    assert row["next_run"] > 0
    assert row["schedule_kind"] == "legacy"
    assert row["stale_policy"] == "run"
    assert row["source_session_id"] is None
    assert row["source_message_id"] is None
    assert row["expires_at"] is None


def test_schedule_create_persists_intent_contract_fields(tmp_db):
    from secu_agent import state

    sid = state.schedule_create(
        agent_type="agent",
        prompt="poll previous scan",
        cron_expr="@once",
        next_run=100.0,
        origin="operator_agent",
        repeat=1,
        schedule_kind="self_wakeup",
        stale_policy="skip_if_superseded",
        source_session_id=7,
        source_message_id=11,
        expires_at=200.0,
    )

    row = state.schedule_get(sid)
    assert row["schedule_kind"] == "self_wakeup"
    assert row["stale_policy"] == "skip_if_superseded"
    assert row["source_session_id"] == 7
    assert row["source_message_id"] == 11
    assert row["expires_at"] == 200.0


def test_schedule_list_filters_by_agent_type_and_status(tmp_db):
    from secu_agent import state
    from secu_agent.agent_type_registry import register_agent_type, unregister_agent_type

    register_agent_type("testdom")
    try:
        a = state.schedule_create(
            agent_type="agent", prompt="A", cron_expr="* * * * *",
            next_run=1.0, origin="user",
        )
        b = state.schedule_create(
            agent_type="agent", prompt="B", cron_expr="* * * * *",
            next_run=2.0, origin="user",
        )
        c = state.schedule_create(
            agent_type="testdom", prompt="C", cron_expr="* * * * *",
            next_run=3.0, origin="user",
        )
    finally:
        unregister_agent_type("testdom")
    state.schedule_pause(b)

    agent_all = state.schedule_list(agent_type="agent")
    assert {r["id"] for r in agent_all} == {a, b}

    agent_active = state.schedule_list(agent_type="agent", status="active")
    assert [r["id"] for r in agent_active] == [a]

    all_rows = state.schedule_list()
    assert {r["id"] for r in all_rows} == {a, b, c}


def test_schedule_pause_and_resume(tmp_db):
    from secu_agent import state
    sid = state.schedule_create(
        agent_type="agent", prompt="x", cron_expr="* * * * *",
        next_run=1.0, origin="user",
    )
    assert state.schedule_get(sid)["status"] == "active"

    state.schedule_pause(sid)
    assert state.schedule_get(sid)["status"] == "paused"

    state.schedule_resume(sid)
    assert state.schedule_get(sid)["status"] == "active"


def test_schedule_delete_removes_row(tmp_db):
    from secu_agent import state
    sid = state.schedule_create(
        agent_type="agent", prompt="x", cron_expr="* * * * *",
        next_run=1.0, origin="user",
    )
    state.schedule_delete(sid)
    assert state.schedule_get(sid) is None


def test_schedule_update_changes_fields(tmp_db):
    from secu_agent import state
    sid = state.schedule_create(
        agent_type="agent", prompt="old", cron_expr="* * * * *",
        next_run=1.0, origin="user",
    )
    state.schedule_update(sid, prompt="new", cron_expr="0 */6 * * *",
                          next_run=99.0, deliver="silent")
    row = state.schedule_get(sid)
    assert row["prompt"] == "new"
    assert row["cron_expr"] == "0 */6 * * *"
    assert row["next_run"] == 99.0
    assert row["deliver"] == "silent"


def test_schedule_due_returns_active_past_next_run(tmp_db):
    from secu_agent import state
    now = 1000.0
    past = state.schedule_create(
        agent_type="agent", prompt="due", cron_expr="* * * * *",
        next_run=now - 1, origin="user",
    )
    future = state.schedule_create(
        agent_type="agent", prompt="not yet", cron_expr="* * * * *",
        next_run=now + 1000, origin="user",
    )
    paused_due = state.schedule_create(
        agent_type="agent", prompt="paused", cron_expr="* * * * *",
        next_run=now - 10, origin="user",
    )
    state.schedule_pause(paused_due)

    due = state.schedule_due(now=now)
    ids = {r["id"] for r in due}
    assert past in ids
    assert future not in ids
    assert paused_due not in ids


def test_schedule_due_respects_repeat_cap(tmp_db):
    """repeat=2 이면 fire_count 2 도달 후 더 이상 due 안 됨."""
    from secu_agent import state
    sid = state.schedule_create(
        agent_type="agent", prompt="capped", cron_expr="* * * * *",
        next_run=100.0, origin="user", repeat=2,
    )
    # 처음엔 due
    assert sid in {r["id"] for r in state.schedule_due(now=200.0)}

    # 1번 fire
    fid1 = state.schedule_fire_start(sid)
    state.schedule_fire_finish(fid1, status="ok", result_summary="r1")
    state.schedule_update(sid, next_run=150.0)
    assert state.schedule_get(sid)["fire_count"] == 1
    assert sid in {r["id"] for r in state.schedule_due(now=200.0)}

    # 2번 fire — cap 도달
    fid2 = state.schedule_fire_start(sid)
    state.schedule_fire_finish(fid2, status="ok", result_summary="r2")
    state.schedule_update(sid, next_run=160.0)
    row = state.schedule_get(sid)
    assert row["fire_count"] == 2
    # 자동 paused — repeat cap 도달
    assert row["status"] == "paused"
    assert sid not in {r["id"] for r in state.schedule_due(now=200.0)}


def test_schedule_fire_log_records_audit_row(tmp_db):
    from secu_agent import state
    sid = state.schedule_create(
        agent_type="agent", prompt="x", cron_expr="* * * * *",
        next_run=1.0, origin="user",
    )

    fid = state.schedule_fire_start(sid)
    assert isinstance(fid, int)

    fires = state.schedule_fires_for(sid)
    assert len(fires) == 1
    assert fires[0]["status"] == "running"
    assert fires[0]["schedule_id"] == sid
    assert fires[0]["fired_at"] > 0
    assert fires[0]["finished_at"] is None

    state.schedule_fire_finish(
        fid, status="ok",
        result_summary="2 shares reviewed",
        child_session_id=42,
    )
    fires = state.schedule_fires_for(sid)
    assert fires[0]["status"] == "ok"
    assert fires[0]["result_summary"] == "2 shares reviewed"
    assert fires[0]["child_session_id"] == 42
    assert fires[0]["finished_at"] is not None


def test_schedule_fire_finish_accepts_skipped_status(tmp_db):
    from secu_agent import state

    sid = state.schedule_create(
        agent_type="agent", prompt="x", cron_expr="@once",
        next_run=1.0, origin="operator_agent", repeat=1,
    )
    fid = state.schedule_fire_start(sid)
    state.schedule_fire_finish(fid, status="skipped", result_summary="superseded")

    fire = state.schedule_fires_for(sid)[0]
    assert fire["status"] == "skipped"
    assert fire["result_summary"] == "superseded"


def test_chat_latest_message_id_helpers(tmp_db):
    from secu_agent import state

    sid = state.chat_session_new()
    assert state.chat_latest_message_id(sid, role="user") is None
    first = state.chat_message_add(sid, role="user", content={"text": "first"})
    state.chat_message_add(sid, role="assistant", content={"text": "ack"})
    second = state.chat_message_add(sid, role="user", content={"text": "second"})

    assert state.chat_latest_message_id(sid, role="user") == second
    assert state.chat_has_message_after(sid, first, role="user") is True
    assert state.chat_has_message_after(sid, second, role="user") is False


def test_schedule_fire_start_increments_fire_count_and_touches_last_run(tmp_db):
    from secu_agent import state
    sid = state.schedule_create(
        agent_type="agent", prompt="x", cron_expr="* * * * *",
        next_run=1.0, origin="user",
    )
    before = state.schedule_get(sid)
    assert before["fire_count"] == 0
    assert before["last_run"] is None

    state.schedule_fire_start(sid)
    after = state.schedule_get(sid)
    assert after["fire_count"] == 1
    assert after["last_run"] is not None


def test_schedule_fires_for_orders_newest_first(tmp_db):
    from secu_agent import state
    sid = state.schedule_create(
        agent_type="agent", prompt="x", cron_expr="* * * * *",
        next_run=1.0, origin="user",
    )
    f1 = state.schedule_fire_start(sid)
    state.schedule_fire_finish(f1, status="ok", result_summary="r1")
    f2 = state.schedule_fire_start(sid)
    state.schedule_fire_finish(f2, status="error", result_summary="boom")

    fires = state.schedule_fires_for(sid)
    assert len(fires) == 2
    assert fires[0]["id"] == f2  # newest first


def test_schedule_create_validates_agent_type(tmp_db):
    """알 수 없는 agent_type 거부 — operator 가 오타로 만들면 안 됨."""
    import pytest
    from secu_agent import state
    with pytest.raises(ValueError):
        state.schedule_create(
            agent_type="bogus", prompt="x", cron_expr="* * * * *",
            next_run=1.0, origin="user",
        )


def test_schedule_create_validates_deliver(tmp_db):
    import pytest
    from secu_agent import state
    with pytest.raises(ValueError):
        state.schedule_create(
            agent_type="agent", prompt="x", cron_expr="* * * * *",
            next_run=1.0, origin="user", deliver="email_to_ceo",
        )


def test_schedule_create_validates_origin(tmp_db):
    import pytest
    from secu_agent import state
    with pytest.raises(ValueError):
        state.schedule_create(
            agent_type="agent", prompt="x", cron_expr="* * * * *",
            next_run=1.0, origin="evil_bot",
        )
