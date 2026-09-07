"""공유를 닫을 때 반드시 붙는 것 둘 — **경로가 달라도 규칙은 하나여야 한다.**

## 왜 (2026-08-29)

이 두 백스톱은 `inspect_contract._close_queue` 안에만 있었고, 그 자리는
`if is_delegated_inspector(): ... return` **아래**였다. 리드/검토원 2단 분리 이후
운영은 전부 위임 경로라, 백스톱이 붙는 자리를 **아무도 지나가지 않는다.**
실제로 닫는 쪽은 리드의 `lead_adapter._set_status` 인데 거기엔 백스톱이 없었다.

실측 2026-08-29 (라이브):

    검토원 권고            283건
      제출 없이 완료 권고  271건 (95.8%)
    smb finding_lifecycle   12건 = 제출 12건
    smb_file_hit 판정       pending 39,486 · false_positive 1,577 · confirmed 0

    12.36.127.132\\share  ← null 세션으로 읽힘(null_login_ok=1, share_read=1)
      hit 11178  ECHO/tests/keys/id_rsa        private_key_block  pending
      hit 11180  github/keys/private_key.pem   private_key_block  pending
      → finding 0건, 공유는 triaged_completed

백스톱 둘:
  ① 노출 자체가 보고 대상이다 — 제출이 없으면 draft 노출 finding 을 만든다.
  ② 훑을 게 남았으면 7일이 아니라 8시간 뒤에 다시 본다(`retry_after`).
     상태 어휘는 안 바꾼다 — claim SQL 이 이미 `retry_after <= now` 를 본다.
"""
from __future__ import annotations

import logging
import time
from typing import Any

log = logging.getLogger("domains.smb.share_close")

#: 종결 상태 — 여기로 닫을 때만 백스톱이 붙는다. 미종결(`walked` 등)은 그대로 큐에 있다.
TERMINAL_STATUSES = frozenset({"triaged_completed", "triaged_errored"})


def apply(
    share_id: int, status: str, *, saw_submit: bool, rescan_soon_seconds: int,
) -> dict[str, Any]:
    """닫기 직전에 붙일 추가 필드를 돌려준다. 부작용(노출 finding)은 여기서 일으킨다.

    반환 예: `{"retry_after": 1756…, "_exposure_finding_id": 41230}`
    (`_` 로 시작하는 키는 호출부용 정보다 — DB 컬럼이 아니니 걸러서 써라.)
    """
    from service import state_domain as state

    out: dict[str, Any] = {}
    if status not in TERMINAL_STATUSES:
        return out

    # ★ **재는 것을 먼저 한다.** 노출 finding 을 만들면 그 부수효과(share UPDATE·
    #   스레드 생성)가 같은 트랜잭션에 얹혀, 뒤이은 큐 조회가 0 을 돌려준다
    #   (2026-08-30 실측: 1 → 0). 상태를 바꾸기 전에 관측한다.
    try:
        pending_left = int(state.count_files_pending_scan(share_id=share_id) or 0)
    except Exception:  # noqa: BLE001 — 못 세면 예전대로 7일 주기
        pending_left = 0

    # ① 제출이 없으면 노출 자체를 남긴다.
    #
    # ★ codex #8: `saw_submit` 은 **호출자가 준 숫자**다. 그것만 믿으면 두 방향으로
    #   틀린다 — 실제 제출이 있는데 0 을 넘기면 노출 finding 을 또 만들고, >0 인데
    #   제출이 없으면 안 만든다. DB 를 함께 본다.
    submitted = bool(saw_submit)
    if not submitted:
        try:
            submitted = bool(state.smb_share_has_submitted_finding(share_id))
        except Exception:  # noqa: BLE001 — 못 읽으면 호출자 값을 쓴다
            submitted = bool(saw_submit)
    if not submitted:
        try:
            fid = state.smb_share_ensure_open_exposure_finding(share_id, status="draft")
            if fid is not None:
                out["_exposure_finding_id"] = int(fid)
        except Exception:  # noqa: BLE001 — 백스톱이 닫기를 막지는 않는다
            log.warning("[close] share=%s 노출 finding 실패", share_id, exc_info=True)

    # ② 훑을 게 남았으면 다음 주기를 당긴다.
    if pending_left:
        out["retry_after"] = time.time() + int(rescan_soon_seconds)
        out["_pending_left"] = pending_left
    return out


def db_fields(extra: dict[str, Any]) -> dict[str, Any]:
    """`apply()` 결과에서 DB 컬럼만 추린다."""
    return {k: v for k, v in extra.items() if not k.startswith("_")}
