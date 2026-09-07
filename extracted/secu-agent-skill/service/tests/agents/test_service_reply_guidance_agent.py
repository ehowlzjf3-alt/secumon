from __future__ import annotations

import time

import pytest


def test_github_how_to_guidance_replies_once_with_original_quote(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_recheck_agent
    from service.agents import service_reply_guidance_agent as guidance
    from secu_agent.agent.delivery import DeliveryResult

    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["sink_id"] = sink_id
        captured["payload"] = payload
        captured["charter_ref"] = charter_ref
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(guidance, "deliver", fake_deliver)
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=10,
        repo="org/repo",
        severity="high",
        recipient="owner.one@samsung.com",
        status="reported",
    )
    sd.github_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    inbound_id = sd.service_reply_message_add(
        domain="github",
        direction="in",
        thread_id=thread_id,
        message_id="github-howto-reply",
        in_reply_to="<github-report-root@samsung.com>",
        references_header="<github-report-root@samsung.com> <github-howto-reply@samsung.com>",
        root_message_id="github-root-cms-id",
        subject="RE:(2) [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청",
        subject_tag="[GitHub 보안취약점 조치요청](org/repo)",
        mail_from="Owner One <owner.one@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>, Watcher <watcher@samsung.com>",
        mail_cc="Team Mate <team.mate@samsung.com>",
        body_excerpt="어떻게 조치하면 되나요?",
        body_html="<p>어떻게 조치하면 되나요?</p><table><tr><td>문의</td></tr></table><script>x()</script>",
        agent_verdict="classified_how_to_question",
        decision_reason="답장 신규 본문에서 조치 방법 안내를 요청함",
        received_at=base + 60,
    )

    result = github_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["guidance"]["handled"] == 1
    assert result["guidance"]["sent"] == 1
    assert result["handled"] == 0
    payload = captured["payload"]
    assert captured["sink_id"] == "knox_mail"
    assert captured["charter_ref"] == "SECOPS-TEST"
    assert payload.recipients == ("owner.one@samsung.com",)
    # ★ 회신도 담당자(To) + DSSOC(Cc) 다 — 정책상 우리 팀함이 사본을 받아야 한다.
    #   예전엔 DSSOC 를 To·Cc 양쪽에서 빼기만 해서 회신 사본이 안 남았다.
    assert payload.cc == ("watcher@samsung.com", "team.mate@samsung.com", "dssoc@samsung.com")
    assert payload.subject == (
        "RE:(3) [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청"
    )
    assert "저장소 시크릿 노출 조치 방법" in payload.body
    assert "--------- Original Message ---------" in payload.body
    assert "<table>" in payload.body
    assert "<script" not in payload.body
    assert payload.metadata["reply_message_id"] == inbound_id
    assert payload.metadata["delivery_policy"] == "reply_to_inbound_sender"
    assert payload.metadata["in_reply_to"] == "github-howto-reply"
    assert payload.metadata["references"] == (
        "<github-report-root@samsung.com> <github-howto-reply@samsung.com>"
    )
    assert payload.metadata["root_message_id"] == "github-root-cms-id"
    assert "owner.one@samsung.com" in payload.metadata["delivery_allowed_pii_values"]

    thread = sd.github_report_thread_get(thread_id)
    assert thread["status"] == "awaiting_owner"
    assert thread["claimed_by"] is None
    assert thread["retry_after"] is None
    assert thread["last_reason"] == "how-to guidance sent; awaiting owner reply"
    assert int(thread["attempt_count"] or 0) == 1
    messages = sd.service_reply_messages_for_thread("github", thread_id)
    out = [m for m in messages if m["direction"] == "out"]
    assert len(out) == 1
    assert out[0]["decision_reason"] == guidance.OUTBOUND_HOW_TO_GUIDANCE
    assert out[0]["in_reply_to"] == "github-howto-reply"
    assert out[0]["references_header"] == (
        "<github-report-root@samsung.com> <github-howto-reply@samsung.com>"
    )
    assert out[0]["root_message_id"] == "github-root-cms-id"
    assert out[0]["body_html"] == out[0]["body_excerpt"]
    assert "--------- Original Message ---------" in out[0]["body_html"]
    assert "<script" not in out[0]["body_html"]

    second = github_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )
    assert second["guidance"]["handled"] == 0


