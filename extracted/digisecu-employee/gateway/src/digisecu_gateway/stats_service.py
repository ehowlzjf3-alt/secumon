"""개요 집계 서비스 — 4도메인을 1회 호출로 (quality_service·runtime_service 선례).

【왜 서비스 층인가】 화면 하나가 4도메인 payload 를 팬아웃하면 커넥션 32왕복이 된다
(`workspace_payload` 1회가 8왕복 × 4). `pool_max=4` 라 그 사이 다른 요청이 굶는다.
여기서는 finding_lifecycle **1스캔** + 스레드 union 1회 + 큐 1회 + 재검증 1회로 끝낸다.

【숫자가 거짓말하지 않게 하는 규칙 셋】
1. **`weekly.resolved` 를 쓰지 않는다.** 기존 `performance()` 의 정의(`status NOT IN (open,triaged)`)는
   사실상 false_positive 만 세는데(5,462건 중 github 5,460) 그걸 "처리 건수" 로 렌더하면 거짓말이다.
   여기서는 유입만 내고, 조치는 아래 재검증 근거로 따로 센다.
2. **조치 완료의 근거를 밝힌다.** 도메인마다 다르다 — github/confluence 는 재스캔에서 사라진 것
   (`verification.status='gone'`), smb 는 재검증 판정(`mail_reverify_result.verdict='now_closed'`).
   `remediationBasis` 로 무엇을 셌는지 같이 낸다.
3. **못 읽은 것과 0건을 구분한다.** 재검증 테이블·asset_owner 는 sql/004 를 돌려야 읽힌다.
   권한이 없으면 `remediationLookup="denied"` 로 내보내고, 0 으로 위장하지 않는다.
"""
from __future__ import annotations

from .db import ReadOnlyPool
from .domains import (
    DOMAINS,
    REPORT_THREAD_TERMINAL,
    VERIFY_STAGE_STATUS,
    all_domain_task_types,
    domain_case_sql,
    report_union_sql,
    src_case_sql,
    DELIVERY_EVIDENCE_TIMESTAMP,
    delivery_evidence,
)
from .models import CategoryCount, DomainStats, GatewayStats, StatsTotals, WeeklyPoint
from .repos import finding_repo, queue_repo, source_repo
from . import taxonomy

# 주차 키 형식 — smb cycle_key·finding_repo.list_weeks 와 같아야 두 화면의 "W34" 가 같은 집합이다.
_WEEK_FMT = 'IYYY-"W"IW'
_WEEKLY_LIMIT = 12

# 대기 중인 통보(회신 대기) — domains.VERIFY_STAGE_STATUS 와 겹치지 않는 "보냈고 답을 기다림" 단계.
_AWAITING = ("awaiting_reply", "awaiting_owner")

# 재검증 판정 중 "닫혔다" 로 보는 값(실측 vocab). partially_closed 는 조치 완료가 아니다.
_REVERIFY_CLOSED = ("now_closed",)

# 도메인별 재검증 결과 테이블. 없거나 권한이 없으면 denied 로 떨어진다.
_REVERIFY_TABLE = {
    "smb": "mail_reverify_result",
    "github": "github_recheck_result",
    "confluence": "confluence_recheck_result",
    "dev_web": "dev_web_recheck_result",
}
# github/confluence 는 재스캔이 "HEAD 에서 사라졌다" 를 finding 에 직접 기록한다 — 재검증 테이블보다
# 이쪽이 1차 근거다(실측: github gone 40건 vs github_recheck_result 1행).
_GONE_BASIS_DOMAINS = ("github", "confluence")


def _server_epoch(pool: ReadOnlyPool) -> float:
    row = pool.fetch_one("SELECT extract(epoch FROM now()) AS now")
    return float(row["now"]) if row and row.get("now") is not None else 0.0


def _current_week(pool: ReadOnlyPool) -> str:
    row = pool.fetch_one(f"SELECT to_char(now(), '{_WEEK_FMT}') AS wk")
    return str(row["wk"]) if row and row.get("wk") else ""


