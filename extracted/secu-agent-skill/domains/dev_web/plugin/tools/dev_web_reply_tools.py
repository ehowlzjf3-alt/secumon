"""dev_web 재검증 회신 본문 빌더 — 3단 단절의 마지막 칸.

## 왜 필요한가

dev_web 재검증 워커의 종료 도구는 `dev_web_record_reverify_result`(DB 기록)뿐이었다.
다른 도메인은 **발송이 종료 조건**이다(SMB: `{"deliver","smb_build_reply"}`). 그래서
dev_web 은 재검증을 해도 담당자에게 아무 말도 하지 않았고, 스레드는 상태만 바뀌었다.

3단 단절의 나머지 둘은 `70248dc` 에서 고쳤다 — 담당자 경로(`DEV_WEB_REMEDIATION_MAIL_MODE`)와
수신 분류(`mail_inbound` 의 dev_web 분기). 이 파일이 마지막 칸이다.

## SMB 와 같은 모양으로 둔다

`smb_reply_tools.SmbBuildReplyTool` 과 나란히 읽히게 구조를 맞췄다 — 반환에 `deliver_hint` 를
싣고 워커가 그대로 `deliver(sink='knox_mail')` 로 보낸다. 회신 대상·제목 RE 카운트·원문 인용은
`service.services.remediation_mail` 의 **공용** 헬퍼를 그대로 쓴다(SMB 전용 본문 빌더만 다르다).

## 경계

- 수신 원문은 `service_reply_message`(비SMB 도메인용, 이미 존재)에서 읽는다. `mail_message` 는
  SMB 전용이라 여기서 쓰지 않는다.
- 발송 여부는 이 도구가 정하지 않는다. `DevWebReportDeliverTool` 의 수신자 정책(기본
  `dssoc_only`) + 코어 egress 게이트(sink opt-in · RECIPIENT_ALLOW 전원매칭 · redact 스캔,
  전부 fail-closed)가 관문이다. 정책 SSOT: `docs/MAIL-EGRESS-POLICY.md`.
"""
from __future__ import annotations

import json
from html import escape
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)

from service import state_domain as state
from service.services import remediation_mail as rm

_DOMAIN = "dev_web"

#: 회신 종류 — 재검증 verdict 와 1:1 로 맞춘다(워커가 옮겨 적을 때 헷갈리지 않게).
#: `inconclusive`/`error` 는 회신하지 않는다 — 판단이 안 선 것을 담당자에게 보내지 않는다.
_REPLY_KINDS = {
    "confirmed": "remediated",       # 조치 확인
    "still_exposed": "still_exposed",  # 아직 열려 있음
    "partial": "partial",            # 일부만 닫힘
}

#: 회신에 싣는 잔여 노출 URL 최대 개수. 넘치면 몇 건을 접었는지 밝힌다.
_OPEN_URL_CAP = 20


def _latest_inbound_at(domain: str, thread_id: int) -> float | None:
    """이 스레드의 마지막 **수신** 시각 — 재검증이 그보다 뒤여야 신선하다."""
    from service import state_domain as state

    try:
        rows = state.service_reply_messages_for_thread(domain, int(thread_id))
    except Exception:  # noqa: BLE001
        return None
    times = [r.get("received_at") for r in rows or []
             if str(r.get("direction") or "") in ("in", "inbound") and r.get("received_at")]
    return max((float(t) for t in times), default=None)


class DevWebBuildReplyInput(BaseModel):
    thread_id: int = Field(..., description="dev_web_report_thread.id")
    reply_kind: str = Field(
        ..., description="confirmed | still_exposed | partial — 재검증 verdict 와 같은 뜻")
    owner_name: str = Field("담당자", max_length=80)
    open_urls: list[str] = Field(
        default_factory=list,
        description="아직 인증 없이 열려 있는 URL. still_exposed/partial 일 때 표로 실린다.")
    detail: str = Field("", max_length=1000, description="재검증에서 관찰한 추가 설명.")


