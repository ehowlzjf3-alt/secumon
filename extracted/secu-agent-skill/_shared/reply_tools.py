"""회신 도구 — **4도메인 공용 한 벌**. 도메인 이름이 도구에 붙지 않는다.

> "넷을 같이 만들어야지. 그래서 도구가 smb로 붙으면 안된다" (사용자, 2026-08-31)

지금까지 회신 도구는 `smb_read_inbox` / `smb_build_reply` 처럼 도메인이 이름에
박혀 있었고, 인자도 `host=` 였다. 그래서 github/confluence/dev_web 은 회신을
쓸 도구가 아예 없었다.

여기 둘은 **티켓 번호 하나**로 동작한다:

    ticket_read(ticket="GH00137")           ← 무엇을 보냈고 무엇이 걸렸는지
    ticket_reply_compose(ticket=…, answer=…, blocks=[…])

도메인 차이(수신처 규칙·reply-all·상태 어휘)는 `ThreadAdapter` 가 흡수한다.
"""
from __future__ import annotations

import json
from typing import Any, ClassVar

from pydantic import BaseModel, Field
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


class TicketReadInput(BaseModel):
    ticket: str = Field(..., description="티켓 번호 — SMB00024 · GH00137 · CF00019 · DW00045")
    include_previews: bool = Field(
        False,
        description="탐지된 값의 원문 조각까지 포함(기본 False). 회신 본문에 값을 그대로 쓰지 마라.",
    )
    include_html: bool = Field(False, description="보낸 메일 HTML 원본까지(길다). 보통 불필요.")


class TicketReadTool(Tool[TicketReadInput]):
    name: ClassVar[str] = "ticket_read"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "ticket read 티켓 조회 회신 컨텍스트 finding 스레드 thread context"
    description: ClassVar[str] = (
        "티켓 하나를 읽는다(4도메인 공용). 담당자 질문에 답하려면 **먼저 이걸 부른다**. "
        "돌려주는 것: 상태·대상 좌표·수신처·finding 목록(자산/위치/심각도)·"
        "우리가 보낸 메일 본문(sent.body_text)·받은 답장(inbound). "
        "담당자가 '어느 폴더/저장소/페이지인가요' 라고 물으면 findings[].hits[].location 이 답이다. "
        "'뭐라고 보내셨죠' 는 sent.body_text 가 답이다. 추측하지 말고 여기 있는 사실만 써라."
    )
    input_model: ClassVar[type[BaseModel]] = TicketReadInput

    async def execute(self, vi: TicketReadInput, ctx: ToolContext) -> ToolResult:
        from _shared.ticket_context import ticket_context

        ctxt = ticket_context(
            ticket=vi.ticket,
            include_previews=vi.include_previews,
            include_html=vi.include_html,
        )
        if ctxt.get("error"):
            return ToolError(kind="not_found", message=str(ctxt["error"]))
        return ToolSuccess(content=json.dumps(
            {"kind": "ticket_read", **ctxt}, ensure_ascii=False, default=str))


class TicketReplyComposeInput(BaseModel):
    ticket: str = Field(..., description="티켓 번호 — SMB00024 · GH00137 등")
    answer: str = Field(
        ...,
        description=(
            "담당자에게 할 답. **평문으로 네가 직접 쓴다.** 담당자가 물은 것에 답해라 — "
            "위치를 물었으면 위치를, 이유를 물었으면 이유를. ticket_read 로 확인한 "
            "사실만 쓰고, 모르는 것은 모른다고 써라. HTML 태그를 쓰지 마라(자동 변환된다)."
        ),
    )
    blocks: list[str] = Field(
        default_factory=list,
        description=(
            "덧붙일 검증된 문단 이름들(선택). 절차 안내처럼 문구가 고정된 것은 "
            "직접 쓰지 말고 블록을 골라라 — 목록은 프롬프트의 '회신 블록' 참조. "
            "필요 없으면 비워 둔다."
        ),
    )
    owner_name: str = Field("담당자", description="호칭. 모르면 그대로 둔다.")


