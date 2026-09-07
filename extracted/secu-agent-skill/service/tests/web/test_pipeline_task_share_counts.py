"""Pipeline task stage uses SMB share counts, not distinct host counts."""
from __future__ import annotations

import time

from domains.smb.application.contracts import SA_SESSION_ID
from domains.smb.webapp.pipeline_view import pipeline_overview
from domains.smb.webapp.routes import agents


def test_pipeline_task_stage_counts_and_lists_shares(seed) -> None:
    import service.state_domain as sd

    seed.share(host="10.0.0.5", share="C$", status="walked")
    seed.share(host="10.0.0.5", share="D$", status="listing_reviewed")
    processing = seed.share(host="10.0.0.6", share="Users", status="walked")
    seed.share(host="10.0.0.7", share="Public", status="triaged_completed")
    seed.share(host="10.0.0.8", share="Broken", status="triaged_errored")

    sd.share_set_status(processing, "in_progress", claimed_by=SA_SESSION_ID, claimed_at=time.time())

    task = next(s for s in pipeline_overview()["stages"] if s["key"] == "task")

    assert task["queue"] == 2
    assert task["processing"] == 1
    assert task["done"] == 2
    assert task["targets"]["active"] == [{
        "label": "\\\\10.0.0.6\\Users",
        "component": "task",
        "session_ref": f"share-{processing}",
    }]
    next_labels = [x["label"] for x in task["targets"]["next"]]
    assert "\\\\10.0.0.5\\C$" in next_labels
    assert all(x["component"] == "task" and x["session_ref"].startswith("share-") for x in task["targets"]["next"])
    metrics = {m["label"]: (m["value"], m["unit"]) for m in task["metrics"]}
    expected = {
        "판정 대기 share": (2, "개"),
        "판정 중 share": (1, "개"),
        "판정 완료 share": (1, "개"),
        "판정 실패 share": (1, "개"),
    }
    for label, value in expected.items():
        assert metrics[label] == value


def test_pipeline_task_stage_moves_stale_claims_back_to_queue(seed) -> None:
    import service.state_domain as sd

    ready = seed.share(host="10.0.0.9", share="Ready", status="walked")
    stale = seed.share(host="10.0.0.10", share="Old", status="walked")
    fresh = seed.share(host="10.0.0.11", share="Current", status="walked")
    stale_at = 1000.0
    fresh_at = time.time()
    sd.share_set_status(stale, "in_progress", claimed_by=SA_SESSION_ID, claimed_at=stale_at)
    sd.share_set_status(fresh, "in_progress", claimed_by=SA_SESSION_ID, claimed_at=fresh_at)

    task = next(s for s in pipeline_overview()["stages"] if s["key"] == "task")

    assert task["queue"] == 2
    assert task["processing"] == 1
    assert task["targets"]["active"] == [{
        "label": "\\\\10.0.0.11\\Current",
        "component": "task",
        "session_ref": f"share-{fresh}",
    }]
    next_refs = {x["session_ref"] for x in task["targets"]["next"]}
    assert next_refs == {f"share-{ready}", f"share-{stale}"}
    metrics = {m["label"]: m["value"] for m in task["metrics"]}
    assert metrics["판정 대기 share"] == 2
    assert metrics["판정 중 share"] == 1


def test_agent_overview_task_queue_is_share_count(seed) -> None:
    seed.share(host="10.0.0.5", share="C$", status="walked")
    seed.share(host="10.0.0.5", share="D$", status="listing_reviewed")

    body = agents.overview()
    task = next(a for a in body["agents"] if a["component"] == "task")

    assert task["queue"] == 2
    assert "대기 2개" in task["main_line"]


def test_agent_overview_task_stale_claim_is_queued_not_active(seed) -> None:
    import service.state_domain as sd

    stale = seed.share(host="10.0.0.20", share="Old", status="walked")
    fresh = seed.share(host="10.0.0.21", share="Current", status="walked")
    sd.share_set_status(stale, "in_progress", claimed_by=SA_SESSION_ID, claimed_at=1000.0)
    sd.share_set_status(fresh, "in_progress", claimed_by=SA_SESSION_ID, claimed_at=time.time())

    body = agents.overview()
    task = next(a for a in body["agents"] if a["component"] == "task")
    sessions = {s["id"]: s for s in task["sessions"]}

    assert task["queue"] == 1
    assert sessions[f"share-{fresh}"]["status"] == "active"
    assert sessions[f"share-{stale}"]["status"] == "queued"
