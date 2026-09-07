"""POP3 수신 — 조치요청 답장 수집 (smb_domain_e2e 요구 8). 신규 구축(두 repo 0).

VulnerMove `mailFetchService.ts`(node-pop3) 패턴을 Python `poplib` 로 포팅:
`pop3.samsung.net` POP3S(TLS), STAT/UIDL/TOP/RETR. **passive** — RETR/TOP 헤더·본문
fetch 만, **DELE/flag 변경 금지**(KEEP). UID = x-cms-mailid(Knox 고유) > Message-ID > uidl.

제목 `[보안취약점 조치요청](IP)`, `[GitHub 보안취약점 조치요청](repo)`,
`[Confluence 보안취약점 조치요청](space)` 파싱(RE:/FW: 접두 허용)
→ 각 도메인 report thread subject_tag 매칭.
**dedup UNIQUE(message_id) → spawn/send 전에 체크**(POP3 leave-on-server 재처리 방지).
메일계정 lockout 도 SMB 철학 미러(`_POP3_DISABLED_REASON` 프로세스 전역, reactive).

env: POP3_HOST(기본 pop3.samsung.net) / POP3_PORT(995) / POP3_USER(dssoc) /
POP3_PASSWORD / POP3_TIMEOUT.
(폴링 주기는 수집기가 정한다 — `COLLECTOR_POLL_SECONDS`. 여기 `POP3_POLL_SECONDS` 라고
 적혀 있었으나 읽는 코드가 없었다: 2026-08-28 에 문구와 .env 키를 함께 정리했다.)

테스트 보조(기본 off): `SMB_POP3_TEST_SUBJECT_CONTAINS`/`SMB_POP3_TEST_SUBJECT_TAG`
또는 `SERVICE_POP3_TEST_SUBJECT_CONTAINS`/`SERVICE_POP3_TEST_SUBJECT_TAG` 를 함께
주면 해당 제목을 지정 subject_tag 의 답장처럼 수거한다. 운영 분류함에서 실제
조치요청 제목을 당장 볼 수 없을 때 POP3 HTML/스레딩/답장 처리를 검증하기 위한
opt-in 경로이며, 평소 동작에는 영향을 주지 않는다.
"""
from __future__ import annotations

import email
import base64
from html import unescape
import logging
import os
import poplib
import re
import time
from email.header import decode_header, make_header
from email.utils import getaddresses, parsedate_to_datetime
from typing import Any

from service import state_domain as state
from service.services import owner_recipients as orx

log = logging.getLogger("service.collector.mail_inbound")

# 메일계정 lockout 미러 (SMB _AUTH_DISABLED_REASON 철학). reactive, operator reset.
_POP3_DISABLED_REASON: str | None = None

# 제목 태그: SMB/GitHub/Confluence 조치요청 correlation key.
#: 티켓 번호 괄호 — 태그 바로 뒤에 올 수 있다(2026-08-31 형식 통일).
#:
#:     [보안취약점 조치요청](SMB00024)(10.125.102.246) 공유폴더 …
#:                          ^^^^^^^^^^ 이 그룹을 **건너뛰어야** 좌표를 잡는다.
#:
#: ⚠️ 옵션이다. 이 형식 이전에 나간 메일의 답장이 아직 돌아온다 —
#:    `[보안취약점 조치요청](10.125.102.246)` 도 그대로 매칭돼야 한다.
_TICKET_GROUP = r"(?:\(\s*(?:SMB|GH|CF|DW)\d{5,}\s*\))?"

#: ★ 2026-09-01: 제목에서 **대상이 맨 뒤로** 갔다(사용자 결정).
#:
#:     예전  [보안취약점 조치요청](12.23.37.227) 공유폴더 접근권한 관리
#:     지금  [보안취약점 조치요청](SMB00080) 공유폴더 접근권한 관리 (12.23.37.227)
#:
#: 태그 **바로 뒤** 괄호만 보던 정규식은 새 형태에서 대상을 못 찾는다. 그래서 좌표는
#: 별도로 **제목의 마지막 괄호**에서 집는다(`_trailing_src`). 라벨 매칭은 그대로 두어
#: 도메인 판정에만 쓴다.
#: ⚠️ 두 형태를 **모두** 읽어야 한다 — 옛 형태로 나간 메일의 답장이 아직 온다.
_SUBJECT_TAG_RE = re.compile(
    r"\[보안취약점\s*조치요청\]" + _TICKET_GROUP + r"(?:\(([^)]+)\))?")
