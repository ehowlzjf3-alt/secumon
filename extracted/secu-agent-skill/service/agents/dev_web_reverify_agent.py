"""dev_web #3 reply/reverify agent."""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any

from domains.dev_web.application.contracts import COMPONENT_REVERIFY, REVERIFY_SESSION_ID
from service import state_domain as state
from service.agents import runtime

log = logging.getLogger("service.agents.dev_web_reverify")

COMPONENT = COMPONENT_REVERIFY
_SKILL_NAME = "dev_web_reply_verify"


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _tool_classes() -> list[type]:
    from secu_agent.agent.tools.skill_tool import SkillTool
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    from domains.dev_web.plugin.tools.dev_web_reply_tools import DevWebBuildReplyTool
    from domains.dev_web.plugin.tools.dev_web_report_tools import DevWebReportDeliverTool
    from domains.dev_web.plugin.tools.dev_web_reverify_tool import DevWebRecordReverifyTool
    from domains.web.plugin.tools.web_site_sweep_tool import WebSiteSweepTool
    from domains.web.plugin.tools.web_tools import WebFetchTool, WebResourceProbeTool

    # ★ 회신 도구 둘이 없어서 재검증이 **DB 기록으로 끝났다** — 담당자는 결과를 못 받았다.
    #   다른 도메인은 발송이 종료 조건이다(SMB: {"deliver","smb_build_reply"}).
    #   DevWebReportDeliverTool 이 수신자 정책(기본 dssoc_only)을 강제하므로, 도구를 준다고
    #   담당자에게 바로 나가지는 않는다.
    from _shared.reply_tools import TicketReadTool, TicketReplyComposeTool

    return [WebSiteSweepTool, WebFetchTool, WebResourceProbeTool,
            DevWebRecordReverifyTool,
            # ★ 4도메인 공용 — 티켓을 읽고 담당자 질문에 답한다(smb 와 같은 계약).
            TicketReadTool, TicketReplyComposeTool,
            DevWebBuildReplyTool, DevWebReportDeliverTool,
            SkillTool, ToolSearchTool]


def _ticket_no(thread: dict[str, Any]) -> str:
    from _shared.ticket_id import ticket_no

    return ticket_no("dev_web", int(thread["id"]))


def _build_user_text(thread: dict[str, Any]) -> str:
    ticket = _ticket_no(thread)
    return (
        f"[dev_web 재검증 대상] 티켓={ticket} thread_id={thread['id']} "
        f"domain={thread.get('domain')} "
        f"url={thread.get('url')} finding_id={thread.get('finding_id')}\n"
        f"먼저 ticket_read(ticket='{ticket}') 로 **티켓을 읽어라** — 우리가 담당자에게 "
        f"뭐라고 보냈는지(sent), 무엇이 걸렸는지(findings), 담당자가 뭘 물었는지"
        f"(inbound)가 여기 있다.\n"
        "동일 URL/동일 origin만 read-only로 재검증한다. web_site_sweep(domain='<url>', "
        "max_route_pages=3, max_probe_urls=20, attempt_login=False)를 우선 수행하고, "
        "원 finding에서 문제였던 화면/API/endpoint가 더 이상 무인증으로 확인되지 않으면 "
        "dev_web_record_reverify_result(thread_id=<id>, verdict='remediated', ...)를 호출한다. "
        "아직 보이면 'still_exposed', 일부만 닫혔으면 'partial', 판단 불가면 'inconclusive'.\n"
        "기록 뒤에는 **담당자에게 결과를 회신한다**.\n"
        f"  · 담당자가 **질문**을 했으면(ticket_read 의 inbound 참조) "
        f"ticket_reply_compose(ticket='{ticket}', answer=<네가 쓴 답>) 로 "
        "**그 질문에 답하라.** 고정 양식에 끼워 맞추지 마라 — 질문과 다른 답을 "
        "보내는 것이 가장 흔한 실패다.\n"
        "  · 재검증 결과만 알리면 되는 경우엔 dev_web_build_reply(thread_id=<id>, "
        "reply_kind='confirmed'|'still_exposed'|'partial', open_urls=[아직 열린 URL]) — "
        "그 도구만 '아직 열린 URL 표'를 자동으로 붙인다.\n"
        "  · 어느 쪽이든 deliver(action='send', sink_id='knox_mail', ...)로 보낸다. "
        "verdict 가 inconclusive/error 면 회신하지 말고 기록으로 닫는다."
    )


