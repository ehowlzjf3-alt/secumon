"""PythonExecTool 성능/자원 가드 (v3.79-perf-cache).

두 개선을 검증:
(a) execute() 가 event loop 를 블록하지 않고, timeout 은 await 경계에서 강제된다.
    - GIL 을 놓는 blocking 코드(time.sleep)를 전용 daemon thread 에서 돌리는 동안
      동시 코루틴(heartbeat)이 계속 tick 함을 확인 → loop 미블록 증명.
    - timeout 시 ToolError(kind="timeout") 반환(과거와 동일).
(b) stdout 이 상한 처리된다 — 기본 30_000자, SA_PYTHON_EXEC_MAX_OUTPUT 로 override.

DB 불필요(간단한 print/sleep 만). 실제 subprocess/network 없음.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.agent.tools import python_exec_tool as pex
from secu_agent.agent.tools.python_exec_tool import PythonExecTool


def _ctx(tmp_path: Path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path, metadata={})


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


# ── (a) event loop 미블록 + timeout ────────────────────────────


def test_timeout_returns_toolerror_kind_timeout(tmp_path):
    """GIL 을 놓는 blocking(time.sleep) 도 timeout 으로 끊기고 kind='timeout'."""
    res = _run(
        PythonExecTool(),
        {"code": "import time; time.sleep(30)", "timeout_seconds": 1},
        _ctx(tmp_path),
    )
    assert isinstance(res, ToolError), res
    assert res.kind == "timeout"
    assert "timeout" in res.message.lower()
    assert "(1s)" in res.message


def test_execute_does_not_block_event_loop(tmp_path):
    """blocking exec 이 도는 동안 동시 코루틴이 계속 tick — loop 미블록 증명."""

    async def _drive():
        tool = PythonExecTool()
        ctx = _ctx(tmp_path)
        ticks = 0

        async def heartbeat():
            nonlocal ticks
            for _ in range(200):
                await asyncio.sleep(0.02)
                ticks += 1

        hb = asyncio.create_task(heartbeat())
        # 1s timeout 동안 blocking sleep — 동기 실행이면 loop 이 얼어 tick=0.
        res = await tool.execute(
            tool.input_model(code="import time; time.sleep(30)", timeout_seconds=1),
            ctx,
        )
        hb.cancel()
        return res, ticks

    res, ticks = asyncio.run(_drive())
    assert isinstance(res, ToolError) and res.kind == "timeout"
    # ~1s / 0.02s ≈ 50 tick 가능. 동기 블록이었다면 0 이었을 것.
    assert ticks >= 5, f"event loop appears blocked (ticks={ticks})"


def test_normal_output_still_formatted(tmp_path):
    """개선 후에도 [stdout] / (no output) 포맷 보존."""
    res = _run(PythonExecTool(), {"code": "print('hi', 2 + 2)"}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), res
    assert "[stdout]" in res.content
    assert "hi 4" in res.content

    res2 = _run(PythonExecTool(), {"code": "x = 1"}, _ctx(tmp_path))
    assert isinstance(res2, ToolSuccess), res2
    assert res2.content == "(no output)"


# ── (b) stdout cap ─────────────────────────────────────────────


def test_stdout_capped_at_default(tmp_path):
    res = _run(PythonExecTool(), {"code": "print('A' * 100_000)"}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), res
    assert "truncated at 30,000 chars" in res.content
    # cap + [stdout] 헤더 + marker 정도. 원본 100k 은 남지 않음.
    assert len(res.content) < 40_000


def test_stdout_cap_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv(pex.MAX_OUTPUT_ENV, "100")
    res = _run(PythonExecTool(), {"code": "print('B' * 5_000)"}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), res
    assert "truncated at 100 chars" in res.content
    assert len(res.content) < 500


def test_cap_stdout_helper_unit(monkeypatch):
    monkeypatch.delenv(pex.MAX_OUTPUT_ENV, raising=False)
    assert pex._max_output_chars() == pex._DEFAULT_MAX_OUTPUT
    short = "x" * 10
    assert pex._cap_stdout(short) == short  # 상한 이하 무변경

    monkeypatch.setenv(pex.MAX_OUTPUT_ENV, "5")
    assert pex._max_output_chars() == 5
    capped = pex._cap_stdout("y" * 20)
    assert capped.startswith("yyyyy")
    assert "truncated at 5 chars" in capped

    # 잘못된/음수 값은 안전하게 기본값으로.
    monkeypatch.setenv(pex.MAX_OUTPUT_ENV, "not-an-int")
    assert pex._max_output_chars() == pex._DEFAULT_MAX_OUTPUT
    monkeypatch.setenv(pex.MAX_OUTPUT_ENV, "-3")
    assert pex._max_output_chars() == pex._DEFAULT_MAX_OUTPUT