_GITHUB_SUBJECT_TAG_RE = re.compile(
    r"\[GitHub\s*보안취약점\s*조치요청\]" + _TICKET_GROUP + r"(?:\(([^)]+)\))?",
    re.IGNORECASE)
_CONFLUENCE_SUBJECT_TAG_RE = re.compile(
    r"\[Confluence\s*보안취약점\s*조치요청\]" + _TICKET_GROUP + r"(?:\(([^)]+)\))?",
    re.IGNORECASE,
)
# ★ dev_web 이 빠져 있었다. 태그는 `[Dev Web 보안취약점 조치요청](도메인)` 인데 SMB 정규식은
#   `[` **바로 뒤** `보안취약점` 을 요구해서 안 걸리고, 분류 실패는 `classified is None → continue`
#   로 **조용히 버려졌다**. 그래서 `dev_web_report_thread` 에 `reply_received` 가 0행이고,
#   재검증 워커는 영원히 빈 큐를 돈다(`dev_web_recheck_result` 0행).
#   생산자 쪽(`state.normalize_dev_web_subject_tag`)은 이미 있었다 — 소비 분기만 없었다.
_DEV_WEB_SUBJECT_TAG_RE = re.compile(
    r"\[Dev\s*Web\s*보안취약점\s*조치요청\]" + _TICKET_GROUP + r"(?:\(([^)]+)\))?",
    re.IGNORECASE,
)

#: 제목의 **마지막** 괄호 = 대상. 티켓 번호 괄호는 제외한다.
_TRAILING_SRC_RE = re.compile(r"\(([^)]+)\)\s*$")
_TICKET_ONLY_RE = re.compile(r"^\s*(?:SMB|GH|CF|DW)\d{5,}\s*$", re.IGNORECASE)


def _trailing_src(subject: str) -> str:
    """제목 끝의 괄호에서 대상을 집는다. 티켓 번호뿐이면 대상이 아니다."""
    m = _TRAILING_SRC_RE.search(str(subject or ""))
    if not m:
        return ""
    value = m.group(1).strip()
    return "" if _TICKET_ONLY_RE.match(value) else value
_REPLY_PREFIX_RE = re.compile(r"^\s*((re|fw|fwd|회신|답장|전달)\s*:\s*)+", re.IGNORECASE)
_ORIGINAL_MESSAGE_RE = re.compile(
    r"(?im)^\s*-{2,}\s*Original Message\s*-{2,}\s*$"
    r"|^\s*-{2,}\s*\n\s*Original Message\s*\n\s*-{2,}\s*$"
)
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")

_FETCH_RECENT = 200  # 최근 N통만 검사 (전수 RETR 폭주 방지)
_INLINE_IMAGE_MAX_BYTES = 64 * 1024
_INLINE_IMAGE_TOTAL_MAX_BYTES = 58 * 1024


class Pop3Disabled(RuntimeError):
    pass


def reset_pop3_lockout_flag() -> None:
    """operator/scan-cycle 시작 시에만 호출 — 러너/에이전트 호출 금지(KEEP 미러)."""
    global _POP3_DISABLED_REASON
    _POP3_DISABLED_REASON = None


def pop3_enabled() -> bool:
    return bool((os.environ.get("POP3_PASSWORD") or "").strip()
                and (os.environ.get("POP3_USER") or "").strip())


def _decode(raw: str | None) -> str:
    if not raw:
        return ""
    try:
        return str(make_header(decode_header(raw)))
    except Exception:  # noqa: BLE001
        return raw


def _csv(value: str | None) -> list[str]:
    return [p.strip() for p in str(value or "").split(",") if p.strip()]


def _mail_identity_values(value: str | None) -> set[str]:
    out: set[str] = set()
    for _, addr in getaddresses([str(value or "")]):
        addr = addr.strip().lower()
        if not addr:
            continue
        out.add(addr)
        if "@" in addr:
            out.add(addr.split("@", 1)[0])
    raw = str(value or "").strip().lower()
    if raw and "@" not in raw and "<" not in raw and " " not in raw:
        out.add(raw)
    return out


