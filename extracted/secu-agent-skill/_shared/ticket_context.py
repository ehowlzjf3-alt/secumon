"""티켓 컨텍스트 — 회신을 쓰려면 **티켓을 읽을 수 있어야 한다**. 4도메인 한 벌.

## 왜 (2026-08-31 사용자 지시)

> "지금 메일 답장 양식이 너무 정해져있나본데? 폴더 위치를 물었는데 답변은 그냥
>  조치방법 답변이라 이상하잖아."
> "그리고 제대로 답변하려면 티켓정보는 읽을 수 있어야겠지"
> "넷을 같이 만들어야지. 그래서 도구가 smb로 붙으면 안된다"

실측한 원인: 회신 에이전트(`reply_verify_agent._build_user_text`)가 LLM 에게 주는
정보가 **좌표뿐**이었다 — `thread_id/host/finding_id/attempt` 와 `finding_id=N asset=…`
줄. 담당자가 무엇을 물었든 답할 재료가 없으니 고정 템플릿(`how_to`)으로 떨어진다.
양식이 굳은 게 아니라 **읽을 것이 없었다.**

## 넷의 이름이 다 다르다 (실측 2026-08-31)

여기가 이 모듈이 존재하는 이유다. 같은 것을 도메인마다 다르게 부른다:

    요약        smb=plain_summary   github=summary   confluence=(없음)  dev_web=summary
    조치안내    smb=remediation_actions              dev_web=recommended_actions
                github·confluence=(본문 HTML 안에만)
    본문 HTML   smb=report_json.html                 github·confluence=report_html
                dev_web=(없음 — HTML 을 저장하지 않는다)
    좌표        host / repo / space_key / domain+url
    finding     smb=report_json.built_from_finding_id  나머지=report_json.findings

위층이 이 표를 알면 안 된다. 알면 도메인 분기가 네 벌로 번지고, 그게 지금까지
`_shared/thread_adapter` 가 없애려던 모양이다.

## 안전

⚠️ `hits[].preview` 는 **기본으로 싣지 않는다.** 탐지기 원문 조각이라 시크릿 값이
   그대로 들어 있을 수 있다. 회신 본문을 쓰는 LLM 에게 필요한 것은 "어디에 무엇이
   있다" 지 값 자체가 아니다. 값이 꼭 필요하면 `include_previews=True` 를 **명시**해라.
   (`masked` 는 이미 마스킹된 값이라 싣는다.)
"""
from __future__ import annotations

import json
from typing import Any

#: 요약 문구가 도메인마다 다른 이름으로 산다. **순서대로** 처음 찾은 것을 쓴다.
_SUMMARY_KEYS = ("plain_summary", "summary", "risk_narrative", "note")
#: 조치 안내도 마찬가지.
_ACTION_KEYS = ("remediation_actions", "recommended_actions", "actions")


def _loads(v: Any) -> Any:
    """DB 가 JSON 을 문자열로 돌려줄 수도, 이미 파싱해 줄 수도 있다."""
    if isinstance(v, str):
        try:
            return json.loads(v)
        except (ValueError, TypeError):
            return None
    return v


