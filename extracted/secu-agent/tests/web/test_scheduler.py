"""Scheduler web API."""
from __future__ import annotations


def _set_token(monkeypatch, tok: str = "tok-123"):
    monkeypatch.setenv("SA_CHAT_TOKEN", tok)


def _seed_run(*, agent_type="smb", status="ok", prompt="scheduled review"):
    from secu_agent import state

    sid = state.schedule_create(
        agent_type=agent_type,
        prompt=prompt,
        cron_expr="* * * * *",
        next_run=1.0,
        origin="user",
        deliver="silent",
    )
    fire_id = state.schedule_fire_start(sid)
    state.schedule_fire_finish(
        fire_id,
        status=status,
        result_summary=f"{status} summary",
        child_session_id=77,
    )
    state.schedule_delivery_record_dry_run(
        fire_id=fire_id,
        schedule_id=sid,
        destination="internal-report",
        payload={"schedule_id": sid, "fire_id": fire_id, "status": status},
    )
    return sid, fire_id


def test_scheduler_api_requires_token(client, monkeypatch):
    _set_token(monkeypatch, "good")
    r = client.get("/api/scheduler/runs?token=bad")
    assert r.status_code == 401


def test_scheduler_schedules_list_filters_and_shapes_rows(client, monkeypatch):
    _set_token(monkeypatch)
    _seed_run(agent_type="smb", prompt="smb run")
    web_sid, _ = _seed_run(agent_type="web", prompt="web run")

    r = client.get("/api/scheduler/schedules?token=tok-123&agent_type=web&status=active")
    assert r.status_code == 200
    body = r.json()

    assert body["total"] == 1
    item = body["items"][0]
    assert item["id"] == web_sid
    assert item["agent_type"] == "web"
    assert item["prompt"] == "web run"
    assert item["recent_fire"]["status"] == "ok"


def test_scheduler_runs_list_filters_and_shapes_rows(client, monkeypatch):
    _set_token(monkeypatch)
    _seed_run(agent_type="smb", status="ok")
    _, web_fire = _seed_run(agent_type="web", status="error")

    r = client.get("/api/scheduler/runs?token=tok-123&agent_type=web&status=error")
    assert r.status_code == 200
    body = r.json()

    assert body["total"] == 1
    assert body["status_counts"] == {"error": 1, "ok": 1}
    item = body["items"][0]
    assert item["id"] == web_fire
    assert item["agent_type"] == "web"
    assert item["status"] == "error"
    assert item["delivery_count"] == 1
    assert item["duration_seconds"] is not None


def test_scheduler_runs_include_queued_status(client, monkeypatch):
    _set_token(monkeypatch)
    _seed_run(agent_type="smb", status="queued")

    r = client.get("/api/scheduler/runs?token=tok-123&status=queued")

    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert "queued" in body["statuses"]
    assert body["items"][0]["status"] == "queued"


def test_scheduler_run_detail_includes_dry_run_deliveries(client, monkeypatch):
    _set_token(monkeypatch)
    sid, fire_id = _seed_run(agent_type="github", status="ok")

    r = client.get(f"/api/scheduler/runs/{fire_id}?token=tok-123")
    assert r.status_code == 200
    body = r.json()

    assert body["id"] == fire_id
    assert body["schedule_id"] == sid
    assert body["agent_type"] == "github"
    assert body["deliveries"][0]["channel"] == "internal_report_dry_run"
    assert body["deliveries"][0]["payload"]["fire_id"] == fire_id


def test_scheduler_run_detail_404(client, monkeypatch):
    _set_token(monkeypatch)
    r = client.get("/api/scheduler/runs/999?token=tok-123")
    assert r.status_code == 404


def test_scheduler_run_detail_requires_token(client, monkeypatch):
    # audit #2/#3: run_detail 은 형제 라우트와 달리 token 을 검증하지 않아
    # delivery 페이로드가 무인증 IDOR 로 노출됐다. 유효한 fire 라도 나쁜 토큰이면 401.
    _set_token(monkeypatch, "good")
    _, fire_id = _seed_run(agent_type="github", status="ok")
    r = client.get(f"/api/scheduler/runs/{fire_id}?token=bad")
    assert r.status_code == 401
