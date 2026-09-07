"""v3.80 Slice0e: build_specs 도구 순서 — unlock 전후 prefix 안정성.

핵심 회귀 (prompt prefix-cache):
- 프로바이더 렌더 순서가 tools→system→messages 라서, deferred 도구 unlock 시
  tools 배열 **중간 삽입**이 일어나면 삽입 지점 이후 캐시가 전부 무효화된다.
- 보장해야 할 것: ① 비-deferred prefix 는 unlock 과 무관하게 byte-동일,
  ② unlocked deferred 는 꼬리에만 append, ③ 같은 unlocked 면 호출마다 결정론.
"""
from __future__ import annotations

import json
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.tools.base import (
    EmptyInput, Tool, ToolContext, ToolResult, ToolSuccess,
)
from secu_agent.agent.tools.registry import ToolRegistry


class _NoInput(BaseModel):
    pass


def _make_tool(tool_name: str, *, is_deferred: bool) -> type[Tool[_NoInput]]:
    class _T(Tool[_NoInput]):
        name: ClassVar[str] = tool_name
        description: ClassVar[str] = f"{tool_name} 더미."
        search_hint: ClassVar[str] = tool_name
        input_model: ClassVar[type[BaseModel]] = _NoInput
        deferred: ClassVar[bool] = is_deferred
        domain: ClassVar[str] = "core"

        async def execute(self, payload: _NoInput, context: ToolContext) -> ToolResult:
            del payload, context
            return ToolSuccess(content="ok")

    _T.__name__ = f"_Tool_{tool_name}"
    return _T


def _registry() -> ToolRegistry:
    """비-deferred 2개(alpha/zulu) 사이 알파벳 순서로 끼어드는 deferred(bravo) 구성.

    기존 전체-정렬 구현에서는 bravo unlock 시 [alpha, bravo, zulu] 로 중간 삽입
    → zulu 이후 캐시 무효. 새 구현은 [alpha, zulu, bravo] append 를 보장해야 한다.
    """
    r = ToolRegistry()
    r.register(_make_tool("alpha_search", is_deferred=False))
    r.register(_make_tool("zulu_scan", is_deferred=False))
    r.register(_make_tool("bravo_deep", is_deferred=True))
    r.register(_make_tool("delta_deep", is_deferred=True))
    return r


def _spec_json(registry: ToolRegistry, unlocked: set[str]) -> list[str]:
    """직렬화 byte 단위 비교 — 이름만이 아니라 spec 전체가 안정인지."""
    return [
        json.dumps(
            {"name": s.name, "description": s.description, "input_schema": s.input_schema},
            sort_keys=True, ensure_ascii=False,
        )
        for s in registry.build_specs(unlocked)
    ]


def test_non_deferred_prefix_unchanged_across_unlock():
    r = _registry()
    before = _spec_json(r, set())
    after = _spec_json(r, {"bravo_deep"})
    # ① 기존 prefix 는 byte-동일 — 중간 삽입이면 여기서 깨진다.
    assert after[: len(before)] == before
    # ② unlock 된 deferred 는 꼬리에만 추가.
    assert [json.loads(s)["name"] for s in after] == [
        "alpha_search", "zulu_scan", "bravo_deep",
    ]


def test_second_unlock_keeps_prior_prefix():
    r = _registry()
    one = _spec_json(r, {"delta_deep"})
    two = _spec_json(r, {"delta_deep", "bravo_deep"})
    # 비-deferred prefix 는 항상 동일. (deferred 꼬리 내부 재정렬은 허용 —
    # unlock 이벤트 자체가 캐시 경계라 꼬리 순서까지는 보장 대상 아님.)
    base = _spec_json(r, set())
    assert one[: len(base)] == base
    assert two[: len(base)] == base
    assert [json.loads(s)["name"] for s in two] == [
        "alpha_search", "zulu_scan", "bravo_deep", "delta_deep",
    ]


def test_same_unlocked_is_deterministic_across_calls():
    r = _registry()
    unlocked = {"bravo_deep"}
    assert _spec_json(r, unlocked) == _spec_json(r, unlocked) == _spec_json(r, set(unlocked))


def test_locked_deferred_stays_hidden():
    r = _registry()
    names = [s.name for s in r.build_specs(set())]
    assert names == ["alpha_search", "zulu_scan"]
    assert "bravo_deep" not in names and "delta_deep" not in names
