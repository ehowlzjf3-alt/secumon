from __future__ import annotations


def test_approval_audit_records_request_with_argument_hash(tmp_db):
    from secu_agent import state

    sid = state.chat_session_get_or_create(agent_type="smb")
    row_id = state.approval_audit_record_request(
        approval_id="approval-1",
        session_id=sid,
        agent_type="smb",
        actor="alice",
        tool_name="host_write",
        tool_input={"path": "secret.txt", "content": "do-not-store-raw"},
        reason="write requires approval",
    )

    row = state.approval_audit_get("approval-1")
    assert row is not None
    assert row["id"] == row_id
    assert row["session_id"] == sid
    assert row["agent_type"] == "smb"
    assert row["actor"] == "alice"
    assert row["tool_name"] == "host_write"
    assert row["decision"] == "pending"
    assert row["request_reason"] == "write requires approval"
    assert len(row["tool_input_hash"]) == 64
    assert row["tool_input_size"] > 0
    assert "do-not-store-raw" not in repr(row)


def test_approval_audit_resolves_decision_and_updated_input_hash(tmp_db):
    from secu_agent import state

    sid = state.chat_session_get_or_create(agent_type="github")
    state.approval_audit_record_request(
        approval_id="approval-2",
        session_id=sid,
        agent_type="github",
        actor="bob",
        tool_name="run_in_sandbox",
        tool_input={"cmd": "git status"},
        reason="sandbox approval",
    )

    state.approval_audit_resolve(
        "approval-2",
        decision="allow",
        decision_reason="looks safe",
        updated_input={"cmd": "git status --short"},
        actor="carol",
    )

    row = state.approval_audit_get("approval-2")
    assert row["decision"] == "allow"
    assert row["decision_reason"] == "looks safe"
    assert row["actor"] == "carol"
    assert row["resolved_at"] is not None
    assert len(row["updated_input_hash"]) == 64


def test_approval_audit_list_filters_and_counts(tmp_db):
    from secu_agent import state

    sid = state.chat_session_get_or_create(agent_type="smb")
    state.approval_audit_record_request(
        approval_id="smb-allow",
        session_id=sid,
        agent_type="smb",
        actor="alice",
        tool_name="host_write",
        tool_input={"a": 1},
        reason="approval",
    )
    state.approval_audit_resolve("smb-allow", decision="allow")
    state.approval_audit_record_request(
        approval_id="web-deny",
        session_id=None,
        agent_type="web",
        actor="bob",
        tool_name="browser_action",
        tool_input={"b": 2},
        reason="approval",
    )
    state.approval_audit_resolve("web-deny", decision="deny")

    rows = state.approval_audit_list(agent_type="smb")
    assert [r["approval_id"] for r in rows] == ["smb-allow"]
    denied = state.approval_audit_list(decision="deny")
    assert [r["approval_id"] for r in denied] == ["web-deny"]
    assert state.approval_audit_counts() == {"allow": 1, "deny": 1}


def test_approval_audit_rejects_invalid_decision(tmp_db):
    from secu_agent import state

    state.approval_audit_record_request(
        approval_id="bad-decision",
        session_id=None,
        agent_type="smb",
        actor="alice",
        tool_name="host_write",
        tool_input={},
        reason="approval",
    )

    try:
        state.approval_audit_resolve("bad-decision", decision="approved")
    except ValueError as exc:
        assert "invalid approval decision" in str(exc)
    else:
        raise AssertionError("expected ValueError")