class TicketReplyComposeTool(Tool[TicketReplyComposeInput]):
    name: ClassVar[str] = "ticket_reply_compose"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "ticket reply compose 회신 본문 작성 답장 blocks 템플릿"
    description: ClassVar[str] = (
        "회신 메일을 조립한다(4도메인 공용). 인사·회신요청·서명은 코드가 고정하고, "
        "본문은 네가 쓴 answer 가 들어간다. blocks 로 검증된 절차 문단을 덧붙일 수 있다. "
        "수신처와 제목은 티켓에서 자동으로 정해진다(smb 는 받은 메일에 reply-all). "
        "반환의 deliver_hint 를 그대로 deliver 에 넘겨 발송한다."
    )
    input_model: ClassVar[type[BaseModel]] = TicketReplyComposeInput

    async def execute(self, vi: TicketReplyComposeInput, ctx: ToolContext) -> ToolResult:
        out = compose_reply(
            ticket=vi.ticket,
            answer=vi.answer,
            blocks=tuple(vi.blocks or ()),
            owner_name=vi.owner_name,
        )
        if out.get("error"):
            return ToolError(kind=str(out.get("error_kind") or "internal"),
                             message=str(out["error"]))
        return ToolSuccess(content=json.dumps(out, ensure_ascii=False, default=str))


