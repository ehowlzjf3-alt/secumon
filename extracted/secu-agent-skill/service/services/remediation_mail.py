"""조치요청 회신 3종 본문 빌더 (smb_domain_e2e 요구 9).

#3 답장·재검증 에이전트가 reverify 결과 + 답장 성격에 따라 회신:
  1. not_fixed  — 미조치(재검증 still_open): RE: 태그 유지하고 아직 열려 있음을 안내.
  2. how_to     — 방법 문의: Windows/Linux 공유 권한 변경 친절 안내(차후 '양식 메뉴' 확장).
  3. confirmed  — 조치 확인: "조치 확인했습니다. 감사합니다."

전부 egress gate(deliver knox_mail)로 발송 — 이 모듈은 제목/본문만 만든다.
제목은 RE: 접두 + 원 subject_tag 유지(스레드 correlation).
"""
from __future__ import annotations

import logging
import os

from email.utils import getaddresses
from html import escape
import re
import time
from typing import Any
from service.services import owner_recipients as orx


_SUBJECT_PREFIX_RE = re.compile(
    r"^\s*(?P<prefix>RE|FW|FWD|회신|답장|전달)\s*:\s*(?:\((?P<count>\d+)\)\s*)?",
    re.IGNORECASE,
)
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")

#: 메일 시스템이 붙이는 분류 표식. **우리 회신 제목에 되물려 내보내지 않는다.**
#: 사용자 지시(2026-08-31): "답변 에이전트는 [공문]표시 제거".
#: ⚠️ 우리가 붙이는 `[티켓 …]` 과 제목 태그 `[보안취약점 조치요청](…)` 은 건드리지 않는다 —
#:    앞의 것은 회신 매칭 1차 키이고 뒤의 것은 폴백이다. 여기서 지우면 스레드가 끊긴다.
_SYSTEM_SUBJECT_MARK_RE = re.compile(r"\[\s*(?:공문|대외비|사내한|외부발송)\s*\]\s*")


def strip_system_subject_marks(subject: str) -> str:
    """제목에서 메일 시스템 분류 표식만 걷어낸다."""
    return _SYSTEM_SUBJECT_MARK_RE.sub("", str(subject or "")).strip()


def reply_subject(subject_tag: str, *, original_subject: str | None = None) -> str:
    """회신 제목 — 최신 수신 제목 기준으로 RE 카운트를 증가시킨다.

    ⚠️ 받은 제목에 붙은 메일 시스템 표식(`[공문]` 등)은 **되물려 내보내지 않는다**
       (사용자 지시 2026-08-31). RE 카운트를 세기 전에 걷어야 표식이 접두 사이에
       끼어 있어도 잡힌다.
    """
    subject = strip_system_subject_marks(
        str(original_subject or "").strip() or str(subject_tag or "").strip()
    )
    rest = subject
    re_count = 0
    while True:
        match = _SUBJECT_PREFIX_RE.match(rest)
        if not match:
            break
        prefix = str(match.group("prefix") or "").lower()
        if prefix in {"re", "회신", "답장"}:
            raw_count = match.group("count")
            try:
                count = int(raw_count) if raw_count else 1
            except ValueError:
                count = 1
            re_count = max(re_count, count)
        rest = strip_system_subject_marks(rest[match.end():])
    rest = rest or str(subject_tag or "").strip()
    if re_count <= 0:
        base = f"RE: {rest}" if rest else "RE:"
    else:
        count = re_count + 1
        base = f"RE:({count}) {rest}" if rest else f"RE:({count})"
    return _mark_test_subject(base)


#: 회신 제한이 걸린 동안 붙이는 표식(사용자 요청 2026-09-01
#: "dssoc랑 shaneee.baek으로만 보내는 케이스에는 메일 구분되게 (test) 같은거 붙여주라").
_TEST_SUBJECT_MARK = "[TEST]"


