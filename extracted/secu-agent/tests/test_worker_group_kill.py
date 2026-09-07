"""F5-C: 워커 프로세스그룹 격리 — 취소/backstop 시 chromium 손자까지 회수.

워커를 start_new_session 으로 격리 세션/그룹 리더로 만들고, 종료 시 **검증된**
그룹에만 killpg 를 보내 손자(chromium)까지 함께 회수한다. 검증 실패 시 killpg 를
안 해 부모/풀·PID재사용 오살을 막는다(codex 합심 리뷰: 검증된 PGID 에만 killpg).
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import time

import pytest

# tools 를 먼저 로드해 worker_pool 의 기존 순환 임포트(단독 임포트 시)를 회피.
import secu_agent.agent.tools  # noqa: F401
from secu_agent.agent import worker_pool
from secu_agent.agent.worker_pool import (
    WorkerPool,
    WorkerResultInvalid,
    WorkerSpec,
    _proc_starttime,
)

posix_only = pytest.mark.skipif(
    os.name != "posix", reason="process-group kill 은 POSIX 전용",
)

# 워커: SIGTERM 무시 + 같은 그룹의 손자(역시 SIGTERM 무시)를 띄운다.
# 손자는 start_new_session 없이 떠서 워커의 세션/그룹을 상속한다.
_STUBBORN_WITH_GRANDCHILD = """
import pathlib, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
d = pathlib.Path(sys.argv[1])
gc = subprocess.Popen([sys.executable, "-c",
    "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(120)"])
(d / "grandchild_pid").write_text(str(gc.pid))
(d / "ready").write_text("1")
time.sleep(120)
"""

# 리더는 SIGTERM 에 **즉시 종료**하지만 손자(chromium 대역)는 SIGTERM 을 무시하고
# 남는다 — codex 리뷰 #2 의 잔여 누수 케이스. 그룹-소멸 grace 로 회수돼야 한다.
_GRACEFUL_LEADER_STUBBORN_GRANDCHILD = """
import pathlib, signal, subprocess, sys, time
d = pathlib.Path(sys.argv[1])
gc = subprocess.Popen([sys.executable, "-c",
    "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(120)"])
(d / "grandchild_pid").write_text(str(gc.pid))
signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))  # 리더는 TERM 에 즉시 종료
(d / "ready").write_text("1")
time.sleep(120)
"""


def _mkspec(tmp_path, name, code, **kw) -> WorkerSpec:
    d = tmp_path / name
    d.mkdir()
    return WorkerSpec(
        label=name, argv=(sys.executable, "-c", code, str(d)),
        evidence_dir=d, **kw,
    )


def _queue_next(specs):
    def nxt():
        return specs.pop(0) if specs else None
    return nxt


async def _wait_for_file(path, timeout: float = 15.0) -> None:
    async with asyncio.timeout(timeout):
        while not path.exists():
            await asyncio.sleep(0.02)


def _alive(pid: int) -> bool:
    """실행 중(running)이면 True. zombie/부재는 _proc_starttime 이 None."""
    return _proc_starttime(pid) is not None


@posix_only
def test_isolated_group_leader_gate():
    # 우리(부모/풀) 그룹의 자식은 리더가 아니다 → False → killpg 금지(우리 그룹 오살 방지).
    p = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])
    try:
        assert worker_pool._is_isolated_group_leader(p.pid) is False
    finally:
        p.kill()
        p.wait()
    # start_new_session 자식 = 격리 세션/그룹 리더(pid==pgid==sid) → True.
    p2 = subprocess.Popen(
        [sys.executable, "-c", "import time;time.sleep(30)"],
        start_new_session=True,
    )
    try:
        assert worker_pool._is_isolated_group_leader(p2.pid) is True
        # starttime 불일치면 False (PID 재사용 차단).
        assert worker_pool._is_isolated_group_leader(
            p2.pid, starttime=(_proc_starttime(p2.pid) or 0) + 999,
        ) is False
    finally:
        p2.kill()
        p2.wait()
    # 부재 pid → False.
    assert worker_pool._is_isolated_group_leader(2_000_000_000) is False


@posix_only
def test_cancel_kills_stubborn_grandchild_via_group(tmp_path):
    # 워커(리더)가 SIGTERM 무시 → grace 초과 → 그룹 SIGKILL → 워커+손자 동시 사망.
    spec = _mkspec(tmp_path, "gc", _STUBBORN_WITH_GRANDCHILD)
    pool = WorkerPool(1, term_grace_sec=0.3)
    gc_pid_file = spec.evidence_dir / "grandchild_pid"

    async def go():
        async def cancel_when_ready():
            await _wait_for_file(spec.evidence_dir / "ready")
            pool.cancel()
        watcher = asyncio.create_task(cancel_when_ready())
        out = [c async for c in pool.run(_queue_next([spec]))]
        await watcher
        return out

    out = asyncio.run(go())
    gpid = int(gc_pid_file.read_text())

    assert len(out) == 1
    assert out[0].outcome == "cancelled"
    assert out[0].rc == -9  # grace 초과 → (그룹) SIGKILL
    assert isinstance(out[0].result, WorkerResultInvalid)

    # 손자(chromium 대역)가 그룹 SIGKILL 로 사망해야 한다 — 고아로 안 남는다.
    # init 이 reap 할 시간을 준다(SIGKILL 후 zombie→reaped).
    deadline = time.monotonic() + 5.0
    while _alive(gpid) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _alive(gpid), f"손자 {gpid} 가 그룹 회수 안 됨 (고아 누수)"


@posix_only
def test_grace_group_death_reaps_grandchild_when_leader_exits_first(tmp_path):
    # codex 리뷰 #2: 리더가 TERM 에 먼저 죽고 손자만 TERM 무시 → 그룹-소멸 grace 로
    # 손자를 회수해야 한다(예전엔 group SIGKILL 을 건너뛰어 chromium 이 고아로 남았다).
    spec = _mkspec(tmp_path, "gl", _GRACEFUL_LEADER_STUBBORN_GRANDCHILD)
    pool = WorkerPool(1, term_grace_sec=0.5)
    gc_pid_file = spec.evidence_dir / "grandchild_pid"

    async def go():
        async def cancel_when_ready():
            await _wait_for_file(spec.evidence_dir / "ready")
            pool.cancel()
        watcher = asyncio.create_task(cancel_when_ready())
        out = [c async for c in pool.run(_queue_next([spec]))]
        await watcher
        return out

    out = asyncio.run(go())
    gpid = int(gc_pid_file.read_text())

    assert len(out) == 1
    # 손자가 그룹-소멸 grace 로 회수돼야 한다.
    deadline = time.monotonic() + 5.0
    while _alive(gpid) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _alive(gpid), (
        f"리더 선종료 케이스에서 손자 {gpid} 회수 실패 — 그룹-소멸 grace 미작동"
    )
