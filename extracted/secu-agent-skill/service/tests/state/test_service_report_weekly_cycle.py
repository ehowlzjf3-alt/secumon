from __future__ import annotations

import json
import time

import pytest

import service.state_domain as sd


def _service_thread_upsert(
    domain: str,
    *,
    finding_id: int,
    cycle_key: str,
    status: str = "reported",
    severity: str = "high",
    recipient: str | None = None,
    owner_recipient: str | None = None,
    scope: str | None = None,
) -> tuple[str, int]:
    if domain == "github":
        return sd.github_report_thread_upsert(
            finding_id=finding_id,
            repo=scope or "org/repo",
            severity=severity,
            recipient=recipient,
            owner_recipient=owner_recipient,
            status=status,
            cycle_key=cycle_key,
        )
    if domain == "confluence":
        return sd.confluence_report_thread_upsert(
            finding_id=finding_id,
            space_key=scope or "OPS",
            severity=severity,
            recipient=recipient,
            owner_recipient=owner_recipient,
            status=status,
            cycle_key=cycle_key,
        )
    raise AssertionError(f"unsupported domain: {domain}")


def _service_thread_set_status(domain: str, thread_id: int, status: str, **fields) -> None:
    if domain == "github":
        sd.github_report_thread_set_status(thread_id, status, **fields)
        return
    if domain == "confluence":
        sd.confluence_report_thread_set_status(thread_id, status, **fields)
        return
    raise AssertionError(f"unsupported domain: {domain}")


def _service_thread_get(domain: str, thread_id: int) -> dict | None:
    if domain == "github":
        return sd.github_report_thread_get(thread_id)
    if domain == "confluence":
        return sd.confluence_report_thread_get(thread_id)
    raise AssertionError(f"unsupported domain: {domain}")


def _service_thread_claim_next(domain: str, *, session_id: int, status: str) -> dict | None:
    if domain == "github":
        return sd.github_report_thread_claim_next(session_id=session_id, status=status)
    if domain == "confluence":
        return sd.confluence_report_thread_claim_next(session_id=session_id, status=status)
    raise AssertionError(f"unsupported domain: {domain}")


def _service_thread_queue_count(domain: str, status: str, *, cycle_key: str) -> int:
    if domain == "github":
        return sd.github_report_thread_queue_count(status, cycle_key=cycle_key)
    if domain == "confluence":
        return sd.confluence_report_thread_queue_count(status, cycle_key=cycle_key)
    raise AssertionError(f"unsupported domain: {domain}")


def _service_subject_tag(domain: str) -> str:
    if domain == "github":
        return sd.normalize_github_subject_tag("org/repo")
    if domain == "confluence":
        return sd.normalize_confluence_subject_tag("OPS")
    raise AssertionError(f"unsupported domain: {domain}")


def _service_thread_table(domain: str) -> str:
    if domain == "github":
        return "github_report_thread"
    if domain == "confluence":
        return "confluence_report_thread"
    raise AssertionError(f"unsupported domain: {domain}")


