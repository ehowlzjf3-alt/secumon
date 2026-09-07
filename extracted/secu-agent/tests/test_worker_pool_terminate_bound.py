"""v3.79-perf: _terminate 의 SIGKILL 후 최종 wait 이 bound 됐는지 검증.

문제: un-killable 워커(D-state/uninterruptible I/O — stuck NFS 등)는 SIGKILL
을 받고도 proc.wait() 이 영영 반환 안 한다. bound 없는 최종 await 은 풀
전체를 wedge 시킨다 (이후 완료 yield 불가 → 롤링 풀 정지).
수정: 최종 wait 을 SA_WORKER_KILL_WAIT_SEC 상한으로 bound, 초과 시 대기를
포기하고 proc.returncode(None 가능)로 진행 — spec 당 완료 1개 invariant 유지.

FakeWorker/실프로세스 없이 순수 단위 — _terminate(proc, waiter) 에
'절대 완료 안 하는' waiter future 를 직접 주입해 결정론적으로 검증.
"""
from __future__ import annotations

import asyncio

import pytest

from secu_agent.agent import worker_pool
from secu_agent.agent.worker_pool import WorkerPool, _worker_kill_wait_sec


class _DStateProc:
    """SIGTERM/SIGKILL 을 받아도 절대 안 죽는 워커 (uninterruptible I/O)."""

    def __init__(self, pid: int = 4242) -> None:
        self.returncode: int | None = None  # 영영 종료 안 함
        self.pid = pid
        self.terminated = False
        self.killed = False

    def terminate(self) -> None:
        self.terminated = True  # D-state — 시그널은 pending 상태로 남음

    def kill(self) -> None:
        self.killed = True  # 마찬가지로 즉시 reap 되지 않음


def _never_future() -> asyncio.Future:
    """proc.wait() 을 흉내 내는, 절대 완료되지 않는 future."""
    return asyncio.get_event_loop().create_future()


def test_terminate_bounds_final_wait_on_unkillable_worker(monkeypatch):
    """SIGKILL 후에도 waiter 가 안 끝나도 _terminate 는 bound 안에 반환한다."""
    monkeypatch.setenv("SA_WORKER_KILL_WAIT_SEC", "0.05")

    async def go():
        pool = WorkerPool(k=1, term_grace_sec=0.05)
        proc = _DStateProc()
        waiter = _never_future()
        # _terminate 자체를 넉넉한 상한으로 감싸 — 여기서 TimeoutError 가 나면
        # 그게 곧 '풀 wedge' 회귀 (수정 전 동작).
        rc = await asyncio.wait_for(pool._terminate(proc, waiter), timeout=5.0)
        return rc, proc, waiter

    rc, proc, waiter = asyncio.run(go())

    assert proc.terminated is True          # SIGTERM 보냄
    assert proc.killed is True              # grace 초과 → SIGKILL 보냄
    assert rc is None                       # 미회수 → returncode(None) 로 진행
    # 남은 waiter 는 정리돼 pending-task 경고를 남기지 않는다.
    assert waiter.cancelled()


def test_terminate_returns_rc_when_worker_exits_within_grace():
    """정상 경로: grace 안에 워커가 끝나면 SIGKILL 없이 rc 를 그대로 돌려준다."""

    async def go():
        pool = WorkerPool(k=1, term_grace_sec=5.0)
        proc = _DStateProc()
        waiter = asyncio.get_event_loop().create_future()
        # grace SIGTERM 직후 워커가 rc=0 으로 종료했다고 가정.
        proc.returncode = 0
        waiter.set_result(0)
        rc = await asyncio.wait_for(pool._terminate(proc, waiter), timeout=5.0)
        return rc, proc

    rc, proc = asyncio.run(go())
    assert rc == 0
    assert proc.killed is False             # SIGKILL 불필요


def test_kill_wait_sec_default_and_env_override(monkeypatch):
    """knob: 기본값 안전 + 양수 env override, 잘못된 값은 기본으로 폴백."""
    monkeypatch.delenv("SA_WORKER_KILL_WAIT_SEC", raising=False)
    assert _worker_kill_wait_sec() == worker_pool._WORKER_KILL_WAIT_DEFAULT
    assert _worker_kill_wait_sec() > 0

    monkeypatch.setenv("SA_WORKER_KILL_WAIT_SEC", "3.5")
    assert _worker_kill_wait_sec() == 3.5

    for bad in ("0", "-1", "abc", ""):
        monkeypatch.setenv("SA_WORKER_KILL_WAIT_SEC", bad)
        assert _worker_kill_wait_sec() == worker_pool._WORKER_KILL_WAIT_DEFAULT


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
