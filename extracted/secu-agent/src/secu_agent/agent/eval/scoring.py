"""Scoring — ScenarioResult vs ScenarioExpectations.

각 시나리오 한 줄 pass/fail + 실패 사유 인쇄. 결정적 — 같은 입력 같은 결과.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from secu_agent.agent.eval.runner import ScenarioResult
from secu_agent.agent.eval.scenario import ScenarioExpectations


@dataclass(slots=True)
class ScoreReport:
    scenario_name: str
    passed: bool
    failures: list[str] = field(default_factory=list)

    def format_summary(self) -> str:
        verdict = "PASS" if self.passed else "FAIL"
        if self.passed:
            return f"[{verdict}] {self.scenario_name}"
        details = "\n  - " + "\n  - ".join(self.failures) if self.failures else ""
        return f"[{verdict}] {self.scenario_name}{details}"


def score_scenario(result: ScenarioResult, exp: ScenarioExpectations) -> ScoreReport:
    failures: list[str] = []

    called_set = set(result.tools_called)
    for required in exp.tools_called:
        if required not in called_set:
            failures.append(f"tools_called missing: {required}")
    for forbidden in exp.tools_not_called:
        if forbidden in called_set:
            failures.append(f"tools_not_called violated: {forbidden}")

    for needle in exp.final_text_contains:
        if needle not in result.final_text:
            failures.append(f"final_text_contains missing: {needle!r}")
    for needle in exp.final_text_not_contains:
        if needle in result.final_text:
            failures.append(f"final_text_not_contains violated: {needle!r}")

    if exp.min_turns is not None and result.total_turns < exp.min_turns:
        failures.append(f"min_turns: got {result.total_turns}, need ≥ {exp.min_turns}")
    if exp.max_turns is not None and result.total_turns > exp.max_turns:
        failures.append(f"max_turns: got {result.total_turns}, need ≤ {exp.max_turns}")

    if result.loop_error:
        failures.append(f"loop_error: {result.loop_error}")

    return ScoreReport(
        scenario_name=result.scenario_name,
        passed=not failures,
        failures=failures,
    )