def _our_sender_identities() -> set[str]:
    """**우리가 보낸 메일인가** 를 판정할 신원 집합.

    ⚠️ "DSSOC 인가" 보다 **넓다.** 팀함 주소뿐 아니라 POP3 계정·Knox 발신자도 우리다 —
    좁히면 우리가 보낸 메일이 담당자 회신으로 오인된다. 그래서 DSSOC 판정
    (`owner_recipients.is_dssoc`)으로 대체하지 않고, 그 집합을 **씨앗으로** 쓴다.

    ★ 예전엔 도메인 env 중 `SMB_` 하나만 봤다 — SMB 만 있던 시절의 목록이 남은 것이다.
      도메인별 팀함을 따로 두면 그 도메인 회신에서 자기 메일을 못 알아본다.
    """
    identities: set[str] = set(orx.dssoc_addresses())
    for value in (os.environ.get("POP3_USER"), os.environ.get("SA_KNOX_MAIL_SENDER")):
        identities.update(_mail_identity_values(value))
    return {x for x in identities if x}


def _is_dssoc_sender(from_header: str | None) -> bool:
    sender_values = _mail_identity_values(from_header)
    return bool(sender_values & _our_sender_identities())


def normalize_subject_tag_from_subject(subject: str) -> str | None:
    """제목에서 조치요청 정규화 키 추출 (RE:/FW: 무시). 없으면 None."""
    match = classify_subject_tag_from_subject(subject)
    return match[1] if match else None


def classify_subject_tag_from_subject(subject: str) -> tuple[str, str] | None:
    """Return `(domain, normalized_subject_tag)` for supported remediation mail."""
    if not subject:
        return None
    # ⚠️ 좌표는 태그 바로 뒤(옛 형태) **또는** 제목 끝(현 형태)에 있다. 둘 다 본다.
    trailing = _trailing_src(subject)
    m = _GITHUB_SUBJECT_TAG_RE.search(subject)
    if m:
        src = (m.group(1) or trailing).strip()
        return ("github", state.normalize_github_subject_tag(src)) if src else None
    m = _CONFLUENCE_SUBJECT_TAG_RE.search(subject)
    if m:
        src = (m.group(1) or trailing).strip()
        return ("confluence", state.normalize_confluence_subject_tag(src)) if src else None
    # ⚠️ 접두 있는 것을 **먼저** 본다. SMB 정규식은 접두를 요구하지 않아서, 순서가 바뀌면
    #    다른 도메인 답장이 smb 로 잘못 분류될 수 있다.
    m = _DEV_WEB_SUBJECT_TAG_RE.search(subject)
    if m:
        src = (m.group(1) or trailing).strip()
        return ("dev_web", state.normalize_dev_web_subject_tag(src)) if src else None
    m = _SUBJECT_TAG_RE.search(subject)
    if m:
        ip = (m.group(1) or trailing).strip()
        return ("smb", f"[보안취약점 조치요청]({ip})") if ip else None
    return None


def _test_subject_tag_from_subject(subject: str) -> tuple[str, str] | None:
    """Opt-in POP3 smoke-test subject routing for SMB reply/reverify checks."""
    needle = (os.environ.get("SMB_POP3_TEST_SUBJECT_CONTAINS") or "").strip()
    tag = (os.environ.get("SMB_POP3_TEST_SUBJECT_TAG") or "").strip()
    if not needle or not tag:
        return None
    if needle not in str(subject or ""):
        return None
    if not _SUBJECT_TAG_RE.fullmatch(tag):
        log.warning("[pop3] invalid SMB_POP3_TEST_SUBJECT_TAG ignored: %r", tag)
        return None
    return "smb", tag