def test_github_report_threads_are_isolated_by_weekly_cycle(tmp_db, monkeypatch) -> None:
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    action, old_id = sd.github_report_thread_upsert(
        finding_id=10,
        repo="org/repo",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    assert action == "new"
    sd.github_report_thread_set_status(old_id, "awaiting_owner")

    same_action, same_id = sd.github_report_thread_upsert(
        finding_id=10,
        repo="org/repo",
        severity="critical",
        status="reported",
        cycle_key="2026-W27",
    )
    assert (same_action, same_id) == ("dup", old_id)

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    assert sd.github_report_thread_claim_next(session_id=701, status="reported") is None

    recur_action, recur_id = sd.github_report_thread_upsert(
        finding_id=10,
        repo="org/repo",
        severity="high",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        status="reported",
        cycle_key="2026-W28",
    )

    old_thread = sd.github_report_thread_get(old_id)
    recur_thread = sd.github_report_thread_get(recur_id)
    assert recur_action == "recurred"
    assert recur_id != old_id
    assert old_thread["status"] == "awaiting_owner"
    assert old_thread["last_cycle_key"] == "2026-W27"
    assert recur_thread["status"] == "reported"
    assert recur_thread["last_cycle_key"] == "2026-W28"
    assert json.loads(recur_thread["cycle_keys"]) == ["2026-W27", "2026-W28"]

    assert [t["id"] for t in sd.github_report_threads_overview(cycle_key="2026-W27")] == [old_id]
    assert [t["id"] for t in sd.github_report_threads_overview(cycle_key="2026-W28")] == [recur_id]
    assert sd.github_report_thread_status_counts(cycle_key="2026-W27")["awaiting_owner"] == 1
    assert sd.github_report_thread_status_counts(cycle_key="2026-W28")["reported"] == 1
    assert sd.github_report_thread_cycle_keys()[:2] == ["2026-W28", "2026-W27"]

    claimed = sd.github_report_thread_claim_next(session_id=702, status="reported")
    assert claimed is not None
    assert int(claimed["id"]) == recur_id


def test_confluence_report_threads_are_isolated_by_weekly_cycle(tmp_db, monkeypatch) -> None:
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    action, old_id = sd.confluence_report_thread_upsert(
        finding_id=20,
        space_key="OPS",
        severity="medium",
        status="reported",
        cycle_key="2026-W27",
    )
    assert action == "new"
    sd.confluence_report_thread_set_status(old_id, "awaiting_owner")

    same_action, same_id = sd.confluence_report_thread_upsert(
        finding_id=20,
        space_key="OPS",
        severity="high",
        status="reported",
        cycle_key="2026-W27",
    )
    assert (same_action, same_id) == ("dup", old_id)

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    assert sd.confluence_report_thread_claim_next(session_id=801, status="reported") is None

    recur_action, recur_id = sd.confluence_report_thread_upsert(
        finding_id=20,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        owner_recipient="space.owner@samsung.com",
        status="reported",
        cycle_key="2026-W28",
    )

    old_thread = sd.confluence_report_thread_get(old_id)
    recur_thread = sd.confluence_report_thread_get(recur_id)
    assert recur_action == "recurred"
    assert recur_id != old_id
    assert old_thread["status"] == "awaiting_owner"
    assert old_thread["last_cycle_key"] == "2026-W27"
    assert recur_thread["status"] == "reported"
    assert recur_thread["last_cycle_key"] == "2026-W28"
    assert json.loads(recur_thread["cycle_keys"]) == ["2026-W27", "2026-W28"]

    assert [t["id"] for t in sd.confluence_report_threads_overview(cycle_key="2026-W27")] == [old_id]
    assert [t["id"] for t in sd.confluence_report_threads_overview(cycle_key="2026-W28")] == [recur_id]
    assert sd.confluence_report_thread_status_counts(cycle_key="2026-W27")["awaiting_owner"] == 1
    assert sd.confluence_report_thread_status_counts(cycle_key="2026-W28")["reported"] == 1
    assert sd.confluence_report_thread_cycle_keys()[:2] == ["2026-W28", "2026-W27"]

    claimed = sd.confluence_report_thread_claim_next(session_id=802, status="reported")
    assert claimed is not None
    assert int(claimed["id"]) == recur_id


def test_legacy_report_and_mail_threads_backfill_to_w25(tmp_db) -> None:
    now = time.time()
    with sd.connect() as c:
        github_id = c.execute(
            "INSERT INTO github_report_thread("
            "repo, finding_id, subject_tag, severity, status, recipient, created_at, updated_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            (
                "org/legacy",
                901,
                "[GitHub 보안취약점 조치요청](org/legacy)",
                "high",
                "reported",
                "owner@samsung.com",
                now,
                now,
            ),
        ).fetchone()["id"]
        confluence_id = c.execute(
            "INSERT INTO confluence_report_thread("
            "space_key, finding_id, subject_tag, severity, status, recipient, created_at, updated_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            (
                "LEG",
                902,
                "[Confluence 보안취약점 조치요청](LEG)",
                "high",
                "reported",
                "space.owner@samsung.com",
                now,
                now,
            ),
        ).fetchone()["id"]
        mail_id = c.execute(
            "INSERT INTO mail_thread("
            "finding_id, host, subject_tag, severity, status, recipient, created_at, updated_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            (
                903,
                "10.10.10.10",
                "[보안취약점 조치요청](10.10.10.10)",
                "high",
                "reported",
                "owner@samsung.com",
                now,
                now,
            ),
        ).fetchone()["id"]

    sd._SCHEMA_READY = False
    with sd.connect():
        pass

    github = sd.github_report_thread_get(github_id)
    confluence = sd.confluence_report_thread_get(confluence_id)
    mail = sd.mail_thread_get(mail_id)

    for row in (github, confluence, mail):
        assert row["first_cycle_key"] == "2026-W25"
        assert row["last_cycle_key"] == "2026-W25"
        assert json.loads(row["cycle_keys"]) == ["2026-W25"]

    assert [t["id"] for t in sd.github_report_threads_overview(cycle_key="2026-W25")] == [
        github_id,
    ]
    assert [t["id"] for t in sd.confluence_report_threads_overview(cycle_key="2026-W25")] == [
        confluence_id,
    ]
    assert [t["id"] for t in sd.mail_threads_overview(cycle_key="2026-W25")] == [mail_id]
    assert "2026-W25" in sd.github_report_thread_cycle_keys()
    assert "2026-W25" in sd.confluence_report_thread_cycle_keys()
    assert "2026-W25" in sd.mail_thread_cycle_keys()


