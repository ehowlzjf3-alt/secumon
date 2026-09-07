"""v3.26-A: directory-based skill (Anthropic Skill 패턴).

설계:
- single-file skill 호환: `<name>.md` 그대로 (frontmatter + body, file basename == name)
- directory skill: `<name>/SKILL.md` (frontmatter + entry body) + 추가 `.md` resources
- view 동작:
    - resource=None → SKILL.md (또는 single-file) body inline. 이건 stash 거치지 않게
      도구가 size cap 자체 처리 (cap 안에 들면 그대로 통과).
    - resource="api.md" → directory skill 의 추가 docs body. path safety.
- list: directory skill 은 resources 목록도 표시.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


SKILL_MD = """\
---
name: smb_tasking
description: SMB tasking reference
domain: smb
when_to_use: SMB 점검 시작 시
---

# smb_tasking entry

대표 패턴: enumerate_hosts → walk → fetch → scan → persist.

상세는 resources 참고:
- api.md — smb / state 모듈 API
- schema.md — DB schema
- snippets.md — 스니펫 카탈로그
"""

API_MD = """\
# smb 모듈 API

- enumerate_hosts(subnet) → list[str] (alive hosts, TCP 445)
- list_shares_modes(host) → SmbHostShares
- walk_share(host, share, max_files=200) → iterator[SmbFile]
"""

SCHEMA_MD = """\
# DB schema

- smb_share (id, host, share, status, ...)
- smb_file (id, share_id, path, size, ...)
"""

SINGLE_FILE_SKILL = """\
---
name: plan_mode
description: plan mode 사용법
domain: core
---

# plan_mode

