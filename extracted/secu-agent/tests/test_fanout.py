"""v3.81 T1d: generic fan-out 헬퍼 + 어댑터 프로토콜 (Fake 어댑터 테스트).

설계 계약 (docs/design/v3.81-de-domain-autonomy.md T1d — v3.80 원 설계는 git history):
- 부모 선claim (어댑터 claim_next 순차 1회) / 워커 무claim
- 타깃=1turn (goal_record_turn 완료당 1회, judge streak 비간섭)
- fail-closed 결과 → release(success=False)
- 결정론 종료: claim None ∧ 활성 0 → report.exhausted
- max_targets 예산 → budget_capped (예산 초과 불가능)
"""
from __future__ import annotations

import asyncio
import itertools
import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from secu_agent import state
from secu_agent.agent.events import FanoutCompleted, WorkerCompleted
from secu_agent.agent.fanout import (
    FanoutReport, FanoutTarget, get_fanout_adapter_factory,
    list_fanout_adapters, register_fanout_adapter,
    register_worker_completion_observer, run_fanout,
    unregister_fanout_adapter, unregister_worker_completion_observer,
)
from secu_agent.agent.schema.worker_result import (
    WorkerResult, WorkerResultInvalid,
)
from secu_agent.agent.worker_pool import WorkerCompletion, WorkerPool, WorkerSpec

_VALID_PAYLOAD = {
    "rc": 0, "status": "ok", "summary": "done", "findings_count": 1,
    "turns_used": 1, "tokens_in": 10, "tokens_out": 5, "evidence_paths": [],
}

_fake_pids = itertools.count(60000)


class _FakeProc:
    """argv[-1] = evidence_dir. write_result=False 면 결과 누락 (fail-closed)."""

    def __init__(self, ev_dir: Path, delay: float, write_result: bool):
        self.pid = next(_fake_pids)
        self.returncode: int | None = None
        self._ev = ev_dir
        self._delay = delay
        self._write = write_result

    async def wait(self) -> int:
        await asyncio.sleep(self._delay)
        if self._write:
            (self._ev / "worker_result.json").write_text(
                json.dumps(_VALID_PAYLOAD), encoding="utf-8",
            )
        self.returncode = 0
        return 0

    def terminate(self) -> None:
        self.returncode = -15

    def kill(self) -> None:
        self.returncode = -9


def _pool_factory(*, delay: float = 0.01, silent_labels: set[str] | None = None):
    """create_subprocess 주입 팩토리 — silent_labels 는 결과 파일을 안 쓴다."""
    silent = silent_labels or set()

    def factory(k: int) -> WorkerPool:
        async def create(*argv, **kw):
            ev = Path(argv[-1])
            return _FakeProc(ev, delay, ev.name not in silent)
        return WorkerPool(k, create_subprocess=create)

    return factory


class FakeAdapter:
    name = "fake"

    def __init__(self, tmp_path: Path, n: int, *, build_fail: set[str] | None = None):
        self._queue = [FanoutTarget(label=f"t{i}", payload=i) for i in range(n)]
        self._tmp = tmp_path
        self._build_fail = build_fail or set()
        self.released: list[tuple[str, bool]] = []
        self.claim_calls = 0

    async def claim_next(self) -> FanoutTarget | None:
        self.claim_calls += 1
        return self._queue.pop(0) if self._queue else None

    async def build_spec(self, target: FanoutTarget) -> WorkerSpec:
        if target.label in self._build_fail:
            raise RuntimeError("spec boom")
        d = self._tmp / target.label
        d.mkdir()
        return WorkerSpec(
            label=target.label, argv=("fake-worker", str(d)), evidence_dir=d,
        )

    async def release(self, target, completion, *, success: bool) -> None:
        self.released.append((target.label, success))

    def summarize(self, report: FanoutReport) -> str:
        return f"{report.succeeded}/{report.claimed}"


def _collect(aiter):
    async def _go():
        return [ev async for ev in aiter]
    return asyncio.run(_go())


def _report(events) -> FanoutReport:
    fin = [ev for ev in events if isinstance(ev, FanoutCompleted)]
    assert len(fin) == 1, "FanoutCompleted 는 정확 1개"
    assert fin[0] is events[-1], "FanoutCompleted 는 마지막 이벤트"
    return fin[0].report


# ── 기본 드레인 + 결정론 종료 ────────────────────────────────────────


