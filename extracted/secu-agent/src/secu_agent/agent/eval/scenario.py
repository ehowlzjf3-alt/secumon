"""Scenario YAML 스키마 + 로더.

시나리오 = LLM scripted turns + 기대 동작. 별도 코드 변경 없이 시나리오
YAML 만 추가하면 새 회귀가 늘어남.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

from secu_agent.agent.eval.scripted_llm import ScriptedToolCall, ScriptedTurn


@dataclass(slots=True)
class ScenarioSeed:
    subnets: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ToolStub:
    """시나리오 안에서 도구 호출 시 반환할 결과를 박아두기.

    실제 도구는 네트워크/DB 닿으니까 eval 에선 stub 로 결정적 결과 박음.
    LLM 의 호출 시퀀스 회귀가 검증 대상이지 도구 내부 동작이 아니다.
    """
    name: str
    description: str = "scenario stub tool"
    success_message: str = "ok"
    is_error: bool = False
    error_kind: str = "validation"


@dataclass(slots=True)
class ScenarioExpectations:
    tools_called: list[str] = field(default_factory=list)
    tools_not_called: list[str] = field(default_factory=list)
    final_text_contains: list[str] = field(default_factory=list)
    final_text_not_contains: list[str] = field(default_factory=list)
    min_turns: int | None = None
    max_turns: int | None = None


@dataclass(slots=True)
class Scenario:
    name: str
    task_type: str
    user_input: str
    script: list[ScriptedTurn]
    expectations: ScenarioExpectations
    description: str = ""
    seed: ScenarioSeed | None = None
    tool_stubs: list[ToolStub] = field(default_factory=list)
    source_path: Path | None = None


def _parse_turn(raw: dict) -> ScriptedTurn:
    calls_raw = raw.get("tool_calls") or []
    tool_calls = [
        ScriptedToolCall(
            name=tc["name"],
            input=tc.get("input") or {},
            id=tc.get("id"),
        )
        for tc in calls_raw
    ]
    return ScriptedTurn(
        text=raw.get("text", "") or "",
        reasoning=raw.get("reasoning", "") or "",
        tool_calls=tool_calls,
    )


def _parse_expectations(raw: dict) -> ScenarioExpectations:
    return ScenarioExpectations(
        tools_called=list(raw.get("tools_called") or []),
        tools_not_called=list(raw.get("tools_not_called") or []),
        final_text_contains=list(raw.get("final_text_contains") or []),
        final_text_not_contains=list(raw.get("final_text_not_contains") or []),
        min_turns=raw.get("min_turns"),
        max_turns=raw.get("max_turns"),
    )


def _parse_seed(raw: dict | None) -> ScenarioSeed | None:
    if not raw:
        return None
    return ScenarioSeed(subnets=list(raw.get("subnets") or []))


def _parse_tool_stubs(raw: list | None) -> list[ToolStub]:
    if not raw:
        return []
    return [
        ToolStub(
            name=item["name"],
            description=item.get("description") or "scenario stub tool",
            success_message=item.get("success_message") or "ok",
            is_error=bool(item.get("is_error", False)),
            error_kind=item.get("error_kind") or "validation",
        )
        for item in raw
    ]


def load_scenario(path: Path) -> Scenario:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if "name" not in data:
        raise ValueError(f"{path}: missing required field 'name'")
    if "task_type" not in data:
        raise ValueError(f"{path}: missing required field 'task_type'")
    if "user_input" not in data:
        raise ValueError(f"{path}: missing required field 'user_input'")
    script_raw = data.get("script")
    if not script_raw or not isinstance(script_raw, list):
        raise ValueError(f"{path}: 'script' must be a non-empty list")

    return Scenario(
        name=str(data["name"]),
        task_type=str(data["task_type"]),
        user_input=str(data["user_input"]),
        description=str(data.get("description") or ""),
        script=[_parse_turn(t) for t in script_raw],
        expectations=_parse_expectations(data.get("expectations") or {}),
        seed=_parse_seed(data.get("seed")),
        tool_stubs=_parse_tool_stubs(data.get("tool_stubs")),
        source_path=path,
    )


def load_scenarios_dir(directory: Path) -> list[Scenario]:
    out: list[Scenario] = []
    for p in sorted(directory.iterdir()):
        if p.suffix.lower() in {".yaml", ".yml"} and p.is_file():
            out.append(load_scenario(p))
    return out
