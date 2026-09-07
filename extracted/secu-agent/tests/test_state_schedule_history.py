"""Scheduler run history and internal delivery dry-run state."""
from __future__ import annotations

import json


def _schedule(agent_type: str = "agent", *, prompt: str = "scheduled review") -> int:
    from secu_agent import state

    return state.schedule_create(
        agent_type=agent_type,
        prompt=prompt,
        cron_expr="* * * * *",
        next_run=1.0,
        origin="user",
    )


def test_schedule_fire_history_filters_enriches_and_orders(tmp_db):
    from secu_agent import state

    from secu_agent.agent_type_registry import register_agent_type, unregister_agent_type

    register_agent_type("testdom")
    try:
        smb = _schedule("agent", prompt="smb prompt")
        web = _schedule("testdom", prompt="web prompt")
    finally:
        unregister_agent_type("testdom")

    old_fire = state.schedule_fire_start(smb)
    state.schedule_fire_finish(old_fire, status="ok", result_summary="ok")
    new_fire = state.schedule_fire_start(web)
    state.schedule_fire_finish(new_fire, status="error", result_summary="boom")

    all_rows = state.schedule_fire_history(limit=10)
    assert [r["id"] for r in all_rows] == [new_fire, old_fire]
    assert all_rows[0]["agent_type"] == "testdom"
    assert all_rows[0]["schedule_prompt"] == "web prompt"
    assert all_rows[0]["cron_expr"] == "* * * * *"

    web_errors = state.schedule_fire_history(
        agent_type="testdom",
        status="error",
        limit=10,
    )
    assert [r["id"] for r in web_errors] == [new_fire]


def test_schedule_fire_get_returns_detail_with_schedule_fields(tmp_db):
    from secu_agent import state

    sid = _schedule("agent", prompt="repo review")
    fire_id = state.schedule_fire_start(sid)
    state.schedule_fire_finish(
        fire_id,
        status="ok",
        result_summary="2 repos checked",
        child_session_id=123,
    )

    row = state.schedule_fire_get(fire_id)
    assert row is not None
    assert row["id"] == fire_id
    assert row["schedule_id"] == sid
    assert row["agent_type"] == "agent"
    assert row["schedule_prompt"] == "repo review"
    assert row["result_summary"] == "2 repos checked"
    assert row["child_session_id"] == 123


def test_schedule_delivery_dry_run_records_payload_hash_and_payload(tmp_db):
    from secu_agent import state

    sid = _schedule("agent")
    fire_id = state.schedule_fire_start(sid)
    state.schedule_fire_finish(fire_id, status="ok", result_summary="done")

    delivery_id = state.schedule_delivery_record_dry_run(
        fire_id=fire_id,
        schedule_id=sid,
        destination="internal-report",
        payload={"schedule_id": sid, "fire_id": fire_id, "status": "ok"},
    )
    rows = state.schedule_deliveries_for_fire(fire_id)

    assert rows[0]["id"] == delivery_id
    assert rows[0]["channel"] == "internal_report_dry_run"
    assert rows[0]["status"] == "dry_run"
    assert rows[0]["destination"] == "internal-report"
    assert len(rows[0]["payload_hash"]) == 64
    assert json.loads(rows[0]["payload_json"]) == {
        "schedule_id": sid,
        "fire_id": fire_id,
        "status": "ok",
    }


def test_schedule_delete_removes_delivery_dry_runs(tmp_db):
    from secu_agent import state

    sid = _schedule("agent")
    fire_id = state.schedule_fire_start(sid)
    state.schedule_fire_finish(fire_id, status="ok", result_summary="done")
    state.schedule_delivery_record_dry_run(
        fire_id=fire_id,
        schedule_id=sid,
        destination="internal-report",
        payload={"schedule_id": sid, "fire_id": fire_id},
    )

    state.schedule_delete(sid)

    assert state.schedule_get(sid) is None
    assert state.schedule_fires_for(sid) == []
    assert state.schedule_deliveries_for_fire(fire_id) == []
