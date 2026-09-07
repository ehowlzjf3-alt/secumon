"""terminal_tool.execute() 스트리밍 read 회귀 테스트.

핵심: communicate() 로 자식 출력 전체를 메모리에 올린 뒤 절단하던 것을,
read 하는 동안 byte 예산을 강제하도록 바꾼 것을 검증한다 — 예산 초과 즉시
read 중단 + 프로세스 kill (기가바이트 유출 → OOM 방지). fake stream/proc 를
주입해 실제 subprocess/network/sleep 없이 결정론으로 확인한다.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from secu_agent.agent.tools import terminal_tool as tt
from secu_agent.agent.tools.base import ToolContext


class _FakeStream:
    """proc.stdout 대역. preset chunk 를 순서대로 반환, 소진 후 EOF(b"")."""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = list(chunks)
        self.reads = 0

    async def read(self, n: int) -> bytes:  # noqa: ARG002 - n 무시(fake)
        self.reads += 1
        if self._chunks:
            return self._chunks.pop(0)
        return b""


class _InfiniteStream:
    """절대 EOF 를 주지 않는 stream — 절단이 read 를 멈추지 못하면 테스트가 hang."""

    def __init__(self, chunk: bytes) -> None:
        self.chunk = chunk
        self.reads = 0

    async def read(self, n: int) -> bytes:  # noqa: ARG002
        self.reads += 1
        return self.chunk


class _FakeProc:
    def __init__(self, stdout: object, returncode: int = 0) -> None:
        self.stdout = stdout
        self.returncode = returncode
        self.killed = False

    def kill(self) -> None:
        self.killed = True

    async def wait(self) -> int:
        return self.returncode


def _ctx() -> ToolContext:
    return ToolContext(evidence_dir=Path.cwd())


def _patch_proc(monkeypatch: pytest.MonkeyPatch, proc: _FakeProc) -> None:
    async def _fake_create(*_a: object, **_k: object) -> _FakeProc:
        return proc

    monkeypatch.setattr(tt.asyncio, "create_subprocess_shell", _fake_create)


def test_normal_small_output_preserved(monkeypatch: pytest.MonkeyPatch) -> None:
    proc = _FakeProc(_FakeStream([b"hello\nworld\n"]), returncode=0)
    _patch_proc(monkeypatch, proc)
    tool = tt.TerminalTool()
    res = asyncio.run(tool.execute(tt.TerminalInput(command="echo hi"), _ctx()))
    assert res.type == "success"
    assert "hello\nworld" in res.content
    assert "exit=0" in res.content
    assert "truncated" not in res.content
    assert proc.killed is False


def test_oversized_output_truncated_without_full_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # limit 아래이지만 EOF 없는 stream: 절단이 동작해야만 read 가 멈춘다.
    limit = 1024
    stream = _InfiniteStream(b"x" * 2048)  # 첫 chunk 만으로 이미 limit 초과
    proc = _FakeProc(stream, returncode=0)
    _patch_proc(monkeypatch, proc)
    tool = tt.TerminalTool()
    res = asyncio.run(
        tool.execute(
            tt.TerminalInput(command="yes", output_limit_bytes=limit), _ctx()
        )
    )
    assert res.type == "success"
    # 첫 chunk 로 예산 초과 → 딱 한 번만 읽고 멈춘다(전체 소진 아님).
    assert stream.reads == 1
    # 예산 초과 시 프로세스를 죽여 유출 차단.
    assert proc.killed is True
    assert "truncated" in res.content
    assert f"(truncated at {limit} bytes)" in res.content
    # 반환 body 는 limit 로 절단 (header/suffix 제외 본문 길이 확인).
    body = res.content.split("\n---\n", 1)[1]
    body_only = body.split("\n... (truncated", 1)[0]
    assert len(body_only) == limit


def test_exact_limit_not_truncated(monkeypatch: pytest.MonkeyPatch) -> None:
    limit = 1024
    proc = _FakeProc(_FakeStream([b"y" * limit]), returncode=0)
    _patch_proc(monkeypatch, proc)
    tool = tt.TerminalTool()
    res = asyncio.run(
        tool.execute(
            tt.TerminalInput(command="cat f", output_limit_bytes=limit), _ctx()
        )
    )
    assert res.type == "success"
    assert "truncated" not in res.content
    assert proc.killed is False


def test_abort_signal_kills_and_returns_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stream = _InfiniteStream(b"x" * 4096)
    proc = _FakeProc(stream, returncode=0)
    _patch_proc(monkeypatch, proc)
    ctx = _ctx()
    ctx.signal.set()  # 시작 전에 이미 aborted
    tool = tt.TerminalTool()
    res = asyncio.run(tool.execute(tt.TerminalInput(command="sleep 999"), ctx))
    assert res.type == "error"
    assert res.kind == "cancelled"
    assert proc.killed is True
    assert stream.reads == 0  # abort 를 첫 read 전에 확인


class _BlockingStream:
    """read() 가 영영 반환하지 않는 stream — wait_for 의 실제 timeout 을 태운다.

    monotonic 을 monkeypatch 하지 않는다: tt.time.monotonic 은 곧 표준 time.monotonic
    이라, 패치하면 asyncio 이벤트루프 시계(loop.time)까지 오염돼 deadline 계산이
    깨진다(예전 버전의 결함). 대신 아주 짧은 실제 timeout 으로 결정론 검증한다.
    """

    def __init__(self) -> None:
        self.reads = 0

    async def read(self, n: int) -> bytes:  # noqa: ARG002
        self.reads += 1
        await asyncio.Event().wait()  # 영영 대기 → wait_for 가 timeout
        return b""


def test_timeout_path_kills_and_returns_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # read 가 blocking → 짧은 실제 timeout(50ms) 으로 timeout 분기를 태운다.
    stream = _BlockingStream()
    proc = _FakeProc(stream, returncode=0)
    _patch_proc(monkeypatch, proc)
    tool = tt.TerminalTool()
    res = asyncio.run(
        tool.execute(
            tt.TerminalInput(command="sleep 999", timeout_seconds=0.05), _ctx()
        )
    )
    assert res.type == "error"
    assert res.kind == "timeout"
    assert proc.killed is True  # timeout 시 프로세스 kill(_reap)
