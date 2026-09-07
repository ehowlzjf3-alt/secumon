"""Confluence E2E report and remediation recheck services."""
from __future__ import annotations

import json
import os
import re
import time
from email.utils import getaddresses
from html import escape
from pathlib import Path
from typing import Any
from uuid import uuid4

from service import state_domain as state
from service.services.remediation_mail import (
    allowed_pii_values,
    append_original_message,
    reply_subject,
    reply_targets,
)
from service.services.finding_verification import is_agent_verified_extra
from secu_agent.agent.delivery import DeliveryPayload, deliver
from secu_agent import state as core_state
from secu_agent.detectors import scan_text
from secu_agent.detectors.secrets import find_high_entropy, mask_secret

from domains.services.application.report_cycles import (
    accumulated_week_label,
    notice_recurrence_label,
    should_show_recurrence,
    report_cycle_summary,
)
from service.services import owner_recipients as orx


_SPACE_RE = re.compile(r"^confluence:(?P<space>[^:/]+):(?P<page>[^/]+)")
_LEGACY_PAGE_RE = re.compile(r"^confluence:(?P<page>[^/]+)")
_DISPLAY_SPACE_RE = re.compile(r"/display/([^/?#]+)")
# ★ 신형 Confluence URL — `https://.../spaces/KEY[/pages/...]`.
#
# 이게 빠져 있어서 신규 finding 의 space_key 가 전부 `unknown` 으로 떨어졌고,
# `sync_report_threads` 가 `skipped_unknown_scope` 로 버려 리포트 스레드가 0행이었다
# (실측 2026-08-23: confluence finding 10건 중 5건이 이 형식).
#
# ⚠️ 게이트웨이(`digisecu-employee` `domains.py` 의 `SRC_EXPR["confluence"]`)는 이미
#    `/spaces/([^/]+)` 를 쓴다 — 같은 finding 을 게이트웨이는 `TPYE` 로, 여기서는
#    `unknown` 으로 읽고 있었다. **같은 개념을 두 곳에 적으면 어긋난다**(개인키 armor
#    정규식과 같은 사고). 아래 `test_space_key_matches_gateway_parser` 가 대조를 고정한다.
_SPACES_SPACE_RE = re.compile(r"/spaces/([^/?#]+)")
_VERSION_RE = re.compile(r"/version/(\d+)")
_COMMENT_RE = re.compile(r"/comment/(\d+)")
_ATTACHMENT_RE = re.compile(r"/attachment/([^/?#]+)")
_ATTACHMENT_DOWNLOAD_PAGE_RE = re.compile(r"/attachments/(?P<page_id>[^/?#]+)/")
# ── 담당자 수신자 해석 — SSOT 위임 ────────────────────────────────────────────
# 이 헬퍼 4개와 16키 목록이 github scanner·양쪽 webapp 에도 복사돼 있었다(4벌).
# 키 목록이 갈라진 탓에 생산자가 키를 바꿔도 아무도 못 알아챘다.
# ⚠️ confluence 는 읽는 쪽 키가 16개인데 **생산자가 하나도 안 쓴다**(스캐너 미배선) —
#    작성자를 넣기 전까지 담당자는 항상 빈다.
_csv = orx.csv
_iter_recipient_values = orx.iter_recipient_values
_is_internal_owner_email = orx.is_internal
_owner_recipient_list = orx.recipient_list


def _confluence_owner_recipients_from_extra(extra: dict[str, Any] | None) -> list[str]:
    return orx.from_extra(extra, orx.CONFLUENCE_KEYS)
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
_MAIL_BODY_LIMIT = 100_000
_CONFLUENCE_RECHECK_FINAL_STATUSES = {
    "recheck_requested",
    "remediated",
    "partially_remediated",
    "still_open",
    "exception_review",
}
_CONFLUENCE_RECHECK_VERDICTS = {"unknown", "still_open", "now_closed"}
_CONFLUENCE_RECHECK_DELIVERY_REQUIRED_STATUSES = {
    "remediated",
    "partially_remediated",
    "still_open",
}
_CONFLUENCE_AUTH_FAILURE_STATUS_CODES = {401}
_CONFLUENCE_LIMIT_FAILURE_STATUS_CODES = {429}
_CONFLUENCE_LIMIT_FAILURE_TEXT = (
    "abuse detection",
    "rate limit",
    "rate-limit",
    "rate_limited",
    "ratelimit",
    "retry-after",
    "secondary rate limit",
    "too many requests",
)


def _safe_evidence_label(value: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(value or ""))
    return (safe or "unknown")[:80]


def _http_status_code(error: Any) -> int | None:
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    if status is not None:
        try:
            return int(status)
        except (TypeError, ValueError):
            pass
    match = re.search(r"\bHTTP\s+(\d{3})\b", str(error))
    if match:
        return int(match.group(1))
    return None


def _confluence_api_auth_failed(error: Any) -> bool:
    return _http_status_code(error) in _CONFLUENCE_AUTH_FAILURE_STATUS_CODES


def _http_error_text(error: Any) -> str:
    parts = [repr(error)]
    response = getattr(error, "response", None)
    if response is not None:
        try:
            parts.append(str(response.text))
        except Exception:  # noqa: BLE001
            pass
        try:
            parts.extend(f"{k}: {v}" for k, v in response.headers.items())
        except Exception:  # noqa: BLE001
            pass
    return "\n".join(parts).lower()


def _confluence_api_limit_failed(error: Any) -> bool:
    status_code = _http_status_code(error)
    if status_code in _CONFLUENCE_LIMIT_FAILURE_STATUS_CODES:
        return True
    if status_code == 403:
        text = _http_error_text(error)
        return any(token in text for token in _CONFLUENCE_LIMIT_FAILURE_TEXT)
    return False


def _recipient() -> str:
    return (
        os.environ.get("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT")
        or os.environ.get("SA_DSSOC_MAIL_RECIPIENT")
        or "dssoc@samsung.com"
    )


def confluence_report_mail_subject(space_key: str) -> str:
    # ★ 대상(스페이스)은 **맨 뒤**로 — 4도메인 공용 조립기.
    from _shared.mail_subject import compose_subject

    return compose_subject(
        state.normalize_confluence_subject_tag(space_key), "콘텐츠 시크릿 조치 요청")







