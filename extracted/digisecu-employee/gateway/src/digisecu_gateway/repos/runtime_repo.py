"""도메인 런타임 read repo — platform.pipeline_heartbeat / pipeline_run 조회.

codex A2 반영:
- **schema-qualified** 로만 조회(search_path 의존 안 함). platform 스키마 명시.
- 요청별 짧은 read-only 트랜잭션(풀 configure에서 강제) + statement_timeout + **recent-window** + **hard limit**.
- raw detail 은 여기서 반환하되 상위 service 가 redact 후 직렬화한다(이 repo는 SQL 경계).
- pipeline_run 은 72k+ 행 — 반드시 bounded(window/limit)로만 스캔한다.

주의: 이 두 테이블 SELECT 권한은 게이트웨이 RO 롤에 **기본 미부여**다(sql/001). sql/002_runtime_read_grants.sql
을 사용자가 적용해야 조회 가능(prod DDL 게이트). 미적용 시 SELECT 가 42501(권한없음)로 실패한다.
"""
from __future__ import annotations

from typing import Any

from ..db import ReadOnlyPool

# 활동 피드 최근 창(초) — 이보다 오래된 run 은 조회하지 않음. 컴포넌트 열거에도 사용.
RECENT_WINDOW_S = 30 * 24 * 3600  # 30일(파이프라인이 며칠 유휴여도 최근 활동을 보여주려 넉넉히)
_RUN_COUNTER_COLS = "subnets_swept, hosts_found, shares_found, shares_walked, owners_enriched"


def heartbeats_all(pool: ReadOnlyPool) -> list[dict[str, Any]]:
    """모든 컴포넌트 heartbeat(28행 규모) + DB now() 기준 나이(초). presence 소스."""
    return pool.fetch_all(
        "SELECT component, phase, detail, last_beat, "
        "(extract(epoch FROM now()) - last_beat) AS age_seconds "
        "FROM platform.pipeline_heartbeat"
    )


def latest_terminal_run_by_component(pool: ReadOnlyPool) -> list[dict[str, Any]]:
    """컴포넌트별 최신 terminal run(status ok/error) 1건 — health 판정 소스. 최근 창 내로 제한."""
    return pool.fetch_all(
        "SELECT DISTINCT ON (component) component, status, started_at "
        "FROM platform.pipeline_run "
        "WHERE status IN ('ok','error') AND started_at > (extract(epoch FROM now()) - %s) "
        "ORDER BY component, started_at DESC",
        (RECENT_WINDOW_S,),
    )


def recent_run_components(pool: ReadOnlyPool) -> list[str]:
    """최근 창 내 run 을 낸 컴포넌트 목록(heartbeat 없는 컴포넌트도 포착). 도메인 열거용."""
    rows = pool.fetch_all(
        "SELECT DISTINCT component FROM platform.pipeline_run "
        "WHERE started_at > (extract(epoch FROM now()) - %s)",
        (RECENT_WINDOW_S,),
    )
    return [str(r["component"]) for r in rows if r.get("component")]


def recent_runs_for_components(pool: ReadOnlyPool, components: list[str], limit: int) -> list[dict[str, Any]]:
    """지정 컴포넌트들의 최근 run 피드(started_at DESC, hard limit). 빈 목록이면 조회 생략."""
    if not components:
        return []
    return pool.fetch_all(
        "SELECT component, started_at, finished_at, status, detail, "
        f"{_RUN_COUNTER_COLS} "
        "FROM platform.pipeline_run "
        "WHERE component = ANY(%s) AND started_at > (extract(epoch FROM now()) - %s) "
        "ORDER BY started_at DESC "
        "LIMIT %s",
        (list(components), RECENT_WINDOW_S, limit),
    )