def test_fanout_drains_all_targets_and_exhausts(tmp_path):
    ad = FakeAdapter(tmp_path, 5)
    events = _collect(run_fanout(ad, k=2, pool_factory=_pool_factory()))

    workers = [ev for ev in events if isinstance(ev, WorkerCompleted)]
    assert len(workers) == 5
    assert all(ev.ok and ev.status == "ok" and ev.adapter == "fake"
               for ev in workers)

    rpt = _report(events)
    assert rpt.claimed == 5 and rpt.succeeded == 5 and rpt.failed == 0
    assert rpt.exhausted is True          # claim None ∧ 활성 0 — 결정론 종료 신호
    assert rpt.budget_capped is False and rpt.cancelled is False
    assert rpt.tokens_in == 50 and rpt.tokens_out == 25
    assert rpt.findings_count == 5
    # 성공 타깃 전부 release(success=True)
    assert sorted(ad.released) == [(f"t{i}", True) for i in range(5)]
    assert ad.summarize(rpt) == "5/5"


def test_fanout_missing_result_fail_closed(tmp_path):
    """worker_result 누락 = 실패 집계 + release(success=False) (재점검 경로)."""
    ad = FakeAdapter(tmp_path, 3)
    events = _collect(run_fanout(
        ad, k=2, pool_factory=_pool_factory(silent_labels={"t1"}),
    ))
    rpt = _report(events)
    assert rpt.claimed == 3 and rpt.succeeded == 2 and rpt.failed == 1
    assert rpt.failures == ["t1"]
    assert ("t1", False) in ad.released
    bad = [ev for ev in events
           if isinstance(ev, WorkerCompleted) and not ev.ok]
    assert len(bad) == 1 and bad[0].status == "invalid:missing"


def test_fanout_build_spec_failure_rolls_on(tmp_path):
    """spec build 예외 = 그 타깃만 실패(release success=False), 풀은 계속."""
    ad = FakeAdapter(tmp_path, 4, build_fail={"t2"})
    events = _collect(run_fanout(ad, k=2, pool_factory=_pool_factory()))
    rpt = _report(events)
    assert rpt.claimed == 4 and rpt.succeeded == 3 and rpt.failed == 1
    assert rpt.failures == ["t2"]
    assert ("t2", False) in ad.released
    assert rpt.exhausted is True


# ── 예산 (F4: 초과 자체가 불가능) ────────────────────────────────────


def test_fanout_budget_cap_stops_claiming(tmp_path):
    ad = FakeAdapter(tmp_path, 10)
    events = _collect(run_fanout(
        ad, k=2, max_targets=3, pool_factory=_pool_factory(),
    ))
    rpt = _report(events)
    assert rpt.claimed == 3 and rpt.succeeded == 3
    assert rpt.budget_capped is True
    assert rpt.exhausted is False  # 타깃이 남았는데 예산으로 멈춤 ≠ 소진


def test_fanout_zero_budget_no_claims(tmp_path):
    ad = FakeAdapter(tmp_path, 5)
    events = _collect(run_fanout(
        ad, k=2, max_targets=0, pool_factory=_pool_factory(),
    ))
    rpt = _report(events)
    assert rpt.claimed == 0 and ad.claim_calls == 0
    assert rpt.budget_capped is True
    assert len(events) == 1  # FanoutCompleted 만


# ── 타깃 = 1 turn (워커 계약 4) + judge streak 비간섭 ────────────────


def test_fanout_records_one_turn_per_target_streak_preserved(tmp_path, tmp_db):
    sid = state.chat_session_get_or_create()
    gid = state.goal_set(sid, goal_text="batch", max_turns=0)
    # 선행 judge parse fail 1회 — fanout 턴이 streak 을 건드리면 안 된다
    state.goal_record_turn(gid, verdict=None, reason=None, parse_fail=True)

    ad = FakeAdapter(tmp_path, 4)
    _collect(run_fanout(
        ad, k=2, goal_id=gid, pool_factory=_pool_factory(),
    ))
    g = state.goal_get_active(sid)
    assert g["turns_used"] == 1 + 4          # 타깃당 정확 1 turn
    assert g["parse_fail_streak"] == 1       # parse_fail=None 보존
    assert g["no_progress_streak"] == 0      # progress=None 보존
    assert "fanout fake" in (g["last_reason"] or "")


# ── 취소 ─────────────────────────────────────────────────────────────


def test_fanout_cancel_before_start(tmp_path):
    ad = FakeAdapter(tmp_path, 5)
    cancel = asyncio.Event()
    cancel.set()
    events = _collect(run_fanout(
        ad, k=2, cancel_event=cancel, pool_factory=_pool_factory(),
    ))
    rpt = _report(events)
    assert rpt.claimed == 0
    assert rpt.cancelled is True
    assert rpt.exhausted is False


