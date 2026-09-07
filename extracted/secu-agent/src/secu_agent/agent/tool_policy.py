"""도메인 등록형 도구 정책(ToolPolicy) — v3.87 C2-a 클린 플러그인 가드레일.

코어의 도구 실행 초크포인트(`tools/invoker.py::invoke_tool`)는 이미 권한/파괴적/스케줄
게이트를 갖는다. 도메인이 자기 자산 점검에 필요한 **추가** 안전 규칙(예: 특정 도구는
in-scope charter 가 있어야, 특정 도구는 특정 task_type 에서만 허용)을 코어 0줄 수정으로
in-code·prompt-독립적으로 강제하도록, task_type→계약(`register_task_contract`)과 같은
방식의 등록형 훅을 제공한다. 코어는 어떤 도메인 정책도 알지 못한다.

적용 범위(정직한 경계):
- 정책은 **모델 주도 도구 루프의 초크포인트(invoke_tool)** 에서 강제된다 — LLM 이 호출할
  수 있는 모든 도구가 이 경로를 지난다(엔진 유일 호출부). 이것이 실제 공격 표면이다.
- plugin 이 자기 내부 오케스트레이션에서 다른 도구의 `.execute()` 를 **직접** 부르면
  invoke_tool 을 건너뛰어 정책(및 기존 권한 게이트)도 우회된다 — 이는 코어가 막을 수
  없는 plugin 측 안티패턴이며(정책 도입 이전부터 권한 게이트도 동일하게 우회됨), 서브도구
  호출은 plugin 도 invoke_tool 을 거쳐야 한다.

신뢰 모델(정직하게):
- 정책은 operator 가 SA_PLUGINS 로 적재하는 **신뢰된 in-process plugin** 이 등록한다.
  악의적 plugin 은 애초에 코어 모듈을 직접 import·전역 변조할 수 있어 어떤 게이트든
  우회 가능하다 — 즉 이 훅은 **악성 plugin 에 대한 샌드박스가 아니다**(그런 건 in-process
  로는 불가능). 아래 방어는 **선의의 정책이 실수로 코어 상태/실행을 변조하는 것**을 막는
  defense-in-depth 이자, 정책이 코어 내부에 결합되는 표면을 최소화하는 장치다.

SAFETY-KEEP(강화 전용 — 코어 게이트를 절대 약화 못 함):
- 정책은 **차단만** 한다. None 은 "이 훅으로는 막지 않음"일 뿐이고, 코어 권한/url_safety/
  파괴적/마스킹 게이트는 그대로 이어서 돈다(allow-override 없음). 정책 게이트는 권한/승인
  흐름 **뒤, 실행 직전**에 돈다.
- **부작용 없는 검사(best-effort)**: predicate 에는 실행 객체가 아니라 사본/뷰만 넘긴다 —
  ① 입력은 정책마다 `model_copy(deep=True)` fresh 사본(정책이 사본을 바꿔도 실제 실행
     입력 불변 → 승인 후 입력을 변조해 앞선 게이트를 우회하는 경로 차단; 정책 간 교차오염도
     없음). _execute 는 언제나 원본 next_input 으로 돈다.
  ② metadata 는 **스칼라 값만** 담은 read-only 뷰(문자열/수/불리언/None). 라이브 객체
     (guardrail controller·resolver 등)와 중첩 mutable(list/dict)은 제외 → 정책이 코어
     상태를 엿보거나 별칭 경유로 변조하지 못한다.
  잔여(문서화, 신뢰 모델상 무시가능): deep-copy 가 실패하거나 필드가 `__deepcopy__`=self 인
  병적 타입, 또는 mutable 속성을 얹은 str/int 서브클래스 metadata 값은 별칭될 수 있다 —
  단 이는 "실수로 입력/metadata 를 변조하는 정책 + 병적 타입"이 동시에 필요하고, 그런
  변조로도 코어 게이트(평문 스칼라만 읽음)를 약화하지 못한다.
- predicate 가 str 을 돌려주면(빈 문자열 포함) **무조건 차단**한다(비면 기본 사유로 대체).
  predicate 예외도 **fail-closed**(그 도구 호출을 차단; 사유에 정책 이름 노출).
- 정책 미등록 시 evaluate 는 no-op(None) — 코어 동작 무변(순수 additive).
- 레지스트리는 lock 으로 보호 — 실행 중 등록/해제와 평가 iteration 이 경합하지 않는다.

중복 등록은 명시 에러(silent override 금지). 등록/해제는 register_task_contract 와 동형.
"""
from __future__ import annotations

import threading
import types
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

# check(tool_name, input_copy, metadata_view, is_read_only) -> str | None
#   None       = 이 정책으로는 차단하지 않음(허용).
#   str        = 차단 사유(빈 문자열이어도 차단; 사람이 읽을 문구, 모델에게도 전달됨).
#   input_copy = 실행 직전 도구 입력의 deep copy(정책이 바꿔도 실행 입력엔 영향 없음).
#   metadata_view = read-only 스칼라 인가 맥락(charter_ref/task_type/schedule_origin 등).
# 타입은 순환 import 회피를 위해 Any 로 둔다(task_contract 의 BudgetFactory 와 동일 결).
ToolPolicyCheck = Callable[[str, Any, "Mapping[str, Any]", bool], "str | None"]

