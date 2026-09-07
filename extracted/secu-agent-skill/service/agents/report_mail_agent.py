"""#2 조치요청 에이전트 — confirmed finding → HTML 리포트 + 스크린샷 + 자동메일.

(smb_domain_e2e 요구 4·5·6·7). mail_thread(status='reported') 큐를 claim → 리포트 빌드
→ deliver(knox_mail) 자동발송 → 'awaiting_reply' 전이. live SMB I/O 0.

엔진 무수정: service.agents.runtime.run_agent 가 GuardedHarness 직접 구동. contract:
이 에이전트는 점검/POP3 도구를 unlock 하지 않는다(리포트+deliver 만).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any

from domains.smb.application.contracts import (
    COMPONENT_MAIL,
    MAIL_SESSION_ID,
    PHASE_REPORT_MAIL,
    SMB_REPORT_MAIL_PLAN,
)
from service import state_domain as state
from service.agents import runtime

log = logging.getLogger("service.agents.report_mail")

COMPONENT = COMPONENT_MAIL
_SKILL_NAME = SMB_REPORT_MAIL_PLAN
_SESSION_ID = MAIL_SESSION_ID
_MAIL_BODY_LIMIT = 120000


def _tool_classes() -> list[type]:
    from secu_agent.agent.tools.skill_tool import SkillTool
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    from domains.smb.plugin.tools.smb_report_mail_tools import (
        SmbBuildRemediationReportTool, SmbReportMailDeliverTool, SmbReportScreenshotTool,
    )
    return [
        SmbBuildRemediationReportTool, SmbReportScreenshotTool,
        SmbReportMailDeliverTool, SkillTool, ToolSearchTool,
    ]


def _build_user_text(thread: dict[str, Any]) -> str:
    from service.services import smb_remediation_report

    subject_tag = str(thread.get("subject_tag") or f"[보안취약점 조치요청]({thread['host']})")
    # ★ 회신 매칭 1차 키(티켓번호)를 제목 앞에 찍는다. 기존 태그는 지우지 않는다.
    #   ⚠️ 도구(`smb_build_remediation_report`)도 같은 규칙으로 찍으므로 둘이 일치한다 —
    #      워커가 프롬프트 제목을 쓰든 deliver_hint 를 쓰든 같은 제목이 나간다.
    subject = state.stamp_subject_for_thread(
        smb_remediation_report.remediation_mail_subject(subject_tag),
        "smb", int(thread["id"]),
    )
    return (
        f"[조치요청 메일 발송] finding_id={thread['finding_id']} host={thread['host']}\n"
        f"이 finding 의 조치요청 HTML 리포트를 만들고(공유폴더 권한 변경 등 조치사항 포함), "
        f"제목 `{subject}` 으로 정책 수신자에게 자동 발송하라.\n\n"
        f"1) smb_build_remediation_report(finding_id={thread['finding_id']}) 로 리포트+스크린샷 생성.\n"
        f"2) 반환된 deliver_hint 대로 deliver(action='send', sink_id='knox_mail', "
        f"recipients=[...], cc=[...], subject='{subject}', body=<html>, "
        f"finding_id={thread['finding_id']}) 호출. dry-run/sent 결과를 보고하라.\n"
        f"발송 후 추가 행동 없이 종료."
    )


def _mail_body_for_thread(body: Any, *, limit: int = _MAIL_BODY_LIMIT) -> str:
    raw = str(body or "")
    if len(raw) > limit:
        return raw[:limit].rstrip() + "\n<!-- mail body truncated for thread display -->"
    return raw


def _deliver_input(result: dict[str, Any]) -> dict[str, Any]:
    call = _deliver_call(result)
    payload = call.get("input") or {}
    return payload if isinstance(payload, dict) else {}


def _deliver_call(result: dict[str, Any]) -> dict[str, Any]:
    calls = result.get("terminal_calls") or []
    if not isinstance(calls, list):
        return {}
    for call in reversed(calls):
        if not isinstance(call, dict) or call.get("name") != "deliver":
            continue
        return call
    return {}


def _delivery_mode(result: dict[str, Any]) -> str | None:
    if not result.get("saw_terminal"):
        return None
    content = str(_deliver_call(result).get("result_content") or "")
    if not content:
        return "sent"
    lowered = content.lower()
    if "dry-run" in lowered:
        return "dry_run"
    if "발송 완료" in content or "sent" in lowered:
        return "sent"
    return "unknown"


def _sent_mail_fields(thread: dict[str, Any], result: dict[str, Any]) -> dict[str, str | None]:
    payload = _deliver_input(result)
    recipients = payload.get("recipients")
    if isinstance(recipients, list):
        requested_to = [str(x).strip() for x in recipients if str(x).strip()]
    else:
        requested_to = [str(recipients).strip()] if str(recipients or "").strip() else []
    try:
        from domains.smb.plugin.tools.smb_report_mail_tools import report_mail_delivery_targets

        targets = report_mail_delivery_targets(requested_to)
        to = ", ".join(targets["recipients"]) or None
    except Exception:  # noqa: BLE001
        to = str((requested_to or [thread.get("recipient") or ""])[0]).strip() or None
    if payload.get("subject"):
        subject = str(payload.get("subject"))
    else:
        from service.services import smb_remediation_report

        subject_tag = str(thread.get("subject_tag") or f"[보안취약점 조치요청]({thread['host']})")
        subject = smb_remediation_report.remediation_mail_subject(subject_tag)
    body = payload.get("body")
    if not body:
        try:
            from service.services import smb_remediation_report

            report = smb_remediation_report.build_remediation_report(
                finding_id=int(thread["finding_id"]),
                host=str(thread["host"]),
            )
            body = report.get("html")
        except Exception:  # noqa: BLE001
            body = ""
    return {
        "subject": subject,
        "mail_to": to,
        "body_excerpt": _mail_body_for_thread(body),
    }


def _record_outbound(
    thread: dict[str, Any], fields: dict[str, str | None], *, verdict: str,
) -> None:
    """발신 기록 1건. `verdict='sent'` 는 실제로 나간 것, `draft:*` 는 안 나간 본문이다.

    ★ **초안은 쌓지 않고 갈아끼운다.** 재시도마다 행이 늘면 "발송 이력" 이 시도 횟수로
      부풀고, 화면이 최신 초안 하나를 고를 근거가 없다. 반면 `sent` 는 절대 안 지운다 —
      그건 실제로 일어난 일이고, 이력의 전부다.
    """
    if verdict != "sent":
        try:
            state.mail_message_drop_drafts(int(thread["id"]))
        except Exception:  # noqa: BLE001 — 기록 실패가 발송 판정을 뒤집지 않는다
            log.exception("[mail] thread=%s 이전 초안 정리 실패", thread["id"])
    body = fields.get("body_excerpt")
    state.mail_message_add(
        direction="out", thread_id=int(thread["id"]),
        subject=fields.get("subject"),
        subject_tag=thread.get("subject_tag"), mail_from="dssoc",
        mail_to=fields.get("mail_to"),
        body_excerpt=body,
        # ⚠️ 본문은 HTML 이다(`build_remediation_report(...)['html']`). `body_html` 에도
        #    넣어야 콘솔이 iframe 으로 렌더한다 — `body_excerpt` 만 채우면 <pre> 로 떨어진다.
        body_html=body if body and "<" in body else None,
        agent_verdict=verdict,
    )


async def _handle_thread(
    thread: dict[str, Any],
    *,
    charter_ref: str,
    evidence_dir: Path | None = None,
) -> dict[str, Any]:
    thread_id = thread["id"]
    try:
        result = await runtime.run_agent(
            tool_classes=_tool_classes(),
            skill_body=runtime.load_skill_contract(_SKILL_NAME, resource="worker.md"),
            user_text=_build_user_text(thread),
            label=f"mail-{thread['host']}-{thread['finding_id']}",
            terminal_tools={"deliver"},
            charter_ref=charter_ref,
            max_turns=int(os.environ.get("SMB_MAIL_MAX_TURNS", "15")),
            # ★★ idle 상한을 **명시한다.** 안 넘기면 엔진 기본 120s 가 걸린다.
            #   2026-08-26 실측(메일 워커 500런): 완주 287·idle 사망 213 = **43% 사망**.
            #   그런데 완주한 런의 1턴 응답은 중앙 4s·p90 49s·**최대 119s** 였다 —
            #   최대가 상한 바로 아래라는 건 분포가 **상한에서 잘렸다**는 뜻이다.
            #   120s 를 넘겼을 런은 죽어서 관측에 남지 않으니, 생존자만 보면 "여유롭다" 로 보인다.
            #   ⚠️ 이건 게이트웨이가 느려진 게 아니라 **배선 누락**이다. 다른 워커는 전부
            #      명시했고(smb_task·github_task·confluence_task 300, dev_web 120/180)
            #      여기만 빠져 있었다. 기본값을 물려받는 것과 고르는 것은 다르다.
            # ★ idle 상한은 **LLM 요청 타임아웃(프로파일 300s)보다 커야** 한다.
            #   같으면 "아직 응답 대기 중" 과 "멎었다" 를 구분 못 하고, 정상적으로 느린
            #   요청이 idle 로 오인돼 죽는다. 300 == 300 은 동점이고 감시자가 이긴다.
            max_idle_sec=int(os.environ.get("SMB_MAIL_MAX_IDLE_SEC", "360")),
            # ★★ wall-clock 도 **명시한다.** 엔진 기본이 300s 인데 그건 요청 타임아웃과
            #   **같은 숫자**라, 요청 하나가 멎으면 워커 수명을 통째로 먹는다 —
            #   즉 예산이 백스톱 역할을 아예 못 한다. httpx 가 300s 에 요청을 끊고
            #   하네스가 그걸 오류로 **기록**할 수 있으려면 wall-clock 이 더 커야 한다.
            #
            #   2026-08-26 실측(초안까지 간 메일 런 124건):
            #     턴수 중앙 4 · 최대 4 (상한 15)
            #     총시간 중앙 56s · p90 85s · 최대 120s
            #   건강한 런은 120s 안에 끝난다. 900s 는 멎은 요청 한 번을 흡수하고도
            #   붙박이 워커를 가둬둔다. 동료 워커와도 같은 자릿수다
            #   (smb_task·dev_web_task 1200 · github·confluence 1500).
            max_wall_clock_sec=int(os.environ.get("SMB_MAIL_MAX_WALL_SEC", "900")),
            evidence_dir=evidence_dir,
            extra_metadata={"smb_host": thread["host"], "finding_id": thread["finding_id"]},
        )
    except Exception as e:  # noqa: BLE001
        log.warning("[mail] thread=%s 실패: %r", thread_id, e)
        state.mail_thread_set_status(thread_id, "reported")  # claim 해제, 재시도
        return {"thread_id": thread_id, "error": repr(e)[:200]}

    delivery_mode = _delivery_mode(result)
    if delivery_mode == "sent":
        sent_mail = _sent_mail_fields(thread, result)
        state.mail_thread_set_status(
            thread_id, "awaiting_reply",
            request_message_id=None,  # Knox 는 Message-ID 미surface (subject_tag 가 1차 키)
            recipient=sent_mail["mail_to"],
        )
        state.mail_thread_bump_attempt(thread_id, reason="report mailed")
        # 발신 기록 (dedup/추적). subject_tag 로 답장 매칭.
        _record_outbound(thread, sent_mail, verdict="sent")
        attached = state.mail_message_attach_unmatched(thread["subject_tag"], thread_id)
        if attached:
            state.mail_thread_set_status(
                thread_id,
                "reply_received",
                last_reason=f"pre-existing inbound replies attached: {attached}",
            )
    elif result.get("saw_terminal"):
        content = str(_deliver_call(result).get("result_content") or "").strip()
        reason = content[:240] if content else f"delivery {delivery_mode or 'unknown'}"
        # ★ 안 나갔어도 **본문은 남긴다.** 워커가 deliver() 를 부른 시점에 본문은 이미
        #   만들어져 있다 — 게이트가 막았을 뿐이다. 안 남기면 운영자가 "무엇을 보내려
        #   했는지" 를 볼 방법이 아예 없다(실측 2026-08-27: 나머지 3도메인은 리포트
        #   생성 시점에 report_html/report_json 을 남겨서 발송 전에도 보인다.
        #   smb 만 sent 일 때만 남겨서 mail_message 가 0행이었다).
        _record_outbound(thread, _sent_mail_fields(thread, result),
                         verdict=f"draft:{delivery_mode or 'unknown'}")
        state.mail_thread_set_status(
            thread_id,
            "reported",
            claimed_by=_SESSION_ID,
            claimed_at=time.time(),
            last_reason=reason,
        )
        state.mail_thread_bump_attempt(thread_id, reason=reason)
    else:
        # ★ 자동 최초 발송이 닫혀 있으면 도구가 `deliver_hint` 를 안 준다("제작까지만").
        #   그걸 "미발송이니 재시도" 로 두면 **영원히 헛돈다** — 리포트 생성 → 발송 불가 →
        #   재시도 를 매 주기 반복하며 LLM 비용만 태운다(dev_web 에서 실측했다).
        #   초안은 이미 만들었으니 `report_ready` 에 세운다 — 3도메인과 같은 자리다.
        from service.services.owner_recipients import initial_autosend_enabled

        if not initial_autosend_enabled():
            state.mail_thread_set_status(
                thread_id, "report_ready",
                last_reason="자동 최초 발송 닫힘 — 초안 저장, 수동 발송 대기",
            )
        else:
            state.mail_thread_set_status(thread_id, "reported")  # 미발송 — 재시도 큐 유지
    log.info("[mail] thread=%s host=%s submit=%s reason=%s",
             thread_id, thread["host"], result.get("saw_terminal"), result.get("reason"))
    return {"thread_id": thread_id, "delivery_mode": delivery_mode, **result}


#: `ThreadAdapter.deliver_report` 계약 슬롯의 공개 이름.
#  ⚠️ 별칭이다 — 구현은 위 `_handle_thread` **한 벌**뿐이다. 어댑터용으로 두 번째
#  구현을 만들지 마라. `charter_ref` 가 **필수**다 — 어댑터가 기본값을 채운다.
handle_thread_async = _handle_thread


async def run_mail_pass(*, max_threads: int | None = None, charter_ref: str = "") -> dict[str, Any]:
    # ★ 4도메인 동일 — github·confluence·dev_web 리포트 러너는 첫 줄에서 이걸 부른다.
    #   smb·회신 경로 셋만 빠져 있어서 `python -m` 단독 기동이 DSN 없이 죽었다
    #   (2026-08-31 실측). 호출부가 미리 로드했겠거니 하면 안 된다.
    from service.runtime_env import load_runtime_env

    load_runtime_env(load_plugins=False)
    state.heartbeat_upsert(COMPONENT, phase=PHASE_REPORT_MAIL, pid=os.getpid())
    run_id = state.pipeline_run_start(COMPONENT)
    state.mail_thread_reclaim_stale()
    handled = 0
    sent = 0
    try:
        while True:
            if max_threads is not None and handled >= max_threads:
                break
            thread = state.mail_thread_claim_next(session_id=_SESSION_ID, status="reported")
            if thread is None:
                break
            handled += 1
            r = await _handle_thread(thread, charter_ref=charter_ref)
            if r.get("delivery_mode") == "sent":
                sent += 1
    finally:
        state.pipeline_run_finish(run_id, status="ok", detail=f"handled={handled} sent={sent}")
    return {"handled": handled, "sent": sent}


def main(argv: "list[str] | None" = None) -> int:
    import argparse
    logging.basicConfig(level=os.environ.get("SMB_AGENT_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    p = argparse.ArgumentParser(description="SMB #2 조치요청 에이전트")
    p.add_argument("--max-threads", type=int, default=None)
    p.add_argument("--charter", default=os.environ.get("DEFAULT_CHARTER_REF", "SECOPS-2026-001"))
    args = p.parse_args(argv)
    res = asyncio.run(run_mail_pass(max_threads=args.max_threads, charter_ref=args.charter))
    log.info("[mail] pass done %s", res)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
