from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent import engine as engine_module
from secu_agent.agent.engine import QueryConfig, _partition_calls, _run_tool_calls, run_query
from secu_agent.agent.events import LoopCompleted, ToolCallCompleted
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import (
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from secu_agent.agent.llm.types import (
    LLMRequest,
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
    tool_is_concurrency_safe,
)
from secu_agent.agent.tools.registry import ToolRegistry


class _ProbeInput(BaseModel):
    delay: float = 0.0
    value: str = "ok"
    error: bool = False


class _ProbeTool(Tool[_ProbeInput]):
    name: ClassVar[str] = "probe"
    description: ClassVar[str] = "test read-only probe"
    input_model: ClassVar[type[BaseModel]] = _ProbeInput
    is_read_only: ClassVar[bool] = True

    async def execute(self, vi: _ProbeInput, ctx: ToolContext) -> ToolResult:
        await asyncio.sleep(vi.delay)
        if vi.error:
            return ToolError(kind="execution", message=f"soft {vi.value}")
        return ToolSuccess(content=vi.value)


class _UnsafeReadProbeTool(_ProbeTool):
    name: ClassVar[str] = "unsafe_probe"
    description: ClassVar[str] = "test read-only probe with unsafe concurrency"
    is_concurrency_safe: ClassVar[bool] = False


class _WriteProbeTool(_ProbeTool):
    name: ClassVar[str] = "write_probe"
    description: ClassVar[str] = "test write probe"
    is_read_only: ClassVar[bool] = False


class _ConcurrencySafeWriteProbeTool(_WriteProbeTool):
    name: ClassVar[str] = "safe_write_probe"
    description: ClassVar[str] = "test write probe with safe concurrency"
    is_concurrency_safe: ClassVar[bool] = True


class _TwoProbeCallsThenCapture(LLMClient):
    def __init__(self) -> None:
        self.calls = 0
        self.tool_result_ids: list[str] = []

    @property
    def name(self) -> str:
        return "scripted-tool-batch"

    async def stream(self, request: LLMRequest) -> AsyncIterator:
        if self.calls == 0:
            self.calls += 1
            yield StreamToolUseStart(tool_use_id="A", name="probe")
            yield StreamToolUseDelta(
                tool_use_id="A",
                input_json_delta='{"delay": 0.05, "value": "A"}',
            )
            yield StreamToolUseStop(tool_use_id="A")
            yield StreamToolUseStart(tool_use_id="B", name="probe")
            yield StreamToolUseDelta(
                tool_use_id="B",
                input_json_delta='{"delay": 0.01, "value": "B"}',
            )
            yield StreamToolUseStop(tool_use_id="B")
            yield StreamMessageStop(
                stop_reason="tool_use",
                usage=StreamUsage(input_tokens=1, output_tokens=1),
            )
            return

        last = request.messages[-1]
        if isinstance(last, UserMessage):
            self.tool_result_ids = [
                block.tool_use_id
                for block in last.content
                if isinstance(block, ToolResultBlock)
            ]
        yield StreamTextDelta(text="done")
        yield StreamMessageStop(
            stop_reason="end_turn",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        )


def _registry(*extra_tool_classes: type[Tool]) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(_ProbeTool)
    for tool_cls in extra_tool_classes:
        registry.register(tool_cls)
    return registry


async def _collect(aiter):
    out = []
    async for item in aiter:
        out.append(item)
    return out


def test_tool_is_concurrency_safe_resolver_inherits_read_only_default():
    assert tool_is_concurrency_safe(_ProbeTool) is True
    assert tool_is_concurrency_safe(_WriteProbeTool) is False


def test_tool_is_concurrency_safe_resolver_honors_explicit_override():
    assert tool_is_concurrency_safe(_UnsafeReadProbeTool) is False
    assert tool_is_concurrency_safe(_ConcurrencySafeWriteProbeTool) is True


def test_partition_default_read_only_tool_stays_parallel_batched():
    registry = _registry()
    calls = [
        ToolUseBlock(id="A", name="probe", input={}),
        ToolUseBlock(id="B", name="probe", input={}),
    ]

    batches = _partition_calls(calls, registry)

    assert [(safe, [call.id for call in batch]) for safe, batch in batches] == [
        (True, ["A", "B"]),
    ]


def test_partition_read_only_concurrency_unsafe_tool_runs_alone_in_order():
    registry = _registry(_UnsafeReadProbeTool)
    calls = [
        ToolUseBlock(id="A", name="probe", input={}),
        ToolUseBlock(id="unsafe-1", name="unsafe_probe", input={}),
        ToolUseBlock(id="unsafe-2", name="unsafe_probe", input={}),
        ToolUseBlock(id="B", name="probe", input={}),
        ToolUseBlock(id="C", name="probe", input={}),
    ]

    batches = _partition_calls(calls, registry)

    assert [(safe, [call.id for call in batch]) for safe, batch in batches] == [
        (True, ["A"]),
        (False, ["unsafe-1"]),
        (False, ["unsafe-2"]),
        (True, ["B", "C"]),
    ]


def test_parallel_readonly_result_blocks_stay_in_tool_use_order(tmp_path):
    registry = _registry()
    context = ToolContext(evidence_dir=tmp_path, metadata={})
    client = _TwoProbeCallsThenCapture()

    events = asyncio.run(_collect(run_query(
        client=client,
        registry=registry,
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="run probes")])],
        system="test",
        config=QueryConfig(
            max_turns=5,
            parallel_readonly_limit=2,
            tool_guardrails=False,
        ),
    )))

    completed_ids = [
        ev.tool_use_id
        for ev in events
        if isinstance(ev, ToolCallCompleted) and ev.name == "probe"
    ]
    assert completed_ids == ["B", "A"]
    assert client.tool_result_ids == ["A", "B"]
    assert any(isinstance(ev, LoopCompleted) and ev.reason == "end_turn" for ev in events)


