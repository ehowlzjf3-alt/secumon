from __future__ import annotations

import asyncio
import hashlib
import json

from secu_agent.agent.tools.base import ToolContext


def test_owner_changed_reply_routes_to_hitl_without_llm(monkeypatch, tmp_db) -> None:
    from service import state_domain as state
    from service.agents import reply_verify_agent, runtime

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        status="reply_received",
    )
    state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="reply-owner-changed",
        subject="RE: [보안취약점 조치요청](10.0.0.5)",
        body_excerpt="담당자가 변경되었습니다. 새 담당자는 owner.two@samsung.com 입니다.",
        agent_verdict="pending",
    )

    async def fail_run_agent(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("HITL owner change must not invoke LLM runtime")

    monkeypatch.setattr(runtime, "run_agent", fail_run_agent)

    res = asyncio.run(
        reply_verify_agent._handle_thread(
            state.mail_thread_get(thread_id),
            charter_ref="SECOPS-2026-001",
        ),
    )

    thread = state.mail_thread_get(thread_id)
    decision = state.mail_reply_decision_latest(thread_id)
    messages = state.mail_messages_for_thread(thread_id)

    assert res["human_review"] is True
    assert res["decision"] == "owner_changed"
    assert thread["status"] == "owner_reassignment_review"
    assert thread["attempt_count"] == 0
    assert decision["decision"] == "owner_changed"
    assert decision["extracted_owner"]["email"] == "owner.two@samsung.com"
    assert messages[0]["agent_verdict"] == "hitl_owner_changed"


def test_business_exception_reply_routes_to_hitl_without_attempt(monkeypatch, tmp_db) -> None:
    from service import state_domain as state
    from service.agents import reply_verify_agent, runtime

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.6",
        subject_tag="[보안취약점 조치요청](10.0.0.6)",
        status="reply_received",
    )
    state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="reply-business-exception",
        subject="RE: [보안취약점 조치요청](10.0.0.6)",
        body_excerpt="이 공유는 업무 목적으로 필요해서 예외 승인이 필요합니다.",
        agent_verdict="pending",
    )

    async def fail_run_agent(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("business exception must route to HITL before LLM")

    monkeypatch.setattr(runtime, "run_agent", fail_run_agent)

    res = asyncio.run(
        reply_verify_agent._handle_thread(
            state.mail_thread_get(thread_id),
            charter_ref="SECOPS-2026-001",
        ),
    )

    thread = state.mail_thread_get(thread_id)
    assert res["decision"] == "business_exception_claim"
    assert thread["status"] == "exception_review"
    assert thread["attempt_count"] == 0


def test_human_review_heuristic_ignores_quoted_original_message() -> None:
    from service.agents import reply_verify_agent

    decision = reply_verify_agent._heuristic_human_review_decision({
        "subject": "RE: [보안취약점 조치요청](10.0.0.7)",
        "body_excerpt": (
            "안녕하세요.\n조치완료했습니다.\n"
            "--------- Original Message ---------\n"
            "담당자가 변경되었습니다. 업무 목적으로 필요합니다."
        ),
    })

    assert decision is None


def test_reverify_communication_unavailable_is_retry_not_closed(monkeypatch, tmp_db, tmp_path) -> None:
    from domains.smb.plugin.agent_types import smb as smb_mod
    from domains.smb.plugin.tools.smb_reverify_tool import SmbReverifyWalkTool
    from service import state_domain as state

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.82",
        subject_tag="[보안취약점 조치요청](10.0.0.82)",
        status="reply_received",
    )

    def offline(host):
        mm = smb_mod.SmbHostMultiMode(host=host)
        mm.login_errors = {
            "null": "login: Error NT_STATUS_IO_TIMEOUT",
            "guest": "login: Error NT_STATUS_IO_TIMEOUT",
            "auth": "login: Error NT_STATUS_IO_TIMEOUT",
        }
        return mm

    monkeypatch.setattr(smb_mod, "list_shares_modes", offline)

    res = asyncio.run(
        SmbReverifyWalkTool().execute(
            SmbReverifyWalkTool.input_model(
                host="10.0.0.82",
                share="C$",
                path_prefix="Users/example/Desktop",
                finding_id=10,
            ),
            ToolContext(evidence_dir=tmp_path),
        ),
    )

    payload = json.loads(res.content)
    thread = state.mail_thread_get(thread_id)
    results = state.mail_reverify_results_for_thread(thread_id)

    assert payload["verdict"] == "communication_unavailable"
    assert payload["retry_after"] == "8h"
    assert thread["status"] == "reply_received"
    assert thread["last_error_kind"] == "communication_unavailable"
    assert thread["retry_after"] is not None
    assert results[-1]["verdict"] == "communication_unavailable"


