"""v3.80 Slice1: WorkerPool — 롤링 풀/backstop/SIGTERM→SIGKILL/PID 추적.

2계층:
- 실프로세스 (sys.executable -c …): 시그널 시맨틱 — SIGTERM grace 안의
  error_cancel 기록, SIG_IGN 워커의 SIGKILL, backstop timeout, 고아 정리.
- FakeWorker (create_subprocess 주입, F11 패턴): 롤링/동시성 캡/claim 순차성
  /None 비영구 재질의 같은 루프 로직.

핵심 invariant: spawn 된(또는 claim 후 spawn 못 한) spec 1개당
WorkerCompletion 정확 1개 — 부모의 claim 해제/goal_record_turn 이 여기 걸림.
worker_result.json 스키마 자체는 test_worker_result.py 가 고정.
"""
from __future__ import annotations

import asyncio
import itertools
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from secu_agent.agent import worker_pool
from secu_agent.agent.schema.worker_result import (
    WorkerResult,
    WorkerResultInvalid,
)
from secu_agent.agent.worker_pool import (
    WorkerCompletion,
    WorkerPool,
    WorkerSpec,
    reap_orphan_workers,
)

# ── 실워커 스크립트 (python -c, sys.argv[1] = evidence_dir) ──────────

_OK_WORKER = """
import json, pathlib, sys
d = pathlib.Path(sys.argv[1])
(d / "worker_result.json").write_text(json.dumps({
    "rc": 0, "status": "ok", "summary": "done", "findings_count": 1,
    "turns_used": 1, "tokens_in": 3, "tokens_out": 2, "evidence_paths": []}))
"""

_CRASH_NO_RESULT = "import sys; sys.exit(3)"

_GARBAGE_RESULT = """
import pathlib, sys
pathlib.Path(sys.argv[1], "worker_result.json").write_text("not-json{{{")
"""

# SIGTERM 을 받아 grace 안에 error_cancel 을 기록하고 143 으로 종료 —
# CONTRACTS.md 워커 계약 3·5 의 워커측 절반.
_GRACEFUL_SLEEPER = """
import json, pathlib, signal, sys, time
d = pathlib.Path(sys.argv[1])
def onterm(signum, frame):
    (d / "worker_result.json").write_text(json.dumps({
        "rc": 143, "status": "error_cancel", "summary": "cancel 수신",
        "findings_count": 0, "turns_used": 0, "tokens_in": 0,
        "tokens_out": 0, "evidence_paths": []}))
    sys.exit(143)
signal.signal(signal.SIGTERM, onterm)
(d / "ready").write_text("1")
time.sleep(60)
"""

_STUBBORN_SLEEPER = """
import pathlib, signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
pathlib.Path(sys.argv[1], "ready").write_text("1")
time.sleep(60)
"""

_PLAIN_SLEEPER = """
import pathlib, sys, time
pathlib.Path(sys.argv[1], "ready").write_text("1")
time.sleep(60)
"""


def _mkspec(tmp_path: Path, name: str, code: str, **kw) -> WorkerSpec:
    d = tmp_path / name
    d.mkdir()
    return WorkerSpec(
        label=name, argv=(sys.executable, "-c", code, str(d)),
        evidence_dir=d, **kw,
    )


def _queue_next(specs: list[WorkerSpec]):
    def nxt():
        return specs.pop(0) if specs else None
    return nxt


def _collect(pool: WorkerPool, next_spec) -> list[WorkerCompletion]:
    async def go():
        return [c async for c in pool.run(next_spec)]
    return asyncio.run(go())


async def _wait_for_file(path: Path, timeout: float = 10.0) -> None:
    async with asyncio.timeout(timeout):
        while not path.exists():
            await asyncio.sleep(0.02)


# ── FakeWorker (create_subprocess 주입) ──────────────────────────────

_VALID_PAYLOAD = {
    "rc": 0, "status": "ok", "summary": "fake done", "findings_count": 0,
    "turns_used": 1, "tokens_in": 1, "tokens_out": 1, "evidence_paths": [],
}

