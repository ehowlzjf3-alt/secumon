"""Background process tool parity with Hermes process."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

PY = sys.executable

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolInvocation, ToolSuccess
from secu_agent.agent.tools.invoker import invoke_tool
from secu_agent.agent.tools.process_tool import ProcessTool
from secu_agent.agent.tools.registry import ToolRegistry


def _ctx(tmp_path: Path, **meta) -> ToolContext:
    md = {"charter_ref": "TH-TEST-001"}
    md.update(meta)
    return ToolContext(evidence_dir=tmp_path, metadata=md)


def _run(payload, ctx):
    tool = ProcessTool()
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_process_start_wait_and_tail(tmp_path):
    ctx = _ctx(tmp_path)
    start = _run({
        "action": "start",
        "command": f"{PY} -c 'print(\"ready\"); print(\"done\")'",
        "cwd": str(tmp_path),
    }, ctx)
    assert isinstance(start, ToolSuccess), start
    assert "process_id=" in start.content
    process_id = start.content.split("process_id=", 1)[1].split()[0]

    waited = _run({"action": "wait", "process_id": process_id, "timeout_seconds": 5}, ctx)
    assert isinstance(waited, ToolSuccess), waited
    assert "status=exited" in waited.content
    assert "exit_code=0" in waited.content

    tail = _run({"action": "tail", "process_id": process_id, "tail_bytes": 4096}, ctx)
    assert isinstance(tail, ToolSuccess), tail
    assert "ready" in tail.content
    assert "done" in tail.content


def test_process_close_terminates_running_process(tmp_path):
    ctx = _ctx(tmp_path)
    start = _run({
        "action": "start",
        "command": f"{PY} -c 'import time; time.sleep(30)'",
        "cwd": str(tmp_path),
    }, ctx)
    assert isinstance(start, ToolSuccess), start
    process_id = start.content.split("process_id=", 1)[1].split()[0]

    closed = _run({"action": "close", "process_id": process_id}, ctx)
    assert isinstance(closed, ToolSuccess), closed
    # v3.43-P4: bg watcher 가 close 와 race 해서 process 자체 종료 인식할 수도 (already_exited).
    # 셋 다 valid outcome — process 가 더 안 돌고 있으면 성공.
    assert any(s in closed.content for s in ("terminated", "killed", "already_exited"))


def test_process_start_blocks_dangerous_command(tmp_path):
    res = _run({
        "action": "start",
        "command": "rm -rf /",
        "cwd": str(tmp_path),
    }, _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"


def test_process_registered_for_operator():
    from secu_agent.agent.tools import build_registry_for_task

    r = build_registry_for_task("operator")
    names = {t.name for t in r.all()}
    assert "process" in names


def test_scheduled_process_start_fails_closed_without_blocking_poll(tmp_path):
    registry = ToolRegistry()
    registry.register(ProcessTool)
    ctx = _ctx(tmp_path, schedule_origin={"schedule_id": 1})

    start = asyncio.run(invoke_tool(
        ToolInvocation(
            id="call-process-start",
            name="process",
            input={
                "action": "start",
                "command": "pwd",
                "cwd": str(tmp_path),
            },
        ),
        registry,
        ctx,
    ))
    assert isinstance(start, ToolError)
    assert start.kind == "permission"

    listed = asyncio.run(invoke_tool(
        ToolInvocation(id="call-process-list", name="process", input={"action": "list"}),
        registry,
        ctx,
    ))
    assert isinstance(listed, ToolSuccess)
