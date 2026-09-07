"""라이브 threat_hunter 계약 검증 — read-only 강제 + 스키마 드리프트(codex #3).

SECU_AGENT_PG_DSN 미설정 시 skip(CI에 라이브 DB 없을 때). 실행 시:
  set -a; . ~/project/secu-agent/.env; set +a; GATEWAY_TOKEN=test pytest gateway/tests/test_live_contract.py
전부 read-only SELECT/LIMIT 0 — 어떤 write/DDL도 발생하지 않는다.
"""
import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("SECU_AGENT_PG_DSN"),
    reason="라이브 threat_hunter DSN(SECU_AGENT_PG_DSN) 필요",
)


@pytest.fixture()
def pool():
    os.environ.setdefault("GATEWAY_TOKEN", "test")
    from digisecu_gateway.config import Config
    from digisecu_gateway.db import ReadOnlyPool

    p = ReadOnlyPool(Config.load())
    p.open()
    yield p
    p.close()


def test_readonly_blocks_write(pool):
    """세션 read-only(layer2) — write/DDL은 25006 ReadOnlySqlTransaction."""
    import psycopg

    with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
        with pool._pool.connection() as c:
            c.execute("CREATE TEMP TABLE _gw_probe(x int)")


def test_ping(pool):
    assert pool.ping() is True


def test_three_axes(pool):
    """3축 조회가 실데이터에서 예외 없이 동작."""
    from digisecu_gateway.domains import DOMAINS
    from digisecu_gateway.repos import finding_repo, queue_repo, workspace_repo

    fl = finding_repo.list_findings(pool, limit=3)
    assert fl.total >= 0 and len(fl.items) <= 3
    for d in DOMAINS:
        qd = queue_repo.queue_depth(pool, d)
        assert qd.task >= 0 and qd.report >= 0 and qd.verify >= 0
    wp = workspace_repo.workspace_payload(pool, "smb")
    assert wp.key == "smb"


def test_schema_contract_no_drift(pool):
    """게이트웨이 SELECT의 컬럼이 라이브 스키마와 일치(LIMIT 0). 스킬이 스키마를 바꾸면 여기서 실패."""
    from digisecu_gateway.domains import DOMAIN_TABLES
    from digisecu_gateway.repos.finding_repo import _COLS

    # finding projection 컬럼 존재 확인
    pool.fetch_all(f"SELECT {_COLS} FROM finding_lifecycle LIMIT 0")
    # 각 도메인 큐/스레드 테이블의 status·라벨·finding_id·updated_at 컬럼 존재 확인
    for dt in DOMAIN_TABLES.values():
        pool.fetch_all(f"SELECT status FROM {dt.queue_table} LIMIT 0")
        pool.fetch_all(
            f"SELECT id, status, severity, subject_tag, {dt.report_label_col} AS label, "
            f"finding_id, updated_at FROM {dt.report_thread_table} LIMIT 0"
        )


def test_status_vocab_no_contradiction(pool):
    """종결 status와 verify status가 겹치지 않는다(겹치면 이중분류 버그). 미분류는 안전방향(대기)이라 로그만."""
    from digisecu_gateway.domains import (
        DOMAIN_TABLES,
        REPORT_THREAD_TERMINAL,
        VERIFY_STAGE_STATUS,
    )

    assert set(REPORT_THREAD_TERMINAL) & set(VERIFY_STAGE_STATUS) == set(), "종결∩verify 중첩 = 이중분류"
    # 실측 리포트 스레드 status를 분류 커버리지와 대조(미분류는 report-대기로 안전 집계 → 정보성).
    classified = set(REPORT_THREAD_TERMINAL) | set(VERIFY_STAGE_STATUS)
    unclassified: set[str] = set()
    for dt in DOMAIN_TABLES.values():
        rows = pool.fetch_all(f"SELECT DISTINCT status FROM {dt.report_thread_table}")
        for r in rows:
            s = r["status"]
            if s not in classified:
                unclassified.add(f"{dt.report_thread_table}:{s}")
    # 미분류 status는 자동으로 report-대기에 잡혀 undercount는 없음(안전). 존재 시 드리프트 신호로 노출.
    print(f"[status-vocab] 미분류(→report-대기로 안전집계): {sorted(unclassified) or '없음'}")


def test_strategy_collect_backlog(pool):
    """수집(strategy) 스테이지 실집계 — smb/dev_web은 소스 대기>=0, 롤링수집(github/confluence)=0."""
    from digisecu_gateway.repos import queue_repo

    assert queue_repo.queue_depth(pool, "smb").strategy >= 0
    assert queue_repo.queue_depth(pool, "dev_web").strategy >= 0
    assert queue_repo.queue_depth(pool, "github").strategy == 0
    assert queue_repo.queue_depth(pool, "confluence").strategy == 0


def test_performance_real_aggregate(pool):
    """성과 대시보드 실집계 — 퍼널(severity)·주간추이(유입/처리) 구조·합 정합."""
    from digisecu_gateway.repos import workspace_repo

    perf = workspace_repo.workspace_payload(pool, "smb").performance
    assert len(perf.funnel) >= 1 and all(f.value >= 0 for f in perf.funnel)
    assert all(w.inflow >= 0 and w.resolved >= 0 for w in perf.weekly)
    assert len(perf.kpis) >= 1


def test_github_includes_jenkins(pool):
    """github 도메인 finding 카운트가 jenkins task_type를 포함(1:1 가정의 은닉 방지)."""
    from digisecu_gateway.repos import finding_repo

    gh_only = finding_repo.list_findings(pool, task_types=("github",), limit=1).total
    gh_jenkins = finding_repo.list_findings(pool, task_types=("github", "jenkins"), limit=1).total
    assert gh_jenkins >= gh_only  # jenkins 포함이 더 많거나 같아야(은닉 없음)


def test_finding_projection_excludes_raw(pool):
    """마스킹 seal 보존 — 게이트웨이 finding에 원문 컬럼(extra_json)·evidence 경로가 없다."""
    from digisecu_gateway.repos import finding_repo

    fl = finding_repo.list_findings(pool, limit=1)
    if fl.items:
        dumped = fl.items[0].model_dump()
        assert "extra_json" not in dumped
        assert "evidence_ref" not in dumped
        assert "hasEvidence" in dumped  # 존재 여부만(불투명)
