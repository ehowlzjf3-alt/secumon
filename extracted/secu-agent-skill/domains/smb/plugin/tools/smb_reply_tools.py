"""#3 답장·재검증 에이전트 도구 — 수신함 읽기 + 회신 본문 빌드 (smb_domain_e2e 요구 8·9).

LLM 은 "답장이 조치주장인가/방법문의인가"만 판단(자연어). "실제 닫혔는지"는 코드
`smb_reverify_walk`(별 도구)가 결정. 회신은 generic `deliver`(knox_mail)로 발송.
"""
from __future__ import annotations

import logging

import hashlib
import json
import re
from email.utils import getaddresses
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.deliver_tool import DeliverInput, DeliverTool
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)

from domains.smb.plugin.tools.smb_report_mail_tools import report_mail_delivery_targets

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


class SmbReadInboxInput(BaseModel):
    thread_id: int | None = Field(None, description="특정 스레드의 수신 메시지만. 비우면 pending 전체.")
    limit: int = Field(20, ge=1, le=100)


class SmbReadInboxTool(Tool[SmbReadInboxInput]):
    name: ClassVar[str] = "smb_read_inbox"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "smb read inbox reply pop3 답장 mail_message pending"
    description: ClassVar[str] = (
        "조치요청 답장(direction='in', pending) 메시지를 읽는다. POP3 수집기가 이미 "
        "passive 수집해 둔 mail_message 를 조회만 한다(네트워크 0). 각 메시지의 subject/"
        "reply_text/body_excerpt(마스킹됨)/매칭 thread/finding 을 보고 '조치주장/방법문의/기타'를 "
        "판단하라. body_excerpt 에 Original Message 인용 원문이 있으면 reply_text 또는 "
        "separator 이전 신규 답장만 판단 근거로 사용한다. 실제 재검증은 smb_reverify_walk 가 한다."
    )
    input_model: ClassVar[type[BaseModel]] = SmbReadInboxInput

    async def execute(self, vi: SmbReadInboxInput, ctx: ToolContext) -> ToolResult:
        from service import state_domain as state
        from service.collector.mail_inbound import new_reply_text
        if vi.thread_id is not None:
            state.mail_messages_mark_stale_before_latest_outbound(vi.thread_id)
            msg = state.mail_message_next_pending_reply(vi.thread_id)
            msgs = [msg] if msg else []
        else:
            msgs = state.mail_messages_pending_reply()
        out = []
        for m in msgs[:vi.limit]:
            thread = state.mail_thread_get(m["thread_id"]) if m.get("thread_id") else None
            out.append({
                "message_pk": m["id"],
                "thread_id": m.get("thread_id"),
                "finding_id": thread.get("finding_id") if thread else None,
                "host": thread.get("host") if thread else None,
                "subject": m.get("subject"),
                "subject_tag": m.get("subject_tag"),
                "from": m.get("mail_from"),
                "reply_text": new_reply_text(str(m.get("body_excerpt") or "")),
                "body_excerpt": m.get("body_excerpt"),
                "thread_status": thread.get("status") if thread else None,
                "attempt_count": thread.get("attempt_count") if thread else None,
            })
        return ToolSuccess(content=json.dumps({
            "kind": "smb_read_inbox", "count": len(out), "messages": out,
        }, ensure_ascii=False))


_HUMAN_REVIEW_STATUS_BY_DECISION = {
    "business_exception_claim": "exception_review",
    "not_owner": "owner_update_needed",
    "owner_changed": "owner_reassignment_review",
}


class SmbRecordReplyDecisionInput(BaseModel):
    thread_id: int
    message_id_pk: int | None = Field(None, description="판단한 inbound mail_message.id")
    decision: str = Field(
        ...,
        description=(
            "remediation_claim | how_to_question | still_needed | business_exception_claim | "
            "not_owner | owner_changed | unclear"
        ),
    )
    confidence: float | None = Field(None, ge=0, le=1)
    reason: str = Field("", max_length=1000)
    owner_name: str = Field("", max_length=120)
    owner_department: str = Field("", max_length=120)
    owner_email: str = Field("", max_length=200)


