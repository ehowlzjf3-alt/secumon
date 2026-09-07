"""Finding verification helpers shared by domain report pipelines."""
from __future__ import annotations

from typing import Any, Iterable

AGENT_VERIFICATION_KEY = "agent_verification"
AGENT_VERIFICATION_VERSION = 1


def make_agent_verification(
    *,
    method: str,
    source: str,
    checks: Iterable[str] = (),
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the explicit marker required before report-thread promotion."""
    payload: dict[str, Any] = {
        "version": AGENT_VERIFICATION_VERSION,
        "status": "verified",
        "method": str(method or "").strip(),
        "source": str(source or "").strip(),
        "checks": [str(c).strip() for c in checks if str(c).strip()],
    }
    if details:
        payload["details"] = dict(details)
    return payload


def is_agent_verified_extra(extra: dict[str, Any] | None) -> bool:
    marker = (extra or {}).get(AGENT_VERIFICATION_KEY)
    if not isinstance(marker, dict):
        return False
    return (
        marker.get("status") == "verified"
        and bool(str(marker.get("method") or "").strip())
        and bool(str(marker.get("source") or "").strip())
    )


def stamp_agent_verification(
    fingerprint: str,
    *,
    method: str,
    source: str,
    checks: Iterable[str] = (),
    details: dict[str, Any] | None = None,
) -> bool:
    """제출이 성공한 finding 에 표식을 단다. → 달았으면 True.

    ## 왜 공용인가 (2026-08-30 사용자 결정: 4도메인 동일)

    이 표식은 "검증했다" 가 아니라 **"에이전트가 제출 도구로 냈다"** 는 사실이다.
    보고 파이프라인이 스레드를 만들기 전에 이걸 본다(`is_agent_verified_extra`).

    ⚠️ 표식과 게이트가 **다른 자리**에 있으면 조합이 어긋난다. 실측 2026-08-30:

        표식 O + 게이트 O   confluence   정상 19/19
        표식 X + 게이트 O   github       268건 영구 차단   ← 사고
        표식 O + 게이트 X   dev_web      게이트 무의미
        표식 X + 게이트 X   smb          게이트 없음

    도메인마다 따로 구현하면 이 표가 다시 생긴다. 한 함수로 모은다.
    """
    from secu_agent import state as core_state

    fid = _finding_id_by_fingerprint(fingerprint)
    if fid is None:
        return False  # 조회 실패 — 마커를 엉뚱한 행에 붙이지 않는다
    core_state.finding_update(
        fid,
        extra={"agent_verification": make_agent_verification(
            method=method, source=source, checks=checks, details=details or {})},
        merge_extra=True,
    )
    return True


def _finding_id_by_fingerprint(fp: str) -> int | None:
    """fingerprint → finding id. 도메인 제출 도구 넷이 쓰던 것과 같은 쿼리다."""
    from service import state_domain as state

    with state.connect() as c:
        row = c.execute(
            "SELECT id FROM finding_lifecycle WHERE fingerprint=?", (str(fp or ""),),
        ).fetchone()
    return int(row["id"]) if row else None
