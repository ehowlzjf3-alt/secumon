"""worker candidate 이벤트 기록 — skill_quality writer (#1 눈 read-model v1).

v3.90 침묵 게이트가 파일(worker_result.json)·인메모리(FanoutReport)에만 남기던 candidates 신호를
DB(skill_quality.worker_candidate_event)로 영속한다. 게이트웨이 /gw/quality/candidates 가 소비.

계약:
- **best-effort**: 기록 실패는 log 후 False 반환 — 텔레메트리가 워커/부모 흐름을 절대 깨지 않는다.
- **attempt_id**: 부모가 `new_attempt_id()` 로 생성해 spec env `SA_ATTEMPT_ID` 로 워커에 전달
  (코어는 이 개념을 모른다 — CORE-ASK observer 가 생겨도 spec.env 왕복은 동일). 워커 단독 구동
  (수동/E2E)엔 env 부재 → `solo-` 접두 자동 생성으로 이벤트 유실 방지.
- **unknown ≠ 0**: candidates 미상은 None(=NULL) — 0(측정된 깨끗함)과 절대 합치지 않는다.
- dedup: UNIQUE(attempt_id, event_kind) + ON CONFLICT DO NOTHING (재시도/이중호출 안전).
- 이벤트 시맨틱은 state_split/skill_quality.py NOTES 가 단일 소스.
"""
from __future__ import annotations

import logging
import os
import re
import time
import uuid

log = logging.getLogger(__name__)

ATTEMPT_ENV = "SA_ATTEMPT_ID"
# attempt_id 는 opaque 토큰만 허용 — env 경유라 임의 문자열(경로/자산명) 유입 가능성을
# writer 에서 차단한다(codex verify #8: free-text 가 read-model 드릴다운으로 노출되는 벡터).
_ATTEMPT_ID_RE = re.compile(r"^(solo-)?[0-9a-f]{32}$")
METRICS_VERSION = 1
DOMAINS = ("smb", "dev_web", "github", "confluence")

EVENT_STARTED = "started"
EVENT_WORKER_RESULT = "worker_result"
EVENT_PARENT_OBSERVED = "parent_observed"

_INSERT_SQL = (
    "INSERT INTO worker_candidate_event("
    "attempt_id, event_kind, domain, worker_type, component, result_valid, "
    "execution_status, reason_code, ledger_enforced, metrics_version, "
    "candidates_seen, candidates_accounted, worker_reported_findings_count, recorded_at) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
    "ON CONFLICT (attempt_id, event_kind) DO NOTHING"
)

_registered = False


def _ensure_registered() -> None:
    """skill_quality 네임스페이스 등록 보장 — bootstrap 미경유 구동(수동 워커/스크립트) 대비.

    register_state_schemas 는 메모리 등록 + checksum 멱등이라 이중 호출 무해
    (candidate_counters.ensure_registered 전례).
    """
    global _registered
    if _registered:
        return
    from plugin.state_schema_wiring import register_state_schemas  # noqa: PLC0415
    register_state_schemas()
    _registered = True


def new_attempt_id() -> str:
    return uuid.uuid4().hex


def ledger_enforced_from_env(environ=None) -> bool:
    """SA_CANDIDATE_LEDGER kill-switch 반영 상태 — runtime.run_agent 파싱과 동일 어휘.

    헌팅 워커는 enforce=True opt-in 이므로, 실제 enforce 여부는 kill-switch 만이 뒤집는다.
    """
    env = os.environ if environ is None else environ
    return str(env.get("SA_CANDIDATE_LEDGER", "1")).strip().lower() not in {
        "0", "false", "no", "off",
    }


def attempt_id_from_env(environ=None) -> str:
    env = os.environ if environ is None else environ
    aid = (env.get(ATTEMPT_ENV) or "").strip()
    if aid and _ATTEMPT_ID_RE.fullmatch(aid):
        return aid
    if aid:
        log.warning("quality_events: 비정형 %s 무시(opaque 토큰만 허용) — solo 재생성", ATTEMPT_ENV)
    return f"solo-{uuid.uuid4().hex}"


