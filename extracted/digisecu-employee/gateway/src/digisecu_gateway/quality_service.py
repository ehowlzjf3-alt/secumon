"""candidate 품질 집계 서비스 — quality_repo(SQL) + quality_states(순수 분류) 를 응답 모델로 조립 (#1 눈).

계약(codex 설계리뷰 반영):
- attempt 0건 도메인은 status=noData — clean 으로 위장 금지.
- 도메인 어휘 밖 행은 조용히 제외하지 않고 unclassifiedRows 로 카운트(숨기면 fail-open).
- hard limit 절단은 truncated=true 로 노출(조용한 절단 금지).
- free-text 는 응답에 없음 — 전 필드가 enum/카운트/UUID/epoch (redact 대상 자체를 만들지 않는다).
"""
from __future__ import annotations

import re

from .db import ReadOnlyPool
from .domains import DOMAINS
from .models import QualityCandidates, QualityDomainReport, QualitySilentAttempt
from .quality_states import ResolvedAttempt, is_degraded_ok, is_failed_silent, resolve_attempt
from .repos import quality_repo

POLICY_VERSION = "v1"
METRICS_VERSION = 1
_RECENT_SILENT_MAX = 20
# writer 가 이미 opaque 토큰만 기록하지만, read 경계에서도 방어(비정형=원문 미반환, codex #8)
_ATTEMPT_ID_RE = re.compile(r"^(solo-)?[0-9a-f]{32}$")


def _server_epoch(pool: ReadOnlyPool) -> float:
    row = pool.fetch_one("SELECT extract(epoch FROM now()) AS now")
    return float(row["now"]) if row and row.get("now") is not None else 0.0


def candidates(pool: ReadOnlyPool, window_days: int) -> QualityCandidates:
    as_of = _server_epoch(pool)
    window_s = int(window_days) * 24 * 3600
    rows = quality_repo.attempts_recent(pool, window_s)
    # repo 는 limit+1 을 반환 — len>limit 이 정확한 절단 신호(경계 오탐 없음, codex #10)
    truncated = len(rows) > quality_repo.ATTEMPT_HARD_LIMIT
    rows = rows[: quality_repo.ATTEMPT_HARD_LIMIT]
    attempts = [resolve_attempt(r) for r in rows]

    classified: dict[str, list[ResolvedAttempt]] = {d: [] for d in DOMAINS}
    unclassified = 0
    for a in attempts:
        if a.domain in classified:
            classified[a.domain].append(a)
        else:
            unclassified += 1  # 어휘 밖 도메인 — 카운트로만 노출(원문 미노출)

    domains_out = [_domain_report(d, classified[d]) for d in DOMAINS]

    silent = sorted(
        (a for a in attempts if a.domain in classified and a.ledger_state == "silent"),
        key=lambda a: a.last_at, reverse=True,
    )[:_RECENT_SILENT_MAX]

    return QualityCandidates(
        asOf=as_of,
        windowDays=int(window_days),
        policyVersion=POLICY_VERSION,
        metricsVersion=METRICS_VERSION,
        unclassifiedRows=unclassified,
        truncated=truncated,
        domains=domains_out,
        recentSilent=[
            QualitySilentAttempt(
                attemptId=(a.attempt_id if _ATTEMPT_ID_RE.fullmatch(a.attempt_id)
                           else "opaque-invalid"),
                domain=a.domain, workerType=a.worker_type,
                component=a.component, candidatesSeen=a.candidates_seen,
                executionState=a.execution_state, lastAt=a.last_at,
            )
            for a in silent
        ],
    )


def _domain_report(domain: str, items: list[ResolvedAttempt]) -> QualityDomainReport:
    if not items:
        return QualityDomainReport(
            domain=domain, status="noData",
            attempts=0, reported=0, invalid=0, missing=0, soloAttempts=0,
            accounted=0, silent=0, zeroSignal=0, unknownLedger=0,
            degradedOk=0, failedSilent=0, enforcementDisabled=0,
            rawCandidateSignals=0, rawCandidatesAccounted=0,
            telemetryCoverage=None, lastObservedAt=None,
            byWorkerType={}, byExecutionState={},
        )
    by_worker: dict[str, int] = {}
    by_exec: dict[str, int] = {}
    ledger = {"accounted": 0, "silent": 0, "noSignal": 0, "unknown": 0}
    invalid = missing = solo = reported = degraded_ok = failed_silent = disabled = 0
    raw_seen = raw_acct = 0
    for a in items:
        by_worker[a.worker_type] = by_worker.get(a.worker_type, 0) + 1
        by_exec[a.execution_state] = by_exec.get(a.execution_state, 0) + 1
        ledger[a.ledger_state] = ledger.get(a.ledger_state, 0) + 1
        if a.execution_state == "invalid":
            invalid += 1
        if a.execution_state == "missing":
            missing += 1
        if a.reported and not a.has_started:
            solo += 1
        if a.reported:
            reported += 1
        if is_degraded_ok(a):
            degraded_ok += 1
        if is_failed_silent(a):
            failed_silent += 1
        if a.enforced is False:
            disabled += 1
        raw_seen += a.candidates_seen or 0
        raw_acct += a.candidates_accounted or 0
    total = len(items)
    return QualityDomainReport(
        domain=domain, status="present",
        attempts=total, reported=reported, invalid=invalid, missing=missing,
        soloAttempts=solo,
        accounted=ledger["accounted"], silent=ledger["silent"],
        zeroSignal=ledger["noSignal"], unknownLedger=ledger["unknown"],
        degradedOk=degraded_ok, failedSilent=failed_silent,
        enforcementDisabled=disabled,
        rawCandidateSignals=raw_seen, rawCandidatesAccounted=raw_acct,
        telemetryCoverage=round(reported / total, 4),
        lastObservedAt=max(a.last_at for a in items),
        byWorkerType=dict(sorted(by_worker.items())),
        byExecutionState=dict(sorted(by_exec.items())),
    )
