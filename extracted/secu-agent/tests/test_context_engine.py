"""ContextEngine — cheap stub compaction + LLM summary policy."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass

from secu_agent.agent.context_summarizer import ContextSummarizer
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import (
    AssistantMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage,
)
from secu_agent.agent.llm.types import (
    LLMRequest, StreamMessageStop, StreamTextDelta,
)


@dataclass
class _SummaryClient(LLMClient):
    summary_text: str = "## Active Task\nNone.\n\n## Completed Actions\n압축됨"
    calls: list[LLMRequest] | None = None

    def __post_init__(self):
        if self.calls is None:
            self.calls = []

    @property
    def name(self) -> str:
        return "summary-test"

    async def stream(self, request: LLMRequest) -> AsyncIterator:
        assert self.calls is not None
        self.calls.append(request)
        yield StreamTextDelta(text=self.summary_text)
        yield StreamMessageStop(stop_reason="end_turn")


def _u(text: str) -> UserMessage:
    return UserMessage(content=[TextBlock(text=text)])


def _a(text: str) -> AssistantMessage:
    return AssistantMessage(content=[TextBlock(text=text)])


def _tool_pair(tool_use_id: str, name: str, result: str):
    return [
        AssistantMessage(content=[ToolUseBlock(id=tool_use_id, name=name, input={})]),
        UserMessage(content=[ToolResultBlock(tool_use_id=tool_use_id, content=result)]),
    ]


def _run(coro):
    return asyncio.run(coro)


def test_context_engine_off_mode_noops_even_over_threshold():
    from secu_agent.agent.context_engine import ContextEngine, ContextEnginePolicy

    messages = [_u("x" * 5000), *_tool_pair("t1", "read_file_quick", "y" * 5000)]
    engine = ContextEngine(policy=ContextEnginePolicy(mode="off"))

    new_messages, stats = _run(engine.compress(messages))

    assert new_messages == messages
    assert not stats.triggered
    assert stats.mode == "off"


def test_context_engine_stub_mode_compacts_without_summary():
    from secu_agent.agent.context_engine import ContextEngine, ContextEnginePolicy

    messages = [
        _u("task"),
        *_tool_pair("t1", "read_file_quick", "body " + "x" * 8000),
        _a("final"),
    ]
    engine = ContextEngine(policy=ContextEnginePolicy(
        mode="stub",
        stub_threshold_chars=100,
        stub_keep_last_n=0,
    ))

    new_messages, stats = _run(engine.compress(messages))

    assert stats.triggered
    assert stats.stub_compacted == 1
    assert not stats.summary_triggered
    assert "compacted" in new_messages[2].content[0].content.lower()


def test_context_engine_hybrid_skips_summary_when_stub_is_enough():
    from secu_agent.agent.context_engine import ContextEngine, ContextEnginePolicy

    client = _SummaryClient()
    summarizer = ContextSummarizer(client=client, threshold_chars=50_000)
    messages = [
        _u("task"),
        *_tool_pair("t1", "read_file_quick", "body " + "x" * 8000),
        _a("short tail"),
        _u("current ask"),
    ]
    engine = ContextEngine(
        policy=ContextEnginePolicy(
            mode="hybrid",
            stub_threshold_chars=100,
            stub_keep_last_n=0,
        ),
        summarizer=summarizer,
    )

    _new_messages, stats = _run(engine.compress(messages))

    assert stats.triggered
    assert stats.stub_compacted == 1
    assert not stats.summary_triggered
    assert client.calls == []


def test_context_engine_hybrid_runs_summary_when_still_over_threshold():
    from secu_agent.agent.context_engine import ContextEngine, ContextEnginePolicy

    client = _SummaryClient()
    summarizer = ContextSummarizer(
        client=client,
        threshold_chars=1000,
        protect_first_n=1,
        tail_char_budget=100,
    )
    messages = [
        _u("start"),
        _a("a" * 1500),
        _u("b" * 1500),
        _a("c" * 1500),
        _u("d" * 1500),
        _a("e" * 1500),
        _u("current ask"),
    ]
    engine = ContextEngine(
        policy=ContextEnginePolicy(mode="hybrid", stub_threshold_chars=100),
        summarizer=summarizer,
    )

    new_messages, stats = _run(engine.compress(messages))

    assert stats.triggered
    assert stats.summary_triggered
    assert stats.summary_stats is not None
    assert len(client.calls or []) == 1
    assert len(new_messages) < len(messages)


def test_context_engine_policy_from_env(monkeypatch):
    from secu_agent.agent.context_engine import ContextEnginePolicy

    monkeypatch.setenv("SA_CONTEXT_ENGINE_MODE", "stub")
    monkeypatch.setenv("SA_CONTEXT_STUB_THRESHOLD_CHARS", "1234")
    monkeypatch.setenv("SA_CONTEXT_STUB_KEEP_LAST_N", "7")

    policy = ContextEnginePolicy.from_env(
        default_stub_threshold_chars=60_000,
        default_stub_keep_last_n=2,
    )

    assert policy.mode == "stub"
    assert policy.stub_threshold_chars == 1234
    assert policy.stub_keep_last_n == 7
