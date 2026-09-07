"""process_tool 라이프사이클/리소스 바운드 유닛 테스트 (v3.79-perf-cache).

검증 대상:
  (a) _PROCESS_REGISTRY 상한(SA_PROCESS_REGISTRY_MAX) + 종료 레코드 evict,
      실행 중 프로세스는 절대 조용히 버리지 않고 spawn 을 거부.
  (b) bg watcher 가 100ms busy-poll 대신 event-driven proc.wait() 를 사용,
      spawn 직후 stdin PIPE 를 닫는지.

실제 subprocess/network/sleep/DB 없이 fake 로만 구동한다.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from secu_agent.agent.tools import process_tool
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.agent.tools.process_tool import (
    ProcessInput,
    ProcessRecord,
    ProcessTool,
    _evict_terminated_locked,
    _registry_max,
    _watch_to_completion,
)


class _FakeStdin:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _FakeHandle:
    def __init__(self) -> None:
        self.closed = False

    def flush(self) -> None:  # pragma: no cover - trivial
        pass

    def close(self) -> None:
        self.closed = True


class _FakeProc:
    """subprocess.Popen 대역. poll()/wait()/kill() 만 흉내."""

    def __init__(self, *, running: bool = True, returncode: int = 0,
                 has_stdin: bool = True, exit_after_polls: int | None = None) -> None:
        self._running = running
        self._final_rc = returncode
        self.returncode = None if running else returncode
        self.stdin = _FakeStdin() if has_stdin else None
        self.killed = False
        self.wait_calls = 0
        # >0 이면 그만큼 poll() 을 None 으로 돌려준 뒤 종료를 모사(backoff-poll watcher용).
        self._exit_after_polls = exit_after_polls
        self._poll_count = 0

    def poll(self):
        if self._exit_after_polls is not None and self._running:
            self._poll_count += 1
            if self._poll_count > self._exit_after_polls:
                self._running = False
                self.returncode = self._final_rc
        return None if self._running else self._final_rc

    def kill(self) -> None:
        self.killed = True
        self._running = False
        self.returncode = self._final_rc

    def wait(self, timeout=None):
        self.wait_calls += 1
        self._running = False
        self.returncode = self._final_rc
        return self._final_rc


def _make_record(proc: _FakeProc, output_path: Path, pid: str) -> ProcessRecord:
    return ProcessRecord(
        process_id=pid,
        command="sleep 1",
        cwd=output_path.parent,
        output_path=output_path,
        proc=proc,
        output_handle=_FakeHandle(),
        started_at=0.0,
    )


@pytest.fixture(autouse=True)
def _clean_registry():
    process_tool._PROCESS_REGISTRY.clear()
    yield
    process_tool._PROCESS_REGISTRY.clear()


# ---------------------------------------------------------------- (a) helpers

def test_registry_max_default_and_env(monkeypatch):
    monkeypatch.delenv("SA_PROCESS_REGISTRY_MAX", raising=False)
    assert _registry_max() == 64
    monkeypatch.setenv("SA_PROCESS_REGISTRY_MAX", "3")
    assert _registry_max() == 3
    # 비정상/음수 값은 안전 기본/최소로 폴백
    monkeypatch.setenv("SA_PROCESS_REGISTRY_MAX", "not-an-int")
    assert _registry_max() == 64
    monkeypatch.setenv("SA_PROCESS_REGISTRY_MAX", "0")
    assert _registry_max() == 1


def test_evict_terminated_only(tmp_path):
    running = _make_record(_FakeProc(running=True), tmp_path / "r.log", "run")
    dead = _make_record(_FakeProc(running=False, returncode=0), tmp_path / "d.log", "dead")
    process_tool._PROCESS_REGISTRY["run"] = running
    process_tool._PROCESS_REGISTRY["dead"] = dead

    removed = _evict_terminated_locked()

    assert removed == 1
    assert "dead" not in process_tool._PROCESS_REGISTRY
    # 실행 중인 것은 절대 evict 되지 않는다
    assert "run" in process_tool._PROCESS_REGISTRY


# ------------------------------------------------------------- (a) start path

def _ctx(tmp_path: Path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path)


def test_start_rejects_when_cap_full_all_running_and_kills_new(tmp_path, monkeypatch):
    """cap 도달 + 전부 실행 중이면 새 spawn 을 거부하고, 방금 띄운 proc 를 정리한다.

    live 로 추적 중인 프로세스를 조용히 버리지 않는다는 보장이 핵심.
    """
    monkeypatch.setenv("SA_PROCESS_REGISTRY_MAX", "1")
    # 이미 실행 중인 레코드 1개로 cap 채움
    incumbent = _make_record(_FakeProc(running=True), tmp_path / "inc.log", "inc")
    process_tool._PROCESS_REGISTRY["inc"] = incumbent

    spawned: list[_FakeProc] = []

    def _fake_popen(*args, **kwargs):
        p = _FakeProc(running=True)
        spawned.append(p)
        return p

    monkeypatch.setattr(process_tool.subprocess, "Popen", _fake_popen)

    tool = ProcessTool()
    vi = ProcessInput(action="start", command="sleep 100")
    result = asyncio.run(tool._start(vi, _ctx(tmp_path)))

    assert isinstance(result, ToolError)
    assert result.kind == "resource_exhausted"
    # incumbent(live) 는 그대로 추적된다
    assert "inc" in process_tool._PROCESS_REGISTRY
    assert len(process_tool._PROCESS_REGISTRY) == 1
    # 방금 띄운 프로세스는 leak 방지를 위해 kill + stdin close 됨
    assert spawned and spawned[0].killed is True
    assert spawned[0].stdin.closed is True


def test_start_evicts_terminated_to_make_room(tmp_path, monkeypatch):
    """cap 도달이어도 종료된 레코드가 있으면 evict 해서 새 spawn 을 수용."""
    monkeypatch.setenv("SA_PROCESS_REGISTRY_MAX", "1")
    dead = _make_record(_FakeProc(running=False, returncode=0), tmp_path / "d.log", "dead")
    process_tool._PROCESS_REGISTRY["dead"] = dead

    def _fake_popen(*args, **kwargs):
        return _FakeProc(running=True)

    monkeypatch.setattr(process_tool.subprocess, "Popen", _fake_popen)

    tool = ProcessTool()
    vi = ProcessInput(action="start", command="sleep 100")
    result = asyncio.run(tool._start(vi, _ctx(tmp_path)))

    assert isinstance(result, ToolSuccess)
    assert "dead" not in process_tool._PROCESS_REGISTRY
    assert len(process_tool._PROCESS_REGISTRY) == 1


def test_start_closes_stdin_pipe(tmp_path, monkeypatch):
    """spawn 직후 미사용 stdin PIPE 를 release/close 한다."""
    monkeypatch.delenv("SA_PROCESS_REGISTRY_MAX", raising=False)
    holder: list[_FakeProc] = []

    def _fake_popen(*args, **kwargs):
        p = _FakeProc(running=True)
        holder.append(p)
        return p

    monkeypatch.setattr(process_tool.subprocess, "Popen", _fake_popen)

    tool = ProcessTool()
    vi = ProcessInput(action="start", command="sleep 100")
    result = asyncio.run(tool._start(vi, _ctx(tmp_path)))

    assert isinstance(result, ToolSuccess)
    assert holder and holder[0].stdin.closed is True


# ----------------------------------------------------------- (b) event-driven watcher

def test_watch_to_completion_detects_exit_and_emits(tmp_path):
    """watcher 는 고정 10Hz 스핀도 스레드-park 도 아닌 backoff poll 로 종료를 감지하고
    completion 을 drop 한다. exit_after_polls=1 → 첫 poll None, 다음 poll 에서 종료."""
    proc = _FakeProc(running=True, returncode=0, exit_after_polls=1)
    output_path = tmp_path / "w.log"
    output_path.write_bytes(b"hello world\n")
    record = _make_record(proc, output_path, "watch")
    record.session_id = None  # DB 경로 스킵

    emitted: list[tuple] = []
    process_tool.subscribe_bg_completion(lambda r, p: emitted.append((r, p)))
    try:
        asyncio.run(_watch_to_completion(record))
    finally:
        # 구독 해제 (전역 리스트 오염 방지)
        process_tool._BG_COMPLETION_SUBSCRIBERS.clear()

    # poll 로 종료가 관측됨 (스레드 park 없음). wait() 는 watcher 경로에서 안 부른다.
    assert proc.poll() is not None
    assert proc.wait_calls == 0
    assert record.completion_emitted is True
    # completion.json 이 evidence 로 drop 됨
    comp = output_path.with_suffix(".completion.json")
    assert comp.exists()
    assert emitted and emitted[0][1]["process_id"] == "watch"
    assert emitted[0][1]["exit_code"] == 0