class SmbRecordReplyDecisionTool(Tool[SmbRecordReplyDecisionInput]):
    name: ClassVar[str] = "smb_record_reply_decision"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "smb reply classify owner changed business exception hitl"
    description: ClassVar[str] = (
        "답장 성격을 구조화 기록한다. 업무 목적 예외, 담당자 아님, 담당자 변경은 즉시 "
        "HITL 상태(exception_review/owner_update_needed/owner_reassignment_review)로 전환한다. "
        "이 도구는 메일 발송을 하지 않는다."
    )
    input_model: ClassVar[type[BaseModel]] = SmbRecordReplyDecisionInput

    async def execute(self, vi: SmbRecordReplyDecisionInput, ctx: ToolContext) -> ToolResult:
        from service import state_domain as state

        owner = {
            "name": vi.owner_name.strip(),
            "department": vi.owner_department.strip(),
            "email": vi.owner_email.strip(),
        }
        owner = {k: v for k, v in owner.items() if v}
        did = state.mail_reply_decision_add(
            thread_id=vi.thread_id,
            message_id_pk=vi.message_id_pk,
            decision=vi.decision,
            confidence=vi.confidence,
            reason=vi.reason,
            extracted_owner=owner,
            created_by="reply_agent",
        )
        status = _HUMAN_REVIEW_STATUS_BY_DECISION.get(vi.decision)
        if vi.message_id_pk is not None:
            state.mail_message_set_verdict(
                vi.message_id_pk,
                verdict=f"classified_{vi.decision}",
                thread_id=vi.thread_id,
            )
        if status:
            state.mail_thread_set_status(
                vi.thread_id,
                status,
                last_reason=vi.reason or f"reply decision: {vi.decision}",
            )
        return ToolSuccess(content=json.dumps({
            "kind": "smb_record_reply_decision",
            "decision_id": did,
            "thread_id": vi.thread_id,
            "decision": vi.decision,
            "status": status,
            "extracted_owner": owner,
        }, ensure_ascii=False))


class SmbBuildReplyInput(BaseModel):
    host: str
    subject_tag: str = Field(..., description="원 [보안취약점 조치요청](IP) 태그 — 최신 수신 제목 기준으로 RE 카운트 증가.")
    reply_kind: str = Field(..., description="not_fixed | how_to | confirmed")
    thread_id: int | None = Field(None, description="선택: mail_thread.id. 비우면 subject_tag 로 최신 스레드를 찾는다.")
    owner_name: str = Field("담당자", max_length=80)
    os_hint: str = Field("windows", description="how_to 일 때 windows|linux|both")
    detail: str = Field("", max_length=1000, description="not_fixed 일 때 추가 안내(재검증 결과 등).")


