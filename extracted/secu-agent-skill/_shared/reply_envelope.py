"""회신 봉투 — 제목·수신처·인용문. 도메인이 안 주면 이 기본형을 쓴다.

## 왜 기본형이 필요한가

smb 만 **받은 메일**을 갖고 있다(POP3 대조). 그래서 smb 는 reply-all 을 하고,
제목의 `RE:` 카운트를 올리고, 원문을 인용해 붙일 수 있다. 나머지 셋은 담당자에게서
받은 것이 없으니 그럴 재료 자체가 없다.

넷이 다르다고 회신 도구가 `if domain == "smb"` 를 하면 안 된다 — 그 분기가
네 벌로 번지는 것이 이 계약이 없애려는 모양이다. 도메인이 봉투를 주면 그걸 쓰고,
없으면 여기로 떨어진다.
"""
from __future__ import annotations

from typing import Any


def default_reply_envelope(
    adapter: Any,
    thread: dict[str, Any],
    *,
    ticket_no: str | None = None,
) -> dict[str, Any]:
    """받은 메일이 없는 도메인의 회신 봉투.

    수신처는 스레드에 적힌 담당자다. 정책(담당자 To + DSSOC Cc)은 어댑터의
    `delivery_targets` 가 소유한다 — 여기서 다시 정하지 않는다.
    """
    from service.services import remediation_mail as rm

    owner = [a for a in (thread.get("owner_recipient"), thread.get("recipient")) if a]
    targets: dict[str, Any] = {}
    if adapter.delivery_targets is not None:
        try:
            targets = adapter.delivery_targets(owner or None) or {}
        except Exception as e:  # noqa: BLE001
            # ⚠️ 수신처 규칙이 모순이면 정책이 **예외를 던진다**(의도된 fail-loud).
            #    조용히 담당자를 채우지 마라 — 실제 사람에게 잘못 나간다.
            return {"error": f"수신처 결정 실패: {e!r}"[:300]}

    from _shared.ticket_id import stamp_subject_with

    # 번호의 정본은 DB 저장값이다 — 여기서 공식으로 다시 만들지 않는다.
    subject = stamp_subject_with(rm.reply_subject(str(thread.get("subject_tag") or "")), ticket_no)
    return {
        "subject": subject,
        "recipients": targets.get("recipients") or [],
        "cc": targets.get("cc") or [],
        "mode": targets.get("mode"),
        "quote_html": "",
    }