_fake_pids = itertools.count(90001)


class _FakeProc:
    """argv[-1] 을 evidence_dir 로 받아, wait() 끝에 유효 결과를 쓴다."""

    def __init__(self, ev_dir: Path, delay: float, rec: dict | None):
        self.pid = next(_fake_pids)
        self.returncode: int | None = None
        self._ev = ev_dir
        self._delay = delay
        self._rec = rec

    async def wait(self) -> int:
        try:
            await asyncio.sleep(self._delay)
            (self._ev / "worker_result.json").write_text(
                json.dumps(_VALID_PAYLOAD), encoding="utf-8",
            )
            self.returncode = 0
            return 0
        finally:
            if self._rec is not None:
                self._rec["cur"] -= 1

    def terminate(self) -> None:
        self.returncode = -15

    def kill(self) -> None:
        self.returncode = -9


def _make_fake_create(rec: dict | None = None, delay: float = 0.03):
    async def create(*argv, **kw):
        if rec is not None:
            rec["cur"] += 1
            rec["max"] = max(rec["max"], rec["cur"])
        return _FakeProc(Path(argv[-1]), delay, rec)
    return create


def _fake_spec(tmp_path: Path, name: str, **kw) -> WorkerSpec:
    d = tmp_path / name
    d.mkdir()
    return WorkerSpec(
        label=name, argv=("fake-worker", str(d)), evidence_dir=d, **kw,
    )


# ── 생성자/사용 계약 ─────────────────────────────────────────────────


@pytest.mark.parametrize("k", [0, -1])
def test_k_must_be_positive(k):
    with pytest.raises(ValueError, match="k"):
        WorkerPool(k)


def test_empty_argv_rejected(tmp_path):
    with pytest.raises(ValueError, match="argv"):
        WorkerSpec(label="x", argv=(), evidence_dir=tmp_path)


def test_run_is_single_use():
    pool = WorkerPool(1)
    assert _collect(pool, lambda: None) == []

    async def again():
        async for _ in pool.run(lambda: None):
            pass
    with pytest.raises(RuntimeError, match="1회용"):
        asyncio.run(again())


def test_empty_queue_returns_immediately():
    calls = []

    def nxt():
        calls.append(1)
        return None

    assert _collect(WorkerPool(3), nxt) == []
    # k=3 이어도 첫 None 에서 fill 중단 — 슬롯 수만큼 재질의하지 않는다
    assert len(calls) == 1


# ── 실프로세스: 정상/실패 종료 ──────────────────────────────────────


def test_ok_worker_end_to_end(tmp_path):
    spec = _mkspec(tmp_path, "ok", _OK_WORKER, payload={"target": "10.0.0.1"})
    (out,) = _collect(WorkerPool(1), _queue_next([spec]))
    assert out.outcome == "exited"
    assert out.rc == 0
    assert isinstance(out.result, WorkerResult)
    assert out.result.status == "ok"
    assert out.result.findings_count == 1
    assert out.pid is not None and out.pid > 0
    # payload 패스스루 — 부모 claim 핸들이 그대로 돌아온다
    assert out.spec.payload == {"target": "10.0.0.1"}


def test_crash_without_result_is_fail_closed(tmp_path):
    spec = _mkspec(tmp_path, "crash", _CRASH_NO_RESULT)
    (out,) = _collect(WorkerPool(1), _queue_next([spec]))
    assert out.outcome == "exited"
    assert out.rc == 3
    assert isinstance(out.result, WorkerResultInvalid)
    assert out.result.reason == "missing"


def test_garbage_result_is_fail_closed_parse(tmp_path):
    spec = _mkspec(tmp_path, "garbage", _GARBAGE_RESULT)
    (out,) = _collect(WorkerPool(1), _queue_next([spec]))
    assert out.outcome == "exited"
    assert isinstance(out.result, WorkerResultInvalid)
    assert out.result.reason == "parse"