def test_reply_agent_keeps_reply_pending_when_reverify_communication_unavailable(
    monkeypatch,
    tmp_db,
) -> None:
    from service import state_domain as state
    from service.agents import reply_verify_agent

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.83",
        subject_tag="[보안취약점 조치요청](10.0.0.83)",
        status="reply_received",
    )
    inbound_id = state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="reply-communication-unavailable",
        subject="DSSOC POP3 visible mailbox smoke",
        body_excerpt="조치완료했습니다.",
        agent_verdict="pending",
    )

    async def fake_run_agent(**kwargs):  # noqa: ANN003
        del kwargs
        state.mail_message_set_verdict(
            inbound_id,
            verdict="classified_remediation_claim",
            thread_id=thread_id,
        )
        state.mail_reverify_result_add(
            thread_id=thread_id,
            finding_id=10,
            verdict="communication_unavailable",
            error="login: Error NT_STATUS_IO_TIMEOUT",
        )
        state.mail_thread_schedule_communication_retry(
            thread_id,
            reason="SMB communication unavailable",
        )
        return {
            "saw_terminal": False,
            "reason": "communication unavailable; retry later",
            "terminal_calls": [],
        }

    monkeypatch.setattr(reply_verify_agent.runtime, "run_agent", fake_run_agent)

    res = asyncio.run(
        reply_verify_agent._handle_thread(
            state.mail_thread_get(thread_id),
            charter_ref="SECOPS-2026-001",
        ),
    )

    thread = state.mail_thread_get(thread_id)
    inbound = state.mail_message_get_by_message_id("reply-communication-unavailable")
    messages = state.mail_messages_for_thread(thread_id)

    assert res["final_status"] == "reply_received"
    assert res["reply_delivery_required"] is False
    assert thread["status"] == "reply_received"
    assert thread["last_error_kind"] == "communication_unavailable"
    assert thread["retry_after"] is not None
    assert inbound["agent_verdict"] == "pending"
    assert [m for m in messages if m["direction"] == "out"] == []