class DevWebBuildReplyTool(Tool[DevWebBuildReplyInput]):
    name: ClassVar[str] = "dev_web_build_reply"
    domain: ClassVar[str] = "dev_web"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "dev web reply build reverify 회신 본문 재검증 결과"
    description: ClassVar[str] = (
        "dev_web 재검증 결과 회신의 제목/본문을 만든다. reply_kind 는 confirmed(조치 확인) · "
        "still_exposed(아직 열림) · partial(일부만 닫힘). 반환의 subject/body 를 "
        "deliver(action='send', sink_id='knox_mail')로 발송하면 이번 재검증이 끝난다. "
        "회신 대상·제목 RE 카운트·원문 인용은 최신 수신 메일 기준으로 자동 구성된다. "
        "open_urls 를 주면 아직 열려 있는 경로가 표로 실린다."
    )
    input_model: ClassVar[type[BaseModel]] = DevWebBuildReplyInput

    async def execute(self, vi: DevWebBuildReplyInput, ctx: ToolContext) -> ToolResult:
        kind = str(vi.reply_kind or "").strip().lower()
        if kind not in _REPLY_KINDS:
            return ToolError(
                kind="validation",
                message=(f"reply_kind 는 {'|'.join(sorted(_REPLY_KINDS))} 중 하나 "
                         f"(받은 값: {vi.reply_kind!r}). inconclusive/error 는 회신하지 않는다 — "
                         "판단이 안 선 것을 담당자에게 보내지 않는다."),
            )
        thread = state.dev_web_report_thread_get(int(vi.thread_id))
        if not thread:
            return ToolError(kind="not_found",
                             message=f"dev_web_report_thread 없음: {vi.thread_id}")

        # ★ 상태를 단언하는 회신은 **신선한 재검증 기록**이 있어야 만든다.
        #   없으면 조립기가 저장된 지난 스캔으로 폴백해 "재점검한 결과" 라고 쓴다
        #   (`_shared/reply_guard` 머리말). 프롬프트의 "반드시 재검증" 은 부탁이라
        #   언젠가 깨지고, 깨져도 조용하다.
        from _shared.reply_guard import check_state_assertion

        _refusal = check_state_assertion(
            "dev_web", int(vi.thread_id), kind,
            after=_latest_inbound_at("dev_web", int(vi.thread_id)),
            verify_hint="dev_web_record_reverify_result 로 재검증 결과를 먼저 기록하라",
        )
        if _refusal:
            return ToolError(kind="precondition", message=_refusal)

        original = state.service_reply_message_latest_inbound_for_thread(
            _DOMAIN, int(vi.thread_id))
        url = str(thread.get("url") or "")
        site = str(thread.get("domain") or "")

        # ★ 담당자가 아니라는 답장에는 조치를 요구하지 않는다(2026-09-01).
        #   회신을 만드는 도구는 셋이다(공용 · smb · dev_web) — 하나만 막으면 새 나간다.
        from _shared.reply_guard import check_owner_dispute

        _refusal = check_owner_dispute(
            kind, str((original or {}).get("body_excerpt") or ""),
        )
        if _refusal:
            return ToolError(kind="precondition", message=_refusal)

        body = _build_body(kind, owner_name=vi.owner_name, url=url, site=site,
                           open_urls=list(vi.open_urls), detail=vi.detail)
        body = rm.append_original_message(body, original)
        recipients, cc = (rm.reply_targets(original) if original
                          else (_dssoc(), []))
        subject = rm.reply_subject(
            str(thread.get("subject_tag") or ""),
            original_subject=str((original or {}).get("subject") or ""),
        )
        return ToolSuccess(content=json.dumps({
            "kind": "dev_web_build_reply",
            "reply_kind": kind,
            "thread_id": int(vi.thread_id),
            "subject": subject,
            "body": body,
            "recipients": recipients,
            "cc": cc,
            "deliver_hint": {
                "action": "send",
                "sink_id": "knox_mail",
                "recipients": recipients,
                "cc": cc,
                "subject": subject,
                "metadata": {
                    "dev_web_thread_id": int(vi.thread_id),
                    "dev_web_reply_kind": kind,
                    "reverify_verdict": _REPLY_KINDS[kind],
                },
            },
        }, ensure_ascii=False))


