"""quality_events (#1 눈 v1) — skill_quality 이벤트 기록 계약 검증.

계약(모듈 docstring 이 단일 소스): best-effort(절대 raise 금지) · unknown≠0(NULL) ·
UNIQUE(attempt_id, event_kind) dedup · solo attempt_id 폴백 · VIEW 고정 컬럼.
"""
from __future__ import annotations

import service.agents.quality_events as qe
from secu_agent.state import connection


def _rows(where: str = "1=1"):
    with connection("skill_quality") as c:
        cur = c.execute(
            "SELECT * FROM worker_candidate_event WHERE " + where + " ORDER BY id"
        )
        return [{k: r[k] for k in r.keys()} for r in cur.fetchall()]


def test_three_event_kinds_roundtrip(tmp_db):
    aid = qe.new_attempt_id()
    assert qe.record_started(
        attempt_id=aid, domain="confluence",
        worker_type="confluence_task", component="confluence.task",
    )
    assert qe.record_worker_result(
        attempt_id=aid, domain="confluence",
        worker_type="confluence_task", component="confluence.task",
        execution_status="ok", reason_code="end_turn",
        ledger_enforced=True, candidates_seen=22, candidates_accounted=0,
        worker_reported_findings_count=0,
    )
    assert qe.record_parent_observed(
        attempt_id=aid, domain="confluence",
        worker_type="confluence_task", component="confluence.task",
        result_valid=True, execution_status="ok",
        candidates_seen=22, candidates_accounted=0,
    )
    rows = _rows(f"attempt_id = '{aid}'")
    assert [r["event_kind"] for r in rows] == [
        qe.EVENT_STARTED, qe.EVENT_WORKER_RESULT, qe.EVENT_PARENT_OBSERVED,
    ]
    started, worker, parent = rows
    # started 는 식별축만 — 측정값 전부 NULL
    assert started["candidates_seen"] is None
    assert started["result_valid"] is None
    # worker_result 는 로컬 진실 + result_valid=TRUE 고정 + metrics_version 각인
    assert worker["result_valid"] is True
    assert worker["candidates_seen"] == 22
    assert worker["candidates_accounted"] == 0
    assert worker["ledger_enforced"] is True
    assert worker["metrics_version"] == qe.METRICS_VERSION
    assert worker["reason_code"] == "end_turn"
    # parent_observed(valid) 는 파싱된 값 보존
    assert parent["result_valid"] is True
    assert parent["candidates_seen"] == 22


def test_dedup_same_attempt_and_kind(tmp_db):
    aid = qe.new_attempt_id()
    assert qe.record_started(
        attempt_id=aid, domain="smb", worker_type="smb_task", component="task.worker")
    # 이중 호출(재시도)도 True — ON CONFLICT DO NOTHING, 행은 1개
    assert qe.record_started(
        attempt_id=aid, domain="smb", worker_type="smb_task", component="task.worker")
    assert len(_rows(f"attempt_id = '{aid}'")) == 1


def test_invalid_parent_observation_forces_unknown(tmp_db):
    """result_valid=False 면 candidates 는 unknown(NULL) — 0(측정된 깨끗함)과 합치면 안 된다."""
    aid = qe.new_attempt_id()
    assert qe.record_parent_observed(
        attempt_id=aid, domain="github", worker_type="github_task",
        component="github.task", result_valid=False,
        candidates_seen=7, candidates_accounted=3,  # 잘못 전달돼도 강제 NULL
    )
    (row,) = _rows(f"attempt_id = '{aid}'")
    assert row["result_valid"] is False
    assert row["candidates_seen"] is None
    assert row["candidates_accounted"] is None
    assert row["metrics_version"] is None


def test_solo_attempt_id_fallback(tmp_db, monkeypatch):
    """env 에 SA_ATTEMPT_ID 없는 단독 구동도 이벤트를 잃지 않는다 (solo- 접두 생성)."""
    monkeypatch.delenv(qe.ATTEMPT_ENV, raising=False)
    assert qe.record_worker_result(
        domain="dev_web", worker_type="dev_web_task", component="web.task",
        execution_status="ok", reason_code=None,
        ledger_enforced=True, candidates_seen=0, candidates_accounted=0,
    )
    (row,) = _rows("domain = 'dev_web'")
    assert row["attempt_id"].startswith("solo-")