def test_fanout_cancel_mid_run_yields_all_completions(tmp_path):
    """취소 후에도 이미 claim 된 완료는 전부 yield + release (claim 유실 0)."""
    cancel = asyncio.Event()

    class CancellingAdapter(FakeAdapter):
        async def release(self, target, completion, *, success):
            await super().release(target, completion, success=success)
            if len(self.released) == 2:
                cancel.set()

    ad = CancellingAdapter(tmp_path, 10)
    events = _collect(run_fanout(
        ad, k=2, cancel_event=cancel,
        pool_factory=_pool_factory(delay=0.05),
    ))
    rpt = _report(events)
    assert rpt.cancelled is True
    assert rpt.claimed < 10                  # 전부 claim 하기 전에 멈춤
    # 모든 claim 은 완료(성공/실패 무관)로 반납됨 — release 1회씩
    assert len(ad.released) == rpt.claimed
    workers = [ev for ev in events if isinstance(ev, WorkerCompleted)]
    assert len(workers) == rpt.claimed


# ── 어댑터 레지스트리 (재부착 plugin API) ────────────────────────────


def test_fanout_adapter_registry_roundtrip():
    name = "test-dom"
    try:
        register_fanout_adapter(name, lambda: None)  # type: ignore[arg-type]
        assert name in list_fanout_adapters()
        assert get_fanout_adapter_factory(name) is not None
        with pytest.raises(ValueError, match="이미 등록"):
            register_fanout_adapter(name, lambda: None)  # type: ignore[arg-type]
    finally:
        assert unregister_fanout_adapter(name) is True
    assert get_fanout_adapter_factory(name) is None
    assert unregister_fanout_adapter(name) is False


# ── ASK-1: 워커 완료 관측 훅 ─────────────────────────────────────────


def _run_with_observer(ad, observer, **kw):
    """observer 등록 → run_fanout 실행 → 반드시 해제 (누수 방지)."""
    register_worker_completion_observer(observer)
    try:
        return _collect(run_fanout(ad, **kw))
    finally:
        assert unregister_worker_completion_observer(observer) is True


def test_observer_fires_once_per_valid_completion(tmp_path):
    seen: list[tuple[str, bool]] = []

    def obs(target, spec, completion, ok):
        # 인자 계약: target=claim 핸들, spec==completion.spec, ok=success 판정
        assert isinstance(target, FanoutTarget)
        assert spec is completion.spec
        assert isinstance(completion, WorkerCompletion)
        assert target.label == spec.label
        seen.append((spec.label, ok))

    ad = FakeAdapter(tmp_path, 4)
    _run_with_observer(ad, obs, k=2, pool_factory=_pool_factory())

    assert sorted(seen) == [(f"t{i}", True) for i in range(4)]  # 완료당 1회


def test_observer_fires_on_invalid_missing_completion(tmp_path):
    """worker_result 누락(fail-closed)도 completion 이다 — observer 발화 + ok=False."""
    seen: list[tuple[str, bool, object]] = []

    def obs(target, spec, completion, ok):
        seen.append((spec.label, ok, completion.result))

    ad = FakeAdapter(tmp_path, 3)
    _run_with_observer(
        ad, obs, k=2, pool_factory=_pool_factory(silent_labels={"t1"}),
    )

    assert len(seen) == 3                       # 3 completion 전부
    bad = [row for row in seen if not row[1]]
    assert len(bad) == 1 and bad[0][0] == "t1"
    assert isinstance(bad[0][2], WorkerResultInvalid)
    assert bad[0][2].reason == "missing"
    good = [row for row in seen if row[1]]
    assert all(isinstance(r[2], WorkerResult) for r in good)


def test_observer_not_fired_on_build_spec_failure(tmp_path):
    """spec build 예외는 completion 이 아니다(워커 미기동) — observer 발화 안 함."""
    seen: list[str] = []
    ad = FakeAdapter(tmp_path, 4, build_fail={"t2"})
    _run_with_observer(
        ad, lambda t, s, c, ok: seen.append(s.label),
        k=2, pool_factory=_pool_factory(),
    )
    # t2 는 build 실패로 completion 이 없다 → observer 는 나머지 3개만.
    assert sorted(seen) == ["t0", "t1", "t3"]


def test_observer_exception_isolated(tmp_path):
    """observer 예외는 삼켜지고, 다른 observer 는 계속 발화 + fan-out 정상 완료."""
    good_seen: list[str] = []

    def boom(target, spec, completion, ok):
        raise RuntimeError("observer boom")

    def good(target, spec, completion, ok):
        good_seen.append(spec.label)

    register_worker_completion_observer(boom)
    register_worker_completion_observer(good)
    try:
        ad = FakeAdapter(tmp_path, 3)
        events = _collect(run_fanout(ad, k=2, pool_factory=_pool_factory()))
    finally:
        assert unregister_worker_completion_observer(boom) is True
        assert unregister_worker_completion_observer(good) is True

    rpt = _report(events)
    assert rpt.succeeded == 3 and rpt.failed == 0   # 관측 예외 ≠ 워커 실패
    assert sorted(good_seen) == ["t0", "t1", "t2"]  # 예외 observer 옆에서도 발화


