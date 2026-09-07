from __future__ import annotations


def _job(**overrides):
    job = {
        "id": 1,
        "schedule_kind": "self_wakeup",
        "stale_policy": "skip_if_superseded",
        "source_session_id": 10,
        "source_message_id": 20,
        "expires_at": 200.0,
    }
    job.update(overrides)
    return job


def test_schedule_contract_allows_unsuperseded_self_wakeup():
    from secu_agent.agent.schedule_contract import evaluate_schedule_fire

    decision = evaluate_schedule_fire(
        _job(), now=150.0, latest_user_message_id=20,
    )

    assert decision.should_run is True
    assert decision.reason == "ready"


def test_schedule_contract_skips_superseded_self_wakeup():
    from secu_agent.agent.schedule_contract import evaluate_schedule_fire

    decision = evaluate_schedule_fire(
        _job(), now=150.0, latest_user_message_id=21,
    )

    assert decision.should_run is False
    assert decision.reason == "superseded"


def test_schedule_contract_skips_expired_self_wakeup():
    from secu_agent.agent.schedule_contract import evaluate_schedule_fire

    decision = evaluate_schedule_fire(
        _job(), now=201.0, latest_user_message_id=20,
    )

    assert decision.should_run is False
    assert decision.reason == "expired"


def test_schedule_contract_keeps_legacy_schedules_running():
    from secu_agent.agent.schedule_contract import evaluate_schedule_fire

    decision = evaluate_schedule_fire(
        _job(schedule_kind="legacy", stale_policy="run"),
        now=999.0,
        latest_user_message_id=999,
    )

    assert decision.should_run is True
    assert decision.reason == "ready"
