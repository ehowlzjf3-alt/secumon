"""Approval audit web API."""
from __future__ import annotations


def _set_token(monkeypatch, tok: str = "tok-123"):
    monkeypatch.setenv("SA_CHAT_TOKEN", tok)


def _seed_approval(
    *,
    approval_id="approval-1",
    agent_type="smb",
    decision="allow",
    actor="alice",
):
    from secu_agent import state

    sid = state.chat_session_get_or_create(agent_type=agent_type)
    state.approval_audit_record_request(
        approval_id=approval_id,
        session_id=sid,
        agent_type=agent_type,
        actor=actor,
        tool_name="host_write",
        tool_input={"path": "x.txt"},
        reason="approval required",
    )
    state.approval_audit_resolve(
        approval_id,
        decision=decision,
        decision_reason=f"{decision} reason",
        actor=actor,
    )
    return approval_id


def test_approval_audit_list_requires_token(client, monkeypatch):
    _set_token(monkeypatch, "good")
    r = client.get("/api/approvals?token=bad")
    assert r.status_code == 401


def test_approval_audit_list_filters_and_shapes_rows(client, monkeypatch):
    _set_token(monkeypatch)
    _seed_approval(approval_id="smb-allow", agent_type="smb", decision="allow")
    _seed_approval(approval_id="web-deny", agent_type="web", decision="deny", actor="bob")

    r = client.get("/api/approvals?token=tok-123&agent_type=web&decision=deny")
    assert r.status_code == 200
    body = r.json()

    assert body["total"] == 1
    assert body["decision_counts"] == {"allow": 1, "deny": 1}
    item = body["items"][0]
    assert item["approval_id"] == "web-deny"
    assert item["agent_type"] == "web"
    assert item["actor"] == "bob"
    assert item["decision"] == "deny"
    assert item["decision_reason"] == "deny reason"
    assert len(item["tool_input_hash"]) == 64


def test_approval_audit_detail(client, monkeypatch):
    _set_token(monkeypatch)
    _seed_approval(approval_id="approval-detail")

    r = client.get("/api/approvals/approval-detail?token=tok-123")
    assert r.status_code == 200
    assert r.json()["approval_id"] == "approval-detail"


def test_approval_audit_detail_404(client, monkeypatch):
    _set_token(monkeypatch)
    r = client.get("/api/approvals/missing?token=tok-123")
    assert r.status_code == 404