@pytest.mark.parametrize("domain", ["github", "confluence"])
def test_service_report_recurrence_clears_stale_report_artifacts(
    tmp_db,
    domain: str,
) -> None:
    _, thread_id = _service_thread_upsert(
        domain,
        finding_id=21,
        cycle_key="2026-W27",
        status="reported",
    )
    _service_thread_set_status(
        domain,
        thread_id,
        "report_ready",
        report_json=json.dumps({"stale": True}),
        report_html="<h1>old report</h1>",
        notified_at=100.0,
        claimed_by=123,
        claimed_at=time.time(),
        retry_after=time.time() + 3600,
    )

    action, same_id = _service_thread_upsert(
        domain,
        finding_id=22,
        cycle_key="2026-W27",
        status="reported",
    )

    assert (action, same_id) == ("recurred", thread_id)
    thread = _service_thread_get(domain, thread_id)
    assert thread is not None
    assert thread["status"] == "reported"
    assert json.loads(thread["finding_ids"]) == [21, 22]
    assert json.loads(thread["report_json"]) == {}
    assert thread["report_html"] is None
    assert thread["notified_at"] is None
    assert thread["claimed_by"] is None
    assert thread["claimed_at"] is None
    assert thread["retry_after"] is None
    assert thread["attempt_count"] == 1


@pytest.mark.parametrize("domain", ["github", "confluence"])
def test_service_report_ready_same_finding_input_change_requeues_report(
    tmp_db,
    domain: str,
) -> None:
    _, thread_id = _service_thread_upsert(
        domain,
        finding_id=51,
        cycle_key="2026-W27",
        status="reported",
        severity="medium",
        recipient="old.owner@samsung.com",
        owner_recipient="old.owner@samsung.com",
    )
    _service_thread_set_status(
        domain,
        thread_id,
        "report_ready",
        report_json=json.dumps({"severity": "medium", "owner": "old.owner@samsung.com"}),
        report_html="<h1>old report</h1>",
        notified_at=None,
        claimed_by=123,
        claimed_at=time.time(),
        retry_after=time.time() + 3600,
    )

    action, same_id = _service_thread_upsert(
        domain,
        finding_id=51,
        cycle_key="2026-W27",
        status="reported",
        severity="critical",
        recipient="new.owner@samsung.com",
        owner_recipient="new.owner@samsung.com",
    )

    assert (action, same_id) == ("recurred", thread_id)
    thread = _service_thread_get(domain, thread_id)
    assert thread is not None
    assert thread["status"] == "reported"
    assert thread["severity"] == "critical"
    assert thread["recipient"] == "new.owner@samsung.com"
    assert thread["owner_recipient"] == "new.owner@samsung.com"
    assert json.loads(thread["finding_ids"]) == [51]
    assert json.loads(thread["report_json"]) == {}
    assert thread["report_html"] is None
    assert thread["notified_at"] is None
    assert thread["claimed_by"] is None
    assert thread["claimed_at"] is None
    assert thread["retry_after"] is None
    assert thread["attempt_count"] == 1


