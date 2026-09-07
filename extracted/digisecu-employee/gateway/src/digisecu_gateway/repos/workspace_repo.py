"""워크스페이스 축 — payload만(구조 sectionLayout은 control-plane 소유).

payload = { findings(마스킹), reports(리포트 스레드 진행상태 ⨝ finding 마스킹 summary), kpi }.
finding_id 는 opaque BIGINT(SQL FK 없음) → LEFT JOIN, dangling 시 findingSummary=null.
"""
from __future__ import annotations

import json
import re

from ..db import ReadOnlyPool
from ..domains import (
    DOMAIN_TABLES,
    DOMAIN_TASK_TYPES,
    REPORT_TABLES,
    delivery_evidence,
    is_dssoc,
    report_col,
)
from ..masking import redact
from ..models import (
    FunnelItem,
    GatewayPerformance,
    PerfKpi,
    ReportThreadItem,
    WeeklyPoint,
    WorkspaceKpi,
    WorkspacePayload,
)
from . import finding_repo, queue_repo

# 리포트 테이블별 컬럼 보유 여부는 domains.py 가 SSOT(source_repo 도 같은 것을 쓴다).
# catch-ignore 대신 명시적 per-source projection — 없는 컬럼은 타입 지정 NULL alias.
_REPORT_TABLES = REPORT_TABLES
# 발송대상(고정 라벨) — raw recipient 미노출. dssoc 계열은 담당자 아님.


# 주차 키 형식(smb cycle_key 와 동일) — 형태 밖 문자열은 버린다(UI 주입·잡음 방지).
_CYCLE_KEY_RE = re.compile(r"^\d{4}-W\d{2}$")
_CYCLE_KEYS_MAX = 24  # 스레드 하나가 걸친 주차 상한(2년치) — 무한 배열 방어
_REASON_MAX = 200     # last_reason/last_error_kind 절단(마스킹 **후** 자른다)


# 정의는 `domains.is_dssoc` 하나다. 이 파일은 제 사본과 finding_repo 사본을 **한 파일 안에서
# 섞어 쓰고** 있었다(:54 는 제 것, :119 는 finding_repo 것). 이름만 남긴다.
_is_dssoc = is_dssoc


def _delivery_target(recipient: object, owner_recipient: str | None) -> str | None:
    """발송대상 고정 라벨(raw 미노출). dssoc→'DSSOC', 실 담당자메일→'담당자 개별', 그 외 null."""
    if _is_dssoc(recipient):
        return "DSSOC"
    if owner_recipient and not _is_dssoc(owner_recipient):
        return "담당자 개별"
    if _is_dssoc(owner_recipient):
        return "DSSOC"
    return None


def _finding_count(finding_id: object, finding_ids_raw: object) -> int:
    """finding_id ∪ finding_ids(JSON 배열) 중복제거 수. malformed/스칼라전용/null 방어."""
    ids: set[int] = set()
    if isinstance(finding_id, int):
        ids.add(finding_id)
    if isinstance(finding_ids_raw, str) and finding_ids_raw.strip():
        try:
            arr = json.loads(finding_ids_raw)
        except (ValueError, TypeError):
            arr = None
        if isinstance(arr, list):
            for x in arr:
                if isinstance(x, bool):
                    continue
                if isinstance(x, int):
                    ids.add(x)
                elif isinstance(x, str) and x.isdigit():
                    ids.add(int(x))
    return len(ids) or 1

def _cycle_keys(raw: object) -> list[str]:
    """cycle_keys(JSON 배열 문자열) 방어 파싱 — malformed/스칼라/null 어느 쪽도 500 이 되면 안 된다.

    값은 `2026-W34` 같은 주차 키라 자유텍스트가 아니지만, 저장 형식이 텍스트라 형태 검증을 한 번 더 한다.
    """
    if not isinstance(raw, str) or not raw.strip():
        return []
    try:
        arr = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(arr, list):
        return []
    out: list[str] = []
    for x in arr:
        if isinstance(x, str) and _CYCLE_KEY_RE.match(x) and x not in out:
            out.append(x)
    return out[:_CYCLE_KEYS_MAX]


# 퍼널 severity 순서·라벨.
_SEV_ORDER = ("critical", "high", "medium", "low", "info", "informational")
_SEV_LABEL = {
    "critical": "심각",
    "high": "높음",
    "medium": "중간",
    "low": "낮음",
    "info": "정보",
    "informational": "정보",
}


