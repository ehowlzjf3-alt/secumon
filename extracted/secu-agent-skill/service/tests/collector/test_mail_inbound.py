from __future__ import annotations

from email import policy
from email.header import Header
from email.message import EmailMessage
from email.utils import formatdate

import pytest


def _message(
    *,
    subject: str,
    from_: str,
    message_id: str,
    body: str = "조치 완료",
    date_ts: float | None = None,
    cc: str = "",
    in_reply_to: str = "",
    references: str = "",
    root_mail_id: str = "",
    content_type: str = "text/plain",
) -> bytes:
    optional = ""
    if cc:
        optional += f"Cc: {cc}\r\n"
    if in_reply_to:
        optional += f"In-Reply-To: {in_reply_to}\r\n"
    if references:
        optional += f"References: {references}\r\n"
    if root_mail_id:
        optional += f"X-CMS-RootMailID: {root_mail_id}\r\n"
    return (
        f"Subject: {Header(subject, 'utf-8').encode()}\r\n"
        f"From: {from_}\r\n"
        "To: dssoc@samsung.com\r\n"
        f"{optional}"
        f"Date: {formatdate(date_ts, localtime=False, usegmt=True)}\r\n"
        f"Message-ID: <{message_id}>\r\n"
        f"Content-Type: {content_type}; charset=utf-8\r\n"
        "\r\n"
        f"{body}\r\n"
    ).encode("utf-8")


class _FakePop3:
    def __init__(self, messages: dict[int, bytes]) -> None:
        self.messages = messages
        self.retrieved: list[int] = []

    def list(self):
        return b"+OK", [f"{idx} {len(raw)}".encode() for idx, raw in self.messages.items()]

    def uidl(self):
        return b"+OK", [f"{idx} uid-{idx}".encode() for idx in self.messages]

    def top(self, msgnum: int, lines: int):
        del lines
        raw = self.messages[msgnum].split(b"\r\n\r\n", 1)[0]
        return b"+OK", raw.split(b"\r\n")

    def retr(self, msgnum: int):
        self.retrieved.append(msgnum)
        return b"+OK", self.messages[msgnum].split(b"\r\n")

    def quit(self) -> None:
        pass


def _cid_html_message(
    *,
    subject: str,
    from_: str,
    message_id: str,
    cid: str = "inline-image",
) -> bytes:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_
    msg["To"] = "dssoc@samsung.com"
    msg["Message-ID"] = f"<{message_id}>"
    msg.set_content("조치완료했습니다.")
    msg.add_alternative(
        f"<html><body><p>조치완료했습니다.</p><img src=\"cid:{cid}\"/></body></html>",
        subtype="html",
    )
    html_part = msg.get_payload()[1]
    html_part.add_related(
        b"\x89PNG\r\n\x1a\nfakepng",
        maintype="image",
        subtype="png",
        cid=f"<{cid}>",
    )
    return msg.as_bytes(policy=policy.SMTP)


def test_dssoc_sender_detection_uses_configured_identities(monkeypatch) -> None:
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "DSSOC <dssoc@samsung.com>")

    assert mail_inbound._is_dssoc_sender("DSSOC <dssoc@samsung.com>") is True
    assert mail_inbound._is_dssoc_sender("dssoc") is True
    assert mail_inbound._is_dssoc_sender("Owner One <owner.one@samsung.com>") is False


def test_body_excerpt_extracts_visible_text_from_knox_html() -> None:
    from service.collector import mail_inbound

    raw = (
        "Subject: RE: [보안취약점 조치요청](12.25.122.200)\r\n"
        "From: Owner <owner@samsung.com>\r\n"
        "To: dssoc@samsung.com\r\n"
        "Content-Type: text/html; charset=utf-8\r\n"
        "\r\n"
        "<!doctype html><html><head><style>"
        "@charset \"UTF-8\"; body,html{overflow:visible!important}"
        "</style></head><body>"
        "<p>안녕하세요.</p><p>조치완료했어요!</p>"
        "<div>--------- Original Message ---------</div>"
        "<p>SMB 공유 폴더 조치 요청</p>"
        "</body></html>"
    ).encode("utf-8")

    excerpt = mail_inbound._body_excerpt(raw)
    body_html = mail_inbound._body_html(raw)

    assert "조치완료했어요!" in excerpt
    assert "SMB 공유 폴더 조치 요청" in excerpt
    assert excerpt.index("조치완료했어요!") < excerpt.index("Original Message")
    assert mail_inbound.new_reply_text(excerpt) == "안녕하세요.\n조치완료했어요!"
    assert "@charset" not in excerpt
    assert "overflow:visible" not in excerpt
    assert "<p>안녕하세요.</p>" in body_html
    assert "<div>--------- Original Message ---------</div>" in body_html
    assert "<html" not in body_html.lower()


def test_body_html_inlines_cid_images_as_data_uri() -> None:
    from service.collector import mail_inbound

    raw = _cid_html_message(
        subject="RE: [보안취약점 조치요청](10.0.0.12)",
        from_="Owner One <owner.one@samsung.com>",
        message_id="cid-inline",
        cid="inline-image",
    )

    body_html = mail_inbound._body_html(raw)

    assert "cid:inline-image" not in body_html
    assert "src=\"data:image/png;base64," in body_html
    assert "조치완료했습니다." in body_html


