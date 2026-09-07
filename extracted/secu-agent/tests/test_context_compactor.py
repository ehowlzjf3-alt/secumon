"""context_compactor — master 본문 폭증 대비.

전략: messages 리스트의 ToolResultBlock 중 "재인용 안 해도 되는" 종류 (read_file_quick,
list_share_files 등) 를 short stub 으로 치환. 마지막 N turn 결과는 유지 — 직전 호출 정보 필요.
영속화된 정보 (file_finding, share_review) 는 어차피 DB 에 있어서 잃어도 됨.
"""
from __future__ import annotations

from secu_agent.agent.llm.messages import (
    AssistantMessage, ToolResultBlock, ToolUseBlock, TextBlock, UserMessage,
)


def _u(*blocks):
    return UserMessage(content=list(blocks))


def _a(*blocks):
    return AssistantMessage(content=list(blocks))


def _tool_result(tool_use_id: str, content: str) -> ToolResultBlock:
    return ToolResultBlock(tool_use_id=tool_use_id, content=content)


def test_compact_replaces_old_compactable_tool_results():
    """read_file_quick / list_share_files 의 오래된 결과는 stub 치환."""
    from secu_agent.agent.compactor import compact_messages

    big_body = "x" * 8000

    messages = [
        _u(TextBlock(text="task: review share")),
        _a(ToolUseBlock(id="t1", name="list_share_files", input={})),
        _u(_tool_result("t1", "items: " + big_body)),  # 오래된 listing — 휘발 OK
        _a(ToolUseBlock(id="t2", name="read_file_quick", input={"file_id": 1})),
        _u(_tool_result("t2", "body lines:\n" + big_body)),  # 오래된 본문
        _a(ToolUseBlock(id="t3", name="set_file_finding", input={"file_id": 1, "severity": "high"})),
        _u(_tool_result("t3", "file#1 finding saved")),  # 짧음 — 유지
        _a(ToolUseBlock(id="t4", name="read_file_quick", input={"file_id": 2})),
        _u(_tool_result("t4", "body lines:\n" + big_body)),  # 직전 turn — 유지
    ]
    original_total = sum(_len(m) for m in messages)

    compacted, n = compact_messages(
        messages, char_threshold=10_000, keep_last_n=1,
    )

    assert n >= 1
    new_total = sum(_len(m) for m in compacted)
    assert new_total < original_total
    # 첫 user prompt 는 건드리지 않음
    assert compacted[0] == messages[0]
    # 마지막 read_file_quick (직전) 은 유지
    assert compacted[-1].content[0].content.startswith("body lines:")
    # 첫번째 list_share_files / read_file_quick (오래된) 은 stub 화
    assert "compacted" in compacted[2].content[0].content.lower()
    assert "compacted" in compacted[4].content[0].content.lower()


def test_compact_skips_when_under_threshold():
    """누적 chars 가 임계 아래면 no-op."""
    from secu_agent.agent.compactor import compact_messages

    messages = [
        _u(TextBlock(text="task")),
        _a(ToolUseBlock(id="t1", name="read_file_quick", input={})),
        _u(_tool_result("t1", "small body")),
    ]
    compacted, n = compact_messages(messages, char_threshold=30_000, keep_last_n=2)
    assert n == 0
    assert compacted == messages


def test_compact_preserves_persistence_tool_results():
    """set_file_finding / submit_share_review / memory_save / report_inspection 결과는
    짧고 결정적이라 stub 화 안 함."""
    from secu_agent.agent.compactor import compact_messages

    big = "x" * 50_000
    messages = [
        _u(TextBlock(text="t")),
        _a(ToolUseBlock(id="t1", name="set_file_finding", input={})),
        _u(_tool_result("t1", big)),  # 가짜로 길게 — 그래도 유지
        _a(ToolUseBlock(id="t2", name="read_file_quick", input={})),
        _u(_tool_result("t2", big)),  # 압축 대상
        _a(ToolUseBlock(id="t3", name="read_file_quick", input={})),
        _u(_tool_result("t3", big)),  # last — 유지
    ]
    compacted, n = compact_messages(messages, char_threshold=30_000, keep_last_n=1)
    # set_file_finding 결과 그대로
    assert compacted[2].content[0].content == big
    # 오래된 read_file_quick 만 압축
    assert "compacted" in compacted[4].content[0].content.lower()


def test_compact_preserves_text_blocks_and_tool_use_blocks():
    """assistant reasoning / ToolUseBlock 은 압축 대상 아님."""
    from secu_agent.agent.compactor import compact_messages

    big = "x" * 50_000
    messages = [
        _u(TextBlock(text="t")),
        _a(TextBlock(text="thinking..."),
           ToolUseBlock(id="t1", name="read_file_quick", input={})),
        _u(_tool_result("t1", big)),
        _a(ToolUseBlock(id="t2", name="read_file_quick", input={})),
        _u(_tool_result("t2", big)),
    ]
    compacted, n = compact_messages(messages, char_threshold=30_000, keep_last_n=1)
    # assistant text + tool_use 유지
    assert compacted[1].content[0].text == "thinking..."
    assert isinstance(compacted[1].content[1], ToolUseBlock)


def test_compact_stub_mentions_tool_name():
    """stub 메시지 안에 어떤 도구 결과였는지 적혀있어야 agent 가 헷갈리지 않음."""
    from secu_agent.agent.compactor import compact_messages

    big = "x" * 50_000
    messages = [
        _u(TextBlock(text="t")),
        _a(ToolUseBlock(id="t1", name="list_share_files", input={})),
        _u(_tool_result("t1", big)),
        _a(ToolUseBlock(id="t2", name="read_file_quick", input={"file_id": 42})),
        _u(_tool_result("t2", big)),
    ]
    compacted, n = compact_messages(messages, char_threshold=30_000, keep_last_n=0)
    stub1 = compacted[2].content[0].content
    stub2 = compacted[4].content[0].content
    assert "list_share_files" in stub1
    assert "read_file_quick" in stub2


def test_compact_includes_host_source_tools():
    """host read/search/outline 결과도 재호출 가능하므로 오래된 결과는 압축 가능."""
    from secu_agent.agent.compactor import compact_messages

    big = "x" * 50_000
    messages = [
        _u(TextBlock(text="inspect source")),
        _a(ToolUseBlock(id="t1", name="host_read", input={"path": "/tmp/a.py"})),
        _u(_tool_result("t1", big)),
        _a(ToolUseBlock(id="t2", name="host_code_outline", input={"path": "/tmp"})),
        _u(_tool_result("t2", big)),
    ]

    compacted, n = compact_messages(messages, char_threshold=30_000, keep_last_n=0)

    assert n == 2
    assert "host_read" in compacted[2].content[0].content
    assert "host_code_outline" in compacted[4].content[0].content
    assert "previous raw output was removed" in compacted[2].content[0].content


# ============================================================
# engine 통합 — run_query 가 자동으로 compact 호출
# ============================================================

def test_run_query_invokes_compactor_between_turns(monkeypatch):
    """엔진 루프가 매 turn 전 compact_messages 호출 — call site 확인."""
    import secu_agent.agent.engine as engine
    import inspect

    src = inspect.getsource(engine.run_query)
    assert "compact_messages" in src, (
        "engine.run_query 가 compact_messages 를 호출해야 한다"
    )
    assert "clear_read_state" in src, (
        "context compaction/drop 뒤 host_read dedup state 를 지워야 한다"
    )


def _len(m) -> int:
    s = 0
    for b in m.content:
        if hasattr(b, "content"):
            s += len(b.content)
        elif hasattr(b, "text"):
            s += len(b.text)
    return s