def _finding_stats(pool: ReadOnlyPool, week: str) -> dict[str, dict]:
    """도메인별 finding 집계 — 1스캔. src 종수까지 여기서 같이 센다."""
    tts = all_domain_task_types()
    ph = ", ".join(["%s"] * len(tts))
    open_ph = ", ".join(["%s"] * len(finding_repo._OPEN_STATUSES))
    sql = f"""
WITH b AS (
  SELECT {domain_case_sql()} AS domain, {src_case_sql()} AS src,
         severity, status, first_seen, last_seen,
         to_char(to_timestamp(first_seen), '{_WEEK_FMT}') AS wk,
         to_char(to_timestamp(last_seen), '{_WEEK_FMT}') AS seen_wk,
         -- ⚠️ LIKE 프리필터가 먼저다. `IS JSON` 은 컬럼 전체를 파싱하므로 20,648행에 그냥 걸면
         -- 355ms 인데, 값싼 부분문자열로 후보를 걸러내면 138ms 다(실측). 정확성은 뒤의
         -- jsonb 검사가 보장하고 LIKE 는 순수 프리필터다 — 오탐이 나도 결과는 같다.
         -- 리터럴 퍼센트는 두 번 써야 한다(파라미터 쿼리라 psycopg 가 플레이스홀더로 읽는다).
         (extra_json LIKE '%%gone%%'
          AND extra_json IS JSON
          AND (extra_json::jsonb) -> 'verification' ->> 'status' = 'gone') AS gone
  FROM finding_lifecycle
  WHERE task_type IN ({ph})
)
SELECT domain,
       COUNT(*) AS findings,
       COUNT(DISTINCT src) AS sources,
       COUNT(*) FILTER (WHERE src IS NULL) AS unparsed,
       COUNT(*) FILTER (WHERE status IN ({open_ph})) AS open_findings,
       COUNT(*) FILTER (WHERE status = 'false_positive') AS false_positive,
       COUNT(*) FILTER (WHERE lower(severity) = 'critical') AS critical,
       COUNT(*) FILTER (WHERE lower(severity) = 'high') AS high,
       COUNT(*) FILTER (WHERE wk = %s) AS week_new,
       COUNT(*) FILTER (WHERE gone) AS gone_total,
       COUNT(*) FILTER (WHERE gone AND seen_wk = %s) AS gone_week
FROM b WHERE domain IS NOT NULL GROUP BY domain
"""
    rows = pool.fetch_all(sql, [*tts, *finding_repo._OPEN_STATUSES, week, week])
    return {str(r["domain"]): r for r in rows}


def _thread_stats(pool: ReadOnlyPool) -> dict[str, dict]:
    """도메인별 리포트 스레드 집계 — union 1회. 통보된 대상 종수도 여기서 나온다."""
    aw = ", ".join(["%s"] * len(_AWAITING))
    term = ", ".join(["%s"] * len(REPORT_THREAD_TERMINAL))
    ver = ", ".join(["%s"] * len(VERIFY_STAGE_STATUS))
    sql = f"""
WITH th AS ({report_union_sql()})
SELECT domain,
       COUNT(*) AS threads,
       COUNT(DISTINCT src) FILTER (WHERE src IS NOT NULL AND src <> '') AS sources_with_thread,
       -- 발송이 **사실로** 확인된 대상. notified_at 은 github/confluence 만 보유하므로
       -- 나머지 도메인은 구조적으로 0 이 나온다 — 그 0 을 "안 나갔다" 로 읽으면 안 되고,
       -- 아래 delivery_evidence 로 갈라 None 으로 내린다.
       COUNT(DISTINCT src) FILTER (
         WHERE src IS NOT NULL AND src <> '' AND notified_at IS NOT NULL
       ) AS sources_delivered,
       COUNT(*) FILTER (WHERE status IN ({aw})) AS awaiting,
       COUNT(*) FILTER (WHERE status IN ({term})) AS closed_threads,
       COUNT(*) FILTER (WHERE status IN ({ver})) AS verifying,
       -- ★ **대상(src) 단위** 집계. 콘솔의 "티켓" 은 대상 1건 = 티켓 1건이고
       --   (`/gw/sources` total=250), 스레드는 그 대상에 달린 메일 실이다(148).
       --   둘은 1:1 이 아니다 — dev_web 은 대상 34 에 스레드 101, github 은 대상 177 에
       --   스레드 3 이다. 스레드 수를 "티켓 수" 로 그리면 목록 화면과 숫자가 어긋난다.
       COUNT(DISTINCT src) FILTER (
         WHERE src IS NOT NULL AND src <> '' AND status IN ({aw})
       ) AS sources_awaiting,
       COUNT(DISTINCT src) FILTER (
         WHERE src IS NOT NULL AND src <> '' AND status IN ({term})
       ) AS sources_closed
FROM th GROUP BY domain
"""
    # ⚠️ 자리표시자 순서 = SQL 등장 순서다. 아래 두 그룹(sources_awaiting/sources_closed)이
    #    같은 어휘를 **다시** 쓰므로 파라미터도 다시 실어야 한다. 2026-08-29 에 여기를
    #    빠뜨려 "22 placeholders but 14 parameters" 로 /gw/stats 가 500 을 냈다 —
    #    게이트웨이 스위트 284건은 이 쿼리를 실 DB 로 안 돌려서 그대로 통과했다.
    rows = pool.fetch_all(sql, [
        *_AWAITING, *REPORT_THREAD_TERMINAL, *VERIFY_STAGE_STATUS,
        *_AWAITING, *REPORT_THREAD_TERMINAL,
    ])
    return {str(r["domain"]): r for r in rows}