def test_spawn_failure_yields_completion(tmp_path):
    d = tmp_path / "nospawn"
    d.mkdir()
    spec = WorkerSpec(
        label="nospawn", argv=("/nonexistent-binary-xyz-12345",),
        evidence_dir=d,
    )
    (out,) = _collect(WorkerPool(1), _queue_next([spec]))
    assert out.outcome == "spawn_failed"
    assert out.rc is None and out.pid is None
    assert isinstance(out.result, WorkerResultInvalid)
    assert out.result.reason == "missing"
    assert "spawn 실패" in out.result.detail


def test_worker_stdout_goes_to_evidence_file_not_parent(tmp_path):
    code = "import sys; print('worker noise'); print('err noise', file=sys.stderr)"
    spec = _mkspec(tmp_path, "noisy", code)
    (out,) = _collect(WorkerPool(1), _queue_next([spec]))
    assert out.outcome == "exited"
    stdout_log = spec.evidence_dir / worker_pool.WORKER_STDOUT_LOG
    stderr_log = spec.evidence_dir / worker_pool.WORKER_STDERR_LOG
    assert "worker noise" in stdout_log.read_text()
    assert "err noise" in stderr_log.read_text()


# ── 실프로세스: backstop timeout / 취소 ─────────────────────────────


def test_backstop_timeout_sigterm(tmp_path):
    spec = _mkspec(tmp_path, "hang", _PLAIN_SLEEPER, timeout_sec=0.5)
    pool = WorkerPool(1, term_grace_sec=2.0)
    (out,) = _collect(pool, _queue_next([spec]))
    assert out.outcome == "backstop_timeout"
    assert out.rc == -15  # SIGTERM (기본 disposition — 핸들러 없음)
    assert isinstance(out.result, WorkerResultInvalid)
    assert out.result.reason == "missing"


def test_cancel_graceful_workers_record_error_cancel(tmp_path):
    s1 = _mkspec(tmp_path, "g1", _GRACEFUL_SLEEPER)
    s2 = _mkspec(tmp_path, "g2", _GRACEFUL_SLEEPER)
    pool = WorkerPool(2, term_grace_sec=5.0)
    after_cancel_calls = []
    specs = [s1, s2]

    def nxt():
        if pool.cancelled:
            after_cancel_calls.append(1)
        return specs.pop(0) if specs else None

    async def go():
        async def cancel_when_ready():
            await _wait_for_file(s1.evidence_dir / "ready")
            await _wait_for_file(s2.evidence_dir / "ready")
            pool.cancel()
        watcher = asyncio.create_task(cancel_when_ready())
        out = [c async for c in pool.run(nxt)]
        await watcher
        return out

    out = asyncio.run(go())
    assert len(out) == 2
    for c in out:
        assert c.outcome == "cancelled"
        assert c.rc == 143
        # grace 안에 기록한 error_cancel 은 유효한 부분 결과
        assert isinstance(c.result, WorkerResult)
        assert c.result.status == "error_cancel"
    assert not after_cancel_calls  # cancel 후 신규 claim 없음


def test_cancel_stubborn_worker_gets_sigkill(tmp_path):
    spec = _mkspec(tmp_path, "stubborn", _STUBBORN_SLEEPER)
    pool = WorkerPool(1, term_grace_sec=0.3)

    async def go():
        async def cancel_when_ready():
            await _wait_for_file(spec.evidence_dir / "ready")
            pool.cancel()
        watcher = asyncio.create_task(cancel_when_ready())
        out = [c async for c in pool.run(_queue_next([spec]))]
        await watcher
        return out

    (out,) = asyncio.run(go())
    assert out.outcome == "cancelled"
    assert out.rc == -9  # grace 초과 → SIGKILL
    assert isinstance(out.result, WorkerResultInvalid)
    assert out.result.reason == "missing"


