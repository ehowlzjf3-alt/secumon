from __future__ import annotations

import pytest

import asyncio

from domains.smb.plugin.tools.smb_report_mail_tools import report_mail_delivery_targets
from service.agents import report_mail_agent



@pytest.fixture(autouse=True)
def _initial_gate_open(monkeypatch):
    """이 파일은 **수신처/본문 정책**을 검증한다 — 최초 발송 게이트는 관심사가 다르다.

    게이트가 닫힌 채로 두면 모든 케이스가 `initial_closed`(수신처 없음)로 뭉개져
    정작 검증하려던 정책을 못 본다. 게이트 자체는
    `service/tests/test_initial_send_gate.py` 가 따로 고정한다(2026-08-31).
    """
    from service.services.owner_recipients import INITIAL_AUTOSEND_ENV

    monkeypatch.setenv(INITIAL_AUTOSEND_ENV, "1")

def test_report_mail_delivery_targets_default_is_dry_run(monkeypatch) -> None:
    """모드를 안 정하면 DSSOC 로만 — 단, **자율발송이 꺼져 있을 때에 한해서다.**

    ⚠️ 라벨이 `dssoc_only` → `dry_run` 으로 바뀌었다. 수신처는 그대로이고 뜻이 분명해졌다 —
    예전 이름은 "DSSOC 에게만 보내는 정책" 처럼 읽혔는데, 실제 조건은 "어차피 안 나간다" 다.
    자율발송이 켜진 채로 모드를 안 정하면 이제 **예외**다(정책: DSSOC 로만 보내는 실발송은 없다).
    """
    monkeypatch.delenv("SMB_REMEDIATION_MAIL_MODE", raising=False)
    monkeypatch.delenv("SMB_REMEDIATION_DSSOC_RECIPIENT", raising=False)
    monkeypatch.delenv("SA_DSSOC_MAIL_RECIPIENT", raising=False)

    assert report_mail_delivery_targets(["owner.one@samsung.com"]) == {
        "mode": "dry_run",
        "recipients": ["dssoc@samsung.com"],
        "cc": [],
    }


def test_report_mail_delivery_targets_normal_owner_with_dssoc_cc(monkeypatch) -> None:
    monkeypatch.setenv("SMB_REMEDIATION_MAIL_MODE", "normal")
    monkeypatch.setenv("SMB_REMEDIATION_DSSOC_RECIPIENT", "dssoc")

    assert report_mail_delivery_targets(["owner.one@samsung.com"]) == {
        "mode": "normal",
        "recipients": ["owner.one@samsung.com"],
        "cc": ["dssoc"],
    }


def test_sent_mail_fields_use_deliver_terminal_input(monkeypatch) -> None:
    monkeypatch.delenv("SMB_REMEDIATION_MAIL_MODE", raising=False)
    monkeypatch.delenv("SMB_REMEDIATION_DSSOC_RECIPIENT", raising=False)
    monkeypatch.delenv("SA_DSSOC_MAIL_RECIPIENT", raising=False)
    thread = {
        "host": "10.0.0.5",
        "finding_id": 10,
        "recipient": None,
        "subject_tag": "[보안취약점 조치요청](10.0.0.5)",
    }
    result = {
        "terminal_calls": [{
            "name": "deliver",
            "input": {
                "recipients": ["owner.one@samsung.com"],
                "subject": "[보안취약점 조치요청](10.0.0.5) 공유폴더 접근권한 관리",
                "body": (
                    "<html><body><p>Owner One님</p>"
                    "<p>공유 폴더 권한을 축소해 주세요.</p></body></html>"
                ),
            },
        }],
    }

    fields = report_mail_agent._sent_mail_fields(thread, result)

    assert fields["mail_to"] == "dssoc@samsung.com"
    assert fields["subject"] == "[보안취약점 조치요청](10.0.0.5) 공유폴더 접근권한 관리"
    assert "Owner One님" in fields["body_excerpt"]
    assert "공유 폴더 권한을 축소해 주세요." in fields["body_excerpt"]
    assert "<p>" in fields["body_excerpt"]


