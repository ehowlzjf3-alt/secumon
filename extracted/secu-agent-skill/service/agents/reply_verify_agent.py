"""#3 답장·재검증 에이전트 — POP3 답장 → 조치주장 판단 → 재검증 walk → 회신/완결.

(smb_domain_e2e 요구 8·9). 깨우개 루프:
  1) mail_inbound.poll_inbox() — POP3 passive 수집(조치요청 답장만 적재, dedup).
  2) reply_received 스레드 claim → 에이전트가 답장 성격 판단 + smb_reverify_walk +
     회신 3종(deliver knox_mail) → remediated | awaiting_reply 전이.
  3) attempt_count 상한 초과 시 escalated(무한 reverify 방지).

LLM 은 자연어 판단만(조치주장/방법문의). "실제 닫혔는지"는 smb_reverify_walk(코드).
contract: 점검/리포트 도구 미unlock — read_inbox/reverify/reply/deliver 만.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

from domains.smb.application.contracts import (
    COMPONENT_REVERIFY,
    REVERIFY_SESSION_ID,
    SMB_REPLY_VERIFY_PLAN,
)
from service import state_domain as state
from service.agents import runtime

log = logging.getLogger("service.agents.reply_verify")

COMPONENT = COMPONENT_REVERIFY
_SKILL_NAME = SMB_REPLY_VERIFY_PLAN
_SESSION_ID = REVERIFY_SESSION_ID
_ATTEMPT_CAP = 4  # 회신 왕복 상한 — 초과 시 operator escalation
_MAIL_BODY_LIMIT = 120000

_HUMAN_REVIEW_STATUS_BY_DECISION = {
    "business_exception_claim": "exception_review",
    "not_owner": "owner_update_needed",
    "owner_changed": "owner_reassignment_review",
}
_CLOSED_VERDICTS = {"now_closed"}
_PARTIAL_VERDICTS = {"partially_closed"}
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")


def _tool_classes() -> list[type]:
    from secu_agent.agent.tools.skill_tool import SkillTool
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    from domains.smb.plugin.tools.smb_reply_tools import (
        SmbBuildReplyTool, SmbReadInboxTool, SmbRecordReplyDecisionTool,
        SmbReplyDeliverTool,
    )
    from domains.smb.plugin.tools.smb_reverify_tool import SmbReverifyWalkTool
    from _shared.reply_tools import TicketReadTool, TicketReplyComposeTool

    return [
        # ★ 4도메인 공용 — 티켓을 읽고 답을 쓴다. 도메인이 이름에 붙지 않는다.
        TicketReadTool, TicketReplyComposeTool,
        SmbReadInboxTool, SmbRecordReplyDecisionTool,
        SmbReverifyWalkTool, SmbBuildReplyTool,
        SmbReplyDeliverTool, SkillTool, ToolSearchTool,
    ]


def _thread_finding_ids(thread: dict[str, Any]) -> list[int]:
    ids = state.mail_thread_finding_ids(int(thread["id"]))
    if ids:
        return ids
    try:
        return [int(thread["finding_id"])]
    except Exception:
        return []


def _finding_scope_text(thread: dict[str, Any], finding: dict[str, Any] | None) -> str:
    from secu_agent import state as cs

    lines: list[str] = []
    for fid in _thread_finding_ids(thread):
        row = finding if finding and int(finding.get("id") or 0) == fid else cs.finding_get(fid)
        asset = str((row or {}).get("asset") or "")
        lines.append(f"- finding_id={fid} asset={asset or '(unknown)'}")
    return "\n".join(lines) if lines else "- finding_id=(unknown)"


def _ticket_no(thread: dict[str, Any]) -> str:
    """이 스레드의 티켓 번호 — 회신 도구의 **유일한 좌표**다."""
    from _shared.ticket_id import ticket_no

    return ticket_no("smb", int(thread["id"]))


def _block_menu_text(thread: dict[str, Any]) -> str:
    """프롬프트에 실을 회신 블록 목록.

    ⚠️ 본문은 싣지 않는다 — 이름과 용도만. 본문을 보여주면 LLM 이 그걸 **베껴서**
       answer 에 다시 쓴다(블록이 두 번 들어간다).
    """
    from _shared.reply_body import block_menu

    return block_menu("smb")


def _build_user_text(thread: dict[str, Any], finding: dict[str, Any] | None) -> str:
    scope = _finding_scope_text(thread, finding)
    return (
        f"[조치요청 답장 처리] thread_id={thread['id']} host={thread['host']} "
        f"finding_id={thread['finding_id']} (attempt={thread.get('attempt_count')})\n"
        f"이 IP thread 에 묶인 재검증 scope:\n{scope}\n\n"
        f"이 스레드의 답장을 처리하라.\n\n"
        f"1) ticket_read(ticket='{_ticket_no(thread)}') 로 **티켓을 먼저 읽어라.**\n"
        f"   - 우리가 담당자에게 뭐라고 보냈는지(sent.body_text), 어떤 대상이 걸렸는지"
        f"(findings[].hits[].location)가 여기 있다.\n"
        f"   - 담당자 질문에 답하려면 이 사실이 있어야 한다. 없는 것을 지어내지 마라.\n"
        f"2) smb_read_inbox(thread_id={thread['id']}) 로 최신 발송 이후 pending 답장만 확인.\n"
        f"   - body_excerpt 에 Original Message 이후 인용 원문이 포함될 수 있다. "
        f"답장 성격 판단은 reply_text 또는 separator 이전 신규 답장 본문만 사용하고, "
        f"인용된 DSSOC 원문은 판단 근거로 삼지 마라.\n"
        f"3) smb_record_reply_decision 으로 답장 성격을 기록:\n"
        f"   - remediation_claim / how_to_question / still_needed / unclear\n"
        f"   - business_exception_claim / not_owner / owner_changed\n"
        f"4) 업무 목적 예외, 담당자 아님, 담당자 변경이면 즉시 기록 후 종료. "
        f"재검증이나 추가 회신을 하지 말고 HITL 상태로 넘긴다.\n"
        f"5) **조치 완료 주장이면 반드시** 위 scope 의 각 finding_id 에 대해 "
        f"smb_reverify_walk(host='{thread['host']}', share=<노출 공유>, "
        f"path_prefix=<노출 경로>, finding_id=<finding_id>) 로 실제 재검증.\n"
        f"   - communication_unavailable 는 PC off/SMB 통신 불가 상태이므로 메일을 보내지 말고 "
        f"8시간 후 재검증 예약 상태로 둔다.\n"
        f"\n"
        f"6) 회신 — ★ **담당자가 물은 것에 답하라.**\n"
        f"   ticket_reply_compose(ticket='{_ticket_no(thread)}', answer=<네가 쓴 답>, "
        f"blocks=[...]) 로 본문을 만든다.\n"
        f"   - answer 는 **네가 직접 쓴다.** 담당자가 폴더 위치를 물었으면 위치를, "
        f"기간을 물었으면 기간을, 이유를 물었으면 이유를 답해라. "
        f"고정된 양식에 끼워 맞추지 마라 — 질문과 다른 답을 보내는 것이 "
        f"가장 흔한 실패다.\n"
        f"   - 절차 안내처럼 문구가 고정된 것은 **직접 쓰지 말고 blocks 로 골라라**:\n"
        f"{_block_menu_text(thread)}\n"
        f"   - 모르는 것은 모른다고 쓰고, DSSOC 가 확인 후 회신하겠다고 안내해라.\n"
        f"   - 수신처·제목·인사·서명은 도구가 붙인다. answer 에 넣지 마라.\n"
        f"\n"
        f"   ⚠️ 예외 하나 — 재검증 결과 **아직 열려 있으면**(still_open) "
        f"smb_build_reply(reply_kind='not_fixed', thread_id={thread['id']}) 를 쓴다. "
        f"그 도구만 '아직 열린 공유/권한 표'를 자동으로 붙인다. "
        f"finding_id 나열식 detail 은 금지.\n"
        f"\n7) 회신 발송 후 종료. (status 전이는 시스템이 처리.)"
    )


def _classify_outcome(evidence_dir: str) -> dict[str, Any]:
    """에이전트가 evidence_dir 에 남긴 reverify/reply 흔적으로 결과 분류 (보강용).

    1차 판단은 에이전트 도구 호출 자체(deliver=종료). 여기선 status 전이만 결정.
    """
    return {}


def _next_actionable_inbound_message(thread_id: int) -> dict[str, Any] | None:
    state.mail_messages_mark_stale_before_latest_outbound(thread_id)
    return state.mail_message_next_pending_reply(thread_id)


def _mail_body_for_thread(body: Any, *, limit: int = _MAIL_BODY_LIMIT) -> str:
    raw = str(body or "")
    if len(raw) > limit:
        return raw[:limit].rstrip() + "\n<!-- mail body truncated for thread display -->"
    return raw


def _deliver_call(result: dict[str, Any]) -> dict[str, Any]:
    calls = result.get("terminal_calls") or []
    if not isinstance(calls, list):
        return {}
    for call in reversed(calls):
        if not isinstance(call, dict) or call.get("name") != "deliver":
            continue
        return call
    return {}


#: 회신 본문을 만드는 종료 도구들.
#  ★ `ticket_reply_compose` 가 4도메인 공용 신규 도구다(`_shared/reply_tools`).
#    `smb_build_reply` 는 남겨 둔다 — `not_fixed` 회신에서 "아직 열린 공유 표"를
#    자동으로 붙이는 재검증 전용 경로가 거기에만 있다. 지우면 그 기능이 사라진다.
_BUILD_REPLY_TOOLS = ("ticket_reply_compose", "smb_build_reply")


def _build_reply_call(result: dict[str, Any]) -> dict[str, Any]:
    calls = result.get("terminal_calls") or []
    if not isinstance(calls, list):
        return {}
    for call in reversed(calls):
        if not isinstance(call, dict) or call.get("name") not in _BUILD_REPLY_TOOLS:
            continue
        return call
    return {}


def _deliver_input(result: dict[str, Any]) -> dict[str, Any]:
    payload = _deliver_call(result).get("input") or {}
    return payload if isinstance(payload, dict) else {}


def _delivery_mode(result: dict[str, Any]) -> str | None:
    if not result.get("saw_terminal"):
        return None
    call = _deliver_call(result)
    if not call:
        return None
    content = str(call.get("result_content") or "")
    if not content:
        return "sent"
    lowered = content.lower()
    if "dry-run" in lowered:
        return "dry_run"
    if "발송 완료" in content or "sent" in lowered:
        return "sent"
    return "unknown"


def _built_reply_payload(result: dict[str, Any]) -> dict[str, Any]:
    call = _build_reply_call(result)
    content = str(call.get("result_content") or "")
    if content:
        try:
            built = json.loads(content)
            if isinstance(built, dict):
                return built
        except ValueError:
            pass
    evidence_dir = Path(str(result.get("evidence_dir") or ""))
    if not evidence_dir.is_dir():
        return {}
    candidates = sorted(
        c for name in _BUILD_REPLY_TOOLS for c in evidence_dir.glob(f"*_{name}_*.json")
    )
    if not candidates:
        return {}
    try:
        built = json.loads(candidates[-1].read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return built if isinstance(built, dict) else {}


def _built_reply_delivery_input(result: dict[str, Any]) -> dict[str, Any]:
    built = _built_reply_payload(result)
    if not built:
        return {}
    hint = built.get("deliver_hint") if isinstance(built.get("deliver_hint"), dict) else {}
    subject = str(hint.get("subject") or built.get("subject") or "")
    body = str(built.get("body") or "")
    recipients = hint.get("recipients") or built.get("recipients") or []
    cc = hint.get("cc") or built.get("cc") or []
    metadata = hint.get("metadata") if isinstance(hint.get("metadata"), dict) else {}
    return {
        "action": "send",
        "sink_id": str(hint.get("sink_id") or "knox_mail"),
        "recipients": [str(x).strip() for x in recipients if str(x).strip()],
        "cc": [str(x).strip() for x in cc if str(x).strip()],
        "subject": subject,
        "body": body,
        "metadata": metadata,
    }


async def _deliver_built_reply_if_needed(
    result: dict[str, Any],
    *,
    charter_ref: str,
) -> None:
    if _deliver_call(result):
        return
    payload = _built_reply_delivery_input(result)
    if not payload:
        return
    from secu_agent.agent import delivery as delivery_mod
    from secu_agent.agent.delivery import DeliveryPayload

    evidence_dir = Path(str(result.get("evidence_dir") or "")) if result.get("evidence_dir") else None
    if evidence_dir is None:
        return
    delivery_result = await delivery_mod.deliver(
        str(payload["sink_id"]),
        DeliveryPayload(
            subject=str(payload["subject"]),
            body=str(payload["body"]),
            recipients=tuple(payload["recipients"]),
            cc=tuple(payload["cc"]),
            metadata=payload["metadata"] or None,
        ),
        evidence_dir=evidence_dir,
        charter_ref=charter_ref,
    )
    if delivery_result.mode == "sent":
        content = f"[deliver:{delivery_result.sink_id}] 발송 완료 — {delivery_result.detail}"
    else:
        content = f"[deliver:{delivery_result.sink_id}] dry-run — {delivery_result.detail}"
    calls = result.setdefault("terminal_calls", [])
    if isinstance(calls, list):
        calls.append({
            "name": "deliver",
            "input": payload,
            "result_content": content,
        })


def _sent_reply_mail_fields(thread: dict[str, Any], result: dict[str, Any]) -> dict[str, str | None]:
    payload = _deliver_input(result)
    recipients = payload.get("recipients")
    if isinstance(recipients, list):
        requested_to = [str(x).strip() for x in recipients if str(x).strip()]
    else:
        requested_to = [str(recipients).strip()] if str(recipients or "").strip() else []
    to = ", ".join(requested_to) or None
    cc = payload.get("cc")
    if isinstance(cc, list):
        requested_cc = [str(x).strip() for x in cc if str(x).strip()]
    else:
        requested_cc = [str(cc).strip()] if str(cc or "").strip() else []
    subject = str(
        payload.get("subject")
        or f"RE: {thread.get('subject_tag') or '[보안취약점 조치요청]'}"
    )
    return {
        "subject": subject,
        "mail_to": to,
        "mail_cc": ", ".join(requested_cc) or None,
        "body_excerpt": _mail_body_for_thread(payload.get("body")),
    }


def _record_sent_reply_mail(thread: dict[str, Any], result: dict[str, Any]) -> None:
    fields = _sent_reply_mail_fields(thread, result)
    state.mail_message_add(
        direction="out",
        thread_id=int(thread["id"]),
        subject=fields["subject"],
        subject_tag=thread.get("subject_tag"),
        mail_from="dssoc",
        mail_to=fields["mail_to"],
        mail_cc=fields["mail_cc"],
        body_excerpt=fields["body_excerpt"],
        # ⚠️ 회신 본문은 HTML 이다. `body_html` 을 안 채우면 게이트웨이가 `isHtml=false` 로
        #    내려보내고 콘솔이 원시 마크업을 그대로 그린다 — 화면에선 "메일이 안 뜬다" 로 보인다.
        #    최초 조치요청(`report_mail_agent._record_outbound`)은 채우는데 회신만 빠져 있었다
        #    (2026-08-31 실측: smb 24 본문 `isHtml=false`, 내용은 `<div style=...`).
        body_html=(
            fields["body_excerpt"]
            if fields["body_excerpt"] and "<" in fields["body_excerpt"]
            else None
        ),
        agent_verdict="sent",
    )


def _owner_hint(text: str) -> dict[str, str]:
    match = _EMAIL_RE.search(text or "")
    out: dict[str, str] = {}
    if match:
        out["email"] = match.group(0)
    return out


def _replier_differs_from_recipient(
    message: dict[str, Any] | None, thread: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """**우리가 보낸 사람과 답한 사람이 다르면** 담당자가 바뀐 것이다.

    ## 왜 문구로는 못 잡나 (2026-09-01 실측)

    스레드 37 은 `jaehun82.sim@samsung.com`(심재훈, Splunk 자산 담당자)에게 보냈는데
    `donghee4.kim@samsung.com`(김동희)이 답했다. 담당자가 바뀐 게 분명한데 본문에는
    "담당자" 라는 말이 한 번도 없다 — 그냥 "설정한 적이 없는데 방법 알려주세요" 였다.
    기존 판정기는 **문구**만 봐서 아무것도 못 잡았고, 자산 담당자 기록도 심재훈 그대로다.

    주소 비교는 문구와 달리 **틀릴 수 없는 신호**다. 사람이 확인해 담당자를 고치면 된다.

    ⚠️ 전달(FW)로 온 것과 구분되지 않는다 — 그래서 자동 교체가 아니라 **HITL** 이다.
    ⚠️ DSSOC 자기 자신은 제외한다(우리가 우리에게 보낸 사본).
    """
    if not message or not thread:
        return None
    from service.services import remediation_mail as rm

    sent_to = {a.lower() for a in rm._mail_addresses(thread.get("recipient"))}
    replied = {a.lower() for a in rm._mail_addresses(message.get("mail_from"))}
    if not sent_to or not replied:
        return None
    dssoc = {a.lower() for a in rm._dssoc_recipients()} if hasattr(rm, "_dssoc_recipients") else set()
    replied -= dssoc
    if not replied or replied & sent_to:
        return None
    return {
        "decision": "owner_changed",
        "confidence": 0.9,
        "reason": (
            f"보낸 대상({', '.join(sorted(sent_to))})과 답한 사람"
            f"({', '.join(sorted(replied))})이 다르다 — 담당자 확인 필요"
        ),
        "owner": {"email": sorted(replied)[0]},
    }


def _heuristic_human_review_decision(
    message: dict[str, Any] | None, thread: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    # ★ 주소가 다르면 문구를 보기 전에 잡는다 — 문구는 안 쓰는 경우가 많다.
    by_address = _replier_differs_from_recipient(message, thread)
    if by_address:
        return by_address
    if not message:
        return None
    from service.collector.mail_inbound import new_reply_text

    reply_text = new_reply_text(str(message.get("body_excerpt") or ""))
    text = f"{message.get('subject') or ''}\n{reply_text}".lower()
    compact = re.sub(r"\s+", "", text)
    if (
        ("담당자" in text and any(k in text for k in ("변경", "바뀌", "이관", "교체", "후임", "새 담당")))
        or ("owner" in text and any(k in text for k in ("changed", "transfer", "new owner")))
    ):
        return {
            "decision": "owner_changed",
            "confidence": 0.86,
            "reason": "답장에서 담당자 변경/이관을 언급함",
            "owner": _owner_hint(text),
        }
    if (
        "담당자가아닙" in compact
        or "담당자아님" in compact
        or ("제가" in text and "담당" in text and any(k in text for k in ("아닙", "아니", "아님")))
        or ("not" in text and "owner" in text)
    ):
        return {
            "decision": "not_owner",
            "confidence": 0.84,
            "reason": "답장에서 본인이 담당자가 아니라고 밝힘",
            "owner": _owner_hint(text),
        }
    if any(k in text for k in ("업무 목적", "업무상", "업무적으로", "업무 필요", "운영상", "예외 승인", "예외처리")):
        return {
            "decision": "business_exception_claim",
            "confidence": 0.78,
            "reason": "답장에서 업무 목적/예외 필요성을 언급함",
            "owner": _owner_hint(text),
        }
    return None


def _record_human_review(
    thread: dict[str, Any],
    message: dict[str, Any],
    decision: dict[str, Any],
    *,
    created_by: str,
) -> dict[str, Any]:
    thread_id = int(thread["id"])
    kind = str(decision["decision"])
    status = _HUMAN_REVIEW_STATUS_BY_DECISION[kind]
    state.mail_reply_decision_add(
        thread_id=thread_id,
        message_id_pk=int(message["id"]) if message.get("id") else None,
        decision=kind,
        confidence=decision.get("confidence"),
        reason=str(decision.get("reason") or ""),
        extracted_owner=decision.get("owner") or {},
        created_by=created_by,
    )
    if message.get("id"):
        state.mail_message_set_verdict(
            int(message["id"]),
            verdict=f"hitl_{kind}",
            thread_id=thread_id,
        )
    state.mail_thread_set_status(
        thread_id,
        status,
        last_reason=str(decision.get("reason") or f"reply decision: {kind}"),
    )
    return {
        "thread_id": thread_id,
        "human_review": True,
        "decision": kind,
        "final_status": status,
    }


def _human_review_status_from_latest_decision(thread_id: int) -> tuple[str, str] | None:
    decision = state.mail_reply_decision_latest(thread_id)
    if not decision:
        return None
    kind = str(decision.get("decision") or "")
    status = _HUMAN_REVIEW_STATUS_BY_DECISION.get(kind)
    if not status:
        return None
    return kind, status


def _reverify_final_status(thread: dict[str, Any]) -> tuple[str | None, str]:
    thread_id = int(thread["id"])
    fids = _thread_finding_ids(thread)
    latest = state.mail_reverify_latest_by_finding(thread_id)
    if not latest:
        return None, "no structured reverify result"
    missing = [fid for fid in fids if fid not in latest]
    verdicts = [str(row.get("verdict") or "") for row in latest.values()]
    if any(v == "communication_unavailable" for v in verdicts):
        return "reply_received", "SMB communication unavailable; retry scheduled"
    if any(v == "still_open" for v in verdicts):
        return "awaiting_reply", "one or more scopes still_open"
    if missing:
        return "partially_remediated", f"missing reverify results for finding_ids={missing}"
    if verdicts and all(v in _CLOSED_VERDICTS for v in verdicts):
        return "remediated", "all scopes now_closed"
    if any(v in _CLOSED_VERDICTS or v in _PARTIAL_VERDICTS for v in verdicts):
        return "partially_remediated", "one or more scopes partially closed"
    return "awaiting_reply", "reverify did not prove closure"


def _mark_message_handled(message: dict[str, Any] | None, status: str) -> None:
    msg = message
    if not msg or not msg.get("id"):
        return
    state.mail_message_set_verdict(
        int(msg["id"]),
        verdict=f"handled_{status}",
        thread_id=int(msg["thread_id"]) if msg.get("thread_id") else None,
    )


def _mark_message_pending(message: dict[str, Any] | None, thread_id: int) -> None:
    if not message or not message.get("id"):
        return
    state.mail_message_set_verdict(
        int(message["id"]),
        verdict="pending",
        thread_id=thread_id,
    )


async def _handle_thread(
    thread: dict[str, Any],
    *,
    charter_ref: str,
    evidence_dir: Path | None = None,
) -> dict[str, Any]:
    thread_id = thread["id"]
    from secu_agent import state as cs
    finding = cs.finding_get(thread["finding_id"]) if thread.get("finding_id") else None

    # 담당자 변경/업무 예외/담당자 아님은 재검증/반복 카운트가 아니라 즉시 HITL.
    latest_msg = _next_actionable_inbound_message(thread_id)
    if not latest_msg:
        fallback = "awaiting_reply"
        state.mail_thread_set_status(
            thread_id,
            fallback,
            last_reason="no inbound mail after latest outbound",
        )
        return {
            "thread_id": thread_id,
            "skipped": True,
            "final_status": fallback,
            "reason": "no actionable inbound after latest outbound",
        }
    # ★ 스레드를 함께 넘긴다 — 우리가 보낸 주소와 답한 주소를 비교해야 담당자 변경이 잡힌다.
    #   (넘기지 않으면 함수는 있는데 그 판정만 조용히 죽는다 — 이 저장소의 단골 형태다.)
    decision = _heuristic_human_review_decision(latest_msg, thread)
    if decision and latest_msg:
        result = _record_human_review(
            thread, latest_msg, decision, created_by="reply_heuristic",
        )
        log.info("[reverify] thread=%s human-review decision=%s final=%s",
                 thread_id, result["decision"], result["final_status"])
        return result

    # attempt cap → escalation (무한 reverify 방지). HITL성 답장은 위에서 제외.
    if int(thread.get("attempt_count") or 0) > _ATTEMPT_CAP:
        state.mail_thread_set_status(thread_id, "escalated", last_reason="attempt cap 초과")
        _mark_message_handled(latest_msg, "escalated")
        log.warning("[reverify] thread=%s attempt cap 초과 → escalated", thread_id)
        return {"thread_id": thread_id, "escalated": True}

    state.mail_thread_set_status(thread_id, "reverifying",
                                 claimed_by=_SESSION_ID, claimed_at=time.time())
    try:
        result = await runtime.run_agent(
            tool_classes=_tool_classes(),
            skill_body=runtime.load_skill_contract(_SKILL_NAME, resource="worker.md"),
            user_text=_build_user_text(thread, finding),
            label=f"reverify-{thread['host']}-{thread['finding_id']}",
            terminal_tools={"deliver", "smb_build_reply", "ticket_reply_compose"},
            charter_ref=charter_ref,
            max_turns=int(os.environ.get("SMB_REVERIFY_MAX_TURNS", "20")),
            # 같은 배선 누락(→ report_mail_agent 주석). `reply_verify` 플래그가 꺼져 있어
            # 아직 안 터졌을 뿐, 켜는 순간 메일 워커와 같은 자리에서 죽는다.
            max_idle_sec=int(os.environ.get("SMB_REVERIFY_MAX_IDLE_SEC", "360")),
            max_wall_clock_sec=int(os.environ.get("SMB_REVERIFY_MAX_WALL_SEC", "900")),
            evidence_dir=evidence_dir,
            extra_metadata={"smb_host": thread["host"], "finding_id": thread["finding_id"]},
        )
    except Exception as e:  # noqa: BLE001
        log.warning("[reverify] thread=%s 실패: %r", thread_id, e)
        state.mail_thread_set_status(thread_id, "reply_received")  # claim 해제, 재시도
        _mark_message_pending(latest_msg, thread_id)
        return {"thread_id": thread_id, "error": repr(e)[:200]}

    try:
        await _deliver_built_reply_if_needed(result, charter_ref=charter_ref)
    except Exception as e:  # noqa: BLE001
        result["reply_delivery_error"] = repr(e)[:240]
        log.warning("[reverify] thread=%s build-reply delivery failed: %r", thread_id, e)

    human = _human_review_status_from_latest_decision(thread_id)
    if human:
        kind, final_status = human
        state.mail_thread_set_status(
            thread_id,
            final_status,
            last_reason=f"reply decision requires HITL: {kind}",
        )
        _mark_message_handled(latest_msg, final_status)
        log.info("[reverify] thread=%s decision=%s final=%s",
                 thread_id, kind, final_status)
        return {"thread_id": thread_id, "decision": kind, "final_status": final_status, **result}

    # 결정적 전이: 재검증 도구가 남긴 structured result 기준.
    # 회신이 필요한 결과는 deliver 가 실제 sent 로 확인된 뒤에만 상태를 넘긴다.
    final_status = "reply_received"  # 미처리 — 재시도 기본
    delivery_mode = _delivery_mode(result)
    delivery_required = False
    if result.get("saw_terminal"):
        proposed, reason = _reverify_final_status(thread)
        if proposed == "remediated":
            delivery_required = True
            if delivery_mode == "sent":
                closed = state.mail_thread_resolve_thread(thread_id, status="remediated")
                log.info("[reverify] thread=%s 조치완료 — finding %d건 resolved", thread_id, closed)
                final_status = "remediated"
        elif proposed == "partially_remediated":
            delivery_required = True
            if delivery_mode == "sent":
                state.mail_thread_set_status(thread_id, "partially_remediated", last_reason=reason)
                final_status = "partially_remediated"
        elif proposed == "reply_received":
            state.mail_thread_set_status(thread_id, "reply_received", last_reason=reason)
            final_status = "reply_received"
        else:
            delivery_required = True
            if delivery_mode == "sent":
                next_status = proposed if proposed in {"awaiting_reply", "re_requested"} else "awaiting_reply"
                state.mail_thread_set_status(thread_id, next_status, last_reason=reason)
                final_status = next_status
        if delivery_required and delivery_mode != "sent":
            content = str(
                result.get("reply_delivery_error")
                or _deliver_call(result).get("result_content")
                or ""
            ).strip()
            blocked_reason = content[:240] if content else f"reply delivery {delivery_mode or 'unknown'}"
            state.mail_thread_set_status(
                thread_id,
                "reply_received",
                last_reason=blocked_reason,
            )
            _mark_message_pending(latest_msg, thread_id)
            final_status = "reply_received"
        elif delivery_required:
            _record_sent_reply_mail(thread, result)
    if final_status == "reply_received":
        _mark_message_pending(latest_msg, thread_id)
    if final_status not in {"remediated", "partially_remediated", "re_requested", "awaiting_reply"}:
        state.mail_thread_set_status(thread_id, final_status)
    if result.get("saw_terminal") and final_status != "reply_received":
        state.mail_thread_bump_attempt(thread_id, reason=f"reply sent: {final_status}")
        _mark_message_handled(latest_msg, final_status)
    log.info("[reverify] thread=%s submit=%s final=%s reason=%s",
             thread_id, result.get("saw_terminal"), final_status, result.get("reason"))
    return {
        "thread_id": thread_id,
        "final_status": final_status,
        "delivery_mode": delivery_mode,
        "reply_delivery_required": delivery_required,
        **result,
    }


#: `ThreadAdapter.deliver_recheck` 계약 슬롯의 공개 이름.
#  ⚠️ 별칭이다 — 구현은 위 `_handle_thread` 한 벌뿐이다. smb 재검증은 **inbound 답장**이 방아쇠다(`reply_received` claim) — 주기 재조회가 아니다.
recheck_thread_async = _handle_thread


async def run_reply_pass(*, max_threads: int | None = None, charter_ref: str = "",
                         poll_pop3: bool = True) -> dict[str, Any]:
    # ★ 4도메인 동일 — github·confluence·dev_web 리포트 러너는 첫 줄에서 이걸 부른다.
    #   smb·회신 경로 셋만 빠져 있어서 `python -m` 단독 기동이 DSN 없이 죽었다
    #   (2026-08-31 실측). 호출부가 미리 로드했겠거니 하면 안 된다.
    from service.runtime_env import load_runtime_env

    load_runtime_env(load_plugins=False)
    state.heartbeat_upsert(COMPONENT, phase="reverify", pid=os.getpid())
    run_id = state.pipeline_run_start(COMPONENT)
    state.mail_thread_reclaim_stale()

    inbox = {}
    if poll_pop3:
        from service.collector import mail_inbound
        try:
            inbox = await asyncio.to_thread(mail_inbound.poll_inbox)
        except Exception as e:  # noqa: BLE001 — POP3 실패가 큐 처리를 막지 않음
            log.warning("[reverify] POP3 poll 실패: %r", e)
            inbox = {"error": repr(e)[:200]}

    handled = 0
    try:
        while True:
            if max_threads is not None and handled >= max_threads:
                break
            thread = state.mail_thread_claim_next(session_id=_SESSION_ID, status="reply_received")
            if thread is None:
                break
            handled += 1
            await _handle_thread(thread, charter_ref=charter_ref)
    finally:
        state.pipeline_run_finish(run_id, status="ok",
                                  detail=f"inbox={inbox} handled={handled}")
    return {"inbox": inbox, "handled": handled}


def main(argv: "list[str] | None" = None) -> int:
    import argparse
    logging.basicConfig(level=os.environ.get("SMB_AGENT_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    p = argparse.ArgumentParser(description="SMB #3 답장·재검증 에이전트")
    p.add_argument("--max-threads", type=int, default=None)
    p.add_argument("--no-pop3", action="store_true", help="POP3 폴 생략(큐만 처리)")
    p.add_argument("--charter", default=os.environ.get("DEFAULT_CHARTER_REF", "SECOPS-2026-001"))
    args = p.parse_args(argv)
    res = asyncio.run(run_reply_pass(
        max_threads=args.max_threads, charter_ref=args.charter, poll_pop3=not args.no_pop3,
    ))
    log.info("[reverify] pass done %s", res)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
