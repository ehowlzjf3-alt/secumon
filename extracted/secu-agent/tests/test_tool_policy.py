"""C2-a: 도메인 등록형 도구 정책(ToolPolicy) 단위 + invoke_tool 통합 테스트.

- 등록/해제/중복거부(register_task_contract 와 동형).
- evaluate: 미등록 no-op, 차단 사유 [name] 접두어, applies_to 필터, fail-closed,
  빈 문자열도 차단(S1), read-only metadata(S2).
- invoke_tool 초크포인트: 차단 정책이면 실행 전에 kind='policy' 로 막고, 통과 정책이면
  실제 실행됨. 정책은 승인/리다케이션 뒤 **최종 입력**을 본다(S5).
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import ClassVar

import pytest
from pydantic import BaseModel

from secu_agent.agent.tool_policy import (
    ToolPolicy,
    evaluate_tool_policies,
    register_tool_policy,
    registered_tool_policies,
    unregister_tool_policy,
)
from secu_agent.agent.tools.base import (
    PermissionDecision,
    Tool,
    ToolContext,
    ToolError,
    ToolInvocation,
    ToolSuccess,
)
from secu_agent.agent.tools.invoker import invoke_tool
from secu_agent.agent.tools.registry import ToolRegistry


@pytest.fixture(autouse=True)
def _clean_policies():
    """각 테스트마다 전역 정책 레지스트리를 비운다(상태 오염 방지)."""
    for name in list(registered_tool_policies()):
        unregister_tool_policy(name)
    yield
    for name in list(registered_tool_policies()):
        unregister_tool_policy(name)


# ── 단위: 등록/평가 ────────────────────────────────────────────────────────

def _allow(*_a, **_k):
    return None


def test_register_and_registered_roundtrip():
    register_tool_policy(ToolPolicy(name="p1", check=_allow))
    assert "p1" in registered_tool_policies()
    unregister_tool_policy("p1")
    assert "p1" not in registered_tool_policies()


def test_duplicate_registration_is_explicit_error():
    register_tool_policy(ToolPolicy(name="dup", check=_allow))
    with pytest.raises(ValueError, match="already registered"):
        register_tool_policy(ToolPolicy(name="dup", check=_allow))


def test_evaluate_no_policies_is_noop():
    assert evaluate_tool_policies("any_tool", object(), {}, is_read_only=True) is None


def test_evaluate_block_reason_has_name_prefix():
    register_tool_policy(ToolPolicy(
        name="scope_guard",
        check=lambda *_a, **_k: "charter_ref out of scope",
    ))
    reason = evaluate_tool_policies("web_fetch", object(), {}, is_read_only=True)
    assert reason == "[scope_guard] charter_ref out of scope"


def test_empty_string_reason_still_blocks():
    """S1: str 반환은 빈 문자열이어도 차단(fail-closed) — 기본 사유로 대체."""
    register_tool_policy(ToolPolicy(name="empty", check=lambda *_a, **_k: ""))
    reason = evaluate_tool_policies("t", object(), {}, is_read_only=True)
    assert reason is not None
    assert reason.startswith("[empty]")
    assert "blocked by tool policy" in reason


def test_applies_to_filters_untargeted_tools():
    register_tool_policy(ToolPolicy(
        name="only_web",
        check=lambda *_a, **_k: "blocked",
        applies_to=frozenset({"web_fetch"}),
    ))
    assert evaluate_tool_policies("web_fetch", object(), {}, is_read_only=True) is not None
    # 비대상 도구 → 이 정책은 검사조차 안 함(None).
    assert evaluate_tool_policies("host_read", object(), {}, is_read_only=True) is None


def test_predicate_exception_fails_closed():
    def _boom(*_a, **_k):
        raise RuntimeError("policy bug")

    register_tool_policy(ToolPolicy(name="buggy", check=_boom))
    reason = evaluate_tool_policies("x", object(), {}, is_read_only=True)
    assert reason is not None
    assert "buggy" in reason
    assert "fail-closed" in reason


def test_first_registered_block_wins():
    register_tool_policy(ToolPolicy(name="a", check=lambda *_a, **_k: "reason-a"))
    register_tool_policy(ToolPolicy(name="b", check=lambda *_a, **_k: "reason-b"))
    reason = evaluate_tool_policies("t", object(), {}, is_read_only=True)
    assert reason == "[a] reason-a"


def test_check_receives_tool_name_input_metadata_and_ro_flag():
    seen = {}

    def _capture(tool_name, validated_input, metadata, is_read_only):
        seen.update(
            name=tool_name, inp=validated_input,
            charter=metadata.get("charter_ref"), ro=is_read_only,
        )
        return None

    register_tool_policy(ToolPolicy(name="cap", check=_capture))
    inp = object()
    evaluate_tool_policies(
        "host_search", inp, {"charter_ref": "TICKET-1"}, is_read_only=False,
    )
    assert seen == {"name": "host_search", "inp": inp, "charter": "TICKET-1", "ro": False}


def test_metadata_is_read_only_cannot_weaken_core_gate():
    """S2: 정책이 인가 metadata 를 변조하려 하면 실패(fail-closed) + 실제 dict 불변."""
    real_meta = {"schedule_origin": "cron", "charter_ref": "T-9"}

    def _tamper(tool_name, validated_input, metadata, is_read_only):
        del metadata["schedule_origin"]  # read-only proxy → TypeError
        return None

    register_tool_policy(ToolPolicy(name="tamper", check=_tamper))
    reason = evaluate_tool_policies("x", object(), real_meta, is_read_only=True)
    assert reason is not None            # 변조 시도가 fail-closed 로 차단됨
    assert "tamper" in reason
    assert real_meta["schedule_origin"] == "cron"  # 원본 metadata 불변


def test_metadata_view_exposes_scalars_only_hides_live_and_nested():
    """T1/T3: 정책은 스칼라 인가 값만 보고, 라이브 객체·중첩 mutable 은 못 본다."""
    live_object = object()
    real_meta = {
        "charter_ref": "T-1",           # scalar → 보임
        "schedule_origin": "cron",      # scalar → 보임
        "_tool_guardrail_controller": live_object,  # 라이브 객체 → 숨김
        "finding_ids": [1, 2, 3],       # 중첩 mutable → 숨김
    }
    seen_keys = {}

    def _capture(tool_name, validated_input, metadata, is_read_only):
        seen_keys["keys"] = set(metadata.keys())
        return None

    register_tool_policy(ToolPolicy(name="peek", check=_capture))
    evaluate_tool_policies("x", object(), real_meta, is_read_only=True)
    assert seen_keys["keys"] == {"charter_ref", "schedule_origin"}


def test_each_policy_gets_fresh_input_copy_no_cross_contamination():
    """U4: 앞선 정책이 입력 사본을 변조해도 뒤 정책은 오염되지 않은 값을 본다."""
    class _Inp(BaseModel):
        value: str

    seen_by_b = {}

    def _a(tool_name, inp, meta, ro):
        inp.value = "MUTATED_BY_A"   # A 의 사본만 바뀜
        return None

    def _b(tool_name, inp, meta, ro):
        seen_by_b["value"] = inp.value
        return None

    register_tool_policy(ToolPolicy(name="a", check=_a))
    register_tool_policy(ToolPolicy(name="b", check=_b))
    evaluate_tool_policies("t", _Inp(value="pristine"), {}, is_read_only=True)
    assert seen_by_b["value"] == "pristine"   # B 는 원본 값을 본다


def test_evaluate_snapshot_is_iteration_safe_under_registration():
    """T4: 평가 중 정책이 새 정책을 등록해도 iteration 이 깨지지 않는다(스냅샷)."""
    def _register_more(tool_name, validated_input, metadata, is_read_only):
        # 평가 iteration 도중 레지스트리 변경 — 스냅샷이라 RuntimeError 없어야 함.
        register_tool_policy(ToolPolicy(name="added_midway", check=lambda *_a, **_k: None))
        return None

    register_tool_policy(ToolPolicy(name="mutator", check=_register_more))
    # dict changed size during iteration 이 나면 여기서 터진다.
    assert evaluate_tool_policies("x", object(), {}, is_read_only=True) is None


# ── 통합: invoke_tool 초크포인트 ───────────────────────────────────────────

class _EchoInput(BaseModel):
    value: str


class _EchoTool(Tool[_EchoInput]):
    name: ClassVar[str] = "echo_probe"
    description: ClassVar[str] = "Test-only read-only echo."
    input_model: ClassVar[type[BaseModel]] = _EchoInput
    is_read_only: ClassVar[bool] = True
    executed: ClassVar[bool] = False

    async def execute(self, validated_input: _EchoInput, context: ToolContext):
        del context
        type(self).executed = True
        return ToolSuccess(content=f"echo={validated_input.value}")


class _RewriteTool(Tool[_EchoInput]):
    """check_permission 이 승인 흐름에서 입력을 재작성 → next_input 이 validated 와 다름."""
    name: ClassVar[str] = "rewrite_probe"
    description: ClassVar[str] = "Test-only input-rewriting tool."
    input_model: ClassVar[type[BaseModel]] = _EchoInput
    is_read_only: ClassVar[bool] = True
    executed_value: ClassVar[str | None] = None

    async def check_permission(self, validated_input, context):
        del validated_input, context
        return PermissionDecision(behavior="allow", updated_input={"value": "REWRITTEN"})

    async def execute(self, validated_input: _EchoInput, context: ToolContext):
        del context
        type(self).executed_value = validated_input.value
        return ToolSuccess(content=f"echo={validated_input.value}")


def _registry(*tools) -> ToolRegistry:
    r = ToolRegistry()
    for t in (tools or (_EchoTool,)):
        r.register(t)
    return r


def _invoke(tmp_path: Path, name="echo_probe", value="hi", registry=None):
    return asyncio.run(invoke_tool(
        ToolInvocation(id="c1", name=name, input={"value": value}),
        registry or _registry(),
        ToolContext(evidence_dir=tmp_path),
    ))


def test_invoke_tool_blocked_by_policy_before_execute(tmp_path):
    _EchoTool.executed = False
    register_tool_policy(ToolPolicy(
        name="deny_echo",
        check=lambda *_a, **_k: "not allowed here",
        applies_to=frozenset({"echo_probe"}),
    ))
    result = _invoke(tmp_path)
    assert isinstance(result, ToolError)
    assert result.kind == "policy"
    assert "deny_echo" in result.message
    assert _EchoTool.executed is False  # 실행 전에 차단됨


def test_invoke_tool_allowing_policy_lets_execution_proceed(tmp_path):
    _EchoTool.executed = False
    register_tool_policy(ToolPolicy(name="permit", check=lambda *_a, **_k: None))
    result = _invoke(tmp_path)
    assert isinstance(result, ToolSuccess)
    assert "echo=hi" in result.content
    assert _EchoTool.executed is True


def test_invoke_tool_no_policies_unchanged(tmp_path):
    _EchoTool.executed = False
    result = _invoke(tmp_path)
    assert isinstance(result, ToolSuccess)
    assert _EchoTool.executed is True


def test_invoke_tool_policy_sees_validated_input(tmp_path):
    captured = {}

    def _check(tool_name, validated_input, metadata, is_read_only):
        captured["value"] = validated_input.value  # 검증된 pydantic 모델이어야 함
        captured["ro"] = is_read_only
        return None

    register_tool_policy(ToolPolicy(name="inspect", check=_check))
    _invoke(tmp_path)
    assert captured == {"value": "hi", "ro": True}


def test_invoke_tool_policy_input_mutation_does_not_affect_execution(tmp_path):
    """T2: 정책이 입력 사본을 바꿔도 실제 실행 입력은 불변(승인 후 변조로 게이트 우회 차단)."""
    _EchoTool.executed = False

    def _mutate(tool_name, validated_input, metadata, is_read_only):
        validated_input.value = "HACKED"  # 사본을 변조 시도
        return None

    register_tool_policy(ToolPolicy(name="mutate_input", check=_mutate))
    result = _invoke(tmp_path, value="hi")
    assert isinstance(result, ToolSuccess)
    assert "echo=hi" in result.content       # 원본 'hi' 로 실행됨(HACKED 아님)
    assert "HACKED" not in result.content


def test_invoke_tool_policy_sees_approval_rewritten_final_input(tmp_path):
    """S5: 정책은 승인 흐름이 재작성한 최종 입력(REWRITTEN)을 봐야 한다."""
    _RewriteTool.executed_value = None
    register_tool_policy(ToolPolicy(
        name="block_rewritten",
        check=lambda name, inp, meta, ro: (
            "blocked rewritten" if inp.value == "REWRITTEN" else None
        ),
    ))
    result = _invoke(
        tmp_path, name="rewrite_probe", value="original",
        registry=_registry(_RewriteTool),
    )
    # 정책이 원본 'original' 이 아니라 재작성된 'REWRITTEN' 을 보고 차단 → 실행 안 됨.
    assert isinstance(result, ToolError)
    assert result.kind == "policy"
    assert "block_rewritten" in result.message
    assert _RewriteTool.executed_value is None
