"""v3.24-C: Host-wide Read / Write / Edit 도구 검증.

핵심:
- absolute path 강제 (relative 거부)
- 가드: 시스템 디렉토리 + credential dir + sudoers
- read-before-write/edit
- old_string 매치 카운트 (1개 / replace_all)
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.agent.read_context import clear_read_state
from secu_agent.agent.tools.host_tools import (
    HostCodeOutlineTool, HostCopyFileTool, HostEditFileTool, HostMoveFileTool,
    HostReadFileTool, HostSearchTool, HostWriteFileTool,
)


def _ctx(tmp_path: Path, **meta) -> ToolContext:
    md = {"charter_ref": "TH-TEST-001"}
    md.update(meta)
    return ToolContext(evidence_dir=tmp_path, metadata=md)


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


# ============================================================
# 입력 검증
# ============================================================

def test_read_rejects_relative_path(tmp_path):
    res = _run(HostReadFileTool(), {"path": "foo.txt"}, _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert "absolute" in res.message.lower() or "absolute" in res.kind


def test_read_rejects_empty_path(tmp_path):
    res = _run(HostReadFileTool(), {"path": ""}, _ctx(tmp_path))
    assert isinstance(res, ToolError)


# ============================================================
# Read — 정상 + 가드
# ============================================================

def test_read_returns_file_contents(tmp_path):
    f = tmp_path / "hello.txt"
    f.write_text("line one\nline two\n")
    res = _run(HostReadFileTool(), {"path": str(f)}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess)
    assert "line one" in res.content
    assert "line two" in res.content


def test_read_offset_limit(tmp_path):
    f = tmp_path / "long.txt"
    f.write_text("\n".join(f"line{i}" for i in range(20)))
    res = _run(HostReadFileTool(), {"path": str(f), "offset": 5, "limit": 3}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess)
    assert "line5" in res.content
    assert "line7" in res.content
    assert "line10" not in res.content


def test_read_blocks_ssh_dir(tmp_path, monkeypatch):
    # ~/.ssh/something — 실제 파일 존재 여부와 무관하게 가드 작동
    fake_home = tmp_path / "home"
    (fake_home / ".ssh").mkdir(parents=True)
    (fake_home / ".ssh" / "id_rsa").write_text("FAKE KEY")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    res = _run(HostReadFileTool(),
               {"path": str(fake_home / ".ssh" / "id_rsa")},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"
    assert ".ssh" in res.message


def test_read_blocks_aws_dir(tmp_path, monkeypatch):
    fake_home = tmp_path / "home"
    (fake_home / ".aws").mkdir(parents=True)
    (fake_home / ".aws" / "credentials").write_text("FAKE")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    res = _run(HostReadFileTool(),
               {"path": str(fake_home / ".aws" / "credentials")},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"


def test_read_blocks_sudoers(tmp_path):
    res = _run(HostReadFileTool(), {"path": "/etc/sudoers"}, _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"


def test_read_allows_etc_for_debugging(tmp_path):
    """read 는 /etc 허용 (sudoers 제외) — 디버깅용."""
    # /etc/hostname 정도는 보통 있음. 없는 시스템도 있으니 missing 도 OK
    res = _run(HostReadFileTool(), {"path": "/etc/hostname"}, _ctx(tmp_path))
    # forbidden 으로 떨어지면 안 됨. not_found 든 io_error 든 ToolSuccess 든 모두 OK
    if isinstance(res, ToolError):
        assert res.kind != "forbidden"


def test_read_not_found(tmp_path):
    res = _run(HostReadFileTool(),
               {"path": str(tmp_path / "nope.txt")},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "not_found"


def test_read_tracks_path_in_ctx(tmp_path):
    """read 후 ctx.metadata['host_read_paths'] 에 박힘 — edit/write 가 이걸 본다."""
    f = tmp_path / "tracked.txt"
    f.write_text("hi")
    ctx = _ctx(tmp_path)
    _run(HostReadFileTool(), {"path": str(f)}, ctx)
    reads = ctx.metadata.get("host_read_paths") or set()
    assert str(f.resolve()) in reads


def test_read_caps_large_output(tmp_path):
    f = tmp_path / "large.txt"
    f.write_text(("x" * 120 + "\n") * 400)
    res = _run(HostReadFileTool(), {"path": str(f), "limit": 1000}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), res
    assert "truncated at 30,000 chars" in res.content
    assert len(res.content) < 31_000


def test_read_dedups_same_unchanged_range(tmp_path):
    f = tmp_path / "same.txt"
    f.write_text("unique-body-line\n")
    ctx = _ctx(tmp_path)

    first = _run(HostReadFileTool(), {"path": str(f), "offset": 0, "limit": 10}, ctx)
    second = _run(HostReadFileTool(), {"path": str(f), "offset": 0, "limit": 10}, ctx)

    assert isinstance(first, ToolSuccess)
    assert isinstance(second, ToolSuccess)
    assert "unique-body-line" in first.content
    assert "[unchanged: host_read" in second.content
    assert "content_returned=false" in second.content
    assert "unique-body-line" not in second.content


def test_read_dedup_cleared_allows_reread(tmp_path):
    f = tmp_path / "same.txt"
    f.write_text("body-after-clear\n")
    ctx = _ctx(tmp_path)

    _run(HostReadFileTool(), {"path": str(f)}, ctx)
    clear_read_state(ctx.metadata)
    res = _run(HostReadFileTool(), {"path": str(f)}, ctx)

    assert isinstance(res, ToolSuccess)
    assert "body-after-clear" in res.content
    assert "[unchanged:" not in res.content


def test_read_dedup_invalidated_by_file_change(tmp_path):
    f = tmp_path / "changing.txt"
    f.write_text("old-body\n")
    ctx = _ctx(tmp_path)

    _run(HostReadFileTool(), {"path": str(f)}, ctx)
    f.write_text("new-body-with-different-size\n")
    res = _run(HostReadFileTool(), {"path": str(f)}, ctx)

    assert isinstance(res, ToolSuccess)
    assert "new-body-with-different-size" in res.content
    assert "[unchanged:" not in res.content


# ============================================================
# Write — 가드 + read-first + size cap
# ============================================================

def test_write_creates_new_file(tmp_path):
    f = tmp_path / "new.txt"
    res = _run(HostWriteFileTool(),
               {"path": str(f), "content": "fresh content"},
               _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), res
    assert "created" in res.content
    assert f.read_text() == "fresh content"


def test_write_overwrite_requires_read_first(tmp_path):
    f = tmp_path / "existing.txt"
    f.write_text("old")
    res = _run(HostWriteFileTool(),
               {"path": str(f), "content": "new"},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "read_first"
    # 원본 unchanged
    assert f.read_text() == "old"


def test_write_overwrite_after_read_works(tmp_path):
    f = tmp_path / "existing.txt"
    f.write_text("old content")
    ctx = _ctx(tmp_path)
    _run(HostReadFileTool(), {"path": str(f)}, ctx)
    res = _run(HostWriteFileTool(),
               {"path": str(f), "content": "new content"},
               ctx)
    assert isinstance(res, ToolSuccess), res
    assert "overwrote" in res.content
    assert f.read_text() == "new content"


def test_write_blocks_system_dirs(tmp_path):
    res = _run(HostWriteFileTool(),
               {"path": "/etc/hosts", "content": "127.0.0.1 evil"},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"
    assert "/etc" in res.message


def test_write_blocks_bin(tmp_path):
    res = _run(HostWriteFileTool(),
               {"path": "/usr/bin/ls", "content": "fake"},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"


def test_write_blocks_credential_dir(tmp_path, monkeypatch):
    fake_home = tmp_path / "home"
    (fake_home / ".ssh").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    res = _run(HostWriteFileTool(),
               {"path": str(fake_home / ".ssh" / "authorized_keys"),
                "content": "ssh-rsa AAAA"},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"


def test_write_requires_parent_to_exist(tmp_path):
    res = _run(HostWriteFileTool(),
               {"path": str(tmp_path / "nonexist" / "deep.txt"),
                "content": "x"},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "parent_missing"


def test_write_rejects_oversize(tmp_path):
    f = tmp_path / "big.txt"
    big = "x" * (2 * 1024 * 1024)  # 2MB > 1MB cap
    res = _run(HostWriteFileTool(),
               {"path": str(f), "content": big},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "too_large"


# ============================================================
# Edit — exact replace + match counting + read-first
# ============================================================

def test_edit_replaces_unique_match(tmp_path):
    f = tmp_path / "code.py"
    f.write_text("def foo():\n    return 1\n")
    ctx = _ctx(tmp_path)
    _run(HostReadFileTool(), {"path": str(f)}, ctx)
    res = _run(HostEditFileTool(),
               {"path": str(f),
                "old_string": "return 1",
                "new_string": "return 42"},
               ctx)
    assert isinstance(res, ToolSuccess), res
    assert "1 replacement" in res.content
    assert f.read_text() == "def foo():\n    return 42\n"


def test_edit_requires_read_first(tmp_path):
    f = tmp_path / "code.py"
    f.write_text("x = 1")
    res = _run(HostEditFileTool(),
               {"path": str(f), "old_string": "1", "new_string": "2"},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "read_first"


def test_edit_rejects_same_old_new(tmp_path):
    f = tmp_path / "code.py"
    f.write_text("x = 1")
    ctx = _ctx(tmp_path)
    _run(HostReadFileTool(), {"path": str(f)}, ctx)
    res = _run(HostEditFileTool(),
               {"path": str(f), "old_string": "x", "new_string": "x"},
               ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "validation"


def test_edit_no_match(tmp_path):
    f = tmp_path / "code.py"
    f.write_text("x = 1")
    ctx = _ctx(tmp_path)
    _run(HostReadFileTool(), {"path": str(f)}, ctx)
    res = _run(HostEditFileTool(),
               {"path": str(f), "old_string": "missing", "new_string": "added"},
               ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "not_found_in_file"


def test_edit_ambiguous_match_without_replace_all(tmp_path):
    f = tmp_path / "code.py"
    f.write_text("foo\nfoo\nfoo\n")
    ctx = _ctx(tmp_path)
    _run(HostReadFileTool(), {"path": str(f)}, ctx)
    res = _run(HostEditFileTool(),
               {"path": str(f), "old_string": "foo", "new_string": "bar"},
               ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "ambiguous"


def test_edit_replace_all_works(tmp_path):
    f = tmp_path / "code.py"
    f.write_text("foo\nfoo\nfoo\n")
    ctx = _ctx(tmp_path)
    _run(HostReadFileTool(), {"path": str(f)}, ctx)
    res = _run(HostEditFileTool(),
               {"path": str(f), "old_string": "foo", "new_string": "bar",
                "replace_all": True},
               ctx)
    assert isinstance(res, ToolSuccess), res
    assert "3 replacement" in res.content
    assert f.read_text() == "bar\nbar\nbar\n"


def test_edit_blocks_system_dirs(tmp_path):
    ctx = _ctx(tmp_path)
    # 가드는 read-first 보다 먼저 — _was_read check 안 가도 forbidden
    res = _run(HostEditFileTool(),
               {"path": "/etc/passwd", "old_string": "root", "new_string": "x"},
               ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"


# ============================================================
# Search / copy / move — Claude Glob/Grep + Hermes file parity
# ============================================================

def test_host_search_glob_finds_files(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "alpha.py").write_text("print('alpha')\n")
    (tmp_path / "beta.txt").write_text("beta\n")

    res = _run(HostSearchTool(),
               {"root": str(tmp_path), "query": "*.py", "mode": "glob"},
               _ctx(tmp_path))

    assert isinstance(res, ToolSuccess), res
    assert "alpha.py" in res.content
    assert "beta.txt" not in res.content


def test_host_search_grep_finds_text(tmp_path):
    f = tmp_path / "finding.log"
    f.write_text("nope\nsecret token here\n")

    res = _run(HostSearchTool(),
               {"root": str(tmp_path), "query": "secret token", "mode": "grep"},
               _ctx(tmp_path))

    assert isinstance(res, ToolSuccess), res
    assert "finding.log:2:" in res.content
    assert "secret token here" in res.content


def test_host_search_caps_large_output(tmp_path):
    f = tmp_path / "huge.log"
    f.write_text("\n".join(f"needle {'x' * 120} {i}" for i in range(500)))

    res = _run(HostSearchTool(),
               {"root": str(tmp_path), "query": "needle", "mode": "grep",
                "max_matches": 500},
               _ctx(tmp_path))

    assert isinstance(res, ToolSuccess), res
    assert "truncated at 30,000 chars" in res.content
    assert len(res.content) < 31_000


def test_host_code_outline_python_file(tmp_path):
    f = tmp_path / "service.py"
    f.write_text(
        "import os\n\n"
        "class Service:\n"
        "    def run(self):\n"
        "        return 42\n\n"
        "async def main():\n"
        "    return Service().run()\n"
    )

    res = _run(HostCodeOutlineTool(), {"path": str(f)}, _ctx(tmp_path))

    assert isinstance(res, ToolSuccess), res
    assert "imports:" in res.content
    assert "1: import os" in res.content
    assert "3: class Service:" in res.content
    assert "4: def run(self):" in res.content
    assert "7: async def main():" in res.content
    assert "return 42" not in res.content


def test_host_code_outline_dir_skips_noise_dirs(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.ts").write_text(
        "import express from 'express'\n"
        "export function handler() { return express() }\n"
    )
    (tmp_path / "node_modules" / "pkg").mkdir(parents=True)
    (tmp_path / "node_modules" / "pkg" / "index.js").write_text(
        "export function ignored() {}\n"
    )

    res = _run(HostCodeOutlineTool(), {"path": str(tmp_path)}, _ctx(tmp_path))

    assert isinstance(res, ToolSuccess), res
    assert "src/app.ts" in res.content
    assert "handler" in res.content
    assert "ignored" not in res.content


def test_host_copy_binary_file_verifies_hash(tmp_path):
    src = tmp_path / "image.png"
    src.write_bytes(b"\x89PNG\r\n\x1a\n\x00binary")
    out_dir = tmp_path / "exports"
    out_dir.mkdir()

    res = _run(HostCopyFileTool(),
               {"source_path": str(src), "dest_dir": str(out_dir)},
               _ctx(tmp_path))

    dest = out_dir / "image.png"
    assert isinstance(res, ToolSuccess), res
    assert dest.read_bytes() == src.read_bytes()
    assert "verified" in res.content
    assert "sha256=" in res.content


def test_host_copy_refuses_overwrite_by_default(tmp_path):
    src = tmp_path / "source.bin"
    dest = tmp_path / "dest.bin"
    src.write_bytes(b"new")
    dest.write_bytes(b"old")

    res = _run(HostCopyFileTool(),
               {"source_path": str(src), "dest_path": str(dest)},
               _ctx(tmp_path))

    assert isinstance(res, ToolError)
    assert res.kind == "exists"
    assert dest.read_bytes() == b"old"


def test_host_move_binary_file_removes_source(tmp_path):
    src = tmp_path / "capture.png"
    src.write_bytes(b"\x89PNG-data")
    out_dir = tmp_path / "moved"
    out_dir.mkdir()

    res = _run(HostMoveFileTool(),
               {"source_path": str(src), "dest_dir": str(out_dir)},
               _ctx(tmp_path))

    dest = out_dir / "capture.png"
    assert isinstance(res, ToolSuccess), res
    assert not src.exists()
    assert dest.read_bytes() == b"\x89PNG-data"
    assert "verified" in res.content


# ============================================================
# 메타 검증 + registry
# ============================================================

def test_host_tools_metadata():
    assert HostReadFileTool.is_read_only is True
    assert HostReadFileTool.is_destructive is False
    assert HostReadFileTool.deferred is False
    assert HostSearchTool.is_read_only is True
    assert HostSearchTool.deferred is False
    assert HostCodeOutlineTool.is_read_only is True
    assert HostCodeOutlineTool.deferred is False
    assert HostCopyFileTool.is_destructive is True
    assert HostCopyFileTool.deferred is False
    assert HostMoveFileTool.is_destructive is True
    assert HostMoveFileTool.deferred is False
    assert HostWriteFileTool.is_destructive is True
    assert HostWriteFileTool.deferred is False
    assert HostEditFileTool.is_destructive is True
    assert HostEditFileTool.deferred is False


def test_host_tools_in_operator_registry():
    from secu_agent.agent.tools import build_registry_for_task
    r = build_registry_for_task("operator")
    names = {t.name for t in r.all()}
    assert "host_read" in names
    assert "host_search" in names
    assert "host_code_outline" in names
    assert "host_copy" in names
    assert "host_move" in names
    assert "host_write" in names
    assert "host_edit" in names