def test_cancel_during_claim_returns_unspawned_completion(tmp_path):
    s1 = _mkspec(tmp_path, "first", _GRACEFUL_SLEEPER)
    s2 = _mkspec(tmp_path, "second", _GRACEFUL_SLEEPER)
    pool = WorkerPool(2, term_grace_sec=5.0)
    specs = [s1, s2]

    def nxt():
        if not specs:
            return None
        s = specs.pop(0)
        if s.label == "second":
            # claim 은 이미 일어난 뒤 cancel 도착 — spawn 없이 반납돼야 한다
            pool.cancel()
        return s

    out = _collect(pool, nxt)
    assert len(out) == 2
    by_label = {c.spec.label: c for c in out}
    unspawned = by_label["second"]
    assert unspawned.outcome == "cancelled"
    assert unspawned.pid is None and unspawned.rc is None
    assert isinstance(unspawned.result, WorkerResultInvalid)
    assert "spawn 생략" in unspawned.result.detail
    # 이미 떠 있던 first 도 취소 완료로 반납
    assert by_label["first"].outcome == "cancelled"


# ── FakeWorker: 롤링/동시성/claim 순차성 ────────────────────────────


def test_rolling_pool_caps_concurrency_and_completes_all(tmp_path):
    rec = {"cur": 0, "max": 0}
    specs = [_fake_spec(tmp_path, f"w{i}") for i in range(6)]
    pool = WorkerPool(2, create_subprocess=_make_fake_create(rec))
    out = _collect(pool, _queue_next(list(specs)))
    assert len(out) == 6
    assert rec["max"] == 2  # K 캡 준수 + 롤링 교체로 K 까지 채움
    assert all(isinstance(c.result, WorkerResult) for c in out)
    assert all(c.outcome == "exited" for c in out)


def test_next_spec_is_never_called_concurrently(tmp_path):
    state = {"in": False, "reentered": False}
    specs = [_fake_spec(tmp_path, f"w{i}") for i in range(4)]

    async def nxt():
        if state["in"]:
            state["reentered"] = True
        state["in"] = True
        await asyncio.sleep(0.01)  # 동시 진입이면 여기서 겹친다
        state["in"] = False
        return specs.pop(0) if specs else None

    out = _collect(WorkerPool(3, create_subprocess=_make_fake_create()), nxt)
    assert len(out) == 4
    assert not state["reentered"]


def test_none_from_next_spec_is_not_permanent(tmp_path):
    """None = '지금 없음' — 완료 후 재질의에서 새 spec 이 나오면 돈다
    (stale reclaim 으로 큐가 다시 차는 시나리오)."""
    s1 = _fake_spec(tmp_path, "s1")
    s2 = _fake_spec(tmp_path, "s2")
    handed = {"s1": False, "s2": False}
    s1_completed = {"v": False}

    def nxt():
        if not handed["s1"]:
            handed["s1"] = True
            return s1
        if s1_completed["v"] and not handed["s2"]:
            handed["s2"] = True
            return s2
        return None

    async def go():
        pool = WorkerPool(2, create_subprocess=_make_fake_create())
        out = []
        async for c in pool.run(nxt):
            out.append(c)
            if c.spec.label == "s1":
                s1_completed["v"] = True
        return out

    out = asyncio.run(go())
    assert sorted(c.spec.label for c in out) == ["s1", "s2"]


def test_next_spec_exception_drains_active_then_raises(tmp_path):
    """claim(next_spec) 예외 = 신규 claim 만 중단 — 활성 워커의 완료는 전부
    yield 된 뒤에야 예외가 재전파된다. 즉시 전파하면 이미 끝난 헌트의
    완료가 유실돼 stale reclaim 이 같은 타깃을 재점검한다 (리뷰 확정)."""
    s1 = _fake_spec(tmp_path, "s1")
    handed = {"v": False}

    def nxt():
        if not handed["v"]:
            handed["v"] = True
            return s1
        raise RuntimeError("claim DB down")

    async def go():
        pool = WorkerPool(2, create_subprocess=_make_fake_create())
        out = []
        with pytest.raises(RuntimeError, match="claim DB down"):
            async for c in pool.run(nxt):
                out.append(c)
        return out

    out = asyncio.run(go())
    # s1 의 완료는 예외 전에 정상 도착 (drain 보장)
    assert len(out) == 1
    assert out[0].spec.label == "s1"
    assert isinstance(out[0].result, WorkerResult)