def _confluence_dssoc_recipients() -> list[str]:
    return (
        _csv(os.environ.get("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT"))
        or _csv(os.environ.get("SA_DSSOC_MAIL_RECIPIENT"))
        or ["dssoc@samsung.com"]
    )


def confluence_report_delivery_targets(
    owner_recipients: list[str] | None = None, *, manual: bool = False,
) -> dict[str, Any]:
    """조치요청 메일 수신처 — **담당자 + DSSOC**. DSSOC 만 보내는 건 드라이런 때뿐이다.

    규칙은 `owner_recipients.delivery_targets` 가 소유한다. 예전엔 4도메인이 같은 분기를
    각자 들고 있었고 기본값이 `dssoc_only` 였다 — 실발송이 켜져도 담당자가 빠지는 구멍이
    거기 있었다(자율발송 스위치와 수신처 스위치가 서로를 몰랐다).
    """
    return orx.delivery_targets(
        owner_recipients,
        mode_env="CONFLUENCE_REMEDIATION_MAIL_MODE",
        dssoc_env_names=("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT", "SA_DSSOC_MAIL_RECIPIENT"),
        manual=manual,
    )


def _mail_body(body: Any, *, limit: int = _MAIL_BODY_LIMIT) -> str:
    """길면 자른다. **잘렸다는 사실은 담당자에게 보여야 한다.**

    예전엔 `<!-- … truncated -->` HTML 주석이었다. 주석은 메일 클라이언트에서
    안 보이므로 담당자는 **본문이 잘린 줄도 몰랐다** — 조치 대상을 놓친다.

    ⚠️ 이 함수를 포함해 메일 본문 경로에 HTML 주석을 넣지 마라. 주석은 그대로
      실려 나가고, 우리에게만 의미 있는 내부 메모가 담당자에게 간다
      (2026-08-24 dev_web 에서 실제로 그럴 뻔했다).
    """
    raw = str(body or "")
    if len(raw) > limit:
        return raw[:limit].rstrip() + (
            '\n<p style="color:#8a6d3b">※ 본문이 길어 일부만 표시했습니다. '
            "전체 내용이 필요하시면 본 메일로 문의해 주세요.</p>"
        )
    return raw


def _record_outbound_message(
    thread: dict[str, Any],
    *,
    subject: str,
    body: str,
    recipients: list[str],
    cc: list[str] | None = None,
    message_kind: str,
    reply_message: dict[str, Any] | None = None,
) -> None:
    thread_id = int(thread["id"])
    space_key = str(thread.get("space_key") or "")
    state.service_reply_message_add(
        domain="confluence",
        direction="out",
        thread_id=thread_id,
        in_reply_to=(
            (reply_message or {}).get("message_id")
            or (reply_message or {}).get("in_reply_to")
        ),
        references_header=(reply_message or {}).get("references_header"),
        root_message_id=(reply_message or {}).get("root_message_id"),
        subject=subject,
        subject_tag=thread.get("subject_tag") or state.normalize_confluence_subject_tag(space_key),
        mail_from="dssoc",
        mail_to=", ".join(recipients) or None,
        mail_cc=", ".join(cc or []) or None,
        body_excerpt=body,
        body_html=body,
        agent_verdict="sent",
        decision_reason=message_kind,
    )


def _decision_from_service_message(message: dict[str, Any]) -> str | None:
    verdict = str(message.get("agent_verdict") or "")
    prefix = "classified_"
    return verdict[len(prefix):] if verdict.startswith(prefix) else None


def _attach_preexisting_replies(
    thread: dict[str, Any],
    *,
    space_key: str,
    received_after: float,
) -> list[dict[str, Any]]:
    thread_id = int(thread["id"])
    subject_tag = thread.get("subject_tag") or state.normalize_confluence_subject_tag(space_key)
    attached = state.service_reply_message_attach_unmatched(
        "confluence",
        str(subject_tag),
        thread_id,
        received_after=received_after,
    )
    if not attached:
        return []
    latest = attached[-1]
    decision = _decision_from_service_message(latest)
    if decision:
        reason = str(latest.get("decision_reason") or "pre-existing inbound reply attached")
        state.service_report_thread_mark_reply_decision(
            "confluence",
            thread_id,
            decision=decision,
            reason=f"pre-existing inbound replies attached: {len(attached)}; {reason}",
        )
    else:
        state.confluence_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            last_reason=f"pre-existing inbound replies attached: {len(attached)}",
        )
    return attached


def confluence_recheck_mail_subject(space_key: str) -> str:
    return f"RE: {state.normalize_confluence_subject_tag(space_key)} 콘텐츠 시크릿 재검증 결과"


def _html(text: str) -> str:
    return escape(str(text or ""), quote=True)


def _scan_trace_from_metadata(metadata: dict[str, Any]) -> dict[str, str]:
    """Return bounded API-search/detail trace fields for reports."""
    out: dict[str, str] = {}
    for key in ("scan_method", "candidate_source", "candidate_query"):
        value = str(metadata.get(key) or "").strip()
        if value:
            out[key] = value[:500]
    return out


def _confluence_recheck_evidence(item: dict[str, Any]) -> str:
    verification = item.get("verification") if isinstance(item.get("verification"), dict) else {}
    verdict = str(item.get("verdict") or "")
    parts: list[str] = []
    method = str(verification.get("method") or "").strip()
    if method:
        parts.append(method)
    if verification.get("matched") is True:
        parts.append("matched")
    elif verdict == "unknown":
        parts.append("unknown")
    elif verification.get("matched") is False:
        parts.append("clean")
    if "surface_count" in verification:
        try:
            parts.append(f"{int(verification.get('surface_count') or 0)} surface")
        except (TypeError, ValueError):
            pass
    labels = verification.get("surface_labels")
    if isinstance(labels, list):
        shown = [str(item).strip() for item in labels if str(item).strip()]
        if shown:
            parts.append("surfaces " + ", ".join(shown[:6]))
    if verification.get("status_code"):
        parts.append(f"HTTP {verification['status_code']}")
    if verification.get("auth_failed"):
        parts.append("auth_failed")
    if verification.get("limit_failed"):
        parts.append("limit_failed")
    if item.get("error"):
        parts.append(str(item["error"]))
    return " · ".join(parts) or "-"


