from __future__ import annotations

from secu_agent.agent.harness.activity import AgentActivityTracker


def test_activity_tracker_records_last_event_and_counts():
    now = {"value": 10.0}

    def clock() -> float:
        return now["value"]

    tracker = AgentActivityTracker(clock=clock)
    tracker.touch("turn_started")
    tracker.touch("text_chunk")
    tracker.touch("text_chunk")
    now["value"] = 12.5

    snap = tracker.snapshot()
    assert snap.last_event == "text_chunk"
    assert snap.seconds_since_activity == 2.5
    assert snap.event_counts == {"turn_started": 1, "text_chunk": 2}