def test_reply_agent_skips_pending_mail_before_latest_outbound(monkeypatch, tmp_db) -> None:
    from service import state_domain as state
    from service.agents import reply_verify_agent, runtime

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.9",
        subject_tag="[보안취약점 조치요청](10.0.0.9)",
        status="reply_received",
    )
    base = 1_780_000_000.0
    state.mail_message_add(
        direction="out",
        thread_id=thread_id,
        subject="RE: [보안취약점 조치요청](10.0.0.9)",
        subject_tag="[보안취약점 조치요청](10.0.0.9)",
        body_excerpt="<p>재검토 요청</p>",
        agent_verdict="sent",
        received_at=base,
    )
    state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="old-reply-before-request",
        subject="RE: [보안취약점 조치요청](10.0.0.9)",
        body_excerpt="업무 목적으로 필요합니다.",
        agent_verdict="pending",
        received_at=base - 30,
    )

    async def fail_run_agent(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("stale inbound must not invoke LLM runtime")

    monkeypatch.setattr(runtime, "run_agent", fail_run_agent)

    res = asyncio.run(
        reply_verify_agent._handle_thread(
            state.mail_thread_get(thread_id),
            charter_ref="SECOPS-2026-001",
        ),
    )

    thread = state.mail_thread_get(thread_id)
    messages = state.mail_messages_for_thread(thread_id)
    stale = next(m for m in messages if m["direction"] == "in")
    assert res["skipped"] is True
    assert res["final_status"] == "awaiting_reply"
    assert thread["status"] == "awaiting_reply"
    assert stale["agent_verdict"] == "stale_before_latest_outbound"


def test_reply_agent_marks_inbound_handled_when_attempt_cap_escalates(
    monkeypatch,
    tmp_db,
) -> None:
    from service import state_domain as state
    from service.agents import reply_verify_agent, runtime

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.18",
        subject_tag="[보안취약점 조치요청](10.0.0.18)",
        status="reply_received",
    )
    with state.connect() as c:
        c.execute("UPDATE mail_thread SET attempt_count=5 WHERE id=?", (thread_id,))
    inbound_id = state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="reply-attempt-cap",
        subject="DSSOC POP3 visible mailbox smoke",
        body_excerpt="조치완료했습니다.",
        agent_verdict="pending",
    )

    async def fail_run_agent(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("attempt-cap thread must not invoke LLM runtime")

    monkeypatch.setattr(runtime, "run_agent", fail_run_agent)

    res = asyncio.run(
        reply_verify_agent._handle_thread(
            state.mail_thread_get(thread_id),
            charter_ref="SECOPS-2026-001",
        ),
    )

    thread = state.mail_thread_get(thread_id)
    messages = state.mail_messages_for_thread(thread_id)
    inbound = next(m for m in messages if m["id"] == inbound_id)

    assert res["escalated"] is True
    assert thread["status"] == "escalated"
    assert thread["last_reason"] == "attempt cap 초과"
    assert inbound["agent_verdict"] == "handled_escalated"
    assert [m for m in messages if m["direction"] == "out"] == []


def test_reply_agent_records_reply_mail_and_waits_after_still_open(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.agents import reply_verify_agent

    monkeypatch.delenv("SMB_REMEDIATION_MAIL_MODE", raising=False)
    monkeypatch.delenv("SMB_REMEDIATION_DSSOC_RECIPIENT", raising=False)
    monkeypatch.delenv("SA_DSSOC_MAIL_RECIPIENT", raising=False)

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.15",
        subject_tag="[보안취약점 조치요청](10.0.0.15)",
        status="reply_received",
    )
    inbound_id = state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="reply-still-open",
        subject="RE: [보안취약점 조치요청](10.0.0.15)",
        mail_from="Owner One <owner.one@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>",
        body_excerpt="조치했습니다. 확인 부탁드립니다.",
        agent_verdict="pending",
    )

    async def fake_run_agent(**kwargs):  # noqa: ANN003
        del kwargs
        state.mail_message_set_verdict(
            inbound_id,
            verdict="classified_remediation_claim",
            thread_id=thread_id,
        )
        state.mail_reverify_result_add(
            thread_id=thread_id,
            finding_id=10,
            verdict="still_open",
            share="C$",
            path_prefix="Users/A",
            access={"guest_read": True},
            files_visible=3,
        )
        return {
            "saw_terminal": True,
            "reason": "sent reply",
            "terminal_calls": [{
                "name": "deliver",
                "input": {
                    "recipients": ["owner.one@samsung.com"],
                    "subject": "RE: [보안취약점 조치요청](10.0.0.15)",
                    "body": "<p>아직 열린 공유가 확인되었습니다.</p>",
                },
                "result_content": "[deliver:knox_mail] 발송 완료",
            }],
        }

    monkeypatch.setattr(reply_verify_agent.runtime, "run_agent", fake_run_agent)

    res = asyncio.run(
        reply_verify_agent._handle_thread(
            state.mail_thread_get(thread_id),
            charter_ref="SECOPS-2026-001",
        ),
    )

    thread = state.mail_thread_get(thread_id)
    messages = state.mail_messages_for_thread(thread_id)
    inbound = next(m for m in messages if m["id"] == inbound_id)
    outbound = next(m for m in messages if m["direction"] == "out")

    assert res["delivery_mode"] == "sent"
    assert res["reply_delivery_required"] is True
    assert res["final_status"] == "awaiting_reply"
    assert thread["status"] == "awaiting_reply"
    assert thread["attempt_count"] == 1
    assert inbound["agent_verdict"] == "handled_awaiting_reply"
    assert outbound["mail_to"] == "owner.one@samsung.com"
    assert outbound["mail_from"] == "dssoc"
    assert outbound["agent_verdict"] == "sent"
    assert outbound["subject"] == "RE: [보안취약점 조치요청](10.0.0.15)"
    assert "아직 열린 공유" in outbound["body_excerpt"]


