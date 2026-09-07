"""엔진 candidate-ledger 침묵 게이트 — 후보 관찰 후 무해명 text-only 종료 차단."""
from __future__ import annotations

import asyncio
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.candidate_ledger import record_candidates_seen
from secu_agent.agent.engine import QueryConfig, run_query
from secu_agent.agent.events import LoopCompleted, LoopError, ToolCallCompleted
from secu_agent.agent.eval.scripted_llm import (
    ScriptedLLMClient,
    ScriptedToolCall,
    ScriptedTurn,
)
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.tools.base import Tool, ToolContext, ToolResult, ToolSuccess
from secu_agent.agent.tools.registry import ToolRegistry
from secu_agent.agent.tools.triage_candidates import TriageCandidatesTool


class _NoopInput(BaseModel):
    pass


class _NoopTool(Tool[_NoopInput]):
    name: ClassVar[str] = "noop"
    description: ClassVar[str] = "test noop tool"
    input_model: ClassVar[type[BaseModel]] = _NoopInput
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: _NoopInput, context: ToolContext) -> ToolResult:
        del validated_input, context
        return ToolSuccess(content="noop ok")


class _SetDoneTool(Tool[_NoopInput]):
    """set_status 류 terminal 도구 모사 — submit 없이 대상을 닫는다."""

    name: ClassVar[str] = "set_done"
    description: ClassVar[str] = "test terminal set-status tool"
    input_model: ClassVar[type[BaseModel]] = _NoopInput
    is_read_only: ClassVar[bool] = False

    async def execute(self, validated_input: _NoopInput, context: ToolContext) -> ToolResult:
        del validated_input, context
        return ToolSuccess(content="status set")


def _collect(aiter):
    async def _go():
        out = []
        async for ev in aiter:
            out.append(ev)
        return out
    return asyncio.run(_go())


def _registry(*, with_triage: bool = True) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(_NoopTool)
    if with_triage:
        registry.register(TriageCandidatesTool)
    return registry


def _silent_context(tmp_path, *, enforce: bool = True, seen: int = 22) -> ToolContext:
    metadata: dict = {}
    if enforce:
        metadata["candidate_ledger_enforce"] = True
    record_candidates_seen(
        metadata, source_tool="scan_text", count=seen,
        samples=("secret/password@page1",),
    )
    return ToolContext(evidence_dir=tmp_path, metadata=metadata)


def test_silence_gets_reminder_then_triage_completes(tmp_path):
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(text="특이사항 없습니다."),  # 침묵 시도 → 리마인더
        ScriptedTurn(tool_calls=[ScriptedToolCall(
            name="triage_candidates",
            input={"dispositions": [{
                "location": "https://conf.example/page1",
                "reason": "로그인 요구 — 인증 없이 데이터 미노출",
            }]},
            id="triage-1",
        )]),
        ScriptedTurn(text="후보 재확인 후 기각 기록 완료."),
    ])
    # seen=1 → triage 1건으로 완전 해명(seen>accounted 해소) → 종료.
    context = _silent_context(tmp_path, seen=1)

    events = _collect(run_query(
        client=client,
        registry=_registry(),
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검 진행")])],
        config=QueryConfig(max_turns=5),
    ))

    assert context.metadata["candidate_ledger_reminder_count"] == 1
    assert any(
        isinstance(ev, ToolCallCompleted) and ev.name == "triage_candidates"
        for ev in events
    )
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "end_turn"


def test_any_prior_accounting_disables_gate(tmp_path):
    # total-silence 설계(codex 2R): 이전 accounting 1건이 있으면 게이트 off —
    # 문서화된 narrow under-block 절충(over-block/재점검 루프 대신 택함).
    from secu_agent.agent.candidate_ledger import record_candidates_accounted

    client = ScriptedLLMClient(turns=[ScriptedTurn(text="요약만 남기고 종료.")])
    context = _silent_context(tmp_path, seen=22)
    record_candidates_accounted(context.metadata, bucket="submitted", count=1)

    events = _collect(run_query(
        client=client,
        registry=_registry(),
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검")])],
        config=QueryConfig(max_turns=3),
    ))

    assert "candidate_ledger_reminder_count" not in context.metadata
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "end_turn"