def test_observer_registry_idempotent_and_unregister():
    calls: list[str] = []

    def obs(target, spec, completion, ok):
        calls.append(spec.label)

    register_worker_completion_observer(obs)
    register_worker_completion_observer(obs)  # 재등록은 무시(idempotent)
    # 한 번만 해제하면 완전히 사라져야 한다 (중복 등록 안 됨의 방증)
    assert unregister_worker_completion_observer(obs) is True
    assert unregister_worker_completion_observer(obs) is False


def test_no_observer_registered_is_noop(tmp_path):
    """observer 0개면 기존 스위트와 동일 — run_fanout 정상 종료."""
    ad = FakeAdapter(tmp_path, 3)
    events = _collect(run_fanout(ad, k=2, pool_factory=_pool_factory()))
    rpt = _report(events)
    assert rpt.succeeded == 3 and rpt.exhausted is True


def test_observer_fires_before_release(tmp_path):
    """ASK-1 '분류 직후, release 와 독립적으로' — observe 가 release 보다 먼저."""
    order: list[tuple[str, str]] = []

    class OrderAdapter(FakeAdapter):
        async def release(self, target, completion, *, success):
            order.append(("release", target.label))
            await super().release(target, completion, success=success)

    def obs(target, spec, completion, ok):
        order.append(("observe", spec.label))

    ad = OrderAdapter(tmp_path, 2)
    # k=1 로 라벨별 순서를 결정론화
    _run_with_observer(ad, obs, k=1, pool_factory=_pool_factory())
    for label in ("t0", "t1"):
        assert order.index(("observe", label)) < order.index(("release", label))


def test_observer_and_release_survive_goal_record_raise(tmp_path, tmp_db, monkeypatch):
    """goal_record_turn(DB) 예외로 루프가 끊겨도 그 전에 ① observer 발화 +
    ② claim release 가 완료된다 — notify 는 bookkeeping 앞, release 는 finally
    라 관측됨↔미반납 불일치가 없다(codex R2)."""
    seen: list[str] = []

    def obs(target, spec, completion, ok):
        seen.append(spec.label)

    def _boom(*a, **kw):
        raise RuntimeError("db down")

    monkeypatch.setattr(state, "goal_record_turn", _boom)
    sid = state.chat_session_get_or_create()
    gid = state.goal_set(sid, goal_text="batch", max_turns=0)

    ad = FakeAdapter(tmp_path, 3)
    register_worker_completion_observer(obs)
    try:
        with pytest.raises(RuntimeError, match="db down"):
            _collect(run_fanout(ad, k=1, goal_id=gid, pool_factory=_pool_factory()))
    finally:
        assert unregister_worker_completion_observer(obs) is True
    # 첫 completion 은 goal_record_turn 이 터지기 전에 관측됐고(관측 1회),
    assert seen == ["t0"]
    # finally 덕분에 그 claim 도 반드시 반납됐다(관측됐는데 미반납 창 없음).
    assert ad.released == [("t0", True)]


def test_observer_cancellederror_isolated(tmp_path):
    """observer 가 CancelledError(BaseException) 를 던져도 fan-out 무영향."""
    def boom(target, spec, completion, ok):
        raise asyncio.CancelledError()

    ad = FakeAdapter(tmp_path, 2)
    events = _run_with_observer(ad, boom, k=2, pool_factory=_pool_factory())
    rpt = _report(events)
    assert rpt.succeeded == 2 and rpt.failed == 0


def test_observer_registry_uses_identity_not_equality(tmp_path):
    """중복 판정은 `is` — 값이 같은 서로 다른 인스턴스는 둘 다 등록·발화."""
    calls: list[str] = []

    @dataclass(frozen=True)
    class EqObs:
        tag: str = "x"

        def __call__(self, target, spec, completion, ok):
            calls.append(self.tag + spec.label)

    a = EqObs()
    b = EqObs()
    assert a == b and a is not b       # 값 같음, 정체성 다름

    register_worker_completion_observer(a)
    register_worker_completion_observer(b)  # == a 지만 is 다름 → 둘 다 등록
    try:
        _collect(run_fanout(
            FakeAdapter(tmp_path, 1), k=1, pool_factory=_pool_factory(),
        ))
    finally:
        assert unregister_worker_completion_observer(a) is True
        assert unregister_worker_completion_observer(b) is True
    # ==-기반이면 b 미등록 → 1회. is-기반이라 두 observer 각각 1회 = 2.
    assert calls.count("xt0") == 2