def _record(
    event_kind: str,
    *,
    attempt_id: str,
    domain: str,
    worker_type: str,
    component: str,
    result_valid: bool | None = None,
    execution_status: str | None = None,
    reason_code: str | None = None,
    ledger_enforced: bool | None = None,
    metrics_version: int | None = None,
    candidates_seen: int | None = None,
    candidates_accounted: int | None = None,
    worker_reported_findings_count: int | None = None,
) -> bool:
    if domain not in DOMAINS:
        log.warning("quality_events: 미상 domain %r (기록은 계속 — 게이트웨이가 unknown 처리)", domain)
    try:
        _ensure_registered()
        from secu_agent.state import connection  # noqa: PLC0415
        with connection("skill_quality") as c:
            c.execute(_INSERT_SQL, (
                attempt_id, event_kind, domain, worker_type, component,
                result_valid, execution_status, reason_code, ledger_enforced,
                metrics_version,
                candidates_seen, candidates_accounted,
                worker_reported_findings_count, time.time(),
            ))
        return True
    except Exception:
        log.warning("quality_events: %s 기록 실패 (무시 — best-effort 계약)",
                    event_kind, exc_info=True)
        return False


def record_started(*, attempt_id: str, domain: str, worker_type: str, component: str) -> bool:
    """부모가 워커 spawn 직전 기록 — attempted 분모(행방불명 워커 가시화)."""
    return _record(
        EVENT_STARTED,
        attempt_id=attempt_id, domain=domain,
        worker_type=worker_type, component=component,
    )


def record_worker_result(
    *,
    domain: str,
    worker_type: str,
    component: str,
    execution_status: str,
    reason_code: str | None,
    ledger_enforced: bool,
    candidates_seen: int | None,
    candidates_accounted: int | None,
    worker_reported_findings_count: int | None = None,
    attempt_id: str | None = None,
    environ=None,
) -> bool:
    """워커가 자기 결과 기록 직후 호출 — reason 로컬 진실 보존. result_valid=TRUE 고정."""
    return _record(
        EVENT_WORKER_RESULT,
        attempt_id=attempt_id or attempt_id_from_env(environ),
        domain=domain, worker_type=worker_type, component=component,
        result_valid=True,
        execution_status=execution_status, reason_code=reason_code,
        ledger_enforced=ledger_enforced, metrics_version=METRICS_VERSION,
        candidates_seen=candidates_seen, candidates_accounted=candidates_accounted,
        worker_reported_findings_count=worker_reported_findings_count,
    )


def record_parent_observed(
    *,
    attempt_id: str,
    domain: str,
    worker_type: str,
    component: str,
    result_valid: bool,
    execution_status: str | None = None,
    reason_code: str | None = None,
    ledger_enforced: bool | None = None,
    candidates_seen: int | None = None,
    candidates_accounted: int | None = None,
    worker_reported_findings_count: int | None = None,
) -> bool:
    """부모(어댑터 release/자체 루프)가 completion 분류 후 기록.

    result_valid=False 면 candidates_* 는 None 으로 넘길 것(unknown ≠ 0 계약) —
    워커가 죽어 결과가 없어도 "안 보임"이 DB 에 명시적으로 남는다.
    """
    if not result_valid and (candidates_seen is not None or candidates_accounted is not None):
        log.warning("quality_events: result_valid=False 인데 candidates 값 전달 — None 으로 강제")
        candidates_seen = None
        candidates_accounted = None
    return _record(
        EVENT_PARENT_OBSERVED,
        attempt_id=attempt_id,
        domain=domain, worker_type=worker_type, component=component,
        result_valid=result_valid,
        execution_status=execution_status, reason_code=reason_code,
        ledger_enforced=ledger_enforced,
        # 측정된 candidates 가 있을 때만 각인 — 미측정(NULL)에 버전 찍으면 측정처럼 읽힘(codex #5)
        metrics_version=METRICS_VERSION
        if (result_valid and candidates_seen is not None) else None,
        candidates_seen=candidates_seen, candidates_accounted=candidates_accounted,
        worker_reported_findings_count=worker_reported_findings_count,
    )


def spec_env_with_attempt(
    base_env,
    *,
    domain: str,
    worker_type: str,
    component: str,
) -> dict:
    """fanout adapter build_spec 용 — attempt_id 생성→started 기록→env 주입.

    반환 env 를 WorkerSpec(env=...) 에 그대로 쓰면 워커의 record_worker_result 가
    같은 attempt_id 로 상관된다. started 기록 실패(best-effort)여도 env 주입은 진행.
    """
    aid = new_attempt_id()
    record_started(attempt_id=aid, domain=domain,
                   worker_type=worker_type, component=component)
    env = dict(base_env or {})
    env[ATTEMPT_ENV] = aid
    return env


