"""dev_web 스레드 어댑터 — `dev_web_report_thread` 큐.

⚠️ 넷 중 표면이 가장 얇다(실측 2026-08-31):

     · `finding_ids` 가 **없다** — 스레드가 finding 을 **단수**로 가리킨다
       (`dev_web_report_thread.finding_id`). 어댑터가 리스트로 감싼다.
     · `schedule_recheck_retry` 가 없고 `retry_if_status` 뿐이다 — 기대 상태를
       **명시**해야 하는 낙관적 전이라 서명이 다르다. 어댑터가 흡수한다.
     · 만들기·배달·재검증이 전부 LLM 한 런에 융합돼 있다.
"""
from __future__ import annotations

from importlib import import_module
from typing import Any


def _promote_ready_drafts():
    """점검이 끝난 target 의 초안을 조치요청 큐로 올린다(smb 와 같은 자리)."""
    from service.services.draft_promotion import promote_dev_web_target_drafts

    return promote_dev_web_target_drafts()


def dev_web_thread_adapter():
    import service.state_domain as state

    from _shared.thread_adapter import ThreadAdapter, summarize_thread_row

    def _list_threads(*, status: str | None = None, limit: int = 100,
                      cycle_key: str | None = None, **_: Any) -> list[dict[str, Any]]:
        rows = state.dev_web_report_threads_overview(
            status=status, limit=limit, cycle_key=cycle_key,
        )
        return [summarize_thread_row("dev_web", r, coord_keys=("domain", "url")) for r in rows]

    def _finding_ids(thread: dict[str, Any]) -> list[int]:
        """단수 → 리스트. **없으면 빈 리스트다** — 0 을 넣지 마라(유효 id 로 보인다)."""
        fid = thread.get("finding_id")
        try:
            fid = int(fid)
        except (TypeError, ValueError):
            return []
        return [fid] if fid > 0 else []

    def _schedule_retry(thread_id: int, *, reason: str,
                        retry_seconds: float | None = None,
                        status: str = "report_ready",
                        expect_status: str | None = None, **_: Any) -> float | None:
        """넷의 `schedule_retry` 서명을 맞춘다.

        ⚠️ `retry_if_status` 는 기대 상태가 어긋나면 **False 를 돌려주고 아무것도
           안 한다**(낙관적 동시성). 조용한 실패가 되지 않도록 None 을 돌려
           호출부가 구분할 수 있게 한다.
        """
        import time

        retry_after = time.time() + float(retry_seconds or 900)
        ok = state.dev_web_report_thread_retry_if_status(
            int(thread_id),
            expect_status=expect_status or status,
            status=status,
            retry_after=retry_after,
            last_reason=reason,
        )
        return retry_after if ok else None

    async def _deliver_report(thread: dict[str, Any], *, charter_ref: str = "", **kw: Any):
        # charter_ref 를 받되 쓰지 않는다 — 넷의 호출 모양을 같게 두기 위해서다.
        agent = import_module("service.agents.dev_web_report_agent")
        return await agent.handle_thread_async(thread, **kw)

    def _recheck_records(thread_id: int) -> list[dict[str, Any]]:
        return state.dev_web_recheck_results_for_thread(int(thread_id))

    def _delivery_targets(owner_recipients: Any = None) -> dict[str, Any]:
        mod = import_module("domains.dev_web.plugin.tools.dev_web_report_tools")
        return mod.dev_web_report_delivery_targets(owner_recipients)

    async def _deliver_recheck(thread: dict[str, Any], *, charter_ref: str = "", **kw: Any):
        agent = import_module("service.agents.dev_web_reverify_agent")
        return await agent.recheck_thread_async(thread, **kw)

    from domains.dev_web.application.contracts import COMPONENT_REPORT, COMPONENT_REVERIFY

    return ThreadAdapter(
        domain="dev_web",
        report_component=COMPONENT_REPORT,
        recheck_component=COMPONENT_REVERIFY,
        queue_label="Dev Web 사이트 조치요청 큐",
        statuses=tuple(sorted(state._DEV_WEB_REPORT_STATUSES)),
        list_threads=_list_threads,
        thread_get=state.dev_web_report_thread_get,
        finding_ids=_finding_ids,
        claim_next=state.dev_web_report_thread_claim_next,
        set_status=state.dev_web_report_thread_set_status,
        bump_attempt=state.dev_web_report_thread_bump_attempt,
        reclaim_stale=state.dev_web_report_thread_reclaim_stale,
        schedule_retry=_schedule_retry,
        deliver_report=_deliver_report,
        deliver_recheck=_deliver_recheck,
        # ★ 2026-08-31 교체. 예전엔 `dev_web_report_thread_requeue_ready` 였는데, 그건
        #   `report_ready → reported` 로 **되돌리는** 함수다. 최초 발송 게이트가 스레드를
        #   report_ready 에 세우자 매 패스가 그걸 되돌렸고, 워커가 LLM 을 다시 태우고,
        #   게이트가 다시 세우는 순환이 됐다 — 실측 한 스레드 **시도 72회**.
        #   되돌리는 문은 자율발송을 켜는 날 **일부러** 여는 것이지 매 패스 도는 게 아니다.
        #
        #   대신 여기서는 초안 승격을 본다: 점검이 끝난 target 의 draft 를 큐로 올린다.
        #   그 승격은 **한 번도 동작한 적이 없었다**(호출부가 테스트뿐) — 55건이 멈춰 있었다.
        sync_threads=_promote_ready_drafts,
        delivery_targets=_delivery_targets,
        recheck_records=_recheck_records,
        # ★ 러너 실제 호출로 확인했다 — `dev_web_report_agent:266 status="reported"`,
        #   `dev_web_reverify_agent:120 status="reply_received"`.
        #   ⚠️ 처음에 `("report_ready","reverify_requested")` 로 썼다가 틀렸다.
        #      `reverify_requested` 는 `_DEV_WEB_REPORT_STATUSES` 에 **있지도 않다** —
        #      맞춰 놨으면 dev_web 만 조용히 idle 이 됐을 것이다(2026-08-26 과 같은 사고).
        claimable_statuses=("reported", "reply_received"),
    )
