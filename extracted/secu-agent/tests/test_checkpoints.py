from __future__ import annotations

import asyncio
from pathlib import Path

from secu_agent.agent.checkpoints import CheckpointManager
from secu_agent.agent.tools.base import ToolContext, ToolSuccess
from secu_agent.agent.tools.host_tools import (
    HostEditFileTool,
    HostReadFileTool,
    HostWriteFileTool,
)


def _ctx(tmp_path: Path) -> ToolContext:
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    return ToolContext(evidence_dir=evidence, metadata={})


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_checkpoint_rollback_restores_existing_file(tmp_path):
    target = tmp_path / "target.txt"
    target.write_text("before", encoding="utf-8")
    manager = CheckpointManager(tmp_path / "evidence")

    record = manager.create([target], label="before overwrite")
    target.write_text("after", encoding="utf-8")
    result = manager.rollback(record.id)

    assert result.restored == 1
    assert target.read_text(encoding="utf-8") == "before"


def test_checkpoint_rollback_removes_created_file(tmp_path):
    target = tmp_path / "new.txt"
    manager = CheckpointManager(tmp_path / "evidence")

    record = manager.create([target], label="before create")
    target.write_text("created", encoding="utf-8")
    result = manager.rollback(record.id)

    assert result.deleted == 1
    assert not target.exists()


def test_checkpoint_list_returns_records(tmp_path):
    a = tmp_path / "a.txt"
    b = tmp_path / "b.txt"
    a.write_text("a", encoding="utf-8")
    b.write_text("b", encoding="utf-8")
    manager = CheckpointManager(tmp_path / "evidence")

    first = manager.create([a], label="a")
    second = manager.create([b], label="b")

    records = manager.list()
    assert [r.id for r in records] == [first.id, second.id]
    assert [r.label for r in records] == ["a", "b"]


def test_host_write_creates_checkpoint_before_overwrite(tmp_path):
    target = tmp_path / "target.txt"
    target.write_text("before", encoding="utf-8")
    ctx = _ctx(tmp_path)

    _run(HostReadFileTool(), {"path": str(target)}, ctx)
    result = _run(
        HostWriteFileTool(),
        {"path": str(target), "content": "after"},
        ctx,
    )

    assert isinstance(result, ToolSuccess)
    assert target.read_text(encoding="utf-8") == "after"
    checkpoint_ids = ctx.metadata.get("host_checkpoints")
    assert checkpoint_ids

    rollback = CheckpointManager(ctx.evidence_dir).rollback(checkpoint_ids[-1])
    assert rollback.restored == 1
    assert target.read_text(encoding="utf-8") == "before"


def test_host_edit_creates_checkpoint_before_edit(tmp_path):
    target = tmp_path / "target.py"
    target.write_text("answer = 1\n", encoding="utf-8")
    ctx = _ctx(tmp_path)

    _run(HostReadFileTool(), {"path": str(target)}, ctx)
    result = _run(
        HostEditFileTool(),
        {"path": str(target), "old_string": "1", "new_string": "42"},
        ctx,
    )

    assert isinstance(result, ToolSuccess)
    assert target.read_text(encoding="utf-8") == "answer = 42\n"
    checkpoint_ids = ctx.metadata.get("host_checkpoints")
    assert checkpoint_ids

    rollback = CheckpointManager(ctx.evidence_dir).rollback(checkpoint_ids[-1])
    assert rollback.restored == 1
    assert target.read_text(encoding="utf-8") == "answer = 1\n"