def test_stubborn_silence_escalates_to_contract_violation(tmp_path):
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(text="이상 없음."),
        ScriptedTurn(text="정말 이상 없음."),
        ScriptedTurn(text="아무것도 없음."),
    ])
    context = _silent_context(tmp_path)

    events = _collect(run_query(
        client=client,
        registry=_registry(),
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검 진행")])],
        config=QueryConfig(max_turns=5),
    ))

    assert context.metadata["candidate_ledger_reminder_count"] == 2
    errors = [ev for ev in events if isinstance(ev, LoopError)]
    assert any("candidate ledger" in ev.message for ev in errors)
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "contract_violation"


def test_gate_inert_without_enforce_flag(tmp_path):
    # chat/operator 경로 — enforce 미설정이면 기존과 byte-for-byte.
    client = ScriptedLLMClient(turns=[ScriptedTurn(text="요약입니다.")])
    context = _silent_context(tmp_path, enforce=False)

    events = _collect(run_query(
        client=client,
        registry=_registry(),
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="질문")])],
        config=QueryConfig(max_turns=3),
    ))

    assert "candidate_ledger_reminder_count" not in context.metadata
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "end_turn"


def test_terminal_set_status_bypass_is_blocked_then_triage_completes(tmp_path):
    # set_status 류 terminal 로 침묵 종료 시도 → 게이트가 완료를 한 턴 미루고
    # 리마인더 → triage 후 종료 허용.
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="set_done", input={}, id="d1")]),
        ScriptedTurn(tool_calls=[ScriptedToolCall(
            name="triage_candidates",
            input={"dispositions": [{
                "location": "https://conf.example/page1",
                "reason": "로그인 요구 — 인증 없이 데이터 미노출",
            }]},
            id="t1",
        )]),
        ScriptedTurn(text="기각 기록 후 종료."),
    ])
    # seen=1 → triage 1건으로 완전 해명 → terminal 종료 허용.
    context = _silent_context(tmp_path, seen=1)
    context.metadata["terminal_tools"] = {"set_done"}
    registry = _registry()
    registry.register(_SetDoneTool)

    events = _collect(run_query(
        client=client,
        registry=registry,
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검 진행")])],
        config=QueryConfig(max_turns=5),
    ))

    assert context.metadata["candidate_ledger_reminder_count"] == 1
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "end_turn"


def test_terminal_path_cap_allows_completion_with_debt_surfaced(tmp_path):
    # terminal 은 실제 작업이 이미 성공한 경로 — 캡 도달 후엔 완료를 허용하고
    # 침묵 부채는 worker_result 의 candidates 지표로 부모가 판정한다.
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="set_done", input={}, id="d1")]),
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="set_done", input={}, id="d2")]),
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="set_done", input={}, id="d3")]),
    ])
    context = _silent_context(tmp_path)
    context.metadata["terminal_tools"] = {"set_done"}
    registry = _registry()
    registry.register(_SetDoneTool)

    events = _collect(run_query(
        client=client,
        registry=registry,
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검 진행")])],
        config=QueryConfig(max_turns=5),
    ))

    assert context.metadata["candidate_ledger_reminder_count"] == 2
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "end_turn"


def test_gate_inert_when_triage_tool_not_exposed(tmp_path):
    # skill lockstep 전 도메인 toolset — 이행 불가능한 요구를 하지 않는다.
    client = ScriptedLLMClient(turns=[ScriptedTurn(text="요약입니다.")])
    context = _silent_context(tmp_path)

    events = _collect(run_query(
        client=client,
        registry=_registry(with_triage=False),
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="점검")])],
        config=QueryConfig(max_turns=3),
    ))

    assert "candidate_ledger_reminder_count" not in context.metadata
    done = [ev for ev in events if isinstance(ev, LoopCompleted)]
    assert done and done[-1].reason == "end_turn"
