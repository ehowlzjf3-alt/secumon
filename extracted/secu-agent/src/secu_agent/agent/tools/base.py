"""Tool base — pydantic Input model + ClassVar metadata.

각 tool 은 BaseModel subclass `input_model` 을 ClassVar 로 지정,
base 가 검증 + JSON schema 생성. execute 는 검증된 Pydantic 인스턴스를 받음.
"""
from __future__ import annotations

import asyncio
import contextvars
import functools
import os
import re
import time
import uuid
import weakref
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, Literal

from pydantic import BaseModel

if TYPE_CHECKING:
    from secu_agent.agent.harness.audit import AuditLog
    from secu_agent.agent.llm.base import LLMClient
    from secu_agent.agent.tools.approval import ApprovalResolver
    from secu_agent.agent.tools.registry import ToolRegistry


class EmptyInput(BaseModel):
    pass


@dataclass(frozen=True, slots=True)
class ToolImage:
    """F4-C: tool 결과가 모델에 되먹일 이미지(비전 브라우징 스크린샷 등). 엔진이 이를
    ImageBlock 으로 변환해 tool-result 직후 user 메시지로 주입한다(두 클라이언트가 이미
    ImageBlock 을 vision 입력으로 직렬화). in-memory 턴 한정 — 영속 안 됨(F3 결).
    media_type: image/png|jpeg|webp|gif. data_b64: base64(no data: prefix)."""
    media_type: str
    data_b64: str


@dataclass(frozen=True, slots=True)
class ToolSuccess:
    content: str
    type: Literal["success"] = "success"
    # F4-C: 선택적 이미지 첨부(비전 되먹임). **type 뒤**에 둬 기존 positional
    # ToolSuccess("ok", "success") 호출을 깨지 않는다. 기본 없음 → 기존 동작 무변.
    images: tuple[ToolImage, ...] = ()


ToolErrorKind = Literal[
    "validation",
    "permission",
    "not_found",
    "not_file",
    "io_error",
    "binary",
    "too_large",
    "execution",
    "timeout",
    "cancelled",
    "path_escape",
    "budget",
    "forbidden",
]


@dataclass(frozen=True, slots=True)
class ToolError:
    kind: ToolErrorKind | str
    message: str
    type: Literal["error"] = "error"


ToolResult = ToolSuccess | ToolError


PermissionBehavior = Literal["allow", "deny", "ask"]


@dataclass(frozen=True, slots=True)
class PermissionDecision:
    behavior: PermissionBehavior
    reason: str = ""
    updated_input: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class ToolInvocation:
    id: str
    name: str
    input: dict[str, object]