def test_github_how_to_guidance_dry_run_schedules_retry_without_outbound_audit(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_recheck_agent
    from service.agents import service_reply_guidance_agent as guidance
    from secu_agent.agent.delivery import DeliveryResult

    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["sink_id"] = sink_id
        captured["payload"] = payload
        return DeliveryResult(
            sink_id=sink_id,
            mode="dry_run",
            detail="dry-run guidance draft",
            draft_path=str(tmp_path / "draft.json"),
        )

    monkeypatch.setattr(guidance, "deliver", fake_deliver)
    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "41")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=11,
        repo="org/retry-repo",
        severity="high",
        recipient="owner.retry@samsung.com",
        status="reported",
    )
    sd.github_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    sd.service_reply_message_add(
        domain="github",
        direction="in",
        thread_id=thread_id,
        message_id="github-howto-dry-run",
        subject="RE: [GitHub 보안취약점 조치요청](org/retry-repo) 소스코드 시크릿 조치 요청",
        subject_tag="[GitHub 보안취약점 조치요청](org/retry-repo)",
        mail_from="Owner Retry <owner.retry@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>",
        body_excerpt="토큰 폐기 방법 안내 부탁드립니다.",
        agent_verdict="classified_how_to_question",
        decision_reason="답장 신규 본문에서 조치 방법 안내를 요청함",
        received_at=base + 60,
    )

    before = time.time()
    result = github_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["guidance"]["handled"] == 1
    assert result["guidance"]["dry_run"] == 1
    assert result["handled"] == 0
    assert captured["sink_id"] == "knox_mail"
    assert captured["payload"].recipients == ("owner.retry@samsung.com",)
    assert "저장소 시크릿 노출 조치 방법" in captured["payload"].body

    thread = sd.github_report_thread_get(thread_id)
    assert thread["status"] == "awaiting_owner"
    assert thread["claimed_by"] is None
    assert thread["retry_after"] >= before + 40
    assert "how-to guidance dry_run" in thread["last_reason"]
    assert int(thread["attempt_count"] or 0) == 1
    messages = sd.service_reply_messages_for_thread("github", thread_id)
    assert [m for m in messages if m["direction"] == "out"] == []
    assert sd.service_report_thread_claim_how_to_guidance_next(
        "github",
        session_id=999,
    ) is None


