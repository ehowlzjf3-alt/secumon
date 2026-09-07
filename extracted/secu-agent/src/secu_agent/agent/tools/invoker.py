"""Tool invocation pipeline: validate → permission → execute → wrap."""
from __future__ import annotations

import asyncio

import logging

from pydantic import BaseModel, ValidationError

from secu_agent.agent.candidate_ledger import (
    has_candidate_counters,
    run_candidate_counters,
)
from secu_agent.agent.terminal_contract import (
    REQUIRE_TERMINAL_TOOL_KEY,
    TERMINAL_INVOKED_KEY,
)
from secu_agent.agent.tool_policy import evaluate_tool_policies
from secu_agent.agent.tools.approval import ApprovalRequest
from secu_agent.agent.tools.autonomy import (
    AUTONOMOUS_TOOLS_ENV,
    is_autonomous_tool_allowed,
)
from secu_agent.agent.tools.base import (
    _INVOKE_DEPTH,
    _MAX_INVOKE_DEPTH,
    PermissionDecision,
    Tool,
    ToolCheckpointBypass,
    ToolContext,
    ToolError,
    ToolInvocation,
    ToolResult,
    ToolSuccess,
    issue_run_permit,
    reset_run_permit,
)
from secu_agent.agent.tools.registry import ToolRegistry

_log = logging.getLogger("secu_agent.agent.tools.invoker")


def _validate(
    tool_cls: type[Tool[BaseModel]], raw_input: dict[str, object],
) -> BaseModel | ToolError:
    try:
        return tool_cls.input_model.model_validate(raw_input)
    except ValidationError as e:
        # ★ **어떤 인자가 문제였는지 남긴다** (2026-09-02).
        #   CLI 는 ToolError 를 `err:validation (0 chars)` 로만 찍고 메시지를 버리며,
        #   `ToolCallStarted` 표시는 인자를 앞 3개만 보여준다 — 그래서 4번째 인자가
        #   원인이면 사후에 알 길이 전혀 없었다(리드 A/B 에서 실제로 막혔다).
        #   모델은 메시지를 받는데 운영자만 못 보던 비대칭을 없앤다.
        _log.warning(
            "[tool] %s 인자 검증 실패 — 키=%s 사유=%s",
            getattr(tool_cls, "name", tool_cls.__name__),
            sorted(raw_input.keys()) if isinstance(raw_input, dict) else type(raw_input).__name__,
            str(e).replace("\n", " ")[:400],
        )
        return ToolError(kind="validation", message=str(e))


async def _check_permission(
    tool: Tool[BaseModel], validated: BaseModel, context: ToolContext, name: str,
) -> PermissionDecision | ToolError:
    try:
        return await tool.check_permission(validated, context)
    except Exception as e:
        return ToolError(kind="permission", message=f"permission check error: {e}")


def _apply_decision(
    decision: PermissionDecision, tool_cls: type[Tool[BaseModel]], validated: BaseModel,
) -> BaseModel | ToolError:
    if decision.behavior == "deny":
        return ToolError(kind="permission", message=f"denied: {decision.reason or 'no reason'}")
    if decision.behavior == "ask":
        return ToolError(kind="permission", message=f"approval required: {decision.reason}")
    if decision.updated_input is not None:
        return _validate(tool_cls, decision.updated_input)
    return validated


async def _apply_decision_with_approval(
    decision: PermissionDecision,
    tool_cls: type[Tool[BaseModel]],
    validated: BaseModel,
    invocation: ToolInvocation,
    context: ToolContext,
) -> BaseModel | ToolError:
    """Apply PermissionDecision, resolving ask via an injected approval resolver.

    No resolver or no matching approval remains fail-closed. That preserves the
    old unattended behavior while allowing CLI/UI harnesses to approve safely.
    """
    if decision.behavior != "ask":
        return _apply_decision(decision, tool_cls, validated)

    resolver = context.approval_resolver
    if resolver is None:
        return ToolError(kind="permission", message=f"approval required: {decision.reason}")

    request_input = decision.updated_input
    if request_input is None:
        request_input = validated.model_dump(mode="json")
    request = ApprovalRequest(
        invocation_id=invocation.id,
        tool_name=invocation.name,
        tool_input=request_input,
        reason=decision.reason,
    )
    try:
        approval = await resolver.resolve(request)
    except Exception as e:
        return ToolError(kind="permission", message=f"approval resolver error: {e}")

    if approval is None:
        return ToolError(kind="permission", message=f"approval required: {decision.reason}")
    if approval.behavior == "deny":
        return ToolError(kind="permission", message=f"denied: {approval.reason or 'no reason'}")
    if approval.updated_input is not None:
        return _validate(tool_cls, approval.updated_input)
    if decision.updated_input is not None:
        return _validate(tool_cls, decision.updated_input)
    return validated