@dataclass(slots=True)
class ToolContext:
    """매 invocation에 주입되는 실행 컨텍스트."""

    evidence_dir: Path
    audit_log: AuditLog | None = None
    signal: asyncio.Event = field(default_factory=asyncio.Event)
    registry: ToolRegistry | None = None
    unlocked_tools: set[str] = field(default_factory=set)
    llm_client: LLMClient | None = None
    approval_resolver: ApprovalResolver | None = None
    metadata: dict[str, object] = field(default_factory=dict)
    per_turn_counts: dict[str, int] = field(default_factory=dict)
    # ── 부모 하네스의 idle 감시와 도구를 잇는 두 줄 (#32) ──────────────────
    # 오래 블로킹하는 도구(위임 등)는 부모 하네스에 이벤트를 하나도 안 낸다. 그래서
    # `AgentActivityTracker` 가 "관측 가능한 진척 없음" 으로 읽고 런을 죽였다 —
    # 자식은 멀쩡히 일하고 있었다(실측: 리드 idle 300s < 위임 backstop 600s 라
    # 300초 넘는 위임은 **예외 없이** 리드 런을 죽인다).
    #
    # `progress` 는 도구가 **자식의 실제 진척을 확인했을 때만** 부르는 훅이다.
    # 무조건 heartbeat 이 아니다 — 확인 못 하면 부르지 않고, 그러면 idle 이 예전처럼
    # 발동한다(진짜 hang 은 그대로 잡힌다).
    # `idle_budget_sec` 은 `subagent_timeout_sec` docstring 이 "노출 안 돼 있다" 고
    # 적어 둔 그 값이다. 도구가 부모보다 **먼저** 포기해서, 런을 죽이는 대신 ToolError
    # 를 돌려줄 수 있게 한다. 0 = 미노출(예전 동작).
    progress: Callable[[str], None] | None = None
    idle_budget_sec: float = 0.0

    @property
    def aborted(self) -> bool:
        return self.signal.is_set()

    def report_progress(self, event: str) -> None:
        """부모 하네스에 진척을 보고한다(훅이 없으면 무동작). 예외는 삼킨다 —
        진척 보고가 도구를 실패시키면 안 된다."""
        hook = self.progress
        if hook is None:
            return
        try:
            hook(event)
        except Exception:  # noqa: BLE001 — 관측 경로가 실행 경로를 죽이지 않는다
            pass

    async def invoke_tool(
        self, tool_name: str, tool_input: dict[str, object],
    ) -> "ToolResult":
        """v3.89: 도구/플러그인이 **서브도구를 검문소 통과로** 호출한다(직접 `.execute()` 대체).
        core `invoke_tool` 를 재진입 → 새 1회성 permit 발급 + 권한/승인/정책 게이트 전부 재적용.
        registry 미설정(cold context)이면 ToolError. sub-agent 미상속·grant 는 이 context 계승."""
        from secu_agent.agent.tools.invoker import invoke_tool as _invoke
        if self.registry is None:
            return ToolError(
                kind="not_found",
                message="context.invoke_tool: registry unavailable (cold context)")
        # 깊이 계수는 canonical invoke_tool 에 있다(module 직접 호출 경로도 포함 — codex).
        inv = ToolInvocation(id=uuid.uuid4().hex, name=tool_name, input=dict(tool_input))
        return await _invoke(inv, self.registry, self)


# ── v3.89 Slice1: 우회불가 tool 실행 검문소 ────────────────────────────────
# invoker._execute 가 발급한 permit 없이는 어떤 tool.execute 도 실행 불가. permit 은
# (tool 인스턴스, context, 발급 task) 에 결박되고, 실행되는 wrapper 의 소유 클래스가 `type(self).
# __mro__` 안에 있고(=self 자신의 super() 협조 체인) 아직 그 MRO 레벨이 안 쓰였을 때만 통과한다.
# 각 MRO 레벨은 permit 당 1회. 따라서:
#  · 같은 self 의 `super().execute()` 체인 = 각 레벨 1회 통과(협조상속 정상, 스킬 11곳).
#  · 다른 인스턴스 `other.execute()` = permit.tool 불일치 → 차단.
#  · `OtherTool.execute(self,...)`(현 self 를 남 wrapper 에 borrow) = OtherTool ∉ type(self).__mro__ → 차단.
#  · 같은 self 의 self.execute() 재호출/같은 레벨 재진입 = 이미 소비 → 차단(입력 escalation 우회 봉쇄).
#  · detached create_task(copied context) = permit.task 불일치 → 차단.
# 합법 서브도구 조합은 `context.invoke_tool(name, input)` 로 core invoke_tool 재진입(새 permit).
# 위협모델(§7.1): 신뢰된 plugin 의 **우발** 우회 방지. 악성 in-process(__wrapped__ 직접호출·monkeypatch·
# 모듈 직접 import·hash spoof)는 원천 불가라 범위 밖.
class ToolCheckpointBypass(RuntimeError):
    """invoke_tool 밖에서 tool.execute() 직접 호출 — 구조적 금지."""


@dataclass(frozen=True, slots=True)
class _RunPermit:
    """permit — (tool 인스턴스, context, 발급 task) 결박 + MRO 레벨 1회소비 추적.
    frozen: 필드 재대입 금지(발급 후 불변). used_owners 내용 변경(append)은 frozen 이라도 허용.
    used_owners 는 list — 클래스 소비 판정을 `==`/hash 아닌 **identity(is)** 로(custom metaclass
    equality 로 무관 클래스가 같다고 판정되는 우회 봉쇄, codex v5)."""
    tool: object
    context: object
    task: object
    used_owners: list = field(default_factory=list)