def _to_report(r: dict, domain: str) -> ReportThreadItem:
    # read 경계 방어 재마스킹: subject_tag/label/finding_summary는 free-text·미봉인 가능.
    # 담당자 이메일 = 검증된 사내 메일박스(dssoc 계열 제외 — 그건 발송대상이지 담당자 아님).
    owner = finding_repo._owner_email(r.get("owner_recipient"))
    if finding_repo._is_dssoc_email(owner):
        owner = None
    return ReportThreadItem(
        id=int(r["id"]),
        status=r["status"],
        severity=r.get("severity"),
        subjectTag=redact(r["subject_tag"]) or "",
        label=redact(str(r.get("label") or "")) or "",
        findingId=(int(r["finding_id"]) if r.get("finding_id") is not None else None),
        findingSummary=redact(r.get("finding_summary")),  # 재마스킹, dangling 시 null
        updatedAt=(float(r["updated_at"]) if r.get("updated_at") is not None else None),
        ownerRecipient=owner,
        deliveryTarget=_delivery_target(r.get("recipient"), r.get("owner_recipient")),
        findingCount=_finding_count(r.get("finding_id"), r.get("finding_ids")),
        notifiedAt=(float(r["notified_at"]) if r.get("notified_at") is not None else None),
        deliveryEvidence=delivery_evidence(domain),
        firstReportedAt=(
            float(r["first_reported_at"]) if r.get("first_reported_at") is not None else None),
        attemptCount=(int(r["attempt_count"]) if r.get("attempt_count") is not None else None),
        cycleKeys=_cycle_keys(r.get("cycle_keys")),
        # last_reason/last_error_kind 는 free-text 가능 — 마스킹 후 절단(순서 뒤집으면 토큰이
        # detector 임계 밑으로 짧아져 누수한다, masking.py 주석 참조).
        lastReason=_cap(redact(r.get("last_reason"))),
        recurrenceCount=(
            int(r["recurrence_count"]) if r.get("recurrence_count") is not None else None),
        lastErrorKind=_cap(redact(r.get("last_error_kind"))),
    )


