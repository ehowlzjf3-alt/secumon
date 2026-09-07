"""v3.47: sliding window — context overflow 응급 처치."""
from __future__ import annotations

from secu_agent.agent.compactor import sliding_window
from secu_agent.agent.llm.messages import (
    AssistantMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage,
)


def _msg_user_text(s: str) -> UserMessage:
    return UserMessage(content=[TextBlock(text=s)])


def _msg_user_tool_result(tid: str, content: str) -> UserMessage:
    return UserMessage(content=[ToolResultBlock(tool_use_id=tid, content=content)])


def _msg_assistant(text: str, tid: str | None = None) -> AssistantMessage:
    blocks = [TextBlock(text=text)]
    if tid:
        blocks.append(ToolUseBlock(id=tid, name="x", input={}))
    return AssistantMessage(content=blocks)


def test_under_threshold_no_op():
    msgs = [_msg_user_text("hi"), _msg_assistant("hello")]
    out, n = sliding_window(msgs, max_chars=1000)
    assert n == 0
    assert out == msgs


def test_short_message_count_no_op_even_if_over_chars():
    """head+tail+1 보다 적은 메시지면 sliding window 발동 안 함."""
    msgs = [_msg_user_text("x" * 1000), _msg_assistant("y" * 1000)]
    out, n = sliding_window(msgs, max_chars=100, head_n=4, tail_n=12)
    assert n == 0
    assert out == msgs


def test_sliding_window_drops_middle():
    msgs: list = []
    msgs.append(_msg_user_text("user intent: 1번 의도"))
    msgs.append(_msg_assistant("첫 답"))
    msgs.append(_msg_user_text("2"))
    msgs.append(_msg_assistant("3"))
    # 중간 30개 (각 ~500 char) — drop 대상
    for i in range(30):
        msgs.append(_msg_user_tool_result(f"t{i}", "X" * 500))
        msgs.append(_msg_assistant(f"call{i}", tid=f"u{i}"))
    # tail 12개
    for i in range(6):
        msgs.append(_msg_user_text(f"recent_user_{i}"))
        msgs.append(_msg_assistant(f"recent_assistant_{i}"))

    out, dropped = sliding_window(msgs, max_chars=5_000, head_n=4, tail_n=12)
    assert dropped > 0
    # head 4 + note 1 + tail 12 = 17
    assert len(out) == 17
    # head 의 첫 메시지 유지 — 사용자 의도
    head = out[0]
    assert isinstance(head, UserMessage)
    head_text_block = next(b for b in head.content if hasattr(b, "text"))
    assert "1번 의도" in head_text_block.text
    # note 위치 (4번 인덱스, 즉 5번째)
    note = out[4]
    assert isinstance(note, UserMessage)
    note_text_block = next(b for b in note.content if hasattr(b, "text"))
    assert "sliding window" in note_text_block.text
    assert "드롭됨" in note_text_block.text
    # tail 끝 의 메시지 유지
    tail_last = out[-1]
    text = next(
        (b.text for b in tail_last.content if hasattr(b, "text")),
        "",
    )
    assert "recent_assistant_5" in text


def test_drops_count_matches():
    msgs = [_msg_user_text("h" + "x"*1000) for _ in range(20)]
    out, dropped = sliding_window(msgs, max_chars=2_000, head_n=2, tail_n=2)
    # 20 → head 2 + note 1 + tail 2 = 5
    assert dropped == 16
    assert len(out) == 5
