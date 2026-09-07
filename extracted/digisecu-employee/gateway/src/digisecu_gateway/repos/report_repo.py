"""리포트 스레드 **상세** + 파이프라인 상태 (read-only).

`workspace_repo.list_reports`(목록)는 건드리지 않는다 — `/reports` 와 티켓 상세가 이미 쓰고
있어서 갈아엎으면 두 화면이 같이 깨진다. 여기는 별도 표현이다.

## 경계

- **이 라우트는 본문을 반환하지 않는다** — 보유 여부·크기만 낸다
  (`ReportBodyMeta.redaction="pre_egress"` 가 저장값이 egress redact 이전임을 계약에 박는다).
  ⚠️ 2026-08-25 부터 본문 자체는 **별도 라우트**가 낸다:
  `GET /gw/reports/{key}/{thread_id}/body` → `mail_body_repo`. 거기서 읽기 시점에
  `masking.redact()` 를 다시 걸어 내보내므로 화면 값은 실제 나간 메일보다 **더** 가려져 있다.
  두 라우트를 나눈 이유는 이 상세가 목록·타임라인에서 자주 불려서 — 본문(수십 KB)을
  기본 응답에 실으면 안 쓰는 화면까지 무거워진다.
- 되묻기 키는 `srcKey`. `src` 는 표시용 마스킹 라벨이라 필터로 쓰면 남의 것이 섞인다.
- 없는 컬럼은 `report_col()` 이 타입 지정 NULL alias 로 돌려준다 — catch-무시로 도메인 하나가
  조용히 빠지는 걸 막는 기존 규율 그대로.
"""
from __future__ import annotations

import time

from ..db import ReadOnlyPool
from ..domains import (
    DOMAIN_TABLES, REPORT_BODY_ACCESS, REPORT_TABLES, component_domain, report_col,
)
from ..masking import redact
from ..models import (
    PipelineComponentRun,
    PipelineOverview,
    ReportBodyMeta,
    ReportDomainRef,
    ReportThreadDetail,
    group_for,
    stage_for,
)
from . import finding_repo, source_repo
from .workspace_repo import _cap, _cycle_keys, _delivery_target, _finding_count

#: 본문 크기만 재고 원문은 안 가져온다 — 큰 HTML 을 게이트웨이 메모리에 올릴 이유가 없다.
_BODY_LEN_SQL = "length({expr})"


def _detail_sql(domain: str) -> str:
    dt = DOMAIN_TABLES[domain]
    table = dt.report_thread_table
    assert table in REPORT_TABLES, f"허용되지 않은 리포트 테이블: {table}"
    label = dt.report_label_col
    html = report_col(table, "report_html", "text")
    js = report_col(table, "report_json", "text")
    return (
        f"SELECT t.id, t.status, t.severity, t.subject_tag, t.{label} AS label, "
        f"t.finding_id, fl.summary AS finding_summary, t.recipient, "
        f"{report_col(table, 'owner_recipient', 'text')} AS owner_recipient, "
        f"{report_col(table, 'finding_ids', 'text')} AS finding_ids, "
        f"{report_col(table, 'notified_at', 'double precision')} AS notified_at, "
        f"t.created_at, t.updated_at, t.first_reported_at, t.attempt_count, "
        f"t.cycle_keys, t.first_cycle_key, t.last_cycle_key, t.last_reason, "
        f"{report_col(table, 'recurrence_count', 'integer')} AS recurrence_count, "
        f"{report_col(table, 'last_error_kind', 'text')} AS last_error_kind, "
        # 본문은 길이만 — 원문은 응답에 넣지 않는다.
        f"{_BODY_LEN_SQL.format(expr=html)} AS html_bytes, "
        f"({js} IS NOT NULL AND {js} <> '' AND {js} <> '{{}}') AS has_json, "
        # 도메인 고유 좌표
        f"{report_col(table, 'share_id', 'bigint')} AS share_id, "
        f"{report_col(table, 'repo', 'text')} AS repo, "
        f"{report_col(table, 'space_key', 'text')} AS space_key, "
        f"{report_col(table, 'target_id', 'bigint')} AS target_id, "
        f"{report_col(table, 'url', 'text')} AS url "
        f"FROM {table} t "
        f"LEFT JOIN finding_lifecycle fl ON fl.id = t.finding_id "
        f"WHERE t.id = %s"
    )