class SmbBuildReplyTool(Tool[SmbBuildReplyInput]):
    name: ClassVar[str] = "smb_build_reply"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "smb reply build not_fixed how_to confirmed 회신 본문"
    description: ClassVar[str] = (
        "회신 3종 본문/제목을 만든다: not_fixed(미조치 — 재검증 still_open), "
        "how_to(Windows/Linux 권한변경 안내), confirmed(조치 확인 감사). 반환의 "
        "subject/body 를 deliver(sink='knox_mail')로 발송. not_fixed 는 mail_reverify_result 를 "
        "읽어 아직 열린 공유/권한 표를 자동 첨부한다. thread_id 가 있으면 최신 inbound의 "
        "From/To/Cc 기준으로 reply-all 대상과 Original Message 인용 블록을 만든다. "
        "제목은 최신 수신 제목의 RE 카운트를 증가시킨다."
    )
    input_model: ClassVar[type[BaseModel]] = SmbBuildReplyInput

    async def execute(self, vi: SmbBuildReplyInput, ctx: ToolContext) -> ToolResult:
        from service.services import remediation_mail as rm
        original = _latest_inbound_message(vi.thread_id) if vi.thread_id is not None else None

        # ★ 상태를 단언하는 회신은 **신선한 재검증 기록**이 있어야 만든다.
        #   없으면 `reverify_open_rows` 가 비어 `host_open_share_rows`(저장된 지난 스캔)로
        #   폴백하는데, 본문은 그래도 "재점검한 결과" 라고 쓴다(`_shared/reply_guard`).
        #   프롬프트의 "반드시 재검증" 은 부탁이라 언젠가 깨지고, 깨져도 조용하다.
        if vi.thread_id is not None:
            from _shared.reply_guard import check_state_assertion

            _refusal = check_state_assertion(
                "smb", int(vi.thread_id), vi.reply_kind,
                after=(original or {}).get("received_at"),
                verify_hint=(
                    "smb_reverify_walk(host=..., share=..., path_prefix=..., finding_id=...) "
                    "로 각 finding 을 실제로 재검증하라"
                ),
            )
            if _refusal:
                return ToolError(kind="precondition", message=_refusal)

        # ★ 담당자가 아니라고 한 사람에게 **조치를 요구하지 않는다**(사용자 지적 2026-09-01).
        #   프롬프트에 이미 규칙이 있었는데 워커가 `how_to 질문` 으로 분류하고 답장했다 —
        #   "난생 처음 보는 주소" 라고 한 사람에게 "입사 전 폴더라 하더라도 …" 가 나갔다.
        #   부탁으로 지켜지는 불변식은 언젠가 깨진다. 여기서 막는다.
        from _shared.reply_guard import check_owner_dispute

        _owner_refusal = check_owner_dispute(
            vi.reply_kind, str((original or {}).get("body_excerpt") or ""),
        )
        if _owner_refusal:
            return ToolError(kind="precondition", message=_owner_refusal)
        if vi.reply_kind == "not_fixed":
            thread_id = vi.thread_id or _thread_id_from_subject_tag(vi.subject_tag)
            rows = (
                rm.reverify_open_rows(thread_id=thread_id, host=vi.host)
                if thread_id is not None else []
            )
            if not rows:
                rows = rm.host_open_share_rows(host=vi.host)
            body = rm.build_not_fixed(
                host=vi.host,
                owner_name=vi.owner_name,
                detail=vi.detail,
                open_rows=rows,
            )
        elif vi.reply_kind == "how_to":
            body = rm.build_how_to(host=vi.host, owner_name=vi.owner_name, os_hint=vi.os_hint)
        elif vi.reply_kind == "confirmed":
            body = rm.build_confirmed(host=vi.host, owner_name=vi.owner_name)
        else:
            return ToolError(kind="validation",
                             message="reply_kind 는 not_fixed|how_to|confirmed 중 하나")
        body = rm.append_original_message(body, original)
        targets = _reply_targets(original)
        subject = rm.reply_subject(
            vi.subject_tag,
            original_subject=str((original or {}).get("subject") or ""),
        )
        metadata = _reply_build_metadata(
            base=_reply_metadata(original),
            reply_kind=vi.reply_kind,
            thread_id=vi.thread_id,
            subject=subject,
            body=body,
            recipients=targets["recipients"],
            cc=targets["cc"],
        )
        return ToolSuccess(content=json.dumps({
            "kind": "smb_build_reply",
            "reply_kind": vi.reply_kind,
            "subject": subject,
            "body": body,
            "recipient": targets["recipients"][0],
            "recipients": targets["recipients"],
            "cc": targets["cc"],
            "deliver_hint": {
                "action": "send", "sink_id": "knox_mail",
                "recipients": targets["recipients"], "cc": targets["cc"],
                "subject": subject, "metadata": metadata,
            },
        }, ensure_ascii=False))


