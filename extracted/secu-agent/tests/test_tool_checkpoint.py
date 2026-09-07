"""v3.89 Slice1 — 우회불가 tool 실행 검문소.

invoker._execute 가 발급한 1회성 permit 없이는 tool.execute() 실행 불가. 플러그인이 다른 도구를
직접 `.execute()` 로 부르면 ToolCheckpointBypass. 합법 조합은 context.invoke_tool 로 재진입.

이 파일은 conftest 의 _tool_checkpoint_test_mode(강제 off)를 **로컬로 다시 켜서**(강제 on) 실제
차단을 단정한다. (프로젝트 관례대로 asyncio.run 사용 — pytest-asyncio 아님.)
"""
from __future__ import annotations

import asyncio
import tempfile
import uuid
from pathlib import Path

import pytest

from secu_agent.agent.harness.audit import AuditLog
from secu_agent.agent.tools import base
from secu_agent.agent.tools.base import (
    EmptyInput,
    Tool,
    ToolCheckpointBypass,
    ToolContext,
    ToolError,
    ToolInvocation,
    ToolSuccess,
)
from secu_agent.agent.tools.invoker import invoke_tool
from secu_agent.agent.tools.registry import ToolRegistry


class _LeafTool(Tool[EmptyInput]):
    name = "leaf"
    description = "leaf"
    input_model = EmptyInput

    async def execute(self, vi, ctx):
        return ToolSuccess("leaf-ok")


class _BypassComposer(Tool[EmptyInput]):
    """impl 안에서 서브도구를 **직접 .execute()** 로 호출 — 검문소 위반."""
    name = "bypass_composer"
    description = "bypass"
    input_model = EmptyInput

    async def execute(self, vi, ctx):
        leaf = _LeafTool()
        return await leaf.execute(EmptyInput(), ctx)  # ← 우회(직접호출)


class _GoodComposer(Tool[EmptyInput]):
    """impl 안에서 context.invoke_tool 로 서브도구 호출 — 검문소 재진입(합법)."""
    name = "good_composer"
    description = "good"
    input_model = EmptyInput

    async def execute(self, vi, ctx):
        res = await ctx.invoke_tool("leaf", {})
        assert isinstance(res, ToolSuccess) and res.content == "leaf-ok"
        return ToolSuccess("composed:" + res.content)


class _SuperParent(Tool[EmptyInput]):
    name = "super_parent"
    description = "parent"
    input_model = EmptyInput

    async def execute(self, vi, ctx):
        return ToolSuccess("parent")


class _SuperChild(_SuperParent):
    """협조적 상속 — impl 이 같은 인스턴스의 super().execute() 호출(검문소가 허용해야)."""
    name = "super_child"
    description = "child"

    async def execute(self, vi, ctx):
        parent = await super().execute(vi, ctx)  # ← 같은 self 의 super() 체인
        assert isinstance(parent, ToolSuccess)
        return ToolSuccess("child+" + parent.content)


class _RecurTool(Tool[EmptyInput]):
    """자기 자신을 ctx.invoke_tool 로 무한 재진입 — 깊이 상한 backstop 검증."""
    name = "recur"
    description = "recur"
    input_model = EmptyInput

    async def execute(self, vi, ctx):
        return await ctx.invoke_tool("recur", {})


class _BorrowSelfComposer(Tool[EmptyInput]):
    """현 self 를 남(_LeafTool) wrapper 에 borrow — owner ∉ type(self).__mro__ → 차단해야."""
    name = "borrow_self"
    description = "borrow"
    input_model = EmptyInput

    async def execute(self, vi, ctx):
        return await _LeafTool.execute(self, EmptyInput(), ctx)  # ← borrowed-self 우회 시도


class _SelfReplayTool(Tool[EmptyInput]):
    """같은 self·같은 MRO 레벨 재호출 — 이미 소비 → 차단해야(입력 escalation 우회 봉쇄)."""
    name = "self_replay"
    description = "replay"
    input_model = EmptyInput

    async def execute(self, vi, ctx):
        return await self.execute(vi, ctx)  # ← self.execute 재호출


@pytest.fixture()
def _enforced():
    prev = base.set_checkpoint_enforced(True)  # conftest 가 off 로 둔 것을 로컬 on
    yield
    base.set_checkpoint_enforced(prev)


def _ctx(registry=None) -> ToolContext:
    d = Path(tempfile.mkdtemp())
    return ToolContext(
        evidence_dir=d, audit_log=AuditLog(d / "a.jsonl"), registry=registry,
    )


def _reg() -> ToolRegistry:
    r = ToolRegistry()
    for c in (_LeafTool, _BypassComposer, _GoodComposer, _SuperParent, _SuperChild, _RecurTool,
              _BorrowSelfComposer, _SelfReplayTool):
        r.register(c)
    return r