def get_report(
    pool: ReadOnlyPool, domain: str, thread_id: int,
) -> ReportThreadDetail | None:
    """리포트 스레드 1건 상세. 없으면 None(라우트가 404 로 바꾼다)."""
    rows = pool.fetch_all(_detail_sql(domain), [int(thread_id)])
    if not rows:
        return None
    r = rows[0]

    owner = finding_repo._owner_email(r.get("owner_recipient"))
    if finding_repo._is_dssoc_email(owner):
        owner = None  # 발송대상이지 담당자가 아니다

    raw_label = str(r.get("label") or "")
    native = str(r.get("status") or "")
    html_bytes = r.get("html_bytes")
    return ReportThreadDetail(
        domain=domain,
        id=int(r["id"]),
        stage=stage_for(domain, native),
        nativeStatus=native,
        severity=r.get("severity"),
        subjectTag=redact(r.get("subject_tag")) or "",
        src=redact(raw_label) or None,
        # ★ srcKey 는 **마스킹 전 원문**으로 만든다 — 마스킹 후로 만들면 서로 다른 대상이
        #   같은 키로 접힌다(dev_web 35개가 라벨 하나로 접히는 그 문제).
        srcKey=source_repo.src_key(domain, raw_label or None),
        findingId=(int(r["finding_id"]) if r.get("finding_id") is not None else None),
        findingCount=_finding_count(r.get("finding_id"), r.get("finding_ids")),
        findingSummary=redact(r.get("finding_summary")),
        recipient=None,  # raw recipient 미노출 — deliveryTarget 고정라벨로만
        ownerRecipient=owner,
        deliveryTarget=_delivery_target(r.get("recipient"), r.get("owner_recipient")),
        createdAt=_f(r.get("created_at")),
        updatedAt=_f(r.get("updated_at")),
        firstReportedAt=_f(r.get("first_reported_at")),
        notifiedAt=_f(r.get("notified_at")),
        attemptCount=(int(r["attempt_count"]) if r.get("attempt_count") is not None else None),
        cycleKeys=_cycle_keys(r.get("cycle_keys")),
        firstCycleKey=_cycle_one(r.get("first_cycle_key")),
        lastCycleKey=_cycle_one(r.get("last_cycle_key")),
        lastReason=_cap(redact(r.get("last_reason"))),
        recurrenceCount=(
            int(r["recurrence_count"]) if r.get("recurrence_count") is not None else None),
        lastErrorKind=_cap(redact(r.get("last_error_kind"))),
        body=ReportBodyMeta(
            # ★ smb 는 본문이 mail_message 에 있고 그 테이블이 GRANT 밖이다 — hasHtml=False 는
            #   "본문 없음" 이 아니라 "못 읽음" 이다. access 가 그 둘을 가른다.
            access=REPORT_BODY_ACCESS.get(domain, "unavailable"),
            hasHtml=bool(html_bytes),
            hasJson=bool(r.get("has_json")),
            htmlBytes=(int(html_bytes) if html_bytes is not None else None),
            redaction="pre_egress",
        ),
        domainRef=ReportDomainRef(
            shareId=(int(r["share_id"]) if r.get("share_id") is not None else None),
            host=(redact(raw_label) if domain == "smb" else None),
            repo=redact(r.get("repo")),
            spaceKey=redact(r.get("space_key")),
            targetId=(int(r["target_id"]) if r.get("target_id") is not None else None),
            url=redact(r.get("url")),
        ),
    )


def pipeline_overview(pool: ReadOnlyPool, domain: str) -> PipelineOverview:
    """단계별 적체 + 구성요소 마지막 실행.

    ★ `sinceLastRunSeconds` 가 이 함수의 존재 이유다. 보고·재확인 파이프라인이 6주 넘게 멈춰 있어도
      지금은 화면 어디에도 안 나온다(실측: `github.report` 최종 2026-07-10).
    """
    dt = DOMAIN_TABLES[domain]
    table = dt.report_thread_table
    assert table in REPORT_TABLES, f"허용되지 않은 리포트 테이블: {table}"

    rows = pool.fetch_all(f"SELECT t.status, COUNT(*) AS n FROM {table} t GROUP BY t.status", [])
    stage_counts: dict[str, int] = {}
    total = 0
    for r in rows:
        n = int(r["n"])
        total += n
        st = stage_for(domain, r.get("status"))
        stage_counts[st] = stage_counts.get(st, 0) + n

    # pipeline_run 은 도메인 컬럼이 없다 — component 이름으로 가른다(domains.component_domain).
    runs = pool.fetch_all(
        "SELECT component, MAX(started_at) AS last_started, MAX(finished_at) AS last_finished, "
        "COUNT(*) AS n FROM pipeline_run GROUP BY component", [],
    )
    now = time.time()
    components: list[PipelineComponentRun] = []
    for r in runs:
        comp = str(r.get("component") or "")
        if component_domain(comp) != domain:
            continue
        started = _f(r.get("last_started"))
        components.append(PipelineComponentRun(
            component=comp,
            lastRunAt=started,
            lastFinishedAt=_f(r.get("last_finished")),
            lastStatus=_last_status(pool, comp),
            runCount=int(r["n"]),
            sinceLastRunSeconds=(round(now - started, 1) if started is not None else None),
        ))
    # 오래 멈춘 것이 위로 — 한 번도 안 돈 것(None)이 최상단이다.
    components.sort(
        key=lambda c: (c.sinceLastRunSeconds is None, c.sinceLastRunSeconds or 0), reverse=True)
    group_counts: dict[str, int] = {}
    for st, n in stage_counts.items():
        g = group_for(st)
        group_counts[g] = group_counts.get(g, 0) + n
    return PipelineOverview(
        domain=domain, stageCounts=stage_counts, groupCounts=group_counts,
        components=components, threadTotal=total,
    )


def _last_status(pool: ReadOnlyPool, component: str) -> str | None:
    rows = pool.fetch_all(
        "SELECT status FROM pipeline_run WHERE component = %s "
        "ORDER BY started_at DESC NULLS LAST LIMIT 1", [component],
    )
    return (str(rows[0]["status"]) if rows and rows[0].get("status") else None)


def _f(value: object) -> float | None:
    return float(value) if value is not None else None  # type: ignore[arg-type]


def _cycle_one(value: object) -> str | None:
    """단일 주차 키 — 형태 밖 문자열은 버린다(`_cycle_keys` 와 같은 규칙)."""
    keys = _cycle_keys([value] if value is not None else None)
    return keys[0] if keys else None
