from __future__ import annotations


def test_finding_upsert_creates_open_lifecycle_row(tmp_db):
    from secu_agent import state

    fid, created = state.finding_upsert(
        task_type="smb",
        asset="smb://host/share/secret.env",
        asset_kind="file",
        severity="high",
        summary="secret exposed",
        owner="team-a",
        ticket_ref="SEC-1",
        sla_due=1234.5,
        evidence_ref="finding.json",
        extra={"kind": "github_pat"},
    )

    row = state.finding_get(fid)
    assert created is True
    assert row["status"] == "open"
    assert row["seen_count"] == 1
    assert row["owner"] == "team-a"
    assert row["ticket_ref"] == "SEC-1"
    assert row["extra"]["kind"] == "github_pat"


def test_finding_upsert_deduplicates_by_fingerprint_and_keeps_worst_severity(tmp_db):
    from secu_agent import state

    first, created_first = state.finding_upsert(
        task_type="web",
        asset="https://example.test/.env",
        asset_kind="url",
        severity="low",
        summary="env exposed",
    )
    second, created_second = state.finding_upsert(
        task_type="web",
        asset="https://example.test/.env",
        asset_kind="url",
        severity="critical",
        summary="env exposed again",
    )

    row = state.finding_get(first)
    assert first == second
    assert created_first is True
    assert created_second is False
    assert row["seen_count"] == 2
    assert row["severity"] == "critical"
    assert row["summary"] == "env exposed again"
    assert len(state.finding_list()) == 1


def test_finding_upsert_dedup_merges_agent_observations(tmp_db):
    from secu_agent import state

    first, created_first = state.finding_upsert(
        task_type="web",
        asset="https://example.test/.env",
        asset_kind="url",
        severity="high",
        summary="env exposed",
        extra={"agent_provenance": {"session_id": 1, "llm_profile": "codex"}},
    )
    second, created_second = state.finding_upsert(
        task_type="web",
        asset="https://example.test/.env",
        asset_kind="url",
        severity="high",
        summary="env exposed again",
        extra={"agent_provenance": {"session_id": 2, "llm_profile": "gpt-oss"}},
    )

    row = state.finding_get(first)
    assert first == second
    assert created_first is True
    assert created_second is False
    assert row["extra"]["agent_provenance"]["llm_profile"] == "gpt-oss"
    assert [p["llm_profile"] for p in row["extra"]["agent_observations"]] == [
        "codex",
        "gpt-oss",
    ]


def test_finding_update_status_owner_and_ticket(tmp_db):
    from secu_agent import state

    fid, _ = state.finding_upsert(
        task_type="github",
        asset="repo://org/repo/path",
        asset_kind="file",
        severity="medium",
        summary="token candidate",
    )

    state.finding_update(
        fid,
        status="triaged",
        owner="repo-owner",
        ticket_ref="SEC-2",
    )

    row = state.finding_get(fid)
    assert row["status"] == "triaged"
    assert row["owner"] == "repo-owner"
    assert row["ticket_ref"] == "SEC-2"


def test_finding_list_filters_status_and_task_type(tmp_db):
    from secu_agent import state

    a, _ = state.finding_upsert(
        task_type="smb", asset="a", asset_kind="file", severity="high", summary="a",
    )
    b, _ = state.finding_upsert(
        task_type="web", asset="b", asset_kind="url", severity="low", summary="b",
    )
    state.finding_update(a, status="triaged")

    assert [r["id"] for r in state.finding_list(status="triaged")] == [a]
    assert [r["id"] for r in state.finding_list(task_type="web")] == [b]


def test_finding_set_status_records_reason_and_preserves_extra(tmp_db):
    """v3.78 F2: finding_set_status — 상태 전이 + 사유 감사기록, 기존 extra(hits) 보존."""
    from secu_agent import state

    fid, _ = state.finding_upsert(
        task_type="github", asset="github:o/r/AUTHORS", asset_kind="repository_file",
        severity="medium", summary="email",
        extra={"hits": [{"category": "pii", "kind": "email"}]},
    )
    state.finding_set_status(fid, "false_positive", reason="이메일-only 노이즈")

    row = state.finding_get(fid)
    assert row["status"] == "false_positive"
    assert row["extra"]["status_reason"] == "이메일-only 노이즈"
    assert "status_changed_at" in row["extra"]
    assert row["extra"]["hits"][0]["kind"] == "email"  # 기존 extra 보존


def test_finding_set_status_rejects_invalid(tmp_db):
    import pytest

    from secu_agent import state

    fid, _ = state.finding_upsert(
        task_type="web", asset="x", asset_kind="url", severity="low", summary="s",
    )
    with pytest.raises(ValueError):
        state.finding_set_status(fid, "bogus")
