"""session_search 코어 도구 — cross-session 패턴 인지."""
from __future__ import annotations

import service.state_domain as sd

import asyncio
from pathlib import Path


def _ctx(metadata: dict, tmp_path: Path | None = None):
    from secu_agent.agent.tools.base import ToolContext
    return ToolContext(evidence_dir=tmp_path or Path("/tmp"), metadata=metadata)


def _invoke(tool, raw_input: dict, ctx):
    from secu_agent.agent.tools.base import ToolError
    from pydantic import ValidationError
    try:
        validated = type(tool).input_model.model_validate(raw_input)
    except ValidationError as e:
        return ToolError(kind="validation", message=str(e))
    return asyncio.run(tool.execute(validated, ctx))


def test_session_search_returns_other_share_findings(tmp_db, seed, tmp_path):
    """master 가 다른 share 의 관련 finding 검색 — 자기 share 는 자동 제외."""
    from secu_agent import state
    from secu_agent.agent.tools.base import ToolSuccess
    from secu_agent.agent.tools.session_search_tool import SessionSearchTool

    s_mine = seed.share(host="1.1.1.1", share="MINE")
    s_other = seed.share(host="2.2.2.2", share="OTHER")

    f_mine = seed.file(s_mine, path="정유준님/A.xlsx")
    f_other = seed.file(s_other, path="정유준님/B.xlsx")
    sd.file_set_review(f_mine, severity="high",
                          summary="정유준님 폴더 칩 설계",
                          tags=[], note=None)
    sd.file_set_review(f_other, severity="high",
                          summary="정유준님 폴더 회로 데이터",
                          tags=[], note=None)

    tool = SessionSearchTool()
    ctx = _ctx({"master_share_id": s_mine}, tmp_path=tmp_path)
    result = _invoke(tool, {"query": "정유준"}, ctx)

    assert isinstance(result, ToolSuccess), getattr(result, "message", result)
    # 자기 share 제외 → other 만
    assert "OTHER" in result.content or str(s_other) in result.content
    # 자기 share id 가 결과에 안 들어가야
    assert f"share_id={s_mine}" not in result.content


def test_session_search_no_results_friendly(tmp_db, seed, tmp_path):
    from secu_agent.agent.tools.base import ToolSuccess
    from secu_agent.agent.tools.session_search_tool import SessionSearchTool

    sid = seed.share(host="1.1.1.1", share="A")
    result = _invoke(SessionSearchTool(),
                     {"query": "전혀_매칭_없는_문자열_xyz"},
                     _ctx({"master_share_id": sid}, tmp_path=tmp_path))
    assert isinstance(result, ToolSuccess)
    assert "no" in result.content.lower() or "없음" in result.content


def test_session_search_kind_filter(tmp_db, seed, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.base import ToolSuccess
    from secu_agent.agent.tools.session_search_tool import SessionSearchTool

    s_mine = seed.share(host="1.1.1.1", share="MINE")
    s_other = seed.share(host="2.2.2.2", share="OTHER")
    f_other = seed.file(s_other, path="x")
    sd.file_set_review(f_other, severity="medium",
                          summary="AWS access key 발견",
                          tags=[], note=None)
    state.memory_add(scope="global", key="*",
                     rule="AWS access key 발견 시 owner 통보")

    tool = SessionSearchTool()
    ctx = _ctx({"master_share_id": s_mine}, tmp_path=tmp_path)
    rmem = _invoke(tool, {"query": "AWS access key", "kind": "memory_rule"}, ctx)
    assert isinstance(rmem, ToolSuccess)
    assert "memory_rule" in rmem.content
    assert "file_review" not in rmem.content

    rfile = _invoke(tool, {"query": "AWS access key", "kind": "file_review"}, ctx)
    assert isinstance(rfile, ToolSuccess)
    assert "file_review" in rfile.content


def test_session_search_registered_in_core_registries(tmp_db):
    from secu_agent.agent.tools import build_registry_for_task
    for ht in ("operator", "finding_narrator"):
        r = build_registry_for_task(ht)
        names = {t.name for t in r.all()}
        assert "session_search" in names, ht


def test_session_search_validation_kind(tmp_db, seed, tmp_path):
    from secu_agent.agent.tools.base import ToolError
    from secu_agent.agent.tools.session_search_tool import SessionSearchTool

    sid = seed.share(host="1.1.1.1", share="A")
    result = _invoke(SessionSearchTool(),
                     {"query": "x", "kind": "bogus"},
                     _ctx({"master_share_id": sid}, tmp_path=tmp_path))
    assert isinstance(result, ToolError)
