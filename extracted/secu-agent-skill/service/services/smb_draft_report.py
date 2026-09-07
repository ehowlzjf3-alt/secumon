"""smb 조치요청 **초안 본문**을 스레드에 남긴다 — 스레드를 만드는 모든 경로가 쓴다.

## 왜 (2026-08-31 실측)

콘솔의 smb 티켓에서 "메일 준비됨" 이 안 뜨고 발송 버튼도 없었다. 화면은 본문이
있을 때만 그 둘을 그린다. 실측:

    W35 draft   23건 중 본문 23   (100%)
    W36 draft   22건 중 본문  7   ( 32%)  ← 15건 없음

없는 15건은 전부 **노출 자체 finding**(`smb_share_ensure_open_exposure_finding`)
이었다. 초안을 쓰는 코드가 `smb_submit_finding_tool` 안에만 있어서, 제출 도구를
거치지 않는 그 백스톱 경로는 스레드만 만들고 본문을 안 남긴다.

github·confluence·dev_web 은 `report_json` 이 100% 다 — 셋은 보고서 생성 시점에
쓰고, 그 경로가 하나뿐이기 때문이다. smb 만 스레드를 만드는 경로가 둘이다.

⇒ 초안 쓰기를 **한 벌로** 빼서 두 경로가 같은 것을 남기게 한다.

## 실패는 삼킨다

본문은 부가물이다. 여기서 예외를 내면 finding 제출이나 백스톱이 통째로 죽는다 —
이 저장소가 반복해서 당한 형태다. 실패는 로그로만 남긴다.
"""
from __future__ import annotations

import logging
import time

log = logging.getLogger(__name__)


def ensure_thread_draft(thread_id: int, *, finding_id: int, host: str) -> bool:
    """이 스레드에 초안 본문이 없으면 만들어 넣는다. 넣었으면 True.

    ⚠️ 이미 있으면 **덮어쓰지 않는다** — 발송된 본문을 재생성으로 갈아치우면
       "우리가 무엇을 보냈나" 의 기록이 사라진다.
    """
    from service import state_domain as state

    try:
        thread = state.mail_thread_get(int(thread_id))
        if thread is None or thread.get("report_json"):
            return False

        from service.services import smb_remediation_report

        report = smb_remediation_report.build_remediation_report(
            finding_id=int(finding_id), host=str(host),
        )
        state.mail_thread_set_report(int(thread_id), {
            "subject_tag": report.get("subject_tag"),
            "severity": report.get("severity"),
            "html": report.get("html"),
            "plain_summary": report.get("plain_summary"),
            "remediation_actions": report.get("remediation_actions"),
            "built_at": time.time(),
            "built_from_finding_id": int(finding_id),
        })
        return True
    except Exception:  # noqa: BLE001 — 본문 실패가 제출·백스톱을 죽이면 안 된다
        log.warning("[smb] 초안 본문 생성 실패 thread=%s finding=%s",
                    thread_id, finding_id, exc_info=True)
        return False


def promote_ready_host_drafts(*, limit: int = 200) -> dict[str, int]:
    """→ `draft_promotion.promote_smb_host_drafts` (2026-08-31 이사).

    dev_web 도 **같은 결함**이었다(승격 호출부가 테스트뿐). 같은 생각을 두 파일에 두면
    한쪽만 고쳐지므로 한 곳으로 모았다. 이 이름은 호출부·테스트가 쓰고 있어 남긴다.

    ⚠️ 반환 키가 하나 바뀌었다: `hosts_seen` → `seen`(두 도메인 공통 어휘).
    """
    from service.services.draft_promotion import promote_smb_host_drafts

    out = promote_smb_host_drafts(limit=limit)
    return {**out, "hosts_seen": out["seen"]}


def rebuild_draft_body(thread_id: int, *, finding_id: int, host: str) -> bool:
    """**안 나간** 초안의 본문을 다시 만든다(덮어쓴다).

    ## 왜 별도 함수인가

    `ensure_thread_draft` 는 본문이 있으면 손대지 않는다 — 발송된 본문을 재생성으로
    갈아치우면 "우리가 무엇을 보냈나" 가 사라지기 때문이다. 그 규칙은 옳다.

    그런데 문안을 고쳐도 **이미 저장된 초안은 옛 문구 그대로** 남는다. 실측 2026-08-31:

        "2주 누적 확인"(발송 근거 아님)   smb 1 · github 144 · confluence 20
        "DSSOC"(→ DS보안관제 로 바뀐 표기) smb 46 · github 290 · confluence 44

    사용자가 화면에서 그걸 보고 "본문이 안 고쳐졌네 다들" 이라고 했다. 생성기는 고쳐졌고
    저장본이 낡은 것이다.

    ⚠️ **나간 적 있는 스레드는 절대 건드리지 않는다.** 발송 이력(`mail_message` out/sent)이
       있으면 즉시 False. 초안만 다시 만든다.
    """
    from service import state_domain as state

    try:
        with state.connect() as c:
            sent = c.execute(
                "SELECT count(*) AS n FROM mail_message "
                "WHERE thread_id=? AND direction='out' AND agent_verdict='sent'",
                (int(thread_id),),
            ).fetchone()
        if int((sent or {"n": 0})["n"] or 0):
            return False   # 나갔다 — 근거를 갈아치우지 않는다

        from service.services import smb_remediation_report

        report = smb_remediation_report.build_remediation_report(
            finding_id=int(finding_id), host=str(host),
        )
        state.mail_thread_set_report(int(thread_id), {
            "subject_tag": report.get("subject_tag"),
            "severity": report.get("severity"),
            "html": report.get("html"),
            "plain_summary": report.get("plain_summary"),
            "remediation_actions": report.get("remediation_actions"),
            "built_at": time.time(),
            "built_from_finding_id": int(finding_id),
            "rebuilt": True,
        })
        return True
    except Exception:  # noqa: BLE001
        log.warning("[smb] 초안 본문 재생성 실패 thread=%s finding=%s",
                    thread_id, finding_id, exc_info=True)
        return False
