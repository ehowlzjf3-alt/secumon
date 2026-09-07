"""v3.76: finding_narrator subagent — agent def 로드 + 레지스트리 readonly/enrich + operator enrich."""
from __future__ import annotations

from secu_agent.agent.agents import get_agent
from secu_agent.agent.tools import build_registry_for_task


def _names(reg) -> set[str]:
    return {t.name for t in reg.all()}


def test_narrator_agent_def_loads():
    a = get_agent("finding_narrator")
    assert a is not None
    assert a.task_type == "finding_narrator"
    assert "finding_ids" in a.input_keys
    assert "[DEPRECATED" not in a.description


def test_narrator_registry_has_enrich_no_write_tools():
    reg = build_registry_for_task("finding_narrator")
    names = _names(reg)
    assert "enrich_finding" in names
    # read tools present
    assert "session_search" in names
    # write/probe/new-finding tools must NOT be exposed
    for forbidden in (
        "submit_finding", "web_task_scan", "web_site_sweep", "browser_action",
        "browser_query", "scan_text", "github_task_scan", "confluence_task_scan",
    ):
        assert forbidden not in names, f"{forbidden} must not be in narrator registry"


def test_operator_registry_has_enrich_finding():
    reg = build_registry_for_task("operator")
    assert "enrich_finding" in _names(reg)


def test_cli_supports_finding_narrator_prompt():
    """system_prompt(finding_narrator) 가 전용 narrator 프롬프트를 반환 (generic 폴백 아님)."""
    from secu_agent.agent.prompts import system_prompt

    p = system_prompt("finding_narrator")
    assert "finding_narrator" in p
    assert "enrich_finding" in p
