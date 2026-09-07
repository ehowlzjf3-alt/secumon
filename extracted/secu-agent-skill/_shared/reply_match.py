"""회신 매칭 규칙 — **4도메인 한 벌**. 어떤 답장이 어느 티켓에 붙는가.

## 왜 이 파일이 생겼나 (사용자 지시 2026-08-31)

> "이건 최초에 SMB 기준으로는 헤더+ip기준으로 정했었는데 다른 도메인 기준으로는
>  우리가 정한 적이없어서 이것도 정해야 돼" / "이것도 마찬가지로 통일된걸로!"

정확한 지적이었다. smb 규칙만 정해져 있었고, 나머지 셋은 **복사된 채 검증된 적이 없다.**
실측하니 셋은 그냥 안 도는 게 아니라 **구조적으로 절대 매칭될 수 없는** 상태였다:

    service_report_thread_find_inbound_match_at 은 "발송 경계"가 없으면 return None.
    경계의 출처는 둘뿐 —
        notified_at                       github 552건 중 0 · confluence 44건 중 0
                                          dev_web 은 **열 자체가 없다**
        service_reply_message out/sent    테이블 전체 0행
    ⇒ 셋은 답장이 와도 100% 미아(thread_id=NULL)가 된다.

smb 만 경계가 없어도 매칭했다. 그래서 smb 만 동작했다.

## 통일된 규칙

    1차  티켓번호   제목의 [티켓 SMB00024] → (도메인, 스레드) 를 **직접** 확정
                    · 좌표를 파싱하지 않는다 → 도메인 오분류가 원리적으로 불가능
                    · 스레드 행 id 라 같은 대상의 지난 주/이번 주 혼동이 없다
                    · 사람이 제목 앞뒤를 고쳐도 살아남는다(RE:/FW: 는 앞에 쌓인다)

    2차  제목 태그   티켓 표식 이전에 나간 메일의 답장을 위한 **폴백**
                    후보 = subject_tag 일치 AND status IN <그 도메인의 열린 상태>
                    발송 경계가 있으면: 답장 수신시각 <= 경계 → 매칭 안 함
                                        (지난 주차 스레드가 이번 주 답장을 가져가는 것 방지)
                    발송 경계가 없으면: **매칭한다** ← smb 규칙으로 통일

## ★ 왜 "경계 없으면 매칭" 쪽으로 통일했나

경계를 요구한 의도는 "우리가 보낸 적 없는 스레드에 답장이 붙는 것"을 막는 것이었다.
그런데 실제로 막은 것은 **발송 기록이 유실된 경우**였고, 그게 셋을 전면 차단했다.
답장이 왔다는 것 자체가 우리가 보냈다는 증거다 — 우리 제목 태그를 달고 오기 때문이다.
과거 주차 보호는 경계가 **있을 때만** 필요하고, 없으면 태그+열린상태로 충분하다.

(발송 기록을 제대로 남기는 것은 별개 문제다. 매칭 규칙이 그 결함의 인질이 되면 안 된다.)

## 통일하지 **않은** 것 — 상태 어휘

    smb   awaiting_reply / reply_received / reverifying / re_requested
    셋    awaiting_owner / recheck_requested / still_open

이건 상태 기계가 실제로 다른 것이지 복붙 드리프트가 아니다(smb 는 답장 왕복,
셋은 재검증 주기). **규칙을 통일하는 것과 어휘를 통일하는 것은 다르다** —
좌표 열(host/repo/space_key/url)을 하나로 만들지 않는 것과 같은 이유다.
"""
from __future__ import annotations

from typing import Any

#: 매칭 근거. 로그·감사에 남긴다 — "붙었다"만으로는 왜 붙었는지 못 되짚는다.
MATCHED_BY_TICKET = "ticket_no"
MATCHED_BY_SUBJECT_TAG = "subject_tag"