@pytest.mark.parametrize("domain", ["github", "confluence"])
def test_service_report_ready_same_finding_unchanged_input_stays_duplicate(
    tmp_db,
    domain: str,
) -> None:
    _, thread_id = _service_thread_upsert(
        domain,
        finding_id=52,
        cycle_key="2026-W27",
        status="reported",
        severity="high",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
    )
    _service_thread_set_status(
        domain,
        thread_id,
        "report_ready",
        report_json=json.dumps({"ready": True}),
        report_html="<h1>current report</h1>",
        retry_after=time.time() + 3600,
    )

    action, same_id = _service_thread_upsert(
        domain,
        finding_id=52,
        cycle_key="2026-W27",
        status="reported",
        severity="high",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
    )

    assert (action, same_id) == ("dup", thread_id)
    thread = _service_thread_get(domain, thread_id)
    assert thread is not None
    assert thread["status"] == "report_ready"
    assert json.loads(thread["report_json"]) == {"ready": True}
    assert thread["report_html"] == "<h1>current report</h1>"
    assert thread["retry_after"] is not None
    assert thread["attempt_count"] == 0


@pytest.mark.parametrize("domain", ["github", "confluence"])
def test_service_recheck_claims_are_current_cycle_only(
    tmp_db,
    monkeypatch,
    domain: str,
) -> None:
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    _, old_id = _service_thread_upsert(
        domain,
        finding_id=30,
        cycle_key="2026-W27",
        status="recheck_requested",
    )

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    assert _service_thread_claim_next(
        domain,
        session_id=901,
        status="recheck_requested",
    ) is None

    _, current_id = _service_thread_upsert(
        domain,
        finding_id=30,
        cycle_key="2026-W28",
        status="recheck_requested",
    )
    claimed = _service_thread_claim_next(
        domain,
        session_id=902,
        status="recheck_requested",
    )

    assert claimed is not None
    assert int(claimed["id"]) == current_id
    assert int(claimed["id"]) != old_id


@pytest.mark.parametrize("domain", ["github", "confluence"])
def test_service_recheck_claim_skips_future_retry_after(
    tmp_db,
    monkeypatch,
    domain: str,
) -> None:
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    _, thread_id = _service_thread_upsert(
        domain,
        finding_id=40,
        cycle_key="2026-W27",
        status="recheck_requested",
    )
    _service_thread_set_status(
        domain,
        thread_id,
        "recheck_requested",
        retry_after=time.time() + 3600,
    )

    assert _service_thread_claim_next(
        domain,
        session_id=903,
        status="recheck_requested",
    ) is None
    assert _service_thread_queue_count(
        domain,
        "recheck_requested",
        cycle_key="2026-W27",
    ) == 0

    _service_thread_set_status(
        domain,
        thread_id,
        "recheck_requested",
        retry_after=time.time() - 1,
    )
    assert _service_thread_queue_count(
        domain,
        "recheck_requested",
        cycle_key="2026-W27",
    ) == 1
    claimed = _service_thread_claim_next(
        domain,
        session_id=904,
        status="recheck_requested",
    )

    assert claimed is not None
    assert int(claimed["id"]) == thread_id


@pytest.mark.parametrize("domain", ["github", "confluence"])
@pytest.mark.parametrize("status", ["reported", "recheck_requested"])
def test_service_queue_count_matches_claim_retry_and_claim_guards(
    tmp_db,
    monkeypatch,
    domain: str,
    status: str,
) -> None:
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    stale_seconds = (
        sd.GITHUB_REPORT_THREAD_CLAIM_STALE_SECONDS
        if domain == "github"
        else sd.CONFLUENCE_REPORT_THREAD_CLAIM_STALE_SECONDS
    )

    def scope(name: str) -> str:
        return f"org/{status}-{name}" if domain == "github" else f"{status[:2].upper()}{name.upper()}"

    _, queued_id = _service_thread_upsert(
        domain,
        finding_id=60,
        cycle_key="2026-W27",
        status=status,
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        scope=scope("queued"),
    )
    _, cooling_id = _service_thread_upsert(
        domain,
        finding_id=61,
        cycle_key="2026-W27",
        status=status,
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        scope=scope("cooling"),
    )
    _service_thread_set_status(
        domain,
        cooling_id,
        status,
        retry_after=time.time() + 3600,
    )
    _, active_id = _service_thread_upsert(
        domain,
        finding_id=62,
        cycle_key="2026-W27",
        status=status,
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        scope=scope("active"),
    )
    _service_thread_set_status(
        domain,
        active_id,
        status,
        claimed_by=999_901,
        claimed_at=time.time(),
    )
    _, stale_id = _service_thread_upsert(
        domain,
        finding_id=63,
        cycle_key="2026-W27",
        status=status,
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        scope=scope("stale"),
    )
    _service_thread_set_status(
        domain,
        stale_id,
        status,
        claimed_by=999_902,
        claimed_at=time.time() - stale_seconds - 10,
    )

    assert _service_thread_queue_count(domain, status, cycle_key="2026-W27") == 2
    counts = (
        sd.github_report_thread_status_counts(cycle_key="2026-W27")
        if domain == "github"
        else sd.confluence_report_thread_status_counts(cycle_key="2026-W27")
    )
    assert counts[status] == 4

    claimed = _service_thread_claim_next(domain, session_id=906, status=status)
    assert claimed is not None
    assert int(claimed["id"]) == queued_id
    assert int(claimed["id"]) not in {cooling_id, active_id}
    assert _service_thread_queue_count(domain, status, cycle_key="2026-W27") == 1