def test_new_reply_text_handles_split_original_message_separator() -> None:
    from service.collector import mail_inbound

    body = (
        "안녕하세요.\n조치완료했습니다.\n감사합니다.\n"
        "---------\nOriginal Message\n---------\n"
        "SMB 공유 폴더 조치 요청"
    )

    assert mail_inbound.new_reply_text(body) == "안녕하세요.\n조치완료했습니다.\n감사합니다."


def test_subject_tag_classification_supports_service_domains() -> None:
    from service.collector import mail_inbound

    assert mail_inbound.classify_subject_tag_from_subject(
        "RE: [GitHub 보안취약점 조치요청](Org/Repo) 소스코드 시크릿 조치 요청"
    ) == ("github", "[GitHub 보안취약점 조치요청](Org/Repo)")
    assert mail_inbound.classify_subject_tag_from_subject(
        "FW: [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청"
    ) == ("confluence", "[Confluence 보안취약점 조치요청](OPS)")
    assert mail_inbound.classify_subject_tag_from_subject(
        "RE: [보안취약점 조치요청](10.0.0.5) 공유폴더 접근권한 관리"
    ) == ("smb", "[보안취약점 조치요청](10.0.0.5)")


def test_poll_inbox_skips_dssoc_sender_before_retrieval(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="high",
        status="awaiting_reply",
    )
    subject = "RE: [보안취약점 조치요청](10.0.0.5) 공유폴더 접근권한 관리"
    conn = _FakePop3({
        1: _message(subject=subject, from_="DSSOC <dssoc@samsung.com>", message_id="self-copy"),
        2: _message(subject=subject, from_="Owner One <owner.one@samsung.com>", message_id="owner-reply"),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=2)

    assert result["scanned"] == 2
    assert result["self_skipped"] == 1
    assert result["matched"] == 1
    assert result["new"] == 1
    assert conn.retrieved == [2]
    messages = state.mail_messages_for_thread(thread_id)
    assert len(messages) == 1
    assert messages[0]["mail_from"] == "Owner One <owner.one@samsung.com>"
    assert state.mail_thread_get(thread_id)["status"] == "reply_received"


def test_poll_inbox_stores_reply_correlation_headers(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.9",
        subject_tag="[보안취약점 조치요청](10.0.0.9)",
        severity="high",
        status="awaiting_reply",
    )
    subject = "RE: [보안취약점 조치요청](10.0.0.9) 공유폴더 접근권한 관리"
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id="owner-reply-corr",
            cc="Watcher <watcher@samsung.com>",
            in_reply_to="<root@samsung.com>",
            references="<root@samsung.com> <copy@samsung.com>",
            root_mail_id="root-cms-id",
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["new"] == 1
    msg = state.mail_messages_for_thread(thread_id)[0]
    assert msg["mail_cc"] == "Watcher <watcher@samsung.com>"
    assert msg["in_reply_to"] == "<root@samsung.com>"
    assert msg["references_header"] == "<root@samsung.com> <copy@samsung.com>"
    assert msg["root_message_id"] == "root-cms-id"


def test_poll_inbox_can_route_opt_in_smb_test_subject(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")
    monkeypatch.setenv("SMB_POP3_TEST_SUBJECT_CONTAINS", "POP3 reply smoke 20260701")
    monkeypatch.setenv("SMB_POP3_TEST_SUBJECT_TAG", "[보안취약점 조치요청](10.0.0.10)")

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.10",
        subject_tag="[보안취약점 조치요청](10.0.0.10)",
        severity="high",
        status="awaiting_reply",
    )
    subject = "POP3 reply smoke 20260701"
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id="owner-reply-test-subject",
            body="조치완료했어요!",
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["matched"] == 1
    assert result["new"] == 1
    assert conn.retrieved == [1]
    messages = state.mail_messages_for_thread(thread_id)
    assert len(messages) == 1
    assert messages[0]["subject"] == subject
    assert messages[0]["subject_tag"] == "[보안취약점 조치요청](10.0.0.10)"
    assert "조치완료" in messages[0]["body_excerpt"]
    assert state.mail_thread_get(thread_id)["status"] == "reply_received"


def test_poll_inbox_new_smb_reply_clears_retry_after(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")
    monkeypatch.setenv("SMB_POP3_TEST_SUBJECT_CONTAINS", "POP3 retry wake 20260701")
    monkeypatch.setenv("SMB_POP3_TEST_SUBJECT_TAG", "[보안취약점 조치요청](10.0.0.12)")

    _, thread_id = state.mail_thread_upsert(
        finding_id=12,
        host="10.0.0.12",
        subject_tag="[보안취약점 조치요청](10.0.0.12)",
        severity="high",
        status="reply_received",
    )
    state.mail_thread_schedule_communication_retry(
        thread_id,
        reason="SMB communication unavailable",
        retry_seconds=8 * 3600,
    )
    before = state.mail_thread_get(thread_id)
    assert before["retry_after"] is not None
    assert before["last_error_kind"] == "communication_unavailable"

    conn = _FakePop3({
        1: _message(
            subject="POP3 retry wake 20260701",
            from_="Owner One <owner.one@samsung.com>",
            message_id="owner-reply-retry-wake",
            body="조치완료했습니다.",
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["new"] == 1
    thread = state.mail_thread_get(thread_id)
    assert thread["status"] == "reply_received"
    assert thread["retry_after"] is None
    assert thread["last_error_kind"] is None
    assert thread["last_reason"] == "inbound reply received"


@pytest.mark.parametrize(
    ("domain", "subject_tag", "target", "message_id"),
    [
        (
            "github",
            "[GitHub 보안취약점 조치요청](org/repo)",
            "org/repo",
            "github-service-smoke-subject",
        ),
        (
            "confluence",
            "[Confluence 보안취약점 조치요청](OPS)",
            "OPS",
            "confluence-service-smoke-subject",
        ),
    ],
)
def test_poll_inbox_can_route_opt_in_service_test_subject(
    tmp_db,
    monkeypatch,
    domain: str,
    subject_tag: str,
    target: str,
    message_id: str,
) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")
    monkeypatch.setenv("SERVICE_POP3_TEST_SUBJECT_CONTAINS", "POP3 service smoke 20260701")
    monkeypatch.setenv("SERVICE_POP3_TEST_SUBJECT_TAG", subject_tag)

    base = 1_780_000_000.0
    if domain == "github":
        _, thread_id = state.github_report_thread_upsert(
            finding_id=20,
            repo=target,
            severity="high",
            recipient="owner.one@samsung.com",
            status="reported",
        )
        state.github_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            notified_at=base,
            recipient="dssoc@samsung.com",
        )
        get_thread = state.github_report_thread_get
    else:
        _, thread_id = state.confluence_report_thread_upsert(
            finding_id=21,
            space_key=target,
            severity="high",
            recipient="space.owner@samsung.com",
            status="reported",
        )
        state.confluence_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            notified_at=base,
            recipient="dssoc@samsung.com",
        )
        get_thread = state.confluence_report_thread_get

    subject = f"POP3 service smoke 20260701 {domain}"
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id=message_id,
            body="조치완료했습니다.",
            date_ts=base + 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["matched"] == 1
    assert result["new"] == 1
    assert conn.retrieved == [1]
    assert get_thread(thread_id)["status"] == "recheck_requested"
    messages = state.service_reply_messages_for_thread(domain, thread_id)
    assert len(messages) == 1
    assert messages[0]["subject"] == subject
    assert messages[0]["subject_tag"] == subject_tag
    assert messages[0]["agent_verdict"] == "classified_remediation_claim"
    assert messages[0]["decision_reason"] == "답장 신규 본문에서 조치 완료 주장을 확인함"


def test_poll_inbox_service_test_subject_rejects_non_service_tag(
    tmp_db,
    monkeypatch,
) -> None:
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")
    monkeypatch.setenv("SERVICE_POP3_TEST_SUBJECT_CONTAINS", "POP3 service smoke 20260701")
    monkeypatch.setenv("SERVICE_POP3_TEST_SUBJECT_TAG", "[보안취약점 조치요청](10.0.0.10)")

    conn = _FakePop3({
        1: _message(
            subject="POP3 service smoke 20260701",
            from_="Owner One <owner.one@samsung.com>",
            message_id="service-smoke-non-service-tag",
            body="조치완료했습니다.",
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["matched"] == 0
    assert result["new"] == 0
    assert conn.retrieved == []


def test_poll_inbox_stores_reply_html_fragment(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.11",
        subject_tag="[보안취약점 조치요청](10.0.0.11)",
        severity="high",
        status="awaiting_reply",
    )
    subject = "RE: [보안취약점 조치요청](10.0.0.11) 공유폴더 접근권한 관리"
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id="owner-reply-html",
            body=(
                "<!doctype html><html><body><p>조치완료했습니다.</p>"
                "<table><tr><td>owner.one@samsung.com</td></tr></table>"
                "<script>alert(1)</script></body></html>"
            ),
            content_type="text/html",
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["new"] == 1
    msg = state.mail_messages_for_thread(thread_id)[0]
    assert "조치완료했습니다." in msg["body_excerpt"]
    assert "<p>조치완료했습니다.</p>" in msg["body_html"]
    assert "<table>" in msg["body_html"]
    assert "owner.one@samsung.com" in msg["body_html"]
    assert "<script" not in msg["body_html"]


def test_poll_inbox_backfills_duplicate_reply_html_fragment(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.12",
        subject_tag="[보안취약점 조치요청](10.0.0.12)",
        severity="high",
        status="reply_received",
    )
    subject = "RE: [보안취약점 조치요청](10.0.0.12) 공유폴더 접근권한 관리"
    state.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="owner-reply-html-dedup",
        subject=subject,
        subject_tag="[보안취약점 조치요청](10.0.0.12)",
        mail_from="Owner One <owner.one@samsung.com>",
        mail_to="dssoc@samsung.com",
        body_excerpt="조치완료했습니다.",
        body_html='<p>조치완료했습니다.</p><img src="cid:inline-image"/>',
        agent_verdict="pending",
    )
    conn = _FakePop3({
        1: _cid_html_message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id="owner-reply-html-dedup",
            cid="inline-image",
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["new"] == 0
    assert result["dedup_skipped"] == 1
    msg = state.mail_messages_for_thread(thread_id)[0]
    assert msg["body_excerpt"] == "조치완료했습니다."
    assert "cid:inline-image" not in msg["body_html"]
    assert "src=\"data:image/png;base64," in msg["body_html"]


@pytest.mark.parametrize(
    ("domain", "subject", "subject_tag"),
    [
        (
            "github",
            "RE: [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청",
            "[GitHub 보안취약점 조치요청](org/repo)",
        ),
        (
            "confluence",
            "RE: [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청",
            "[Confluence 보안취약점 조치요청](OPS)",
        ),
    ],
)
def test_poll_inbox_backfills_duplicate_service_reply_html_fragment(
    tmp_db,
    monkeypatch,
    domain,
    subject,
    subject_tag,
) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    if domain == "github":
        _, thread_id = state.github_report_thread_upsert(
            finding_id=20,
            repo="org/repo",
            severity="high",
            recipient="owner.one@samsung.com",
            status="reported",
        )
        state.github_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            recipient="dssoc@samsung.com",
        )
    else:
        _, thread_id = state.confluence_report_thread_upsert(
            finding_id=20,
            space_key="OPS",
            severity="high",
            recipient="owner.one@samsung.com",
            status="reported",
        )
        state.confluence_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            recipient="dssoc@samsung.com",
        )
    state.service_reply_message_add(
        domain=domain,
        direction="in",
        thread_id=thread_id,
        message_id=f"{domain}-service-html-dedup",
        subject=subject,
        subject_tag=subject_tag,
        mail_from="Owner One <owner.one@samsung.com>",
        mail_to="dssoc@samsung.com",
        body_excerpt="조치완료했습니다.",
        body_html='<p>조치완료했습니다.</p><img src="cid:inline-image"/>',
        agent_verdict="classified_remediation_claim",
        decision_reason="답장 신규 본문에서 조치 완료 주장을 확인함",
    )
    conn = _FakePop3({
        1: _cid_html_message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id=f"{domain}-service-html-dedup",
            cid="inline-image",
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["new"] == 0
    assert result["dedup_skipped"] == 1
    messages = state.service_reply_messages_for_thread(domain, thread_id)
    assert messages[0]["body_excerpt"] == "조치완료했습니다."
    assert "cid:inline-image" not in messages[0]["body_html"]
    assert "src=\"data:image/png;base64," in messages[0]["body_html"]


def test_poll_inbox_does_not_attach_reply_older_than_latest_outbound(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    _, thread_id = state.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.6",
        subject_tag="[보안취약점 조치요청](10.0.0.6)",
        severity="high",
        status="re_requested",
    )
    base = 1_780_000_000.0
    subject = "RE: [보안취약점 조치요청](10.0.0.6) 공유폴더 접근권한 관리"
    state.mail_message_add(
        direction="out",
        thread_id=thread_id,
        subject=subject,
        subject_tag="[보안취약점 조치요청](10.0.0.6)",
        mail_from="dssoc",
        mail_to="owner.one@samsung.com",
        agent_verdict="sent",
        received_at=base,
    )
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id="old-owner-reply",
            date_ts=base - 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["matched"] == 1
    assert result["new"] == 1
    assert conn.retrieved == []
    messages = state.mail_messages_for_thread(thread_id)
    assert len(messages) == 1
    assert messages[0]["direction"] == "out"
    assert state.mail_thread_get(thread_id)["status"] == "re_requested"
    with state.connect() as c:
        row = c.execute(
            "SELECT thread_id, agent_verdict FROM mail_message WHERE message_id=?",
            ("old-owner-reply",),
        ).fetchone()
    assert row["thread_id"] is None
    assert row["agent_verdict"] == "unmatched"


def test_poll_inbox_routes_github_reply_to_recheck_queue(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = state.github_report_thread_upsert(
        finding_id=10,
        repo="org/repo",
        severity="high",
        recipient="owner.one@samsung.com",
        status="reported",
    )
    state.github_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    subject = "RE: [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청"
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id="github-owner-reply",
            body="조치완료했습니다.",
            date_ts=base + 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["matched"] == 1
    assert result["new"] == 1
    assert conn.retrieved == [1]
    thread = state.github_report_thread_get(thread_id)
    assert thread["status"] == "recheck_requested"
    assert "조치 완료" in thread["last_reason"]
    messages = state.service_reply_messages_for_thread("github", thread_id)
    assert len(messages) == 1
    assert messages[0]["agent_verdict"] == "classified_remediation_claim"
    assert messages[0]["decision_reason"] == "답장 신규 본문에서 조치 완료 주장을 확인함"
    assert messages[0]["subject_tag"] == "[GitHub 보안취약점 조치요청](org/repo)"
    assert "조치완료" in messages[0]["body_excerpt"]


def test_poll_inbox_routes_confluence_reply_to_recheck_queue(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = state.confluence_report_thread_upsert(
        finding_id=20,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="reported",
    )
    state.confluence_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    subject = "RE: [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청"
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Space Owner <space.owner@samsung.com>",
            message_id="confluence-owner-reply",
            body="조치 완료했습니다.",
            date_ts=base + 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["matched"] == 1
    assert result["new"] == 1
    assert conn.retrieved == [1]
    thread = state.confluence_report_thread_get(thread_id)
    assert thread["status"] == "recheck_requested"
    messages = state.service_reply_messages_for_thread("confluence", thread_id)
    assert len(messages) == 1
    assert messages[0]["mail_from"] == "Space Owner <space.owner@samsung.com>"
    assert messages[0]["subject_tag"] == "[Confluence 보안취약점 조치요청](OPS)"
    assert messages[0]["agent_verdict"] == "classified_remediation_claim"
    assert messages[0]["decision_reason"] == "답장 신규 본문에서 조치 완료 주장을 확인함"


def test_poll_inbox_routes_service_owner_change_to_hitl_not_recheck(
    tmp_db,
    monkeypatch,
) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = state.github_report_thread_upsert(
        finding_id=30,
        repo="org/repo",
        severity="high",
        recipient="owner.one@samsung.com",
        status="reported",
    )
    state.github_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    subject = "RE: [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청"
    body = (
        "담당자가 철우님으로 변경되었습니다. cw871126.lee@samsung.com\n"
        "--------- Original Message ---------\n"
        "조치완료했습니다."
    )
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id="github-owner-changed",
            body=body,
            date_ts=base + 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["new"] == 1
    thread = state.github_report_thread_get(thread_id)
    assert thread["status"] == "owner_reassignment_review"
    assert "담당자 변경" in thread["last_reason"]
    messages = state.service_reply_messages_for_thread("github", thread_id)
    assert messages[0]["agent_verdict"] == "classified_owner_changed"
    assert messages[0]["decision_reason"] == "답장 신규 본문에서 담당자 변경/이관을 언급함"
    assert messages[0]["extracted_owner"] == {"email": "cw871126.lee@samsung.com"}


@pytest.mark.parametrize(
    ("domain", "target", "initial_status", "subject", "message_id"),
    [
        (
            "github",
            "org/repo",
            "owner_reassignment_review",
            "RE:(2) [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청",
            "github-hitl-follow-up-done",
        ),
        (
            "confluence",
            "OPS",
            "owner_update_needed",
            "RE:(2) [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청",
            "confluence-hitl-follow-up-done",
        ),
        (
            "github",
            "org/escalated",
            "escalated",
            "RE: [GitHub 보안취약점 조치요청](org/escalated) 소스코드 시크릿 조치 요청",
            "github-escalated-follow-up-done",
        ),
    ],
)
def test_poll_inbox_attaches_service_follow_up_replies_in_hitl_statuses(
    tmp_db,
    monkeypatch,
    domain: str,
    target: str,
    initial_status: str,
    subject: str,
    message_id: str,
) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    if domain == "github":
        _, thread_id = state.github_report_thread_upsert(
            finding_id=31,
            repo=target,
            severity="high",
            recipient="owner.one@samsung.com",
            status="reported",
        )
        state.github_report_thread_set_status(
            thread_id,
            initial_status,
            notified_at=base,
            recipient="dssoc@samsung.com",
            last_reason="hitl pending owner response",
        )
        get_thread = state.github_report_thread_get
    else:
        _, thread_id = state.confluence_report_thread_upsert(
            finding_id=32,
            space_key=target,
            severity="high",
            recipient="space.owner@samsung.com",
            status="reported",
        )
        state.confluence_report_thread_set_status(
            thread_id,
            initial_status,
            notified_at=base,
            recipient="dssoc@samsung.com",
            last_reason="hitl pending owner response",
        )
        get_thread = state.confluence_report_thread_get

    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id=message_id,
            body="조치완료했습니다.",
            date_ts=base + 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["matched"] == 1
    assert result["new"] == 1
    thread = get_thread(thread_id)
    assert thread["status"] == "recheck_requested"
    assert "조치 완료" in thread["last_reason"]
    messages = state.service_reply_messages_for_thread(domain, thread_id)
    assert len(messages) == 1
    assert messages[0]["agent_verdict"] == "classified_remediation_claim"
    assert messages[0]["decision_reason"] == "답장 신규 본문에서 조치 완료 주장을 확인함"


def test_poll_inbox_does_not_attach_stale_service_reply_to_hitl_thread(
    tmp_db,
    monkeypatch,
) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = state.github_report_thread_upsert(
        finding_id=33,
        repo="org/hitl-stale",
        severity="high",
        recipient="owner.one@samsung.com",
        status="reported",
    )
    state.github_report_thread_set_status(
        thread_id,
        "owner_update_needed",
        notified_at=base,
        recipient="dssoc@samsung.com",
        last_reason="hitl pending owner response",
    )
    subject = "RE: [GitHub 보안취약점 조치요청](org/hitl-stale) 소스코드 시크릿 조치 요청"
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id="github-hitl-stale-reply",
            body="조치완료했습니다.",
            date_ts=base - 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["matched"] == 1
    assert result["new"] == 1
    thread = state.github_report_thread_get(thread_id)
    assert thread["status"] == "owner_update_needed"
    assert thread["last_reason"] == "hitl pending owner response"
    assert state.service_reply_messages_for_thread("github", thread_id) == []
    unmatched = state.service_reply_message_get_by_message_id("github-hitl-stale-reply")
    assert unmatched["thread_id"] is None
    assert unmatched["agent_verdict"] == "classified_remediation_claim"


@pytest.mark.parametrize(
    (
        "domain", "target", "subject", "message_id", "body", "expected_status",
        "expected_verdict", "expected_reason", "expected_owner",
    ),
    [
        (
            "github",
            "org/business-exception",
            "RE: [GitHub 보안취약점 조치요청](org/business-exception) 소스코드 시크릿 조치 요청",
            "github-business-exception-reply",
            "해당 토큰은 업무상 예외 승인 필요합니다.",
            "exception_review",
            "classified_business_exception_claim",
            "답장 신규 본문에서 업무 목적/예외 필요성을 언급함",
            {},
        ),
        (
            "confluence",
            "NOTOWNER",
            "RE: [Confluence 보안취약점 조치요청](NOTOWNER) 콘텐츠 시크릿 조치 요청",
            "confluence-not-owner-reply",
            "제가 담당자가 아닙니다. owner.two@samsung.com 쪽으로 확인 부탁드립니다.",
            "owner_update_needed",
            "classified_not_owner",
            "답장 신규 본문에서 본인이 담당자가 아니라고 밝힘",
            {"email": "owner.two@samsung.com"},
        ),
        (
            "github",
            "org/still-needed",
            "RE: [GitHub 보안취약점 조치요청](org/still-needed) 소스코드 시크릿 조치 요청",
            "github-still-needed-reply",
            "아직 조치 진행중입니다. 완료되면 다시 회신드리겠습니다.",
            "awaiting_owner",
            "classified_still_needed",
            "답장 신규 본문에서 조치 미완료 또는 진행 중임을 언급함",
            {},
        ),
    ],
)
def test_poll_inbox_keeps_service_non_remediation_replies_out_of_recheck_queue(
    tmp_db,
    monkeypatch,
    domain: str,
    target: str,
    subject: str,
    message_id: str,
    body: str,
    expected_status: str,
    expected_verdict: str,
    expected_reason: str,
    expected_owner: dict[str, str],
) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    if domain == "github":
        _, thread_id = state.github_report_thread_upsert(
            finding_id=34,
            repo=target,
            severity="high",
            recipient="owner.one@samsung.com",
            status="reported",
        )
        state.github_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            notified_at=base,
            recipient="dssoc@samsung.com",
        )
        get_thread = state.github_report_thread_get
    else:
        _, thread_id = state.confluence_report_thread_upsert(
            finding_id=35,
            space_key=target,
            severity="high",
            recipient="space.owner@samsung.com",
            status="reported",
        )
        state.confluence_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            notified_at=base,
            recipient="dssoc@samsung.com",
        )
        get_thread = state.confluence_report_thread_get

    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id=message_id,
            body=body,
            date_ts=base + 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["matched"] == 1
    assert result["new"] == 1
    thread = get_thread(thread_id)
    assert thread["status"] == expected_status
    assert thread["last_reason"] == expected_reason
    messages = state.service_reply_messages_for_thread(domain, thread_id)
    assert len(messages) == 1
    assert messages[0]["agent_verdict"] == expected_verdict
    assert messages[0]["decision_reason"] == expected_reason
    assert messages[0]["extracted_owner"] == expected_owner


def test_poll_inbox_ignores_original_message_when_service_reply_claims_done(
    tmp_db,
    monkeypatch,
) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = state.confluence_report_thread_upsert(
        finding_id=40,
        space_key="OPS",
        severity="high",
        recipient="space.owner@samsung.com",
        status="reported",
    )
    state.confluence_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    subject = "RE: [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청"
    body = (
        "조치 완료했습니다.\n"
        "--------- Original Message ---------\n"
        "담당자가 아닙니다. 업무상 예외 필요합니다."
    )
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Space Owner <space.owner@samsung.com>",
            message_id="confluence-done-with-original",
            body=body,
            date_ts=base + 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["new"] == 1
    thread = state.confluence_report_thread_get(thread_id)
    assert thread["status"] == "recheck_requested"
    assert "조치 완료" in thread["last_reason"]
    messages = state.service_reply_messages_for_thread("confluence", thread_id)
    assert messages[0]["agent_verdict"] == "classified_remediation_claim"
    assert messages[0]["decision_reason"] == "답장 신규 본문에서 조치 완료 주장을 확인함"


def test_poll_inbox_does_not_classify_service_reply_from_original_message_only(
    tmp_db,
    monkeypatch,
) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = state.github_report_thread_upsert(
        finding_id=41,
        repo="org/repo",
        severity="high",
        recipient="owner.one@samsung.com",
        status="reported",
    )
    state.github_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    subject = "RE: [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청"
    body = (
        "안녕하세요. 확인했습니다.\n"
        "--------- Original Message ---------\n"
        "조치완료했습니다.\n"
        "이거 어떻게 조치하면 되나요?"
    )
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id="github-original-only-action",
            body=body,
            date_ts=base + 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["new"] == 1
    thread = state.github_report_thread_get(thread_id)
    assert thread["status"] == "awaiting_owner"
    assert "명확히 확인하지 못함" in thread["last_reason"]
    messages = state.service_reply_messages_for_thread("github", thread_id)
    assert messages[0]["agent_verdict"] == "classified_unclear"
    assert messages[0]["decision_reason"] == "답장 신규 본문에서 조치 완료 주장이나 HITL 사유를 명확히 확인하지 못함"
    assert state.service_report_thread_claim_how_to_guidance_next(
        "github",
        session_id=999,
    ) is None


def test_poll_inbox_keeps_service_how_to_question_out_of_recheck_queue(
    tmp_db,
    monkeypatch,
) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = state.github_report_thread_upsert(
        finding_id=50,
        repo="org/repo",
        severity="high",
        recipient="owner.one@samsung.com",
        status="reported",
    )
    state.github_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    subject = "RE: [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청"
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id="github-how-to",
            body="이거 어떻게 조치하면 되나요? 방법 안내 부탁드립니다.",
            date_ts=base + 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["new"] == 1
    thread = state.github_report_thread_get(thread_id)
    assert thread["status"] == "awaiting_owner"
    assert "조치 방법" in thread["last_reason"]
    messages = state.service_reply_messages_for_thread("github", thread_id)
    assert messages[0]["agent_verdict"] == "classified_how_to_question"
    assert messages[0]["decision_reason"] == "답장 신규 본문에서 조치 방법 안내를 요청함"


@pytest.mark.parametrize(
    ("domain", "target", "subject", "message_id"),
    (
        (
            "github",
            "org/repo",
            "RE:(2) [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청",
            "github-how-to-quoted-done",
        ),
        (
            "confluence",
            "OPS",
            "RE:(2) [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청",
            "confluence-how-to-quoted-done",
        ),
    ),
)
def test_poll_inbox_service_how_to_ignores_original_message_completion(
    tmp_db,
    monkeypatch,
    domain: str,
    target: str,
    subject: str,
    message_id: str,
) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    if domain == "github":
        _, thread_id = state.github_report_thread_upsert(
            finding_id=70,
            repo=target,
            severity="high",
            recipient="owner.one@samsung.com",
            status="reported",
        )
        state.github_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            notified_at=base,
            recipient="dssoc@samsung.com",
        )
        get_thread = state.github_report_thread_get
    else:
        _, thread_id = state.confluence_report_thread_upsert(
            finding_id=71,
            space_key=target,
            severity="high",
            recipient="space.owner@samsung.com",
            status="reported",
        )
        state.confluence_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            notified_at=base,
            recipient="dssoc@samsung.com",
        )
        get_thread = state.confluence_report_thread_get
    body = (
        "안녕하세요.\n"
        "이 항목은 어떻게 조치하면 되나요? 방법 안내 부탁드립니다.\n"
        "감사합니다.\n\n"
        "--------- Original Message ---------\n"
        "조치완료했습니다.\n"
        "업무상 예외가 필요합니다.\n"
        "담당자가 아닙니다."
    )
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id=message_id,
            body=body,
            date_ts=base + 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["new"] == 1
    thread = get_thread(thread_id)
    assert thread["status"] == "awaiting_owner"
    assert "조치 방법" in thread["last_reason"]
    messages = state.service_reply_messages_for_thread(domain, thread_id)
    assert messages[0]["agent_verdict"] == "classified_how_to_question"
    assert "Original Message" in messages[0]["body_excerpt"]
    assert state.service_report_thread_claim_how_to_guidance_next(
        domain,
        session_id=999,
    )["id"] == thread_id


def test_poll_inbox_uses_service_reply_body_not_subject_for_decision(
    tmp_db,
    monkeypatch,
) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    _, thread_id = state.github_report_thread_upsert(
        finding_id=60,
        repo="org/repo",
        severity="high",
        recipient="owner.one@samsung.com",
        status="reported",
    )
    state.github_report_thread_set_status(
        thread_id,
        "awaiting_owner",
        notified_at=base,
        recipient="dssoc@samsung.com",
    )
    subject = "[문의] RE: [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청"
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id="github-question-subject-done-body",
            body="조치완료했습니다.",
            date_ts=base + 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["new"] == 1
    thread = state.github_report_thread_get(thread_id)
    assert thread["status"] == "recheck_requested"
    messages = state.service_reply_messages_for_thread("github", thread_id)
    assert messages[0]["agent_verdict"] == "classified_remediation_claim"


@pytest.mark.parametrize(
    ("domain", "target", "subject", "message_id"),
    [
        (
            "github",
            "org/repo",
            "RE: [GitHub 보안취약점 조치요청](org/repo) 소스코드 시크릿 조치 요청",
            "github-stale-reply",
        ),
        (
            "confluence",
            "OPS",
            "RE: [Confluence 보안취약점 조치요청](OPS) 콘텐츠 시크릿 조치 요청",
            "confluence-stale-reply",
        ),
    ],
)
def test_poll_inbox_does_not_attach_stale_service_reply(
    tmp_db,
    monkeypatch,
    domain: str,
    target: str,
    subject: str,
    message_id: str,
) -> None:
    from service import state_domain as state
    from service.collector import mail_inbound

    monkeypatch.setenv("POP3_USER", "dssoc")
    monkeypatch.setenv("POP3_PASSWORD", "secret")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")

    base = 1_780_000_000.0
    if domain == "github":
        _, thread_id = state.github_report_thread_upsert(
            finding_id=10,
            repo=target,
            severity="high",
            status="reported",
        )
        state.github_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            notified_at=base,
            recipient="dssoc@samsung.com",
        )
        get_thread = state.github_report_thread_get
    else:
        _, thread_id = state.confluence_report_thread_upsert(
            finding_id=11,
            space_key=target,
            severity="high",
            status="reported",
        )
        state.confluence_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            notified_at=base,
            recipient="dssoc@samsung.com",
        )
        get_thread = state.confluence_report_thread_get
    conn = _FakePop3({
        1: _message(
            subject=subject,
            from_="Owner One <owner.one@samsung.com>",
            message_id=message_id,
            body="조치완료했습니다.",
            date_ts=base - 60,
        ),
    })
    monkeypatch.setattr(mail_inbound, "_connect", lambda: conn)

    result = mail_inbound.poll_inbox(max_fetch=1)

    assert result["matched"] == 1
    assert result["new"] == 1
    assert conn.retrieved == [1]
    assert get_thread(thread_id)["status"] == "awaiting_owner"
    with state.connect() as c:
        row = c.execute(
            "SELECT domain, thread_id, agent_verdict, body_excerpt FROM service_reply_message WHERE message_id=?",
            (message_id,),
        ).fetchone()
    assert row["domain"] == domain
    assert row["thread_id"] is None
    assert row["agent_verdict"] == "classified_remediation_claim"
    assert "조치완료" in row["body_excerpt"]


# ── dev_web 수신 분류 (조용히 버려지던 것) ──────────────────────────────────
#
# 태그가 `[Dev Web 보안취약점 조치요청](도메인)` 인데 SMB 정규식은 `[` **바로 뒤**
# `보안취약점` 을 요구해서 안 걸렸고, 분류 실패는 `classified is None → continue` 로
# **조용히 버려졌다.** 그래서 `dev_web_report_thread.reply_received` 가 0행이고
# 재검증 워커는 영원히 빈 큐를 돌았다(`dev_web_recheck_result` 0행).

def test_dev_web_reply_is_classified():
    from service.collector import mail_inbound
    got = mail_inbound.classify_subject_tag_from_subject(
        "RE: [Dev Web 보안취약점 조치요청](met8mendix--metui-prod.cdep.samsungds.net) 접근통제")
    assert got is not None, "dev_web 답장이 분류되지 않으면 조용히 버려진다"
    assert got[0] == "dev_web"
    assert "met8mendix--metui-prod.cdep.samsungds.net" in got[1]


def test_dev_web_tag_does_not_fall_through_to_smb():
    """★ SMB 정규식은 접두를 요구하지 않는다 — 순서가 바뀌면 dev_web 답장이 smb 로 간다."""
    from service.collector import mail_inbound
    domain, _tag = mail_inbound.classify_subject_tag_from_subject(
        "[Dev Web 보안취약점 조치요청](example.samsungds.net)")
    assert domain == "dev_web"


def test_every_domain_tag_routes_to_its_own_domain():
    """4도메인 전부 자기 도메인으로 — 하나가 빠지면 그 도메인 재확인이 통째로 멈춘다."""
    from service.collector import mail_inbound
    cases = {
        "[보안취약점 조치요청](10.0.0.5)": "smb",
        "[Dev Web 보안취약점 조치요청](x.samsungds.net)": "dev_web",
        "[GitHub 보안취약점 조치요청](org/repo)": "github",
        "[Confluence 보안취약점 조치요청](SPACE)": "confluence",
    }
    for subject, expected in cases.items():
        got = mail_inbound.classify_subject_tag_from_subject(f"RE: {subject} 조치 완료")
        assert got is not None and got[0] == expected, f"{subject} → {got}"


def test_unrelated_mail_is_not_classified():
    from service.collector import mail_inbound
    assert mail_inbound.classify_subject_tag_from_subject("점심 메뉴 안내") is None
