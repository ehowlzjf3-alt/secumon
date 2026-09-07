"""Service-domain how-to reply guidance.

GitHub/Confluence POP3 intake stays passive: it classifies replies and moves
threads to deterministic states. This agent handles the SMB-parity follow-up
for owner questions that ask how to remediate.
"""
from __future__ import annotations

import asyncio
import os
import time
from html import escape
from pathlib import Path
from typing import Any

from service import state_domain as state
from service.agents import runtime
from service.services.remediation_mail import (
    allowed_pii_values,
    append_original_message,
    reply_subject,
    reply_targets,
)
from secu_agent.agent.delivery import DeliveryPayload, deliver
from service.services import owner_recipients as orx

OUTBOUND_HOW_TO_GUIDANCE = "outbound_how_to_guidance"
_ATTEMPT_CAP = 4


def _domain_subject_tag(domain: str, thread: dict[str, Any]) -> str:
    if thread.get("subject_tag"):
        return str(thread["subject_tag"])
    if domain == "github":
        return state.normalize_github_subject_tag(str(thread.get("repo") or ""))
    if domain == "confluence":
        return state.normalize_confluence_subject_tag(str(thread.get("space_key") or ""))
    raise ValueError(f"invalid service reply domain: {domain!r}")


def _scope_name(domain: str, thread: dict[str, Any]) -> str:
    if domain == "github":
        return str(thread.get("repo") or "")
    if domain == "confluence":
        return str(thread.get("space_key") or "")
    raise ValueError(f"invalid service reply domain: {domain!r}")


def _status_setter(domain: str):
    if domain == "github":
        return state.github_report_thread_set_status
    if domain == "confluence":
        return state.confluence_report_thread_set_status
    raise ValueError(f"invalid service reply domain: {domain!r}")


def _attempt_bumper(domain: str):
    if domain == "github":
        return state.github_report_thread_bump_attempt
    if domain == "confluence":
        return state.confluence_report_thread_bump_attempt
    raise ValueError(f"invalid service reply domain: {domain!r}")


def _attempt_cap_exceeded(thread: dict[str, Any]) -> bool:
    return int(thread.get("attempt_count") or 0) > _ATTEMPT_CAP


def _escalate_attempt_cap(domain: str, thread_id: int) -> None:
    _status_setter(domain)(
        thread_id,
        "escalated",
        last_reason=f"{domain} how-to guidance attempt cap exceeded",
    )


def _dssoc_recipients(domain: str) -> list[str]:
    """DSSOC 수신자 — 도메인 env 를 먼저 본다.

    ⚠️ 예전엔 전역(`SA_DSSOC_MAIL_RECIPIENT`)을 **먼저** 보고 그다음 github → confluence
    순이었다. 다른 도메인은 전부 `도메인 → 전역` 순이라 여기만 반대였는데, 이 에이전트가
    두 도메인을 함께 처리하면서 도메인을 안 받아 고를 수가 없었기 때문이다.
    호출부는 도메인을 아니 넘겨받아 정확히 고른다.
    """
    name = str(domain or "").strip().upper()
    domain_env = f"{name}_REMEDIATION_DSSOC_RECIPIENT" if name else ""
    names = (domain_env, "SA_DSSOC_MAIL_RECIPIENT") if domain_env else ("SA_DSSOC_MAIL_RECIPIENT",)
    return orx.dssoc_recipients(*names)


#: 도메인별 도입 문장 + 붙일 블록. **절차 문구는 여기 없다** — 블록이 갖는다.
_GUIDANCE_INTRO = {
    "github": ("{scope} 저장소 시크릿 노출 조치 방법을 안내드립니다.",
               "github_remediation_steps"),
    "confluence": ("{scope} Confluence 콘텐츠 조치 방법을 안내드립니다.",
                   "confluence_remediation_steps"),
}


#: 도메인 → 회신 블록 팩토리 모듈. 블록 등록은 **멱등**이라 몇 번 불러도 안전하다.
_BLOCK_MODULES = {
    "github": "domains.services.github.plugin.reply_blocks",
    "confluence": "domains.services.confluence.plugin.reply_blocks",
}