def test_github_how_to_guidance_normalizes_forwarded_reply_subject(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import github_recheck_agent
    from service.agents import service_reply_guidance_agent as guidance
    from secu_agent.agent.delivery import DeliveryResult

    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["payload"] = payload
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(guidance, "deliver", fake_deliver)
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = sd.github_report_thread_upsert(
        finding_id=12,
        repo="org/fw-repo",
        severity="high",
        recipient="owner.fw@samsung.com",
        status="reported",
    )
    sd.github_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    sd.service_reply_message_add(
        domain="github",
        direction="in",
        thread_id=thread_id,
        message_id="github-forwarded-howto",
        subject="FW: RE:(3) [GitHub 보안취약점 조치요청](org/fw-repo) 소스코드 시크릿 조치 요청",
        subject_tag="[GitHub 보안취약점 조치요청](org/fw-repo)",
        mail_from="Owner FW <owner.fw@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>",
        body_excerpt="조치 방법 안내 부탁드립니다.",
        agent_verdict="classified_how_to_question",
        decision_reason="답장 신규 본문에서 조치 방법 안내를 요청함",
        received_at=base + 60,
    )

    result = github_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["guidance"]["sent"] == 1
    assert captured["payload"].subject == (
        "RE:(4) [GitHub 보안취약점 조치요청](org/fw-repo) 소스코드 시크릿 조치 요청"
    )
    messages = sd.service_reply_messages_for_thread("github", thread_id)
    out = [m for m in messages if m["direction"] == "out"]
    assert out[0]["subject"] == captured["payload"].subject


def test_confluence_how_to_guidance_replies_once_with_original_quote(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import confluence_recheck_agent
    from service.agents import service_reply_guidance_agent as guidance
    from secu_agent.agent.delivery import DeliveryResult

    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["sink_id"] = sink_id
        captured["payload"] = payload
        captured["charter_ref"] = charter_ref
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(guidance, "deliver", fake_deliver)
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=21,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="reported",
    )
    sd.confluence_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    inbound_id = sd.service_reply_message_add(
        domain="confluence",
        direction="in",
        thread_id=thread_id,
        message_id="confluence-howto-sent",
        in_reply_to="<confluence-report-root@samsung.com>",
        references_header=(
            "<confluence-report-root@samsung.com> <confluence-howto-sent@samsung.com>"
        ),
        root_message_id="confluence-root-cms-id",
        subject="RE:(2) [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청",
        subject_tag="[Confluence 보안취약점 조치요청](OPS)",
        mail_from="Space Owner <space.owner@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>, Watcher <watcher@samsung.com>",
        mail_cc="Team Mate <team.mate@samsung.com>",
        body_excerpt="페이지 제한은 어떻게 하면 되나요?",
        body_html="<p>페이지 제한은 어떻게 하면 되나요?</p><table><tr><td>문의</td></tr></table><script>x()</script>",
        agent_verdict="classified_how_to_question",
        decision_reason="답장 신규 본문에서 조치 방법 안내를 요청함",
        received_at=base + 60,
    )

    result = confluence_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["guidance"]["handled"] == 1
    assert result["guidance"]["sent"] == 1
    assert result["handled"] == 0
    payload = captured["payload"]
    assert captured["sink_id"] == "knox_mail"
    assert captured["charter_ref"] == "SECOPS-TEST"
    assert payload.recipients == ("space.owner@samsung.com",)
    # ★ 회신도 담당자(To) + DSSOC(Cc) 다 — 정책상 우리 팀함이 사본을 받아야 한다.
    #   예전엔 DSSOC 를 To·Cc 양쪽에서 빼기만 해서 회신 사본이 안 남았다.
    assert payload.cc == ("watcher@samsung.com", "team.mate@samsung.com", "dssoc@samsung.com")
    assert payload.subject == (
        "RE:(3) [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청"
    )
    assert "Confluence 콘텐츠 조치 방법" in payload.body
    assert "--------- Original Message ---------" in payload.body
    assert "<table>" in payload.body
    assert "<script" not in payload.body
    assert payload.metadata["reply_message_id"] == inbound_id
    assert payload.metadata["delivery_policy"] == "reply_to_inbound_sender"
    assert payload.metadata["in_reply_to"] == "confluence-howto-sent"
    assert payload.metadata["references"] == (
        "<confluence-report-root@samsung.com> <confluence-howto-sent@samsung.com>"
    )
    assert payload.metadata["root_message_id"] == "confluence-root-cms-id"
    assert "space.owner@samsung.com" in payload.metadata["delivery_allowed_pii_values"]

    thread = sd.confluence_report_thread_get(thread_id)
    assert thread["status"] == "awaiting_owner"
    assert thread["claimed_by"] is None
    assert thread["retry_after"] is None
    assert thread["last_reason"] == "how-to guidance sent; awaiting owner reply"
    assert int(thread["attempt_count"] or 0) == 1
    messages = sd.service_reply_messages_for_thread("confluence", thread_id)
    out = [m for m in messages if m["direction"] == "out"]
    assert len(out) == 1
    assert out[0]["decision_reason"] == guidance.OUTBOUND_HOW_TO_GUIDANCE
    assert out[0]["in_reply_to"] == "confluence-howto-sent"
    assert out[0]["references_header"] == (
        "<confluence-report-root@samsung.com> <confluence-howto-sent@samsung.com>"
    )
    assert out[0]["root_message_id"] == "confluence-root-cms-id"
    assert out[0]["body_html"] == out[0]["body_excerpt"]
    assert "--------- Original Message ---------" in out[0]["body_html"]
    assert "<script" not in out[0]["body_html"]

    second = confluence_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )
    assert second["guidance"]["handled"] == 0


def test_confluence_how_to_guidance_dry_run_schedules_retry_without_outbound_audit(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import confluence_recheck_agent
    from service.agents import service_reply_guidance_agent as guidance
    from secu_agent.agent.delivery import DeliveryResult

    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["payload"] = payload
        return DeliveryResult(
            sink_id=sink_id,
            mode="dry_run",
            detail="dry-run guidance draft",
            draft_path=str(tmp_path / "draft.json"),
        )

    monkeypatch.setattr(guidance, "deliver", fake_deliver)
    monkeypatch.setenv("SERVICE_RECHECK_RETRY_SECONDS", "41")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=20,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="reported",
    )
    sd.confluence_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    sd.service_reply_message_add(
        domain="confluence",
        direction="in",
        thread_id=thread_id,
        message_id="confluence-howto-reply",
        subject="RE: [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청",
        subject_tag="[Confluence 보안취약점 조치요청](OPS)",
        mail_from="Space Owner <space.owner@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>",
        body_excerpt="권한 제한 방법 안내 부탁드립니다.",
        agent_verdict="classified_how_to_question",
        decision_reason="답장 신규 본문에서 조치 방법 안내를 요청함",
        received_at=base + 60,
    )

    before = time.time()
    result = confluence_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["guidance"]["handled"] == 1
    assert result["guidance"]["dry_run"] == 1
    assert result["handled"] == 0
    assert captured["payload"].recipients == ("space.owner@samsung.com",)
    assert "Confluence 콘텐츠 조치 방법" in captured["payload"].body

    thread = sd.confluence_report_thread_get(thread_id)
    assert thread["status"] == "awaiting_owner"
    assert thread["claimed_by"] is None
    assert thread["retry_after"] >= before + 40
    assert "how-to guidance dry_run" in thread["last_reason"]
    assert int(thread["attempt_count"] or 0) == 1
    messages = sd.service_reply_messages_for_thread("confluence", thread_id)
    assert [m for m in messages if m["direction"] == "out"] == []
    assert sd.service_report_thread_claim_how_to_guidance_next(
        "confluence",
        session_id=999,
    ) is None


