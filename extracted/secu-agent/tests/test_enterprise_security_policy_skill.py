from __future__ import annotations

from pathlib import Path


def test_enterprise_security_policy_skill_is_registered():
    from secu_agent.agent.skills import load_skills

    skills = {s.name: s for s in load_skills(Path("src/secu_agent/agent/skills"))}

    assert "enterprise_security_policy" in skills
    assert "secops_policy" not in skills
    assert skills["enterprise_security_policy"].domain == "core"


def test_enterprise_security_policy_mentions_common_agent_principles():
    body = Path(
        "src/secu_agent/agent/skills/enterprise_security_policy.md"
    ).read_text(encoding="utf-8")

    assert "기업 보안 전반" in body
    assert "도메인별 절차는 각 skill 또는 sub-agent로 분리" in body
    assert "워터마크" in body
    assert "deterministic contract" in body
