"""P1 Slice1: sliding_window must not orphan tool_use/tool_result pairs.

compactor.sliding_window drops the middle (head[:N] + note + tail[-N:]). If an
AssistantMessage(tool_use) survives in head while its ToolResultBlock is in the
dropped middle (or an orphan tool_result survives in tail), the OpenAI-compatible
gateway rejects the request (400). The window must fold in the same pairing
sanitation the summarizer uses.
"""
from __future__ import annotations

from secu_agent.agent.compactor import sliding_window
from secu_agent.agent.llm.messages import (
    AssistantMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)


def _pair_ids(messages):
    use_ids: set[str] = set()
    result_ids: set[str] = set()
    for m in messages:
        if isinstance(m, AssistantMessage):
            for b in m.content:
                if isinstance(b, ToolUseBlock):
                    use_ids.add(b.id)
        if isinstance(m, UserMessage):
            for b in m.content:
                if isinstance(b, ToolResultBlock):
                    result_ids.add(b.tool_use_id)
    return use_ids, result_ids


def test_sliding_window_no_orphan_when_result_dropped():
    # tool_use "A" lives in head; its result sits in the dropped middle.
    messages = [
        UserMessage(content=[TextBlock(text="u0 start the session here")]),
        AssistantMessage(content=[ToolUseBlock(id="A", name="t", input={})]),
        UserMessage(content=[ToolResultBlock(tool_use_id="A", content="resultA body")]),
        AssistantMessage(content=[TextBlock(text="filler middle message body")]),
        UserMessage(content=[TextBlock(text="u4 trailing end message body")]),
    ]
    new, dropped = sliding_window(messages, max_chars=5, head_n=2, tail_n=1)
    assert dropped > 0  # window actually fired
    use_ids, result_ids = _pair_ids(new)
    # every surviving tool_use must have a matching tool_result (stub allowed)
    assert use_ids <= result_ids, f"orphan tool_use(s): {use_ids - result_ids}"


def test_sliding_window_no_orphan_result_in_tail():
    # an orphan tool_result "Z" survives in tail with no matching tool_use.
    messages = [
        UserMessage(content=[TextBlock(text="u0 head message content here")]),
        AssistantMessage(content=[TextBlock(text="a1 dropped middle content")]),
        AssistantMessage(content=[TextBlock(text="a2 dropped middle content")]),
        UserMessage(content=[ToolResultBlock(tool_use_id="Z", content="orphan result Z")]),
    ]
    new, dropped = sliding_window(messages, max_chars=5, head_n=1, tail_n=1)
    assert dropped > 0
    use_ids, result_ids = _pair_ids(new)
    # no tool_result may reference a tool_use that is not present
    assert result_ids <= use_ids, f"orphan tool_result(s): {result_ids - use_ids}"
