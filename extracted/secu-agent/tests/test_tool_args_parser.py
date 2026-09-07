"""v3.34-A: LLM tool args JSON 파싱 — 흔한 escape 깨짐 recover."""
from __future__ import annotations

from secu_agent.agent.engine import _parse_tool_args


def test_empty_buffer_returns_empty_dict() -> None:
    assert _parse_tool_args("") == {}


def test_valid_json_passes_strict() -> None:
    out = _parse_tool_args('{"code": "print(1)"}')
    assert out == {"code": "print(1)"}


def test_literal_newline_passes_lenient() -> None:
    """LLM 이 \\n escape 안 하고 literal newline 넣은 경우 — strict=False 가 잡음."""
    raw = '{"code": "line1\nline2"}'
    out = _parse_tool_args(raw)
    assert out == {"code": "line1\nline2"}


def test_invalid_single_quote_escape_recovers() -> None:
    """LLM 이 single quote 를 \\' 로 잘못 escape — JSON 표준 위반. v3.34-A normalize 로 recover."""
    # raw bytes: {"code": "t[\'subnet\']"}
    raw = r'{"code": "t[\'subnet\']"}'
    out = _parse_tool_args(raw)
    assert "__parse_error" not in out, f"failed to recover: {out}"
    assert out == {"code": "t['subnet']"}


def test_invalid_escape_with_newlines_recovers() -> None:
    """실제 깨진 케이스 — \\' + raw \\n 둘 다."""
    raw = "{\"code\": \"subnets = [t[\\'subnet\\'] for t in xs]\\nprint(len(subnets))\"}"
    out = _parse_tool_args(raw)
    assert "__parse_error" not in out, f"failed: {out}"
    assert out["code"] == "subnets = [t['subnet'] for t in xs]\nprint(len(subnets))"


def test_truly_broken_returns_parse_error() -> None:
    """완전 깨진 (`{` 누락) — recover 불가, __parse_error."""
    out = _parse_tool_args('"code": "x"')  # missing braces, not a dict
    assert "__parse_error" in out


def test_non_dict_returns_parse_error() -> None:
    """valid JSON 이지만 dict 아님."""
    out = _parse_tool_args('["a", "b"]')
    assert "__parse_error" in out