def _service_test_subject_tag_from_subject(subject: str) -> tuple[str, str] | None:
    """Opt-in POP3 smoke-test subject routing for GitHub/Confluence replies."""
    needle = (os.environ.get("SERVICE_POP3_TEST_SUBJECT_CONTAINS") or "").strip()
    tag = (os.environ.get("SERVICE_POP3_TEST_SUBJECT_TAG") or "").strip()
    if not needle or not tag:
        return None
    if needle not in str(subject or ""):
        return None
    classified = classify_subject_tag_from_subject(tag)
    if classified is None or classified[0] not in {"github", "confluence"}:
        log.warning("[pop3] invalid SERVICE_POP3_TEST_SUBJECT_TAG ignored: %r", tag)
        return None
    return classified


def _ticket_subject_tag(subject: str) -> tuple[str, str] | None:
    """제목 태그가 지워졌어도 **티켓번호**가 있으면 우리 메일로 인식한다.

    태그는 스레드에서 되읽는다 — 뒤 단계(`common["subject_tag"]`)가 태그를 요구하고,
    여기서 비워 두면 감사 기록에 좌표가 사라진다.
    """
    from _shared.thread_adapter import get_thread_adapter
    from _shared.ticket_id import parse_ticket

    parsed = parse_ticket(subject)
    if parsed is None:
        return None
    domain, thread_id = parsed
    adapter = get_thread_adapter(domain)
    if adapter is None:
        return None
    thread = adapter.thread_get(int(thread_id))
    if thread is None:
        return None
    tag = str(thread.get("subject_tag") or "").strip()
    return (domain, tag) if tag else None


def _classify_subject_for_poll(subject: str) -> tuple[str, str] | None:
    return (
        classify_subject_tag_from_subject(subject)
        # ★ 티켓번호는 태그보다 강하지만, 여기선 "우리 메일인가" 만 가른다.
        #   실제 스레드 확정은 `_shared.reply_match.match_inbound_thread` 가 한다.
        or _ticket_subject_tag(subject)
        or _test_subject_tag_from_subject(subject)
        or _service_test_subject_tag_from_subject(subject)
    )


def _extract_uid(headers: dict[str, str], uidl: str) -> str:
    cms = (headers.get("x-cms-mailid") or "").strip()
    mid = (headers.get("message-id") or "").strip().strip("<>")
    return cms or mid or f"uidl-{uidl}"


def _connect():
    global _POP3_DISABLED_REASON
    if _POP3_DISABLED_REASON:
        raise Pop3Disabled(_POP3_DISABLED_REASON)
    host = os.environ.get("POP3_HOST", "pop3.samsung.net")
    port = int(os.environ.get("POP3_PORT", "995"))
    user = os.environ.get("POP3_USER", "dssoc")
    password = os.environ.get("POP3_PASSWORD", "")
    if not password:
        raise Pop3Disabled("POP3_PASSWORD 미설정")
    timeout = float(os.environ.get("POP3_TIMEOUT", "60"))
    try:
        conn = poplib.POP3_SSL(host, port, timeout=timeout)
        conn.user(user)
        conn.pass_(password)
        return conn
    except poplib.error_proto as e:
        # 인증 실패 — lockout 예방 미러(계정 잠금 방지).
        _POP3_DISABLED_REASON = f"POP3 인증 실패 ({host}): {e} — 이번 프로세스 동안 차단"
        log.warning(_POP3_DISABLED_REASON)
        raise Pop3Disabled(_POP3_DISABLED_REASON) from e


def _parse_headers_only(top_lines: list[bytes]) -> dict[str, str]:
    raw = b"\r\n".join(top_lines)
    msg = email.message_from_bytes(raw)
    out: dict[str, str] = {}
    for k in (
        "subject", "from", "to", "cc", "date", "message-id", "in-reply-to",
        "references", "x-cms-mailid", "x-cms-rootmailid", "content-type",
    ):
        v = msg.get(k)
        if v is not None:
            out[k] = _decode(v) if k in ("subject", "from", "to", "cc") else v
    return out


def _header_received_at(headers: dict[str, str]) -> float:
    raw = (headers.get("date") or "").strip()
    if raw:
        try:
            dt = parsedate_to_datetime(raw)
            if dt.tzinfo is not None:
                ts = float(dt.timestamp())
                if 0 < ts < time.time() + 86400:
                    return ts
        except Exception:  # noqa: BLE001
            pass
    return time.time()