def test_reply_agent_delivers_built_reply_terminal_fallback(tmp_db, monkeypatch, tmp_path) -> None:
    from service import state_domain as state
    from service.agents import reply_verify_agent
    from secu_agent.agent import delivery as delivery_mod
    from secu_agent.agent.delivery import DeliveryResult

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.17",
        subject_tag="[보안취약점 조치요청](10.0.0.17)",
        status="reply_received",
    )
    inbound_id = state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="reply-build-only",
        subject="DSSOC POP3 alternate smoke",
        mail_from="Owner One <owner.one@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>",
        body_excerpt="조치완료했습니다.",
        agent_verdict="pending",
    )
    body = "<p>아직 열린 공유가 확인되었습니다.</p>"
    built = {
        "kind": "smb_build_reply",
        "reply_kind": "not_fixed",
        "subject": "RE: DSSOC POP3 alternate smoke",
        "body": body,
        "recipients": ["owner.one@samsung.com"],
        "cc": [],
        "deliver_hint": {
            "action": "send",
            "sink_id": "knox_mail",
            "recipients": ["owner.one@samsung.com"],
            "cc": [],
            "subject": "RE: DSSOC POP3 alternate smoke",
            "metadata": {
                "smb_reply_built": True,
                "smb_reply_subject": "RE: DSSOC POP3 alternate smoke",
                "smb_reply_body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
                "smb_reply_recipients": ["owner.one@samsung.com"],
                "smb_reply_cc": [],
            },
        },
    }

    async def fake_run_agent(**kwargs):  # noqa: ANN003
        assert "smb_build_reply" in kwargs["terminal_tools"]
        state.mail_reverify_result_add(
            thread_id=thread_id,
            finding_id=10,
            verdict="still_open",
            share="C$",
            path_prefix="Users/A",
            access={"guest_read": True},
            files_visible=3,
        )
        return {
            "saw_terminal": True,
            "reason": "terminal_tool:smb_build_reply",
            "evidence_dir": str(tmp_path),
            "terminal_calls": [{
                "name": "smb_build_reply",
                "input": {
                    "thread_id": thread_id,
                    "reply_kind": "not_fixed",
                },
                "result_content": json.dumps(built, ensure_ascii=False),
            }],
        }

    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["sink_id"] = sink_id
        captured["payload"] = payload
        captured["evidence_dir"] = evidence_dir
        captured["charter_ref"] = charter_ref
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="ok")

    monkeypatch.setattr(reply_verify_agent.runtime, "run_agent", fake_run_agent)
    monkeypatch.setattr(delivery_mod, "deliver", fake_deliver)

    res = asyncio.run(
        reply_verify_agent._handle_thread(
            state.mail_thread_get(thread_id),
            charter_ref="SECOPS-2026-001",
        ),
    )

    thread = state.mail_thread_get(thread_id)
    messages = state.mail_messages_for_thread(thread_id)
    inbound = next(m for m in messages if m["id"] == inbound_id)
    outbound = next(m for m in messages if m["direction"] == "out")

    assert res["delivery_mode"] == "sent"
    assert res["final_status"] == "awaiting_reply"
    assert thread["status"] == "awaiting_reply"
    assert inbound["agent_verdict"] == "handled_awaiting_reply"
    assert captured["sink_id"] == "knox_mail"
    assert captured["payload"].recipients == ("owner.one@samsung.com",)
    assert captured["payload"].subject == "RE: DSSOC POP3 alternate smoke"
    assert captured["charter_ref"] == "SECOPS-2026-001"
    assert outbound["subject"] == "RE: DSSOC POP3 alternate smoke"
    assert outbound["mail_to"] == "owner.one@samsung.com"
    assert "아직 열린 공유" in outbound["body_excerpt"]