def _run(name: str, ctx: ToolContext) -> object:
    return asyncio.run(
        invoke_tool(ToolInvocation(id=uuid.uuid4().hex, name=name, input={}), ctx.registry, ctx))


def test_invoke_tool_path_issues_permit(_enforced):
    # 정상 경로: invoker 가 permit 발급 → leaf.execute 통과.
    res = _run("leaf", _ctx(_reg()))
    assert isinstance(res, ToolSuccess) and res.content == "leaf-ok"


def test_direct_execute_cold_raises_when_enforced(_enforced):
    # invoker 밖 cold 직접호출 → permit 없어 ToolCheckpointBypass.
    leaf = _LeafTool()
    with pytest.raises(ToolCheckpointBypass):
        asyncio.run(leaf.execute(EmptyInput(), _ctx()))


def test_nested_direct_execute_bypass_blocked(_enforced):
    # 도구 impl 안에서 다른 도구를 직접 .execute() → self 불일치로 차단(→ ToolError forbidden).
    res = _run("bypass_composer", _ctx(_reg()))
    assert isinstance(res, ToolError) and res.kind == "forbidden"
    assert "outside invoke_tool" in res.message


def test_nested_via_context_invoke_tool_ok(_enforced):
    # context.invoke_tool 로 재진입한 서브도구는 새 permit 을 받아 통과.
    res = _run("good_composer", _ctx(_reg()))
    assert isinstance(res, ToolSuccess) and res.content == "composed:leaf-ok"


def test_cold_execute_allowed_when_not_enforced():
    # conftest 기본(강제 off)에서는 cold 직접호출이 허용(41 테스트파일 호환).
    assert base._checkpoint_enforced is False  # conftest autouse
    res = asyncio.run(_LeafTool().execute(EmptyInput(), _ctx()))
    assert isinstance(res, ToolSuccess)


def test_super_execute_cooperative_chain_allowed(_enforced):
    # ★ codex 회귀: 같은 인스턴스의 super().execute() 협조 체인은 permit 미소비라 통과해야.
    res = _run("super_child", _ctx(_reg()))
    assert isinstance(res, ToolSuccess) and res.content == "child+parent"


def test_invoke_tool_depth_limit(_enforced):
    # 무한 재진입 → 깊이 상한에서 forbidden (canonical invoke_tool 이 계수).
    res = _run("recur", _ctx(_reg()))
    assert isinstance(res, ToolError) and res.kind == "forbidden"
    assert "depth" in res.message


def test_borrowed_self_cross_tool_blocked(_enforced):
    # ★ codex v2: OtherTool.execute(self,...) 로 현 self 를 남 wrapper 에 borrow → owner ∉ MRO → 차단.
    res = _run("borrow_self", _ctx(_reg()))
    assert isinstance(res, ToolError) and res.kind == "forbidden"
    assert "outside invoke_tool" in res.message


def test_self_replay_same_level_blocked(_enforced):
    # ★ codex v2: 같은 self·같은 MRO 레벨 재호출은 이미 소비 → 차단(입력 escalation 우회 봉쇄).
    res = _run("self_replay", _ctx(_reg()))
    assert isinstance(res, ToolError) and res.kind == "forbidden"


def test_registry_rejects_non_tool_duck_class():
    # Tool 서브클래스 아닌 duck class → 등록 거부(검문소 우회 방지, codex).
    class _NotATool:  # noqa: N801
        name = "fake_duck"
        description = "duck"

        async def execute(self, vi, ctx):
            return ToolSuccess("duck")

    with pytest.raises(ValueError, match="subclass Tool"):
        ToolRegistry().register(_NotATool)  # type: ignore[arg-type]


def test_runtime_type_mismatch_blocked(_enforced):
    # ★ codex v3: custom __new__ 이 다른 타입 반환 → 게이트는 등록클래스, 실행은 다른 타입 raw execute
    # 될 수 있어 fail-closed.
    class _ProxyReturner(Tool[EmptyInput]):
        name = "proxy_ret"
        description = "proxy"
        input_model = EmptyInput

        def __new__(cls):
            return _LeafTool()  # 다른 타입 인스턴스 반환

        async def execute(self, vi, ctx):
            return ToolSuccess("never")

    reg = ToolRegistry()
    reg.register(_LeafTool)
    reg.register(_ProxyReturner)
    res = _run("proxy_ret", _ctx(reg))
    assert isinstance(res, ToolError) and res.kind == "forbidden"
    assert "type mismatch" in res.message