def _body_excerpt(raw_bytes: bytes, *, limit: int = 2000) -> str:
    """본문 텍스트 일부(마스킹 전 raw 는 격리 — 여기선 excerpt 만). plain 우선."""
    try:
        msg = email.message_from_bytes(raw_bytes)
    except Exception:  # noqa: BLE001
        return ""
    text = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                try:
                    text = part.get_payload(decode=True).decode(
                        part.get_content_charset() or "utf-8", errors="replace")
                    break
                except Exception:  # noqa: BLE001
                    continue
        if not text:
            for part in msg.walk():
                if part.get_content_type() == "text/html":
                    try:
                        html = part.get_payload(decode=True).decode(
                            part.get_content_charset() or "utf-8", errors="replace")
                        text = _html_visible_text(html)
                        break
                    except Exception:  # noqa: BLE001
                        continue
    else:
        try:
            text = msg.get_payload(decode=True).decode(
                msg.get_content_charset() or "utf-8", errors="replace")
            if msg.get_content_type() == "text/html":
                text = _html_visible_text(text)
        except Exception:  # noqa: BLE001
            text = ""
    text = _normalize_body_text(text)
    return text[:limit]


def _body_html(raw_bytes: bytes, *, limit: int = 95_000) -> str:
    """Return a sanitized HTML body fragment for reply-style quoting.

    The agent still reasons over `_body_excerpt()` visible text. This fragment is
    only used to render the quoted Original Message as HTML instead of escaping
    all tags into broken-looking text.
    """
    try:
        msg = email.message_from_bytes(raw_bytes)
    except Exception:  # noqa: BLE001
        return ""
    html = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() != "text/html":
                continue
            disposition = str(part.get("content-disposition") or "").lower()
            if "attachment" in disposition:
                continue
            try:
                html = part.get_payload(decode=True).decode(
                    part.get_content_charset() or "utf-8",
                    errors="replace",
                )
                break
            except Exception:  # noqa: BLE001
                continue
    elif msg.get_content_type() == "text/html":
        try:
            html = msg.get_payload(decode=True).decode(
                msg.get_content_charset() or "utf-8",
                errors="replace",
            )
        except Exception:  # noqa: BLE001
            html = ""
    if not html:
        return ""
    fragment = _html_body_fragment(html)
    fragment = _inline_cid_images(fragment, msg)
    return fragment[:limit]


def _cid_key(value: str) -> str:
    raw = str(value or "").strip().strip("<>").strip()
    if raw.lower().startswith("cid:"):
        raw = raw[4:]
    return raw.strip().lower()


def _inline_cid_images(html: str, msg: email.message.Message) -> str:
    """Rewrite cid: image references to data URIs when the MIME part is present."""
    if "cid:" not in (html or "").lower():
        return html
    images: dict[str, tuple[str, bytes]] = {}
    total = 0
    for part in msg.walk():
        ctype = str(part.get_content_type() or "")
        cid = _cid_key(str(part.get("content-id") or ""))
        if not cid or not ctype.startswith("image/"):
            continue
        data = part.get_payload(decode=True) or b""
        if not data or len(data) > _INLINE_IMAGE_MAX_BYTES:
            continue
        if total + len(data) > _INLINE_IMAGE_TOTAL_MAX_BYTES:
            continue
        images[cid] = (ctype, data)
        total += len(data)
    if not images:
        return html
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
        for img in soup.find_all("img"):
            src = str(img.get("src") or "")
            match = images.get(_cid_key(src))
            if not match:
                continue
            ctype, data = match
            img["src"] = f"data:{ctype};base64,{base64.b64encode(data).decode('ascii')}"
        return str(soup)
    except Exception:  # noqa: BLE001
        for cid, (ctype, data) in images.items():
            uri = f"data:{ctype};base64,{base64.b64encode(data).decode('ascii')}"
            html = re.sub(
                rf"(?i)cid:{re.escape(cid)}",
                uri.replace("\\", "\\\\"),
                html,
            )
        return html