def test_reply_agent_keeps_thread_open_when_reply_delivery_dry_run(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.agents import reply_verify_agent

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.16",
        subject_tag="[보안취약점 조치요청](10.0.0.16)",
        status="reply_received",
    )
    inbound_id = state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="reply-dry-run-blocked",
        subject="RE: [보안취약점 조치요청](10.0.0.16)",
        body_excerpt="조치했습니다.",
        agent_verdict="pending",
    )

    async def fake_run_agent(**kwargs):  # noqa: ANN003
        del kwargs
        state.mail_reverify_result_add(
            thread_id=thread_id,
            finding_id=10,
            verdict="still_open",
            share="C$",
            path_prefix="Users/A",
            access={"guest_read": True},
            files_visible=3,
        )
        return {
            "saw_terminal": True,
            "reason": "dry-run reply",
            "terminal_calls": [{
                "name": "deliver",
                "input": {
                    "recipients": ["dssoc@samsung.com"],
                    "subject": "RE: [보안취약점 조치요청](10.0.0.16)",
                    "body": "<p>차단된 회신</p>",
                },
                "result_content": "[deliver:knox_mail] dry-run - 실발송 안 됨",
            }],
        }

    monkeypatch.setattr(reply_verify_agent.runtime, "run_agent", fake_run_agent)

    res = asyncio.run(
        reply_verify_agent._handle_thread(
            state.mail_thread_get(thread_id),
            charter_ref="SECOPS-2026-001",
        ),
    )

    thread = state.mail_thread_get(thread_id)
    messages = state.mail_messages_for_thread(thread_id)
    inbound = next(m for m in messages if m["id"] == inbound_id)

    assert res["delivery_mode"] == "dry_run"
    assert res["reply_delivery_required"] is True
    assert res["final_status"] == "reply_received"
    assert thread["status"] == "reply_received"
    assert thread["attempt_count"] == 0
    assert "dry-run" in thread["last_reason"]
    assert inbound["agent_verdict"] == "pending"
    assert [m for m in messages if m["direction"] == "out"] == []


def test_next_pending_reply_uses_latest_mail_after_latest_outbound(tmp_db) -> None:
    from service import state_domain as state

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.10",
        subject_tag="[보안취약점 조치요청](10.0.0.10)",
        status="reply_received",
    )
    base = 1_780_000_000.0
    state.mail_message_add(
        direction="out",
        thread_id=thread_id,
        subject="[보안취약점 조치요청](10.0.0.10)",
        agent_verdict="sent",
        received_at=base,
    )
    state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="first-after-outbound",
        subject="RE: [보안취약점 조치요청](10.0.0.10)",
        body_excerpt="첫 번째 답장",
        agent_verdict="pending",
        received_at=base + 10,
    )
    latest_id = state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="second-after-outbound",
        subject="RE: [보안취약점 조치요청](10.0.0.10)",
        body_excerpt="두 번째 답장",
        agent_verdict="pending",
        received_at=base + 20,
    )

    msg = state.mail_message_next_pending_reply(thread_id)

    assert msg["id"] == latest_id
    assert msg["message_id"] == "second-after-outbound"


def test_partial_reverify_does_not_resolve_entire_thread(tmp_db) -> None:
    from service import state_domain as state
    from service.agents import reply_verify_agent

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.7",
        subject_tag="[보안취약점 조치요청](10.0.0.7)",
        status="reply_received",
    )
    state.mail_thread_upsert(
        finding_id=11,
        host="10.0.0.7",
        subject_tag="[보안취약점 조치요청](10.0.0.7)",
        status="reply_received",
    )
    state.mail_reverify_result_add(
        thread_id=thread_id,
        finding_id=10,
        verdict="now_closed",
        share="C$",
        path_prefix="Users/A",
        access={"auth_read": False},
        files_visible=0,
    )

    proposed, reason = reply_verify_agent._reverify_final_status(
        state.mail_thread_get(thread_id),
    )

    assert proposed == "partially_remediated"
    assert "missing reverify results" in reason


def test_reply_build_uses_dssoc_address_by_default(monkeypatch, tmp_path) -> None:
    from domains.smb.plugin.tools.smb_reply_tools import (
        SmbBuildReplyInput,
        SmbBuildReplyTool,
    )
    from secu_agent.agent.tools.base import ToolContext, ToolSuccess

    monkeypatch.delenv("SMB_REMEDIATION_MAIL_MODE", raising=False)
    monkeypatch.delenv("SMB_REMEDIATION_DSSOC_RECIPIENT", raising=False)
    monkeypatch.delenv("SA_DSSOC_MAIL_RECIPIENT", raising=False)

    res = asyncio.run(
        SmbBuildReplyTool().execute(
            SmbBuildReplyInput(
                host="10.0.0.5",
                subject_tag="[보안취약점 조치요청](10.0.0.5)",
                reply_kind="confirmed",
            ),
            ToolContext(evidence_dir=tmp_path),
        ),
    )

    assert isinstance(res, ToolSuccess)
    assert '"recipient": "dssoc@samsung.com"' in res.content
    assert '"recipients": ["dssoc@samsung.com"]' in res.content