def compose_reply(
    *,
    ticket: str,
    answer: str,
    blocks: tuple[str, ...] | list[str] = (),
    owner_name: str = "담당자",
) -> dict[str, Any]:
    """회신 조립 — 도구 껍데기 **밖**의 순수 함수.

    ⚠️ 도구 클래스 안에 두지 않는다. 코어가 `Tool.execute` 직접 호출을 막고 있어
       (`ToolCheckpointBypass`) 안에 두면 도구 하네스 없이는 검증할 수 없다.
       실제로 이 로직에서 값나가는 판단(수신처 결정·빈 담당자 거부)이 일어나므로
       하네스 없이 돌려볼 수 있어야 한다.

    오류는 던지지 않고 `{"error", "error_kind"}` 로 돌려준다 — 도구가 그대로 옮긴다.
    """
    from _shared.reply_body import render_reply
    from _shared.reply_envelope import default_reply_envelope
    from _shared.thread_adapter import get_thread_adapter
    from _shared.ticket_id import parse_ticket

    parsed = parse_ticket(f"[티켓 {str(ticket).strip()}]")
    if parsed is None:
        return {"error": f"티켓 번호를 못 읽었다: {ticket!r} (예: SMB00024)",
                "error_kind": "validation"}
    domain, thread_id = parsed
    adapter = get_thread_adapter(domain)
    if adapter is None:
        return {"error": f"스레드 어댑터 미등록: {domain}", "error_kind": "validation"}
    thread = adapter.thread_get(thread_id)
    if thread is None:
        return {"error": f"{ticket} 스레드가 없다", "error_kind": "not_found"}

    ticket_no = adapter.ticket_no(thread_id)
    if adapter.reply_envelope is not None:
        env = adapter.reply_envelope(thread, ticket_no=ticket_no)
    else:
        env = default_reply_envelope(adapter, thread, ticket_no=ticket_no)
    if env.get("error"):
        return {"error": str(env["error"]), "error_kind": "internal"}
    if not env.get("recipients"):
        # ★ 담당자가 비면 **만들지 않는다.** 잘못된 사람에게 보내는 것보다 낫다.
        #   dev_web 은 지금 담당자 조회원이 없어 여기서 걸린다(실측 2026-08-31).
        return {"error": f"{ticket_no} 수신처를 정할 수 없다 — 담당자가 비어 있다.",
                "error_kind": "internal"}

    # ★ 담당자가 아니라는 답장에는 **조치를 요구하지 않는다**(사용자 지적 2026-09-01).
    #   ⚠️ 이 가드를 `smb_build_reply` 에만 걸었다가 09:48 에 그대로 답장이 나갔다 —
    #      워커가 쓴 것은 **이 공용 도구**였다. 회신을 만드는 도구는 셋이다
    #      (공용 · smb · dev_web). 하나에만 걸면 나머지로 새 나간다.
    from _shared.reply_guard import check_owner_dispute

    inbound_text = str((env.get("original_message") or {}).get("body_excerpt") or "")
    # 자유 문장 회신은 조치 요구로 본다 — 무엇을 쓸지는 LLM 이 정하므로 보수적으로 막는다.
    refusal = check_owner_dispute("how_to", inbound_text)
    if refusal:
        return {"error": refusal, "error_kind": "precondition"}

    built = render_reply(domain=domain, answer=answer, owner_name=owner_name,
                         blocks=tuple(blocks or ()), ticket_no=ticket_no)
    body = built["html"]
    original = env.get("original_message")
    if original:
        # smb: 받은 원문을 인용해 붙인다(스레드 문맥 유지).
        from service.services import remediation_mail as rm

        body = rm.append_original_message(body, original)

    # ★ 회신 본문에는 **인용된 원문**이 딸려 온다. 거기 든 메일 주소는 egress 게이트가
    #   "마스킹 후 PII 잔존" 으로 보고 **발송 전체를 차단한다**(2026-08-31 실측: 6건 차단).
    #   원문에 이미 있던 주소는 우리가 새로 노출하는 것이 아니므로 허용 목록에 싣는다.
    #   ⚠️ 원문에서 **실제로 발견된 값만** 싣는다. 임의 주소를 넣으면 게이트를 우회하는
    #      구멍이 된다 — 허용의 근거는 provenance(원문에 있었다)여야 한다.
    metadata: dict[str, Any] = {
        "domain": domain,
        "thread_id": thread_id,
        "ticket_no": ticket_no,
        # ★ 회신은 공문이 아니다 — Knox 가 `doc_secu_type=OFFICIAL` 을 보고 제목에
        #   `[공문]` 을 붙인다. 사용자 지시(2026-08-31): "답변 에이전트는 [공문]표시 제거".
        #   ⚠️ Knox 스키마의 값은 `OFFICIAL` / `PERSONAL` **둘뿐**이라 뗄 방법이 이것뿐이다.
        #      최초 조치요청은 OFFICIAL 로 둔다 — 그건 공식 통보 기록이다.
        "doc_secu_type": "PERSONAL",
    }
    if original:
        from service.services.remediation_mail import allowed_pii_values

        metadata.update({
            "reply_relation": "inbound_mail",
            "original_mail_message_pk": original.get("id"),
            "original_message_id": original.get("message_id"),
            "in_reply_to": original.get("in_reply_to"),
            "references": original.get("references_header"),
            "delivery_allowed_pii_values": allowed_pii_values(
                original.get("mail_from"), original.get("mail_to"),
                original.get("mail_cc"), original.get("body_excerpt"),
                original.get("body_html"),
            ),
        })

    payload: dict[str, Any] = {
        "kind": "ticket_reply_compose",
        "ticket_no": ticket_no,
        "domain": domain,
        "thread_id": thread_id,
        "subject": env["subject"],
        "body": body,
        "recipients": env["recipients"],
        "cc": env.get("cc") or [],
        "recipient_mode": env.get("mode"),
        "blocks_used": built["blocks_used"],
        "metadata": metadata,
        "deliver_hint": {
            "action": "send",
            "sink_id": "knox_mail",
            "recipients": env["recipients"],
            "cc": env.get("cc") or [],
            "subject": env["subject"],
            "metadata": metadata,
        },
    }
    if built["blocks_unknown"]:
        # ⚠️ 조용히 버리지 않는다 — 없는 블록을 골랐다는 사실을 워커가 알아야 한다.
        payload["blocks_unknown"] = built["blocks_unknown"]
        payload["warning"] = (
            f"등록되지 않은 블록을 골랐다: {built['blocks_unknown']} — 본문에 들어가지 "
            "않았다. 절차 안내가 필요하면 목록에 있는 이름을 써라."
        )
    return payload


def reply_tools() -> list[type]:
    """회신 에이전트 도구셋 — 도메인 무관."""
    return [TicketReadTool, TicketReplyComposeTool]
