"""v3.25-A: Tool.requires_capabilities + build_registry_for_task 의 frontend-aware 필터.

설계:
- Tool 에 ClassVar `requires_capabilities: frozenset[str]` (default frozenset()).
- build_registry_for_task(task_type, *, frontend_capabilities=None) 가 도구의
  requires 가 frontend 의 capabilities 의 subset 이 아니면 등록 자체에서 제외.
- chat WS frontend = capabilities 명시 안 함 (None 또는 set()) → interactive_approval
  요구 도구 (enter_plan_mode / exit_plan_mode) 자동 제외.
- CLI 같이 user keystroke approval 가능한 frontend = {"interactive_approval"} 명시 →
  enter_plan_mode 노출.
- capability 요구 없는 도구는 항상 등록.
"""
from __future__ import annotations

from secu_agent.agent.tools import build_registry_for_task
from secu_agent.agent.tools.base import Tool
from secu_agent.agent.tools.plan_mode_tools import (
    EnterPlanModeTool, ExitPlanModeTool,
)


# ============================================================
# Tool meta
# ============================================================

def test_tool_default_requires_capabilities_empty():
    """capability 요구 없는 base default — frozenset()."""
    assert Tool.requires_capabilities == frozenset()


def test_enter_plan_mode_requires_interactive_approval():
    assert "interactive_approval" in EnterPlanModeTool.requires_capabilities


def test_exit_plan_mode_requires_interactive_approval():
    """exit 도 enter 와 짝 — capability 없는 frontend 에선 둘 다 제외."""
    assert "interactive_approval" in ExitPlanModeTool.requires_capabilities


# ============================================================
# operator task — chat WS frontend (no capabilities)
# ============================================================

def test_operator_registry_excludes_plan_mode_when_no_capabilities():
    """frontend_capabilities=None (chat WS default) → plan_mode 도구 빠짐."""
    r = build_registry_for_task("operator")
    names = {t.name for t in r.all()}
    assert "enter_plan_mode" not in names
    assert "exit_plan_mode" not in names


def test_operator_registry_excludes_plan_mode_when_empty_capabilities():
    r = build_registry_for_task("operator", frontend_capabilities=set())
    names = {t.name for t in r.all()}
    assert "enter_plan_mode" not in names
    assert "exit_plan_mode" not in names


def test_operator_registry_includes_plan_mode_when_capable():
    """interactive_approval 가능한 frontend (CLI 등) → plan_mode 노출."""
    r = build_registry_for_task(
        "operator", frontend_capabilities={"interactive_approval"},
    )
    names = {t.name for t in r.all()}
    assert "enter_plan_mode" in names
    assert "exit_plan_mode" in names


def test_operator_registry_keeps_capability_free_tools():
    """capability 요구 없는 도구는 양쪽 모두 등록."""
    r_no = build_registry_for_task("operator")
    r_cap = build_registry_for_task(
        "operator", frontend_capabilities={"interactive_approval"},
    )
    base_tools = {
        "skill", "todo", "session_search", "host_read", "host_code_outline", "host_write",
    }
    names_no = {t.name for t in r_no.all()}
    names_cap = {t.name for t in r_cap.all()}
    for n in base_tools:
        assert n in names_no, f"capability-free 도구 {n} 빠짐 (no-cap)"
        assert n in names_cap, f"capability-free 도구 {n} 빠짐 (cap)"


def test_other_task_types_unaffected_by_capability():
    """smb_agent_type / smb_file_triage 등 plan_mode 안 들어있는 task_type 은
    capability 인자 무관 같은 도구셋."""
    for ht in ("smb_agent_type", "smb_file_triage", "smb_share_listing_review"):
        names_no = {t.name for t in build_registry_for_task(ht).all()}
        names_cap = {
            t.name
            for t in build_registry_for_task(
                ht, frontend_capabilities={"interactive_approval"},
            ).all()
        }
        assert names_no == names_cap, f"{ht} 에서 capability 영향 받음"