def _ensure_reply_blocks(domain: str) -> None:
    """이 도메인의 회신 블록이 등록돼 있게 한다.

    ★ 2026-08-31 — 여기서 `render_reply` 를 쓰기 시작하면서 이 함수가 조용히
      **`plugin/bootstrap.register_all()` 에 의존**하게 됐다. 이 에이전트는 LLM 도
      도구도 안 쓰는 순수 코드라 부트스트랩을 부를 이유가 없고, 실제로 스위트에서
      **다른 테스트가 먼저 부트스트랩한 덕에** 통과하고 있었다(순서 의존).

      "누가 먼저 등록해 줬겠지" 에 기대지 않는다 — 자기가 쓰는 것은 자기가 보장한다.
      등록이 멱등이라 부트스트랩과 중복돼도 무해하다.
    """
    from importlib import import_module

    from _shared.reply_body import register_reply_block

    module = _BLOCK_MODULES.get(domain)
    if module is None:
        return
    factory = getattr(import_module(module), f"{domain}_reply_blocks")
    for block in factory():
        register_reply_block(block)


def _guidance_body(domain: str, thread: dict[str, Any], message: dict[str, Any]) -> str:
    """조치 방법 안내 본문.

    ★ 2026-08-31 — 여기 있던 인라인 절차 문구를 걷어냈다. 같은 사안에 대해
      **세 벌**이 서로 다른 말을 하고 있었다(실측):

        1. 조치요청 리포트 본문   `scanner.py` / `reporter.py` 의 "■ 조치 방법"
        2. 회신 블록              `domains/*/plugin/reply_blocks.py`
        3. 여기                   4단계, 문구가 1·2 와 달랐다

      담당자 입장에선 DSSOC 가 말을 바꾸는 것이다. 이제 셋 다 블록 하나를 읽고,
      드리프트는 `service/tests/test_reply_blocks_no_drift.py` 가 잡는다.

    ⚠️ 본문 조립(인사·회신요청·서명·티켓번호)도 4도메인 공용 껍데기를 쓴다
       (`_shared/reply_body.render_reply`).
    """
    spec = _GUIDANCE_INTRO.get(domain)
    if spec is None:
        raise ValueError(f"invalid service reply domain: {domain!r}")
    intro, block = spec
    _ensure_reply_blocks(domain)

    from _shared.reply_body import render_reply
    from _shared.ticket_id import ticket_no

    built = render_reply(
        domain=domain,
        answer=intro.format(scope=_scope_name(domain, thread)),
        blocks=(block,),
        ticket_no=ticket_no(domain, int(thread["id"])),
    )
    if built["blocks_unknown"]:
        # 블록 등록이 빠진 채로 조용히 절차 없는 안내가 나가면 안 된다.
        raise RuntimeError(
            f"{domain} 회신 블록 미등록: {built['blocks_unknown']} — "
            "plugin/bootstrap.py:_register_reply_blocks 확인"
        )
    return append_original_message(built["html"], message)


async def deliver_how_to_guidance(
    domain: str,
    thread: dict[str, Any],
    message: dict[str, Any],
    *,
    evidence_dir: Path,
    charter_ref: str = "",
) -> dict[str, Any]:
    domain = str(domain or "").strip().lower()
    recipients, cc = reply_targets(message, dssoc_recipients=_dssoc_recipients(domain))
    subject = reply_subject(
        _domain_subject_tag(domain, thread),
        original_subject=str(message.get("subject") or ""),
    )
    body = _guidance_body(domain, thread, message)
    metadata = {
        "domain": domain,
        "thread_id": int(thread["id"]),
        "reply_message_id": int(message["id"]),
        "delivery_policy": "reply_to_inbound_sender",
        "content_type": "HTML",
        "in_reply_to": message.get("message_id") or message.get("in_reply_to"),
        "references": message.get("references_header"),
        "root_message_id": message.get("root_message_id"),
        "delivery_allowed_pii_values": allowed_pii_values(
            message.get("mail_from"),
            message.get("mail_to"),
            message.get("mail_cc"),
            *recipients,
            *cc,
        ),
    }
    if domain == "github":
        metadata["repo"] = thread.get("repo")
    else:
        metadata["space_key"] = thread.get("space_key")
    payload = DeliveryPayload(
        subject=subject,
        body=body,
        recipients=tuple(recipients),
        cc=tuple(cc),
        finding_id=int(thread.get("finding_id") or 0) or None,
        metadata=metadata,
    )
    result = await deliver(
        "knox_mail",
        payload,
        evidence_dir=Path(evidence_dir),
        charter_ref=charter_ref,
    )
    if result.mode == "sent":
        state.service_reply_message_add(
            domain=domain,
            direction="out",
            thread_id=int(thread["id"]),
            in_reply_to=message.get("message_id") or message.get("in_reply_to"),
            references_header=message.get("references_header"),
            root_message_id=message.get("root_message_id"),
            subject=subject,
            subject_tag=_domain_subject_tag(domain, thread),
            mail_from="dssoc",
            mail_to=", ".join(recipients) or None,
            mail_cc=", ".join(cc) or None,
            body_excerpt=body,
            body_html=body,
            agent_verdict="sent",
            decision_reason=OUTBOUND_HOW_TO_GUIDANCE,
        )
    return {
        "mode": result.mode,
        "detail": result.detail,
        "recipients": recipients,
        "cc": cc,
        "subject": subject,
        "draft_path": result.draft_path,
        "scan_hits": list(result.scan_hits),
    }


