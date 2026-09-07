from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.engine import QueryConfig, run_query
from secu_agent.agent.events import (
    LlmCallMeasured,
    LoopCompleted,
    ToolCallCompleted,
    ToolCallStarted,
)
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import (
    TextBlock,
    ToolResultBlock,
    UserMessage,
)
from secu_agent.agent.llm.types import (
    LLMRequest,
    StreamEvent,
    StreamMessageStop,
    StreamTextDelta,
    StreamToolUseDelta,
    StreamToolUseStart,
    StreamToolUseStop,
    StreamUsage,
)
from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    ToolSuccess,
)
from secu_agent.agent.tools.registry import ToolRegistry


class _TimedInput(BaseModel):
    delay: float = 0.0
    value: str = "ok"


class _ReadTool(Tool[_TimedInput]):
    name: ClassVar[str] = "stream_read"
    description: ClassVar[str] = "test read-only stream tool"
    input_model: ClassVar[type[BaseModel]] = _TimedInput
    is_read_only: ClassVar[bool] = True

    async def execute(self, vi: _TimedInput, ctx: ToolContext) -> ToolResult:
        starts = ctx.metadata.setdefault("starts", {})
        ends = ctx.metadata.setdefault("ends", {})
        order = ctx.metadata.setdefault("start_order", [])
        starts[vi.value] = time.perf_counter()
        order.append(vi.value)
        try:
            await asyncio.sleep(vi.delay)
        except asyncio.CancelledError:
            ctx.metadata.setdefault("cancelled", []).append(vi.value)
            raise
        ends[vi.value] = time.perf_counter()
        return ToolSuccess(content=vi.value)


class _WriteTool(_ReadTool):
    name: ClassVar[str] = "stream_write"
    description: ClassVar[str] = "test write stream tool"
    is_read_only: ClassVar[bool] = False


class _Sleep:
    def __init__(self, seconds: float) -> None:
        self.seconds = seconds


class _Abort:
    pass


class _MarkStop:
    pass


class _ScriptedClient(LLMClient):
    def __init__(
        self,
        steps: list[StreamEvent | _Sleep | _Abort | _MarkStop],
        context: ToolContext,
    ):
        self.steps = steps
        self.context = context
        self.calls = 0
        self.message_stop_seen_at: float | None = None
        self.tool_result_ids: list[str] = []
        self.tool_result_contents: list[str] = []
        self.tool_result_errors: list[bool] = []

    @property
    def name(self) -> str:
        return "scripted-streaming-exec"

    async def stream(self, request: LLMRequest) -> AsyncIterator[StreamEvent]:
        if self.calls == 0:
            self.calls += 1
            for step in self.steps:
                if isinstance(step, _Sleep):
                    await asyncio.sleep(step.seconds)
                    continue
                if isinstance(step, _Abort):
                    self.context.signal.set()
                    continue
                if isinstance(step, _MarkStop):
                    self.message_stop_seen_at = time.perf_counter()
                    continue
                yield step
            return

        self.calls += 1
        last = request.messages[-1]
        if isinstance(last, UserMessage):
            result_blocks = [
                block for block in last.content if isinstance(block, ToolResultBlock)
            ]
            self.tool_result_ids = [block.tool_use_id for block in result_blocks]
            self.tool_result_contents = [block.content for block in result_blocks]
            self.tool_result_errors = [block.is_error for block in result_blocks]
        yield StreamTextDelta(text="done")
        yield StreamMessageStop(
            stop_reason="end_turn",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        )


def _registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(_ReadTool)
    registry.register(_WriteTool)
    return registry


def _tool_start(tool_use_id: str, name: str, payload: str) -> StreamToolUseStart:
    return StreamToolUseStart(tool_use_id=tool_use_id, name=name)


def _tool_delta(tool_use_id: str, payload: str) -> StreamToolUseDelta:
    return StreamToolUseDelta(tool_use_id=tool_use_id, input_json_delta=payload)


def _tool_stop(tool_use_id: str) -> StreamToolUseStop:
    return StreamToolUseStop(tool_use_id=tool_use_id)


async def _collect(aiter):
    out = []
    async for item in aiter:
        out.append(item)
    return out


def _run(client: _ScriptedClient, context: ToolContext):
    return asyncio.run(_collect(run_query(
        client=client,
        registry=_registry(),
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="run tools")])],
        system="test",
        config=QueryConfig(
            max_turns=3,
            parallel_readonly_limit=2,
            tool_guardrails=False,
        ),
    )))


def test_sealed_tool_starts_before_message_stop(tmp_path):
    context = ToolContext(evidence_dir=tmp_path, metadata={})
    client = _ScriptedClient([
        _tool_start("A", "stream_read", "A"),
        _tool_delta("A", '{"delay": 0.01, "value": "A"}'),
        _tool_stop("A"),
        _Sleep(0.03),
        StreamTextDelta(text="tail"),
        _MarkStop(),
        StreamMessageStop(
            stop_reason="tool_use",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        ),
    ], context)

    events = _run(client, context)

    assert context.metadata["starts"]["A"] < client.message_stop_seen_at
    assert any(isinstance(ev, ToolCallStarted) and ev.tool_use_id == "A" for ev in events)
    assert any(isinstance(ev, ToolCallCompleted) and ev.tool_use_id == "A" for ev in events)