@pytest.mark.parametrize("domain", ["github", "confluence"])
def test_service_report_queue_count_excludes_ownerless_reported_threads(
    tmp_db,
    monkeypatch,
    domain: str,
) -> None:
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    _, ownerless_id = _service_thread_upsert(
        domain,
        finding_id=70,
        cycle_key="2026-W27",
        status="reported",
        recipient=None,
        owner_recipient=None,
        scope="org/ownerless" if domain == "github" else "NOOWNER",
    )
    _, owner_ready_id = _service_thread_upsert(
        domain,
        finding_id=71,
        cycle_key="2026-W27",
        status="reported",
        recipient="owner@samsung.com",
        owner_recipient="owner@samsung.com",
        scope="org/owner-ready" if domain == "github" else "OWNER",
    )
    _, old_cycle_id = _service_thread_upsert(
        domain,
        finding_id=72,
        cycle_key="2026-W26",
        status="reported",
        recipient="old.owner@samsung.com",
        owner_recipient="old.owner@samsung.com",
        scope="org/old-owner" if domain == "github" else "OLDOWNER",
    )

    assert _service_thread_get(domain, ownerless_id)["status"] == "reported"
    assert _service_thread_get(domain, old_cycle_id)["status"] == "reported"
    assert _service_thread_queue_count(domain, "reported", cycle_key="2026-W27") == 1
    assert _service_thread_queue_count(domain, "reported", cycle_key="2026-W26") == 1
    assert _service_thread_queue_count(domain, "reported", cycle_key="2026-W28") == 0

    counts = (
        sd.github_report_thread_status_counts(cycle_key="2026-W27")
        if domain == "github"
        else sd.confluence_report_thread_status_counts(cycle_key="2026-W27")
    )
    assert counts["reported"] == 2

    claimed = _service_thread_claim_next(domain, session_id=905, status="reported")
    assert claimed is not None
    assert int(claimed["id"]) == owner_ready_id
    assert int(claimed["id"]) != ownerless_id


@pytest.mark.parametrize("domain", ["github", "confluence"])
def test_service_reply_match_prefers_latest_outbound_cycle_when_old_thread_was_updated(
    tmp_db,
    domain: str,
) -> None:
    _, old_id = _service_thread_upsert(domain, finding_id=100, cycle_key="2026-W25")
    _service_thread_set_status(domain, old_id, "awaiting_owner", notified_at=100.0)

    action, current_id = _service_thread_upsert(domain, finding_id=100, cycle_key="2026-W27")
    assert action == "recurred"
    _service_thread_set_status(domain, current_id, "awaiting_owner", notified_at=200.0)

    table = _service_thread_table(domain)
    with sd.connect() as c:
        c.execute(f"UPDATE {table} SET updated_at=? WHERE id=?", (300.0, old_id))
        c.execute(f"UPDATE {table} SET updated_at=? WHERE id=?", (150.0, current_id))

    matched = sd.service_report_thread_find_inbound_match_at(
        domain,
        _service_subject_tag(domain),
        received_at=250.0,
    )

    assert matched is not None
    assert int(matched["id"]) == current_id