async def _execute(
    tool: Tool[BaseModel], validated: BaseModel, context: ToolContext, name: str,
) -> ToolResult:
    # 종료 도구 계약(terminal_contract): Tool.execute 진입 직전(= 실제 실행 시작)의
    # canonical choke point — 모든 실행 경로(streaming/post-stream)가 여기로 수렴한다.
    # task 생성/디스패치 시점이 아니라 execute 진입이라, 취소/검증/권한/정책/abort 로
    # execute 에 도달 못 하면 set 되지 않는다(codex R6: 조기·성공한정 기록의 오탐 제거).
    # require_terminal_tool opt-in 일 때만 — chat/비-opt-in metadata 불변.
    if context.metadata.get(REQUIRE_TERMINAL_TOOL_KEY):
        _terminal_names = context.metadata.get("terminal_tools") or {"submit_finding"}
        if name in _terminal_names:
            context.metadata[TERMINAL_INVOKED_KEY] = True
    # v3.89 Slice1: 실행 직전에만 permit 발급(앞 게이트가 실패하면 여기 도달 안 함). 클래스 속성
    # execute(검문소 래퍼)를 명시 호출 — 인스턴스 shadow(self.execute=raw)를 우회 못 하게(codex).
    token = issue_run_permit(tool, context)
    try:
        result = await type(tool).execute(tool, validated, context)
    except asyncio.CancelledError:
        raise
    except ToolCheckpointBypass as e:
        # 구조적 안전 위반 → forbidden (일반 execution 실패와 구분: 재시도/감사/경보 분리, codex).
        return ToolError(kind="forbidden", message=str(e))
    except Exception as e:
        return ToolError(kind="execution", message=f"{type(e).__name__}: {e}")
    finally:
        reset_run_permit(token)
    if not isinstance(result, ToolSuccess | ToolError):
        return ToolError(kind="execution", message=f"non-result: {type(result).__name__}")
    return result


async def invoke_tool(
    invocation: ToolInvocation, registry: ToolRegistry, context: ToolContext,
) -> ToolResult:
    """모든 도구 실행의 canonical 진입점. 재진입 깊이를 여기서 계수(module 직접호출·context.invoke_tool
    경로 모두 포함 — codex). 상한 초과 시 forbidden(cycle/폭주 backstop). finally 로 예외/취소에도 복원."""
    depth = _INVOKE_DEPTH.get()
    if depth >= _MAX_INVOKE_DEPTH:
        return ToolError(
            kind="forbidden",
            message=f"invoke_tool: max nesting depth {_MAX_INVOKE_DEPTH} exceeded (cycle?)")
    tok = _INVOKE_DEPTH.set(depth + 1)
    try:
        return await _invoke_tool_inner(invocation, registry, context)
    finally:
        _INVOKE_DEPTH.reset(tok)


async def _invoke_tool_inner(  # noqa: PLR0911
    invocation: ToolInvocation, registry: ToolRegistry, context: ToolContext,
) -> ToolResult:
    tool_cls = registry.get(invocation.name)
    if tool_cls is None:
        return ToolError(kind="not_found", message=f"unknown tool: {invocation.name}")

    tool = tool_cls()
    # v3.89: 인스턴스 실제 타입이 등록 클래스와 다르면(custom __new__/metaclass 가 proxy 반환) 게이트는
    # tool_cls 로 하고 실행은 다른 타입의 raw execute 가 될 수 있다 → fail-closed(codex). 정상 도구는 항상 일치.
    if type(tool) is not tool_cls:
        return ToolError(
            kind="forbidden",
            message=f"tool {invocation.name}: instance type mismatch (custom __new__?) — blocked")

    if "__parse_error" in invocation.input:
        raw = invocation.input.get("__parse_error")
        preview = raw[:500] + "…" if isinstance(raw, str) and len(raw) > 500 else raw
        return ToolError(
            kind="validation",
            message=(
                f"tool arguments were not valid JSON. Re-emit with proper escaping "
                f"(use '\\n' not literal newlines). Raw preview: {preview!r}"
            ),
        )

    validated = _validate(tool_cls, invocation.input)
    if isinstance(validated, ToolError):
        return validated

    if (
        context.metadata.get("schedule_origin")
        and tool_cls.is_destructive
        and not is_autonomous_tool_allowed(invocation.name)
    ):
        return ToolError(
            kind="permission",
            message=(
                f"scheduled execution cannot run destructive tool: "
                f"{invocation.name} — set {AUTONOMOUS_TOOLS_ENV}={invocation.name} "
                f"to allow for trusted automation"
            ),
        )

    decision = await _check_permission(tool, validated, context, invocation.name)
    if isinstance(decision, ToolError):
        return decision

    next_input = await _apply_decision_with_approval(
        decision, tool_cls, validated, invocation, context,
    )
    if isinstance(next_input, ToolError):
        return next_input

    if context.aborted:
        return ToolError(kind="cancelled", message="aborted before execution")

    # C2-a: 도메인 등록형 도구 정책(강화 전용 게이트) — 권한/승인 흐름 뒤, 실행 직전에
    # **최종 입력(next_input, 승인·리다케이션 반영 후)** 과 read-only 인가 metadata 를 보고
    # 차단만 한다. 정책 이후 코어 게이트가 없어 변조 우회 여지 0. 미등록 시 no-op.
    policy_block = evaluate_tool_policies(
        invocation.name, next_input, context.metadata,
        is_read_only=bool(tool_cls.is_read_only),
    )
    if policy_block is not None:
        return ToolError(kind="policy", message=policy_block)

    result = await _execute(tool, next_input, context, invocation.name)
    # candidate ledger: 도메인 등록형 counter — ToolSuccess 결과에서 후보/처리
    # 건수를 세어 장부에 기록(record-only, 결과 불변). 미등록 tool 은 fast-path.
    # 장부 실패가 도구 결과를 삼키면 안 된다 — 전체 best-effort.
    if isinstance(result, ToolSuccess) and has_candidate_counters(invocation.name):
        try:
            run_candidate_counters(
                invocation.name,
                next_input.model_dump(mode="json"),
                result.content,
                context.metadata,
            )
        except Exception:  # noqa: BLE001
            pass
    return result