# 정책에 노출 가능한 metadata 값 타입 — 스칼라만(불변). 라이브 객체/중첩 mutable 제외.
_POLICY_SCALAR_TYPES = (str, int, float, bool, type(None))


@dataclass(frozen=True)
class ToolPolicy:
    """도구 하나(또는 여럿)에 걸리는 등록형 차단 정책.

    name
        정책 식별자(중복 등록 거부 키·차단 사유 접두어).
    check
        차단 판정 predicate. 위 ToolPolicyCheck 시그니처. metadata 는 read-only.
    applies_to
        이 정책이 검사할 도구 이름 집합. None = 모든 도구에 적용.
    """

    name: str
    check: ToolPolicyCheck
    applies_to: frozenset[str] | None = None


_TOOL_POLICIES: dict[str, ToolPolicy] = {}
_TOOL_POLICIES_LOCK = threading.Lock()


def register_tool_policy(policy: ToolPolicy) -> None:
    """도구 정책 등록 (plugin API). 중복은 명시 에러 (silent override 금지)."""
    with _TOOL_POLICIES_LOCK:
        if policy.name in _TOOL_POLICIES:
            raise ValueError(f"tool policy already registered: {policy.name!r}")
        _TOOL_POLICIES[policy.name] = policy


def unregister_tool_policy(name: str) -> None:
    """등록 해제 (test/plugin 재부착용). 미등록은 무시."""
    with _TOOL_POLICIES_LOCK:
        _TOOL_POLICIES.pop(name, None)


def registered_tool_policies() -> frozenset[str]:
    """등록된 정책 이름 집합."""
    with _TOOL_POLICIES_LOCK:
        return frozenset(_TOOL_POLICIES)


def _policy_metadata_view(metadata: "Mapping[str, Any]") -> "Mapping[str, Any]":
    """정책에 넘길 read-only 인가 맥락 — 스칼라 값만. 라이브 객체(guardrail controller 등)와
    중첩 mutable 은 제외해 정책이 코어 상태를 엿보거나 별칭 경유 변조하지 못하게 한다."""
    return types.MappingProxyType({
        k: v for k, v in metadata.items()
        # bool 은 int 서브클래스 — 별도 처리 불필요(둘 다 스칼라 허용).
        if isinstance(v, _POLICY_SCALAR_TYPES)
    })


def _policy_input_view(validated_input: Any) -> Any:
    """정책에 넘길 입력 사본 — deep copy 라 정책이 바꿔도 실제 실행 입력은 불변.
    pydantic 모델이 아니면(방어적) 원본 반환."""
    copy = getattr(validated_input, "model_copy", None)
    if callable(copy):
        try:
            return copy(deep=True)
        except Exception:  # noqa: BLE001 — 복사 실패는 검사만 막고 실행은 원본으로 진행
            return validated_input
    return validated_input


def evaluate_tool_policies(
    tool_name: str,
    validated_input: Any,
    metadata: "Mapping[str, Any]",
    *,
    is_read_only: bool,
) -> str | None:
    """등록된 모든 적용 정책을 평가. 첫 차단 사유를 반환(없으면 None=이 훅 통과).

    - 정책에는 입력 deep copy + 스칼라만 담은 read-only metadata 뷰만 넘긴다(부작용 없는
      검사; 정책이 실행 입력/코어 상태를 변조 못 함, SAFETY-KEEP).
    - 레지스트리는 lock 스냅샷으로 읽어 실행 중 등록/해제와 iteration 경합을 막는다.
    - applies_to 가 지정된 정책은 해당 도구에만 검사.
    - predicate 가 str 반환(빈 문자열 포함) → 차단(비면 기본 사유로 대체).
    - predicate 예외는 fail-closed(그 정책 이름으로 차단).
    - 반환 문구에는 `[정책이름] ...` 접두어를 달아 어느 정책이 막았는지 드러낸다.
    """
    with _TOOL_POLICIES_LOCK:
        if not _TOOL_POLICIES:
            return None
        policies = tuple(_TOOL_POLICIES.values())  # iteration-safe 스냅샷
    applicable = [
        p for p in policies
        if p.applies_to is None or tool_name in p.applies_to
    ]
    if not applicable:
        return None
    meta_view = _policy_metadata_view(metadata)
    for policy in applicable:
        # 정책마다 fresh 입력 사본 — 앞선 정책의 실수 변조가 뒤 정책 판정을 오염시키지 않게.
        input_view = _policy_input_view(validated_input)
        try:
            reason = policy.check(tool_name, input_view, meta_view, is_read_only)
        except Exception as e:  # noqa: BLE001 — 깨진 보안정책은 통과가 아니라 차단(fail-closed)
            return f"[{policy.name}] tool policy errored (fail-closed): {e}"
        if reason is not None:  # 빈 문자열도 차단(모든 str 반환=차단 의도)
            text = str(reason).strip() or "blocked by tool policy"
            return f"[{policy.name}] {text}"
    return None
