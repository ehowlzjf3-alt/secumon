"""candidate 품질 read-model (#1 눈) — 무DB 순수함수 + 서비스 조립 회귀.

계약(quality_states/quality_service docstring 이 단일 소스): unknown≠0≠clean ·
noData(빈 도메인)≠clean · degradedOk(=ok 로 위장된 침묵) 분리 노출 · 어휘 밖 도메인은
숨기지 않고 unclassifiedRows 카운트.
"""
from digisecu_gateway import quality_states as qs
from digisecu_gateway import quality_service


# ── ledger 축 ──


def test_ledger_state_axis():
    assert qs.ledger_state(None, None) == "unknown"      # 미계측 — 0 과 절대 동치 아님
    assert qs.ledger_state(0, 0) == "noSignal"           # 후보 신호 없음 — 깨끗함의 증거 아님
    assert qs.ledger_state(22, 0) == "silent"            # 무해명 침묵 — 그 사고
    # 해명 여부 미상은 silent 단정 금지(codex verify #5) — unknown 보존
    assert qs.ledger_state(22, None) == "unknown"
    assert qs.ledger_state(9, 1) == "accounted"


def test_execution_state_axis():
    assert qs.execution_state("ok", "end_turn") == "ok"
    assert qs.execution_state("error_crash", "contract_violation") == "contractViolation"
    assert qs.execution_state("error_crash", "max_tokens") == "budget"
    assert qs.execution_state("error_crash", "max_turns") == "budget"
    assert qs.execution_state("error_crash", "aborted") == "cancelled"
    assert qs.execution_state("error_crash", "crash") == "crash"
    assert qs.execution_state("error_crash", None) == "crash"
    # "파일은 ok 인데 이후 killed" — 부모가 남긴 abnormal outcome(reason)이 ok 를 이긴다(codex #1)
    assert qs.execution_state("ok", "backstop_timeout") == "budget"
    assert qs.execution_state("ok", "spawn_failed") == "crash"
    # 미등록 문자열은 이름 지어내지 않고 unknown 통과
    assert qs.execution_state("weird", "novel_reason") == "unknown"


def _row(**kw):
    base = {
        "attempt_id": "a1", "domain": "confluence",
        "worker_type": "confluence_keyword_search", "component": "confluence.search_task",
        "last_at": 100.0, "has_started": True, "has_worker": False, "has_parent": False,
        "w_status": None, "w_reason": None, "w_enforced": None,
        "w_seen": None, "w_acct": None, "w_findings": None,
        "p_status": None, "p_reason": None, "p_valid": None,
        "p_seen": None, "p_acct": None, "p_findings": None,
    }
    base.update(kw)
    return base


def test_resolve_prefers_worker_result():
    a = qs.resolve_attempt(_row(
        has_worker=True, has_parent=True,
        w_status="ok", w_reason="end_turn", w_enforced=True, w_seen=22, w_acct=0,
        p_status="ok", p_valid=True, p_seen=1, p_acct=1,  # 워커 로컬 진실이 이겨야 함
    ))
    assert a.ledger_state == "silent"
    assert a.execution_state == "ok"
    assert a.enforced is True
    assert qs.is_degraded_ok(a)  # ok 로 위장된 침묵 — 최우선 관전 지표


def test_resolve_parent_invalid_is_explicit_unknown():
    a = qs.resolve_attempt(_row(has_parent=True, p_valid=False, p_status="crashed"))
    assert a.execution_state == "invalid"
    assert a.ledger_state == "unknown"
    assert not qs.is_degraded_ok(a)


def test_resolve_parent_invalid_overrides_worker_ok():
    """결과 파일 쓰기 실패(OSError 삼킴)+DB ok 기록 — 부모의 invalid 관측이 이긴다(codex #1).

    단 candidates 는 워커 실측이므로 ledger 축은 보존.
    """
    a = qs.resolve_attempt(_row(
        has_worker=True, has_parent=True, p_valid=False,
        w_status="ok", w_reason="end_turn", w_enforced=True, w_seen=22, w_acct=0,
    ))
    assert a.execution_state == "invalid"
    assert a.ledger_state == "silent"
    assert not qs.is_degraded_ok(a)      # ok 아님 → degradedOk 아님
    assert qs.is_failed_silent(a)


def test_resolve_started_only_is_missing():
    a = qs.resolve_attempt(_row())
    assert a.execution_state == "missing"
    assert a.ledger_state == "unknown"