def _latest_inbound_message(thread_id: int | None) -> dict[str, Any] | None:
    if thread_id is None:
        return None
    from service import state_domain as state

    messages = [
        m for m in state.mail_messages_for_thread(int(thread_id))
        if m.get("direction") == "in"
    ]
    return messages[-1] if messages else None


def _address_list(value: str | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for _, addr in getaddresses([str(value or "")]):
        email = addr.strip()
        key = email.lower()
        if not email or key in seen:
            continue
        out.append(email)
        seen.add(key)
    return out


def _dssoc_identities() -> set[str]:
    # "우리가 보낸 메일인가" 판정 — DSSOC 팀함보다 넓다(POP3 계정·Knox 발신자 포함).
    # 이름이 `_dssoc_sender_identities` → `_our_sender_identities` 로 바뀌었다.
    from service.collector.mail_inbound import _our_sender_identities

    return _our_sender_identities()


def _is_dssoc_address(addr: str) -> bool:
    lowered = addr.strip().lower()
    local = lowered.split("@", 1)[0] if "@" in lowered else lowered
    return lowered in _dssoc_identities() or local in _dssoc_identities()


log = logging.getLogger(__name__)


def _reply_targets(message: dict[str, Any] | None) -> dict[str, list[str]]:
    """회신 수신처 — **공용 함수 한 벌**을 쓴다.

    ## 왜 합쳤나 (사용자 지적 2026-09-01 "공용러너인데 왜 또 따로 막아")

    여기에 같은 판정이 **한 벌 더** 있었다. 그래서 회신 임시 제한을 공용 쪽에만 걸었을 때
    smb 답장이 그대로 실제 담당자에게 나갔다(09:09:30). 두 곳을 각각 막는 게 아니라
    결정 지점을 **하나로** 만드는 게 답이다.

    ⚠️ 합치면서 두 가지가 바뀐다 — 둘 다 정책에 맞는 방향이다:
      · DSSOC 가 **Cc 로 붙는다**. 정책은 "담당자(To) + DSSOC(Cc)" 인데 여기 판정은
        DSSOC 를 양쪽에서 빼기만 해서 우리 팀함에 회신 사본이 안 남았다.
      · 수신자가 비면 **빈 목록**이 나간다(폴백 없음). 엔진이 막고 발송 실패로 남는다 —
        누구에게 보낼지 모르는 것을 팀함 발송으로 덮지 않는다.
    """
    from service.services.remediation_mail import reply_targets

    recipients, cc = reply_targets(message or {})
    return {"recipients": list(recipients), "cc": list(cc)}


def _reply_metadata(message: dict[str, Any] | None) -> dict[str, Any]:
    if not message:
        return {"smb_reply_relation": "none"}
    return {
        "smb_reply_relation": "inbound_mail",
        "original_mail_message_pk": message.get("id"),
        "original_message_id": message.get("message_id"),
        "in_reply_to": message.get("in_reply_to"),
        "references": message.get("references_header"),
        "root_message_id": message.get("root_message_id"),
        "delivery_allowed_pii_values": _reply_allowed_pii_values(message),
    }


def _reply_build_metadata(
    *,
    base: dict[str, Any],
    reply_kind: str,
    thread_id: int | None,
    subject: str,
    body: str,
    recipients: list[str],
    cc: list[str],
) -> dict[str, Any]:
    out = dict(base)
    out.update({
        # ★ 회신은 공문이 아니다(사용자 지시 2026-08-31). Knox enum 은 OFFICIAL/PERSONAL 뿐.
        "doc_secu_type": "PERSONAL",
        "smb_reply_built": True,
        "smb_reply_kind": reply_kind,
        "smb_reply_thread_id": thread_id,
        "smb_reply_subject": subject,
        "smb_reply_body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "smb_reply_recipients": list(recipients),
        "smb_reply_cc": list(cc),
    })
    return out


def _reply_allowed_pii_values(message: dict[str, Any]) -> list[str]:
    values: list[str] = []
    seen: set[str] = set()
    for field in ("mail_from", "mail_to", "mail_cc", "body_excerpt", "body_html"):
        for match in _EMAIL_RE.findall(str(message.get(field) or "")):
            key = match.strip().lower()
            if not key or key in seen:
                continue
            values.append(match)
            seen.add(key)
    return values


def _thread_id_from_subject_tag(subject_tag: str) -> int | None:
    from service import state_domain as state

    for thread in state.mail_thread_find_by_subject_tag(subject_tag):
        if thread.get("status") in {
            "reply_received", "reverifying", "re_requested", "awaiting_reply",
            "partially_remediated",
        }:
            return int(thread["id"])
    return None


def _phase_recipient() -> str:
    """단계 알림용 수신처(DSSOC).

    ⚠️ `manual=True` 로 부른다. 이건 **최초 발송이 아니라** 회신 경로의 내부 알림이고,
       최초 발송 게이트가 닫혀 수신처가 비면 `[0]` 이 터진다(2026-08-31).
    """
    got = report_mail_delivery_targets([], manual=True)["recipients"]
    return got[0] if got else _dssoc_recipients()[0]


def _copy_deliver_input(vi: DeliverInput, **updates: Any) -> DeliverInput:
    data = vi.model_dump() if hasattr(vi, "model_dump") else vi.dict()
    data.update(updates)
    return DeliverInput(**data)


class SmbReplyDeliverTool(DeliverTool):
    """Reply/reverify scoped deliver wrapper that enforces recipient policy."""

    async def execute(self, vi: DeliverInput, ctx: ToolContext) -> ToolResult:
        if vi.action != "send" or vi.sink_id != "knox_mail":
            return await super().execute(vi, ctx)
        metadata = dict(vi.metadata or {})
        validation = _validate_built_reply_delivery(vi, metadata)
        if validation is not None:
            return validation
        metadata["smb_reply_delivery_policy"] = "reply_to_inbound"
        metadata["requested_recipients"] = list(vi.recipients)
        metadata["requested_cc"] = list(vi.cc)
        safe_vi = _copy_deliver_input(
            vi,
            metadata=metadata,
        )
        return await super().execute(safe_vi, ctx)


def _validate_built_reply_delivery(
    vi: DeliverInput,
    metadata: dict[str, Any],
) -> ToolError | None:
    """Require deliver to send the exact payload returned by smb_build_reply."""
    if metadata.get("smb_reply_built") is not True:
        return ToolError(
            kind="validation",
            message=(
                "SMB reply delivery must use smb_build_reply.deliver_hint exactly; "
                "call smb_build_reply first and pass its subject/body/recipients/cc/metadata to deliver."
            ),
        )
    expected_subject = str(metadata.get("smb_reply_subject") or "")
    if expected_subject and vi.subject != expected_subject:
        return ToolError(
            kind="validation",
            message="SMB reply subject differs from smb_build_reply result.",
        )
    expected_hash = str(metadata.get("smb_reply_body_sha256") or "")
    actual_hash = hashlib.sha256(str(vi.body or "").encode("utf-8")).hexdigest()
    if expected_hash and actual_hash != expected_hash:
        return ToolError(
            kind="validation",
            message="SMB reply body differs from smb_build_reply result.",
        )
    expected_recipients = [str(x) for x in metadata.get("smb_reply_recipients") or []]
    if expected_recipients and list(vi.recipients) != expected_recipients:
        return ToolError(
            kind="validation",
            message="SMB reply recipients differ from smb_build_reply result.",
        )
    expected_cc = [str(x) for x in metadata.get("smb_reply_cc") or []]
    if list(vi.cc) != expected_cc:
        return ToolError(
            kind="validation",
            message="SMB reply cc differs from smb_build_reply result.",
        )
    return None
