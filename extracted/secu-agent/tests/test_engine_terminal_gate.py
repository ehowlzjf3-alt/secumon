"""엔진 terminal-tool 계약 게이트 — 필수 종료 도구를 텍스트로만 서술하고 끝낸
워커 되돌리기(candidate ledger 침묵 게이트의 형제: "미종료")."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import ClassVar

import pytest
from pydantic import BaseModel

from secu_agent.agent.candidate_ledger import record_candidates_seen
from secu_agent.agent.engine import QueryConfig, run_query
from secu_agent.agent.events import LoopCompleted, LoopError, ToolCallCompleted
from secu_agent.agent.eval.scripted_llm import (
    ScriptedLLMClient,
    ScriptedToolCall,
    ScriptedTurn,
)
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.llm.types import (
    LLMRequest,
    StreamEvent,
    StreamMessageStop,
    StreamToolUseDelta,
    StreamToolUseStart,
    StreamToolUseStop,
)
from secu_agent.agent.tools.base import Tool, ToolContext, ToolResult, ToolSuccess
from secu_agent.agent.tools.registry import ToolRegistry
from secu_agent.agent.tools.triage_candidates import TriageCandidatesTool


class _NoopInput(BaseModel):
    pass


class _SetDoneTool(Tool[_NoopInput]):
    """set_status 류 terminal 도구 모사."""

    name: ClassVar[str] = "set_done"
    description: ClassVar[str] = "test terminal set-status tool"
    input_model: ClassVar[type[BaseModel]] = _NoopInput
    is_read_only: ClassVar[bool] = False

    async def execute(self, validated_input: _NoopInput, context: ToolContext) -> ToolResult:
        del validated_input, context
        return ToolSuccess(content="status set")


class _DeferredSetDoneTool(_SetDoneTool):
    """deferred(unlock 필요) terminal 도구 — unlock 전엔 모델에 광고 안 됨."""

    name: ClassVar[str] = "set_done_deferred"
    deferred: ClassVar[bool] = True


# 동시성 시나리오용 — 종료 도구는 non-concurrency-safe 라 blocker 뒤에 큐잉된다.
_EXEC_LOG: list[str] = []


class _SlowAbortTool(Tool[_NoopInput]):
    """실행 즉시 abort 신호를 켜고 잠시 지연 — 뒤에 큐잉된 종료 도구가 취소되게."""

    name: ClassVar[str] = "slow_abort"
    description: ClassVar[str] = "slow blocker that aborts"
    input_model: ClassVar[type[BaseModel]] = _NoopInput
    is_read_only: ClassVar[bool] = False  # non-concurrency-safe → 순차 실행

    async def execute(self, validated_input: _NoopInput, context: ToolContext) -> ToolResult:
        del validated_input
        context.signal.set()          # abort during execution
        await asyncio.sleep(0.05)
        _EXEC_LOG.append("slow_abort")
        return ToolSuccess(content="ok")


class _SlowBlockerTool(Tool[_NoopInput]):
    """abort 없이 그냥 느린 blocker — 예외 경로 leak 검증용."""

    name: ClassVar[str] = "slow_blocker"
    description: ClassVar[str] = "slow blocker"
    input_model: ClassVar[type[BaseModel]] = _NoopInput
    is_read_only: ClassVar[bool] = False

    async def execute(self, validated_input: _NoopInput, context: ToolContext) -> ToolResult:
        del validated_input, context
        await asyncio.sleep(0.03)
        _EXEC_LOG.append("slow_blocker")
        return ToolSuccess(content="ok")


class _RecordingTerminalTool(Tool[_NoopInput]):
    """실행되면 로그에 남기는 종료 도구 — dispatch 여부 관측용."""

    name: ClassVar[str] = "set_done"
    description: ClassVar[str] = "terminal that records execution"
    input_model: ClassVar[type[BaseModel]] = _NoopInput
    is_read_only: ClassVar[bool] = False

    async def execute(self, validated_input: _NoopInput, context: ToolContext) -> ToolResult:
        del validated_input, context
        _EXEC_LOG.append("set_done")
        return ToolSuccess(content="status set")


def _collect(aiter):
    async def _go():
        return [ev async for ev in aiter]
    return asyncio.run(_go())


def _registry(*, with_set_done: bool = True, with_triage: bool = False) -> ToolRegistry:
    registry = ToolRegistry()
    if with_set_done:
        registry.register(_SetDoneTool)
    if with_triage:
        registry.register(TriageCandidatesTool)
    return registry


def _ctx(tmp_path, *, require: bool = True) -> ToolContext:
    metadata: dict = {"terminal_tools": {"set_done"}}
    if require:
        metadata["require_terminal_tool"] = True
    return ToolContext(evidence_dir=tmp_path, metadata=metadata)


def test_text_only_terminal_gets_reminder_then_tool_completes(tmp_path):
    """수용기준 1: 종료를 텍스트로만 냄 → 리마인더 → 실제 tool 호출 → 정상 완료."""
    client = ScriptedLLMClient(turns=[
        # 종료 도구 인자를 tool_use 가 아니라 텍스트(JSON)로만 서술 (weak-model 실패모드)
        ScriptedTurn(text='{"target_ids":[1,2],"status":"tasked","finding_count":0}'),
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="set_done", input={}, id="d1")]),
    ])
    context = _ctx(tmp_path)

    events = _collect(run_query(
        client=client, registry=_registry(), context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검 진행")])],
        config=QueryConfig(max_turns=5),
    ))

    assert context.metadata["terminal_tool_reminder_count"] == 1
    assert any(
        isinstance(ev, ToolCallCompleted) and ev.name == "set_done" for ev in events
    )
    assert context.metadata.get("terminal_tool_invoked") is True
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "end_turn"


def test_gate_inert_without_require_flag(tmp_path):
    """수용기준 2: require_terminal_tool 미설정(chat) → 비발동, 텍스트 종료 수용."""
    client = ScriptedLLMClient(turns=[ScriptedTurn(text="요약만 남기고 종료.")])
    context = _ctx(tmp_path, require=False)

    events = _collect(run_query(
        client=client, registry=_registry(), context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="질문")])],
        config=QueryConfig(max_turns=3),
    ))

    assert "terminal_tool_reminder_count" not in context.metadata
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "end_turn"


def test_stubborn_text_only_escalates_to_contract_violation(tmp_path):
    """수용기준 3: 리마인더 예산 소진 → contract_violation (무한 continue 없음)."""
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(text="끝났습니다."),
        ScriptedTurn(text="정말 끝났습니다."),
        ScriptedTurn(text="이미 종료했습니다."),
    ])
    context = _ctx(tmp_path)

    events = _collect(run_query(
        client=client, registry=_registry(), context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검 진행")])],
        config=QueryConfig(max_turns=6),
    ))

    assert context.metadata["terminal_tool_reminder_count"] == 2
    errors = [ev for ev in events if isinstance(ev, LoopError)]
    assert any("terminal tool contract" in ev.message for ev in errors)
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "contract_violation"


def test_gate_inert_when_terminal_tool_not_registered(tmp_path):
    """이행 불가능한 요구 금지 — 종료 도구가 toolset 에 없으면 게이트 비발동."""
    client = ScriptedLLMClient(turns=[ScriptedTurn(text="done")])
    # require + terminal_tools 지정했지만 set_done 을 registry 에 등록하지 않음.
    context = _ctx(tmp_path)

    events = _collect(run_query(
        client=client, registry=_registry(with_set_done=False), context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검")])],
        config=QueryConfig(max_turns=3),
    ))

    assert "terminal_tool_reminder_count" not in context.metadata
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "end_turn"


def test_no_false_reminder_after_real_terminal_invocation(tmp_path):
    """크로스-턴 가드: 종료 도구를 실제 호출한 뒤(candidate-continue 로 텍스트-only
    턴이 뒤따라도) 게이트가 미호출로 오인해 리마인더를 쏘지 않는다."""
    client = ScriptedLLMClient(turns=[
        # 1) 종료 도구 실호출 → terminal_tool_invoked=True. 단 후보 미정산이라
        #    candidate 게이트가 완료를 미루고 continue.
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="set_done", input={}, id="d1")]),
        # 2) 후보 정산(triage) → 화해.
        ScriptedTurn(tool_calls=[ScriptedToolCall(
            name="triage_candidates",
            input={"dispositions": [{
                "location": "https://conf.example/page1",
                "reason": "로그인 요구 — 인증 없이 데이터 미노출",
            }]},
            id="t1",
        )]),
        # 3) 텍스트-only 종료 — 이미 종료 도구를 불렀으므로 terminal 게이트 비발동.
        ScriptedTurn(text="정산 완료, 종료."),
    ])
    context = _ctx(tmp_path)
    context.metadata["candidate_ledger_enforce"] = True
    record_candidates_seen(
        context.metadata, source_tool="scan_text", count=1,
        samples=("secret/password@page1",),
    )

    events = _collect(run_query(
        client=client, registry=_registry(with_triage=True), context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검 진행")])],
        config=QueryConfig(max_turns=6),
    ))

    # 종료 도구를 실제 호출했으므로 terminal 리마인더는 한 번도 안 나간다.
    assert "terminal_tool_reminder_count" not in context.metadata
    assert context.metadata.get("terminal_tool_invoked") is True
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "end_turn"


def test_gate_inert_when_terminal_tool_deferred_and_locked(tmp_path):
    """이행 불가능한 요구 금지(codex) — 종료 도구가 deferred 인데 unlock 안 돼
    모델에 광고조차 안 되면 게이트 비발동(잠긴 도구 요구 = 오탐 방지)."""
    client = ScriptedLLMClient(turns=[ScriptedTurn(text="done")])
    registry = ToolRegistry()
    registry.register(_DeferredSetDoneTool)
    context = ToolContext(evidence_dir=tmp_path, metadata={
        "terminal_tools": {"set_done_deferred"},
        "require_terminal_tool": True,
    })

    events = _collect(run_query(
        client=client, registry=registry, context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검")])],
        config=QueryConfig(max_turns=3),
        unlocked_tools=set(),  # deferred 도구 미unlock → 광고 안 됨
    ))

    assert "terminal_tool_reminder_count" not in context.metadata
    assert not [ev for ev in events if isinstance(ev, LoopError)]
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "end_turn"


def test_gate_fires_when_terminal_tool_deferred_but_unlocked(tmp_path):
    """반대 축 — deferred 종료 도구가 unlock 돼 광고되면 게이트 정상 발동."""
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(text='{"status":"tasked"}'),
        ScriptedTurn(text='{"status":"tasked"}'),
        ScriptedTurn(text='{"status":"tasked"}'),
    ])
    registry = ToolRegistry()
    registry.register(_DeferredSetDoneTool)
    context = ToolContext(evidence_dir=tmp_path, metadata={
        "terminal_tools": {"set_done_deferred"},
        "require_terminal_tool": True,
    })

    events = _collect(run_query(
        client=client, registry=registry, context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검")])],
        config=QueryConfig(max_turns=6),
        unlocked_tools={"set_done_deferred"},  # 광고됨 → 요구 가능
    ))

    assert context.metadata["terminal_tool_reminder_count"] == 2
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "contract_violation"


class _TerminalThenMaxTokens(LLMClient):
    """종료 도구를 스트리밍 tool_use 로 낸 뒤 스트림이 max_tokens 로 잘림 —
    engine 이 결과 처리(_record_tool_event) 전에 조기 return 하는 경로."""

    @property
    def name(self) -> str:
        return "terminal-then-max-tokens"

    async def stream(self, request: LLMRequest) -> AsyncIterator[StreamEvent]:
        del request
        yield StreamToolUseStart(tool_use_id="t1", name="set_done")
        yield StreamToolUseDelta(tool_use_id="t1", input_json_delta="{}")
        yield StreamToolUseStop(tool_use_id="t1")
        await asyncio.sleep(0.02)   # 종료 도구가 실제 execute 진입하도록 양보
        yield StreamMessageStop(stop_reason="max_tokens")


def test_streaming_terminal_truncated_by_max_tokens_sets_flag_no_false_reminder(tmp_path):
    """codex 회귀: 종료 도구가 실제 실행(execute 진입)한 뒤 스트림이 max_tokens 로
    잘려 결과가 discard 돼도, invoker choke-point 플래그가 set 되어 이후 같은
    context resume 에서 게이트가 오탐(contract_violation)하지 않는다."""
    context = _ctx(tmp_path)

    # 1차: 종료 tool_use + max_tokens 조기 종료.
    first = _collect(run_query(
        client=_TerminalThenMaxTokens(), registry=_registry(), context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검")])],
        config=QueryConfig(max_turns=3),
    ))
    assert [e.reason for e in first if isinstance(e, LoopCompleted)] == ["max_tokens"]
    # tool_use 를 실제로 냈으므로 플래그가 set 됐다(결과 discard 여부와 무관).
    assert context.metadata.get("terminal_tool_invoked") is True

    # 2차: 같은 context 로 resume + 텍스트-only → 오탐 없어야 함.
    second = _collect(run_query(
        client=ScriptedLLMClient(turns=[ScriptedTurn(text="이미 종료함.")]),
        registry=_registry(), context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="resume")])],
        config=QueryConfig(max_turns=3),
    ))
    assert not [ev for ev in second if isinstance(ev, LoopError)]
    assert "terminal_tool_reminder_count" not in context.metadata
    done = [ev for ev in second if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "end_turn"


def test_reminder_and_violation_exclude_locked_deferred_terminal(tmp_path):
    """codex R6-4: 종료 도구가 여럿이고 일부가 잠긴 deferred 면, reminder/violation
    은 **광고된(호출 가능한)** 부분집합만 언급한다 — 잠긴 도구를 요구하면 이행
    불가능하다."""
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(text="끝."), ScriptedTurn(text="끝."), ScriptedTurn(text="끝."),
    ])
    registry = ToolRegistry()
    registry.register(_SetDoneTool)          # non-deferred → 광고됨
    registry.register(_DeferredSetDoneTool)  # deferred → unlock 안 하면 미광고
    context = ToolContext(evidence_dir=tmp_path, metadata={
        "terminal_tools": {"set_done", "set_done_deferred"},
        "require_terminal_tool": True,
    })

    events = _collect(run_query(
        client=client, registry=registry, context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검")])],
        config=QueryConfig(max_turns=6),
        unlocked_tools=set(),  # deferred 미unlock
    ))

    errors = [ev for ev in events if isinstance(ev, LoopError)]
    assert errors, "contract_violation 이 나야 한다"
    msg = errors[-1].message
    assert "set_done" in msg
    assert "set_done_deferred" not in msg  # 잠긴 deferred 는 제외


class _TwoToolsThen(LLMClient):
    """slow blocker + 종료 도구를 같은 턴에 낸 뒤, 지정한 종결(end_turn/raise)."""

    def __init__(self, blocker_name: str, *, raise_after: bool):
        self._blocker = blocker_name
        self._raise = raise_after

    @property
    def name(self) -> str:
        return "two-tools"

    async def stream(self, request: LLMRequest) -> AsyncIterator[StreamEvent]:
        del request
        yield StreamToolUseStart(tool_use_id="b", name=self._blocker)
        yield StreamToolUseDelta(tool_use_id="b", input_json_delta="{}")
        yield StreamToolUseStop(tool_use_id="b")
        yield StreamToolUseStart(tool_use_id="t", name="set_done")
        yield StreamToolUseDelta(tool_use_id="t", input_json_delta="{}")
        yield StreamToolUseStop(tool_use_id="t")
        if self._raise:
            raise RuntimeError("stream boom")
        await asyncio.sleep(0.02)
        from secu_agent.agent.llm.types import StreamMessageStop
        yield StreamMessageStop(stop_reason="end_turn")


def _reg_concurrency(blocker_cls) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(blocker_cls)
    registry.register(_RecordingTerminalTool)
    return registry


def test_aborted_queued_terminal_not_marked_invoked(tmp_path):
    """codex R4-2: running blocker 가 abort → 뒤에 큐잉된 종료 도구는 취소되어
    execute 진입 없음 → 플래그 미set(디스패치 아님). resume 게이트 정상 발동."""
    _EXEC_LOG.clear()
    context = _ctx(tmp_path)
    _collect(run_query(
        client=_TwoToolsThen("slow_abort", raise_after=False),
        registry=_reg_concurrency(_SlowAbortTool), context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검")])],
        config=QueryConfig(tool_guardrails=False, max_turns=3),
    ))
    # 종료 도구는 취소돼 실행되지 않았다.
    assert "set_done" not in _EXEC_LOG
    # 디스패치 안 됐으므로 플래그 미set → 게이트가 나중에 발동할 수 있다.
    assert context.metadata.get("terminal_tool_invoked") is not True


def test_stream_exception_cancels_executor_no_terminal_leak(tmp_path):
    """codex R4-1: 스트림 예외 시 실행기를 취소해 종료 도구가 leak 실행되지 않는다
    (반환 후 지각 dispatch 로 플래그가 뒤늦게 set 되는 타이밍 갭 제거)."""
    _EXEC_LOG.clear()
    context = _ctx(tmp_path)
    with pytest.raises(RuntimeError, match="stream boom"):
        _collect(run_query(
            client=_TwoToolsThen("slow_blocker", raise_after=True),
            registry=_reg_concurrency(_SlowBlockerTool), context=context,
            initial_messages=[UserMessage(content=[TextBlock(text="점검")])],
            config=QueryConfig(tool_guardrails=False, max_turns=3),
        ))
    # 예외 후 leak 실행이 붙지 않도록 잠시 양보.
    _collect_sleep()
    assert "set_done" not in _EXEC_LOG        # 종료 도구 leak 실행 없음
    assert context.metadata.get("terminal_tool_invoked") is not True


def _collect_sleep():
    async def _s():
        await asyncio.sleep(0.1)
    asyncio.run(_s())


class _TerminalThenRaise(LLMClient):
    """종료 도구를 스트리밍 tool_use 로 낸 직후 스트림이 예외로 죽음 — 종료 도구는
    execute 진입 전에 취소된다(codex R6: dispatch≠execute)."""

    @property
    def name(self) -> str:
        return "terminal-then-raise"

    async def stream(self, request: LLMRequest) -> AsyncIterator[StreamEvent]:
        del request
        yield StreamToolUseStart(tool_use_id="t1", name="set_done")
        yield StreamToolUseDelta(tool_use_id="t1", input_json_delta="{}")
        yield StreamToolUseStop(tool_use_id="t1")
        raise RuntimeError("stream boom")


def test_stream_exception_before_terminal_execute_leaves_flag_unset(tmp_path):
    """codex R6: 종료 도구 tool_use 직후 스트림 예외 → 실행기 취소로 execute 진입
    안 함 → 플래그 미set(디스패치≠실행). resume 에서 게이트가 올바르게 발동해야
    한다(종료 도구가 실제로 실행되지 않았으므로)."""
    context = _ctx(tmp_path)
    with pytest.raises(RuntimeError, match="stream boom"):
        _collect(run_query(
            client=_TerminalThenRaise(), registry=_registry(), context=context,
            initial_messages=[UserMessage(content=[TextBlock(text="점검")])],
            config=QueryConfig(max_turns=3),
        ))
    # execute 진입 없음 → 플래그 미set → false-suppression 없음.
    assert context.metadata.get("terminal_tool_invoked") is not True


class _BareTerminalStartThenMaxTokens(LLMClient):
    """종료 도구 ToolUseStart 만 내고 Stop 없이 max_tokens 로 잘림 — seal/dispatch
    안 됨(실행 0). '텍스트로만 서술'이 아니라 '잘린 tool_use' 지만, 실제 종료
    신호(디스패치)는 없었다."""

    @property
    def name(self) -> str:
        return "bare-terminal-start-then-max-tokens"

    async def stream(self, request: LLMRequest) -> AsyncIterator[StreamEvent]:
        del request
        yield StreamToolUseStart(tool_use_id="t1", name="set_done")
        # ToolUseStop 없음 → 미seal → 미dispatch.
        yield StreamMessageStop(stop_reason="max_tokens")


def test_bare_terminal_start_not_dispatched_does_not_set_flag(tmp_path):
    """codex R3 회귀: bare Start(디스패치 안 됨)는 flag 를 set 하지 않아, resume
    에서 게이트가 정상 발동한다(over-fire 차단의 반대 검증)."""
    context = _ctx(tmp_path)
    first = _collect(run_query(
        client=_BareTerminalStartThenMaxTokens(), registry=_registry(), context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검")])],
        config=QueryConfig(max_turns=3),
    ))
    assert [e.reason for e in first if isinstance(e, LoopCompleted)] == ["max_tokens"]
    # 디스패치 안 됐으므로 플래그 미set.
    assert context.metadata.get("terminal_tool_invoked") is not True

    # resume + 텍스트-only 반복 → 게이트 정상 발동 → 캡 도달 contract_violation.
    second = _collect(run_query(
        client=ScriptedLLMClient(turns=[
            ScriptedTurn(text="끝."), ScriptedTurn(text="끝."), ScriptedTurn(text="끝."),
        ]),
        registry=_registry(), context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="resume")])],
        config=QueryConfig(max_turns=6),
    ))
    assert context.metadata["terminal_tool_reminder_count"] == 2
    done = [ev for ev in second if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "contract_violation"


def test_harness_passes_unlocked_tools_to_run_query(tmp_path):
    """codex R2: GuardedHarness 가 사전 unlock(_unlock_all 등)을 run_query 에
    전달 — 미전달 시 run_query 가 unlocked 를 빈 set 으로 덮어써 deferred 종료
    도구가 광고되지 않고 게이트가 무력화된다."""
    from secu_agent.agent.harness.runner import GuardedHarness
    from secu_agent.agent.llm.types import StreamMessageStop

    advertised: dict = {}

    class _RecordingClient(LLMClient):
        @property
        def name(self) -> str:
            return "recording"

        async def stream(self, request: LLMRequest) -> AsyncIterator[StreamEvent]:
            advertised["names"] = {t.name for t in (request.tools or [])}
            yield StreamMessageStop(stop_reason="end_turn")

    registry = ToolRegistry()
    registry.register(_DeferredSetDoneTool)  # deferred → unlock 돼야 광고됨
    harness = GuardedHarness(
        client=_RecordingClient(), registry=registry, evidence_dir=tmp_path,
    )
    harness.context.unlocked_tools.add("set_done_deferred")

    async def _go():
        return [ev async for ev in harness.run(
            initial_messages=[UserMessage(content=[TextBlock(text="go")])],
        )]

    asyncio.run(_go())

    # 사전 unlock 된 deferred 도구가 모델에 광고됐다(run_query 가 wipe 안 함).
    assert "set_done_deferred" in advertised.get("names", set())