_RUN_PERMIT: contextvars.ContextVar[_RunPermit | None] = contextvars.ContextVar(
    "sa_tool_run_permit", default=None)
_INVOKE_DEPTH: contextvars.ContextVar[int] = contextvars.ContextVar(
    "sa_tool_invoke_depth", default=0)
_MAX_INVOKE_DEPTH = 12  # invoke_tool 재진입 깊이 상한 (cycle/폭주 backstop — canonical invoke_tool 에서 계수)
# core 가 만든 검문소 래퍼의 identity 집합. marker boolean 은 functools.wraps 로 복사돼 오염되므로
# (codex 지적) identity(WeakSet)로만 판정. class 속성으로 살아있어 GC 안 됨.
_GUARDED_WRAPPERS: "weakref.WeakSet[Any]" = weakref.WeakSet()
# 프로덕션 항상 강제. 테스트만 conftest autouse fixture 로 False 로 낮춘다(env 노출 0 —
# codex 가 지적한 프로덕션 fail-open 토글을 두지 않기 위함). cold 직접호출 테스트 41파일 호환.
_checkpoint_enforced: bool = True


def is_execute_guarded(fn: object) -> bool:
    """`fn` 이 core 검문소 래퍼인가(identity). registry 가 미보호 duck/mixin execute 를 거부."""
    try:
        return fn in _GUARDED_WRAPPERS
    except TypeError:
        return False


def issue_run_permit(tool: object, context: object) -> "contextvars.Token[_RunPermit | None]":
    """invoker._execute 전용 — 이 (tool, context, 현 task) 에 실행 permit 발급. 호출자가 finally reset."""
    try:
        task = asyncio.current_task()
    except RuntimeError:
        task = None
    return _RUN_PERMIT.set(_RunPermit(tool, context, task))


def reset_run_permit(token: "contextvars.Token[_RunPermit | None]") -> None:
    _RUN_PERMIT.reset(token)


def set_checkpoint_enforced(enabled: bool) -> bool:
    """테스트 전용(conftest) — 검문소 강제 on/off. 이전값 반환. 프로덕션 코드는 호출 안 함."""
    global _checkpoint_enforced
    prev = _checkpoint_enforced
    _checkpoint_enforced = bool(enabled)
    return prev