def test_sent_mail_fields_normal_mode_records_owner_to(monkeypatch) -> None:
    monkeypatch.setenv("SMB_REMEDIATION_MAIL_MODE", "normal")
    monkeypatch.setenv("SMB_REMEDIATION_DSSOC_RECIPIENT", "dssoc")
    thread = {
        "host": "10.0.0.5",
        "finding_id": 10,
        "recipient": None,
        "subject_tag": "[보안취약점 조치요청](10.0.0.5)",
    }
    result = {
        "terminal_calls": [{
            "name": "deliver",
            "input": {
                "recipients": ["owner.one@samsung.com"],
                "subject": "SMB 조치요청",
                "body": "본문",
            },
        }],
    }

    fields = report_mail_agent._sent_mail_fields(thread, result)

    assert fields["mail_to"] == "owner.one@samsung.com"


def test_sent_mail_fields_join_multiple_recipients(monkeypatch) -> None:
    monkeypatch.delenv("SMB_REMEDIATION_MAIL_MODE", raising=False)
    monkeypatch.delenv("SMB_REMEDIATION_DSSOC_RECIPIENT", raising=False)
    monkeypatch.delenv("SA_DSSOC_MAIL_RECIPIENT", raising=False)
    thread = {
        "host": "10.0.0.5",
        "finding_id": 10,
        "recipient": "fallback@samsung.com",
        "subject_tag": "[보안취약점 조치요청](10.0.0.5)",
    }
    result = {
        "terminal_calls": [{
            "name": "deliver",
            "input": {
                "recipients": ["owner.one@samsung.com", "reviewer@samsung.com"],
                "subject": "SMB 조치요청",
                "body": "본문",
            },
        }],
    }

    fields = report_mail_agent._sent_mail_fields(thread, result)

    assert fields["mail_to"] == "dssoc@samsung.com"
    assert fields["subject"] == "SMB 조치요청"
    assert fields["body_excerpt"] == "본문"


def test_mail_body_for_thread_preserves_html() -> None:
    body = "<style>.x{}</style><p>A&nbsp;B</p>"

    assert report_mail_agent._mail_body_for_thread(body) == body


def test_handle_thread_records_sent_mail_body(tmp_db, monkeypatch) -> None:
    from service import state_domain as state

    monkeypatch.delenv("SMB_REMEDIATION_MAIL_MODE", raising=False)
    monkeypatch.delenv("SMB_REMEDIATION_DSSOC_RECIPIENT", raising=False)
    monkeypatch.delenv("SA_DSSOC_MAIL_RECIPIENT", raising=False)
    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="high",
        status="reported",
    )
    thread = state.mail_thread_get(thread_id)
    assert thread is not None

    async def fake_run_agent(**kwargs):
        del kwargs
        return {
            "saw_terminal": True,
            "reason": "done",
            "terminal_calls": [{
                "name": "deliver",
                "input": {
                    "recipients": ["owner.one@samsung.com"],
                    "subject": "SMB 조치요청",
                    "body": "<p>발송한 조치요청 본문</p>",
                },
            }],
        }

    monkeypatch.setattr(report_mail_agent.runtime, "run_agent", fake_run_agent)

    result = asyncio.run(report_mail_agent._handle_thread(thread, charter_ref="test"))

    assert result["saw_terminal"] is True
    saved_thread = state.mail_thread_get(thread_id)
    assert saved_thread is not None
    assert saved_thread["status"] == "awaiting_reply"
    assert saved_thread["recipient"] == "dssoc@samsung.com"
    messages = state.mail_messages_for_thread(thread_id)
    assert len(messages) == 1
    assert messages[0]["direction"] == "out"
    assert messages[0]["mail_to"] == "dssoc@samsung.com"
    assert messages[0]["subject"] == "SMB 조치요청"
    assert messages[0]["body_excerpt"] == "<p>발송한 조치요청 본문</p>"