def _confluence_recheck_body(thread: dict[str, Any], result: dict[str, Any]) -> str:
    from service.services.sensitive_summary import recheck_status_label

    space_key = _html(str(thread.get("space_key") or result.get("space_key") or ""))
    # ⚠️ 예전엔 `now_closed` 같은 엔진 내부 키가 그대로 나갔다(행별 `결과` 는 번역돼 있는데
    #    여기만 원문이라 같은 메일 안에서 어긋났다).
    final_status = _html(recheck_status_label(result.get("final_status")))
    rows: list[str] = []
    verdict_label = {
        "now_closed": "현재 콘텐츠에서 미검출",
        "still_open": "현재 콘텐츠에서 재확인",
        "unknown": "재검증 보류",
    }
    for item in result.get("results") or []:
        if not isinstance(item, dict):
            continue
        asset = _html(str(item.get("asset") or "-"))
        verdict = str(item.get("verdict") or "unknown")
        # ★ `검증 근거`(영문 내부 진단)와 `finding_id`(DB 내부 id) 열을 뺐다 — 조치요청
        #   메일에서 스캔 방식·후보 출처를 뺀 것과 같은 이유다. 우리 진단이지 담당자 일이 아니다.
        rows.append(
            "<tr>"
            f"<td>{asset}</td>"
            f"<td>{_html(verdict_label.get(verdict, verdict))}</td>"
            "</tr>"
        )
    if not rows:
        rows.append("<tr><td colspan=\"2\">표시할 재검증 항목이 없습니다.</td></tr>")
    status = str(result.get("final_status") or "")
    if status in {"still_open", "partially_remediated"}:
        guidance = "현재 콘텐츠에서 다시 확인되는 항목은 토큰 폐기/재발급과 페이지 또는 첨부 정리를 다시 확인해 주세요."
    elif status == "remediated":
        guidance = "현재 콘텐츠 기준으로 기존 항목이 확인되지 않았습니다. 노출된 값은 재사용 방지를 위해 폐기 상태를 유지해 주세요."
    else:
        guidance = "현재 콘텐츠 재확인이 보류되었습니다. 일시 오류나 접근 제한이 해소되면 다시 확인하겠습니다."
    return f"""<div style="font-family:'Malgun Gothic',Arial,sans-serif;line-height:1.6">
<p>안녕하세요.</p>
<p><b>{space_key}</b> Confluence 공간의 시크릿 조치 회신에 대한 재검증 결과를 안내드립니다.</p>
<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:13px">
  <tr>
    <th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">스페이스</th>
    <td style="border:1px solid #d9e2ec;padding:8px">{space_key}</td>
  </tr>
  <tr>
    <th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">재검증 상태</th>
    <td style="border:1px solid #d9e2ec;padding:8px">{final_status}</td>
  </tr>
</table>
<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:13px">
  <thead><tr>
    <th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">대상</th>
    <th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">결과</th>
  </tr></thead>
  <tbody>{''.join(rows)}</tbody>
</table>
<p>{_html(guidance)}</p>
<p>감사합니다.<br/>DS보안관제 (정보보호)</p>
</div>"""


def space_key_from_finding(row: dict[str, Any]) -> str:
    extra = row.get("extra") or {}
    metadata = extra.get("metadata") or {}
    if metadata.get("space_key"):
        return str(metadata["space_key"]).strip() or "unknown"
    asset = str(row.get("asset") or "")
    m = _SPACE_RE.search(asset)
    if m:
        return m.group("space") or "unknown"
    url = str(metadata.get("url") or asset)
    m = _DISPLAY_SPACE_RE.search(url)
    if m:
        return m.group(1) or "unknown"
    m = _SPACES_SPACE_RE.search(url)
    if m:
        return m.group(1) or "unknown"
    return "unknown"


def _page_id_from(row: dict[str, Any]) -> str | None:
    extra = row.get("extra") or {}
    metadata = extra.get("metadata") or {}
    if metadata.get("page_id"):
        return str(metadata["page_id"])
    asset = str(row.get("asset") or "")
    m = _SPACE_RE.search(asset) or _LEGACY_PAGE_RE.search(asset)
    return m.group("page") if m else None


def _invalid_page_id_reason(page_id: str) -> str | None:
    value = str(page_id or "").strip()
    if not value:
        return "missing page_id"
    if len(value) > 512:
        return "invalid page_id"
    if "/" in value or "\\" in value or _CONTROL_CHAR_RE.search(value):
        return "invalid page_id"
    return None


def _attachment_download_error(download_url: str, page_id: str) -> str | None:
    value = str(download_url or "").strip()
    if not value:
        return "attachment download_url not found"
    if (
        "\\" in value
        or "://" in value
        or value.startswith("//")
        or _CONTROL_CHAR_RE.search(value)
        or any(part == ".." for part in value.split("/"))
    ):
        return "attachment download_url invalid"
    if not _attachment_download_matches_page(value, page_id):
        return "attachment download_url outside page scope"
    return None