def match_inbound_thread(
    subject: str,
    *,
    received_at: float | None = None,
    classified: tuple[str, str] | None = None,
) -> dict[str, Any] | None:
    """받은 메일 제목 → `{domain, thread_id, thread, matched_by}`. 못 붙이면 None.

    classified: 호출부가 이미 구한 `(도메인, 제목태그)`. **주면 그걸 쓴다.**
        ⚠️ 여기서 다시 분류하면 호출부의 분류 경로를 잃는다 — 수집기에는 env 기반
           스모크 라우팅(`SMB_POP3_TEST_SUBJECT_TAG` 등)이 있어서 제목만으로는
           태그를 못 얻는 메일이 있다. 2026-08-31 에 이걸 놓쳐 테스트 4건이 깨졌다.

    ⚠️ 1차가 실패하면 **조용히 2차로 떨어지지 않는다** — 티켓 표식이 있는데 그 스레드가
       없거나 닫혀 있으면, 그건 폴백할 일이 아니라 알아야 할 사실이다. 그래서
       `matched_by` 에 근거를 남기고 `ticket_rejected` 로 사유를 실어 보낸다.
    """
    from _shared.thread_adapter import get_thread_adapter
    from _shared.ticket_id import parse_ticket

    subj = str(subject or "")
    out: dict[str, Any] = {}

    # ── 1차: 티켓번호 ───────────────────────────────────────────────
    parsed = parse_ticket(subj)
    if parsed is not None:
        domain, thread_id = parsed
        adapter = get_thread_adapter(domain)
        if adapter is None:
            # ★ 조용히 태그 폴백으로 떨어지면 안 된다. 어댑터 미등록은 **1차 키가 통째로
            #   꺼진 상태**다 — `service/agents/runtime.py` 는 부트스트랩이 실패해도
            #   warning 만 남기고 진행하므로 실제로 일어날 수 있다.
            #   2026-08-31 에 내가 이걸로 오진했다(부트스트랩 없는 probe 가 태그로 떨어졌다).
            out["ticket_rejected"] = (
                f"{domain} 스레드 어댑터가 등록되지 않았다 — 티켓 매칭이 꺼진 상태다"
                " (plugin/bootstrap.register_all 확인)"
            )
        else:
            thread = adapter.thread_get(int(thread_id))
            if thread is None:
                out["ticket_rejected"] = f"{domain}#{thread_id} 스레드가 없다"
            elif not _is_open(domain, str(thread.get("status") or "")):
                out["ticket_rejected"] = (
                    f"{domain}#{thread_id} 가 닫힌 상태다(status={thread.get('status')})"
                )
            else:
                return {
                    "domain": domain,
                    "thread_id": int(thread_id),
                    "thread": thread,
                    "matched_by": MATCHED_BY_TICKET,
                }

    # ── 2차: 제목 태그 ──────────────────────────────────────────────
    import service.state_domain as state
    from service.collector.mail_inbound import classify_subject_tag_from_subject

    if classified is None:
        classified = classify_subject_tag_from_subject(subj)
    if classified is None:
        return out or None
    domain, tag = classified
    if domain == "smb":
        thread = state.mail_thread_find_inbound_match_at(tag, received_at=received_at)
    else:
        thread = state.service_report_thread_find_inbound_match_at(
            domain, tag, received_at=received_at,
        )
    if thread is None:
        out["subject_tag"] = tag
        out["domain"] = domain
        return out or None
    return {
        "domain": domain,
        "thread_id": int(thread["id"]),
        "thread": thread,
        "matched_by": MATCHED_BY_SUBJECT_TAG,
        "subject_tag": tag,
        **({"ticket_rejected": out["ticket_rejected"]} if out.get("ticket_rejected") else {}),
    }


def _is_open(domain: str, status: str) -> bool:
    """이 스레드가 아직 답장을 받을 수 있는 상태인가.

    정본은 각 도메인의 **기존 매칭 상태 집합**이다 — 이미 큐레이션된 것이라
    여기서 다시 정의하지 않는다(복사하면 조용히 갈린다).
    """
    import service.state_domain as state

    if domain == "smb":
        return status in state._MAIL_THREAD_INBOUND_MATCH_STATUSES
    try:
        return status in state.service_report_inbound_match_statuses(domain)
    except ValueError:
        return False
