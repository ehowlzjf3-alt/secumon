"""v3.78 F2: 기존 finding 소급 정리.

F1 의 노이즈 기준(is_low_value_only — 이메일/식별자-only PII 또는 자동차 번호뿐,
secret·고가치 PII 0)을 이미 적재된 finding 에 재적용해 false_positive 로 마킹한다.
삭제가 아니라 status 전이라 감사·복구 가능. 사람이 검토한
finding(triaged/accepted_risk/remediated)은 건드리지 않고 'open' 만 재평가한다.
"""
from __future__ import annotations

from typing import Any

from secu_agent import state
from secu_agent.agent.evidence_judgment import is_low_value_only


def find_low_value_findings(*, status: str = "open", limit: int = 100_000) -> list[dict[str, Any]]:
    """현 finding 중 제외 대상 PII 노이즈(secret·고가치 PII 0) 목록.

    status='open' 만 (사람이 검토한 건 제외). extra.hits 를 F1 규칙으로 재판정."""
    out: list[dict[str, Any]] = []
    for row in state.finding_list(status=status, limit=limit):
        hits = (row.get("extra") or {}).get("hits") or []
        if is_low_value_only(hits):
            out.append(row)
    return out


def retro_mark_low_value(*, apply: bool, reason: str) -> dict[str, Any]:
    """노이즈 finding 을 false_positive 로 마킹. apply=False 면 dry-run(카운트만)."""
    rows = find_low_value_findings()
    if apply:
        for row in rows:
            state.finding_set_status(row["id"], "false_positive", reason=reason)
    return {
        "count": len(rows),
        "applied": apply,
        "ids": [row["id"] for row in rows],
    }
