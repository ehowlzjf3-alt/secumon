"""candidate 품질 read repo — skill_quality.worker_candidate_quality (VIEW) 조회 (#1 눈).

runtime_repo 와 동일 계약:
- **schema-qualified VIEW 만** 조회(base table 금지 — 기밀성 경계는 sql/003 이 VIEW SELECT 만 부여).
- bounded: recent-window + hard limit. attempt 당 이벤트 ≤3행이라 window 내 attempt 수로 유계.
- free-text 컬럼을 아예 SELECT 하지 않는다(뷰에 label/경로 자체가 없음 — 이중 방어).

주의: 이 VIEW SELECT 권한은 게이트웨이 RO 롤에 기본 미부여(sql/001). sql/003_quality_read_grants.sql
을 사용자가 적용해야 조회 가능(prod DDL 게이트). 미적용 시 42501, 스키마/뷰 미생성 시 42P01.
"""
from __future__ import annotations

from typing import Any

from ..db import ReadOnlyPool

MAX_WINDOW_S = 30 * 24 * 3600   # runtime_repo.RECENT_WINDOW_S 와 동일 상한
ATTEMPT_HARD_LIMIT = 5000       # window 내 attempt pivot 상한 — 초과 시 최신순 절단(서비스가 truncated 표시)


def attempts_recent(pool: ReadOnlyPool, window_s: int, limit: int = ATTEMPT_HARD_LIMIT) -> list[dict[str, Any]]:
    """window 내 이벤트를 attempt 단위로 pivot — quality_states.resolve_attempt 의 입력.

    BOOL_OR/MAX 로 attempt 당 1행. worker_result(w_*)/parent_observed(p_*) 값을 분리 유지해
    파생(우선순위·invalid 판정)은 순수함수 계층에 맡긴다(이 repo 는 SQL 경계).
    limit+1 행을 요청한다 — 호출측이 len>limit 로 절단을 판정(경계 오탐 방지, codex verify #10).
    """
    window_s = min(int(window_s), MAX_WINDOW_S)
    return pool.fetch_all(
        "SELECT attempt_id, domain, worker_type, component, "
        "MAX(recorded_at) AS last_at, "
        "BOOL_OR(event_kind = 'started') AS has_started, "
        "BOOL_OR(event_kind = 'worker_result') AS has_worker, "
        "BOOL_OR(event_kind = 'parent_observed') AS has_parent, "
        "MAX(CASE WHEN event_kind = 'worker_result' THEN execution_status END) AS w_status, "
        "MAX(CASE WHEN event_kind = 'worker_result' THEN reason_code END) AS w_reason, "
        "BOOL_OR(CASE WHEN event_kind = 'worker_result' THEN ledger_enforced END) AS w_enforced, "
        "MAX(CASE WHEN event_kind = 'worker_result' THEN candidates_seen END) AS w_seen, "
        "MAX(CASE WHEN event_kind = 'worker_result' THEN candidates_accounted END) AS w_acct, "
        "MAX(CASE WHEN event_kind = 'worker_result' THEN worker_reported_findings_count END) AS w_findings, "
        "MAX(CASE WHEN event_kind = 'parent_observed' THEN execution_status END) AS p_status, "
        "MAX(CASE WHEN event_kind = 'parent_observed' THEN reason_code END) AS p_reason, "
        "BOOL_OR(CASE WHEN event_kind = 'parent_observed' THEN result_valid END) AS p_valid, "
        "MAX(CASE WHEN event_kind = 'parent_observed' THEN candidates_seen END) AS p_seen, "
        "MAX(CASE WHEN event_kind = 'parent_observed' THEN candidates_accounted END) AS p_acct, "
        "MAX(CASE WHEN event_kind = 'parent_observed' THEN worker_reported_findings_count END) AS p_findings "
        "FROM skill_quality.worker_candidate_quality "
        "WHERE recorded_at > (extract(epoch FROM now()) - %s) "
        "GROUP BY attempt_id, domain, worker_type, component "
        "ORDER BY last_at DESC, attempt_id DESC "
        "LIMIT %s",
        (window_s, limit + 1),
    )
