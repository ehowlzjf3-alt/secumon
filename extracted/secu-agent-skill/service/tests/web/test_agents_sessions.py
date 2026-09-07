"""Agent console session presentation checks."""
from __future__ import annotations

import time
from typing import Any

from fastapi.testclient import TestClient

from domains.smb.webapp.app import create_app
from domains.smb.webapp.routes import agents


def test_task_worker_session_uses_chat_context_not_raw_target_status(
    seed: Any,
    monkeypatch: Any,
) -> None:
    client = TestClient(create_app())
    monkeypatch.setattr(
        agents.agent_transcripts,
        "transcript_session",
        lambda *args, **kwargs: None,
    )
    share_id = seed.share(
        host="10.125.96.72",
        share="D$",
        status="in_progress",
        severity="high",
        summary="권한과 파일 내용을 확인 중입니다.",
    )

    overview = client.get("/api/agents/overview").json()
    task = next(a for a in overview["agents"] if a["component"] == "task")
    item = next(s for s in task["sessions"] if s["id"] == f"share-{share_id}")

    target = "\\\\10.125.96.72\\D$"
    assert item["title"] == target
    assert item["target"]["display"] == target
    assert item["status_label"] == "진행 중"
    assert "share 상태" not in item["subtitle"]
    assert "in_progress" not in item["subtitle"]

    response = client.get(f"/api/agents/sessions/task/share-{share_id}")
    assert response.status_code == 200
    body = response.json()
    texts = [m["content"]["text"] for m in body["messages"]]

    assert body["title"] == target
    assert body["target"]["display"] == target
    assert body["status_label"] == "진행 중"
    assert any(f"대상 공유 {target}" in text for text in texts)
    assert not any("target=" in text for text in texts)
    assert not any("status=in_progress" in text for text in texts)


def test_agents_overview_mail_and_reverify_sessions_are_current_cycle_only(
    tmp_db,
    monkeypatch,
) -> None:
    from service import state_domain as state

    client = TestClient(create_app())
    monkeypatch.setattr(
        agents.agent_transcripts,
        "transcript_session",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(state, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    state.mail_thread_upsert(
        finding_id=10,
        host="10.0.3.10",
        subject_tag="[tag](10.0.3.10)",
        status="reported",
        cycle_key="2026-W27",
    )
    state.mail_thread_upsert(
        finding_id=11,
        host="10.0.3.11",
        subject_tag="[tag](10.0.3.11)",
        status="reply_received",
        cycle_key="2026-W27",
    )
    _, current_mail_id = state.mail_thread_upsert(
        finding_id=12,
        host="10.0.3.12",
        subject_tag="[tag](10.0.3.12)",
        status="reported",
        cycle_key="2026-W28",
    )
    _, current_reply_id = state.mail_thread_upsert(
        finding_id=13,
        host="10.0.3.13",
        subject_tag="[tag](10.0.3.13)",
        status="reply_received",
        cycle_key="2026-W28",
    )

    overview = client.get("/api/agents/overview").json()

    assert overview["cycle_key"] == "2026-W28"
    mail = next(a for a in overview["agents"] if a["component"] == "mail")
    reverify = next(a for a in overview["agents"] if a["component"] == "reverify")
    assert mail["queue"] == 1
    assert reverify["queue"] == 1
    assert [s["id"] for s in mail["sessions"]] == [f"thread-{current_mail_id}"]
    assert [s["id"] for s in reverify["sessions"]] == [f"thread-{current_reply_id}"]


def test_agents_overview_reverify_queue_excludes_future_retry_after(
    tmp_db,
    monkeypatch,
) -> None:
    from service import state_domain as state

    client = TestClient(create_app())
    monkeypatch.setattr(
        agents.agent_transcripts,
        "transcript_session",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(state, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    state.mail_thread_upsert(
        finding_id=20,
        host="10.0.4.20",
        subject_tag="[tag](10.0.4.20)",
        status="reply_received",
        cycle_key="2026-W28",
    )
    _, scheduled_id = state.mail_thread_upsert(
        finding_id=21,
        host="10.0.4.21",
        subject_tag="[tag](10.0.4.21)",
        status="reply_received",
        cycle_key="2026-W28",
    )
    with state.connect() as c:
        c.execute(
            "UPDATE mail_thread SET retry_after=? WHERE id=?",
            (time.time() + 3600, scheduled_id),
        )

    overview = client.get("/api/agents/overview").json()

    reverify = next(a for a in overview["agents"] if a["component"] == "reverify")
    assert reverify["queue"] == 1