def _mark_test_subject(subject: str) -> str:
    """회신이 **실제 담당자에게 가지 않는 동안**에는 제목에 표식을 단다.

    ⚠️ 표식이 없으면 받은 쪽(우리 팀함)이 진짜 나간 메일과 구분할 수 없다. 오늘
       09:09 에 실제 담당자에게 나간 것과 09:41 이후 시험분이 메일함에 섞여 있다.
    ⚠️ 제한이 풀리면 표식도 자동으로 사라진다 — 지우는 것을 잊어 진짜 메일에 [TEST] 가
       붙는 사고를 막는다.
    """
    if not reply_redirect_targets():
        return subject
    text = str(subject or "")
    if _TEST_SUBJECT_MARK in text:
        return text
    # ★ RE: 접두 **뒤**에 붙인다. 앞에 붙이면 회신 매칭의 RE 계산이 흔들린다.
    match = _SUBJECT_PREFIX_RE.match(text)
    if match:
        head = text[: match.end()]
        return f"{head}{_TEST_SUBJECT_MARK} {text[match.end():].lstrip()}"
    return f"{_TEST_SUBJECT_MARK} {text}"


def _mail_addresses(*values: Any) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for name, addr in getaddresses([str(v or "") for v in values if v is not None]):
        parsed = addr.strip() or str(name or "").strip()
        if not parsed or "@" not in parsed:
            continue
        lowered = parsed.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        out.append(parsed)
    return out


_DSSOC_DEFAULT = orx.DSSOC_DEFAULT


def _is_dssoc_address(addr: str, dssoc_recipients: list[str]) -> bool:
    value = addr.strip().lower()
    if not value:
        return False
    if orx.is_dssoc(value):
        return True
    for recipient in dssoc_recipients:
        for _, parsed in getaddresses([recipient]):
            if parsed and parsed.strip().lower() == value:
                return True
    return False


log = logging.getLogger(__name__)


def reply_targets(
    message: dict[str, Any],
    *,
    dssoc_recipients: list[str] | None = None,
) -> tuple[list[str], list[str]]:
    """받은 메일에 대한 회신 수신처 — **회신 상대(To) + DSSOC(Cc)**.

    사용자 정책(2026-08-24): 메일 수신처는 담당자 + DSSOC(자기 자신)다. 회신도 메일이므로
    같다 — DSSOC 는 **참조로 붙인다.**

    ★ 예전엔 DSSOC 를 To·Cc 양쪽에서 **빼기만** 했고, 그래서 우리 팀함에 회신 사본이 안 남았다.
      (메일 루프가 걱정이라면 이미 막혀 있다 — 수신 수집기가 `_our_sender_identities` 로
      우리가 보낸 메일을 알아본다.)

    ★ 그리고 수신자가 전부 걸러지면 **DSSOC 로만 보내는 폴백**이 있었다. 정책이 금지한
      상태이고, 더 나쁜 건 **누구에게 보낼지 모르는 상황을 발송 성공처럼 만든다**는 것이다.
      이제 빈 목록을 그대로 돌려준다 — 엔진이 `DeliveryError("TO 수신자가 없습니다.")` 로
      막고 발송 실패로 남는다. 조용히 팀함에 쌓이는 것보다 낫다.
    """
    dssoc = dssoc_recipients or [_DSSOC_DEFAULT]
    recipients = [
        addr for addr in _mail_addresses(message.get("mail_from"))
        if not _is_dssoc_address(addr, dssoc)
    ]
    cc: list[str] = []
    seen = {addr.lower() for addr in recipients}
    for addr in _mail_addresses(message.get("mail_to"), message.get("mail_cc")):
        lowered = addr.lower()
        if lowered in seen or _is_dssoc_address(addr, dssoc):
            continue
        cc.append(addr)
        seen.add(lowered)
    # DSSOC 를 참조로 붙인다(자기 자신 사본). To 에는 넣지 않는다 — 회신 상대가 To 다.
    for addr in dssoc:
        for _name, parsed in getaddresses([addr]):
            low = (parsed or "").strip().lower()
            if low and low not in seen:
                cc.append(parsed.strip())
                seen.add(low)
    # ⚠️ 폴백 없음. 비면 빈 채로 돌려준다 — 엔진이 막고 발송 실패로 남는다.
    return _apply_reply_redirect(recipients, cc)


#: 회신을 **지정한 주소로만** 보내는 임시 제한(사용자 요청 2026-09-01
#: "답변은 우선 dssoc랑 shaneee.baek으로만 나가도록 잠깐 막자").
#: 비어 있으면 평소대로 회신 상대에게 나간다.
REPLY_REDIRECT_ENV = "SA_REPLY_RECIPIENT_ONLY"