class Tool[TInput: BaseModel](ABC):
    name: ClassVar[str]
    description: ClassVar[str]
    input_model: ClassVar[type[BaseModel]]
    search_hint: ClassVar[str] = ""
    is_read_only: ClassVar[bool] = False
    is_concurrency_safe: ClassVar[bool | None] = None
    is_destructive: ClassVar[bool] = False
    deferred: ClassVar[bool] = False

    # v3.12-A — 도메인 메타. prompt 합성 / domain 필터링에 사용.
    # domain="core" 는 도메인 무관 (schedule/todo/python_exec 등).
    # prompt_section 비어있으면 prompt 도구 섹션에서 자동 생략.
    # dispatch_keywords 비어있으면 dispatch cheat sheet 에서 자동 생략.
    domain: ClassVar[str] = "core"
    prompt_section: ClassVar[str] = ""
    dispatch_keywords: ClassVar[tuple[str, ...]] = ()

    # v3.25-A — frontend capability 요구. build_registry_for_task 가
    # frontend_capabilities 의 superset 이 아니면 등록 자체에서 제외.
    # 예: enter_plan_mode 는 {"interactive_approval"} 요구 — chat WS 에선 안 보임.
    requires_capabilities: ClassVar[frozenset[str]] = frozenset()

    def __init_subclass__(cls, **kw: Any) -> None:
        # v3.89: 각 서브클래스의 execute 를 검문소 래퍼로 투명 교체(execute 이름 보존 →
        # skill override·load_plugins 무변경). execute 미정의(상속)=skip, 이미 래핑=멱등.
        # 추상 execute 재선언도 **래핑하되 __isabstractmethod__ 보존**(추상 non-Tool mixin 의 raw
        # 본문이 super() 로 검문소 없이 실행되던 것 봉쇄 — codex v4).
        super().__init_subclass__(**kw)
        impl = cls.__dict__.get("execute")
        if impl is None or is_execute_guarded(impl):
            return  # execute 미정의(상속) 또는 이미 래핑(멱등)
        # 추상 execute(body 가질 수 있음)도 래핑하되 __isabstractmethod__ 보존(추상 상태·인스턴스화
        # TypeError 유지). impl·cls 는 **default 인자가 아니라 lexical closure** 로 캡처 — caller 가
        # `execute(self, vi, ctx, evil_impl)` 로 지정 못 하게(codex Q4). 시그니처는 정확히 (self, vi, ctx).
        _abstract = getattr(impl, "__isabstractmethod__", False)

        @functools.wraps(impl)
        async def _guarded(self, validated_input, context):  # type: ignore[no-untyped-def]
            permit = _RUN_PERMIT.get()
            try:
                cur_task = asyncio.current_task()
            except RuntimeError:
                cur_task = None
            # cls(이 wrapper 를 만든 원 클래스) ∈ type(self).__mro__ 이어야:
            #  · super() 협조/상속: cls 가 self 의 조상 → 통과(레벨마다 다른 cls → 각 1회 소비).
            #  · borrowed-self(OtherTool.execute(self)): cls=OtherTool ∉ type(self).__mro__ → 차단.
            #  · wrapper transplant(alias `execute=OtherTool.execute` / @dataclass class-replace):
            #    cls=원 클래스 ∉ 옮겨진 클래스 MRO → 차단(fail-closed). @dataclass(slots=True)/alias 는
            #    Tool 에 미지원 — 평범한 상속을 쓸 것(실도구 46종 전부 그러함).
            # cls ∉ used_owners: 이 레벨 permit 당 1회(self 재호출/같은레벨 입력 escalation 차단).
            # ★ identity(is)로 판정 — `cls in mro`/`cls in used_owners` 는 `==`/hash 를 타서 custom
            # metaclass equality 가 무관 클래스를 같다고 만들 수 있다(codex v5). is 로 봉쇄.
            # used_owners 접근은 permit non-None 확인 뒤(and 단락평가).
            owner_in_mro = any(base is cls for base in type(self).__mro__)
            if (permit is not None and permit.tool is self and permit.context is context
                    and cur_task is not None and permit.task is cur_task and owner_in_mro
                    and all(used is not cls for used in permit.used_owners)):
                permit.used_owners.append(cls)
                return await impl(self, validated_input, context)
            if not _checkpoint_enforced:  # 테스트 cold-call 우회(conftest 전용)
                return await impl(self, validated_input, context)
            raise ToolCheckpointBypass(
                f"{type(self).__name__}.execute() outside invoke_tool — "
                "route sub-tool calls through context.invoke_tool(name, input).")

        # marker 대신 identity(WeakSet)로 판정. 추상이면 flag 보존.
        _GUARDED_WRAPPERS.add(_guarded)
        _guarded.__isabstractmethod__ = _abstract
        cls.execute = _guarded  # type: ignore[assignment]

    @classmethod
    def input_schema(cls) -> dict[str, Any]:
        return cls.input_model.model_json_schema()

    async def check_permission(
        self, validated_input: TInput, context: ToolContext,
    ) -> PermissionDecision:
        del validated_input, context
        if self.is_destructive:
            return PermissionDecision(behavior="ask", reason="destructive tool")
        return PermissionDecision(behavior="allow")

    @abstractmethod
    async def execute(self, validated_input: TInput, context: ToolContext) -> ToolResult: ...


def tool_is_concurrency_safe(tool_cls: type[Tool[Any]]) -> bool:
    cs = getattr(tool_cls, "is_concurrency_safe", None)
    return bool(tool_cls.is_read_only) if cs is None else bool(cs)


