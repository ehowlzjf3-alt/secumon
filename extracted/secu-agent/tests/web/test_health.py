"""S0: /api/health — DB 살아있음 + 코어 카운트 (v3.82 U3b: 도메인 카운트 제거, 토큰 필수)."""
from __future__ import annotations

_AUTH = {"Authorization": "Bearer devtoken"}


def test_health_requires_token(client):
    assert client.get("/api/health").status_code == 401


def test_health_empty_db_returns_core_counts(client):
    r = client.get("/api/health", headers=_AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert isinstance(body["db"], str)
    assert body["chat_session_total"] == 0
    assert body["schedule_total"] == 0
    assert body["finding_open"] == 0
    # 도메인 카운트(smb 등)는 도메인 서비스 소유 — 코어 payload 에 없음
    assert "share_total" not in body
    assert "file_total" not in body


def test_health_reflects_core_counts(client):
    from secu_agent import state

    state.chat_session_new(agent_type="agent")
    state.finding_upsert(
        task_type="web", asset="https://app.example/.env", asset_kind="url",
        severity="high", summary="exposed env", evidence_ref="finding.json",
    )

    r = client.get("/api/health", headers=_AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["chat_session_total"] == 1
    assert body["finding_open"] == 1