def test_handle_thread_keeps_dry_run_delivery_out_of_awaiting_reply(tmp_db, monkeypatch) -> None:
    from domains.smb.application.contracts import MAIL_SESSION_ID
    from service import state_domain as state

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="high",
        status="reported",
    )
    thread = state.mail_thread_get(thread_id)
    assert thread is not None

    async def fake_run_agent(**kwargs):
        del kwargs
        return {
            "saw_terminal": True,
            "reason": "done",
            "terminal_calls": [{
                "name": "deliver",
                "input": {
                    "recipients": ["dssoc@samsung.com"],
                    "subject": "[보안취약점 조치요청](10.0.0.5) 공유폴더 접근권한 관리",
                    "body": "<p>차단된 본문</p>",
                },
                "result_content": "[deliver:knox_mail] dry-run — 실발송 안 됨",
            }],
        }

    monkeypatch.setattr(report_mail_agent.runtime, "run_agent", fake_run_agent)

    result = asyncio.run(report_mail_agent._handle_thread(thread, charter_ref="test"))

    assert result["delivery_mode"] == "dry_run"
    saved_thread = state.mail_thread_get(thread_id)
    assert saved_thread is not None
    assert saved_thread["status"] == "reported"
    assert saved_thread["claimed_by"] == MAIL_SESSION_ID
    assert saved_thread["attempt_count"] == 1
    assert "dry-run" in saved_thread["last_reason"]

    # ★ 2026-08-27 부터 **안 나간 본문도 남긴다.** 예전 계약은 `== []` 였는데, 그래서
    #   운영자가 "무엇을 보내려 했는지" 를 볼 방법이 아예 없었다(mail_message 0행).
    #   중요한 건 기록 유무가 아니라 **발송으로 기록되지 않는 것**이다.
    msgs = state.mail_messages_for_thread(thread_id)
    assert len(msgs) == 1, msgs
    assert msgs[0]["agent_verdict"] == "draft:dry_run", msgs[0]["agent_verdict"]
    assert msgs[0]["direction"] == "out"
    assert "차단된 본문" in (msgs[0]["body_excerpt"] or ""), "초안 본문이 비어 있다"
    # 발송으로 오인될 여지를 남기지 않는다.
    assert not any(m["agent_verdict"] == "sent" for m in msgs)


def test_draft_is_replaced_not_stacked_on_retry(tmp_db, monkeypatch) -> None:
    """★ 초안은 재시도마다 갈아끼운다 — 쌓으면 '발송 이력' 이 시도 횟수로 부풀고,
    화면이 최신 초안 하나를 고를 근거가 없어진다. `sent` 는 반대로 절대 안 지운다."""
    from service import state_domain as state

    _, tid = state.mail_thread_upsert(
        finding_id=77,
        host="10.0.0.7",
        subject_tag="[보안취약점 조치요청](10.0.0.7)",
        severity="high",
        status="reported",
    )
    thread = {"id": tid, "subject_tag": "[보안취약점 조치요청](10.0.0.7)"}
    fields = {"subject": "제목", "mail_to": "dssoc@samsung.com",
              "body_excerpt": "<p>초안</p>"}

    report_mail_agent._record_outbound(thread, fields, verdict="draft:dry_run")
    report_mail_agent._record_outbound(thread, fields, verdict="draft:dry_run")
    msgs = state.mail_messages_for_thread(tid)
    assert len(msgs) == 1, f"초안이 쌓였다: {len(msgs)}건"

    # 실제 발송이 뒤따르면 그건 남는다.
    report_mail_agent._record_outbound(thread, fields, verdict="sent")
    verdicts = [m["agent_verdict"] for m in state.mail_messages_for_thread(tid)]
    assert verdicts.count("sent") == 1, verdicts

    # 이후 초안이 또 만들어져도 발송 기록은 살아 있어야 한다.
    report_mail_agent._record_outbound(thread, fields, verdict="draft:unknown")
    verdicts = [m["agent_verdict"] for m in state.mail_messages_for_thread(tid)]
    assert verdicts.count("sent") == 1, f"발송 기록이 지워졌다: {verdicts}"
    assert verdicts.count("draft:unknown") == 1, verdicts


def test_sent_mail_fields_fallback_subject_adds_management_suffix(monkeypatch) -> None:
    monkeypatch.delenv("SMB_REMEDIATION_MAIL_MODE", raising=False)
    thread = {
        "host": "10.0.0.5",
        "finding_id": 10,
        "recipient": "fallback@samsung.com",
        "subject_tag": "[보안취약점 조치요청](10.0.0.5)",
    }
    result = {"terminal_calls": [{"name": "deliver", "input": {"recipients": [], "body": "본문"}}]}

    fields = report_mail_agent._sent_mail_fields(thread, result)

    assert fields["subject"] == "[보안취약점 조치요청](10.0.0.5) 공유폴더 접근권한 관리"
