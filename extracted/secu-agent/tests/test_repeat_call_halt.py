"""v3.48: 같은 (tool, input) 반복 호출 5회+ 시 halt."""
from __future__ import annotations

from secu_agent.agent.repeat_error import (
    REPEAT_CALL_HALT_THRESHOLD,
    build_repeat_call_halt_message,
    call_fingerprint,
)


def test_call_fingerprint_same_input_same_fp():
    fp1 = call_fingerprint("grep_evidence", {"pattern": "x", "path": "a.txt"})
    fp2 = call_fingerprint("grep_evidence", {"pattern": "x", "path": "a.txt"})
    assert fp1 == fp2


def test_call_fingerprint_different_input_different_fp():
    fp1 = call_fingerprint("grep_evidence", {"pattern": "x", "path": "a.txt"})
    fp2 = call_fingerprint("grep_evidence", {"pattern": "y", "path": "a.txt"})
    assert fp1 != fp2


def test_call_fingerprint_ignores_offset_for_read_evidence():
    """offset/limit 변경은 다른 영역 보는 정상 행동 — 같은 fp."""
    fp1 = call_fingerprint(
        "read_evidence_file", {"path": "a.txt", "offset": 0, "limit": 200},
    )
    fp2 = call_fingerprint(
        "read_evidence_file", {"path": "a.txt", "offset": 200, "limit": 200},
    )
    assert fp1 == fp2  # path 같으면 같은 fp


def test_threshold_is_5():
    assert REPEAT_CALL_HALT_THRESHOLD == 5


def test_halt_message_contains_tool_and_count():
    msg = build_repeat_call_halt_message("grep_evidence", 5)
    assert "grep_evidence" in msg
    assert "5회" in msg
    assert "무한 loop" in msg
