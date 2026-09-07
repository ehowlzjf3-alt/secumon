"""v3.81 T4: agent_type 레지스트리 — 도메인 agent_type 이름의 등록형 전환 (확정 결정 ③).

이전엔 web chat/scheduler/schedule_tool 이 각자 도메인 하드코딩 set
({"agent", <도메인 agent_type 들>, ...})을 들고 있었다. 코어는 'agent' 만 알고,
도메인 agent_type 는 plugin 재부착이 register_agent_type 로 등록한다.

미등록 agent_type 로 세션을 만들면 prompts/registry 가 generic fallback 을
타므로 (system_generic + 최소 도구) 등록 검증은 "오타/미부착 plugin 을
보이게 거부"하는 UX 게이트다 — 보안 게이트가 아니다.
"""
from __future__ import annotations

CORE_AGENT_TYPES: frozenset[str] = frozenset({"agent"})

_PLUGIN_AGENT_TYPES: set[str] = set()


def register_agent_type(name: str) -> None:
    """plugin 부트스트랩용 — 중복은 명시 에러 (silent override 금지)."""
    n = str(name or "").strip()
    if not n:
        raise ValueError("agent_type 이름 비어 있음")
    if n in CORE_AGENT_TYPES or n in _PLUGIN_AGENT_TYPES:
        raise ValueError(f"agent_type {n!r} 이미 등록됨")
    _PLUGIN_AGENT_TYPES.add(n)


def unregister_agent_type(name: str) -> bool:
    if name in CORE_AGENT_TYPES:
        return False  # 코어 agent_type 제거 불가
    if name in _PLUGIN_AGENT_TYPES:
        _PLUGIN_AGENT_TYPES.discard(name)
        return True
    return False


def valid_agent_types() -> frozenset[str]:
    return frozenset(CORE_AGENT_TYPES | _PLUGIN_AGENT_TYPES)


# ── agent_type → task_type 별칭 (v3.85: 라우팅 리터럴 등록형) ─────────────────
# 프론트엔드 agent_type 라벨은 대개 task_type 과 같지만, 일부는 다른 task_type 의
# 레지스트리/프롬프트로 라우팅된다(예: 코어 'agent' → 'operator'). 이전엔 이 매핑이
# session_runtime 과 scheduler_tick 두 곳에 `{"agent","smb"}` 리터럴로 중복돼 있어,
# 도메인 이름('smb')이 프레임워크에 박혀 있었다. 이제 코어는 자기 'agent'→'operator'
# 만 시드하고, 도메인 plugin 은 register_task_type_alias 로 자기 별칭을 등록한다.
#
# 이건 UX/prompt 라우팅만 — **보안 게이트가 아니다**(agent_type_registry 상단 주석 참고).
#
# 2026-08-20: 'smb'→'operator' 하위호환 시드를 **plugin 으로 이관 완료**.
# 이제 skill `plugin/bootstrap.py` 가 register_task_type_alias("smb", "operator") 를
# 등록한다 — 코어에 도메인 이름이 남지 않는다.
#
# ⚠️ plugin 미부착 상태에서 'smb' agent_type 챗 세션을 열면 operator 레지스트리가
# 아니라 generic fallback 으로 떨어진다. 그건 회귀가 아니라 **정확한 표현**이다 —
# 도메인 plugin 이 없으면 도메인 세션도 없다. (이 매핑은 UX/prompt 라우팅일 뿐
# 보안 게이트가 아니다 — 상단 주석 참고.)
_CORE_TASK_TYPE_ALIASES: dict[str, str] = {"agent": "operator"}

_PLUGIN_TASK_TYPE_ALIASES: dict[str, str] = {}


def register_task_type_alias(agent_type: str, task_type: str) -> None:
    """agent_type 라벨을 다른 task_type 으로 라우팅하는 별칭 등록 (plugin API).

    중복은 명시 에러. 예: SMB plugin 이 register_task_type_alias("smb", "operator")
    로 SMB 챗 세션을 operator 레지스트리/프롬프트에 태운다.
    """
    a = str(agent_type or "").strip()
    if not a:
        raise ValueError("agent_type 이름 비어 있음")
    if a in _CORE_TASK_TYPE_ALIASES or a in _PLUGIN_TASK_TYPE_ALIASES:
        raise ValueError(f"task_type alias {a!r} 이미 등록됨")
    _PLUGIN_TASK_TYPE_ALIASES[a] = str(task_type)


def unregister_task_type_alias(agent_type: str) -> bool:
    if agent_type in _CORE_TASK_TYPE_ALIASES:
        return False  # 코어 별칭 제거 불가
    if agent_type in _PLUGIN_TASK_TYPE_ALIASES:
        del _PLUGIN_TASK_TYPE_ALIASES[agent_type]
        return True
    return False


def resolve_task_type(agent_type: str) -> str:
    """agent_type → task_type. 등록된 별칭이 있으면 매핑, 없으면 identity(그대로)."""
    if agent_type in _CORE_TASK_TYPE_ALIASES:
        return _CORE_TASK_TYPE_ALIASES[agent_type]
    return _PLUGIN_TASK_TYPE_ALIASES.get(agent_type, agent_type)