def test_attempt_id_env_roundtrip():
    good = "a" * 32  # opaque 32-hex 토큰만 왕복 허용
    assert qe.attempt_id_from_env({qe.ATTEMPT_ENV: good}) == good
    assert qe.attempt_id_from_env({qe.ATTEMPT_ENV: f"solo-{good}"}) == f"solo-{good}"
    assert qe.attempt_id_from_env({}).startswith("solo-")
    # 비정형(자산명/경로 등 free-text) env 는 무시하고 재생성 — read-model 노출 벡터 차단(codex #8)
    assert qe.attempt_id_from_env(
        {qe.ATTEMPT_ENV: "prod-share-CEO-payroll"}).startswith("solo-")


def test_best_effort_never_raises(tmp_db, monkeypatch):
    """DB 가 죽어도 기록 함수는 False 만 반환 — 워커/부모 흐름 보호가 최우선 계약."""
    import secu_agent.state as state_mod

    def _boom(namespace="core"):
        raise RuntimeError("db down")

    monkeypatch.setattr(state_mod, "connection", _boom)
    assert qe.record_started(
        attempt_id=qe.new_attempt_id(), domain="smb",
        worker_type="smb_task", component="task.worker",
    ) is False


def test_view_fixed_columns_no_id(tmp_db):
    """게이트웨이 기밀성 경계 — VIEW 는 고정 컬럼만(내부 PK 미노출)."""
    qe.record_started(
        attempt_id=qe.new_attempt_id(), domain="confluence",
        worker_type="confluence_search", component="confluence.search_task",
    )
    with connection("skill_quality") as c:
        cur = c.execute("SELECT * FROM worker_candidate_quality LIMIT 1")
        row = cur.fetchone()
        cols = set(row.keys())
    assert "id" not in cols
    assert {"attempt_id", "event_kind", "domain", "worker_type", "component",
            "result_valid", "execution_status", "reason_code", "ledger_enforced",
            "metrics_version", "candidates_seen", "candidates_accounted",
            "worker_reported_findings_count", "recorded_at"} == cols


def test_namespace_registered_via_wiring():
    from secu_agent.persistence.schema_orchestrator import registered_namespaces
    qe._ensure_registered()
    assert "skill_quality" in registered_namespaces()


# ── 부모측 경로 (QualityRecorder / observe_completion) ──


class _FakeSpec:
    def __init__(self, env):
        self.env = env


class _FakeCompletion:
    def __init__(self, env, result, outcome=None):
        self.spec = _FakeSpec(env)
        self.result = result
        self.outcome = outcome


def test_recorder_spec_env_records_started_and_injects_attempt(tmp_db):
    rec = qe.QualityRecorder("confluence")
    env = rec.spec_env({"EXISTING": "1"},
                       worker_type="confluence_space_batch",
                       component="confluence.space_task")
    assert env["EXISTING"] == "1"
    aid = env[qe.ATTEMPT_ENV]
    (row,) = _rows(f"attempt_id = '{aid}'")
    assert row["event_kind"] == qe.EVENT_STARTED
    assert row["domain"] == "confluence"
    assert row["worker_type"] == "confluence_space_batch"


def test_observe_completion_valid_result(tmp_db):
    from secu_agent.agent.schema.worker_result import WorkerResult

    result = WorkerResult(
        rc=0, status="ok", summary="x", findings_count=2, turns_used=3,
        tokens_in=10, tokens_out=20, candidates_seen=9, candidates_accounted=1,
    )
    aid = qe.new_attempt_id()
    rec = qe.QualityRecorder("github")
    rec.observe(_FakeCompletion({qe.ATTEMPT_ENV: aid}, result),
                worker_type="github_sso_task", component="github.sso_task")
    (row,) = _rows(f"attempt_id = '{aid}'")
    assert row["event_kind"] == qe.EVENT_PARENT_OBSERVED
    assert row["result_valid"] is True
    assert row["execution_status"] == "ok"
    assert row["candidates_seen"] == 9
    assert row["worker_reported_findings_count"] == 2


