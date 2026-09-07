"""confluence 검토원 실행계약 — task_type 이 **둘**이다 (Phase 1).

## 왜 하나가 아닌가

오늘 confluence 워커는 `target.kind` 로 도구셋과 종료 도구를 **둘 다** 바꾼다:

    keyword_search → {confluence_search_set_status}
    그 외(space)   → {confluence_space_set_status, devops_target_set_status}

`TaskContract.terminal_tools` 는 정적이고 `register_task_toolset` 의 provider 는
무인자 호출이라, 하나로 합치려면 합집합을 줘야 한다. 그러면
`_terminal_tools_for` 의 docstring 이 명시한 안전성이 깨진다 —
"에이전트가 실수로 space/devops setter 를 불러도 완료 처리되지 않아 **엉뚱한 큐를
'ok'로 닫지 못한다**". 그 성질을 지키려면 task_type 이 둘이어야 한다.
"""
from __future__ import annotations

from typing import Any


def _user_message(spec: dict) -> str:
    from service.agents.confluence_task_worker import _build_user_text
    return _build_user_text(spec)


def _metadata(spec: dict) -> dict[str, Any]:
    return {"confluence_target": spec.get("target") or {}}


def _space_tools():
    from domains.services.confluence.plugin.toolsets import confluence_task_tools
    return confluence_task_tools(None)


def _search_tools():
    from domains.services.confluence.plugin.toolsets import confluence_task_tools
    return confluence_task_tools("keyword_search")


def _contract(task_type: str, tools, terminal: set[str]):
    from _shared.inspect_contract import (
        INSPECTOR_IDLE_SEC_DEFAULT, build_inspect_contract,
    )

    return build_inspect_contract(
        task_type=task_type,
        skill_name="confluence_task",
        tools=tools,
        terminal_tools=frozenset(terminal),
        user_message=_user_message,
        metadata=_metadata,
        env_prefix="CONFLUENCE_TASK",
        default_turns=40,
        default_wall_sec=1500,
        default_idle_sec=INSPECTOR_IDLE_SEC_DEFAULT,
        default_tokens=500_000,
        candidate_ledger_enforce=True,
        require_terminal_tool=True,
    )


def confluence_inspect_contract():
    """space / space_batch 검토원."""
    return _contract(
        "confluence_inspect", _space_tools,
        {"confluence_space_set_status", "devops_target_set_status"},
    )


def confluence_search_inspect_contract():
    """keyword_search 검토원 — 검색 큐만 닫을 수 있다."""
    return _contract(
        "confluence_search_inspect", _search_tools,
        {"confluence_search_set_status"},
    )