def observe_completion(
    completion,
    *,
    domain: str,
    worker_type: str,
    component: str,
) -> bool:
    """fanout adapter release() 용 parent_observed — valid/invalid 분류 포함.

    release() 의 success 분기 **앞**에서 호출할 것 (성공 no-op 조기 return 이 관측을
    삼키면 안 된다). invalid(worker_result 누락/파싱실패/스키마위반/시그널 종료)는
    result_valid=False + candidates NULL 로 남는다 — "안 보임" 의 명시적 기록.
    """
    try:
        spec_env = getattr(getattr(completion, "spec", None), "env", None) or {}
        aid = attempt_id_from_env(spec_env)
        result = getattr(completion, "result", None)
        outcome = getattr(completion, "outcome", None)
        outcome_s = str(getattr(outcome, "value", outcome) or "").strip()
        # 프로세스가 깨끗이 끝나지 않았으면(outcome≠exited) reason 으로 남긴다 —
        # "결과 파일은 유효한데 이후 killed" 케이스가 ok 로 위장되지 않게(codex verify #1).
        abnormal = outcome_s if outcome_s and outcome_s != "exited" else None
        from secu_agent.agent.schema.worker_result import WorkerResult  # noqa: PLC0415
        if isinstance(result, WorkerResult):
            # 구 artifact(candidates 필드 부재)는 pydantic default 0 — 측정값 아님.
            # 명시 기록된 경우에만 복사, 아니면 NULL(unknown) 보존(codex verify #5).
            fields = getattr(result, "model_fields_set", None) or set()
            measured = "candidates_seen" in fields or "candidates_accounted" in fields
            return record_parent_observed(
                attempt_id=aid, domain=domain,
                worker_type=worker_type, component=component,
                result_valid=True,
                execution_status=str(getattr(result, "status", None) or "unknown"),
                reason_code=abnormal,
                candidates_seen=int(result.candidates_seen) if measured else None,
                candidates_accounted=int(result.candidates_accounted) if measured else None,
                worker_reported_findings_count=int(
                    getattr(result, "findings_count", 0) or 0),
            )
        return record_parent_observed(
            attempt_id=aid, domain=domain,
            worker_type=worker_type, component=component,
            result_valid=False,
            execution_status=outcome_s or "invalid",
            reason_code=abnormal,
        )
    except Exception:
        log.warning("quality_events: observe_completion 실패 (무시 — best-effort 계약)",
                    exc_info=True)
        return False


class QualityRecorder:
    """도메인 바인딩된 QualityTelemetryPort 구현 — plugin 컴포지션 루트가 FanoutServices 에 주입.

    application 계층은 service import 금지(계층 불변식)라 fanout adapter 는 이 객체를
    포트(domains/*/application/ports.QualityTelemetryPort)로만 본다.
    """

    def __init__(self, domain: str) -> None:
        self._domain = domain

    def spec_env(self, base_env, *, worker_type: str, component: str) -> dict:
        return spec_env_with_attempt(
            base_env, domain=self._domain,
            worker_type=worker_type, component=component,
        )

    def observe(self, completion, *, worker_type: str, component: str) -> None:
        observe_completion(
            completion, domain=self._domain,
            worker_type=worker_type, component=component,
        )


def apply_quality_schema() -> None:
    """명시적 스키마 적용(운영/배포 단계) — lazy 첫-워커 DDL 의존 금지 (codex 배포 지적).

    라이브 threat_hunter 에는 prod DDL 게이트에 따라 사용자 승인 하에 실행할 것.
    """
    _ensure_registered()
    from secu_agent.persistence.schema_orchestrator import apply_schema  # noqa: PLC0415
    apply_schema("skill_quality")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="skill_quality schema 적용 유틸")
    parser.add_argument("--apply-schema", action="store_true",
                        help="skill_quality 네임스페이스 DDL 명시 적용(멱등)")
    args = parser.parse_args()
    if args.apply_schema:
        apply_quality_schema()
        print("skill_quality schema applied")
    else:
        parser.print_help()
