"""워커 실행계약(TaskContract) 등록 — v3.85 클린 플러그인 호스트.

워커(agent/cli.py `_run`)는 task_type 마다 user-message 빌더, 예산, ToolContext
metadata, terminal 도구, MCP 부트스트랩, 미제출/제출 산출물 처리가 달랐다. 이전엔
이 분기들이 cli.py 안의 `if task_type == "..."` 하드코딩이었고, allowlist 가
{generic, finding_narrator, package_sandbox} 밖 task_type 을 거부했다(도메인 누출:
새 도메인 워커는 cli.py 를 수정해야 실행됐다).

이제 코어는 task_type→TaskContract 레지스트리만 들고, 코어 자신의 generic/
finding_narrator/package_sandbox 도 같은 공개 훅(register_task_contract)으로
등록한다. 도메인 plugin 은 register_task_contract(...) 로 자기 워커 계약을 코어
0줄 수정 없이 등록한다 — 등록 자체가 그 task_type 을 워커에 허용시킨다.

SAFETY-KEEP: 레지스트리는 "어떤 계약이 이미-fresh 인 워커 프로세스 안에서 도는가"
만 고른다 — worker_pool 의 fresh-subprocess-per-spec 모델(SSO circuit-breaker 가
프로세스 종료로만 리셋)을 바꾸지 않는다. terminal 게이트(submit_finding/submit_verdict)
는 계약이 그대로 들고 있어야 하며, 중복 등록은 명시 에러(코어 계약 silent override 금지).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from secu_agent.agent.tools.capability import Capability

# 순환 import 회피: AgentBudget 는 타입 힌트로만 필요 (런타임 참조 없음).
BudgetFactory = Callable[[dict, Any], Any]


@dataclass(frozen=True)
class TaskContract:
    """task_type 하나의 워커 실행계약.

    build_user_message(spec, evidence_dir) -> str
        워커 초기 user 메시지 본문.
    terminal_tools
        성공 신호가 되는 terminal 도구 이름 집합(예: {"submit_finding"}).
    needs_mcp_bootstrap
        CLI 워커에서 MCP 서버(config/mcp_servers.yaml)를 부트스트랩할지.
    budget(spec, profile) -> AgentBudget | None
        task_type 기본 예산(argv/spec override 가 없을 때만 사용). None = 코어 기본.
    metadata(spec) -> dict
        ToolContext.metadata 에 주입할 키(예: finding_ids, terminal_tools).
    system_prompt(spec) -> str
        도메인 계약이 자기 system prompt 를 공급(None = 코어 system_prompt(task_type)).
    build_client(profile, profiles, spec) -> LLMClient
        계약이 자기 LLM client 를 공급(None = 코어 _build_client(profile)).

        왜 필요한가: 코어는 선택된 프로파일로 **날것** client 를 만든다. 그런데 도메인
        워커는 게이트웨이 호환 래퍼가 있어야 산다 — 이미지 400(태스크 영구 사망),
        텍스트없는 tool_use 로 인한 5xx, 폴백 체인, 서빙 모델 provenance. 이걸 코어에
        하드코딩하면 도메인 누출이고, 계약이 못 들면 워커가 방어막 없이 돈다.

        `profile` 은 코어가 이미 검증한 선택값(존재 확인 끝)이고 `profiles` 는 전체
        로스터다. 계약은 이 선택을 존중해도 되고, **능력 기반으로 바꿔도 된다**
        (예: 이미지가 필수인 워커에 vision 불가 모델이 선택된 경우). 바꿀 때는
        로그로 드러낼 것 — 조용한 모델 교체는 A/B 어트리뷰션을 망친다.
    on_no_submit(evidence_dir, spec, reason) -> int
        terminal 미호출 종료 시 errored 산출물 기록 + 반환 rc(None = rc 3, 산출물 없음).
    on_submit(evidence_dir, spec) -> int
        terminal 호출 성공 시 산출물 경로 출력 + 반환 rc(None = rc 0, 출력 없음).
    """

    task_type: str
    build_user_message: Callable[[dict, Path | None], str]
    terminal_tools: frozenset[str]
    needs_mcp_bootstrap: bool = False
    budget: BudgetFactory | None = None
    metadata: Callable[[dict], dict[str, Any]] | None = None
    system_prompt: Callable[[dict], str] | None = None
    on_no_submit: Callable[[Path, dict, str], int] | None = None
    on_submit: Callable[[Path, dict], int] | None = None
    # v3.95: 계약이 자기 LLM client 를 공급하는 훅. (profile, profiles, spec) -> client.
    # None = 코어 기본(_build_client(profile)) — 오늘과 byte-for-byte 동일.
    build_client: Callable[[Any, dict[str, Any], dict], Any] | None = None
    # v3.89: 이 task_type 워커가 자율로 쓸 수 있게 계약이 선언하는 destructive 능력(Capability 튜플).
    # 기본 () → grant 없음 → 오늘과 동일(fail-closed). 유효 grant = 선언 ∩ operator env − floor
    # (build_effective_grants). 도메인 계약이 최소 read-only 브라우저 셋만 선언하도록.
    autonomous_grants: tuple["Capability", ...] = ()


_TASK_CONTRACTS: dict[str, TaskContract] = {}


def register_task_contract(contract: TaskContract) -> None:
    """워커 실행계약 등록 (plugin API). 중복은 명시 에러 (silent override 금지)."""
    if contract.task_type in _TASK_CONTRACTS:
        raise ValueError(
            f"task contract already registered: {contract.task_type!r}"
        )
    _TASK_CONTRACTS[contract.task_type] = contract


def unregister_task_contract(task_type: str) -> None:
    """등록 해제 (test/plugin 재부착용). 미등록은 무시."""
    _TASK_CONTRACTS.pop(task_type, None)


def get_task_contract(task_type: str | None) -> TaskContract | None:
    """등록된 계약 조회 (미등록 = None → 워커가 unsupported 로 fail-closed)."""
    if task_type is None:
        return None
    return _TASK_CONTRACTS.get(task_type)


def registered_task_contracts() -> frozenset[str]:
    """등록된 task_type 집합."""
    return frozenset(_TASK_CONTRACTS)