def reply_redirect_targets() -> list[str]:
    """제한이 걸려 있으면 그 주소 목록. 없으면 빈 목록."""
    raw = os.environ.get(REPLY_REDIRECT_ENV) or ""
    return [a.strip() for a in raw.replace(";", ",").split(",") if a.strip()]


def _apply_reply_redirect(
    recipients: list[str], cc: list[str],
) -> tuple[list[str], list[str]]:
    """회신 수신처를 지정 주소로 **바꿔친다**.

    ## 왜 여기인가

    회신은 정책상 열려 있다(사용자 결정: "답변 > 모두에게 열려있음"). 그래서 답장이
    들어오면 러너가 바로 실제 담당자에게 답한다 — 2026-09-01 09:00 에 실제로 나갔다.
    문안을 손보는 동안 그게 계속 나가면 안 되므로, **회신 수신처의 유일한 결정 지점**인
    여기서 막는다.

    ⚠️ 조용히 바꾸지 않는다. 실제 상대는 `cc` 에서도 빠지고 로그에 남는다 — 발송된 것을
       "담당자에게 갔다" 고 오해하면 안 된다.
    ⚠️ 임시다. 환경변수를 지우면 즉시 평소 동작으로 돌아온다.
    """
    only = reply_redirect_targets()
    if not only:
        return recipients, cc
    if recipients or cc:
        log.warning(
            "[reply] 회신 수신처를 제한한다(%s) — 원래 To=%s Cc=%s",
            REPLY_REDIRECT_ENV, recipients, cc,
        )
    return list(only), []


def allowed_pii_values(*values: Any) -> list[str]:
    out: list[str] = []
    for value in values:
        text = str(value or "")
        for addr in _EMAIL_RE.findall(text):
            lowered = addr.lower()
            if lowered not in out:
                out.append(lowered)
    return out


def _format_mail_ts(value: Any) -> str:
    try:
        ts = float(value)
    except (TypeError, ValueError):
        return ""
    if ts <= 0:
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))


def append_original_message(body: str, message: dict[str, Any] | None) -> str:
    """Append a reply-style quoted original message block under the new response."""
    if not message:
        return body
    sender = escape(str(message.get("mail_from") or ""))
    to = escape(str(message.get("mail_to") or ""))
    cc = escape(str(message.get("mail_cc") or ""))
    date = escape(_format_mail_ts(message.get("received_at")))
    subject = escape(str(message.get("subject") or ""))
    original = _original_message_body_html(message)
    meta = [
        ("Sender", sender),
        ("Date", date),
        ("Title", subject),
        ("To", to),
    ]
    if cc:
        meta.append(("Cc", cc))
    meta_html = "".join(
        f"<div><b>{label}</b> : {value}</div>" for label, value in meta if value
    )
    return body.rstrip() + f"""
<br/>
<div style="margin-top:24px;border-top:1px solid #cbd5e1;padding-top:12px;color:#475569">
<div>--------- Original Message ---------</div>
{meta_html}
<div style="margin-top:12px">{original}</div>
</div>"""


def _original_message_body_html(message: dict[str, Any]) -> str:
    html = str(message.get("body_html") or "")
    if html.strip():
        return _sanitize_original_html(html[:95_000])
    return escape(str(message.get("body_excerpt") or "")[:6000]).replace("\n", "<br/>")


def _sanitize_original_html(html: str) -> str:
    """Preserve email HTML for quoting while removing executable content."""
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html or "", "html.parser")
        for tag in soup(["script", "iframe", "object", "embed", "meta", "title", "base", "link"]):
            tag.decompose()
        for tag in soup.find_all(True):
            for attr in list(tag.attrs):
                name = attr.lower()
                value = " ".join(tag.get(attr)) if isinstance(tag.get(attr), list) else str(tag.get(attr) or "")
                lowered = value.strip().lower()
                if name.startswith("on"):
                    del tag.attrs[attr]
                elif name in {"href", "src"} and (
                    lowered.startswith("javascript:") or lowered.startswith("data:")
                ):
                    if not (tag.name == "img" and lowered.startswith("data:image/")):
                        del tag.attrs[attr]
                elif name == "style" and (
                    "javascript:" in lowered
                    or "data:" in lowered
                    or re.search(r"(?i)\b(?:url|expression)\s*\(", value)
                ):
                    del tag.attrs[attr]
        root = soup.body or soup
        fragment = root.decode_contents() if getattr(root, "decode_contents", None) else str(root)
        return fragment.strip()
    except Exception:  # noqa: BLE001
        cleaned = re.sub(
            r"(?is)<(script|iframe|object|embed|meta|title|base|link)\b[^>]*>.*?</\1>",
            " ",
            html or "",
        )
        cleaned = re.sub(r"(?is)</?(?:html|body)\b[^>]*>", " ", cleaned)
        return cleaned.strip()