def test_reply_subject_increments_existing_re_prefix() -> None:
    from service.services import remediation_mail

    assert remediation_mail.reply_subject(
        "[보안취약점 조치요청](10.0.0.6)",
        original_subject="RE: [보안취약점 조치요청](10.0.0.6)",
    ) == "RE:(2) [보안취약점 조치요청](10.0.0.6)"
    assert remediation_mail.reply_subject(
        "[보안취약점 조치요청](10.0.0.6)",
        original_subject="RE:(2) [보안취약점 조치요청](10.0.0.6)",
    ) == "RE:(3) [보안취약점 조치요청](10.0.0.6)"
    assert remediation_mail.reply_subject(
        "[보안취약점 조치요청](10.0.0.6)",
        original_subject="FW: RE:(3) [보안취약점 조치요청](10.0.0.6)",
    ) == "RE:(4) [보안취약점 조치요청](10.0.0.6)"
    assert remediation_mail.reply_subject(
        "[보안취약점 조치요청](10.0.0.6)",
        original_subject="RE: FW: RE:(3) [보안취약점 조치요청](10.0.0.6)",
    ) == "RE:(4) [보안취약점 조치요청](10.0.0.6)"
    assert remediation_mail.reply_subject(
        "[보안취약점 조치요청](10.0.0.6)",
        original_subject="FW: [보안취약점 조치요청](10.0.0.6)",
    ) == "RE: [보안취약점 조치요청](10.0.0.6)"


def test_delivery_mode_requires_actual_deliver_call() -> None:
    from service.agents import reply_verify_agent

    assert reply_verify_agent._delivery_mode({
        "saw_terminal": True,
        "terminal_calls": [{
            "name": "smb_build_reply",
            "result_content": "{}",
        }],
    }) is None


def test_built_reply_delivery_input_falls_back_to_evidence_file(tmp_path) -> None:
    from service.agents import reply_verify_agent

    body = "<p>아직 열려 있습니다.</p>"
    payload = {
        "body": body,
        "deliver_hint": {
            "sink_id": "knox_mail",
            "recipients": ["owner.one@samsung.com"],
            "cc": [],
            "subject": "RE: smoke",
            "metadata": {
                "smb_reply_built": True,
                "smb_reply_subject": "RE: smoke",
                "smb_reply_body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
                "smb_reply_recipients": ["owner.one@samsung.com"],
                "smb_reply_cc": [],
            },
        },
    }
    (tmp_path / "20260701_130000_smb_build_reply_test.json").write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )

    delivery = reply_verify_agent._built_reply_delivery_input({
        "evidence_dir": str(tmp_path),
        "terminal_calls": [{
            "name": "smb_build_reply",
            "result_content": "",
        }],
    })

    assert delivery["sink_id"] == "knox_mail"
    assert delivery["recipients"] == ["owner.one@samsung.com"]
    assert delivery["subject"] == "RE: smoke"
    assert delivery["body"] == body


def test_original_message_sanitizer_keeps_image_data_uri_only() -> None:
    from service.services import remediation_mail

    body = remediation_mail._sanitize_original_html(
        "<p style=\"font-weight:bold;color:#111\">safe</p>"
        "<p style=\"background:url(javascript:alert(1))\">bad style</p>"
        "<span style=\"width:expression(alert(1))\">old ie</span>"
        "<img src=\"data:image/png;base64,AAAA\"/>"
        "<img src=\"data:text/html;base64,PHNjcmlwdA==\"/>"
        "<a href=\"data:text/html;base64,PHNjcmlwdA==\">x</a>"
        "<img src=\"javascript:alert(1)\"/>"
    )

    assert "font-weight:bold" in body
    assert "data:image/png;base64,AAAA" in body
    assert "data:text/html" not in body
    assert "javascript:" not in body
    assert "expression(" not in body


