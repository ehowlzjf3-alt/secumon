"""smb 스레드 어댑터 — `mail_thread` 큐.

⚠️ github·confluence 와 **같이 못 짓는다**(`_shared/report_thread_adapter`).
   이유는 셋:

     · 만들기와 배달이 LLM 워커 **한 런**에 융합돼 있다 → `build_report` = None
     · 재검증의 방아쇠가 주기가 아니라 **inbound 답장**이다(POP3 대조)
     · 상태 어휘가 다르다(`awaiting_reply`/`reply_received` vs `awaiting_owner`/
       `recheck_requested`)

   억지로 합치면 계약이 거짓말을 한다. 넷을 같은 **모양**으로 맞추는 것과
   같은 **코드**로 맞추는 것은 다르다.
"""
from __future__ import annotations

from importlib import import_module
from typing import Any


def smb_thread_adapter():
    import service.state_domain as state

    from _shared.thread_adapter import ThreadAdapter, summarize_thread_row

    def _list_threads(*, status: str | None = None, limit: int = 100,
                      cycle_key: str | None = None, **_: Any) -> list[dict[str, Any]]:
        rows = state.mail_threads_overview(status=status, limit=limit, cycle_key=cycle_key)
        return [summarize_thread_row("smb", r, coord_keys=("host",)) for r in rows]

    def _finding_ids(thread: dict[str, Any]) -> list[int]:
        return state.mail_thread_finding_ids(int(thread["id"]))

    async def _deliver_report(thread: dict[str, Any], *, charter_ref: str = "", **kw: Any):
        # ⚠️ smb 만 `charter_ref` 가 필수 인자다 — 어댑터가 기본값을 채워 넷의
        #    호출 모양을 같게 만든다.
        agent = import_module("service.agents.report_mail_agent")
        return await agent.handle_thread_async(thread, charter_ref=charter_ref, **kw)

    async def _deliver_recheck(thread: dict[str, Any], *, charter_ref: str = "", **kw: Any):
        agent = import_module("service.agents.reply_verify_agent")
        return await agent.recheck_thread_async(thread, charter_ref=charter_ref, **kw)

    def _recheck_records(thread_id: int) -> list[dict[str, Any]]:
        return state.mail_reverify_results_for_thread(int(thread_id))

    def _promote_ready_drafts():
        from service.services.smb_draft_report import promote_ready_host_drafts

        return promote_ready_host_drafts()

    def _delivery_targets(owner_recipients: Any = None) -> dict[str, Any]:
        mod = import_module("domains.smb.plugin.tools.smb_report_mail_tools")
        return mod.report_mail_delivery_targets(owner_recipients)

    def _reply_envelope(thread: dict[str, Any], *, ticket_no: str | None = None) -> dict[str, Any]:
        """★ smb 만 할 수 있는 것 — 받은 메일에 **reply-all** 로 답한다.

        POP3 로 수집한 최신 수신 메일의 From/To/Cc 를 그대로 쓰고, 제목의 RE 카운트를
        올리고, 원문을 인용해 붙인다. 다른 셋은 받은 메일이 없어 이 재료가 없다
        (`_shared/reply_envelope.default_reply_envelope` 로 떨어진다).
        """
        from service.services import remediation_mail as rm

        from domains.smb.plugin.tools.smb_reply_tools import (
            _latest_inbound_message, _reply_targets,
        )

        original = _latest_inbound_message(int(thread["id"]))
        if original is None:
            from _shared.reply_envelope import default_reply_envelope
            from _shared.thread_adapter import get_thread_adapter

            return default_reply_envelope(get_thread_adapter("smb"), thread, ticket_no=ticket_no)
        targets = _reply_targets(original)
        # ★ 정책 준수 — 담당자(To) + **DSSOC(Cc)**. 사용자 결정 2026-08-24.
        #   ⚠️ 2026-08-31 실측: reply-all 경로는 받은 메일의 To/Cc 를 그대로 쓰는데,
        #      담당자가 DSSOC 를 cc 에 안 넣고 답장하면 우리 회신에서 DSSOC 가 빠진다
        #      (SMB00024 실측 cc=[]). 조치요청은 정책대로 나가는데 **회신만** 조용히
        #      DSSOC 가 빠져 스레드 기록이 끊긴다. 여기서 되넣는다.
        from service.services import owner_recipients as orx

        cc = list(targets["cc"])
        to_lower = {a.lower() for a in targets["recipients"]}
        for addr in orx.dssoc_recipients("SMB_REMEDIATION_DSSOC_RECIPIENT"):
            if addr.lower() not in to_lower and addr.lower() not in {c.lower() for c in cc}:
                cc.append(addr)
        subject = rm.reply_subject(
            str(thread.get("subject_tag") or ""),
            original_subject=str(original.get("subject") or ""),
        )
        from _shared.ticket_id import stamp_subject_with

        subject = stamp_subject_with(subject, ticket_no)
        return {
            "subject": subject,
            "recipients": targets["recipients"],
            "cc": cc,
            "quote_html": "",          # 인용은 조립 마지막에 붙인다(아래 참조)
            "original_message": original,
            "mode": "reply_all",
        }

    from domains.smb.application.contracts import COMPONENT_MAIL, COMPONENT_REVERIFY

    return ThreadAdapter(
        domain="smb",
        report_component=COMPONENT_MAIL,
        recheck_component=COMPONENT_REVERIFY,
        queue_label="SMB 공유폴더 조치요청 큐",
        statuses=tuple(sorted(state._MAIL_THREAD_STATUSES)),
        list_threads=_list_threads,
        thread_get=state.mail_thread_get,
        finding_ids=_finding_ids,
        claim_next=state.mail_thread_claim_next,
        set_status=state.mail_thread_set_status,
        bump_attempt=state.mail_thread_bump_attempt,
        reclaim_stale=state.mail_thread_reclaim_stale,
        schedule_retry=state.mail_thread_schedule_communication_retry,
        deliver_report=_deliver_report,
        # build_report=None — LLM 한 런에 융합. `supports_build()` 가 False 를 말한다.
        deliver_recheck=_deliver_recheck,
        delivery_targets=_delivery_targets,
        recheck_records=_recheck_records,
        reply_envelope=_reply_envelope,
        # recheck=None — 배달 없는 미리보기가 없다.
        # sync_threads — 스레드 **생성**은 finding 제출 때 하지만, draft → 큐 **승격**은
        #   따로 봐야 한다. 승격을 부르던 곳이 "마지막 작업이 닫히는 순간" 하나뿐이라
        #   그 순간을 놓친 초안이 영원히 큐에 안 올라갔다(2026-08-31 실측 26/51).
        sync_threads=_promote_ready_drafts,
        claimable_statuses=("reported", "reply_received"),
        notes={
            # ⚠️ 2026-08-31 정정: "답장은 smb 만 받는다" 고 적었다가 틀렸다.
            #    POP3 수집기는 4도메인을 다 라우팅한다(`mail_inbound.py:596`).
            #    smb 가 다른 점은 **저장 테이블과 reply-all 재료**다.
            "inbound": (
                "smb 답장은 `mail_message` 에 쌓인다(다른 셋은 `service_reply_message`). "
                "받은 메일의 To/Cc 가 있으므로 회신을 **reply-all** 로 보낼 수 있다."
            ),
        },
    )