# sub-agent evidence dir 이름에 쓸 수 있는 문자. label 은 호출자 input 에서 파생되고,
# 그 input 은 **LLM 이 쓴 자유 텍스트**일 수 있다(리드가 넘기는 question/scope 등).
# 공백·따옴표·개행이 경로에 들어가면 그 경로를 읽는 쪽(쉘 스크립트·로그 파서·글롭)이
# 조용히 깨진다 — 2026-08-21 실측: 한국어 질문 한 문장이 통째로 디렉터리 이름이 됐다.
_SUB_LABEL_SAFE = re.compile(r"[^0-9A-Za-z._-]+")


def _sanitize_sub_label(label: str) -> str:
    """경로 안전한 label — 허용 문자 밖은 `_` 로 접고 연속은 하나로 줄인다.

    비-ASCII 도 접는다. 이름은 사람이 훑기 위한 힌트일 뿐이고, 식별은 ts+nonce 가 한다.
    """
    cleaned = _SUB_LABEL_SAFE.sub("_", str(label or "")).strip("_")
    return cleaned[:60] or "spawn"


def make_sub_evidence_dir(parent: Path, label: str) -> Path:
    """v3.80 Slice0a: sub-agent evidence dir 생성 — 초단위 ts 충돌 제거.

    기존 `sub-{%Y%m%dT%H%M%S}-{label}` 은 같은 초에 2개 spawn 시 동일 이름
    + mkdir(exist_ok=True) 로 **조용히 같은 dir 재사용** (증거 혼입). uuid nonce
    를 끼우고 exist_ok=False 로 fail-closed — 충돌 시 새 nonce 로 재시도.

    label 은 경로 안전하게 접는다(`_sanitize_sub_label`) — 호출자가 LLM 자유 텍스트를
    넘길 수 있다.
    """
    label = _sanitize_sub_label(label)
    for _ in range(3):
        ts = time.strftime("%Y%m%dT%H%M%S")
        nonce = uuid.uuid4().hex[:6]
        path = parent / f"sub-{ts}-{nonce}-{label}"
        try:
            path.mkdir(parents=True, exist_ok=False)
        except FileExistsError:
            continue
        return path
    raise RuntimeError(f"sub evidence dir 충돌 3회 — parent={parent} label={label}")


# ── v3.80 Slice0c: sub-agent spawn timeout + charter 상속 ────────────

SUBAGENT_TIMEOUT_ENV = "SA_SUBAGENT_TIMEOUT_SEC"
_SUBAGENT_TIMEOUT_DEFAULT = 600.0


def subagent_timeout_sec() -> float:
    """부모측 spawn backstop timeout (초).

    워커 내부 예산 계층 위에 앉는 마지막 방어선이라 내부 한도보다 커야 한다:
      idle watchdog 120s < max_wall_clock_sec 300s (워커 자체 graceful 종료,
      결과/audit 작성) < 부모 backstop 600s (워커가 자체 watchdog 도 못 돌릴
      만큼 wedge — 예: socket timeout 없는 LLM HTTP hang — 일 때만 발동).
    부모 잔여 예산은 ToolContext 에 노출 안 돼 있어 고정값 (동적화는 Slice1).
    """
    raw = os.environ.get(SUBAGENT_TIMEOUT_ENV, "")
    try:
        v = float(raw)
        if v > 0:
            return v
    except ValueError:
        pass
    return _SUBAGENT_TIMEOUT_DEFAULT


def inherit_charter_ref(context: ToolContext) -> str:
    """sub-agent task_spec 의 charter_ref — 부모 인가 컨텍스트 상속.

    부모가 어떤 charter 로 돌든 env 기본값이 박히면 감사추적이 끊긴다.
    부모 ToolContext metadata 의 charter_ref 우선, 없을 때만 env fallback
    (operator chat 등 charter 없는 컨텍스트).
    """
    ref = str(context.metadata.get("charter_ref") or "").strip()
    if ref:
        return ref
    return os.environ.get("DEFAULT_CHARTER_REF", "CHARTER-PLACEHOLDER-001")
