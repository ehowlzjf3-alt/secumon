"""General terminal tool parity with Claude Bash / Hermes terminal."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

PY = sys.executable

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolInvocation, ToolSuccess
from secu_agent.agent.tools.invoker import invoke_tool
from secu_agent.agent.tools.registry import ToolRegistry
from secu_agent.agent.tools.terminal_tool import TerminalTool


def _ctx(tmp_path: Path, **meta) -> ToolContext:
    md = {"charter_ref": "TH-TEST-001"}
    md.update(meta)
    return ToolContext(evidence_dir=tmp_path, metadata=md)


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_terminal_runs_command_with_cwd(tmp_path):
    marker = tmp_path / "marker.txt"
    marker.write_text("hello", encoding="utf-8")

    res = _run(
        TerminalTool(),
        {"command": "pwd && ls", "cwd": str(tmp_path), "timeout_seconds": 5},
        _ctx(tmp_path),
    )

    assert isinstance(res, ToolSuccess), res
    assert "exit=0" in res.content
    assert str(tmp_path) in res.content
    assert "marker.txt" in res.content


def test_terminal_blocks_obviously_dangerous_command(tmp_path):
    res = _run(
        TerminalTool(),
        {"command": "rm -rf /", "cwd": str(tmp_path)},
        _ctx(tmp_path),
    )

    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"


def test_terminal_timeout(tmp_path):
    res = _run(
        TerminalTool(),
        {
            "command": f"{PY} -c 'import time; time.sleep(2)'",
            "cwd": str(tmp_path),
            "timeout_seconds": 0.1,
        },
        _ctx(tmp_path),
    )

    assert isinstance(res, ToolError)
    assert res.kind == "timeout"


def test_terminal_registered_for_operator():
    from secu_agent.agent.tools import build_registry_for_task

    r = build_registry_for_task("operator")
    names = {t.name for t in r.all()}
    assert "terminal" in names


def test_terminal_blocked_from_scheduled_invocation(tmp_path):
    r = ToolRegistry()
    r.register(TerminalTool)
    ctx = _ctx(tmp_path, schedule_origin={"schedule_id": 1})
    res = asyncio.run(
        invoke_tool(
            ToolInvocation(
                id="toolu_test",
                name="terminal",
                input={"command": "pwd", "cwd": str(tmp_path)},
            ),
            r,
            ctx,
        ),
    )

    assert isinstance(res, ToolError)
    assert res.kind == "permission"
    assert "scheduled execution cannot run destructive tool" in res.message