async def _reverify_one_thread(
    thread: dict[str, Any],
    *,
    evidence_dir: Path | None = None,
) -> dict[str, Any]:
    thread_id = int(thread["id"])
    try:
        result = await runtime.run_agent(
            tool_classes=_tool_classes(),
            skill_body=runtime.load_skill_contract(_SKILL_NAME, resource="worker.md"),
            user_text=_build_user_text(thread),
            label=f"dev_web-reverify-{thread_id}-{thread.get('domain')}",
            # 기록만으로 끝나지 않게 발송도 종료 조건에 넣는다. 둘 다 terminal 인 이유:
            # inconclusive/error 는 회신하지 않고 기록으로 닫는 게 맞다(판단이 안 선 것을
            # 담당자에게 보내지 않는다).
            terminal_tools={"dev_web_record_reverify_result", "deliver",
                            "ticket_reply_compose"},
            max_turns=_int_env("DEV_WEB_REVERIFY_MAX_TURNS", 30),
            max_wall_clock_sec=_int_env("DEV_WEB_REVERIFY_MAX_WALL_SEC", 600),
            max_idle_sec=_int_env("DEV_WEB_REVERIFY_MAX_IDLE_SEC", 180),
            max_tokens_total=_int_env("DEV_WEB_REVERIFY_MAX_TOKENS_TOTAL", 300_000),
            evidence_dir=evidence_dir,
            extra_metadata={"dev_web_thread_id": thread_id},
        )
    except Exception as e:  # noqa: BLE001
        state.dev_web_report_thread_set_status(thread_id, "reply_received")
        return {"thread_id": thread_id, "error": repr(e)[:200]}
    if result.get("error"):
        state.dev_web_report_thread_set_status(thread_id, "reply_received")
    return {"thread_id": thread_id, **result}


#: `ThreadAdapter.deliver_recheck` 계약 슬롯의 공개 이름.
#  ⚠️ 별칭이다 — 구현은 위 `_reverify_one_thread` 한 벌뿐이다. dev_web 재조회와 사후기록이 LLM 한 런에 융합돼 있다 — `recheck` 슬롯은 None 이다.
recheck_thread_async = _reverify_one_thread


async def run_reverify_pass(*, max_threads: int | None = None) -> dict[str, Any]:
    # ★ 4도메인 동일 — github·confluence·dev_web 리포트 러너는 첫 줄에서 이걸 부른다.
    #   smb·회신 경로 셋만 빠져 있어서 `python -m` 단독 기동이 DSN 없이 죽었다
    #   (2026-08-31 실측). 호출부가 미리 로드했겠거니 하면 안 된다.
    from service.runtime_env import load_runtime_env

    load_runtime_env(load_plugins=False)
    state.heartbeat_upsert(COMPONENT, phase="reply_verify", pid=os.getpid())
    run_id = state.pipeline_run_start(COMPONENT)
    claimed = 0
    results: list[dict[str, Any]] = []
    try:
        # claim 회수를 먼저 돈다. github/confluence/smb 는 부르는데 dev_web 만 안 불렀다.
        # ⚠️ **잠김을 푸는 게 아니다.** `claim_next` 는 `claimed_at < cutoff` 로 묵은 claim 을
        #    스스로 뺏으므로 현재 주차 행은 회수가 없어도 진행된다. 실제 차이는 주차 조건이다 —
        #      claim_next : status · **last_cycle_key=현재주차** · claimed_at < cutoff
        #      reclaim    : claimed_at < cutoff              ← 주차 조건 없음
        #    그래서 **지나간 주차 행의 죽은 claim 은 회수만 푼다.** 실측(2026-08-24):
        #    W28 67건 중 54건에 죽은 워커 이름이 45일째 박혀 있었다. 그 컬럼을 읽는 사람이
        #    "누가 지금 잡고 있다" 고 오해한다 — 실제로 내가 그렇게 오해했다.
        # ⚠️ 포트 메서드 `reclaim_stale_report_threads()` 는 3도메인에 정의돼 있고 호출부가
        #    0이다. 정의만 보고 배선됐다고 읽으면 안 된다.
        state.dev_web_report_thread_reclaim_stale()
        while max_threads is None or claimed < max_threads:
            thread = state.dev_web_report_thread_claim_next(
                session_id=REVERIFY_SESSION_ID,
                status="reply_received",
            )
            if thread is None:
                break
            state.dev_web_report_thread_set_status(int(thread["id"]), "reverifying")
            thread["status"] = "reverifying"
            claimed += 1
            results.append(await _reverify_one_thread(thread))
        state.pipeline_run_finish(
            run_id,
            status="ok",
            hosts_found=claimed,
            shares_walked=sum(1 for r in results if r.get("saw_terminal")),
            detail=f"dev_web_reverify={len(results)}",
        )
    except Exception as e:  # noqa: BLE001
        state.pipeline_run_finish(run_id, status="error", detail=repr(e)[:500])
        raise
    return {"claimed": claimed, "reverified": len(results),
            "recorded": sum(1 for r in results if r.get("saw_terminal"))}


def main(argv: list[str] | None = None) -> int:
    import argparse

    logging.basicConfig(level=os.environ.get("DEV_WEB_AGENT_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    parser = argparse.ArgumentParser(description="dev_web #3 reverify agent")
    parser.add_argument("--max-threads", type=int, default=None)
    args = parser.parse_args(argv)
    result = asyncio.run(run_reverify_pass(max_threads=args.max_threads))
    log.info("[dev_web_reverify] pass done %s", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
