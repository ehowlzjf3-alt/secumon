"""티켓 상태 수동 지정 — 콘솔 필터 어휘를 사람이 직접 쓴다.

## 왜 필요한가 (2026-09-01 사용자 요청)

콘솔 티켓 상세의 "담당자 진행사항" 은 `finding_triage`(control-plane) 를 썼다. 그건
**파이프라인이 모르는 별도 축**이라, 운영자가 "처리완료" 를 눌러도 티켓 상태는 그대로였고
목록 필터에도 안 잡혔다. 실측: 스레드 129 를 `resolved` 로 다섯 번 눌렀는데 smb 상태는
계속 `awaiting_reply` 였다.

사용자 결정: **필터에 있는 상태값을 사람이 직접 고칠 수 있게 한다.**

## ⚠️ 어휘가 도메인마다 다르다 — 이름의 유사성을 믿으면 안 된다

    필터        smb · dev_web        github · confluence
    발송 대기   report_ready         report_ready
    회신 대기   awaiting_reply       awaiting_owner      ← 다르다
    회신 옴     reply_received       recheck_requested   ← 다르다
    종결        closed               closed

`awaiting_reply` 를 github 스레드에 쓰면 `_GITHUB_REPORT_THREAD_STATUSES` 검증에 걸려
통째로 실패한다. 그래서 도메인별로 따로 적는다.

## ⚠️ 이 값을 바꾸면 파이프라인이 움직인다

`회신 옴`(smb `reply_received`)은 공용 러너가 집어 가는 큐다 — 재검증을 돌리고
**담당자에게 회신 메일을 보낸다.** 되돌릴 수 없는 행위라 화면이 그렇게 말해야 한다.
`발송 대기` 는 파킹 자리라 자동으로 나가지 않는다(운영자가 콘솔에서 수동 발송).
"""
from __future__ import annotations

import time
from typing import Any


class TicketStatusError(RuntimeError):
    """못 바꾼 이유 — 화면까지 그대로 올라간다."""


#: 콘솔 필터 키 → 도메인 native status. 필터(`THREAD_STATE_FILTER`)와 나란히 둔다.
#: ⚠️ `none`(보고 없음)·`reported`(보고 생성)는 **여기 없다** — 둘 다 "스레드가 있느냐" 를
#:    말하는 파생값이지 사람이 고를 수 있는 상태가 아니다. 넣으면 누르는 순간 뜻이 없다.
TICKET_STATUS_MAP: dict[str, dict[str, str]] = {
    "ready": {
        "smb": "report_ready", "dev_web": "report_ready",
        "github": "report_ready", "confluence": "report_ready",
    },
    "awaiting": {
        "smb": "awaiting_reply", "dev_web": "awaiting_reply",
        "github": "awaiting_owner", "confluence": "awaiting_owner",
    },
    "replied": {
        "smb": "reply_received", "dev_web": "reply_received",
        "github": "recheck_requested", "confluence": "recheck_requested",
    },
    # ★ `remediated` 로 쓴다(`closed` 아님 — 2026-09-01 사용자 지적).
    #   둘 다 필터의 "종결" 그룹이라 목록에선 같아 보이지만 **상세 라벨이 갈린다**:
    #       remediated = "조치 완료"   파이프라인이 재검증으로 닫힌 걸 확인했을 때
    #       closed     = "종결"        더 이상 안 다룬다
    #   사람이 누른 것만 "종결" 로 다르게 보이면 같은 결과가 두 이름을 갖는다.
    #   운영자가 이 버튼을 누르는 것은 "조치가 끝났다" 는 판단이므로 파이프라인과 같은 값을 쓴다.
    "closed": {
        "smb": "remediated", "dev_web": "remediated",
        "github": "remediated", "confluence": "remediated",
    },
}

#: 사람이 고를 수 있는 값의 순서(화면 순서와 같다 — 생애주기 순).
TICKET_STATUS_ORDER: tuple[str, ...] = ("ready", "awaiting", "replied", "closed")

#: 도메인별 스레드 조회/기록. `owner_assign` 과 같은 어휘를 쓴다.
_THREAD_GET = {
    "smb": "mail_thread_get",
    "github": "github_report_thread_get",
    "confluence": "confluence_report_thread_get",
    "dev_web": "dev_web_report_thread_get",
}
_THREAD_SET = {
    "smb": "mail_thread_set_status",
    "github": "github_report_thread_set_status",
    "confluence": "confluence_report_thread_set_status",
    "dev_web": "dev_web_report_thread_set_status",
}


def native_status(ticket_status: str, domain: str) -> str:
    """필터 키 + 도메인 → 그 도메인이 실제로 받는 status."""
    key = str(ticket_status or "").strip()
    dom = str(domain or "").lower()
    by_domain = TICKET_STATUS_MAP.get(key)
    if by_domain is None:
        raise TicketStatusError(
            f"모르는 티켓 상태: {ticket_status!r} "
            f"(가능: {', '.join(TICKET_STATUS_ORDER)})")
    native = by_domain.get(dom)
    if native is None:
        raise TicketStatusError(f"모르는 도메인: {domain!r}")
    return native


def set_ticket_status(
    *, domain: str, thread_id: int, ticket_status: str, requested_by: str = "",
) -> dict[str, Any]:
    """티켓 상태를 사람이 고른 값으로 바꾼다. 반환값은 화면이 그대로 보여준다."""
    from service import state_domain as state

    dom = str(domain or "").lower()
    getter = _THREAD_GET.get(dom)
    setter = _THREAD_SET.get(dom)
    if getter is None or setter is None:
        raise TicketStatusError(f"모르는 도메인: {domain}")

    target = native_status(ticket_status, dom)

    thread = getattr(state, getter)(int(thread_id))
    if not thread:
        raise TicketStatusError(f"{dom} 스레드 {thread_id} 를 찾을 수 없습니다.")
    previous = str(thread.get("status") or "")
    if previous == target:
        raise TicketStatusError(f"이미 '{target}' 입니다.")

    # ★ 클레임은 **일부러 안 넘긴다.** 네 setter 모두 `claimed_by` 를 명시하지 않으면
    #   스스로 NULL 로 푼다(진행중 상태 제외). 여기서 또 넘기면 그 로직을 우회하게 되고,
    #   열 이름이 도메인마다 다를 때 조용히 깨진다 — 있는 규칙을 다시 쓰지 않는다.
    getattr(state, setter)(
        int(thread_id), target,
        last_reason=f"운영자 지정: {previous or '(없음)'} → {target}"
                    + (f" ({requested_by})" if requested_by else ""),
    )

    return {
        "domain": dom,
        "threadId": int(thread_id),
        "ticketStatus": str(ticket_status),
        "previous": previous or None,
        "status": target,
        "requestedBy": requested_by or None,
        "at": time.time(),
    }
