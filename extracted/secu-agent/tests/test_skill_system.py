"""v3.12-B: Skill system — skills/ 디렉토리 + SKILL.md frontmatter + Skill 도구.

운영팀이 markdown 만으로 새 패턴 추가 가능. LLM on-demand `skill_view` 로 로드.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


SAMPLE_SKILL = """\
---
name: sample_skill
description: 테스트용 샘플 skill — 짧은 설명
domain: smb
when_to_use: SMB task 시작할 때, share lifecycle 헷갈릴 때
triggers: smb, share lifecycle
---

# sample_skill

## share lifecycle
- pending → walked → listing_reviewed
- pending 인 share 는 walk 먼저, review 불가.

## 후속 도구
- run_smb_walk: pending → walked
- run_smb_review: walked → listing_reviewed
"""

NO_FRONTMATTER_SKILL = """\
이건 frontmatter 없는 markdown — 거부되어야 함.
"""

WRONG_NAME_SKILL = """\
---
name: wrong_name
description: 이 skill 의 file 이름이 frontmatter name 과 안 맞음
domain: core
---

본문
"""


@pytest.fixture
def skills_dir(tmp_path: Path) -> Path:
    """test 용 skills 디렉토리. SKILL.md 파일 하나 + 깡 markdown 하나."""
    d = tmp_path / "skills"
    d.mkdir()
    (d / "sample_skill.md").write_text(SAMPLE_SKILL)
    return d


def _ctx(tmp_path: Path, skills_dir: Path | None = None) -> ToolContext:
    md = {}
    if skills_dir is not None:
        md["skills_dir"] = str(skills_dir)
    return ToolContext(evidence_dir=tmp_path, metadata=md)


# ─── skill loader ─────────────────────────────────────────────────


def test_skill_loader_lists_skills(skills_dir):
    from secu_agent.agent.skills import load_skills
    skills = load_skills(skills_dir)
    assert len(skills) == 1
    s = skills[0]
    assert s.name == "sample_skill"
    assert "share lifecycle" in s.body.lower()
    assert s.domain == "smb"
    assert "share lifecycle" in s.when_to_use
    assert s.triggers == ("smb", "share lifecycle")


def test_skill_loader_skips_missing_frontmatter(tmp_path):
    from secu_agent.agent.skills import load_skills
    d = tmp_path / "skills"
    d.mkdir()
    (d / "bad.md").write_text(NO_FRONTMATTER_SKILL)
    skills = load_skills(d)
    assert skills == []


def test_skill_loader_skips_name_mismatch(tmp_path):
    from secu_agent.agent.skills import load_skills
    d = tmp_path / "skills"
    d.mkdir()
    # file 이름 wrong_file.md 이지만 frontmatter name=wrong_name
    (d / "wrong_file.md").write_text(WRONG_NAME_SKILL)
    skills = load_skills(d)
    # 우리 정책: file basename (확장자 빼고) 가 frontmatter name 과 일치해야 함.
    assert skills == []


def test_skill_loader_returns_empty_for_missing_dir(tmp_path):
    from secu_agent.agent.skills import load_skills
    assert load_skills(tmp_path / "nonexistent") == []


def test_skill_loader_filters_by_domain(skills_dir):
    from secu_agent.agent.skills import load_skills
    only_smb = load_skills(skills_dir, domain="smb")
    only_github = load_skills(skills_dir, domain="github")
    assert len(only_smb) == 1
    assert only_github == []


# ─── SKILLS_GUIDANCE 합성 ────────────────────────────────────────


def test_skills_guidance_text_lists_available(skills_dir):
    from secu_agent.agent.skills import build_skills_guidance
    text = build_skills_guidance(skills_dir)
    assert "sample_skill" in text
    assert "테스트용 샘플" in text
    # LLM 에게 어떻게 로드하는지 알려줌 (v3.26: skill(action='view', name=...))
    assert "skill(action='view'" in text


def test_skills_guidance_empty_when_no_skills(tmp_path):
    from secu_agent.agent.skills import build_skills_guidance
    d = tmp_path / "empty_skills"
    d.mkdir()
    text = build_skills_guidance(d)
    assert text == ""


# ─── Skill 도구 ──────────────────────────────────────────────────


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_skill_tool_list(skills_dir, tmp_path):
    from secu_agent.agent.tools.skill_tool import SkillTool
    res = _run(SkillTool(), {"action": "list"},
               _ctx(tmp_path, skills_dir=skills_dir))
    assert isinstance(res, ToolSuccess)
    assert "sample_skill" in res.content
    assert "테스트용 샘플" in res.content


def test_skill_tool_view(skills_dir, tmp_path):
    from secu_agent.agent.tools.skill_tool import SkillTool
    res = _run(SkillTool(), {"action": "view", "name": "sample_skill"},
               _ctx(tmp_path, skills_dir=skills_dir))
    assert isinstance(res, ToolSuccess)
    assert "share lifecycle" in res.content.lower()
    assert "run_smb_walk" in res.content


def test_skill_view_dedup_same_session(skills_dir, tmp_path):
    """v3.34-C: 같은 ctx (즉 같은 session) 안에서 같은 skill view 두 번째는 짧은 reminder."""
    from secu_agent.agent.tools.skill_tool import SkillTool
    ctx = _ctx(tmp_path, skills_dir=skills_dir)
    first = _run(SkillTool(), {"action": "view", "name": "sample_skill"}, ctx)
    assert isinstance(first, ToolSuccess)
    assert "share lifecycle" in first.content.lower()  # full body
    second = _run(SkillTool(), {"action": "view", "name": "sample_skill"}, ctx)
    assert isinstance(second, ToolSuccess)
    assert "이미 본 skill" in second.content
    # full body 재인쇄 안 됨 — 짧음
    assert len(second.content) < 200


def test_skill_view_dedup_different_session(skills_dir, tmp_path):
    """v3.34-C: 다른 ctx (즉 다른 session) 면 dedup 안 됨 — 둘 다 full body."""
    from secu_agent.agent.tools.skill_tool import SkillTool
    ctx1 = _ctx(tmp_path, skills_dir=skills_dir)
    ctx2 = _ctx(tmp_path, skills_dir=skills_dir)
    r1 = _run(SkillTool(), {"action": "view", "name": "sample_skill"}, ctx1)
    r2 = _run(SkillTool(), {"action": "view", "name": "sample_skill"}, ctx2)
    assert "이미 본 skill" not in r1.content
    assert "이미 본 skill" not in r2.content


def test_skill_tool_view_not_found(skills_dir, tmp_path):
    from secu_agent.agent.tools.skill_tool import SkillTool
    res = _run(SkillTool(), {"action": "view", "name": "no_such"},
               _ctx(tmp_path, skills_dir=skills_dir))
    assert isinstance(res, ToolError)
    assert res.kind == "not_found"
    assert "available skills" in res.message
    assert "sample_skill" in res.message


def test_skill_tool_view_requires_name(skills_dir, tmp_path):
    from secu_agent.agent.tools.skill_tool import SkillTool
    res = _run(SkillTool(), {"action": "view"},
               _ctx(tmp_path, skills_dir=skills_dir))
    assert isinstance(res, ToolError)
    assert res.kind == "validation"


def test_skill_tool_no_skills_dir_metadata(tmp_path):
    """metadata 에 skills_dir 없으면 — fallback 으로 패키지 기본 skills 디렉토리."""
    from secu_agent.agent.tools.skill_tool import SkillTool
    res = _run(SkillTool(), {"action": "list"}, _ctx(tmp_path))
    # 기본 디렉토리는 비어있을 수 있음 — 어쨌든 ToolSuccess (목록 비어있어도 OK)
    assert isinstance(res, ToolSuccess)


def test_skill_tool_has_domain_core():
    """Skill 도구 자체 — 도메인 무관 core."""
    from secu_agent.agent.tools.skill_tool import SkillTool
    assert SkillTool.domain == "core"
    assert SkillTool.dispatch_keywords  # 비어있지 않음