def _reverify_stats(pool: ReadOnlyPool, domain: str, week: str) -> tuple[int, int, bool]:
    """(누적 조치완료, 이번주 조치완료, 읽을 수 있었는가).

    finding 단위로 센다 — 같은 finding 이 여러 번 재검증될 수 있어 DISTINCT 가 필요하다.
    """
    table = _REVERIFY_TABLE.get(domain)
    if not table:
        return 0, 0, False
    ph = ", ".join(["%s"] * len(_REVERIFY_CLOSED))
    try:
        row = pool.fetch_one(
            f"SELECT COUNT(DISTINCT finding_id) AS n, "
            f"COUNT(DISTINCT finding_id) FILTER "
            f"(WHERE to_char(to_timestamp(created_at), '{_WEEK_FMT}') = %s) AS wk_n "
            f"FROM {table} WHERE verdict IN ({ph})",
            [week, *_REVERIFY_CLOSED],
        )
    except Exception:  # noqa: BLE001 — 권한 없음/테이블 없음. 0 으로 위장하지 않고 denied 로 낸다.
        return 0, 0, False
    if not row:
        return 0, 0, True
    return int(row["n"] or 0), int(row["wk_n"] or 0), True


def _weekly(pool: ReadOnlyPool) -> list[WeeklyPoint]:
    """주차별 신규 발견(first_seen 기준).

    ⚠️ resolved 는 0 으로 둔다 — 이 축에는 신뢰할 수 있는 '처리' 정의가 없다(모듈 주석 1번).
    화면은 유입만 그린다.
    """
    tts = all_domain_task_types()
    ph = ", ".join(["%s"] * len(tts))
    rows = pool.fetch_all(
        f"SELECT to_char(to_timestamp(first_seen), '{_WEEK_FMT}') AS wk, COUNT(*) AS n "
        f"FROM finding_lifecycle WHERE task_type IN ({ph}) "
        f"GROUP BY wk ORDER BY wk DESC LIMIT {_WEEKLY_LIMIT}",
        list(tts),
    )
    return [WeeklyPoint(week=str(r["wk"]), inflow=int(r["n"]), resolved=0) for r in reversed(rows)]


def _categories(pool: ReadOnlyPool) -> list[CategoryCount]:
    """데이터 분류 분포 — **단일 쿼리**.

    기존 `finding_repo.category_counts` 는 taxonomy 8키 × jsonb COUNT 를 순차 실행한다(도메인까지
    돌면 32스캔). 여기서는 hits[].category ∪ hit_categories 를 한 번에 펼쳐 센다.
    ⚠️ finding 하나가 여러 분류를 가질 수 있어 **합계 ≠ 총계**다(중복 계수).
    """
    tts = all_domain_task_types()
    ph = ", ".join(["%s"] * len(tts))
    # MATERIALIZED 로 **한 번만 파싱**한다 — 인라인되면 같은 행에서 extra_json 을 세 번(IS JSON +
    # 캐스트 2회) 파싱해 667ms 가 걸린다. 한 번으로 묶으면 484ms(실측).
    rows = pool.fetch_all(
        f"WITH j AS MATERIALIZED ( "
        f"  SELECT id, extra_json::jsonb AS ej FROM finding_lifecycle "
        f"  WHERE extra_json IS JSON AND task_type IN ({ph}) "
        f") "
        f"SELECT x.k AS cat, COUNT(DISTINCT j.id) AS n "
        f"FROM j, LATERAL ( "
        f"  SELECT jsonb_array_elements_text( "
        f"    COALESCE(jsonb_path_query_array(j.ej, '$.hits[*].category'), '[]'::jsonb) "
        f"    || COALESCE(j.ej -> 'hit_categories', '[]'::jsonb)) AS k "
        f") x "
        f"GROUP BY x.k",
        list(tts),
    )
    # canon(secret→credential 병합) 후 합산 — 병합 전 키로 두면 같은 분류가 두 줄로 갈린다.
    merged: dict[str, int] = {}
    for r in rows:
        key = taxonomy.canon_param(str(r["cat"]))
        if key is None:
            continue
        merged[key] = merged.get(key, 0) + int(r["n"])
    labels = taxonomy.labels()
    out = [CategoryCount(key=k, label=labels.get(k, k), count=v) for k, v in merged.items()]
    out.sort(key=lambda c: (-c.count, c.key))
    return out


