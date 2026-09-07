"""finding enrichment — 등록형 훅 (de-domain v3.84 #3).

이전엔 코어 submit_finding 이 secu_agent.agent.pivot 을 직접 import 해 finding emit
마다 도메인-특화 pivot(SMB UNC / SAML SP / k8s ingress / 대상 API 표면 추출 → 내부
GET-probe)을 돌렸다. 그 pivot 로직은 순수 보안점검 도메인 지식이라 secu-agent-skill 로
이관하고, 코어는 등록된 enricher 를 순회 호출만 한다. 등록 없음(코어 단독)=enrichment
없음(도메인-프리 기본).

enricher 계약: fn(*, asset: str, summary: str, hits: list) -> dict | None.
  반환 dict 는 finding.extra 슬롯에 기록되고 signal 로 집계된다. record-only(게이트/
  차단 아님). 예외는 삼켜 finding 자체를 막지 않는다(구 pivot 의 fail-open 보존).

  v3.85 결과 descriptor(모두 optional — 도메인 어휘 중립화):
    - slot (str)         : finding.extra 의 어느 키에 payload 병합할지. 미선언 시 "pivot"
                           (구 network enricher 종전 위치 보존). 도메인마다 다른 slot 을
                           선언하면 서로 덮어쓰지 않는다.
    - payload (dict)     : 슬롯에 기록할 데이터. 없으면 descriptor 메타키를 뺀 dict 전체.
    - signal_count (int) : FindingSignal.pivot_exposed(노출/신호 카운트 요약)에 더할 수치.
                           없으면 하위호환으로 exposed_count 사용. (signal_key 는 payload
                           에서 제외되는 예약 키 — 현재 카운트는 단일 합계로 집계.)
    - followup_hint (str): 이 finding 이 뒤이어 필요로 하는 후속 행동 nudge(내러티브).
                           코어는 하드코딩 nudge 를 들지 않는다 — 도메인 enricher 가 공급.
  descriptor 를 안 쓰는 구 enricher(예: exposed_count 만 반환)는 기본값으로 종전 동작 보존.
"""
from __future__ import annotations

from typing import Any, Callable

# descriptor 메타키 — payload 미선언 시 이 키들을 뺀 나머지가 payload 가 된다.
ENRICHMENT_META_KEYS = frozenset(
    {"slot", "payload", "signal_key", "signal_count", "followup_hint"}
)

_ENRICHERS: list[Callable[..., dict[str, Any] | None]] = []
_FOLLOWUP_HINTS: list[Callable[..., list[str]]] = []


def register_finding_enricher(fn: Callable[..., dict[str, Any] | None]) -> None:
    """finding enricher 등록 (plugin 부트스트랩용)."""
    if not callable(fn):
        raise TypeError("finding enricher 는 callable 이어야 한다")
    _ENRICHERS.append(fn)


def register_followup_hint(fn: Callable[..., list[str]]) -> None:
    """후속행동 nudge 공급자 등록 (plugin 부트스트랩용).

    fn(signals) -> list[str]. build_followup_message 가 등록된 hint 를 앞에 붙인다.
    이전엔 코어가 network 특화 [PIVOT] nudge 를 하드코딩했으나, 이제 도메인 plugin 이
    자기 nudge 를 공급한다(코어는 hint 를 하나도 들지 않는다 — 도메인-프리 기본).
    """
    if not callable(fn):
        raise TypeError("followup hint 는 callable 이어야 한다")
    _FOLLOWUP_HINTS.append(fn)


def run_followup_hints(signals: Any) -> list[str]:
    """등록된 hint 공급자 순회 → 문자열 라인 평탄화. 예외는 삼킨다(fail-open)."""
    out: list[str] = []
    for fn in _FOLLOWUP_HINTS:
        try:
            lines = fn(signals)
        except Exception:
            continue
        if lines:
            out.extend(str(x) for x in lines)
    return out


def unregister_all_finding_enrichers() -> None:
    """등록 전체 해제 (테스트/재부착 멱등 보장용)."""
    _ENRICHERS.clear()
    _FOLLOWUP_HINTS.clear()


def run_finding_enrichers(
    *, asset: str, summary: str, hits: Any,
) -> list[dict[str, Any]]:
    """등록된 enricher 순회 호출 → 비-None dict 결과 리스트. 예외는 삼킨다.

    blocking(network probe) 가능하므로 호출부가 asyncio.to_thread 로 offload 한다.
    """
    out: list[dict[str, Any]] = []
    for fn in _ENRICHERS:
        try:
            r = fn(asset=asset, summary=summary, hits=hits)
        except Exception:
            continue
        if r:
            out.append(r)
    return out


__all__ = [
    "register_finding_enricher",
    "register_followup_hint",
    "run_followup_hints",
    "unregister_all_finding_enrichers",
    "run_finding_enrichers",
    "ENRICHMENT_META_KEYS",
]