def _html_body_fragment(html: str) -> str:
    """Keep renderable email HTML, dropping document/runtime-only wrappers."""
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html or "", "html.parser")
        for tag in soup(["script", "iframe", "object", "embed", "meta", "title", "base", "link"]):
            tag.decompose()
        root = soup.body or soup
        fragment = root.decode_contents() if getattr(root, "decode_contents", None) else str(root)
        return fragment.strip()
    except Exception:  # noqa: BLE001
        text = re.sub(
            r"(?is)<(script|iframe|object|embed|meta|title|base|link)\b[^>]*>.*?</\1>",
            " ",
            html or "",
        )
        text = re.sub(r"(?is)</?(?:html|body)\b[^>]*>", " ", text)
        return text.strip()


def _html_visible_text(html: str) -> str:
    """Knox HTML 답장에서 style/head/script 를 버리고 사람이 보는 본문만 추출."""
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html or "", "html.parser")
        for tag in soup(["style", "script", "head", "meta", "title", "noscript"]):
            tag.decompose()
        for br in soup.find_all("br"):
            br.replace_with("\n")
        return soup.get_text("\n")
    except Exception:  # noqa: BLE001
        text = re.sub(
            r"(?is)<(style|script|head|title|noscript|meta)\b[^>]*>.*?</\1>",
            " ",
            html or "",
        )
        text = re.sub(r"(?is)<br\s*/?>", "\n", text)
        text = re.sub(r"(?is)<[^>]+>", " ", text)
        return unescape(text)


def _normalize_body_text(text: str) -> str:
    lines = [re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in str(text or "").splitlines()]
    return "\n".join(line for line in lines if line).strip()


def new_reply_text(text: str) -> str:
    """Return only the human-authored reply before a quoted Original Message."""
    normalized = _normalize_body_text(text)
    if not normalized:
        return ""
    return _ORIGINAL_MESSAGE_RE.split(normalized, maxsplit=1)[0].strip()


def _owner_hint(text: str) -> dict[str, str]:
    match = _EMAIL_RE.search(text or "")
    return {"email": match.group(0)} if match else {}


def classify_service_reply_decision(subject: str, body_excerpt: str) -> dict[str, Any]:
    """Classify GitHub/Confluence remediation replies using only new reply text."""
    del subject
    reply_text = new_reply_text(body_excerpt)
    text = reply_text.lower()
    compact = re.sub(r"\s+", "", text)
    owner = _owner_hint(text)
    if not reply_text.strip():
        return {
            "decision": "unclear",
            "reason": "답장 신규 본문이 비어 있거나 확인되지 않아 재검증하지 않음",
            "owner": owner,
        }
    if (
        ("담당자" in text and any(k in text for k in ("변경", "바뀌", "이관", "교체", "후임", "새 담당")))
        or ("owner" in text and any(k in text for k in ("changed", "transfer", "new owner")))
    ):
        return {
            "decision": "owner_changed",
            "reason": "답장 신규 본문에서 담당자 변경/이관을 언급함",
            "owner": owner,
        }
    if (
        "담당자가아닙" in compact
        or "담당자아님" in compact
        or ("제가" in text and "담당" in text and any(k in text for k in ("아닙", "아니", "아님")))
        or ("not" in text and "owner" in text)
    ):
        return {
            "decision": "not_owner",
            "reason": "답장 신규 본문에서 본인이 담당자가 아니라고 밝힘",
            "owner": owner,
        }
    if any(k in text for k in ("업무 목적", "업무상", "업무적으로", "업무 필요", "운영상", "예외 승인", "예외처리")):
        return {
            "decision": "business_exception_claim",
            "reason": "답장 신규 본문에서 업무 목적/예외 필요성을 언급함",
            "owner": owner,
        }
    if (
        any(k in text for k in ("어떻게", "방법", "안내", "도와", "가이드", "문의", "알려주"))
        or any(k in text for k in ("how to", "how do", "help", "guide", "guidance"))
    ):
        return {
            "decision": "how_to_question",
            "reason": "답장 신규 본문에서 조치 방법 안내를 요청함",
            "owner": owner,
        }
    if (
        any(k in text for k in ("아직", "못했", "안됐", "안 되었", "어렵", "불가", "보류", "진행중"))
        or any(k in text for k in ("not fixed", "not resolved", "cannot", "can't", "pending", "in progress"))
    ):
        return {
            "decision": "still_needed",
            "reason": "답장 신규 본문에서 조치 미완료 또는 진행 중임을 언급함",
            "owner": owner,
        }
    if (
        any(k in compact for k in ("조치완료", "수정완료", "삭제완료", "해결완료"))
        or any(k in text for k in ("완료했습니다", "조치했습니다", "수정했습니다", "삭제했습니다", "해결했습니다", "반영했습니다", "폐기했습니다", "회수했습니다"))
        or any(k in text for k in ("fixed", "resolved", "removed", "remediated", "revoked", "rotated", "done"))
    ):
        return {
            "decision": "remediation_claim",
            "reason": "답장 신규 본문에서 조치 완료 주장을 확인함",
            "owner": owner,
        }
    return {
        "decision": "unclear",
        "reason": "답장 신규 본문에서 조치 완료 주장이나 HITL 사유를 명확히 확인하지 못함",
        "owner": owner,
    }


