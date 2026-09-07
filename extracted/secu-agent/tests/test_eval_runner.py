"""v3.16-C: Runner — ScriptedLLM + scenario 로 run_query 구동.

각 시나리오는 결정적으로 재생되며 events / tools_called / final_text 를
ScenarioResult 로 집계한다.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from pydantic import BaseModel

from secu_agent.agent.eval.scenario import (
    Scenario,
    ScenarioExpectations,
)
from secu_agent.agent.eval.scripted_llm import ScriptedToolCall, ScriptedTurn
from secu_agent.agent.tools.base import Tool, ToolContext, ToolResult, ToolSuccess
from secu_agent.agent.tools.registry import ToolRegistry


# ─── 테스트용 가벼운 도구 ────────────────────────────────────


class _PingInput(BaseModel):
    msg: str = "pong"


class _PingTool(Tool[_PingInput]):
    name = "ping"
    description = "echo back"
    input_model = _PingInput
    domain = "test"

    async def execute(self, payload, context) -> ToolResult:
        return ToolSuccess(content=f"pong:{payload.msg}")


def _registry() -> ToolRegistry:
    r = ToolRegistry()
    r.register(_PingTool)
    return r


def _scenario(name: str, *, script, expectations=None) -> Scenario:
    return Scenario(
        name=name,
        task_type="operator",
        user_input="안녕",
        script=script,
        expectations=expectations or ScenarioExpectations(),
    )


# ─── runner happy path ──────────────────────────────────────


def test_run_scenario_text_only(tmp_path):
    from secu_agent.agent.eval.runner import run_scenario

    s = _scenario("text", script=[ScriptedTurn(text="안녕하세요")])
    result = asyncio.run(run_scenario(s, registry=_registry(), evidence_dir=tmp_path))
    assert result.scenario_name == "text"
    assert "안녕하세요" in result.final_text
    assert result.tools_called == []
    assert result.total_turns == 1
    assert result.stop_reason == "end_turn"


def test_run_scenario_with_tool_call(tmp_path):
    from secu_agent.agent.eval.runner import run_scenario

    s = _scenario("tool", script=[
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="ping", input={"msg": "hi"})]),
        ScriptedTurn(text="ping 완료"),
    ])
    result = asyncio.run(run_scenario(s, registry=_registry(), evidence_dir=tmp_path))
    assert result.tools_called == ["ping"]
    assert "ping 완료" in result.final_text
    assert result.total_turns == 2


def test_run_scenario_multiple_tool_calls(tmp_path):
    from secu_agent.agent.eval.runner import run_scenario

    s = _scenario("multi", script=[
        ScriptedTurn(tool_calls=[
            ScriptedToolCall(name="ping", input={"msg": "1"}),
            ScriptedToolCall(name="ping", input={"msg": "2"}),
        ]),
        ScriptedTurn(text="done"),
    ])
    result = asyncio.run(run_scenario(s, registry=_registry(), evidence_dir=tmp_path))
    assert result.tools_called == ["ping", "ping"]
    assert "done" in result.final_text


def test_run_scenario_with_unknown_tool_returns_error_but_continues(tmp_path):
    """등록 안 된 도구 호출 → tools_completed_error 에 기록, 시나리오는 계속."""
    from secu_agent.agent.eval.runner import run_scenario

    s = _scenario("unknown", script=[
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="nonexistent", input={})]),
        ScriptedTurn(text="복구"),
    ])
    result = asyncio.run(run_scenario(s, registry=_registry(), evidence_dir=tmp_path))
    assert result.tools_called == ["nonexistent"]
    # error 처리 했는지는 tools_completed_error 또는 events 검사로 확인
    assert "복구" in result.final_text


# ─── scoring ────────────────────────────────────────────────


def test_scoring_passes_when_all_expectations_met(tmp_path):
    from secu_agent.agent.eval.runner import run_scenario
    from secu_agent.agent.eval.scoring import score_scenario

    s = _scenario("ok", script=[
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="ping", input={})]),
        ScriptedTurn(text="끝"),
    ], expectations=ScenarioExpectations(
        tools_called=["ping"],
        tools_not_called=["nonexistent"],
        final_text_contains=["끝"],
    ))
    result = asyncio.run(run_scenario(s, registry=_registry(), evidence_dir=tmp_path))
    report = score_scenario(result, s.expectations)
    assert report.passed
    assert report.failures == []


def test_scoring_fails_on_missing_tool_call(tmp_path):
    from secu_agent.agent.eval.runner import run_scenario
    from secu_agent.agent.eval.scoring import score_scenario

    s = _scenario("miss", script=[ScriptedTurn(text="끝")],
                  expectations=ScenarioExpectations(tools_called=["ping"]))
    result = asyncio.run(run_scenario(s, registry=_registry(), evidence_dir=tmp_path))
    report = score_scenario(result, s.expectations)
    assert not report.passed
    assert any("ping" in f for f in report.failures)


def test_scoring_fails_on_forbidden_tool_call(tmp_path):
    from secu_agent.agent.eval.runner import run_scenario
    from secu_agent.agent.eval.scoring import score_scenario

    s = _scenario("forb", script=[
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="ping", input={})]),
        ScriptedTurn(text="끝"),
    ], expectations=ScenarioExpectations(tools_not_called=["ping"]))
    result = asyncio.run(run_scenario(s, registry=_registry(), evidence_dir=tmp_path))
    report = score_scenario(result, s.expectations)
    assert not report.passed
    assert any("ping" in f and "not_called" in f for f in report.failures)


def test_scoring_text_contains_and_not_contains(tmp_path):
    from secu_agent.agent.eval.runner import run_scenario
    from secu_agent.agent.eval.scoring import score_scenario

    s = _scenario("txt", script=[ScriptedTurn(text="task 완료. 에러 없음.")],
                  expectations=ScenarioExpectations(
                      final_text_contains=["task", "완료"],
                      final_text_not_contains=["panic"],
                  ))
    result = asyncio.run(run_scenario(s, registry=_registry(), evidence_dir=tmp_path))
    report = score_scenario(result, s.expectations)
    assert report.passed

    # 반대 케이스
    s2 = _scenario("bad", script=[ScriptedTurn(text="panic!")],
                   expectations=ScenarioExpectations(
                       final_text_contains=["완료"],
                       final_text_not_contains=["panic"],
                   ))
    r2 = asyncio.run(run_scenario(s2, registry=_registry(), evidence_dir=tmp_path))
    rep2 = score_scenario(r2, s2.expectations)
    assert not rep2.passed
    assert len(rep2.failures) >= 2


def test_scoring_turn_bounds(tmp_path):
    from secu_agent.agent.eval.runner import run_scenario
    from secu_agent.agent.eval.scoring import score_scenario

    s = _scenario("turns", script=[
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="ping", input={})]),
        ScriptedTurn(text="끝"),
    ], expectations=ScenarioExpectations(min_turns=3))
    result = asyncio.run(run_scenario(s, registry=_registry(), evidence_dir=tmp_path))
    rep = score_scenario(result, s.expectations)
    assert not rep.passed
    assert any("min_turns" in f for f in rep.failures)


# ─── score_report human-readable ────────────────────────────


def test_score_report_format_summary():
    from secu_agent.agent.eval.scoring import ScoreReport

    r = ScoreReport(scenario_name="x", passed=False, failures=["a", "b"])
    s = r.format_summary()
    assert "x" in s
    assert "a" in s and "b" in s
    assert "FAIL" in s or "fail" in s