def test_mixed_outcomes_one_completion_per_spec(tmp_path):
    """invariant: ok/crash/spawn_failed 혼재해도 spec 수 == 완료 수."""
    ok1 = _mkspec(tmp_path, "ok1", _OK_WORKER)
    crash = _mkspec(tmp_path, "crash", _CRASH_NO_RESULT)
    d = tmp_path / "nospawn"
    d.mkdir()
    nospawn = WorkerSpec(
        label="nospawn", argv=("/nonexistent-binary-xyz-12345",),
        evidence_dir=d,
    )
    ok2 = _mkspec(tmp_path, "ok2", _OK_WORKER)
    specs = [ok1, crash, nospawn, ok2]
    out = _collect(WorkerPool(2), _queue_next(list(specs)))
    assert len(out) == len(specs)
    assert {c.spec.label for c in out} == {s.label for s in specs}


# ── PID 추적 + 고아 정리 ────────────────────────────────────────────


def test_proc_starttime_of_self_is_int():
    import os
    assert isinstance(worker_pool._proc_starttime(os.getpid()), int)


def test_pid_registry_lifecycle(tmp_path):
    reg = tmp_path / "pids.json"
    spec = _mkspec(tmp_path, "tracked", _PLAIN_SLEEPER)
    pool = WorkerPool(1, term_grace_sec=2.0, pid_registry=reg)
    seen: dict = {}

    async def go():
        async def watch():
            await _wait_for_file(spec.evidence_dir / "ready")
            seen.update(json.loads(reg.read_text(encoding="utf-8")))
            pool.cancel()
        watcher = asyncio.create_task(watch())
        out = [c async for c in pool.run(_queue_next([spec]))]
        await watcher
        return out

    (out,) = asyncio.run(go())
    # 실행 중엔 (pid, starttime, label) 이 registry 에 있었고
    assert len(seen) == 1
    (entry,) = seen.values()
    assert isinstance(entry["starttime"], int)
    assert entry["label"] == "tracked"
    assert int(next(iter(seen))) == out.pid
    # 종료 후엔 비워져 파일 자체가 제거된다
    assert not reg.exists()


def test_reap_orphan_workers_kills_verified(tmp_path):
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        st = worker_pool._proc_starttime(p.pid)
        assert isinstance(st, int)
        reg = tmp_path / "pids.json"
        reg.write_text(
            json.dumps({str(p.pid): {"starttime": st, "label": "orphan"}}),
            encoding="utf-8",
        )
        killed = reap_orphan_workers(reg, grace_sec=3.0)
        assert killed == [p.pid]
        assert p.wait(timeout=5) == -15
        assert not reg.exists()
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()


def test_reap_orphan_sig_ign_escalates_to_sigkill(tmp_path):
    """SIGTERM 을 무시하는 고아는 grace 초과 후 SIGKILL — 이 분기가 죽으면
    SIG_IGN 고아가 영구 잔존한다 (리뷰 확정 갭)."""
    marker = tmp_path / "ign_ready"
    code = (
        "import pathlib, signal, sys, time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        f"pathlib.Path({str(marker)!r}).write_text('1')\n"
        "time.sleep(60)\n"
    )
    p = subprocess.Popen([sys.executable, "-c", code])
    try:
        deadline = time.monotonic() + 10.0
        while not marker.exists():
            assert time.monotonic() < deadline, "SIG_IGN 워커 기동 실패"
            time.sleep(0.02)
        st = worker_pool._proc_starttime(p.pid)
        reg = tmp_path / "pids.json"
        reg.write_text(
            json.dumps({str(p.pid): {"starttime": st, "label": "ign"}}),
            encoding="utf-8",
        )
        killed = reap_orphan_workers(reg, grace_sec=0.5)
        assert killed == [p.pid]
        assert p.wait(timeout=5) == -9  # SIGTERM 무시 → SIGKILL
        assert not reg.exists()
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()