def test_parallel_completion_reassembles_history_in_tool_use_order(tmp_path):
    context = ToolContext(evidence_dir=tmp_path, metadata={})
    client = _ScriptedClient([
        _tool_start("A", "stream_read", "A"),
        _tool_delta("A", '{"delay": 0.05, "value": "A"}'),
        _tool_stop("A"),
        _tool_start("B", "stream_read", "B"),
        _tool_delta("B", '{"delay": 0.01, "value": "B"}'),
        _tool_stop("B"),
        _Sleep(0.02),
        _MarkStop(),
        StreamMessageStop(
            stop_reason="tool_use",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        ),
    ], context)

    events = _run(client, context)

    completed_ids = [
        ev.tool_use_id for ev in events if isinstance(ev, ToolCallCompleted)
    ]
    assert completed_ids == ["B", "A"]
    assert client.tool_result_ids == ["A", "B"]
    assert context.metadata["starts"]["B"] < context.metadata["ends"]["A"]


def test_unsafe_tool_is_ordering_barrier(tmp_path):
    context = ToolContext(evidence_dir=tmp_path, metadata={})
    client = _ScriptedClient([
        _tool_start("A", "stream_read", "A"),
        _tool_delta("A", '{"delay": 0.03, "value": "A"}'),
        _tool_stop("A"),
        _tool_start("B", "stream_write", "B"),
        _tool_delta("B", '{"delay": 0.01, "value": "B"}'),
        _tool_stop("B"),
        _tool_start("C", "stream_read", "C"),
        _tool_delta("C", '{"delay": 0.0, "value": "C"}'),
        _tool_stop("C"),
        StreamMessageStop(
            stop_reason="tool_use",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        ),
    ], context)

    _run(client, context)

    assert context.metadata["start_order"] == ["A", "B", "C"]
    assert context.metadata["starts"]["B"] >= context.metadata["ends"]["A"]
    assert context.metadata["starts"]["C"] >= context.metadata["ends"]["B"]


def test_abort_mid_stream_cancels_in_flight_and_appends_no_partial_turn(tmp_path):
    context = ToolContext(evidence_dir=tmp_path, metadata={})
    client = _ScriptedClient([
        _tool_start("A", "stream_read", "A"),
        _tool_delta("A", '{"delay": 10.0, "value": "A"}'),
        _tool_stop("A"),
        _Sleep(0.02),
        _Abort(),
        StreamTextDelta(text="after abort"),
        StreamMessageStop(
            stop_reason="tool_use",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        ),
    ], context)

    events = _run(client, context)

    completed = [ev for ev in events if isinstance(ev, ToolCallCompleted)]
    loop_completed = [ev for ev in events if isinstance(ev, LoopCompleted)][-1]
    assert completed == []
    assert loop_completed.reason == "aborted"
    assert loop_completed.final_message is None
    assert context.metadata["cancelled"] == ["A"]
    assert client.calls == 1
    assert client.tool_result_ids == []


def test_truncated_unsealed_tool_use_is_not_dispatched(tmp_path):
    context = ToolContext(evidence_dir=tmp_path, metadata={})
    client = _ScriptedClient([
        _tool_start("A", "stream_read", "A"),
        _tool_delta("A", '{"delay": 0.0, "value": "A"}'),
        StreamMessageStop(
            stop_reason="max_tokens",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        ),
    ], context)

    events = _run(client, context)

    assert "starts" not in context.metadata
    assert not any(isinstance(ev, ToolCallStarted) for ev in events)
    assert client.calls == 1
    assert client.tool_result_ids == []
    assert [ev.reason for ev in events if isinstance(ev, LoopCompleted)] == ["max_tokens"]


def test_unparseable_tool_args_route_to_post_stream_feedback_once(tmp_path):
    context = ToolContext(evidence_dir=tmp_path, metadata={})
    client = _ScriptedClient([
        _tool_start("A", "stream_read", "A"),
        _tool_delta("A", '{"delay": '),
        _tool_stop("A"),
        StreamMessageStop(
            stop_reason="tool_use",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        ),
    ], context)

    events = _run(client, context)

    started = [
        ev for ev in events
        if isinstance(ev, ToolCallStarted) and ev.tool_use_id == "A"
    ]
    completed = [
        ev for ev in events
        if isinstance(ev, ToolCallCompleted) and ev.tool_use_id == "A"
    ]
    first_llm_measured = next(
        idx for idx, ev in enumerate(events) if isinstance(ev, LlmCallMeasured)
    )
    first_tool_started = next(
        idx for idx, ev in enumerate(events)
        if isinstance(ev, ToolCallStarted) and ev.tool_use_id == "A"
    )

    assert "starts" not in context.metadata
    assert len(started) == 1
    assert len(completed) == 1
    assert started[0].input == {"__parse_error": '{"delay": '}
    assert first_tool_started > first_llm_measured
    assert isinstance(completed[0].result, ToolError)
    assert completed[0].result.kind == "validation"
    assert "tool arguments were not valid JSON" in completed[0].result.message
    assert client.tool_result_ids == ["A"]
    assert client.tool_result_errors == [True]
    assert "tool arguments were not valid JSON" in client.tool_result_contents[0]