def _dssoc() -> list[str]:
    from domains.dev_web.plugin.tools.dev_web_report_tools import _dssoc_recipients
    return _dssoc_recipients()


def _open_urls_table(urls: list[str]) -> str:
    """아직 열려 있는 경로 표. 없으면 표를 그리지 않는다 —
    빈 표는 "확인했는데 없음" 과 "확인 안 함" 을 섞어 보이게 한다."""
    rows = [u for u in urls if str(u or "").strip()]
    if not rows:
        return ""
    shown = rows[:_OPEN_URL_CAP]
    cells = "".join(
        '<tr><td style="border:1px solid #d9e2ec;padding:8px;word-break:break-all">'
        f"{escape(str(u))}</td></tr>"
        for u in shown
    )
    more = ""
    if len(rows) > len(shown):
        more = (f'<p style="color:#718096;font-size:12px;margin:4px 0 0">'
                f"외 {len(rows) - len(shown)}건 더 있습니다 (총 {len(rows)}건).</p>")
    return (
        '<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:13px">'
        '<thead><tr><th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;'
        'text-align:left">아직 인증 없이 열려 있는 경로</th></tr></thead>'
        f"<tbody>{cells}</tbody></table>{more}"
    )


def _build_body(kind: str, *, owner_name: str, url: str, site: str,
                open_urls: list[str], detail: str) -> str:
    """회신 본문. SMB 재확인 메일과 같은 결 — 헤더·서명 없이 단출하게."""
    who = escape(str(owner_name or "담당자"))
    target = escape(url or site or "-")
    extra = f"<p>{escape(detail)}</p>" if str(detail or "").strip() else ""
    if kind == "confirmed":
        return (
            f"<p>{who}님, 조치 확인했습니다.</p>"
            f"<p><b>{target}</b> 를 동일 조건으로 재확인한 결과 인증 없이 접근되는 항목이 "
            "확인되지 않았습니다. 협조해 주셔서 감사합니다.</p>"
            f"{extra}"
            "<p>이후 배포·설정 변경으로 접근 범위가 다시 열릴 수 있으니, 개발·검증 환경의 "
            "접근 제어를 정기적으로 점검해 주시기 바랍니다.</p>"
            "<p>DS보안관제 (정보보호)</p>"
        )
    if kind == "partial":
        return (
            f"<p>{who}님, 재확인 결과를 안내드립니다.</p>"
            f"<p><b>{target}</b> 의 일부 항목은 접근이 제한되었으나, 아래 경로는 "
            "아직 인증 없이 열려 있습니다.</p>"
            f"{_open_urls_table(open_urls)}{extra}"
            "<p>남은 항목까지 접근 제어를 적용하신 뒤 회신해 주시면 다시 확인하겠습니다.</p>"
            "<p>DS보안관제 (정보보호)</p>"
        )
    return (
        f"<p>{who}님, 재확인 결과를 안내드립니다.</p>"
        f"<p><b>{target}</b> 를 동일 조건으로 다시 확인했으나 아직 인증 없이 접근됩니다.</p>"
        f"{_open_urls_table(open_urls)}{extra}"
        "<p>접근 제어(SSO 인증·사내망/담당자 그룹 제한) 적용 후 회신해 주시면 "
        "다시 확인하겠습니다. 조치가 어려운 사유가 있으면 함께 알려주시기 바랍니다.</p>"
        "<p>DS보안관제 (정보보호)</p>"
    )
