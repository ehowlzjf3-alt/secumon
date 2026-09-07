"""v3.15: evidence_dir 한정 정적 분석 도구 — Read / Grep / Bash.

safe_path() 공유. evidence_dir 밖 접근 차단. Bash 는 is_destructive=True.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


def _ctx(tmp_path: Path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path.resolve(), metadata={})


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


# ─── ReadFileTool ──────────────────────────────────────────


def test_read_file_returns_content(tmp_path):
    from secu_agent.agent.tools.evidence_tools import ReadEvidenceFileTool

    f = tmp_path / "hello.txt"
    f.write_text("안녕 agent_type", encoding="utf-8")

    res = _run(ReadEvidenceFileTool(), {"path": "hello.txt"}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess)
    assert "안녕 agent_type" in res.content


def test_read_file_path_escape_returns_error(tmp_path):
    from secu_agent.agent.tools.evidence_tools import ReadEvidenceFileTool

    res = _run(ReadEvidenceFileTool(), {"path": "../escape.txt"}, _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "path_escape"


def test_read_file_missing(tmp_path):
    from secu_agent.agent.tools.evidence_tools import ReadEvidenceFileTool

    res = _run(ReadEvidenceFileTool(), {"path": "ghost.txt"}, _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "not_found"


def test_read_file_size_cap(tmp_path):
    from secu_agent.agent.tools.evidence_tools import ReadEvidenceFileTool

    f = tmp_path / "big.txt"
    f.write_bytes(b"x" * (2 * 1024 * 1024 + 10))  # 2MB+

    res = _run(ReadEvidenceFileTool(), {"path": "big.txt"}, _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "too_large"


def test_read_file_with_offset_and_limit(tmp_path):
    from secu_agent.agent.tools.evidence_tools import ReadEvidenceFileTool

    body = "\n".join(f"line {i}" for i in range(1, 101))
    f = tmp_path / "lines.txt"
    f.write_text(body, encoding="utf-8")

    res = _run(ReadEvidenceFileTool(),
               {"path": "lines.txt", "offset": 50, "limit": 5},
               _ctx(tmp_path))
    assert isinstance(res, ToolSuccess)
    assert "line 51" in res.content
    assert "line 55" in res.content
    assert "line 56" not in res.content
    assert "line 50" not in res.content


def test_read_file_is_read_only_metadata():
    from secu_agent.agent.tools.evidence_tools import ReadEvidenceFileTool
    assert ReadEvidenceFileTool.is_read_only is True
    assert ReadEvidenceFileTool.is_destructive is False


# ─── GrepEvidenceTool ──────────────────────────────────────


def test_grep_finds_matches(tmp_path):
    from secu_agent.agent.tools.evidence_tools import GrepEvidenceTool

    (tmp_path / "a.txt").write_text("secret=abcdef\nfoo=bar", encoding="utf-8")
    (tmp_path / "b.txt").write_text("nothing here", encoding="utf-8")

    res = _run(GrepEvidenceTool(), {"pattern": "secret"}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess)
    assert "a.txt" in res.content
    assert "abcdef" in res.content
    assert "b.txt" not in res.content


def test_grep_no_match_returns_success_with_zero(tmp_path):
    from secu_agent.agent.tools.evidence_tools import GrepEvidenceTool

    (tmp_path / "a.txt").write_text("nothing", encoding="utf-8")
    res = _run(GrepEvidenceTool(), {"pattern": "absent"}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess)
    assert "0 match" in res.content or "no match" in res.content.lower()


def test_grep_scoped_to_evidence_dir(tmp_path, monkeypatch):
    """grep 이 evidence_dir 밖 (홈디렉토리 등) 접근 못함."""
    from secu_agent.agent.tools.evidence_tools import GrepEvidenceTool

    (tmp_path / "in.txt").write_text("token=in_scope", encoding="utf-8")
    res = _run(GrepEvidenceTool(),
               {"pattern": "token", "path": "../"},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "path_escape"


def test_grep_is_read_only():
    from secu_agent.agent.tools.evidence_tools import GrepEvidenceTool
    assert GrepEvidenceTool.is_read_only is True


# ─── BashEvidenceTool ──────────────────────────────────────


def test_bash_runs_command_in_evidence_dir(tmp_path):
    from secu_agent.agent.tools.evidence_tools import BashEvidenceTool

    (tmp_path / "hello.txt").write_text("hi", encoding="utf-8")
    res = _run(BashEvidenceTool(), {"command": "ls"}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    assert "hello.txt" in res.content


def test_bash_is_destructive():
    from secu_agent.agent.tools.evidence_tools import BashEvidenceTool
    assert BashEvidenceTool.is_destructive is True


def test_bash_permission_asks(tmp_path):
    from secu_agent.agent.tools.evidence_tools import BashEvidenceTool

    t = BashEvidenceTool()
    decision = asyncio.run(t.check_permission(
        t.input_model(command="ls"), _ctx(tmp_path)))
    assert decision.behavior == "ask"


def test_bash_blocks_obvious_dangerous(tmp_path):
    """rm -rf /, sudo, curl http(s), wget, : (fork bomb) 같은 패턴 사전 차단."""
    from secu_agent.agent.tools.evidence_tools import BashEvidenceTool

    for bad in ["rm -rf /", "sudo ls", "curl http://evil.com", "wget x", ":(){:|:&};:"]:
        res = _run(BashEvidenceTool(), {"command": bad}, _ctx(tmp_path))
        assert isinstance(res, ToolError), f"should reject: {bad}"
        assert res.kind == "forbidden"


def test_bash_timeout(tmp_path):
    from secu_agent.agent.tools.evidence_tools import BashEvidenceTool

    res = _run(BashEvidenceTool(),
               {"command": "sleep 5", "timeout_sec": 0.1},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "timeout"


def test_bash_output_truncated(tmp_path):
    """대량 출력 cap (50KB)."""
    from secu_agent.agent.tools.evidence_tools import BashEvidenceTool

    res = _run(BashEvidenceTool(),
               {"command": "yes a | head -c 100000"},
               _ctx(tmp_path))
    assert isinstance(res, ToolSuccess)
    assert "truncated" in res.content.lower() or len(res.content) < 80_000
