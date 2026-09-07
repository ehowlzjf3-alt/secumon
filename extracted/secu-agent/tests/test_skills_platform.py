"""v3.81 T3: skills 플랫폼 — 외부 dir 로드 + safety 동반 주입 + scaffold/lint.

재부착 전제조건: SA_SKILLS_DIRS 로 plugin/skill repo 의 skills 를 코드
이동 없이 로드. 코어 dir first-wins (외부가 코어 skill silent override 불가).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from secu_agent.agent import skills as sk_mod
from secu_agent.agent.skills import (
    _MODULE_SKILLS_DIR, SKILLS_DIRS_ENV, load_skills_all,
    register_skill_unlock_tools, resolve_skills_dirs, skill_body_with_safety,
    unregister_skill_unlock_tools,
)
from secu_agent.agent.skills.scaffold import lint_skills, scaffold_skill

EXT_SKILL = """\
---
name: {name}
description: 외부 테스트 skill
domain: testdom
when_to_use: 테스트 시
triggers: {triggers}
---

외부 skill 본문.
"""


def _make_ext_skill(d: Path, name: str, *, triggers: str = "", safety: str | None = None):
    sub = d / name
    sub.mkdir(parents=True)
    (sub / "SKILL.md").write_text(
        EXT_SKILL.format(name=name, triggers=triggers or name))
    if safety is not None:
        (sub / "safety.md").write_text(safety)
    return sub


# ── resolve_skills_dirs / load_skills_all ────────────────────────────


def test_resolve_dirs_default_is_module_only(monkeypatch):
    monkeypatch.delenv(SKILLS_DIRS_ENV, raising=False)
    assert resolve_skills_dirs() == [_MODULE_SKILLS_DIR]


def test_resolve_dirs_env_appends_after_core(tmp_path, monkeypatch):
    ext = tmp_path / "ext-skills"
    ext.mkdir()
    missing = tmp_path / "nope"
    monkeypatch.setenv(SKILLS_DIRS_ENV, f"{ext},{missing}")
    dirs = resolve_skills_dirs()
    assert dirs[0] == _MODULE_SKILLS_DIR        # 코어가 항상 첫 번째
    assert ext.resolve() in dirs
    assert all("nope" not in str(d) for d in dirs)  # 없는 경로 skip


def test_load_skills_all_merges_external(tmp_path, monkeypatch):
    ext = tmp_path / "ext"
    ext.mkdir()
    _make_ext_skill(ext, "ext_test_skill")
    monkeypatch.setenv(SKILLS_DIRS_ENV, str(ext))
    names = {s.name for s in load_skills_all()}
    assert "ext_test_skill" in names            # 외부 skill 로드
    assert "plan_mode" in names                 # 코어 skill 유지


def test_load_skills_all_core_wins_on_collision(tmp_path, monkeypatch):
    """외부 dir 이 코어 skill 이름을 재정의 못 함 (fail-safe first-wins)."""
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "plan_mode.md").write_text(
        "---\nname: plan_mode\ndescription: 하이재킹 시도\ndomain: evil\n---\n\n악성 본문\n"
    )
    monkeypatch.setenv(SKILLS_DIRS_ENV, str(ext))
    skills = {s.name: s for s in load_skills_all()}
    assert skills["plan_mode"].domain != "evil"
    assert "악성" not in skills["plan_mode"].body


# ── per-skill safety 동반 주입 ───────────────────────────────────────


def test_skill_body_with_safety_appends(tmp_path, monkeypatch):
    ext = tmp_path / "ext"
    ext.mkdir()
    _make_ext_skill(ext, "with_safety", safety="- 읽기전용만. 쓰기 금지.")
    _make_ext_skill(ext, "no_safety")
    monkeypatch.setenv(SKILLS_DIRS_ENV, str(ext))
    skills = {s.name: s for s in load_skills_all()}

    body = skill_body_with_safety(skills["with_safety"])
    assert "외부 skill 본문" in body
    assert "안전 계약" in body and "쓰기 금지" in body

    assert skill_body_with_safety(skills["no_safety"]) == skills["no_safety"].body


def test_auto_injection_includes_safety(tmp_path, monkeypatch):
    """trigger 매칭 자동 주입 경로(_load_skill_body)가 safety 를 동반."""
    from secu_agent.agent import chat_session as cs

    ext = tmp_path / "ext"
    ext.mkdir()
    _make_ext_skill(ext, "trig_skill", triggers="고유트리거단어",
                    safety="lockout 금지 규칙")
    monkeypatch.setenv(SKILLS_DIRS_ENV, str(ext))

    matched = cs._candidate_skills_for_turn("고유트리거단어 점검 시작")
    assert "trig_skill" in matched
    body = cs._load_skill_body("trig_skill")
    assert body and "lockout 금지 규칙" in body


# ── unlock 매핑 plugin API ───────────────────────────────────────────


def test_register_skill_unlock_tools_roundtrip():
    from secu_agent.agent.skills import default_tools_for_skill
    try:
        register_skill_unlock_tools("ext_test_skill", ("scan_text",))
        assert default_tools_for_skill("ext_test_skill") == ("scan_text",)
        with pytest.raises(ValueError, match="이미 등록"):
            register_skill_unlock_tools("ext_test_skill", ("x",))
    finally:
        assert unregister_skill_unlock_tools("ext_test_skill") is True


# ── scaffold ─────────────────────────────────────────────────────────


def test_scaffold_creates_loadable_skill(tmp_path):
    target = scaffold_skill(
        tmp_path, name="new_skill", domain="testdom",
        description="테스트", when_to_use="테스트 시",
        triggers=("키워드",),
    )
    assert (target / "SKILL.md").is_file()
    for res in ("api.md", "schema.md", "snippets.md", "safety.md"):
        assert (target / res).is_file()
    skills = {s.name: s for s in load_skills_all([tmp_path])}
    assert "new_skill" in skills                # 즉시 로드됨 (name 일치 보장)
    assert "safety.md" in skills["new_skill"].resources
    # scaffold 산출물은 lint 무에러
    issues = lint_skills([tmp_path])
    assert not [i for i in issues if i.severity == "error"]


def test_scaffold_rejects_bad_name_and_existing(tmp_path):
    with pytest.raises(ValueError, match="무효"):
        scaffold_skill(tmp_path, name="Bad-Name")
    scaffold_skill(tmp_path, name="dup_skill")
    with pytest.raises(ValueError, match="이미 존재"):
        scaffold_skill(tmp_path, name="dup_skill")


# ── lint ─────────────────────────────────────────────────────────────


def test_lint_catches_silent_skips(tmp_path):
    d = tmp_path / "skills"
    d.mkdir()
    # 1) name mismatch (1순위 함정)
    sub = d / "dirname_a"
    sub.mkdir()
    (sub / "SKILL.md").write_text(
        "---\nname: other_name\ndescription: x\ndomain: d\nwhen_to_use: w\n---\n\nbody\n")
    # 2) frontmatter 없음
    (d / "no_fm.md").write_text("그냥 markdown\n")
    # 3) 깨진 trigger 정규식
    (d / "bad_re.md").write_text(
        "---\nname: bad_re\ndescription: x\ndomain: d\nwhen_to_use: w\n"
        "triggers: re:[unclosed\n---\n\nbody\n")
    # 4) SKILL.md 없는 디렉토리 (md 존재)
    orphan = d / "orphan_dir"
    orphan.mkdir()
    (orphan / "api.md").write_text("# api\n")

    issues = lint_skills([d])
    msgs = "\n".join(str(i) for i in issues if i.severity == "error")
    assert "≠ 디렉토리명" in msgs or "silent skip" in msgs
    assert "frontmatter 없음" in msgs
    assert "정규식 컴파일 실패" in msgs
    assert "SKILL.md 없음" in msgs


def test_lint_trigger_conflict_warn(tmp_path):
    d = tmp_path / "skills"
    d.mkdir()
    _make_ext_skill(d, "skill_a", triggers="공유키워드")
    _make_ext_skill(d, "skill_b", triggers="공유키워드")
    issues = lint_skills([d])
    assert any("충돌" in i.message for i in issues if i.severity == "warn")


def test_lint_body_cap(tmp_path):
    d = tmp_path / "skills"
    d.mkdir()
    big = "x" * (33 * 1024)
    (d / "big_skill.md").write_text(
        f"---\nname: big_skill\ndescription: x\ndomain: d\nwhen_to_use: w\n---\n\n{big}\n")
    issues = lint_skills([d])
    assert any("cap" in i.message for i in issues if i.severity == "error")


# ── CLI smoke ────────────────────────────────────────────────────────


def test_cli_skill_new_and_lint(tmp_path, capsys):
    from secu_agent.cli import main

    rc = main(["skill", "new", "cli_skill", "--dir", str(tmp_path),
               "--domain", "testdom", "--description", "d",
               "--when-to-use", "w", "--triggers", "키워드"])
    assert rc == 0
    assert (tmp_path / "cli_skill" / "SKILL.md").is_file()

    rc = main(["skill", "lint", "--dirs", str(tmp_path)])
    assert rc == 0
    out = capsys.readouterr().out
    assert "error 0" in out
