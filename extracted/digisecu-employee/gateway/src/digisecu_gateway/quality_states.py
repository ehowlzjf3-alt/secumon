"""candidate 품질 상태 분류 — DB 무접촉 순수함수 (#1 눈, runtime_components 와 동일 결).

skill_quality.worker_candidate_quality 이벤트(attempt 당 started/worker_result/parent_observed
최대 3행)를 attempt 단위 2축 상태로 파생한다. 핵심 계약:

- **unknown ≠ 0 ≠ clean**: 측정 안 된 것(unknown)·후보 0(noSignal)·해명 완료(accounted)를 절대 합치지
  않는다. 침묵을 잡으려고 만든 눈이 스스로 침묵(모름을 깨끗함으로 위장)하면 안 된다.
- **ledgerState** = accounted | silent | noSignal | unknown (침묵 축)
- **executionState** = ok | contractViolation | budget | cancelled | crash | invalid | missing | unknown
  (실행 축). missing = started 만 있고 이후 이벤트 없음(행방불명). invalid = 부모가 worker_result
  파싱 실패를 관측. 미등록 문자열은 unknown 으로 통과(fail-closed 이름 지어내기 금지).
- **degradedOk** = ok ∧ silent ∧ enforced — terminal 경로 침묵이 status=ok 로 위장 완료되는
  유일 케이스라 반드시 분리 노출한다(엔진 v3.90 설계 확인 사항).
- seen 단위는 도구별 이질(hit/페이지/finding) — 합계는 rawCandidateSignals 로만 노출하고
  비율·차감 계산에 쓰지 않는다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

LEDGER_STATES = ("accounted", "silent", "noSignal", "unknown")
EXECUTION_STATES = (
    "ok", "contractViolation", "budget", "cancelled", "crash",
    "invalid", "missing", "unknown",
)

_REASON_TO_EXECUTION = {
    "contract_violation": "contractViolation",
    "max_tokens": "budget",
    "max_turns": "budget",
    "backstop_timeout": "budget",   # WorkerOutcome — 부모가 abnormal outcome 을 reason 으로 남김
    "aborted": "cancelled",
    "cancelled": "cancelled",
    "stream_error": "crash",
    "no_completion": "crash",
    "crash": "crash",
    "spawn_failed": "crash",        # WorkerOutcome
    "pool_error": "crash",          # WorkerOutcome
}


@dataclass(frozen=True, slots=True)
class ResolvedAttempt:
    """attempt 1개의 파생 상태 — 이벤트 pivot 행에서 계산."""

    attempt_id: str
    domain: str
    worker_type: str
    component: str
    ledger_state: str
    execution_state: str
    enforced: bool | None       # None = 미상(worker_result 이벤트 부재)
    reported: bool              # worker_result 이벤트 존재(텔레메트리 커버리지 분자)
    has_started: bool           # started 부재 = solo/레거시 구동 — 커버리지 캐비앳(codex #4)
    candidates_seen: int | None
    candidates_accounted: int | None
    findings_count: int | None
    last_at: float


def ledger_state(seen: int | None, accounted: int | None) -> str:
    if seen is None:
        return "unknown"
    if seen > 0:
        if accounted is None:
            return "unknown"  # 해명 여부 미상 — silent 단정 금지 (codex verify #5)
        return "silent" if accounted == 0 else "accounted"
    return "noSignal"


def execution_state(status: str | None, reason: str | None) -> str:
    # reason 매핑을 status 보다 먼저 — "결과 파일은 ok 인데 이후 killed"(부모가 outcome 을
    # reason 으로 남김) 같은 케이스가 ok 로 위장되지 않게(codex verify #1). 매핑표는 실패
    # 사유만 담으므로 정상 reason(end_turn)은 그대로 status 판정으로 떨어진다.
    r = (reason or "").strip().lower()
    if r in _REASON_TO_EXECUTION:
        return _REASON_TO_EXECUTION[r]
    s = (status or "").strip().lower()
    if s == "ok":
        return "ok"
    if s == "error_crash":
        return "crash"
    return "unknown"


def resolve_attempt(row: dict[str, Any]) -> ResolvedAttempt:
    """pivot 행(quality_repo.attempts_recent) → attempt 상태.

    worker_result(로컬 진실: reason/enforced 보유)를 우선, 없으면 parent_observed 로 폴백.
    parent 가 invalid 를 관측했으면 execution=invalid + candidates unknown.
    started 만 있으면 missing(행방불명).
    """
    has_worker = bool(row.get("has_worker"))
    has_parent = bool(row.get("has_parent"))
    seen: int | None = None
    acct: int | None = None
    enforced: bool | None = None
    findings: int | None = None
    if has_worker:
        seen = _int_or_none(row.get("w_seen"))
        acct = _int_or_none(row.get("w_acct"))
        enforced = row.get("w_enforced")
        findings = _int_or_none(row.get("w_findings"))
        exec_state = execution_state(_s(row.get("w_status")), _s(row.get("w_reason")))
        # 부모가 전달 실패(invalid)를 관측했으면 워커 자기보고(ok)가 이를 가리면 안 된다
        # (결과 파일 쓰기 OSError 삼킴 + DB 기록 성공 케이스, codex verify #1).
        # candidates 는 워커의 실측이므로 ledger 축은 유지하고 execution 축만 invalid.
        if has_parent and row.get("p_valid") is False:
            exec_state = "invalid"
    elif has_parent:
        if row.get("p_valid") is True:
            seen = _int_or_none(row.get("p_seen"))
            acct = _int_or_none(row.get("p_acct"))
            findings = _int_or_none(row.get("p_findings"))
            exec_state = execution_state(_s(row.get("p_status")), _s(row.get("p_reason")))
        else:
            exec_state = "invalid"
    else:
        exec_state = "missing"
    return ResolvedAttempt(
        attempt_id=str(row.get("attempt_id") or ""),
        domain=str(row.get("domain") or ""),
        worker_type=str(row.get("worker_type") or ""),
        component=str(row.get("component") or ""),
        ledger_state=ledger_state(seen, acct),
        execution_state=exec_state,
        enforced=enforced if isinstance(enforced, bool) else None,
        reported=has_worker,
        has_started=bool(row.get("has_started")),
        candidates_seen=seen,
        candidates_accounted=acct,
        findings_count=findings,
        last_at=float(row.get("last_at") or 0.0),
    )


def is_degraded_ok(a: ResolvedAttempt) -> bool:
    """ok 로 위장된 침묵 — v3.90 terminal 경로가 허용하는 유일한 침묵 완료. 분리 노출 필수."""
    return a.execution_state == "ok" and a.ledger_state == "silent" and a.enforced is True


def is_failed_silent(a: ResolvedAttempt) -> bool:
    return a.ledger_state == "silent" and a.execution_state != "ok"


def _int_or_none(v: Any) -> int | None:
    return None if v is None else int(v)


def _s(v: Any) -> str | None:
    return None if v is None else str(v)
