"""dev_web 검토원 실행계약 — task_type `dev_web_inspect` (Phase 1).

값은 오늘 `dev_web_task_agent` 의 `run_agent(...)` 호출에서 그대로 옮겼다.
스크린샷 되먹임이 근거의 핵심이라 vision 능력 슬롯을 둔다.
"""
from __future__ import annotations

from typing import Any


def _user_message(spec: dict) -> str:
    from service import state_domain as state
    from service.agents.dev_web_task_agent import _build_user_text

    target = spec.get("target") or {}
    target_id = target.get("target_id") or target.get("id")
    row = state.dev_web_target_get(int(target_id)) if target_id is not None else None
    if not row:
        raise RuntimeError(f"dev_web target 없음: target_id={target_id!r}")
    return _build_user_text(row, charter_ref=str(spec.get("charter_ref") or ""))


def _metadata(spec: dict) -> dict[str, Any]:
    target = spec.get("target") or {}
    return {
        "dev_web_target_id": target.get("target_id") or target.get("id"),
        "dev_web_domain": target.get("domain"),
    }


def dev_web_inspect_contract():
    from _shared.inspect_contract import (
        INSPECTOR_IDLE_SEC_DEFAULT, build_inspect_contract,
    )
    from domains.dev_web.plugin.toolsets import dev_web_task_tools

    return build_inspect_contract(
        task_type="dev_web_inspect",
        skill_name="dev_web_task",
        tools=dev_web_task_tools,
        terminal_tools=frozenset({"dev_web_submit_finding", "dev_web_target_set_status"}),
        user_message=_user_message,
        metadata=_metadata,
        env_prefix="DEV_WEB_TASK",
        default_turns=60,
        default_wall_sec=1200,
        default_idle_sec=INSPECTOR_IDLE_SEC_DEFAULT,
        default_tokens=700_000,
        vision_fallback="gemma",
        candidate_ledger_enforce=True,
        require_terminal_tool=False,
    )