def _cap(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    return v[:_REASON_MAX] or None


def report_cycle_keys(pool: ReadOnlyPool, domain: str) -> list[str]:
    """이 도메인 리포트 스레드가 다뤄진 주차 목록(최신순).

    8767 도메인 UI 의 주차 선택기를 5180 으로 옮기기 위한 것. 4개 리포트 테이블 모두
    `first_cycle_key`/`last_cycle_key`/`cycle_keys` 를 갖고 있어 도메인 무관하게 동작한다.
    """
    dt = DOMAIN_TABLES[domain]
    table = dt.report_thread_table
    assert table in _REPORT_TABLES, f"허용되지 않은 리포트 테이블: {table}"
    rows = pool.fetch_all(
        f"SELECT DISTINCT last_cycle_key AS ck FROM {table} "
        "WHERE last_cycle_key IS NOT NULL AND last_cycle_key <> '' ORDER BY ck DESC",
        [],
    )
    return [str(r["ck"]) for r in rows]


def report_status_counts(
    pool: ReadOnlyPool, domain: str, cycle_key: str | None = None,
) -> dict[str, int]:
    """주차별 리포트 상태 분포(8767 mail 탭의 status_counts 미러)."""
    dt = DOMAIN_TABLES[domain]
    table = dt.report_thread_table
    assert table in _REPORT_TABLES, f"허용되지 않은 리포트 테이블: {table}"
    where, params = ("", [])
    if cycle_key:
        where, params = " WHERE last_cycle_key = %s", [cycle_key]
    rows = pool.fetch_all(
        f"SELECT status, COUNT(*) AS n FROM {table}{where} GROUP BY status", params)
    return {str(r["status"] or "?"): int(r["n"]) for r in rows}


def list_reports(
    pool: ReadOnlyPool, domain: str, limit: int = 30, cycle_key: str | None = None,
) -> list[ReportThreadItem]:
    """리포트 스레드 목록.

    `cycle_key` 는 8767 과 **같은 기준**(`last_cycle_key`)으로 거른다 — 두 화면의 "W34" 가
    같은 집합을 가리켜야 한다(state_domain._mail_thread_cycle_where 미러).
    """
    dt = DOMAIN_TABLES[domain]
    table = dt.report_thread_table
    label = dt.report_label_col
    assert table in _REPORT_TABLES, f"허용되지 않은 리포트 테이블: {table}"
    # per-source 명시 projection: 없는 컬럼은 타입 지정 NULL alias(undefined-column 에러를 catch-무시하지 않음).
    owner_expr = report_col(table, "owner_recipient", "text")
    notified_expr = report_col(table, "notified_at", "double precision")
    fids_expr = report_col(table, "finding_ids", "text")
    # smb(mail_thread) 만 보유 — 나머지 3종엔 컬럼 자체가 없다.
    recur_expr = report_col(table, "recurrence_count", "integer")
    errkind_expr = report_col(table, "last_error_kind", "text")
    # label/table 식별자는 고정 화이트리스트. finding_summary는 마스킹된 코어 summary.
    rows = pool.fetch_all(
        f"SELECT t.id, t.status, t.severity, t.subject_tag, "
        f"t.{label} AS label, t.finding_id, fl.summary AS finding_summary, t.updated_at, "
        f"t.recipient AS recipient, {owner_expr} AS owner_recipient, "
        f"{notified_expr} AS notified_at, {fids_expr} AS finding_ids, "
        f"t.first_reported_at, t.attempt_count, t.cycle_keys, t.last_reason, "
        f"{recur_expr} AS recurrence_count, {errkind_expr} AS last_error_kind "
        f"FROM {table} t "
        f"LEFT JOIN finding_lifecycle fl ON fl.id = t.finding_id "
        f"{'WHERE t.last_cycle_key = %s ' if cycle_key else ''}"
        f"ORDER BY t.updated_at DESC NULLS LAST LIMIT %s",
        ([cycle_key, limit] if cycle_key else [limit]),
    )
    return [_to_report(r, domain) for r in rows]


def performance(pool: ReadOnlyPool, domain: str, kpi: WorkspaceKpi) -> GatewayPerformance:
    """성과 대시보드 실집계 — 퍼널=severity 분포, 주간추이=finding 유입/처리."""
    tts = DOMAIN_TASK_TYPES[domain]
    tt_clause, tt_params = finding_repo._in_clause("task_type", tts)
    # 퍼널: severity 분포(해당 도메인 finding)
    sev_rows = pool.fetch_all(
        f"SELECT severity, COUNT(*) AS n FROM finding_lifecycle WHERE {tt_clause} GROUP BY severity",
        tt_params,
    )
    sev_counts = {(r["severity"] or "").lower(): int(r["n"]) for r in sev_rows}
    # 라벨 공유 severity(info+informational→'정보')는 **카운트를 합산**한다(선점 스킵으로 유실 방지, codex #4).
    label_order: list[str] = []
    label_counts: dict[str, int] = {}
    for s in _SEV_ORDER:
        label = _SEV_LABEL.get(s, s)
        if label not in label_counts:
            label_counts[label] = 0
            label_order.append(label)
        label_counts[label] += sev_counts.get(s, 0)
    funnel: list[FunnelItem] = [FunnelItem(label=lbl, value=label_counts[lbl]) for lbl in label_order]
    # 주간추이: ISO주 유입, resolved = 열림(open/triaged) 아닌 것(대부분 0).
    weekly_rows = pool.fetch_all(
        f"SELECT to_char(to_timestamp(first_seen), 'IYYY-IW') AS wk, COUNT(*) AS inflow, "
        f"COUNT(*) FILTER (WHERE status NOT IN ('open','triaged')) AS resolved "
        f"FROM finding_lifecycle WHERE {tt_clause} GROUP BY wk ORDER BY wk DESC LIMIT 8",
        tt_params,
    )
    weekly = [
        WeeklyPoint(week=r["wk"], inflow=int(r["inflow"]), resolved=int(r["resolved"]))
        for r in reversed(weekly_rows)
    ]
    kpis = [
        PerfKpi(label="열린 finding", value=kpi.openFindings),
        PerfKpi(label="큐 타깃", value=kpi.queueTargets),
        PerfKpi(label="리포트 스레드", value=kpi.reportThreads),
    ]
    return GatewayPerformance(kpis=kpis, funnel=funnel, weekly=weekly)


def workspace_payload(
    pool: ReadOnlyPool,
    domain: str,
    *,
    since: float | None = None,
    week: str | None = None,
    cycle_key: str | None = None,
    finding_limit: int = 60,
    report_limit: int = 50,
) -> WorkspacePayload:
    """도메인 워크스페이스 payload.

    상한이 60/50 으로 하드코딩돼 있어 한 run 의 결과도 잘려 보였다(2026-08-17: smb 한
    사이클만 234 타깃·96 finding). 호출측이 정하도록 파라미터화한다 — 기본값은 종전과
    동일해 기존 동작은 안 바뀐다.

    `since` 는 `/gw/findings` 와 같은 의미(`last_seen >=`)로 "이번 run 만 보기" 다.
    ⚠️ KPI(openFindings 등)는 **필터하지 않는다** — 그건 '지금 열려 있는 전체'라는
    운영 지표라서 run 범위로 좁히면 뜻이 달라진다.
    """
    dt = DOMAIN_TABLES[domain]
    tts = DOMAIN_TASK_TYPES[domain]  # github=('github','jenkins') 등 — 은닉 방지
    findings = finding_repo.list_findings(
        pool, task_types=tts, since=since, week=week, limit=finding_limit)
    reports = list_reports(pool, domain, limit=report_limit, cycle_key=cycle_key)
    kpi = WorkspaceKpi(
        openFindings=finding_repo.count_open(pool, tts),
        queueTargets=queue_repo.count_all(pool, dt.queue_table),
        reportThreads=queue_repo.count_all(pool, dt.report_thread_table),
    )
    return WorkspacePayload(
        key=domain, findings=findings.items, reports=reports, kpi=kpi,
        performance=performance(pool, domain, kpi),
    )