def test_reply_build_uses_inbound_reply_targets_subject_and_quote(tmp_db, tmp_path) -> None:
    from domains.smb.plugin.tools.smb_reply_tools import (
        SmbBuildReplyInput,
        SmbBuildReplyTool,
    )
    from service import state_domain as state
    from secu_agent.agent.tools.base import ToolContext, ToolSuccess

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.6",
        subject_tag="[보안취약점 조치요청](10.0.0.6)",
        status="reverifying",
    )
    state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="reply-targets",
        in_reply_to="<root@samsung.com>",
        references_header="<root@samsung.com> <reply@samsung.com>",
        root_message_id="root-cms-id",
        subject="RE:(2) [보안취약점 조치요청](10.0.0.6) 공유폴더 접근권한 관리",
        mail_from="Owner One <owner.one@samsung.com>",
        mail_to="DS보안관제 <dssoc@samsung.com>, Watcher <watcher@samsung.com>",
        mail_cc="Team Mate <team.mate@samsung.com>",
        body_excerpt="조치완료했습니다.\n문의: owner.one@samsung.com / dssoc@samsung.com",
        body_html=(
            "<!doctype html><html><body>"
            "<p>조치완료했습니다.</p>"
            "<table><tr><td>owner.one@samsung.com</td></tr></table>"
            "<script>alert(1)</script>"
            "</body></html>"
        ),
        agent_verdict="pending",
    )
    # ★ 2026-08-31 부터 `confirmed` 는 **상태를 단언하는 회신**이라 재검증 기록이
    #   필요하다(`_shared/reply_guard`). 실제 순서도 재검증 → 회신이다.
    state.mail_reverify_result_add(
        thread_id=thread_id, finding_id=10, share="공유", verdict="now_closed",
    )

    res = asyncio.run(
        SmbBuildReplyTool().execute(
            SmbBuildReplyInput(
                host="10.0.0.6",
                subject_tag="[보안취약점 조치요청](10.0.0.6)",
                reply_kind="confirmed",
                thread_id=thread_id,
            ),
            ToolContext(evidence_dir=tmp_path),
        ),
    )

    assert isinstance(res, ToolSuccess)
    data = json.loads(res.content)
    assert data["subject"] == "RE:(3) [보안취약점 조치요청](10.0.0.6) 공유폴더 접근권한 관리"
    assert data["recipients"] == ["owner.one@samsung.com"]
    assert data["cc"] == ["watcher@samsung.com", "team.mate@samsung.com"]
    assert data["deliver_hint"]["metadata"]["in_reply_to"] == "<root@samsung.com>"
    assert data["deliver_hint"]["metadata"]["root_message_id"] == "root-cms-id"
    assert set(data["deliver_hint"]["metadata"]["delivery_allowed_pii_values"]) == {
        "owner.one@samsung.com",
        "dssoc@samsung.com",
        "watcher@samsung.com",
        "team.mate@samsung.com",
    }
    assert "--------- Original Message ---------" in data["body"]
    assert "조치완료했습니다." in data["body"]
    assert "<p>조치완료했습니다.</p>" in data["body"]
    assert "<table>" in data["body"]
    assert "&lt;table" not in data["body"]
    assert "<script" not in data["body"]
    assert "Owner One &lt;owner.one@samsung.com&gt;" in data["body"]
    assert "owner.one@samsung.com" in data["body"]
    assert "dssoc@samsung.com" in data["body"]