def test_parallel_readonly_hard_exception_cancels_pending_sibling(
    tmp_path, monkeypatch,
):
    registry = _registry()
    context = ToolContext(evidence_dir=tmp_path, metadata={})
    cancelled: list[str] = []
    recorded: list[ToolResult] = []

    async def fake_invoke(call, registry, context):
        if call.id == "fail":
            await asyncio.sleep(0.01)
            raise RuntimeError("hard boom")
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.append(call.id)
            raise
        return ToolSuccess(content="unexpected")

    def fake_record(metadata, *, tool_name, tool_input, result):
        recorded.append(result)

    monkeypatch.setattr(engine_module, "_invoke_tool_with_guardrails", fake_invoke)
    monkeypatch.setattr(engine_module, "record_mutation_result", fake_record)

    calls = [
        ToolUseBlock(id="fail", name="probe", input={}),
        ToolUseBlock(id="slow", name="probe", input={}),
    ]
    events = asyncio.run(_collect(_run_tool_calls(
        calls,
        registry,
        context,
        QueryConfig(parallel_readonly_limit=2, tool_guardrails=False),
    )))

    completed = [
        ev
        for ev, _block in events
        if isinstance(ev, ToolCallCompleted) and ev.name == "probe"
    ]
    assert [ev.tool_use_id for ev in completed] == ["fail", "slow"]
    assert isinstance(completed[0].result, ToolError)
    assert completed[0].result.kind == "execution"
    assert isinstance(completed[1].result, ToolError)
    assert completed[1].result.kind == "cancelled"
    assert cancelled == ["slow"]
    assert len(recorded) == 2

    blocks = [block for _ev, block in events if block is not None]
    assert [block.tool_use_id for block in blocks] == ["fail", "slow"]


def test_parallel_readonly_context_abort_cancels_pending_siblings(tmp_path, monkeypatch):
    registry = _registry()
    context = ToolContext(evidence_dir=tmp_path, metadata={})
    cancelled: list[str] = []
    recorded: list[ToolResult] = []

    async def fake_invoke(call, registry, context):
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.append(call.id)
            raise
        return ToolSuccess(content="unexpected")

    async def abort_soon():
        await asyncio.sleep(0.01)
        context.signal.set()

    async def run_batch(calls):
        abort_task = asyncio.create_task(abort_soon())
        try:
            return await _collect(_run_tool_calls(
                calls,
                registry,
                context,
                QueryConfig(parallel_readonly_limit=2, tool_guardrails=False),
            ))
        finally:
            await abort_task

    def fake_record(metadata, *, tool_name, tool_input, result):
        recorded.append(result)

    monkeypatch.setattr(engine_module, "_invoke_tool_with_guardrails", fake_invoke)
    monkeypatch.setattr(engine_module, "record_mutation_result", fake_record)

    calls = [
        ToolUseBlock(id="A", name="probe", input={}),
        ToolUseBlock(id="B", name="probe", input={}),
    ]
    events = asyncio.run(run_batch(calls))

    completed = [
        ev
        for ev, _block in events
        if isinstance(ev, ToolCallCompleted) and ev.name == "probe"
    ]
    assert {ev.tool_use_id for ev in completed} == {"A", "B"}
    assert all(isinstance(ev.result, ToolError) for ev in completed)
    assert all(ev.result.kind == "cancelled" for ev in completed)
    assert set(cancelled) == {"A", "B"}
    assert len(recorded) == 2


def test_parallel_readonly_tool_error_does_not_cancel_sibling(tmp_path, monkeypatch):
    registry = _registry()
    context = ToolContext(evidence_dir=tmp_path, metadata={})
    recorded: list[ToolResult] = []

    def fake_record(metadata, *, tool_name, tool_input, result):
        recorded.append(result)

    monkeypatch.setattr(engine_module, "record_mutation_result", fake_record)

    calls = [
        ToolUseBlock(
            id="A",
            name="probe",
            input={"delay": 0.01, "value": "A", "error": True},
        ),
        ToolUseBlock(
            id="B",
            name="probe",
            input={"delay": 0.03, "value": "B"},
        ),
    ]
    events = asyncio.run(_collect(_run_tool_calls(
        calls,
        registry,
        context,
        QueryConfig(parallel_readonly_limit=2, tool_guardrails=False),
    )))

    completed = {
        ev.tool_use_id: ev
        for ev, _block in events
        if isinstance(ev, ToolCallCompleted) and ev.name == "probe"
    }
    assert isinstance(completed["A"].result, ToolError)
    assert completed["A"].result.kind == "execution"
    assert isinstance(completed["B"].result, ToolSuccess)
    assert completed["B"].result.content == "B"
    assert len(recorded) == 2