def test_observe_completion_legacy_artifact_stays_unknown(tmp_db):
    """구 워커 artifact(candidates 필드 부재)는 pydantic default 0 — 측정값으로 승격 금지(codex #5)."""
    from secu_agent.agent.schema.worker_result import WorkerResult

    legacy = WorkerResult.model_validate({
        "rc": 0, "status": "ok", "summary": "x", "findings_count": 0,
        "turns_used": 1, "tokens_in": 1, "tokens_out": 1,
    })  # candidates_* 미기재 → model_fields_set 에 없음
    aid = qe.new_attempt_id()
    qe.QualityRecorder("smb").observe(
        _FakeCompletion({qe.ATTEMPT_ENV: aid}, legacy),
        worker_type="smb_task", component="task.worker")
    (row,) = _rows(f"attempt_id = '{aid}'")
    assert row["result_valid"] is True
    assert row["candidates_seen"] is None       # 0 아님 — unknown 보존
    assert row["candidates_accounted"] is None
    assert row["metrics_version"] is None       # 미측정엔 버전 각인 금지


def test_observe_completion_abnormal_outcome_recorded_as_reason(tmp_db):
    """결과 파일은 유효한데 프로세스는 killed — outcome 이 reason 으로 남아 ok 위장 방지(codex #1)."""
    from secu_agent.agent.schema.worker_result import WorkerResult

    result = WorkerResult(rc=0, status="ok", summary="x", findings_count=0, turns_used=1,
                          tokens_in=1, tokens_out=1, candidates_seen=1, candidates_accounted=1)
    aid = qe.new_attempt_id()
    qe.QualityRecorder("github").observe(
        _FakeCompletion({qe.ATTEMPT_ENV: aid}, result, outcome="backstop_timeout"),
        worker_type="github_sso_task", component="github.sso_task")
    (row,) = _rows(f"attempt_id = '{aid}'")
    assert row["execution_status"] == "ok"
    assert row["reason_code"] == "backstop_timeout"


def test_observe_completion_invalid_result_is_explicit_unknown(tmp_db):
    """워커가 죽어 result 가 invalid 여도 '안 보임'이 DB 에 명시적으로 남는다."""
    from secu_agent.agent.schema.worker_result import WorkerResultInvalid

    aid = qe.new_attempt_id()
    rec = qe.QualityRecorder("smb")
    rec.observe(
        _FakeCompletion({qe.ATTEMPT_ENV: aid},
                        WorkerResultInvalid(reason="missing", detail="no file"),
                        outcome="crashed"),
        worker_type="smb_task", component="task.worker")
    (row,) = _rows(f"attempt_id = '{aid}'")
    assert row["result_valid"] is False
    assert row["candidates_seen"] is None
    assert row["candidates_accounted"] is None
    assert row["execution_status"] == "crashed"


def test_worker_and_parent_events_correlate_by_attempt(tmp_db):
    """started(부모) → worker_result(워커, env 왕복) → parent_observed(부모) 3행이 한 attempt 로 묶인다."""
    from secu_agent.agent.schema.worker_result import WorkerResult

    rec = qe.QualityRecorder("dev_web")
    env = rec.spec_env({}, worker_type="dev_web_task", component="dev_web_task")
    aid = env[qe.ATTEMPT_ENV]
    # 워커가 env 로 받은 attempt_id 로 자기 이벤트 기록
    qe.record_worker_result(
        domain="dev_web", worker_type="dev_web_task", component="dev_web_task",
        execution_status="ok", reason_code="end_turn", ledger_enforced=True,
        candidates_seen=0, candidates_accounted=0, environ=env,
    )
    result = WorkerResult(rc=0, status="ok", summary="x", findings_count=0,
                          turns_used=1, tokens_in=1, tokens_out=1)
    rec.observe(_FakeCompletion(env, result),
                worker_type="dev_web_task", component="dev_web_task")
    rows = _rows(f"attempt_id = '{aid}'")
    assert [r["event_kind"] for r in rows] == [
        qe.EVENT_STARTED, qe.EVENT_WORKER_RESULT, qe.EVENT_PARENT_OBSERVED,
    ]