def test_not_fixed_reply_lists_open_shares_from_reverify_results(tmp_db, tmp_path) -> None:
    from domains.smb.plugin.tools.smb_reply_tools import (
        SmbBuildReplyInput,
        SmbBuildReplyTool,
    )
    from service import state_domain as state
    from secu_agent.agent.tools.base import ToolContext, ToolSuccess

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.8",
        subject_tag="[보안취약점 조치요청](10.0.0.8)",
        status="reverifying",
    )
    state.mail_reverify_result_add(
        thread_id=thread_id,
        finding_id=10,
        verdict="still_open",
        share="C$",
        path_prefix="Users/A",
        access={"guest_read": True, "auth_read": True, "any_write": False},
        files_visible=12,
    )

    res = asyncio.run(
        SmbBuildReplyTool().execute(
            SmbBuildReplyInput(
                host="10.0.0.8",
                subject_tag="[보안취약점 조치요청](10.0.0.8)",
                reply_kind="not_fixed",
                thread_id=thread_id,
                detail="finding_id=10 still_open",
            ),
            ToolContext(evidence_dir=tmp_path),
        ),
    )

    assert isinstance(res, ToolSuccess)
    body = json.loads(res.content)["body"]
    assert r"\\10.0.0.8\C$" in body
    assert "Guest 읽기" in body
    assert "AUTH 읽기" in body
    assert "Users/A" in body
    assert "파일 12건 표시" in body
    assert "finding_id=10" not in body


def test_reply_deliver_preserves_reply_recipients(monkeypatch, tmp_path) -> None:
    from domains.smb.plugin.tools.smb_reply_tools import SmbReplyDeliverTool
    from secu_agent.agent.delivery import DeliveryResult
    from secu_agent.agent.tools import deliver_tool
    from secu_agent.agent.tools.base import ToolContext, ToolSuccess
    from secu_agent.agent.tools.deliver_tool import DeliverInput

    monkeypatch.delenv("SMB_REMEDIATION_MAIL_MODE", raising=False)
    monkeypatch.delenv("SMB_REMEDIATION_DSSOC_RECIPIENT", raising=False)
    monkeypatch.delenv("SA_DSSOC_MAIL_RECIPIENT", raising=False)

    captured = {}

    async def fake_deliver(sink_id, payload, *, evidence_dir, charter_ref=""):
        captured["sink_id"] = sink_id
        captured["payload"] = payload
        captured["evidence_dir"] = evidence_dir
        captured["charter_ref"] = charter_ref
        return DeliveryResult(sink_id=sink_id, mode="sent", detail="ok")

    monkeypatch.setattr(deliver_tool, "deliver", fake_deliver)

    subject = "RE: [보안취약점 조치요청](10.0.0.5)"
    body = "<p>확인했습니다.</p>"
    recipients = ["owner.one@samsung.com"]
    cc = ["other@samsung.com"]
    res = asyncio.run(
        SmbReplyDeliverTool().execute(
            DeliverInput(
                action="send",
                sink_id="knox_mail",
                recipients=recipients,
                cc=cc,
                subject=subject,
                body=body,
                metadata={
                    "smb_reply_built": True,
                    "smb_reply_subject": subject,
                    "smb_reply_body_sha256": hashlib.sha256(
                        body.encode("utf-8")
                    ).hexdigest(),
                    "smb_reply_recipients": recipients,
                    "smb_reply_cc": cc,
                },
            ),
            ToolContext(
                evidence_dir=tmp_path,
                metadata={"charter_ref": "SECOPS-2026-001"},
            ),
        ),
    )

    assert isinstance(res, ToolSuccess)
    payload = captured["payload"]
    assert payload.recipients == ("owner.one@samsung.com",)
    assert payload.cc == ("other@samsung.com",)
    assert payload.metadata["requested_recipients"] == ["owner.one@samsung.com"]
    assert payload.metadata["requested_cc"] == ["other@samsung.com"]
    assert payload.metadata["smb_reply_delivery_policy"] == "reply_to_inbound"


def test_reply_deliver_rejects_manual_payload_without_build(tmp_path) -> None:
    from domains.smb.plugin.tools.smb_reply_tools import SmbReplyDeliverTool
    from secu_agent.agent.tools.base import ToolContext, ToolError
    from secu_agent.agent.tools.deliver_tool import DeliverInput

    res = asyncio.run(
        SmbReplyDeliverTool().execute(
            DeliverInput(
                action="send",
                sink_id="knox_mail",
                recipients=["owner.one@samsung.com"],
                subject="RE: FW: RE:(3) [보안취약점 조치요청](10.0.0.5)",
                body="<p>수동 작성 답장</p>",
            ),
            ToolContext(evidence_dir=tmp_path),
        ),
    )

    assert isinstance(res, ToolError)
    assert res.kind == "validation"
    assert "smb_build_reply" in res.message