def poll_inbox(*, max_fetch: int = _FETCH_RECENT) -> dict[str, int]:
    """수신함을 passive 폴 — 조치요청 답장만 mail_message(direction='in')로 적재.

    반환: {scanned, matched, new, dedup_skipped, self_skipped}. DELE/flag 변경 절대 안 함.
    """
    if not pop3_enabled():
        log.info("[pop3] POP3_USER/PASSWORD 미설정 — 수신 skip")
        return {"scanned": 0, "matched": 0, "new": 0, "dedup_skipped": 0, "self_skipped": 0}

    state.heartbeat_upsert("reply_inbound", phase="poll", pid=os.getpid())
    try:
        conn = _connect()
    except Pop3Disabled as e:
        log.warning("[pop3] 연결 차단: %s", e)
        return {"scanned": 0, "matched": 0, "new": 0, "dedup_skipped": 0, "self_skipped": 0, "disabled": 1}

    scanned = matched = new = dedup = self_skipped = 0
    try:
        count = len(conn.list()[1])
        # UIDL 매핑 (msgnum → uidl).
        uidl_map: dict[int, str] = {}
        for line in conn.uidl()[1]:
            parts = line.decode("ascii", "replace").split()
            if len(parts) >= 2:
                uidl_map[int(parts[0])] = parts[1]
        start = max(1, count - max_fetch + 1)
        for msgnum in range(count, start - 1, -1):
            scanned += 1
            try:
                top_lines = conn.top(msgnum, 0)[1]
            except poplib.error_proto:
                continue
            headers = _parse_headers_only(top_lines)
            subject = headers.get("subject", "")
            classified = _classify_subject_for_poll(subject)
            if classified is None:
                continue  # 조치요청 답장 아님
            domain, tag = classified
            if _is_dssoc_sender(headers.get("from")):
                self_skipped += 1
                continue  # DSSOC 자체 발신/자동복사 메일은 답장으로 처리하지 않음
            matched += 1

            # ★ 스레드 확정은 **중복검사보다 먼저** 한다.
            #   티켓 번호가 도메인을 뒤집을 수 있는데(1차 키가 태그보다 강하다),
            #   중복검사가 도메인으로 테이블을 고른다(`mail_message` vs
            #   `service_reply_message`). 뒤에서 뒤집으면 **다른 테이블을 보고**
            #   중복이 아니라고 판단한 뒤 반대쪽에 적재한다.
            #   매칭 규칙 정본은 `_shared/reply_match` 한 곳 — 4도메인 동일.
            #   ⚠️ 이미 구한 분류를 넘긴다. 재분류하면 env 스모크 라우팅을 잃는다.
            from _shared.reply_match import match_inbound_thread

            mail_ts = _header_received_at(headers)
            match = match_inbound_thread(
                subject, received_at=mail_ts, classified=(domain, tag),
            ) or {}
            thread = match.get("thread")
            thread_id = match.get("thread_id") if thread else None
            if match.get("domain"):
                domain = str(match["domain"])
            if match.get("subject_tag"):
                tag = str(match["subject_tag"])
            if match.get("ticket_rejected"):
                # ⚠️ 조용히 폴백하지 않는다 — 티켓 표식이 있는데 못 붙었다는 건 사실이다.
                log.warning("[pop3] 티켓 표식 무시됨: %s (subject=%r)",
                            match["ticket_rejected"], subject[:80])

            uid = _extract_uid(headers, uidl_map.get(msgnum, str(msgnum)))
            # dedup — spawn/적재 전에 체크 (POP3 leave-on-server 재처리 방지, KEEP).
            existing = (
                state.mail_message_get_by_message_id(uid)
                if domain == "smb"
                else state.service_reply_message_get_by_message_id(uid)
            )
            if existing is not None:
                dedup += 1
                existing_html = str(existing.get("body_html") or "")
                needs_html_backfill = (
                    existing.get("direction") == "in"
                    and (not existing_html or "cid:" in existing_html.lower())
                )
                if needs_html_backfill:
                    try:
                        raw = b"\r\n".join(conn.retr(msgnum)[1])
                    except poplib.error_proto:
                        raw = b""
                    body_html = _body_html(raw)
                    if body_html and body_html != existing_html:
                        if domain == "smb":
                            state.mail_message_set_body_html(int(existing["id"]), body_html)
                        else:
                            state.service_reply_message_set_body_html(int(existing["id"]), body_html)
                continue
            # 본문 — SMB는 처리 가능한 thread만, 서비스 도메인은 나중에 thread가
            # 생성될 수 있어 unmatched 답장도 판단 감사 정보를 보존한다.
            excerpt = ""
            body_html = ""
            if thread_id is not None or domain != "smb":
                try:
                    raw = b"\r\n".join(conn.retr(msgnum)[1])
                except poplib.error_proto:
                    raw = b""
                excerpt = _body_excerpt(raw)
                body_html = _body_html(raw)
            service_decision: dict[str, Any] | None = None
            agent_verdict = "pending" if thread_id is not None else "unmatched"
            if domain != "smb":
                service_decision = classify_service_reply_decision(subject, excerpt)
                agent_verdict = f"classified_{service_decision['decision']}"
            from secu_agent.agent.redact import redact_sensitive_text
            common = {
                "direction": "in",
                "thread_id": thread_id,
                "message_id": uid,
                "received_at": mail_ts,
                "in_reply_to": headers.get("in-reply-to"),
                "references_header": headers.get("references"),
                "root_message_id": headers.get("x-cms-rootmailid"),
                "subject": subject,
                "subject_tag": tag,
                "mail_from": headers.get("from"),
                "mail_to": headers.get("to"),
                "mail_cc": headers.get("cc"),
                "body_excerpt": redact_sensitive_text(excerpt, force=True),
                "body_html": body_html or None,
                "agent_verdict": agent_verdict,
            }
            if domain == "smb":
                inserted = state.mail_message_add(**common)
            else:
                inserted = state.service_reply_message_add(
                    domain=domain,
                    **common,
                    decision_reason=(service_decision or {}).get("reason"),
                    extracted_owner=(service_decision or {}).get("owner") or {},
                )
            if inserted is None:
                dedup += 1
                continue
            new += 1
            # 스레드를 다음 처리 큐로 (있으면) → SMB는 reply_received,
            # GitHub/Confluence는 recheck_requested.
            if thread_id is not None:
                try:
                    if domain == "smb":
                        state.mail_thread_set_status(
                            thread_id,
                            "reply_received",
                            retry_after=None,
                            last_error_kind=None,
                            last_reason="inbound reply received",
                        )
                    elif service_decision is not None:
                        decision = str(service_decision["decision"])
                        status = state.service_report_thread_mark_reply_decision(
                            domain,
                            thread_id,
                            decision=decision,
                            reason=str(service_decision["reason"]),
                        )
                        log.info(
                            "[pop3] service reply domain=%s thread=%s decision=%s status=%s",
                            domain,
                            thread_id,
                            decision,
                            status,
                        )
                    else:
                        state.service_report_thread_mark_reply_received(domain, thread_id)
                except Exception:  # noqa: BLE001
                    pass
    finally:
        try:
            conn.quit()  # QUIT — DELE 없이 정상 종료 (메일 서버에 남김).
        except Exception:  # noqa: BLE001
            pass
    log.info("[pop3] scanned=%d matched=%d new=%d dedup=%d self_skipped=%d",
             scanned, matched, new, dedup, self_skipped)
    return {
        "scanned": scanned, "matched": matched, "new": new,
        "dedup_skipped": dedup, "self_skipped": self_skipped,
    }