def _finding_rows(thread_id: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for fid in state.confluence_report_thread_finding_ids(thread_id):
        row = core_state.finding_get(fid)
        if row:
            rows.append(row)
    return rows


def sync_report_threads(*, limit: int = 500) -> dict[str, int]:
    """Ensure current Confluence findings have a space-scoped report thread."""
    counters = {
        "seen": 0,
        "new": 0,
        "merged": 0,
        "recurred": 0,
        "dup": 0,
        "skipped_unknown_scope": 0,
        "skipped_unverified": 0,
        "owner_recipient_count": 0,
        "owner_missing_count": 0,
    }
    active_statuses = ("open", "triaged")
    active_in = ",".join("?" for _ in active_statuses)
    with state.connect() as c:
        rows = c.execute(
            f"SELECT id FROM finding_lifecycle WHERE task_type='confluence' "
            f"AND status IN ({active_in}) "
            "ORDER BY last_seen DESC, id DESC LIMIT ?",
            (*active_statuses, max(1, min(int(limit), 5000))),
        ).fetchall()
    for r in rows:
        row = core_state.finding_get(int(r["id"]))
        if not row:
            continue
        counters["seen"] += 1
        if not is_agent_verified_extra(row.get("extra") or {}):
            counters["skipped_unverified"] += 1
            continue
        space_key = space_key_from_finding(row)
        if not space_key or space_key.lower() == "unknown":
            counters["skipped_unknown_scope"] += 1
            continue
        owner_list = _confluence_owner_recipients_from_extra(row.get("extra") or {})
        if owner_list:
            counters["owner_recipient_count"] += 1
        else:
            counters["owner_missing_count"] += 1
        owner_recipients = ", ".join(owner_list) or None
        action, _thread_id = state.confluence_report_thread_upsert(
            finding_id=int(row["id"]),
            space_key=space_key,
            severity=row.get("severity"),
            recipient=owner_recipients,
            owner_recipient=owner_recipients,
            status="reported",
        )
        counters[action] = counters.get(action, 0) + 1
    return counters


def build_report_for_thread(thread: dict[str, Any]) -> dict[str, Any]:
    """Build a Confluence space-focused report payload and HTML preview."""
    thread_id = int(thread["id"])
    space_key = str(thread.get("space_key") or "unknown")
    cycle_summary = report_cycle_summary(thread)
    findings = _finding_rows(thread_id)
    report_items: list[dict[str, Any]] = []
    out_of_scope_count = 0
    for row in findings:
        row_space = _finding_space_out_of_scope(row, space_key)
        if row_space is not None:
            out_of_scope_count += 1
            continue
        extra = row.get("extra") or {}
        metadata = extra.get("metadata") or {}
        verification = extra.get("verification") or {}
        report_items.append({
            "id": row["id"],
            "asset": row["asset"],
            "asset_kind": row["asset_kind"],
            "severity": row["severity"],
            "summary": row["summary"],
            "status": row["status"],
            "space_key": metadata.get("space_key") or space_key_from_finding(row),
            "page_id": metadata.get("page_id"),
            "title": metadata.get("title"),
            "url": metadata.get("url"),
            "filename": metadata.get("filename"),
            "version": metadata.get("version"),
            "verification_status": verification.get("status") or _default_verification_status(row),
            "scan_trace": _scan_trace_from_metadata(metadata),
            "hits": extra.get("hits") or [],
            "recommended_actions": extra.get("recommended_actions") or [],
        })
    counts: dict[str, int] = {}
    for item in report_items:
        key = str(item.get("verification_status") or "unknown")
        counts[key] = counts.get(key, 0) + 1
    html = _report_html(
        space_key, report_items, counts, cycle_summary=cycle_summary,
        sent_notice_count=state.thread_sent_notice_count("confluence", thread_id),
    )
    return {
        "space_key": space_key,
        "thread_id": thread_id,
        "finding_count": len(report_items),
        "out_of_scope_count": out_of_scope_count,
        **cycle_summary,
        "verification_counts": counts,
        "findings": report_items,
        "html": html,
    }


def _default_verification_status(row: dict[str, Any]) -> str:
    kind = str(row.get("asset_kind") or "")
    asset = str(row.get("asset") or "")
    if kind == "page_version" or "/version/" in asset:
        return "historical_version"
    if kind == "comment" or "/comment/" in asset:
        return "comment_surface"
    if kind == "attachment" or "/attachment/" in asset:
        return "attachment_surface"
    if kind == "page":
        return "current_page"
    return "submitted_surface"


def _report_html(
    space_key: str,
    items: list[dict[str, Any]],
    counts: dict[str, int],
    *,
    cycle_summary: dict[str, Any] | None = None,
    #: 이 스레드로 **실제로 나간** 안내 수. 재확인 문구의 유일한 근거다.
    sent_notice_count: int = 0,
) -> str:
    """Confluence 조치요청 메일 본문.

    ## 왜 다시 썼나

    예전 본문은 영문 `<h2>` 하나에 8열 원시 표였고, 그 표에 **`Masked hit` 열**과 스캔 진단
    (scan_method·candidate_source)이 들어 있었다. 받는 사람은 사내 담당자인데:
      · 값(masked hit)을 메일에 실으면 전달·회신으로 퍼져 **메일 자체가 노출 경로**가 된다.
      · 스캔 방식·후보 출처는 우리 내부 진단이지 담당자가 할 일이 아니다.
    SMB 조치요청 메일(실발송 253통으로 검증된 서식)과 같은 구조로 맞춘다.

    ## 무엇을 보여주고 무엇을 감추는가

    **그릇은 보여주고 내용물은 감춘다.** 담당자는 어느 **페이지**를 고쳐야 하는지 알아야 하므로
    위치는 싣고, 그 안에서 발견된 값은 안 싣는다. 민감 항목은 `sensitive_summary` 가
    **분류와 건수로만** 접어 준다(4도메인 공용 SSOT).

    `report_json` 에는 원본이 그대로 남는다 — 줄이는 건 메일 본문뿐이다.
    """
    from service.services import sensitive_summary

    sensitive = sensitive_summary.merge_counts(
        *[sensitive_summary.sensitive_counts(item.get("hits")) for item in items])

    rows = []
    for item in items:
        location = item.get("title") or item.get("filename") or item.get("asset")
        rows.append(
            "<tr>"
            f'<td style="border:1px solid #d9e2ec;padding:8px">'
            f"{_html(str(item.get('severity') or '-'))}</td>"
            f'<td style="border:1px solid #d9e2ec;padding:8px;word-break:break-all">'
            f"<code>{_html(str(location or '-'))}</code></td>"
            f'<td style="border:1px solid #d9e2ec;padding:8px">'
            f"{_html(str(item.get('asset_kind') or '-'))}</td>"
            f'<td style="border:1px solid #d9e2ec;padding:8px">'
            f"{_html(str(item.get('verification_status') or '-'))}</td>"
            "</tr>"
        )
    page_table = (
        '<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:13px">'
        "<thead><tr>"
        '<th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">심각도</th>'
        '<th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">위치</th>'
        '<th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">유형</th>'
        '<th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">확인 상태</th>'
        f"</tr></thead><tbody>{''.join(rows)}</tbody></table>"
    ) if rows else ""

    # ★ 스캔 주차가 아니라 **발송 횟수**로 말한다 — github/smb/dev_web 과 같은 규칙.
    recurrence_notice = ""
    if should_show_recurrence(sent_notice_count):
        recurrence_notice = (
            "<div style='border-left:4px solid #c53030;background:#fff5f5;"
            "padding:12px 14px;margin:14px 0;color:#742a2a'>"
            f"<strong>{_html(notice_recurrence_label(sent_notice_count))}</strong><br>"
            "이전에 안내드린 Confluence 콘텐츠 시크릿 항목이 이번 주 점검에서도 다시 확인되었습니다. "
            "값 폐기/재발급과 콘텐츠 정리를 한 번 더 점검해 주시기 바랍니다.</div>"
        )
    verified = counts.get("verified") or counts.get("agent_verified") or 0
    count_line = f"확인된 항목 {len(items)}건" + (f" (검증 {verified}건)" if verified else "")

    return (
        "<!doctype html><html><head><meta charset='UTF-8'></head>"
        "<body style=\"font-family:'Malgun Gothic',sans-serif;font-size:14px;"
        'line-height:1.7;color:#263238">'
        '<div style="max-width:900px;margin:0 auto">'
        '<div style="background:#2d3a5a;color:#fff;padding:18px 22px">'
        '<h1 style="margin:0;font-size:19px">Confluence 콘텐츠 조치 요청</h1>'
        '<p style="margin:4px 0 0;font-size:12px;opacity:.85">'
        "삼성전자 DS 정보보호센터 · DS보안관제</p></div>"
        '<div style="background:#fff;padding:22px">'
        "<p>담당자님,</p>"
        "<p>DS보안관제에서 Confluence 스페이스 콘텐츠 점검 결과를 안내드립니다. "
        "아래 페이지의 공개 범위와 내용을 확인해 주세요.</p>"
        f"{recurrence_notice}"
        '<div style="background:#f7fafc;border:1px solid #e2e8f0;padding:14px;margin:14px 0">'
        f"<div><small>대상 스페이스</small> <strong>{_html(space_key)}</strong></div>"
        f"<div><small>확인 내용</small> <strong>{_html(count_line)}</strong></div>"
        "<div><small>요청 사항</small> <strong>값 폐기·재발급 및 콘텐츠 정리</strong></div>"
        f"{sensitive_summary.exposure_metric_html(len(items), sensitive)}"
        "</div>"
        f"{sensitive_summary.credential_notice_html(sensitive)}"
        '<div class="section-title"><span>■</span>내용</div>'
        "<p>점검 결과, 스페이스 콘텐츠에서 외부 저장이 필요한 값이나 내부 정보가 확인되었습니다. "
        "페이지 본문뿐 아니라 댓글·첨부·이전 버전에도 같은 값이 남아 있을 수 있습니다.</p>"
        f"{sensitive_summary.summary_html(sensitive, container_word='스페이스 콘텐츠')}"
        f"{sensitive_summary.actions_html(sensitive)}"
        '<div class="section-title"><span>■</span>확인된 페이지</div>'
        "<p>아래 위치를 확인해 주세요.</p>"
        f"{page_table}"
        '<div class="section-title"><span>■</span>조치 방법</div>'
        "<ol>"
        "<li>페이지와 스페이스의 소유자를 먼저 확인한 뒤 변경해 주세요.</li>"
        "<li>운영 중인 자격증명이나 민감한 값은 승인된 비밀 저장소로 옮겨 주세요.</li>"
        "<li>연결된 페이지, 댓글, 첨부파일, 이전 버전도 함께 점검해 주세요.</li>"
        "<li>스페이스 공개 범위가 업무 목적에 맞는지 확인해 주세요.</li>"
        "</ol>"
        "<p>조치 완료 후 본 메일에 회신해 주시면 DS보안관제에서 재확인하겠습니다.</p>"
        '<div style="margin-top:18px;color:#4a5568">'
        "<p>감사합니다.</p><p><strong>DS보안관제 (정보보호)</strong></p></div>"
        "</div></div></body></html>"
    )


def mark_report_ready(thread: dict[str, Any], report: dict[str, Any]) -> None:
    thread_id = int(thread["id"])
    if _report_finding_count(report) <= 0:
        _mark_empty_report_error(thread_id, report, action="ready")
        return
    state.confluence_report_thread_set_status(
        thread_id,
        "report_ready",
        report_json=json.dumps(
            {k: v for k, v in report.items() if k != "html"},
            ensure_ascii=False,
            sort_keys=True,
        ),
        report_html=report.get("html"),
        last_reason=f"report built with {report.get('finding_count', 0)} findings",
    )
    state.confluence_report_thread_bump_attempt(thread_id, reason="report built")


def _report_finding_count(report: dict[str, Any]) -> int:
    if "finding_count" in report:
        try:
            return int(report.get("finding_count") or 0)
        except (TypeError, ValueError):
            return 0
    findings = report.get("findings")
    return len(findings) if isinstance(findings, list) else 0


def _mark_empty_report_error(thread_id: int, report: dict[str, Any], *, action: str) -> str:
    out_of_scope = int(report.get("out_of_scope_count") or 0)
    reason = f"report {action} skipped: no in-scope findings (out_of_scope_count={out_of_scope})"
    state.confluence_report_thread_set_status(
        thread_id,
        "error",
        report_json="{}",
        report_html=None,
        notified_at=None,
        last_reason=reason,
    )
    return reason


def _skip_empty_report_delivery(thread_id: int, report: dict[str, Any]) -> dict[str, Any]:
    reason = _mark_empty_report_error(thread_id, report, action="delivery")
    return {
        "mode": "skipped_empty_report",
        "detail": reason,
        "recipients": [],
        "cc": [],
        "policy": "blocked_empty_report",
        "subject": None,
        "draft_path": None,
        "scan_hits": [],
        "attached_replies": 0,
    }


async def deliver_report_for_thread(
    thread: dict[str, Any],
    report: dict[str, Any],
    *,
    evidence_dir: Path,
    charter_ref: str = "",
) -> dict[str, Any]:
    """Deliver a built Confluence report through the core egress gate."""
    thread_id = int(thread["id"])
    if _report_finding_count(report) <= 0:
        return _skip_empty_report_delivery(thread_id, report)
    space_key = str(thread.get("space_key") or report.get("space_key") or "unknown")
    requested = _owner_recipient_list([thread.get("owner_recipient") or thread.get("recipient")])
    targets = confluence_report_delivery_targets(requested)
    subject = confluence_report_mail_subject(space_key)
    # ★ 티켓번호를 제목 앞에 찍는다 — 회신 매칭의 1차 키다.
    #   기존 제목 태그는 지우지 않는다(폴백 경로가 그걸 본다).
    subject = state.stamp_subject_for_thread(subject, "confluence", thread_id)
    body = _mail_body(report.get("html"))
    payload = DeliveryPayload(
        subject=subject,
        body=body,
        recipients=tuple(targets["recipients"]),
        cc=tuple(targets["cc"]),
        finding_id=int(thread.get("finding_id") or 0) or None,
        metadata={
            "domain": "confluence",
            "thread_id": thread_id,
            "space_key": space_key,
            "delivery_policy": targets["mode"],
            "requested_recipients": [r for r in requested if r],
            "cycle_key": thread.get("last_cycle_key"),
        },
    )
    # ★ 자동 최초 발송이 닫혀 있으면 **발송을 시도하지 않는다** ("제작까지만").
    #   수신처가 비어 있어 그대로 부르면 sink 가 "TO 수신자가 없습니다" 로 매분 터진다
    #   (리포트 러너는 간격 0분 = 매분 실행, 대기 큐 수백 건).
    #   초안(report_json/report_html)은 이미 위에서 만들어 저장했다.
    if str(targets.get("mode") or "") == "initial_closed":
        state.confluence_report_thread_set_status(
            thread_id, "report_ready",
            last_reason=str(targets.get("reason") or "자동 최초 발송 닫힘 — 초안만 저장"),
        )
        return {
            "mode": "initial_closed", "sent": False,
            "reason": targets.get("reason"),
            "note": "초안만 저장했다. 발송하려면 콘솔에서 수동 승인하라.",
        }

    delivery_started_at = time.time()
    result = await deliver(
        "knox_mail",
        payload,
        evidence_dir=Path(evidence_dir),
        charter_ref=charter_ref,
    )
    if result.mode == "sent":
        state.confluence_report_thread_set_status(
            thread_id,
            "awaiting_owner",
            recipient=", ".join(targets["recipients"]) or None,
            notified_at=time.time(),
            last_reason="report mailed",
        )
        _record_outbound_message(
            thread,
            subject=subject,
            body=body,
            recipients=list(targets["recipients"]),
            cc=list(targets["cc"]),
            message_kind="outbound_report_notice",
        )
        attached_replies = _attach_preexisting_replies(
            thread,
            space_key=space_key,
            received_after=delivery_started_at,
        )
    else:
        attached_replies = []
        state.confluence_report_thread_set_status(
            thread_id,
            "report_ready",
            last_reason=result.detail[:500],
        )
    return {
        "mode": result.mode,
        "detail": result.detail,
        "recipients": list(targets["recipients"]),
        "cc": list(targets["cc"]),
        "policy": targets["mode"],
        "subject": subject,
        "draft_path": result.draft_path,
        "scan_hits": list(result.scan_hits),
        "attached_replies": len(attached_replies),
    }


def finalize_confluence_recheck_result(
    thread: dict[str, Any],
    result: dict[str, Any],
    *,
    mailed: bool = False,
    recipient: str | None = None,
) -> str:
    thread_id = int(thread["id"])
    final_status = _confluence_recheck_result_final_status(result)
    if not mailed and final_status in _CONFLUENCE_RECHECK_DELIVERY_REQUIRED_STATUSES:
        state.confluence_report_thread_schedule_recheck_retry(
            thread_id,
            reason=f"recheck {final_status} blocked until result mail is sent",
        )
        return "recheck_requested"
    fields: dict[str, Any] = {"last_reason": f"recheck {final_status}"}
    if mailed:
        fields["last_reason"] = f"recheck {final_status}; result mailed"
        fields["notified_at"] = time.time()
        if recipient:
            fields["recipient"] = recipient
    state.confluence_report_thread_set_status(thread_id, final_status, **fields)
    for item in result.get("results") or []:
        if not isinstance(item, dict) or item.get("verdict") != "now_closed":
            continue
        try:
            core_state.finding_set_status(
                int(item["finding_id"]),
                "remediated",
                reason="confluence recheck now_closed",
            )
        except Exception:
            pass
    return final_status


async def deliver_recheck_result_for_thread(
    thread: dict[str, Any],
    result_payload: dict[str, Any],
    *,
    evidence_dir: Path,
    charter_ref: str = "",
) -> dict[str, Any]:
    """Notify the Confluence recheck result and finalize only after send."""
    thread_id = int(thread["id"])
    safe_final_status = _confluence_recheck_result_final_status(result_payload)
    if safe_final_status == "recheck_requested":
        reason = "recheck result delivery skipped: no conclusive structured results"
        retry_after = state.confluence_report_thread_schedule_recheck_retry(thread_id, reason=reason)
        return {
            "mode": "skipped_retryable_recheck",
            "detail": reason,
            "recipients": [],
            "cc": [],
            "policy": "blocked_retryable_recheck",
            "subject": None,
            "draft_path": None,
            "scan_hits": [],
            "final_status": "recheck_requested",
            "retry_after": retry_after,
        }
    result_payload = {**result_payload, "final_status": safe_final_status}
    space_key = str(thread.get("space_key") or result_payload.get("space_key") or "unknown")
    reply_message = state.service_reply_message_latest_inbound_after_latest_outbound(
        "confluence",
        thread_id,
        fallback_outbound_at=thread.get("notified_at"),
    )
    requested = _owner_recipient_list([thread.get("owner_recipient") or thread.get("recipient")])
    if reply_message is not None:
        recipients, cc = reply_targets(
            reply_message,
            dssoc_recipients=_confluence_dssoc_recipients(),
        )
        targets = {"mode": "reply_to_inbound_sender", "recipients": recipients, "cc": cc}
        subject = reply_subject(
            thread.get("subject_tag") or state.normalize_confluence_subject_tag(space_key),
            original_subject=str(reply_message.get("subject") or ""),
        )
    else:
        targets = confluence_report_delivery_targets(requested)
        subject = confluence_recheck_mail_subject(space_key)
    # ★ 재검증 결과 회신에도 같은 티켓을 찍는다 — 담당자가 다시 답장하면 붙는다.
    #   ⚠️ if/else **밖**이다. 처음엔 else 가지(신규 발송)에만 넣었는데, 정작 중요한 건
    #      위쪽 가지 — **담당자 답장에 회신하는** 경로다. 거기 안 찍으면 다음 왕복부터
    #      티켓 1차 키가 사라지고 제목 태그 폴백으로 되돌아간다.
    subject = state.stamp_subject_for_thread(subject, "confluence", thread_id)
    body = _confluence_recheck_body(thread, result_payload)
    if reply_message is not None:
        body = append_original_message(body, reply_message)
    metadata = {
        "domain": "confluence",
        "thread_id": thread_id,
        "space_key": space_key,
        "delivery_policy": targets["mode"],
        "content_type": "HTML",
        "requested_recipients": [r for r in requested if r],
        "cycle_key": thread.get("last_cycle_key"),
        "recheck_final_status": result_payload.get("final_status"),
    }
    if reply_message is not None:
        metadata.update({
            "reply_message_id": int(reply_message["id"]),
            "in_reply_to": reply_message.get("message_id") or reply_message.get("in_reply_to"),
            "references": reply_message.get("references_header"),
            "root_message_id": reply_message.get("root_message_id"),
            "delivery_allowed_pii_values": allowed_pii_values(
                reply_message.get("mail_from"),
                reply_message.get("mail_to"),
                reply_message.get("mail_cc"),
                *targets["recipients"],
                *targets["cc"],
            ),
        })
    payload = DeliveryPayload(
        subject=subject,
        body=body,
        recipients=tuple(targets["recipients"]),
        cc=tuple(targets["cc"]),
        finding_id=int(thread.get("finding_id") or 0) or None,
        metadata=metadata,
    )
    delivery = await deliver(
        "knox_mail",
        payload,
        evidence_dir=Path(evidence_dir),
        charter_ref=charter_ref,
    )
    retry_after = None
    if delivery.mode == "sent":
        final_status = finalize_confluence_recheck_result(
            thread,
            result_payload,
            mailed=True,
            recipient=", ".join(targets["recipients"]) or None,
        )
        _record_outbound_message(
            thread,
            subject=subject,
            body=body,
            recipients=list(targets["recipients"]),
            cc=list(targets["cc"]),
            message_kind="outbound_recheck_result_notice",
            reply_message=reply_message,
        )
    else:
        final_status = "recheck_requested"
        retry_after = state.confluence_report_thread_schedule_recheck_retry(
            thread_id,
            reason=f"recheck result delivery {delivery.mode}: {delivery.detail or 'not sent'}",
        )
    return {
        "mode": delivery.mode,
        "detail": delivery.detail,
        "recipients": list(targets["recipients"]),
        "cc": list(targets["cc"]),
        "policy": targets["mode"],
        "subject": subject,
        "draft_path": delivery.draft_path,
        "scan_hits": list(delivery.scan_hits),
        "final_status": final_status,
        "retry_after": retry_after,
    }


def _original_hit_signatures(row: dict[str, Any]) -> set[tuple[str, str]]:
    extra = row.get("extra") or {}
    out: set[tuple[str, str]] = set()
    for hit in extra.get("hits") or []:
        if not isinstance(hit, dict):
            continue
        kind = str(hit.get("kind") or "")
        masked = str(hit.get("masked") or "")
        if kind and masked:
            out.add((kind, masked))
    return out


def _current_hit_signatures(text: str) -> set[tuple[str, str]]:
    result = scan_text(text, label="confluence-recheck")
    out = {(h.kind, h.masked) for h in result.hits}
    taken = [h.span for h in result.hits]
    for he in find_high_entropy(text):
        if any(start <= he.span[0] < end for start, end in taken):
            continue
        out.add(("high_entropy_string", mask_secret(he.matched)))
    return {x for x in out if x[0] and x[1]}


def _finding_space_out_of_scope(row: dict[str, Any], space_key: str) -> str | None:
    row_space = space_key_from_finding(row)
    if row_space and row_space != "unknown" and row_space.lower() != str(space_key or "").lower():
        return row_space
    return None


def _confluence_recheck_final_status(results: list[dict[str, Any]]) -> str:
    if not results:
        return "recheck_requested"
    verdicts = {str(r.get("verdict") or "unknown") for r in results}
    if any(v not in _CONFLUENCE_RECHECK_VERDICTS for v in verdicts):
        return "recheck_requested"
    if "unknown" in verdicts:
        return "recheck_requested"
    still_open = "still_open" in verdicts
    now_closed = "now_closed" in verdicts
    if still_open and now_closed:
        return "partially_remediated"
    if still_open:
        return "still_open"
    if now_closed:
        return "remediated"
    return "recheck_requested"


def _confluence_recheck_result_final_status(result: dict[str, Any]) -> str:
    results = result.get("results")
    if not isinstance(results, list):
        return "recheck_requested"
    final_status = _confluence_recheck_final_status(results)
    return final_status if final_status in _CONFLUENCE_RECHECK_FINAL_STATUSES else "recheck_requested"


def recheck_thread(
    thread: dict[str, Any],
    *,
    evidence_dir: Path,
    finalize: bool = True,
    charter_ref: str = "",
) -> dict[str, Any]:
    """Re-fetch Confluence surfaces and classify each thread finding."""
    thread_id = int(thread["id"])
    space_key = str(thread.get("space_key") or "unknown")
    results: list[dict[str, Any]] = []
    ev_dir = Path(evidence_dir)
    ev_dir.mkdir(parents=True, exist_ok=True)
    evidence_ref = ev_dir / f"confluence_recheck_{_safe_evidence_label(space_key)}_{uuid4().hex[:12]}.json"
    auth_failed = False
    limit_failed = False

    for row in _finding_rows(thread_id):
        try:
            row_space = _finding_space_out_of_scope(row, space_key)
            if row_space is not None:
                verdict = "unknown"
                verification = {
                    "method": "confluence_surface_refetch",
                    "matched": False,
                    "surface_count": 0,
                    "surface_labels": [],
                    "space_key": row_space,
                }
                error = f"finding space outside thread scope: {row_space}"
                state.confluence_recheck_result_add(
                    thread_id=thread_id,
                    finding_id=int(row["id"]),
                    space_key=space_key,
                    asset=str(row.get("asset") or ""),
                    verdict=verdict,
                    verification=verification,
                    error=error,
                )
                results.append({
                    "finding_id": row["id"],
                    "asset": row.get("asset"),
                    "verdict": verdict,
                    "verification": verification,
                    "error": error,
                })
                continue
            signatures = _original_hit_signatures(row)
            text_payloads, fetch_error = _fetch_recheck_text(row)
            surface_labels = [
                str(item.get("label") or "")
                for item in text_payloads
                if isinstance(item, dict) and str(item.get("label") or "").strip()
            ]
            if fetch_error:
                verdict = "unknown"
                verification = {
                    "method": "confluence_surface_refetch",
                    "matched": False,
                    "surface_count": len(text_payloads),
                    "surface_labels": surface_labels,
                }
                status_code = _http_status_code(fetch_error)
                if status_code is not None:
                    verification["status_code"] = status_code
                if _confluence_api_auth_failed(fetch_error):
                    auth_failed = True
                    verification["auth_failed"] = True
                if _confluence_api_limit_failed(fetch_error):
                    limit_failed = True
                    verification["limit_failed"] = True
                state.confluence_recheck_result_add(
                    thread_id=thread_id,
                    finding_id=int(row["id"]),
                    space_key=space_key,
                    asset=str(row.get("asset") or ""),
                    verdict=verdict,
                    verification=verification,
                    error=fetch_error,
                )
            else:
                current: set[tuple[str, str]] = set()
                for item in text_payloads:
                    current |= _current_hit_signatures(str(item.get("text") or ""))
                matched = bool(signatures & current)
                verdict = "still_open" if matched else "now_closed"
                verification = {
                    "method": "confluence_surface_refetch",
                    "matched": matched,
                    "surface_count": len(text_payloads),
                    "surface_labels": surface_labels,
                }
                state.confluence_recheck_result_add(
                    thread_id=thread_id,
                    finding_id=int(row["id"]),
                    space_key=space_key,
                    asset=str(row.get("asset") or ""),
                    verdict=verdict,
                    verification=verification,
                )
            results.append({
                "finding_id": row["id"],
                "asset": row.get("asset"),
                "verdict": verdict,
                "verification": verification,
                "error": fetch_error,
            })
        except Exception as exc:  # noqa: BLE001
            err = repr(exc)[:500]
            verification = {
                "method": "confluence_surface_refetch",
                "matched": False,
                "surface_count": 0,
                "surface_labels": [],
            }
            status_code = _http_status_code(exc)
            if status_code is not None:
                verification["status_code"] = status_code
            if _confluence_api_auth_failed(exc):
                auth_failed = True
                verification["auth_failed"] = True
            if _confluence_api_limit_failed(exc):
                limit_failed = True
                verification["limit_failed"] = True
            state.confluence_recheck_result_add(
                thread_id=thread_id,
                finding_id=int(row.get("id") or 0) or None,
                space_key=space_key,
                asset=str(row.get("asset") or ""),
                verdict="unknown",
                verification=verification,
                error=err,
            )
            results.append({
                "finding_id": row.get("id"),
                "asset": row.get("asset"),
                "verdict": "unknown",
                "verification": verification,
                "error": err,
            })

    final_status = _confluence_recheck_final_status(results)
    payload = {
        "kind": "confluence_recheck_evidence",
        "created_at": time.time(),
        "thread_id": thread_id,
        "space_key": space_key,
        "final_status": final_status,
        "auth_failed": auth_failed,
        "limit_failed": limit_failed,
        "results": results,
    }
    if charter_ref:
        payload["charter_ref"] = charter_ref
    evidence_ref.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    result = {
        "space_key": space_key,
        "thread_id": thread_id,
        "final_status": final_status,
        "auth_failed": auth_failed,
        "limit_failed": limit_failed,
        "results": results,
        "evidence_ref": str(evidence_ref),
    }
    if charter_ref:
        result["charter_ref"] = charter_ref
    if finalize:
        result["final_status"] = finalize_confluence_recheck_result(thread, result)
    return result


def _fetch_recheck_text(row: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
    """재검증용 본문 재조회 — **브라우저 전용** (2026-08-26).

    ★ 예전엔 REST 였다(`cf.fetch_page_body`/`list_comments`/`fetch_page_body_version`/
      `list_attachments`/`fetch_attachment_text`). 그 엔드포인트는 죽어 있다 —
      `/rest/api/content` 가 Basic 403("Basic Authentication has been disabled") ·
      Bearer PAT 429. 그래서 `confluence.recheck` 는 켜는 순간 전량 실패했다.

    표면별로 덮는 범위가 다르다:

        page          ✅ page 본문
        comment       ✅ 댓글은 page 에 함께 렌더된다 — 같은 텍스트로 덮인다
        page_version  ✅ ?pageVersion=<N>
        attachment    ❌ 첨부 본문 추출 불가(office/pdf 바이너리)

    ⚠️ 첨부는 **못 한다고 답한다.** 호출측이 `unknown` 으로 받아 스레드를
      `recheck_requested` 에 남기고 `retry_after` 를 건다(결과메일 없음).
      "확인 못 함" 을 "조치됨" 으로 접으면 유출이 열린 채 스레드만 닫힌다.

    반환형은 예전 그대로다 — 판정(`_original_hit_signatures` 대조)을 건드리지 않는다.
    """
    from domains.services.confluence.plugin.tools.confluence_browser_refetch import (
        browser_fetch_recheck_text,
    )

    extra = row.get("extra") or {}
    metadata = extra.get("metadata") or {}
    asset = str(row.get("asset") or "")
    kind = str(row.get("asset_kind") or "")
    page_id = _page_id_from(row)
    invalid_page_id = _invalid_page_id_reason(str(page_id or ""))
    if invalid_page_id:
        return [], invalid_page_id

    if kind == "attachment" or "/attachment/" in asset:
        return browser_fetch_recheck_text(page_id=str(page_id), kind="attachment")

    if kind == "comment" or "/comment/" in asset:
        return browser_fetch_recheck_text(page_id=str(page_id), kind="comment")

    if kind == "page_version" or "/version/" in asset:
        version = metadata.get("version")
        if version is None:
            m = _VERSION_RE.search(asset)
            version = int(m.group(1)) if m else None
        if version is None:
            return [], "version not found"
        return browser_fetch_recheck_text(
            page_id=str(page_id), kind="page_version", version=int(version))

    return browser_fetch_recheck_text(
        page_id=str(page_id), kind="page", label_hint=str(page_id))


def _attachment_download_matches_page(download_url: str, page_id: str) -> bool:
    match = _ATTACHMENT_DOWNLOAD_PAGE_RE.search(str(download_url or ""))
    if not match:
        return True
    return str(match.group("page_id") or "").strip() == str(page_id or "").strip()