def _access_labels(access: dict[str, Any]) -> list[str]:
    labels: list[str] = []
    if access.get("null_read"):
        labels.append("NULL 읽기")
    if access.get("guest_read"):
        labels.append("Guest 읽기")
    if access.get("auth_read"):
        labels.append("AUTH 읽기")
    if access.get("any_write"):
        labels.append("쓰기 가능")
    return labels


def _rows_table(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return ""
    body = []
    for row in rows:
        share = escape(str(row.get("share_path") or row.get("share") or "-"))
        access = escape(", ".join(row.get("access_labels") or []) or "접근 가능")
        scope = escape(str(row.get("scope") or "공유 루트"))
        status = escape(str(row.get("status") or "접근 가능"))
        body.append(
            "<tr>"
            f"<td>{share}</td>"
            f"<td>{access}</td>"
            f"<td>{scope}</td>"
            f"<td>{status}</td>"
            "</tr>"
        )
    return (
        "<table style=\"border-collapse:collapse;width:100%;margin:12px 0;font-size:13px\">"
        "<thead><tr>"
        "<th style=\"border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left\">공유 폴더</th>"
        "<th style=\"border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left\">남은 접근 권한</th>"
        "<th style=\"border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left\">재확인 범위</th>"
        "<th style=\"border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left\">상태</th>"
        "</tr></thead><tbody>"
        + "".join(
            row.replace("<td>", "<td style=\"border:1px solid #d9e2ec;padding:8px;vertical-align:top\">")
            for row in body
        )
        + "</tbody></table>"
    )


def reverify_open_rows(*, thread_id: int, host: str, limit: int = 50) -> list[dict[str, Any]]:
    """Return action-oriented open-share rows from structured reverify results."""
    from service import state_domain as state

    latest_by_scope: dict[tuple[str, str], dict[str, Any]] = {}
    for row in state.mail_reverify_results_for_thread(thread_id):
        share = str(row.get("share") or "").strip()
        if not share:
            continue
        path_prefix = str(row.get("path_prefix") or "").strip().strip("/")
        latest_by_scope[(share, path_prefix)] = row

    out: list[dict[str, Any]] = []
    for (share, path_prefix), row in latest_by_scope.items():
        access = row.get("access") if isinstance(row.get("access"), dict) else {}
        labels = _access_labels(access)
        verdict = str(row.get("verdict") or "")
        if verdict == "now_closed" or not labels:
            continue
        visible = row.get("files_visible")
        if visible is None:
            status = "공유 접근 가능"
        elif int(visible) < 0:
            status = "공유 접근 가능, 파일 목록 확인 실패"
        elif int(visible) == 0:
            status = "공유 접근 가능, 대상 파일은 미표시"
        else:
            status = f"공유 접근 가능, 파일 {int(visible):,}건 표시"
        out.append({
            "share": share,
            "share_path": f"\\\\{host}\\{share}",
            "access_labels": labels,
            "scope": path_prefix or "공유 루트",
            "status": status,
        })
        if len(out) >= limit:
            break
    return out


def host_open_share_rows(*, host: str, limit: int = 50) -> list[dict[str, Any]]:
    """Fallback rows from the current host report when reverify rows are unavailable."""
    from service.services import smb_reports

    try:
        report = smb_reports.smb_host_report(host, findings_only=False, limit_per_share=1)
    except Exception:  # noqa: BLE001
        return []
    out: list[dict[str, Any]] = []
    for share in report.get("shares") or []:
        access = share.get("access") or {}
        principals = access.get("principals") or {}
        labels: list[str] = []
        read = [str(x).upper() for x in principals.get("read") or []]
        if "NULL" in read:
            labels.append("NULL 읽기")
        if "GUEST" in read:
            labels.append("Guest 읽기")
        if (access.get("scope") or {}).get("auth_broad_readable"):
            labels.append("AUTH 읽기")
        if (access.get("share") or {}).get("write") or principals.get("write"):
            labels.append("쓰기 가능")
        if not labels:
            continue
        counts = share.get("counts") or {}
        out.append({
            "share": share.get("share"),
            "share_path": f"\\\\{host}\\{share.get('share')}",
            "access_labels": labels,
            "scope": "공유 루트",
            "status": f"파일 {int(counts.get('files_total') or 0):,}건 수집",
        })
        if len(out) >= limit:
            break
    return out


def build_not_fixed(
    *,
    host: str,
    owner_name: str = "담당자",
    detail: str = "",
    open_rows: list[dict[str, Any]] | None = None,
) -> str:
    name = escape(owner_name)
    rows = open_rows or []
    table = _rows_table(rows)
    detail_html = f" {escape(detail)}" if detail and not rows else ""
    return f"""<div style="font-family:'Malgun Gothic',sans-serif;line-height:1.7"><style>p{{margin:0 0 1.15em}}</style>
<p>{_addr(name)},</p>
<p>회신 주신 내용 확인했습니다. 다만 <b>{escape(host)}</b> 공유 폴더를 재점검한 결과
아래 공유 폴더의 접근 권한이 아직 남아 있습니다.{detail_html}</p>
{table}
<p>아래 사항을 다시 확인 부탁드립니다.</p>
<ul>
  <li>위 표에 표시된 NULL / Guest / AUTH 읽기 권한이 제거되었는지</li>
  <li>공유 목적에 맞는 계정 또는 그룹에만 권한이 남아 있는지</li>
  <li>쓰기 가능 공유는 필요한 계정에만 제한되었는지</li>
</ul>
<p>조치 후 본 메일에 다시 회신해 주시면 재확인하겠습니다. 감사합니다.<br/>DS보안관제</p>
</div>"""


def _addr(name: str) -> str:
    """호칭은 한 번만 — `김명규님님,` 이 실제로 나갔다(2026-09-01)."""
    from _shared.mail_subject import address_name

    return address_name(name)


def build_how_to(*, host: str, owner_name: str = "담당자", os_hint: str = "windows") -> str:
    """공유 폴더 권한 변경 방법 안내.

    ★ 절차 문구는 `domains/smb/plugin/reply_blocks` 가 **한 벌로** 갖는다 —
      회신 조립기(`_shared/reply_body`)의 블록과 같은 문자열이어야 한다.
      2026-08-31 이전엔 여기 인라인이었고, 블록을 만들면서 출처를 하나로 뒤집었다.
    """
    from domains.smb.plugin.reply_blocks import SMB_HOWTO_LINUX, SMB_HOWTO_WINDOWS

    name = escape(owner_name)
    low = os_hint.lower()
    body = (SMB_HOWTO_WINDOWS if low.startswith("win")
            else SMB_HOWTO_LINUX if low.startswith("lin")
            else SMB_HOWTO_WINDOWS + SMB_HOWTO_LINUX)
    return f"""<div style="font-family:'Malgun Gothic',sans-serif;line-height:1.7"><style>p{{margin:0 0 1.15em}}</style>
<p>{_addr(name)},</p>
<p>문의 주신 <b>{escape(host)}</b> 공유 폴더 권한 변경 방법을 안내드립니다.</p>
{body}
<p>조치 완료 후 본 메일에 회신해 주시면 재확인하겠습니다. 감사합니다.<br/>DS보안관제</p>
</div>"""


def build_confirmed(*, host: str, owner_name: str = "담당자") -> str:
    name = escape(owner_name)
    return f"""<div style="font-family:'Malgun Gothic',sans-serif;line-height:1.7"><style>p{{margin:0 0 1.15em}}</style>
<p>{_addr(name)},</p>
<p><b>{escape(host)}</b> 공유 폴더 조치를 재점검한 결과 정상적으로 접근이 차단된 것을
확인했습니다. 신속히 조치해 주셔서 감사합니다.</p>
<p>추가 문의사항이 있으시면 언제든 회신 부탁드립니다.<br/>DS보안관제</p>
</div>"""