def test_reap_orphan_skips_starttime_mismatch(tmp_path):
    """PID 재사용 보호 — starttime 불일치면 절대 kill 하지 않는다."""
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        st = worker_pool._proc_starttime(p.pid)
        reg = tmp_path / "pids.json"
        reg.write_text(
            json.dumps({str(p.pid): {"starttime": st + 12345, "label": "x"}}),
            encoding="utf-8",
        )
        assert reap_orphan_workers(reg, grace_sec=0.2) == []
        assert p.poll() is None  # 살아 있음
        assert not reg.exists()  # 파일은 정리
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()


def test_reap_orphan_missing_or_corrupt_registry_is_noop(tmp_path):
    assert reap_orphan_workers(tmp_path / "absent.json") == []
    bad = tmp_path / "bad.json"
    bad.write_text("not-json", encoding="utf-8")
    assert reap_orphan_workers(bad, grace_sec=0.1) == []
    assert not bad.exists()


# ── 조기 종료 (aclose) — 고아 방지 ──────────────────────────────────


def test_early_aclose_emergency_kills_remaining_workers(tmp_path):
    reg = tmp_path / "pids.json"
    fast = _mkspec(tmp_path, "fast", _OK_WORKER)
    slow = _mkspec(tmp_path, "slow", _PLAIN_SLEEPER)

    async def go():
        pool = WorkerPool(2, term_grace_sec=0.5, pid_registry=reg)
        gen = pool.run(_queue_next([fast, slow]))
        first = await gen.__anext__()
        await gen.aclose()  # 조기 종료 — 잔여 워커(slow) 비상 정리
        return first

    first = asyncio.run(go())
    assert first.spec.label == "fast"
    # slow 가 죽고 unregister 까지 끝나 registry 가 비워졌다 (고아 없음)
    assert not reg.exists()


# ── reap 배선: run() 기동 시 자기 registry 고아 1회 정리 ──────────────

def test_run_reaps_own_registry_at_startup(tmp_path, monkeypatch):
    """run() 은 첫 워커 spawn 前(= registry 새로 쓰기 前) pid_registry 의 고아를
    딱 1회 reap 한다 (reap_orphan_workers 계약 = 풀 가동 前 startup 전용)."""
    reg = tmp_path / "worker_pids.json"
    calls: list[Path] = []

    def _fake_reap(registry, *, grace_sec=5.0):
        calls.append(registry)
        return []

    monkeypatch.setattr(worker_pool, "reap_orphan_workers", _fake_reap)
    # 빈 큐 → 즉시 종료. reap 은 그 前에 실행된다.
    assert _collect(WorkerPool(1, pid_registry=reg), lambda: None) == []
    assert calls == [reg]


def test_run_skips_reap_when_no_registry(monkeypatch):
    """pid_registry 미설정(=PID 추적 off)이면 reap 을 호출하지 않는다."""
    calls: list[object] = []

    def _fake_reap(registry, *, grace_sec=5.0):
        calls.append(registry)
        return []

    monkeypatch.setattr(worker_pool, "reap_orphan_workers", _fake_reap)
    assert _collect(WorkerPool(1), lambda: None) == []
    assert calls == []


def test_run_reap_failure_does_not_block_task(tmp_path, monkeypatch):
    """reap 이 예외를 던져도 헌트(run)는 정상 진행한다 (백스톱)."""
    reg = tmp_path / "worker_pids.json"

    def _boom(registry, *, grace_sec=5.0):
        raise RuntimeError("reap explode")

    monkeypatch.setattr(worker_pool, "reap_orphan_workers", _boom)
    # 예외를 삼키고 빈 큐 종료까지 도달해야 한다.
    assert _collect(WorkerPool(1, pid_registry=reg), lambda: None) == []
