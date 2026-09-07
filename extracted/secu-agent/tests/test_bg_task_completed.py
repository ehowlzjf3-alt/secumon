"""v3.43-P4: BgTaskCompleted event + process watcher + 영속화."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from secu_agent import state
from secu_agent.agent.events import BgTaskCompleted
from secu_agent.agent.tools.base import ToolContext
from secu_agent.agent.tools.process_tool import (
    ProcessInput, ProcessTool, _PROCESS_REGISTRY,
    subscribe_bg_completion, unsubscribe_bg_completion,
)


def _run(coro):
    return asyncio.run(coro)


def _reset_registry():
    _PROCESS_REGISTRY.clear()


def test_bg_task_completed_event_dataclass_exists():
    """events.py 에 BgTaskCompleted 정의 + 필드."""
    ev = BgTaskCompleted(
        process_id="proc_abc", command="echo hi", exit_code=0,
        output_path="/tmp/x.log", output_tail="hi\n", duration_sec=0.5,
    )
    assert ev.type == "bg_task_completed"
    assert ev.process_id == "proc_abc"


def test_watcher_writes_completion_json_after_proc_exit(tmp_path):
    _reset_registry()
    tool = ProcessTool()
    ctx = ToolContext(evidence_dir=tmp_path)

    async def go():
        res = await tool._start(ProcessInput(
            action="start", command="echo done && sleep 0.05",
        ), ctx)
        pid = res.content.splitlines()[0].split()[0].split("=")[1]
        record = _PROCESS_REGISTRY[pid]
        # watcher_task 가 만들어졌는지
        assert record.watcher_task is not None
        # 기다림
        await record.watcher_task
        return record

    record = _run(go())
    comp_path = record.output_path.with_suffix(".completion.json")
    assert comp_path.exists(), "completion.json 안 만들어짐"
    payload = json.loads(comp_path.read_text())
    assert payload["event"] == "bg_task_completed"
    assert payload["exit_code"] == 0
    assert "done" in payload["output_tail"]


def test_watcher_persists_chat_message_when_session_id_present(tmp_db, tmp_path):
    _reset_registry()
    sid = state.chat_session_get_or_create()
    tool = ProcessTool()
    ctx = ToolContext(evidence_dir=tmp_path, metadata={"session_id": sid})

    async def go():
        res = await tool._start(ProcessInput(
            action="start", command="echo done2",
        ), ctx)
        pid = res.content.splitlines()[0].split()[0].split("=")[1]
        record = _PROCESS_REGISTRY[pid]
        await record.watcher_task
        return record

    record = _run(go())
    msgs = state.chat_messages_for(sid)
    bg_msgs = [m for m in msgs if m["role"] == "system"
               and isinstance(m["content"], dict)
               and m["content"].get("event") == "bg_task_completed"]
    assert len(bg_msgs) == 1
    assert bg_msgs[0]["content"]["process_id"] == record.process_id


def test_subscriber_callback_fires_on_completion(tmp_path):
    _reset_registry()
    tool = ProcessTool()
    ctx = ToolContext(evidence_dir=tmp_path)
    received: list[dict] = []

    def cb(record, payload):
        received.append(payload)

    subscribe_bg_completion(cb)
    try:
        async def go():
            res = await tool._start(ProcessInput(
                action="start", command="echo hi",
            ), ctx)
            pid = res.content.splitlines()[0].split()[0].split("=")[1]
            record = _PROCESS_REGISTRY[pid]
            await record.watcher_task

        _run(go())
    finally:
        unsubscribe_bg_completion(cb)

    assert len(received) == 1
    assert received[0]["event"] == "bg_task_completed"
    assert "hi" in received[0]["output_tail"]
