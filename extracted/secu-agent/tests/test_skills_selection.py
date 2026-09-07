"""v3.82 U4: per-invocation skill 선택 (-s) — 단일 resolver 가 3개 로드 경로 공통.

계약: names=first-wins dedup 후 필터·미존재=fail-loud, extra_dirs=additive
(core-first fail-safe 유지·교체 금지), 세션 시작 시 고정.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from secu_agent.agent.skills import (
    SkillsSelection,
    build_skills_guidance,
    load_skills_all,
    parse_skills_selection,
    resolve_skills_dirs,
)


def _mk_skill(d: Path, name: str, triggers: str = "") -> None:
    trig = f"triggers: {triggers}\n" if triggers else ""
    (d / f"{name}.md").write_text(
        f"---\nname: {name}\ndescription: 테스트 skill {name}\n"
        f"domain: testdom\nwhen_to_use: 테스트\n{trig}---\n\n# {name}\n본문 {name}\n",
        encoding="utf-8",
    )


def test_parse_selection_names_and_dirs(tmp_path):
    sel = parse_skills_selection([f"alpha,beta", str(tmp_path)])
    assert sel.names == ("alpha", "beta")
    assert sel.extra_dirs == (tmp_path.resolve(),)
    assert parse_skills_selection(None) is None
    assert parse_skills_selection([]) is None
    with pytest.raises(ValueError, match="디렉토리 없음"):
        parse_skills_selection(["/nonexistent/skills_dir/"])


def test_names_filter_after_dedup_and_unknown_fails_loud(tmp_path):
    _mk_skill(tmp_path, "plug_alpha")
    _mk_skill(tmp_path, "plug_beta")
    sel = SkillsSelection(names=("plug_alpha",), extra_dirs=(tmp_path,))
    names = [s.name for s in load_skills_all(selection=sel)]
    assert names == ["plug_alpha"]

    with pytest.raises(ValueError, match="미존재 skill"):
        load_skills_all(selection=SkillsSelection(names=("no_such_skill",)))


def test_extra_dirs_additive_core_first(tmp_path):
    """-s /dir 은 코어 dir 을 교체하지 않는다 — first-wins fail-safe 보존."""
    _mk_skill(tmp_path, "plug_gamma")
    # 코어 skill 과 같은 이름을 외부 dir 에 둬도 코어가 이긴다
    core_names = {s.name for s in load_skills_all()}
    assert "plan_mode" in core_names
    _mk_skill(tmp_path, "plan_mode")  # override 시도
    sel = SkillsSelection(extra_dirs=(tmp_path,))
    loaded = {s.name: s for s in load_skills_all(selection=sel)}
    assert "plug_gamma" in loaded
    core_dir = resolve_skills_dirs()[0]
    assert str(loaded["plan_mode"].path).startswith(str(core_dir))


def test_guidance_respects_selection(tmp_path):
    _mk_skill(tmp_path, "plug_delta")
    sel = SkillsSelection(names=("plug_delta",), extra_dirs=(tmp_path,))
    text = build_skills_guidance(None, selection=sel)
    assert "plug_delta" in text
    assert "plan_mode" not in text  # deselect 된 코어 skill 은 인덱스에서도 제외


def test_trigger_injection_respects_selection(tmp_path):
    """deselect 된 skill 은 trigger 가 맞아도 무음 재주입되지 않는다 (최고위험 지점)."""
    from secu_agent.agent.chat_session import _candidate_skills_for_turn

    _mk_skill(tmp_path, "plug_trig", triggers="아주특이한트리거")
    sel_with = SkillsSelection(extra_dirs=(tmp_path,))
    sel_without = SkillsSelection(names=("plan_mode",))

    hits = _candidate_skills_for_turn("아주특이한트리거 점검해줘", selection=sel_with)
    assert "plug_trig" in hits
    hits2 = _candidate_skills_for_turn("아주특이한트리거 점검해줘", selection=sel_without)
    assert "plug_trig" not in hits2


def test_skill_tool_respects_selection(tmp_path):
    """skill 도구 list/view 도 같은 selection — 인덱스와 불일치 금지."""
    import asyncio

    from secu_agent.agent.tools.base import ToolContext
    from secu_agent.agent.tools.skill_tool import SkillTool

    _mk_skill(tmp_path, "plug_tool")
    sel = SkillsSelection(names=("plug_tool",), extra_dirs=(tmp_path,))
    ctx = ToolContext(evidence_dir=tmp_path, metadata={"skills_selection": sel})
    tool = SkillTool()

    res = asyncio.run(tool.execute(tool.input_model(action="list"), ctx))
    assert "plug_tool" in res.content
    assert "plan_mode" not in res.content

    res2 = asyncio.run(tool.execute(tool.input_model(action="view", name="plug_tool"), ctx))
    assert "본문 plug_tool" in res2.content


def test_skill_tool_metadata_dir_is_additive(tmp_path):
    """구 '교체' 시맨틱 폐기 — metadata['skills_dir'] 가 있어도 코어 skill 이 보인다."""
    import asyncio

    from secu_agent.agent.tools.base import ToolContext
    from secu_agent.agent.tools.skill_tool import SkillTool

    _mk_skill(tmp_path, "plug_extra")
    ctx = ToolContext(evidence_dir=tmp_path, metadata={"skills_dir": str(tmp_path)})
    res = asyncio.run(SkillTool().execute(SkillTool().input_model(action="list"), ctx))
    assert "plug_extra" in res.content
    assert "plan_mode" in res.content  # 코어 dir 이 빠지지 않는다


def test_chat_session_load_threads_selection(tmp_db, tmp_path):
    """ChatSession.load(skills_selection=) → metadata + 시스템 프롬프트 인덱스 반영."""
    from tests.test_chat_session import _FakeLLM  # 기존 fake 재사용

    from secu_agent.agent.chat_session import ChatSession

    _mk_skill(tmp_path, "plug_sess")
    sel = SkillsSelection(names=("plug_sess",), extra_dirs=(tmp_path,))
    sess = ChatSession.load(
        client=_FakeLLM(["ok"]), evidence_dir=tmp_path,
        task_type="operator", skills_selection=sel,
    )
    assert sess.context.metadata["skills_selection"] is sel
    assert "plug_sess" in sess.sys_prompt
    assert "plan_mode" not in sess.sys_prompt