def test_failed_silent_vs_degraded_ok():
    failed = qs.resolve_attempt(_row(
        has_worker=True, w_status="error_crash", w_reason="contract_violation",
        w_enforced=True, w_seen=5, w_acct=0,
    ))
    assert qs.is_failed_silent(failed) and not qs.is_degraded_ok(failed)
    # kill-switch 로 enforce 꺼진 침묵은 degradedOk 가 아니다(unenforced)
    unenforced = qs.resolve_attempt(_row(
        has_worker=True, w_status="ok", w_reason="end_turn",
        w_enforced=False, w_seen=5, w_acct=0,
    ))
    assert not qs.is_degraded_ok(unenforced)


# ── 서비스 조립 (fake pool) ──


class _FakePool:
    def __init__(self, rows):
        self._rows = rows

    def fetch_one(self, sql, params=None):
        return {"now": 1000.0}

    def fetch_all(self, sql, params=None):
        return self._rows


def test_service_no_data_is_not_clean():
    out = quality_service.candidates(_FakePool([]), 7)
    assert all(d.status == "noData" for d in out.domains)
    assert all(d.telemetryCoverage is None for d in out.domains)
    assert out.unclassifiedRows == 0
    assert out.truncated is False


_AID = "0" * 32  # opaque 토큰 형식(32-hex) — 드릴다운 노출 계약


def test_service_aggregation_and_unclassified():
    rows = [
        # confluence: ok 위장 침묵 (worker_result)
        _row(attempt_id=_AID, has_worker=True, w_status="ok", w_reason="end_turn",
             w_enforced=True, w_seen=22, w_acct=0, last_at=10.0),
        # confluence: 깨끗한 완료 — 단 started 없음(solo/레거시)
        _row(attempt_id="a2", has_started=False, has_worker=True, w_status="ok",
             w_reason="end_turn", w_enforced=True, w_seen=3, w_acct=3, last_at=20.0),
        # confluence: 해명됐지만 실행은 실패 — execution 축이 응답에서 소실되면 안 됨(codex #2)
        _row(attempt_id="a5", has_worker=True, w_status="error_crash",
             w_reason="contract_violation", w_enforced=True, w_seen=2, w_acct=2, last_at=25.0),
        # smb: 부모만 관측, invalid — candidates unknown
        _row(attempt_id="a3", domain="smb", worker_type="smb_task",
             component="task.worker", has_parent=True, p_valid=False, last_at=30.0),
        # 어휘 밖 도메인 — 숨기지 말고 카운트
        _row(attempt_id="a4", domain="jenkins_legacy", last_at=40.0),
    ]
    out = quality_service.candidates(_FakePool(rows), 7)
    assert out.unclassifiedRows == 1
    cf = next(d for d in out.domains if d.domain == "confluence")
    assert cf.status == "present"
    assert cf.attempts == 3 and cf.reported == 3
    assert cf.silent == 1 and cf.accounted == 2
    assert cf.degradedOk == 1 and cf.failedSilent == 0
    assert cf.soloAttempts == 1
    # execution 축 전체 분포 — accounted 인 실패(contractViolation)도 보인다
    assert cf.byExecutionState == {"contractViolation": 1, "ok": 2}
    assert cf.telemetryCoverage == 1.0
    assert cf.byWorkerType == {"confluence_keyword_search": 3}
    smb = next(d for d in out.domains if d.domain == "smb")
    assert smb.attempts == 1 and smb.invalid == 1 and smb.unknownLedger == 1
    assert smb.reported == 0 and smb.telemetryCoverage == 0.0
    # 드릴다운은 침묵만 — 정형 attempt_id 는 그대로, 비정형은 원문 대신 opaque-invalid
    assert [s.attemptId for s in out.recentSilent] == [_AID]
    assert out.recentSilent[0].executionState == "ok"
    # 빈 도메인은 여전히 noData
    assert next(d for d in out.domains if d.domain == "dev_web").status == "noData"


def test_service_masks_nonconforming_attempt_id_in_drilldown():
    rows = [_row(attempt_id="prod-share-CEO-payroll", has_worker=True, w_status="ok",
                 w_reason="end_turn", w_enforced=True, w_seen=5, w_acct=0)]
    out = quality_service.candidates(_FakePool(rows), 7)
    assert out.recentSilent[0].attemptId == "opaque-invalid"
