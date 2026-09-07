"""업무/큐 축 — (agentType=domain) 실행 큐 대기 깊이.

대기 = **비종결(종결 status의 여집합)**. 손나열 allowlist는 새 status를 놓쳐 과소집계하므로 지양.
- task = 도메인 타깃/셰어에서 종결(queue_terminal) 아닌 건수
- report = 리포트 스레드에서 종결도 verify도 아닌 건수
- verify = 리포트 스레드에서 재검증 단계(VERIFY_STAGE_STATUS) 건수
UI strategy(수집)는 엔진 TaskPlan 부재 → 미제공. 테이블명은 DOMAIN_TABLES 화이트리스트에서만.
"""
from __future__ import annotations

from ..db import ReadOnlyPool
from ..domains import (
    DOMAIN_TABLES,
    DOMAINS,
    REPORT_THREAD_TERMINAL,
    VERIFY_STAGE_STATUS,
)
from ..models import QueueDepth, QueueDepthList

_ALLOWED_TABLES = {t.queue_table for t in DOMAIN_TABLES.values()} | {
    t.report_thread_table for t in DOMAIN_TABLES.values()
}


def _count(
    pool: ReadOnlyPool,
    table: str,
    *,
    in_: tuple[str, ...] | None = None,
    not_in: tuple[str, ...] | None = None,
) -> int:
    assert table in _ALLOWED_TABLES, f"허용되지 않은 테이블: {table}"
    where: list[str] = []
    params: list = []
    if not_in:
        ph = ", ".join(["%s"] * len(not_in))
        where.append(f"status NOT IN ({ph})")
        params += list(not_in)
    if in_:
        ph = ", ".join(["%s"] * len(in_))
        where.append(f"status IN ({ph})")
        params += list(in_)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    row = pool.fetch_one(f"SELECT COUNT(*) AS n FROM {table}{clause}", params)
    return int(row["n"]) if row else 0


def count_all(pool: ReadOnlyPool, table: str) -> int:
    assert table in _ALLOWED_TABLES, f"허용되지 않은 테이블: {table}"
    row = pool.fetch_one(f"SELECT COUNT(*) AS n FROM {table}")
    return int(row["n"]) if row else 0


def strategy_count(pool: ReadOnlyPool, domain: str) -> int:
    """수집(collector) 소스 대기. 별도 수집 소스 테이블이 있는 도메인만; 롤링수집(github/confluence)=0.
    (smb: 훑을 subnet 스코프, dev_web: 미완료 web 타깃도메인. 테이블명은 하드코딩 리터럴.)"""
    if domain == "smb":
        row = pool.fetch_one("SELECT COUNT(*) AS n FROM smb_target_subnet WHERE enabled = 1")
    elif domain == "dev_web":
        # 비종결(≠hunted) = pending/in_progress 등 수집 대기.
        row = pool.fetch_one("SELECT COUNT(*) AS n FROM web_target_domain WHERE status <> %s", ["hunted"])
    else:
        return 0  # github/confluence: 수집·점검이 동일 타깃 테이블(롤링) → 별도 수집 큐 없음
    return int(row["n"]) if row else 0


def queue_depth(pool: ReadOnlyPool, domain: str) -> QueueDepth:
    dt = DOMAIN_TABLES[domain]
    return QueueDepth(
        agentType=domain,
        strategy=strategy_count(pool, domain),
        task=_count(pool, dt.queue_table, not_in=dt.queue_terminal),
        report=_count(
            pool, dt.report_thread_table, not_in=REPORT_THREAD_TERMINAL + VERIFY_STAGE_STATUS
        ),
        verify=_count(pool, dt.report_thread_table, in_=VERIFY_STAGE_STATUS),
    )


def queue_depth_all(pool: ReadOnlyPool) -> QueueDepthList:
    return QueueDepthList(items=[queue_depth(pool, d) for d in DOMAINS])


def status_breakdown(
    pool: ReadOnlyPool, domain: str, cycle_key: str | None = None,
) -> list[dict[str, object]]:
    """큐 테이블의 status 분포(+주차). 8767 "파이프라인 흐름" 을 5180 으로 옮긴 것.

    도메인마다 status 어휘가 다르므로(smb_share vs *_target) **손나열하지 않고** 실제 값을
    그대로 낸다 — 새 status 가 생겨도 자동으로 보인다(domains.py 의 '비종결=여집합' 원칙 미러).
    각 status 가 종결인지 여부는 `DOMAIN_TABLES[domain].queue_terminal` 로 표시한다.
    """
    dt = DOMAIN_TABLES[domain]
    table = dt.queue_table
    assert table in _ALLOWED_TABLES, f"허용되지 않은 큐 테이블: {table}"
    where, params = ("", [])
    if cycle_key:
        where, params = " WHERE cycle_key = %s", [cycle_key]
    rows = pool.fetch_all(
        f"SELECT status, COUNT(*) AS n FROM {table}{where} GROUP BY status ORDER BY n DESC",
        params,
    )
    terminal = set(dt.queue_terminal)
    return [
        {
            "status": str(r["status"] or "?"),
            "count": int(r["n"]),
            "terminal": str(r["status"] or "") in terminal,
        }
        for r in rows
    ]


def queue_cycle_keys(pool: ReadOnlyPool, domain: str) -> list[str]:
    """큐 테이블이 다룬 주차 목록(최신순). 4개 도메인 큐 모두 cycle_key 컬럼을 가진다."""
    dt = DOMAIN_TABLES[domain]
    table = dt.queue_table
    assert table in _ALLOWED_TABLES, f"허용되지 않은 큐 테이블: {table}"
    rows = pool.fetch_all(
        f"SELECT DISTINCT cycle_key AS ck FROM {table} "
        "WHERE cycle_key IS NOT NULL AND cycle_key <> '' ORDER BY ck DESC",
        [],
    )
    return [str(r["ck"]) for r in rows]