def test_wrapper_transplant_to_unrelated_class_blocked(_enforced):
    # ★ codex v4: 남 도구의 guarded wrapper 를 무관 클래스에 이식(alias `execute=Other.execute` /
    # @dataclass(slots=True) 재생성)하면, 그 도구의 raw impl 이 새 클래스의 입력·정책 아래 실행될 위험.
    # captured-owner(cls ∈ type(self).__mro__)로 fail-closed 차단. (@dataclass-on-Tool 은 미지원 — 평범한 상속 사용.)
    reg = ToolRegistry()
    reg.register(_LeafTool)
    Copied = type("CopiedLeaf", (Tool,), {
        "name": "copied_leaf", "description": "c", "input_model": EmptyInput,
        "execute": _LeafTool.__dict__["execute"],  # _LeafTool 의 wrapper 이식(cls=_LeafTool)
    })
    reg.register(Copied)  # 등록은 통과(effective 는 guarded)
    res = _run("copied_leaf", _ctx(reg))  # 실행 시 cls=_LeafTool ∉ Copied MRO → 차단
    assert isinstance(res, ToolError) and res.kind == "forbidden"


def test_alias_execute_transplant_blocked(_enforced):
    # alias `execute = OtherTool.execute` 를 클래스 body 에 두는 것도 동일하게 차단.
    class _AliasTool(Tool[EmptyInput]):
        name = "alias_tool"
        description = "alias"
        input_model = EmptyInput
        execute = _LeafTool.execute  # noqa: — _LeafTool wrapper alias(cls=_LeafTool)

    reg = ToolRegistry()
    reg.register(_LeafTool)
    reg.register(_AliasTool)
    res = _run("alias_tool", _ctx(reg))
    assert isinstance(res, ToolError) and res.kind == "forbidden"


def test_metaclass_equality_transplant_still_blocked(_enforced):
    # ★ codex v5: custom metaclass __eq__ 로 무관 클래스를 "같다"고 주장해도, owner 판정이 identity(is)
    # 라 우회 안 됨(구 `in`/`==` 였다면 통과했을 것).
    _ToolMeta = type(Tool)

    class _EvilMeta(_ToolMeta):  # Tool 메타클래스(ABCMeta 계열) 상속 — 메타 제약 충족
        def __eq__(cls, other):
            return True  # 모든 클래스가 같다고 주장

        __hash__ = _ToolMeta.__hash__

    _AliasEvil = _EvilMeta("AliasEvil", (Tool,), {
        "name": "alias_evil", "description": "e", "input_model": EmptyInput,
        "execute": _LeafTool.__dict__["execute"],  # _LeafTool wrapper alias(cls=_LeafTool)
    })
    reg = ToolRegistry()
    reg.register(_LeafTool)
    reg.register(_AliasEvil)
    res = _run("alias_evil", _ctx(reg))
    assert isinstance(res, ToolError) and res.kind == "forbidden"


def test_registry_rejects_raw_abstract_mixin():
    # ★ codex v4: @abstractmethod 는 body 를 가질 수 있고 super() 로 그 raw 본문에 진입 가능 →
    # root Tool.execute 하나만 예외, 다른 abstract raw mixin 은 등록 거부.
    from abc import ABC, abstractmethod

    class _RawAbstractMixin(ABC):
        @abstractmethod
        async def execute(self, vi, ctx):
            return ToolSuccess("raw-abstract-body")  # 추상이지만 실 본문

    class _LeafOverAbstract(_RawAbstractMixin, Tool[EmptyInput]):
        name = "leaf_over_abstract"
        description = "leaf"
        input_model = EmptyInput

        async def execute(self, vi, ctx):
            return await super().execute(vi, ctx)  # super() → raw abstract body

    with pytest.raises(ValueError, match="raw mixin"):
        ToolRegistry().register(_LeafOverAbstract)


def test_registry_rejects_raw_mixin_under_guarded_leaf():
    # ★ codex v3 Q7d: guarded leaf 아래 raw mixin 이 있으면 super() 가 그리로 진입(permit 없이) → 등록 거부.
    class _RawMixin:  # Tool 아님 — raw execute
        async def execute(self, vi, ctx):
            return ToolSuccess("raw")

    class _LeafOverMixin(_RawMixin, Tool[EmptyInput]):
        name = "leaf_over_mixin"
        description = "leaf"
        input_model = EmptyInput

        async def execute(self, vi, ctx):  # 자기 execute(guarded) 정의 → effective 는 guarded
            return await super().execute(vi, ctx)  # 그러나 super() → _RawMixin.execute(raw)

    with pytest.raises(ValueError, match="raw mixin"):
        ToolRegistry().register(_LeafOverMixin)


def test_registry_rejects_unguarded_mixin_execute():
    # 비-Tool mixin 에서 execute 상속(자기 클래스 미정의 → 미래핑) → 등록 거부.
    class _ExecMixin:  # Tool 아님 — execute 만 제공
        async def execute(self, vi, ctx):
            return ToolSuccess("mixin")

    class _MixTool(_ExecMixin, Tool[EmptyInput]):
        name = "mix_tool"
        description = "mix"
        input_model = EmptyInput
        # execute 를 자기 클래스에 정의 안 함 → _ExecMixin.execute(미보호) 상속

    with pytest.raises(ValueError, match="checkpoint wrapper"):
        ToolRegistry().register(_MixTool)
