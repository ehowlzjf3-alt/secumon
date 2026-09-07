"""Domain overview API."""
from __future__ import annotations


def _set_token(monkeypatch, tok: str = "tok-123"):
    monkeypatch.setenv("SA_CHAT_TOKEN", tok)


def test_domain_overview_requires_token(client, monkeypatch):
    _set_token(monkeypatch, "good")
    r = client.get("/api/domains/overview?token=bad")
    assert r.status_code == 401


def test_domain_overview_shapes_agent_required_fields(
    tmp_db, client, monkeypatch,
):
    from secu_agent import state

    _set_token(monkeypatch)
    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "app.internal,dev.internal")
    state.chat_session_new(agent_type="web", label="web agent_type")
    state.finding_upsert(
        task_type="web",
        asset="https://app.internal/.env",
        asset_kind="url",
        severity="high",
        summary="exposed env",
        evidence_ref="web/probe.json",
    )

    r = client.get("/api/domains/overview?token=tok-123")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 5

    web = next(item for item in body["items"] if item["key"] == "web")
    assert web["agent_count"] == 1
    assert web["discovered"]["allowed_domains"] == 2
    assert web["discovered"]["open_findings"] == 1
    assert "allowed domains/CIDRs" in web["required"]

    smb = next(item for item in body["items"] if item["key"] == "smb")
    assert "readable share inventory" in smb["required"]
    assert "SMB discovery result" in smb["missing"]