def _retry_after() -> float:
    return time.time() + state.service_recheck_retry_seconds()


def handle_how_to_guidance(
    domain: str,
    thread: dict[str, Any],
    *,
    evidence_dir: Path | None = None,
    charter_ref: str = "",
) -> dict[str, Any]:
    domain = str(domain or "").strip().lower()
    thread_id = int(thread["id"])
    if _attempt_cap_exceeded(thread):
        _escalate_attempt_cap(domain, thread_id)
        return {"mode": "escalated", "thread_id": thread_id, "escalated": True}

    message_id = int(thread.get("reply_message_id") or 0)
    message = state.service_reply_message_get(message_id) if message_id else None
    set_status = _status_setter(domain)
    if message is None:
        set_status(
            thread_id,
            "awaiting_owner",
            last_reason="how-to guidance skipped: inbound message missing",
        )
        return {"mode": "missing_message", "thread_id": thread_id}
    ev_dir = evidence_dir or runtime.make_evidence_dir(
        f"{domain}-reply-guidance-{_scope_name(domain, thread)}"
    )
    try:
        delivery = asyncio.run(
            deliver_how_to_guidance(
                domain,
                thread,
                message,
                evidence_dir=Path(ev_dir),
                charter_ref=charter_ref,
            )
        )
    except Exception as e:  # noqa: BLE001
        set_status(
            thread_id,
            "awaiting_owner",
            retry_after=_retry_after(),
            last_reason=f"how-to guidance delivery failed: {repr(e)[:450]}",
        )
        _attempt_bumper(domain)(
            thread_id,
            reason=f"how-to guidance delivery failed: {repr(e)[:450]}",
        )
        return {
            "mode": "error",
            "thread_id": thread_id,
            "error": repr(e)[:500],
        }
    if delivery.get("mode") == "sent":
        set_status(
            thread_id,
            "awaiting_owner",
            last_reason="how-to guidance sent; awaiting owner reply",
        )
        _attempt_bumper(domain)(thread_id, reason="how-to guidance sent; awaiting owner reply")
    else:
        reason = f"how-to guidance {delivery.get('mode')}: {delivery.get('detail', '')[:450]}"
        set_status(
            thread_id,
            "awaiting_owner",
            retry_after=_retry_after(),
            last_reason=reason,
        )
        _attempt_bumper(domain)(thread_id, reason=reason)
    return {
        "thread_id": thread_id,
        "reply_message_id": message_id,
        **delivery,
    }


def run_guidance_pass(
    domain: str,
    *,
    session_id: int,
    max_threads: int | None = None,
    evidence_dir: Path | None = None,
    charter_ref: str = "",
) -> dict[str, Any]:
    handled = sent = dry_run = escalated = errors = 0
    while True:
        if max_threads is not None and handled >= max_threads:
            break
        thread = state.service_report_thread_claim_how_to_guidance_next(
            domain,
            session_id=session_id,
        )
        if thread is None:
            break
        handled += 1
        result = handle_how_to_guidance(
            domain,
            thread,
            evidence_dir=evidence_dir,
            charter_ref=charter_ref,
        )
        if result.get("mode") == "sent":
            sent += 1
        elif result.get("mode") == "dry_run":
            dry_run += 1
        elif result.get("mode") == "escalated":
            escalated += 1
        else:
            errors += 1 if result.get("mode") == "error" else 0
    return {
        "handled": handled,
        "sent": sent,
        "dry_run": dry_run,
        "escalated": escalated,
        "errors": errors,
    }
