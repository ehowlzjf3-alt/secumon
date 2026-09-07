"""dev_web #2 report agent — build remediation report and deliver."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any

from domains.dev_web.application.contracts import COMPONENT_REPORT, REPORT_SESSION_ID
from service import state_domain as state
from service.agents import runtime
from service.runtime_env import load_runtime_env
from service.services import owner_recipients as orx

log = logging.getLogger("service.agents.dev_web_report")

COMPONENT = COMPONENT_REPORT
_SKILL_NAME = "dev_web_report"
_INCOMPLETE_REASONS = {
    "stream_error", "no_completion", "aborted", "max_turns",
    "max_tokens", "contract_violation",
}
_MAIL_BODY_LIMIT = 120000


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _bool_env(name: str, default: bool = False) -> bool:
    """`fanout.py` 와 같은 판정. 이 파일엔 `_int_env` 만 있었다."""
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on", "y"}


#: 발송이 남은 초안이 앉는 자리. confluence·github 이 쓰는 어휘를 그대로 쓴다.
_PARK_STATUS = "report_ready"
#: 자율발송이 꺼져서 파킹된 것 — 스위치를 켜면 되돌릴 대상이다.
PARK_AUTOSEND_OFF = "dry_run_autosend_off:"
#: 발송은 켜져 있는데 다른 이유로 막힌 것 — 스위치를 켜도 안 풀린다.
PARK_BLOCKED = "dry_run_blocked:"


def _park_token() -> str:
    """파킹 **당시** 자율발송 스위치 상태를 우리가 직접 적는다.

    ⚠️ 코어가 만든 한국어 사유 문자열을 파싱하지 않는다. 판정은 스킬 SSOT 인
       `orx.autosend_enabled()` 하나만 쓴다 — 같은 env 를 읽는 **세 번째 판정**을
       만들면 "판정 두 벌" 사고를 반복한다.
    """
    return PARK_BLOCKED if orx.autosend_enabled() else PARK_AUTOSEND_OFF


def _failure_retry_after() -> float:
    """실패 재시도 백오프. **평면이다 — 지수를 쓰지 않는다.**

    ⚠️ 이 도메인의 유일한 카운터 `attempt_count` 는 성공 파킹에서도 오르는 누적치다
       (실측 2026-08-28: 71건이 53~67). 지수 식에 넣으면 첫 실패부터 상한이라
       "일시적 실패는 잠시 뒤 다시" 라는 이 백오프의 목적 자체가 사라진다.
    """
    return time.time() + _int_env("DEV_WEB_REPORT_FAILURE_RETRY_SECONDS", 1800)


def _requeue_failed(thread_id: int, reason: str) -> None:
    """실패는 큐에 남긴다 — 다만 즉시 재청구는 막는다.

    ⚠️ 예전엔 인자 없이 `set_status(thread_id, "reported")` 를 불렀고, 그 함수는
       인자로 안 준 `retry_after`/`claimed_by`/`claimed_at` 을 **NULL 로 지운다**.
       그래서 실패한 스레드가 곧바로 다시 청구됐다(실측: 21:48:18 실패 → 21:50:13 재실행).
    ⚠️ `bump_attempt` 를 **먼저** 부른다. 그 UPDATE 가 `last_reason` 을
       `COALESCE(?, last_reason)` 로 덮으므로 순서가 뒤집히면 사유가 사라진다.
    """
    state.dev_web_report_thread_bump_attempt(thread_id)
    state.dev_web_report_thread_set_status(
        thread_id, "reported",
        retry_after=_failure_retry_after(),
        last_reason=reason[:480],
    )


def _tool_classes() -> list[type]:
    from secu_agent.agent.tools.skill_tool import SkillTool
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    from domains.dev_web.plugin.tools.dev_web_report_tools import (
        DevWebBuildReportTool,
        DevWebReportDeliverTool,
    )

    return [DevWebBuildReportTool, DevWebReportDeliverTool, SkillTool, ToolSearchTool]


def _build_user_text(thread: dict[str, Any]) -> str:
    from domains.dev_web.plugin.tools.dev_web_report_tools import remediation_mail_subject

    subject = remediation_mail_subject(str(thread.get("subject_tag") or ""))
    return (
        f"[dev_web 리포트 대상] thread_id={thread['id']} domain={thread.get('domain')} "
        f"url={thread.get('url')} finding_id={thread.get('finding_id')}\n"
        "dev_web_build_report(thread_id=<id>)로 조치요청 HTML을 만들고, 반환된 deliver_hint대로 "
        f"제목 `{subject}` 으로 deliver(action='send', sink_id='knox_mail', ...)를 1회 호출한다. "
        "본문/제목/수신자는 도구 반환값을 사용하고 새 라이브 웹 검사는 하지 않는다."
    )


def _mail_body_for_thread(body: Any, *, limit: int = _MAIL_BODY_LIMIT) -> str:
    raw = str(body or "")
    if len(raw) > limit:
        return raw[:limit].rstrip() + "\n<!-- mail body truncated for dev_web thread display -->"
    return raw


def _deliver_call(result: dict[str, Any]) -> dict[str, Any]:
    calls = result.get("terminal_calls") or []
    if not isinstance(calls, list):
        return {}
    for call in reversed(calls):
        if isinstance(call, dict) and call.get("name") == "deliver":
            return call
    return {}


def _delivery_mode(result: dict[str, Any]) -> str | None:
    if not result.get("saw_terminal"):
        return None
    content = str(_deliver_call(result).get("result_content") or "")
    if not content:
        # ⚠️ 예전엔 "sent" 였다. deliver 도구는 두 분기 모두 비지 않은 content 를 낸다 —
        #    비었다면 우리가 모르는 상태다. "sent" 로 치면 awaiting_reply 로 가는데
        #    dev_web 은 인바운드 매칭 경로가 없어서 **거기서 나오는 코드가 하나도 없다.**
        #    모르는 것을 블랙홀로 보내지 않는다.
        return "unknown"
    lowered = content.lower()
    if "dry-run" in lowered:
        return "dry_run"
    if "발송 완료" in content or "sent" in lowered:
        return "sent"
    return "unknown"


def _report_fields(thread: dict[str, Any], result: dict[str, Any]) -> dict[str, str | None]:
    from domains.dev_web.plugin.tools.dev_web_report_tools import remediation_mail_subject

    call = _deliver_call(result)
    payload = call.get("input") if isinstance(call.get("input"), dict) else {}
    subject = str(payload.get("subject") or remediation_mail_subject(str(thread.get("subject_tag") or "")))
    body = payload.get("body")
    if not body:
        body = ""
    return {
        "subject": subject,
        # ★ **실제 deliver 호출이 쓴 수신자**를 적는다. 예전엔 여기서 DSSOC env 를 읽어
        #   어디로 갔든 DSSOC 로 기록했다 — 바로 윗줄 subject 는 실제 호출에서 읽으면서
        #   recipient 만 지어내고 있었고, 그 값이 `dev_web_report_thread.recipient` 로 굳어
        #   화면·되먹임 양쪽을 오염시켰다.
        "recipient": ", ".join(orx.recipient_list(payload.get("recipients") or [])) or None,
        "body_excerpt": _mail_body_for_thread(body),
    }


async def _report_one_thread(
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
            label=f"dev_web-report-{thread_id}-{thread.get('domain')}",
            terminal_tools={"deliver"},
            max_turns=_int_env("DEV_WEB_REPORT_MAX_TURNS", 20),
            max_wall_clock_sec=_int_env("DEV_WEB_REPORT_MAX_WALL_SEC", 300),
            max_idle_sec=_int_env("DEV_WEB_REPORT_MAX_IDLE_SEC", 120),
            max_tokens_total=_int_env("DEV_WEB_REPORT_MAX_TOKENS_TOTAL", 200_000),
            evidence_dir=evidence_dir,
            extra_metadata={"dev_web_thread_id": thread_id},
        )
    except Exception as e:  # noqa: BLE001
        log.warning("[dev_web_report] thread=%s failed: %r", thread_id, e)
        _requeue_failed(thread_id, f"report pass failed: {e!r}")
        return {"thread_id": thread_id, "error": repr(e)[:200]}

    if result.get("error") or result.get("reason") in _INCOMPLETE_REASONS:
        _requeue_failed(thread_id, f"incomplete: {result.get('reason') or result.get('error')}")
        return {"thread_id": thread_id, **result}
    delivery_mode = _delivery_mode(result)
    if delivery_mode == "sent":
        fields = _report_fields(thread, result)
        state.dev_web_report_thread_set_status(
            thread_id,
            "awaiting_reply",
            recipient=fields["recipient"],
            request_message_id=None,
        )
        state.dev_web_report_thread_bump_attempt(thread_id, reason="report mailed")
    elif result.get("saw_terminal"):
        content = str(_deliver_call(result).get("result_content") or "").strip()
        reason = content if content else f"delivery {delivery_mode or 'unknown'}"
        # ★ 큐를 떠난다. 초안까지는 다 만들었고 남은 건 발송뿐이다 —
        #   github(scanner) / confluence(reporter) 가 report_ready 로 세우는 것과 같은 자리.
        #   claim_next 는 status='reported' 만 잡으므로 아무도 다시 청구하지 않는다.
        #   예전엔 여기서 reported + claimed_by/claimed_at=now 를 박았고, 그 두 줄이
        #   1800초 순환의 심장이었다(attempt_count 67).
        #   terminal 이 **아니다** — 병합 후보에는 그대로 남고 되돌리는 문이 있다.
        # ⚠️ bump_attempt 를 **먼저**. 그 UPDATE 가 last_reason 을 COALESCE 로 덮으므로
        #    순서가 뒤집히면 파킹 토큰이 사라지고 되돌리는 문이 영영 0행이 된다.
        state.dev_web_report_thread_bump_attempt(thread_id)
        state.dev_web_report_thread_set_status(
            thread_id,
            _PARK_STATUS,
            last_reason=f"{_park_token()} {reason}"[:480],
        )
    else:
        # ★ 자동 최초 발송이 닫혀 있으면 워커가 deliver 를 부를 수 **없다** —
        #   도구가 수신처 없음을 보고 `deliver_hint` 를 안 준다("제작까지만").
        #   그걸 실패로 보고 requeue 하면 **영원히 헛돈다**: 리포트 생성 → 힌트 없음 →
        #   requeue → 반복. 매 사이클 LLM 비용만 태운다(2026-08-31 실측: 5건이 즉시
        #   reported 로 되돌아갔다). 초안은 이미 다 만들었으니 파킹이 맞다.
        from service.services.owner_recipients import initial_autosend_enabled

        if not initial_autosend_enabled():
            state.dev_web_report_thread_bump_attempt(thread_id)
            state.dev_web_report_thread_set_status(
                thread_id, _PARK_STATUS,
                last_reason=f"{_park_token()} 자동 최초 발송 닫힘 — 초안 저장, 수동 발송 대기"[:480],
            )
        else:
            _requeue_failed(thread_id, f"deliver 미호출 (mode={delivery_mode})")
    return {"thread_id": thread_id, "delivery_mode": delivery_mode, **result}


#: `ThreadAdapter.deliver_report` 계약 슬롯의 공개 이름.
#  ⚠️ 별칭이다 — 구현은 위 `_report_one_thread` **한 벌**뿐이다. 어댑터용으로 두 번째
#  구현을 만들지 마라. 만들기와 배달이 LLM 한 런에 융합돼 있다 — `build_report` 슬롯은 None 이다.
handle_thread_async = _report_one_thread


async def run_report_pass(*, max_threads: int | None = None) -> dict[str, Any]:
    load_runtime_env(load_plugins=True)  # 단독 실행 env(.env DSN)+plugin 로드 (dev_web_task_agent 와 대칭, P2 검증서 발견)
    state.heartbeat_upsert(COMPONENT, phase="report", pid=os.getpid())
    run_id = state.pipeline_run_start(COMPONENT)
    results: list[dict[str, Any]] = []
    claimed = 0
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
        # 자율발송이 켜졌을 때, **"발송이 꺼져 있어서" 파킹된 것만** 큐로 되돌린다.
        # ⚠️ 기본값 False. 자율발송을 켜는 것은 사용자 결정이고(2026-08-25),
        #    env 한 줄이 화면 예고 없이 수십 통을 밀어내는 방아쇠가 되면 안 된다.
        #    켤 사람이 같이 켠다.
        if _bool_env("DEV_WEB_REPORT_REQUEUE_PARKED", False):
            requeued = state.dev_web_report_thread_requeue_ready(
                only_prefix=PARK_AUTOSEND_OFF)
            if requeued:
                log.info("[dev_web_report] 파킹 해제 %d건 (자율발송 재개)", requeued)
        while max_threads is None or claimed < max_threads:
            thread = state.dev_web_report_thread_claim_next(
                session_id=REPORT_SESSION_ID,
                status="reported",
            )
            if thread is None:
                break
            claimed += 1
            results.append(await _report_one_thread(thread))
        sent = sum(1 for r in results if r.get("delivery_mode") == "sent")
        state.pipeline_run_finish(
            run_id,
            status="ok",
            hosts_found=claimed,
            shares_walked=sent,
            detail=f"dev_web_reports={len(results)} sent={sent}",
        )
    except Exception as e:  # noqa: BLE001
        state.pipeline_run_finish(run_id, status="error", detail=repr(e)[:500])
        raise
    return {"claimed": claimed, "reported": len(results),
            "sent": sum(1 for r in results if r.get("delivery_mode") == "sent")}


def main(argv: list[str] | None = None) -> int:
    import argparse

    logging.basicConfig(level=os.environ.get("DEV_WEB_AGENT_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    parser = argparse.ArgumentParser(description="dev_web #2 report agent")
    parser.add_argument("--max-threads", type=int, default=None)
    args = parser.parse_args(argv)
    result = asyncio.run(run_report_pass(max_threads=args.max_threads))
    log.info("[dev_web_report] pass done %s", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