def stats(pool: ReadOnlyPool) -> GatewayStats:
    as_of = _server_epoch(pool)
    week = _current_week(pool)
    f_by_dom = _finding_stats(pool, week)
    t_by_dom = _thread_stats(pool)
    depth = {q.agentType: q for q in queue_repo.queue_depth_all(pool).items}
    owner_ok = source_repo._asset_owner_readable(pool)

    domains: list[DomainStats] = []
    for d in DOMAINS:
        f = f_by_dom.get(d, {})
        t = t_by_dom.get(d, {})
        sources = int(f.get("sources") or 0)
        unparsed = int(f.get("unparsed") or 0)
        # 파싱 실패분은 "미상" 대상 1개로 센다 — 버리면 총계가 조용히 줄어든다.
        if unparsed:
            sources += 1
        with_thread = int(t.get("sources_with_thread") or 0)
        evidence = delivery_evidence(d)
        # ★ 근거가 없는 도메인은 None. 0 으로 내리면 "한 통도 안 나갔다" 는 거짓 주장이 된다.
        delivered = (
            int(t.get("sources_delivered") or 0)
            if evidence == DELIVERY_EVIDENCE_TIMESTAMP
            else None
        )

        rv_total, rv_week, rv_ok = _reverify_stats(pool, d, week)
        if d in _GONE_BASIS_DOMAINS:
            remediated, week_rem = int(f.get("gone_total") or 0), int(f.get("gone_week") or 0)
            basis, lookup = "verification_gone", "ok"
        elif rv_ok and rv_total:
            remediated, week_rem = rv_total, rv_week
            basis, lookup = "reverify_now_closed", "ok"
        else:
            remediated, week_rem = 0, 0
            basis = "reverify_now_closed" if rv_ok else "none"
            lookup = "ok" if rv_ok else "denied"

        q = depth.get(d)
        waiting = (q.strategy + q.task + q.report + q.verify) if q else 0

        domains.append(DomainStats(
            domain=d,
            sources=sources,
            unparsedFindings=unparsed,
            findings=int(f.get("findings") or 0),
            openFindings=int(f.get("open_findings") or 0),
            falsePositive=int(f.get("false_positive") or 0),
            critical=int(f.get("critical") or 0),
            high=int(f.get("high") or 0),
            weekNew=int(f.get("week_new") or 0),
            weekRemediated=week_rem,
            remediated=remediated,
            remediationBasis=basis,
            remediationLookup=lookup,
            threads=int(t.get("threads") or 0),
            # 예전 이름은 notifiedSources 였는데 세는 것은 "스레드가 하나라도 있는 대상" 이다.
            # 통보 여부가 아니라 스레드 존재 여부라 이름이 거짓말이었다.
            sourcesWithThread=min(with_thread, sources),
            # 스레드가 finding 대상보다 많을 수 있다(스레드는 있는데 finding 이 정리된 경우) —
            # 음수가 나오지 않게 바닥을 0 으로 둔다.
            sourcesWithoutThread=max(sources - with_thread, 0),
            sourcesDelivered=(min(delivered, sources) if delivered is not None else None),
            deliveryEvidence=evidence,
            awaitingThreads=int(t.get("awaiting") or 0),
            closedThreads=int(t.get("closed_threads") or 0),
            # 대상 단위 — 화면의 "티켓" 축은 이쪽이다. 스레드 수는 모수가 다르다.
            # ⚠️ min(…, sources): 스레드 union 의 src 종수가 finding 쪽 대상 수보다 많을
            #    수 있다(모델 주석의 "모수 차이"). 분자가 분모를 넘으면 처리율이 100% 를 넘는다.
            sourcesAwaiting=min(int(t.get("sources_awaiting") or 0), sources),
            sourcesClosed=min(int(t.get("sources_closed") or 0), sources),
            queueWaiting=waiting,
        ))

    totals = StatsTotals(
        findings=sum(d.findings for d in domains),
        sources=sum(d.sources for d in domains),
        openFindings=sum(d.openFindings for d in domains),
        falsePositive=sum(d.falsePositive for d in domains),
        threads=sum(d.threads for d in domains),
        weekNew=sum(d.weekNew for d in domains),
        weekRemediated=sum(d.weekRemediated for d in domains),
        remediated=sum(d.remediated for d in domains),
        sourcesWithoutThread=sum(d.sourcesWithoutThread for d in domains),
        awaitingThreads=sum(d.awaitingThreads for d in domains),
        sourcesAwaiting=sum(d.sourcesAwaiting for d in domains),
        sourcesClosed=sum(d.sourcesClosed for d in domains),
    )
    return GatewayStats(
        asOf=as_of, week=week, totals=totals, domains=domains,
        weekly=_weekly(pool), categories=_categories(pool),
        ownerLookup="ok" if owner_ok else "denied",
    )