@pytest.mark.parametrize("domain", ["github", "confluence"])
def test_service_reply_match_does_not_fall_back_to_old_cycle_for_stale_reply(
    tmp_db,
    domain: str,
) -> None:
    _, old_id = _service_thread_upsert(domain, finding_id=200, cycle_key="2026-W25")
    _service_thread_set_status(domain, old_id, "awaiting_owner", notified_at=100.0)

    action, current_id = _service_thread_upsert(domain, finding_id=200, cycle_key="2026-W27")
    assert action == "recurred"
    _service_thread_set_status(domain, current_id, "awaiting_owner", notified_at=200.0)

    table = _service_thread_table(domain)
    with sd.connect() as c:
        c.execute(f"UPDATE {table} SET updated_at=? WHERE id=?", (300.0, old_id))
        c.execute(f"UPDATE {table} SET updated_at=? WHERE id=?", (150.0, current_id))

    matched = sd.service_report_thread_find_inbound_match_at(
        domain,
        _service_subject_tag(domain),
        received_at=150.0,
    )

    assert matched is None


@pytest.mark.parametrize("domain", ["github", "confluence"])
def test_service_reply_match_uses_sent_reply_as_latest_outbound_boundary(
    tmp_db,
    domain: str,
) -> None:
    _, thread_id = _service_thread_upsert(domain, finding_id=300, cycle_key="2026-W27")
    _service_thread_set_status(domain, thread_id, "awaiting_owner", notified_at=200.0)
    sd.service_reply_message_add(
        domain=domain,
        thread_id=thread_id,
        direction="out",
        subject=f"RE: {_service_subject_tag(domain)}",
        subject_tag=_service_subject_tag(domain),
        mail_from="dssoc@samsung.com",
        mail_to="owner@samsung.com",
        body_excerpt="how-to reply",
        agent_verdict="sent",
        received_at=300.0,
    )

    stale = sd.service_report_thread_find_inbound_match_at(
        domain,
        _service_subject_tag(domain),
        received_at=250.0,
    )
    fresh = sd.service_report_thread_find_inbound_match_at(
        domain,
        _service_subject_tag(domain),
        received_at=350.0,
    )

    assert stale is None
    assert fresh is not None
    assert int(fresh["id"]) == thread_id


@pytest.mark.parametrize("domain", ["github", "confluence"])
def test_service_latest_inbound_after_latest_outbound_ignores_stale_reply(
    tmp_db,
    domain: str,
) -> None:
    _, thread_id = _service_thread_upsert(domain, finding_id=310, cycle_key="2026-W27")
    _service_thread_set_status(domain, thread_id, "awaiting_owner", notified_at=200.0)
    sd.service_reply_message_add(
        domain=domain,
        thread_id=thread_id,
        direction="in",
        message_id=f"{domain}-stale-inbound",
        subject=f"RE: {_service_subject_tag(domain)}",
        subject_tag=_service_subject_tag(domain),
        mail_from="owner@samsung.com",
        mail_to="dssoc@samsung.com",
        body_excerpt="old reply",
        agent_verdict="classified_how_to_question",
        received_at=250.0,
    )
    sd.service_reply_message_add(
        domain=domain,
        thread_id=thread_id,
        direction="out",
        subject=f"RE: {_service_subject_tag(domain)}",
        subject_tag=_service_subject_tag(domain),
        mail_from="dssoc@samsung.com",
        mail_to="owner@samsung.com",
        body_excerpt="latest guidance",
        agent_verdict="sent",
        received_at=300.0,
    )

    stale_only = sd.service_reply_message_latest_inbound_after_latest_outbound(
        domain,
        thread_id,
        fallback_outbound_at=200.0,
    )
    fresh_id = sd.service_reply_message_add(
        domain=domain,
        thread_id=thread_id,
        direction="in",
        message_id=f"{domain}-fresh-inbound",
        subject=f"RE:(2) {_service_subject_tag(domain)}",
        subject_tag=_service_subject_tag(domain),
        mail_from="owner@samsung.com",
        mail_to="dssoc@samsung.com",
        body_excerpt="fresh reply",
        agent_verdict="classified_remediation_claim",
        received_at=350.0,
    )
    fresh = sd.service_reply_message_latest_inbound_after_latest_outbound(
        domain,
        thread_id,
        fallback_outbound_at=200.0,
    )

    assert stale_only is None
    assert fresh is not None
    assert int(fresh["id"]) == fresh_id
    assert fresh["message_id"] == f"{domain}-fresh-inbound"
