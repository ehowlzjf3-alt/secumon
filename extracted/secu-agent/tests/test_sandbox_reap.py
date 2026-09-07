"""sandbox 타임아웃 kill 후 좀비 reap + 파이프 drain/close 검증 (v3.79-perf-cache).

audit: 타임아웃 시 proc.kill() 만 하고 wait()/파이프 정리를 안 해 좀비·fd 누수.
fix: bounded reap (_reap_process) + SA_SANDBOX_REAP_TIMEOUT_SEC knob.

전부 fake Process 주입 — 실제 subprocess/network/sleep 없음.
"""
from __future__ import annotations

import asyncio

from secu_agent import sandbox
from secu_agent.sandbox import (
    AiSandboxRunner,
    SandboxConfig,
    _reap_process,
    _reap_timeout_sec,
)


class _FakeStream:
    async def read(self) -> bytes:  # pragma: no cover - drain fallback 용
        return b""


class FakeProc:
    """asyncio.subprocess.Process 흉내. 첫 communicate() 는 wait_for 타임아웃 모사."""

    def __init__(self) -> None:
        self.returncode: int | None = None
        self.kill_count = 0
        self.communicate_calls = 0
        self.wait_calls = 0
        self.stdout = _FakeStream()
        self.stderr = _FakeStream()

    def kill(self) -> None:
        self.kill_count += 1
        self.returncode = -9

    async def communicate(self) -> tuple[bytes, bytes]:
        self.communicate_calls += 1
        if self.communicate_calls == 1:
            # 첫 호출 = 메인 실행: wait_for 타임아웃을 흉내내 즉시 TimeoutError.
            raise asyncio.TimeoutError
        # 두번째 호출 = reap: 남은 출력 drain + 파이프 close + wait() reap.
        return b"", b""

    async def wait(self) -> int | None:
        self.wait_calls += 1
        return self.returncode


class NormalProc(FakeProc):
    """정상(비-타임아웃) 경로용 — 첫 communicate() 가 바로 출력 반환."""

    def __init__(self) -> None:
        super().__init__()
        self.returncode = 0

    async def communicate(self) -> tuple[bytes, bytes]:
        self.communicate_calls += 1
        return b"hello", b"warn"


def _runner(monkeypatch, proc, tmp_path) -> AiSandboxRunner:
    async def fake_exec(*a, **k):
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    cfg = SandboxConfig(sandbox_dir=tmp_path, enabled=True)
    return AiSandboxRunner(config=cfg)


def test_timeout_path_kills_and_reaps(monkeypatch, tmp_path):
    proc = FakeProc()
    runner = _runner(monkeypatch, proc, tmp_path)

    res = asyncio.run(
        runner._run_locked(
            file_path=tmp_path / "f.bin",
            command="x",
            timeout_sec=0.5,
            evidence_dir=tmp_path,
        )
    )

    assert res.timed_out is True
    assert res.exit_code == -1
    # kill 은 정확히 한 번, 그리고 reap 위해 communicate() 재호출(drain+close+wait).
    assert proc.kill_count == 1
    assert proc.communicate_calls == 2


def test_timeout_kill_already_dead_is_swallowed(monkeypatch, tmp_path):
    proc = FakeProc()

    def _raise_lookup() -> None:
        proc.kill_count += 1
        raise ProcessLookupError

    proc.kill = _raise_lookup  # type: ignore[method-assign]
    runner = _runner(monkeypatch, proc, tmp_path)

    # ProcessLookupError 가 전파되지 않고 reap 이 계속 진행되어야 한다.
    res = asyncio.run(
        runner._run_locked(
            file_path=tmp_path / "f.bin",
            command="x",
            timeout_sec=0.5,
            evidence_dir=tmp_path,
        )
    )
    assert res.timed_out is True
    assert proc.communicate_calls == 2


def test_normal_path_unchanged(monkeypatch, tmp_path):
    proc = NormalProc()
    runner = _runner(monkeypatch, proc, tmp_path)

    res = asyncio.run(
        runner._run_locked(
            file_path=tmp_path / "f.bin",
            command="x",
            timeout_sec=5.0,
            evidence_dir=tmp_path,
        )
    )

    assert res.timed_out is False
    assert res.exit_code == 0
    assert res.stdout == "hello"
    assert res.stderr == "warn"
    # 정상 경로에서는 kill/재-communicate 없음.
    assert proc.kill_count == 0
    assert proc.communicate_calls == 1


def test_reap_is_bounded_on_dstate_hang():
    """communicate 가 영원히 안 끝나도 reap_timeout 후 포기(무한대기 금지)."""

    class HangProc(FakeProc):
        async def communicate(self) -> tuple[bytes, bytes]:
            self.communicate_calls += 1
            await asyncio.Event().wait()  # 절대 반환 안 함 (D-state 모사)
            return b"", b""  # pragma: no cover

    proc = HangProc()
    # 작은 bound — wait_for 로 취소되어 즉시 복귀해야 한다 (행 걸리면 테스트가 hang).
    asyncio.run(_reap_process(proc, 0.02))
    assert proc.communicate_calls == 1


def test_reap_timeout_knob(monkeypatch):
    monkeypatch.delenv("SA_SANDBOX_REAP_TIMEOUT_SEC", raising=False)
    assert _reap_timeout_sec() == sandbox._DEFAULT_REAP_TIMEOUT_SEC

    monkeypatch.setenv("SA_SANDBOX_REAP_TIMEOUT_SEC", "5.5")
    assert _reap_timeout_sec() == 5.5

    # 잘못된/비양수 값 → 안전 기본.
    monkeypatch.setenv("SA_SANDBOX_REAP_TIMEOUT_SEC", "nope")
    assert _reap_timeout_sec() == sandbox._DEFAULT_REAP_TIMEOUT_SEC
    monkeypatch.setenv("SA_SANDBOX_REAP_TIMEOUT_SEC", "0")
    assert _reap_timeout_sec() == sandbox._DEFAULT_REAP_TIMEOUT_SEC
    monkeypatch.setenv("SA_SANDBOX_REAP_TIMEOUT_SEC", "-3")
    assert _reap_timeout_sec() == sandbox._DEFAULT_REAP_TIMEOUT_SEC