def test_confluence_how_to_guidance_normalizes_forwarded_reply_subject(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from service import state_domain as sd
    from service.agents import confluence_recheck_agent
    from service.agents import service_reply_guidance_agent as guidance
    from secu_agent.agent.delivery import DeliveryResult

    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["payload"] = payload
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="sent")

    monkeypatch.setattr(guidance, "deliver", fake_deliver)
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = sd.confluence_report_thread_upsert(
        finding_id=22,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="reported",
    )
    sd.confluence_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    sd.service_reply_message_add(
        domain="confluence",
        direction="in",
        thread_id=thread_id,
        message_id="confluence-forwarded-howto",
        subject="FW: RE:(3) [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청",
        subject_tag="[Confluence 보안취약점 조치요청](OPS)",
        mail_from="Space Owner <space.owner@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>",
        body_excerpt="조치 방법 안내 부탁드립니다.",
        agent_verdict="classified_how_to_question",
        decision_reason="답장 신규 본문에서 조치 방법 안내를 요청함",
        received_at=base + 60,
    )

    result = confluence_recheck_agent.run_recheck_pass(
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["guidance"]["sent"] == 1
    assert captured["payload"].subject == (
        "RE:(4) [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청"
    )
    messages = sd.service_reply_messages_for_thread("confluence", thread_id)
    out = [m for m in messages if m["direction"] == "out"]
    assert out[0]["subject"] == captured["payload"].subject


@pytest.mark.parametrize("domain", ["github", "confluence"])
def test_service_how_to_guidance_claim_is_current_cycle_only(
    tmp_db,
    monkeypatch,
    domain: str,
) -> None:
    from service import state_domain as sd

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    base = 1_780_000_000.0
    if domain == "github":
        _, old_id = sd.github_report_thread_upsert(
            finding_id=41,
            repo="org/old-howto",
            severity="high",
            recipient="old.owner@samsung.com",
            status="reported",
            cycle_key="2026-W27",
        )
        _, current_id = sd.github_report_thread_upsert(
            finding_id=42,
            repo="org/current-howto",
            severity="high",
            recipient="current.owner@samsung.com",
            status="reported",
            cycle_key="2026-W28",
        )
        sd.github_report_thread_set_status(old_id, "awaiting_owner", notified_at=base)
        sd.github_report_thread_set_status(current_id, "awaiting_owner", notified_at=base)
        old_subject = "[GitHub 보안취약점 조치요청](org/old-howto)"
        current_subject = "[GitHub 보안취약점 조치요청](org/current-howto)"
        get_thread = sd.github_report_thread_get
    else:
        _, old_id = sd.confluence_report_thread_upsert(
            finding_id=43,
            space_key="OLD",
            severity="high",
            recipient="old.owner@samsung.com",
            status="reported",
            cycle_key="2026-W27",
        )
        _, current_id = sd.confluence_report_thread_upsert(
            finding_id=44,
            space_key="CUR",
            severity="high",
            recipient="current.owner@samsung.com",
            status="reported",
            cycle_key="2026-W28",
        )
        sd.confluence_report_thread_set_status(old_id, "awaiting_owner", notified_at=base)
        sd.confluence_report_thread_set_status(current_id, "awaiting_owner", notified_at=base)
        old_subject = "[Confluence 보안취약점 조치요청](OLD)"
        current_subject = "[Confluence 보안취약점 조치요청](CUR)"
        get_thread = sd.confluence_report_thread_get

    old_message_id = sd.service_reply_message_add(
        domain=domain,
        direction="in",
        thread_id=old_id,
        message_id=f"{domain}-old-cycle-howto",
        subject=f"RE: {old_subject}",
        subject_tag=old_subject,
        mail_from="Old Owner <old.owner@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>",
        body_excerpt="방법 안내 부탁드립니다.",
        agent_verdict="classified_how_to_question",
        decision_reason="답장 신규 본문에서 조치 방법 안내를 요청함",
        received_at=base + 10,
    )
    current_message_id = sd.service_reply_message_add(
        domain=domain,
        direction="in",
        thread_id=current_id,
        message_id=f"{domain}-current-cycle-howto",
        subject=f"RE: {current_subject}",
        subject_tag=current_subject,
        mail_from="Current Owner <current.owner@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>",
        body_excerpt="조치 방법 안내 부탁드립니다.",
        agent_verdict="classified_how_to_question",
        decision_reason="답장 신규 본문에서 조치 방법 안내를 요청함",
        received_at=base + 20,
    )

    claimed = sd.service_report_thread_claim_how_to_guidance_next(
        domain,
        session_id=98765,
    )

    assert claimed is not None
    assert int(claimed["id"]) == current_id
    assert int(claimed["reply_message_id"]) == current_message_id
    assert int(claimed["reply_message_id"]) != old_message_id
    old_thread = get_thread(old_id)
    current_thread = get_thread(current_id)
    assert old_thread["claimed_by"] is None
    assert old_thread["claimed_at"] is None
    assert current_thread["claimed_by"] == 98765


@pytest.mark.parametrize("domain", ["github", "confluence"])
def test_service_how_to_guidance_attempt_cap_escalates_without_delivery(
    tmp_db,
    tmp_path,
    monkeypatch,
    domain: str,
) -> None:
    from service import state_domain as sd
    from service.agents import service_reply_guidance_agent as guidance

    async def fail_deliver(*args, **kwargs):
        raise AssertionError("attempt-capped guidance must not deliver")

    monkeypatch.setattr(guidance, "deliver", fail_deliver)
    base = 1_780_000_000.0
    if domain == "github":
        _, thread_id = sd.github_report_thread_upsert(
            finding_id=31,
            repo="org/capped-howto",
            severity="high",
            recipient="owner.capped@samsung.com",
            status="reported",
        )
        sd.github_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            notified_at=base,
            recipient="dssoc@samsung.com",
        )
        with sd.connect() as c:
            c.execute("UPDATE github_report_thread SET attempt_count=5 WHERE id=?", (thread_id,))
        subject = "[GitHub 보안취약점 조치요청](org/capped-howto)"
        subject_tag = subject
    else:
        _, thread_id = sd.confluence_report_thread_upsert(
            finding_id=32,
            space_key="CAP",
            severity="high",
            recipient="space.capped@samsung.com",
            status="reported",
        )
        sd.confluence_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            notified_at=base,
            recipient="dssoc@samsung.com",
        )
        with sd.connect() as c:
            c.execute("UPDATE confluence_report_thread SET attempt_count=5 WHERE id=?", (thread_id,))
        subject = "[Confluence 보안취약점 조치요청](CAP)"
        subject_tag = subject

    sd.service_reply_message_add(
        domain=domain,
        direction="in",
        thread_id=thread_id,
        message_id=f"{domain}-howto-capped",
        subject=f"RE: {subject}",
        subject_tag=subject_tag,
        mail_from="Owner Capped <owner.capped@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>",
        body_excerpt="조치 방법 안내 부탁드립니다.",
        agent_verdict="classified_how_to_question",
        decision_reason="답장 신규 본문에서 조치 방법 안내를 요청함",
        received_at=base + 60,
    )

    result = guidance.run_guidance_pass(
        domain,
        session_id=12345,
        max_threads=1,
        evidence_dir=tmp_path,
        charter_ref="SECOPS-TEST",
    )

    assert result["handled"] == 1
    assert result["escalated"] == 1
    assert result["sent"] == 0
    assert result["dry_run"] == 0
    assert result["errors"] == 0
    if domain == "github":
        thread = sd.github_report_thread_get(thread_id)
    else:
        thread = sd.confluence_report_thread_get(thread_id)
    assert thread["status"] == "escalated"
    assert thread["claimed_by"] is None
    assert thread["claimed_at"] is None
    assert thread["retry_after"] is None
    assert thread["last_reason"] == f"{domain} how-to guidance attempt cap exceeded"
    assert int(thread["attempt_count"] or 0) == 5
    messages = sd.service_reply_messages_for_thread(domain, thread_id)
    assert [m for m in messages if m["direction"] == "out"] == []
