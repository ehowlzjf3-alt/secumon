"""공유 폴더에 노출된 항목이 **몇 건인지** 센다 — 조치요청 메일 머리 지표용.

## 왜 (사용자 지시 2026-08-31)

메일 머리에 `대상 IP` · `확인 내용` · `요청 사항` · `담당자` 가 있는데 **규모가 없다.**
담당자가 급한지 아닌지 판단할 숫자가 한 칸 필요하다. 실측(10.125.102.246):
공유 3개에 열람 가능한 파일 6,373개.

## ⚠️ 세는 것만 한다

파일 경로·파일명은 싣지 않는다. 다른 도메인 메일도 그렇게 하고 있고
(*"보안상 파일 경로와 값은 메일에 포함하지 않습니다"*), 메일은 전달·회신으로
퍼지므로 경로 자체가 정찰 정보다. egress 게이트의 PII 스캔에도 걸린다
(경로에 사람 이름·사번이 흔하다).
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)


def exposed_item_count(share_ids: list[int]) -> int:
    """이 공유들에서 열람 가능한 파일 수. 못 세면 0.

    ⚠️ 실패해도 예외를 내지 않는다 — 지표 한 칸 때문에 조치요청이 못 나가면 안 된다.
    """
    ids = [int(x) for x in (share_ids or []) if x]
    if not ids:
        return 0
    from service import state_domain as state

    try:
        with state.connect() as c:
            r = c.execute(
                "SELECT COUNT(*) n FROM smb_file WHERE share_id IN ("
                + ",".join("?" for _ in ids) + ")",
                ids,
            ).fetchone()
        return int(r["n"] or 0) if r is not None else 0
    except Exception:  # noqa: BLE001
        log.warning("[smb] 노출 항목 수 집계 실패 shares=%s", ids, exc_info=True)
        return 0


def share_sensitive_counts(share_ids: list[int]) -> dict[str, int]:
    """공유 **안 파일들**의 탐지를 분류별로 센다.

    ★ 2026-08-31 — smb 메일의 "확인된 민감 항목" 이 늘 비어 있었다. 집계 근거가
      `finding.extra.hits`(그 finding 자체의 탐지)뿐인데, 공유 노출 finding 은
      "이 공유가 열려 있다" 는 사실만 담고 파일 탐지를 담지 않기 때문이다.
      실제 탐지는 `smb_file_hit` 에 파일 단위로 있다(전체 70개 공유에 존재).

    분류·라벨·조치 문구는 `sensitive_summary` 정본을 그대로 쓴다 — 4도메인이 같은
    어휘로 말해야 한다.
    """
    ids = [int(x) for x in (share_ids or []) if x]
    if not ids:
        return {}
    from service import state_domain as state
    from service.services import sensitive_summary

    out: dict[str, int] = {}
    try:
        with state.connect() as c:
            rows = c.execute(
                "SELECT h.category, h.kind, COUNT(*) n FROM smb_file_hit h "
                "JOIN smb_file f ON f.id = h.file_id WHERE f.share_id IN ("
                + ",".join("?" for _ in ids) + ") "
                # ★ **오탐으로 판정된 것은 세지 않는다** (사용자 결정 2026-09-02).
                #   판정기가 `false_positive` 를 찍어 놓았는데 이 쿼리가 판정 축을 아예
                #   안 봐서, 그대로 담당자 메일 건수에 실려 나갔다. 실측:
                #     12.25.122.146(김명규님) hit 568건 · 판정된 6건 전부 오탐 · 확정 0
                #     12.25.109.98 (윤종필님) hit  94건 · 판정된 3건 전부 오탐 · 확정 0
                #   담당자가 "계측 설비 IP 인데 공정문서라니" 라고 되물은 것이 이 경로다.
                #   ⚠️ `pending`(미판정)은 **뺄 수 없다** — 판정된 것이 전체의 2.5% 뿐이라
                #      pending 을 빼면 메일이 거의 빈다. 그래서 "오탐만" 제외한다.
                "AND COALESCE(h.agent_verdict, '') <> 'false_positive' "
                "GROUP BY 1, 2",
                ids,
            ).fetchall()
    except Exception:  # noqa: BLE001
        log.warning("[smb] 공유 탐지 집계 실패 shares=%s", ids, exc_info=True)
        return {}
    for r in rows:
        bucket = sensitive_summary.sensitive_bucket(r["category"], r["kind"])
        if bucket:
            out[bucket] = out.get(bucket, 0) + int(r["n"] or 0)
    return out


# ── 렌더러는 4도메인 공용이다 ─────────────────────────────────────────
# ⚠️ 여기서 다시 만들지 마라. `sensitive_summary` 가 분류·라벨·문구의 정본이고,
#    smb 가 자기 모양을 따로 가지면 도메인마다 다른 말을 하게 된다.
from service.services.sensitive_summary import (  # noqa: E402,F401
    credential_notice_html, exposure_metric_html,
)
