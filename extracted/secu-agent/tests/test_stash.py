"""v3.51-H4: stash module tests — inline cap, structure summary, file output."""
from __future__ import annotations

import json

from secu_agent.agent.stash import (
    TOOL_RESULT_INLINE_MAX,
    json_structure_summary,
    stash_large_result,
)


def test_inline_max_is_50k():
    assert TOOL_RESULT_INLINE_MAX == 50_000


# ─── json_structure_summary ────────────────────────────────


def test_structure_summary_dict_keys():
    out = json_structure_summary({"a": 1, "b": "hello", "c": [1, 2, 3]})
    assert "a:" in out
    assert "b:" in out
    assert "c:" in out
    assert "[n=3" in out


def test_structure_summary_list_with_sample():
    out = json_structure_summary([{"k": "v"}, {"k": "v2"}, {"k": "v3"}])
    assert "n=3 items" in out
    assert "sample" in out


def test_structure_summary_truncates_long_string():
    out = json_structure_summary({"long": "x" * 200})
    assert "200 chars" in out
    assert "..." in out


def test_structure_summary_depth_limit():
    deep = {"a": {"b": {"c": {"d": {"e": "leaf"}}}}}
    out = json_structure_summary(deep, depth_limit=2)
    assert "..." in out


def test_structure_summary_truncates_many_dict_keys():
    big = {f"k{i}": i for i in range(50)}
    out = json_structure_summary(big)
    assert "+30 more keys" in out


def test_structure_summary_null_and_primitive():
    assert "null" in json_structure_summary({"x": None})


# ─── stash_large_result ────────────────────────────────────


def test_stash_writes_json_file_when_parsable(tmp_path):
    raw = json.dumps({"a": list(range(100)), "b": "hi"})
    summary, path = stash_large_result("web_fetch", raw, tmp_path)
    assert path.suffix == ".json"
    assert path.exists()
    assert path.read_text(encoding="utf-8") == raw
    assert f"{len(raw):,} chars" in summary
    assert "structure:" in summary


def test_stash_writes_txt_when_not_json(tmp_path):
    raw = "plain text body " * 100
    summary, path = stash_large_result("bash_evidence", raw, tmp_path)
    assert path.suffix == ".txt"
    assert path.exists()
    assert "structure:" not in summary  # non-json 에는 structure 라인 없음


def test_stash_summary_includes_head_and_tail(tmp_path):
    raw = "HEAD_MARKER_" + ("x" * 5000) + "_TAIL_MARKER"
    summary, _ = stash_large_result("web_crawl", raw, tmp_path)
    assert "HEAD_MARKER" in summary
    assert "TAIL_MARKER" in summary
    assert "head (2000 chars)" in summary
    assert "tail (1000 chars)" in summary


def test_stash_relative_path_in_summary(tmp_path):
    raw = "x" * 100
    summary, path = stash_large_result("tool", raw, tmp_path)
    # summary 의 path 가 evidence_dir 기준 상대경로여야
    rel = str(path.relative_to(tmp_path.resolve()))
    assert f"path: {rel}" in summary


def test_stash_list_singleton_wrapper(tmp_path):
    """list[1] 같은 single-element wrapper 는 first item structure 로."""
    raw = json.dumps([{"foo": "bar", "items": [1, 2]}])
    summary, _ = stash_large_result("tool", raw, tmp_path)
    assert "list[1] wrapper" in summary
    assert "foo:" in summary
