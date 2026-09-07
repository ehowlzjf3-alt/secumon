"""v3.12-C: system_prompt(task_type, registry=None) — operator 동적 합성.

- operator + registry → operator_core + dispatch_cheat_sheet + tools_section + skills_guidance
- 다른 task_type → 기존 static file (회귀 안전)
- registry 없으면 → 기존 static file (CLI / sub-agent 가 그대로)
"""
from __future__ import annotations

from secu_agent.agent.prompts import system_prompt
from secu_agent.agent.tools import build_registry_for_task


def test_system_prompt_operator_with_registry_includes_core():
    r = build_registry_for_task("operator")
    p = system_prompt("operator", registry=r)
    assert "Samsung DS" in p
    assert "Enterprise Security Agent" in p


def test_system_prompt_operator_with_registry_includes_dispatch_sheet():
    """v3.24: operator = main agent. dispatch sheet 에 main agent 도구들이 있어야.

    de-domain: 도메인 도구(smb_python/domain_report 등)는 plugin 으로 추출됨.
    """
    r = build_registry_for_task("operator")
    p = system_prompt("operator", registry=r)
    assert "agent" in p
    assert "skill" in p
    assert "todo" in p
    assert "session_search" in p


def test_system_prompt_operator_with_registry_includes_tools_section():
    """각 도구의 prompt_section 본문 일부."""
    r = build_registry_for_task("operator")
    p = system_prompt("operator", registry=r)
    # 활성(core) 도구의 prompt_section 본문
    assert "### memory" in p
    assert "### agent" in p or "sub-agent" in p
    # de-domain: 도메인 도구는 registry 에 없어야 한다
    assert "smb_python" not in p
    assert "run_smb_discovery" not in p
    assert "### subnets" not in p


def test_system_prompt_operator_with_registry_includes_skills_guidance():
    r = build_registry_for_task("operator")
    p = system_prompt("operator", registry=r)
    # SKILLS_GUIDANCE — skills 디렉토리에서 자동 inject (v3.26: skill(action='view'))
    assert "skill(action='view'" in p
    # de-domain: 도메인 skill(smb_tasking 등)은 plugin 소유 — 코어 skill 만
    assert "smb_tasking" not in p
    assert "enterprise_security_policy" in p
    assert "워터마크 금지" in p


def test_system_prompt_operator_without_registry_falls_back_to_static():
    """registry 없으면 기존 static system_operator.txt 사용 (회귀 안전)."""
    p = system_prompt("operator")
    assert "Samsung DS" in p
    # 기존 prompt 의 dispatch 치트 시트 한국어 헤더 (static)
    assert "도구 dispatch 치트 시트" in p


def test_system_prompt_non_operator_unchanged_with_registry():
    """operator 아닌 task_type 은 registry 와 무관 — 기존 static prompt."""
    r = build_registry_for_task("finding_narrator")
    p_static = system_prompt("finding_narrator")
    p_with_reg = system_prompt("finding_narrator", registry=r)
    assert p_static == p_with_reg


def test_system_prompt_operator_compose_under_size_budget():
    """operator 동적 합성 — 합쳐도 너무 크지 않아야 (LLM context 절약).

    엄격하진 않게 — runaway 방지 sanity check 만. de-domain 으로 도메인
    풀 도구셋이 빠져 코어 ~수만자 규모. 상한은 명백한 폭주만 잡는 느슨한 가드.
    """
    r = build_registry_for_task("operator")
    p = system_prompt("operator", registry=r)
    assert 1000 <= len(p) <= 28_000


def test_operator_core_file_exists():
    """v3.12-C: operator_core.txt 가 prompts/ 에 있고 짧다 (50줄 이하)."""
    from pathlib import Path
    f = Path(__file__).resolve().parent.parent / "src" / "secu_agent" / "agent" / "prompts" / "operator_core.txt"
    assert f.exists()
    body = f.read_text()
    # 정체성 + 추론원칙. 도구 dispatch / 도구별 사용법 / skill 본문 은 여기 없어야 (자동 합성).
    assert "Samsung DS" in body
    assert "기업 보안 전반" in body
    assert "워터마크 금지" in body
    assert "SMB 작업 시작 전 반드시" not in body
    assert "### run_smb_discovery" not in body  # 도구 섹션은 동적
    assert "## Skills (on-demand" not in body  # skills 섹션도 동적
    lines = body.splitlines()
    assert len(lines) <= 100, f"operator_core 너무 길다: {len(lines)} 줄"


def test_generic_fallback_prompt_stays_domain_neutral():
    p = system_prompt("unknown_task_type")
    forbidden = (
        "smb_enum",
        "smb_fetch",
        "gh_fetch",
        "jenkins_fetch",
        "confluence_fetch",
        "web_crawl",
        "web_vuln_probe",
    )
    assert not any(term in p for term in forbidden)
    assert "도메인별 API" in p