def _first_text(d: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    """산문 요약을 고른다. **문자열만 받는다.**

    ⚠️ 2026-08-31 실데이터가 잡은 것: github 의 `report_json["summary"]` 는 문장이
       아니라 통계 dict 다 — `{"highest_severity":"high","masked_hit_count":785,…}`.
       그냥 첫 키를 쓰면 회신 LLM 에게 카운터 뭉치를 산문이라고 건네게 된다.
    """
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _first_actions(d: dict[str, Any], keys: tuple[str, ...]) -> list[str] | None:
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return [v.strip()]
        if isinstance(v, (list, tuple)) and v:
            out = [str(x).strip() for x in v if str(x).strip()]
            if out:
                return out
    return None


#: HTML 본문에서 텍스트만 뽑을 때 통째로 버리는 요소.
_DROP_TAGS = ("script", "style", "head")


def html_to_text(html: str, *, limit: int = 3000) -> str:
    """보낸 메일 HTML → 사람이 읽는 문장.

    ★ 이게 없으면 github·confluence 회신 LLM 은 **우리가 뭐라고 보냈는지 모른다** —
      둘은 산문을 `report_html` 안에만 갖고 있다(실측 2026-08-31). 담당자가
      "어느 폴더요?" 라고 물었을 때 우리 원문을 못 보면 답할 수가 없다.

    파서를 새로 만들지 않는다 — 표준 `html.parser` 를 쓴다.
    """
    from html.parser import HTMLParser

    class _T(HTMLParser):
        def __init__(self) -> None:
            super().__init__(convert_charrefs=True)
            self.parts: list[str] = []
            self.skip = 0

        def handle_starttag(self, tag: str, attrs: Any) -> None:
            if tag in _DROP_TAGS:
                self.skip += 1
            elif tag in ("br", "p", "div", "tr", "li", "h1", "h2", "h3", "table"):
                self.parts.append("\n")

        def handle_endtag(self, tag: str) -> None:
            if tag in _DROP_TAGS and self.skip:
                self.skip -= 1

        def handle_data(self, data: str) -> None:
            if not self.skip and data.strip():
                self.parts.append(data.strip())

    t = _T()
    try:
        t.feed(str(html or ""))
    except Exception:  # noqa: BLE001 — 깨진 HTML 이 티켓 조회를 죽이면 안 된다
        return ""
    lines = [ln.strip() for ln in "".join(
        p if p == "\n" else p + " " for p in t.parts).split("\n")]
    text = "\n".join(ln for ln in lines if ln)
    return text[:limit] + ("\n…(이하 생략)" if len(text) > limit else "")


def _finding_view(
    finding: dict[str, Any],
    *,
    hit_limit: int,
    include_previews: bool,
) -> dict[str, Any]:
    """finding 행 → 회신에 필요한 만큼만. 원문 조각은 기본으로 뺀다."""
    extra = _loads(finding.get("extra")) or {}
    hits_raw = extra.get("hits") if isinstance(extra, dict) else None
    hits: list[dict[str, Any]] = []
    for h in (hits_raw or [])[:hit_limit]:
        if not isinstance(h, dict):
            continue
        view = {
            "location": h.get("location"),
            "kind": h.get("kind"),
            "category": h.get("category"),
            "masked": h.get("masked") or None,
        }
        if include_previews and h.get("preview"):
            view["preview"] = h["preview"]
        hits.append({k: v for k, v in view.items() if v})
    return {
        "finding_id": finding.get("id"),
        "asset": finding.get("asset"),
        "asset_kind": finding.get("asset_kind"),
        "severity": finding.get("severity"),
        "status": finding.get("status"),
        "summary": finding.get("summary"),
        "hits": hits,
        "hits_total": len(hits_raw or []),
    }


def ticket_context(
    domain: str | None = None,
    thread_id: int | None = None,
    *,
    ticket: str | None = None,
    hit_limit: int = 12,
    finding_limit: int = 10,
    include_previews: bool = False,
    include_html: bool = False,
) -> dict[str, Any]:
    """티켓 하나를 **도메인 무관**하게 읽는다.

    `ticket_context("smb", 24)` 또는 `ticket_context(ticket="SMB00024")`.

    ⚠️ 없는 티켓은 `{"error": ...}` 를 돌려준다 — 예외를 던지지 않는다. 이걸 도구로
       감싸 LLM 에게 주므로, 잘못된 번호는 **말이 되는 응답**이어야 한다.
    """
    from _shared.thread_adapter import get_thread_adapter
    from _shared.ticket_id import parse_ticket, ticket_no as _ticket_no

    if ticket:
        parsed = parse_ticket(f"[티켓 {ticket.strip()}]")
        if parsed is None:
            return {"error": f"티켓 번호를 못 읽었다: {ticket!r} (예: SMB00024·GH00137)"}
        domain, thread_id = parsed
    if not domain or thread_id is None:
        return {"error": "domain+thread_id 또는 ticket 중 하나가 필요하다"}

    adapter = get_thread_adapter(str(domain))
    if adapter is None:
        from _shared.thread_adapter import thread_adapter_names

        return {"error": f"스레드 어댑터 미등록: {domain!r} (등록: {thread_adapter_names()})"}

    thread = adapter.thread_get(int(thread_id))
    if thread is None:
        return {"error": f"{_ticket_no(domain, int(thread_id))} 스레드가 없다"}

    report = _loads(thread.get("report_json")) or {}
    if not isinstance(report, dict):
        report = {}

    # ── finding 본문 ────────────────────────────────────────────────
    from secu_agent import state as cs

    findings: list[dict[str, Any]] = []
    for fid in (adapter.finding_ids(thread) or [])[:finding_limit]:
        try:
            row = cs.finding_get(int(fid))
        except Exception:  # noqa: BLE001 — 한 건 실패가 티켓 전체를 죽이면 안 된다
            row = None
        if row:
            findings.append(_finding_view(row, hit_limit=hit_limit,
                                          include_previews=include_previews))

    # ── 우리가 보낸 것 ──────────────────────────────────────────────
    # ⚠️ HTML 은 기본으로 안 싣는다 — 8,882자짜리가 있다(github GH00552 실측).
    #    프롬프트를 통째로 먹는다. 필요하면 명시해서 켠다.
    html = report.get("html") or thread.get("report_html")
    sent = {
        "summary": _first_text(report, _SUMMARY_KEYS),
        "actions": _first_actions(report, _ACTION_KEYS),
        # ★ 우리가 실제로 보낸 문장. github·confluence 는 여기에만 산문이 있다.
        "body_text": html_to_text(html) if html else None,
        "finding_count": report.get("finding_count"),
        "is_recurring": report.get("is_recurring"),
        "recurrence_count": report.get("recurrence_count") or thread.get("recurrence_count"),
        "html_chars": len(html) if html else 0,
    }
    if include_html and html:
        sent["html"] = html

    # ── 받은 답장 ───────────────────────────────────────────────────
    # ★ 2026-08-31 정정: "답장은 smb 만 받는다" 는 **틀렸다.** POP3 수집기
    #   (`service/collector/mail_inbound.py:596`)가 4도메인을 다 라우팅한다 —
    #   smb 는 `mail_message`, 나머지 셋은 `service_reply_message` 로 들어간다.
    #   테이블 이름이 다르다는 이유로 셋의 답장을 못 읽으면, 담당자가 물어도
    #   회신 워커에겐 질문이 보이지 않는다.
    inbound = _inbound_messages(str(domain), int(thread_id))

    # ── 재검증 ──────────────────────────────────────────────────────
    # ★ 회신에 "재점검한 결과" 라고 쓰려면 근거가 있어야 한다. LLM 이 그 사실을
    #   **보고** 판단하도록 싣는다 — 안 실으면 "했겠지" 로 쓴다.
    #   강제는 `_shared/reply_guard` 가 한다(여기는 알려주기만).
    recheck: dict[str, Any] = {"records": 0, "latest": None, "after_last_inbound": 0}
    if adapter.recheck_records is not None:
        try:
            rows = adapter.recheck_records(int(thread_id)) or []
        except Exception:  # noqa: BLE001
            rows = []
        last_in = max(
            (float(m["received_at"]) for m in inbound
             if isinstance(m, dict) and m.get("received_at")),
            default=None,
        )
        fresh = [r for r in rows
                 if last_in is None or float(r.get("created_at") or 0) > last_in]
        recheck = {
            "records": len(rows),
            "after_last_inbound": len(fresh),
            "latest": [
                {k: r.get(k) for k in ("created_at", "finding_id", "verdict", "share", "url")
                 if r.get(k) is not None}
                for r in rows[:5]
            ],
        }

    return {
        "ticket_no": adapter.ticket_no(int(thread_id)),
        "domain": str(domain),
        "queue_label": adapter.queue_label,
        "thread_id": int(thread_id),
        "status": thread.get("status"),
        "severity": thread.get("severity"),
        "coordinate": _coordinate(domain, thread),
        "subject_tag": thread.get("subject_tag"),
        "recipient": thread.get("recipient"),
        "owner_recipient": thread.get("owner_recipient"),
        "attempt_count": thread.get("attempt_count"),
        "last_reason": thread.get("last_reason"),
        "created_at": thread.get("created_at"),
        "first_reported_at": thread.get("first_reported_at"),
        "updated_at": thread.get("updated_at"),
        "findings": findings,
        "findings_total": len(adapter.finding_ids(thread) or []),
        "sent": sent,
        "inbound": inbound,
        "recheck": recheck,
        "notes": adapter.notes,
    }


#: 좌표 열 이름 — 도메인마다 다르다. 여기 한 곳에서만 안다.
_COORD_KEYS = {
    "smb": ("host",),
    "github": ("repo",),
    "confluence": ("space_key",),
    "dev_web": ("domain", "url"),
}


def _coordinate(domain: str, thread: dict[str, Any]) -> str:
    keys = _COORD_KEYS.get(str(domain), ())
    return " ".join(str(thread.get(k)) for k in keys if thread.get(k))


#: 답장 본문이 도메인마다 다른 열 이름으로 산다.
_BODY_KEYS = ("body_excerpt", "body_text", "body")
_FROM_KEYS = ("mail_from", "from_addr", "sender")
_VERDICT_KEYS = ("agent_verdict", "verdict", "decision")


def _inbound_messages(domain: str, thread_id: int, *, limit: int = 8) -> list[dict[str, Any]]:
    """이 티켓에 붙은 **받은 메일**. 4도메인 공용.

    ⚠️ 본문은 이미 마스킹된 것(`body_excerpt`)을 쓴다 — 수집기가
       `redact_sensitive_text(force=True)` 를 거쳐 저장한다.
    """
    import service.state_domain as state

    try:
        if domain == "smb":
            rows = state.mail_messages_for_thread(int(thread_id))
        else:
            rows = state.service_reply_messages_for_thread(domain, int(thread_id))
    except Exception as e:  # noqa: BLE001 — 답장 조회 실패가 티켓 전체를 죽이면 안 된다
        return [{"error": f"수신 메일 조회 실패: {e!r}"[:200]}]

    out: list[dict[str, Any]] = []
    for m in rows or []:
        if str(m.get("direction") or "") not in ("in", "inbound"):
            continue
        body = next((m[k] for k in _BODY_KEYS if m.get(k)), "")
        out.append({
            "from": next((m[k] for k in _FROM_KEYS if m.get(k)), None),
            "subject": m.get("subject"),
            "received_at": m.get("received_at") or m.get("created_at"),
            "verdict": next((m[k] for k in _VERDICT_KEYS if m.get(k)), None),
            "decision_reason": m.get("decision_reason"),
            "body": str(body)[:4000] or None,
        })
    # 최신이 뒤에 오도록 두고, 길면 **최근 것**을 남긴다.
    return out[-limit:]