heavy batch 전 사용.
"""


@pytest.fixture
def mixed_dir(tmp_path: Path) -> Path:
    """directory + single-file skill 둘 다."""
    d = tmp_path / "skills"
    d.mkdir()
    # directory skill
    sd = d / "smb_tasking"
    sd.mkdir()
    (sd / "SKILL.md").write_text(SKILL_MD)
    (sd / "api.md").write_text(API_MD)
    (sd / "schema.md").write_text(SCHEMA_MD)
    # single-file skill
    (d / "plan_mode.md").write_text(SINGLE_FILE_SKILL)
    return d


def _ctx(tmp_path: Path, skills_dir: Path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path,
                       metadata={"skills_dir": str(skills_dir)})


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


# ============================================================
# loader
# ============================================================

def test_load_skills_picks_up_both_styles(mixed_dir):
    from secu_agent.agent.skills import load_skills
    skills = load_skills(mixed_dir)
    names = {s.name for s in skills}
    assert names == {"smb_tasking", "plan_mode"}


def test_directory_skill_has_resources(mixed_dir):
    from secu_agent.agent.skills import load_skills
    skills = {s.name: s for s in load_skills(mixed_dir)}
    smb = skills["smb_tasking"]
    assert set(smb.resources) == {"api.md", "schema.md"}
    # body 는 SKILL.md 본문
    assert "enumerate_hosts" in smb.body


def test_single_file_skill_has_empty_resources(mixed_dir):
    from secu_agent.agent.skills import load_skills
    skills = {s.name: s for s in load_skills(mixed_dir)}
    plan = skills["plan_mode"]
    assert plan.resources == ()
    assert "heavy batch" in plan.body


def test_directory_skill_name_must_match_dir(tmp_path):
    """`<dir_name>/SKILL.md` 의 frontmatter name 은 dir basename 과 일치해야."""
    from secu_agent.agent.skills import load_skills
    d = tmp_path / "skills"
    d.mkdir()
    sd = d / "smb_tasking"
    sd.mkdir()
    (sd / "SKILL.md").write_text(SKILL_MD.replace(
        "name: smb_tasking", "name: mismatch"))
    assert load_skills(d) == []


def test_loader_ignores_directory_without_skill_md(tmp_path):
    """`<name>/` 안에 SKILL.md 없으면 skip."""
    from secu_agent.agent.skills import load_skills
    d = tmp_path / "skills"
    d.mkdir()
    (d / "broken").mkdir()
    (d / "broken" / "api.md").write_text("# orphan")
    assert load_skills(d) == []


# ============================================================
# SkillTool view — entry + resource
# ============================================================

def test_skill_tool_view_returns_entry_body_inline(mixed_dir, tmp_path):
    """기본 view 는 entry body 만, stash 거치지 않게 그대로 inline 반환."""
    from secu_agent.agent.tools.skill_tool import SkillTool
    res = _run(SkillTool(), {"action": "view", "name": "smb_tasking"},
               _ctx(tmp_path, mixed_dir))
    assert isinstance(res, ToolSuccess)
    assert "enumerate_hosts" in res.content
    # entry 안에서 resources 카탈로그도 보임
    assert "api.md" in res.content
    # stash 시그니처 (file path) 없어야 — 직접 inline 통과
    assert "결과 크기" not in res.content
    assert "컨텍스트 절약" not in res.content


def test_skill_tool_view_unlocks_default_tools(mixed_dir, tmp_path, monkeypatch):
    """unlock 메커니즘 검증 — 매핑 테이블은 plugin 소유라 모킹 (de-domain)."""
    from secu_agent.agent import skills as skills_mod
    from secu_agent.agent.tools import build_registry_for_task
    from secu_agent.agent.tools.skill_tool import SkillTool

    monkeypatch.setattr(
        skills_mod, "_DEFAULT_UNLOCK_TOOLS_BY_SKILL",
        {"smb_tasking": ("python_exec", "bash_evidence")},
    )
    ctx = _ctx(tmp_path, mixed_dir)
    ctx.registry = build_registry_for_task("operator")

    res = _run(SkillTool(), {"action": "view", "name": "smb_tasking"}, ctx)

    assert isinstance(res, ToolSuccess)
    assert "python_exec" in ctx.unlocked_tools
    assert "bash_evidence" in ctx.unlocked_tools
    assert "[auto-loaded tools]" in res.content


def test_skill_tool_view_resource(mixed_dir, tmp_path):
    """resource='api.md' → 그 파일 body 반환."""
    from secu_agent.agent.tools.skill_tool import SkillTool
    res = _run(SkillTool(),
               {"action": "view", "name": "smb_tasking", "resource": "api.md"},
               _ctx(tmp_path, mixed_dir))
    assert isinstance(res, ToolSuccess)
    assert "list_shares_modes" in res.content
    assert "walk_share" in res.content


def test_skill_tool_view_resource_not_found(mixed_dir, tmp_path):
    from secu_agent.agent.tools.skill_tool import SkillTool
    res = _run(SkillTool(),
               {"action": "view", "name": "smb_tasking",
                "resource": "ghost.md"},
               _ctx(tmp_path, mixed_dir))
    assert isinstance(res, ToolError)
    assert res.kind == "not_found"


def test_skill_tool_resource_rejects_path_escape(mixed_dir, tmp_path):
    """resource 가 `../` 또는 absolute 면 path_escape 거부."""
    from secu_agent.agent.tools.skill_tool import SkillTool
    for bad in ("../api.md", "/etc/passwd", "subdir/../api.md",
                "..\\api.md"):
        res = _run(SkillTool(),
                   {"action": "view", "name": "smb_tasking",
                    "resource": bad},
                   _ctx(tmp_path, mixed_dir))
        assert isinstance(res, ToolError), f"escape '{bad}' 통과됨"
        assert res.kind in ("path_escape", "validation"), f"escape '{bad}'"


def test_skill_tool_resource_on_single_file_skill(mixed_dir, tmp_path):
    """single-file skill 에 resource 인자 주면 validation 에러."""
    from secu_agent.agent.tools.skill_tool import SkillTool
    res = _run(SkillTool(),
               {"action": "view", "name": "plan_mode",
                "resource": "anything.md"},
               _ctx(tmp_path, mixed_dir))
    assert isinstance(res, ToolError)


# ============================================================
# list — resources 표시
# ============================================================

def test_skill_tool_list_shows_resources(mixed_dir, tmp_path):
    from secu_agent.agent.tools.skill_tool import SkillTool
    res = _run(SkillTool(), {"action": "list"},
               _ctx(tmp_path, mixed_dir))
    assert isinstance(res, ToolSuccess)
    # directory skill 의 resources 가 보여야 함
    assert "smb_tasking" in res.content
    # resources 목록 — api.md / schema.md 둘 다 노출
    assert "api.md" in res.content
    assert "schema.md" in res.content
    # single-file skill 은 resources 표시 X
    assert "plan_mode" in res.content


# ============================================================
# engine 가 skill 결과를 stash 하지 않게
# ============================================================

def test_skill_tool_in_no_stash_set():
    """no-stash 집합에 'skill' 포함 — view 본문 그대로 inline 통과."""
    from secu_agent.agent.engine import no_stash_tools
    assert "skill" in no_stash_tools()
