"""github 검토원 실행계약 — task_type `github_inspect` (Phase 1).

값은 오늘 `github_task_worker` 의 `run_agent(...)` 호출에서 그대로 옮겼다.

`devops_target_set_status` 는 findings 유무와 무관한 **필수 종료**라
`require_terminal_tool=True` 다 — 종료를 tool_use 대신 텍스트로만 내던 실패모드
(CORE-ASK ④)를 엔진 리마인더로 되돌린다.

이미지 근거를 쓰지 않으므로 vision 능력 슬롯은 없다(전역 프로파일을 그대로 따른다).
"""
from __future__ import annotations

from typing import Any


def _user_message(spec: dict) -> str:
    from service.agents.github_task_worker import _build_user_text
    return _build_user_text(spec)


def _metadata(spec: dict) -> dict[str, Any]:
    return {"github_sso_target": spec.get("target") or {}}


def github_inspect_contract():
    from _shared.inspect_contract import (
        INSPECTOR_IDLE_SEC_DEFAULT, build_inspect_contract,
    )
    from domains.services.github.plugin.toolsets import github_task_tools

    return build_inspect_contract(
        task_type="github_inspect",
        skill_name="github_task",
        tools=github_task_tools,
        terminal_tools=frozenset({"devops_target_set_status"}),
        user_message=_user_message,
        metadata=_metadata,
        env_prefix="GITHUB_TASK",
        default_turns=40,
        default_wall_sec=1500,
        default_idle_sec=INSPECTOR_IDLE_SEC_DEFAULT,
        default_tokens=500_000,
        candidate_ledger_enforce=True,
        require_terminal_tool=True,
    )
