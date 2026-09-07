"""콘솔 발송 — 운영자가 버튼을 눌러 조치요청 메일을 내보내는 **유일한** 실행부.

## 원칙 하나

**`deliver()` 를 거친다.** 그게 이 저장소의 발송 관문이고, 그 안에 게이트 2축
(sink opt-in + `SA_DELIVERY_RECIPIENT_ALLOW`) · redact 스캔 · dry-run draft 폴백이 전부 있다.

2026-08-25 에 게이트를 안 타는 발송 라우트(`/api/findings/owner-mail-send`)를 지웠다
(`b0a9aa4`). 그 문은 수신자·제목·본문을 요청에서 그대로 받아 Knox MCP 로 직행했다.
**이 모듈이 그 자리를 대신하되, 이번엔 게이트를 통과한다.**
`service/tests/web/test_mail_egress_single_door.py` 가 우회를 막는다.

## 입력이 좁은 이유

버튼은 `(domain, thread_id)` 만 넘긴다. 수신자·제목·본문을 **받지 않는다** —
받으면 그게 곧 지운 그 문이다. 서버가 DB 에서 다시 읽어 구성한다.

⚠️ 화면에 보이는 본문을 그대로 보내서도 안 된다. 그건 게이트웨이가 읽기 시점에 한 번 더
   마스킹한 값이라, 그대로 보내면 **이중 마스킹된 메일**이 나가고 운영자는 자기가 본 것과
   같은 게 나갔다고 믿는다.

## 되돌릴 수 없다

메일은 회수 경로가 없다. `deliver()` 도 sink 성공 후엔 아무것도 되돌리지 않는다.
호출부는 **DB 트랜잭션 안에서 부르지 말 것** — 롤백이 보낸 메일을 되돌리지 못한다.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from secu_agent.agent.delivery import DeliveryError, DeliveryPayload, deliver_sync

from service import state_domain as state
from service.services import owner_recipients as orx

log = logging.getLogger(__name__)

#: 콘솔 발송 증거·감사 디렉터리. 워커 evidence 디렉터리와 섞지 않는다 —
#: "사람이 눌러서 나간 것" 과 "워커가 보낸 것" 은 나중에 반드시 갈라 봐야 한다.
_EVIDENCE_ENV = "SA_CONSOLE_SEND_EVIDENCE_DIR"
_EVIDENCE_DEFAULT = "/var/lib/secu-agent/evidence/console-send"

SINK_ID = "knox_mail"


class ConsoleSendError(RuntimeError):
    """발송을 시작조차 못 한 경우(스레드 없음·본문 없음·수신자 없음)."""


def _evidence_dir() -> Path:
    p = Path(os.environ.get(_EVIDENCE_ENV) or _EVIDENCE_DEFAULT)
    try:
        p.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        # ★ 2026-08-31: 기본값 `/var/lib/secu-agent/...` 는 root 소유라 만들 수 없다.
        #   그대로 두면 CLI 가 **트레이스백으로 죽고**, 콘솔엔 "요청 실패 (422) —
        #   send_failed" 만 뜬다. 사유가 화면까지 오게 이름 있는 오류로 바꾼다.
        raise ConsoleSendError(
            f"증거 디렉토리를 만들 수 없습니다: {p} ({e.strerror}). "
            f"`{_EVIDENCE_ENV}` 를 쓸 수 있는 경로로 설정하세요.",
        ) from e
    return p


# ── 도메인별 payload 구성 ────────────────────────────────────────────────────
# 저장된 것을 읽어 쓴다. smb 만 본문 컬럼이 없어 그 자리에서 만든다.

def _smb_payload(thread: dict[str, Any]) -> tuple[DeliveryPayload, str]:
    from domains.smb.plugin.tools.smb_report_mail_tools import report_mail_delivery_targets
    from service.services import smb_remediation_report

    finding_id = thread.get("finding_id")
    if finding_id is None:
        raise ConsoleSendError("이 스레드에 finding 이 없어 본문을 만들 수 없습니다.")
    report = smb_remediation_report.build_remediation_report(
        finding_id=int(finding_id), host=str(thread.get("host") or "") or None,
    )
    owner = str((report.get("owner") or {}).get("email") or "").strip()
    targets = report_mail_delivery_targets([owner] if owner else [], manual=True)
    return (
        DeliveryPayload(
            subject=str(report.get("subject") or ""),
            body=str(report.get("html") or ""),
            recipients=tuple(targets["recipients"]),
            cc=tuple(targets["cc"]),
            finding_id=int(finding_id),
            metadata={"content_type": "HTML"},
        ),
        str(targets["mode"]),
    )


def _subject_for(domain: str, thread: dict[str, Any]) -> str:
    """제목은 도메인마다 **함수도 입력도 다르다** — 공통 함수가 없다.

    ⚠️ github/confluence 는 subject_tag 가 아니라 repo/space_key 를 받는다.
       처음에 `remediation_mail.remediation_mail_subject` 라는 없는 함수를 불렀다가
       심볼 확인에서 걸렸다.
    ★ 제목의 고정 접두는 **답장을 스레드에 붙이는 유일한 키**다(Knox 가 Message-ID 를
      안 준다). 여기서 임의로 만들면 회신이 조용히 안 붙는다 — 도메인 함수를 그대로 쓴다.
    """
    if domain == "github":
        from domains.services.github.application.scanner import github_report_mail_subject
        return github_report_mail_subject(str(thread.get("repo") or ""))
    if domain == "confluence":
        from domains.services.confluence.application.reporter import (
            confluence_report_mail_subject,
        )
        return confluence_report_mail_subject(str(thread.get("space_key") or ""))
    if domain == "dev_web":
        from domains.dev_web.plugin.tools.dev_web_report_tools import remediation_mail_subject
        return remediation_mail_subject(str(thread.get("subject_tag") or ""))
    raise ConsoleSendError(f"모르는 도메인: {domain}")


def _stored_payload(domain: str, thread: dict[str, Any]) -> tuple[DeliveryPayload, str]:
    """github·confluence·dev_web — 워커가 저장해 둔 본문을 그대로 쓴다."""
    # ⚠️ `report_html` 만 보면 안 된다 — 실측(2026-08-25): github 991중 html 36 / json 991,
    #    confluence 1중 html 0 / json 1, dev_web 137중 html **없는 컬럼** / json 137.
    #    html 만 보면 세 도메인이 통째로 "본문 없음" 이 된다(처음에 그랬다).
    body = str(thread.get("report_html") or "").strip()
    is_html = bool(body)
    if not body:
        body = str(thread.get("report_json") or "").strip()
    if not body:
        raise ConsoleSendError(
            "저장된 본문이 없습니다 — 보고 패스가 아직 이 스레드의 메일을 만들지 않았습니다.",
        )

    # 담당자는 **저장된 값**에서. ⚠️ `recipient` 는 발송 대상이라 우리 팀함이 들어 있을 수
    #    있다 — `recipient_list` 가 `is_internal` 로 그걸 거른다(오늘 확인).
    owners = orx.recipient_list([thread.get("owner_recipient") or thread.get("recipient")])
    targets = _targets_for(domain, owners)
    return (
        DeliveryPayload(
            subject=_subject_for(domain, thread),
            body=body,
            recipients=tuple(targets["recipients"]),
            cc=tuple(targets["cc"]),
            finding_id=int(thread["finding_id"]) if thread.get("finding_id") else None,
            # ⚠️ json 본문을 HTML 이라고 우기면 메일이 깨진다 — 실제 형식을 말한다.
            metadata={"content_type": "HTML" if is_html else "TEXT"},
        ),
        str(targets["mode"]),
    )


def _targets_for(domain: str, owners: list[str]) -> dict[str, Any]:
    """도메인별 수신처 SSOT 를 그대로 쓴다 — 여기서 규칙을 다시 쓰지 않는다."""
    if domain == "github":
        from domains.services.github.application.scanner import github_report_delivery_targets
        return github_report_delivery_targets(owners, manual=True)
    if domain == "confluence":
        from domains.services.confluence.application.reporter import (
            confluence_report_delivery_targets,
        )
        return confluence_report_delivery_targets(owners, manual=True)
    if domain == "dev_web":
        from domains.dev_web.plugin.tools.dev_web_report_tools import (
            dev_web_report_delivery_targets,
        )
        return dev_web_report_delivery_targets(owners, manual=True)
    raise ConsoleSendError(f"모르는 도메인: {domain}")


_THREAD_GET = {
    "smb": lambda tid: state.mail_thread_get(tid),
    "github": lambda tid: state.github_report_thread_get(tid),
    "confluence": lambda tid: state.confluence_report_thread_get(tid),
    "dev_web": lambda tid: state.dev_web_report_thread_get(tid),
}



#: 발송 후 스레드가 서는 자리. smb 계열과 service_report 계열이 **어휘가 다르다**.
_SENT_STATUS = {"smb": "awaiting_reply", "github": "awaiting_owner",
                "confluence": "awaiting_owner", "dev_web": "awaiting_reply"}


def _record_manual_send(
    domain: str, thread: dict[str, Any], payload: DeliveryPayload, *, thread_id: int,
) -> None:
    """수동 발송이 실제로 나간 뒤 — 워커 경로와 **같은 것**을 남긴다.

    ⚠️ 실패가 발송을 뒤집지 않는다. 메일은 이미 나갔다. 기록에 실패했다고 예외를 내면
       화면엔 "발송 실패" 로 뜨고 사람이 **한 번 더 보낸다**. 로그로만 남긴다.
    """
    to = ", ".join(payload.recipients) or None
    cc = ", ".join(payload.cc) or None
    body = payload.body or None
    status = _SENT_STATUS.get(domain, "awaiting_owner")
    try:
        if domain == "smb":
            state.mail_thread_set_status(
                thread_id, status, request_message_id=None, recipient=to,
            )
            state.mail_thread_bump_attempt(thread_id, reason="report mailed (console)")
            state.mail_message_add(
                direction="out", thread_id=thread_id, subject=payload.subject,
                subject_tag=thread.get("subject_tag"), mail_from="dssoc", mail_to=to,
                body_excerpt=body,
                # 본문은 HTML 이다 — `body_html` 을 비우면 콘솔이 <pre> 로 그린다.
                body_html=body if body and "<" in body else None,
                agent_verdict="sent",
            )
        else:
            setter = getattr(state, f"{domain}_report_thread_set_status")
            setter(thread_id, status, recipient=to, notified_at=time.time(),
                   last_reason="report mailed (console)")
            state.service_reply_message_add(
                domain=domain, direction="out", thread_id=thread_id,
                subject=payload.subject, subject_tag=thread.get("subject_tag"),
                mail_from="dssoc", mail_to=to, mail_cc=cc,
                body_excerpt=body, body_html=body,
                agent_verdict="sent", decision_reason="outbound_report_notice",
            )
    except Exception:  # noqa: BLE001 — 메일은 이미 나갔다. 기록 실패로 재발송을 유도하지 않는다
        log.exception("[console-send] %s 스레드 %s 발송 기록 실패 — 메일은 나갔다",
                      domain, thread_id)


def send_thread(*, domain: str, thread_id: int, requested_by: str = "") -> dict[str, Any]:
    """스레드 1건을 발송한다. **게이트 판정이 결과다** — 차단도 정상 반환이다.

    반환 mode: "sent" | "dry_run". dry_run 이면 `reasons` 에 사유가 있다
    (allowlist 밖 수신자 · sink 미opt-in · 마스킹 후 잔존 hit 등).
    ⚠️ 예외는 **발송을 시작조차 못 한 경우**만이다(스레드 없음·본문 없음·수신자 없음).
       "막혔다" 는 예외가 아니라 결과다 — 그걸 예외로 만들면 화면이 고장과 정책을 못 가른다.
    """
    dom = str(domain or "").lower()
    getter = _THREAD_GET.get(dom)
    if getter is None:
        raise ConsoleSendError(f"모르는 도메인: {domain}")

    thread = getter(int(thread_id))
    if not thread:
        raise ConsoleSendError(f"{dom} 스레드 {thread_id} 를 찾을 수 없습니다.")

    payload, target_mode = (
        _smb_payload(thread) if dom == "smb" else _stored_payload(dom, thread)
    )

    # ★ 티켓번호를 찍는다 — 회신을 스레드에 붙이는 **1차 키**다.
    #   `stamp_subject_for_thread` 주석은 "발송 경로는 전부 이걸 쓴다" 고 하는데
    #   수동 발송만 안 쓰고 있었다(2026-08-31 실측: 4도메인 전부). 그대로 두면 사람이
    #   손으로 보낸 메일의 답장만 2차 키(제목 태그)로 떨어진다 — 굳이 약한 쪽으로.
    #   ⚠️ 멱등하다. 워커가 이미 찍은 제목에 다시 걸어도 번호가 겹치지 않는다.
    stamped = state.stamp_subject_for_thread(payload.subject, dom, int(thread_id))
    if stamped != payload.subject:
        payload = replace(payload, subject=stamped)

    if not payload.recipients:
        # 담당자를 모르면 **발송 실패로 남긴다**(2026-08-24 결정). 팀함으로 흘리지 않는다.
        raise ConsoleSendError(
            "수신자가 없습니다 — 담당자를 모르는 상태입니다. 팀함으로 대신 보내지 않습니다.",
        )

    try:
        result = deliver_sync(
            SINK_ID, payload,
            evidence_dir=_evidence_dir(),
            charter_ref=f"console-send:{dom}:{thread_id}",
        )
    except DeliveryError as e:
        raise ConsoleSendError(str(e)) from e

    # ★ 나갔으면 **나갔다고 쓴다.** 2026-08-31 실측: 수동 발송이 `deliver_sync` 뒤에
    #   아무것도 안 써서, 실제로 나간 메일 1건이 `mail_message` 0행 / 상태 그대로였다.
    #   운영자 화면엔 "통보됨" 이 안 뜨고, 발송 이력에도 없고, 재검증 흐름도 안 걸린다.
    #   워커 경로(`report_mail_agent`·`scanner._record_outbound_message`)는 네 가지를
    #   쓰는데 수동 경로만 하나도 안 썼다 — 같은 일을 두 경로가 다르게 하고 있었다.
    if result.mode == "sent":
        _record_manual_send(dom, thread, payload, thread_id=int(thread_id))

    return {
        "domain": dom,
        "threadId": int(thread_id),
        "mode": result.mode,
        "detail": result.detail,
        "reasons": list(result.reasons),
        "scanHits": list(result.scan_hits),
        "draftPath": result.draft_path,
        # 화면이 "누구에게 갈 뻔했나" 를 그릴 수 있게. 수신자는 담당자 메일이라 마스킹 안 한다
        # (콘솔이 이미 담당자를 이름·부서로 그린다 — 여기서만 가리면 두 화면이 어긋난다).
        "recipients": list(payload.recipients),
        "cc": list(payload.cc),
        "subject": payload.subject,
        #: 수신처 판정(normal | no_owner | dry_run). mode 와 **다른 축**이다 —
        #: 이건 "누구에게" 이고 mode 는 "실제로 나갔나" 다.
        "targetMode": target_mode,
        "requestedBy": requested_by or None,
        "at": time.time(),
    }
