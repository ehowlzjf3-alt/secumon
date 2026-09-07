"""dev_web 커버리지 게이트: 마킹 래퍼(생산자)와 submit 게이트(소비자)가 같은 층·같은 키.

## 배경 (2026-08-20)

`dev_web_submit_finding` 은 `_dev_web_browser_deep_dive_seen` 이 없으면 제출을 거부한다.
그 플래그를 세우는 래퍼 3종은 **워커 진입점 함수 안의 지역 클래스**로 살고 있었다
(`service/agents/dev_web_task_agent.py::_tool_classes`). 생산자와 소비자가 다른 층에서
각자 문자열 리터럴을 들고 있으면, 한쪽만 바뀔 때 게이트가 조용히 **항상-거부**(제출 0건)
또는 **항상-통과**(증거 없는 보고)가 된다. 둘 다 에러 없이 조용하다.

래퍼를 `domains/dev_web/plugin/tools/dev_web_coverage_tools.py` 로 옮기고 키를 그 모듈이
소유하게 했다. 이 테스트는 그 배선이 유지되는지 본다.
"""
from __future__ import annotations

import asyncio
import inspect
from typing import Any

from secu_agent.agent.tools.base import ToolContext, ToolSuccess

from domains.dev_web.plugin.tools.dev_web_coverage_tools import (
    BROWSER_DEEP_DIVE_KEY,
    SAW_SITE_SWEEP_KEY,
    DevWebBrowserQueryTool,
    DevWebBrowseWorkerTool,
    DevWebSiteSweepTool,
    mark_deep_dive,
    mark_site_sweep,
)


def _ctx(tmp_path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path, metadata={})


# ── 순서가 증거다 ────────────────────────────────────────────────────────


def test_deep_dive_does_not_mark_without_a_prior_sweep(tmp_path) -> None:
    """★ 스윕 없이 화면만 본 것은 deep-dive 로 인정하지 않는다."""
    ctx = _ctx(tmp_path)
    mark_deep_dive(ctx)
    assert BROWSER_DEEP_DIVE_KEY not in ctx.metadata


def test_deep_dive_marks_after_a_sweep(tmp_path) -> None:
    ctx = _ctx(tmp_path)
    mark_site_sweep(ctx)
    mark_deep_dive(ctx)
    assert ctx.metadata[SAW_SITE_SWEEP_KEY] is True
    assert ctx.metadata[BROWSER_DEEP_DIVE_KEY] is True


# ── 생산자/소비자 키 일치 ────────────────────────────────────────────────


def test_submit_gate_reads_the_key_the_wrappers_write() -> None:
    """★ 문자열을 양쪽이 각자 들고 있으면 안 된다 — 게이트가 조용히 무력화된다."""
    from domains.dev_web.plugin.tools import dev_web_submit_finding_tool as sub

    src = inspect.getsource(sub)
    assert "BROWSER_DEEP_DIVE_KEY" in src, "게이트가 공유 상수를 쓰지 않는다"
    assert '"_dev_web_browser_deep_dive_seen"' not in src, (
        "게이트가 키 문자열을 다시 하드코딩했다 — 단일 진실원이 깨졌다"
    )


# ── 래퍼가 도구 이름을 바꾸지 않는다 ─────────────────────────────────────


def test_wrappers_keep_the_contract_tool_names() -> None:
    """이름이 바뀌면 skill 계약(worker.md)이 가리키는 도구가 사라진다."""
    assert DevWebSiteSweepTool.name == "web_site_sweep"
    assert DevWebBrowseWorkerTool.name == "dev_web_browse"
    assert DevWebBrowserQueryTool.name == "browser_query"


def test_worker_toolset_exposes_the_wrappers_not_the_bases() -> None:
    from service.agents.dev_web_task_agent import _tool_classes

    classes = {c.name: c for c in _tool_classes()}
    assert classes["web_site_sweep"] is DevWebSiteSweepTool
    assert classes["dev_web_browse"] is DevWebBrowseWorkerTool
    assert classes["browser_query"] is DevWebBrowserQueryTool


def test_wrappers_no_longer_live_inside_the_worker_entrypoint() -> None:
    """지역 클래스로 되돌아가면 층이 다시 갈린다."""
    from service.agents import dev_web_task_agent as agent

    src = inspect.getsource(agent)
    assert "class DevWebSiteSweepTool" not in src
    assert "_dev_web_browser_deep_dive_seen" not in src


# ── browser_query 는 '화면을 본' action 에서만 마킹 ──────────────────────


def _run(tool: Any, vi: Any, ctx: ToolContext) -> Any:
    return asyncio.run(tool.execute(vi, ctx))


def test_browser_query_marks_only_for_viewing_actions(tmp_path, monkeypatch) -> None:
    class _VI:
        def __init__(self, action: str) -> None:
            self.action = action

    async def ok(self, vi, ctx):  # noqa: ANN001
        return ToolSuccess(content="x")

    monkeypatch.setattr(
        DevWebBrowserQueryTool.__bases__[0], "execute", ok, raising=False)

    for action, expected in (("snapshot", True), ("html", True),
                             ("screenshot", True), ("click", False)):
        ctx = _ctx(tmp_path)
        mark_site_sweep(ctx)
        _run(DevWebBrowserQueryTool(), _VI(action), ctx)
        assert ctx.metadata.get(BROWSER_DEEP_DIVE_KEY, False) is expected, action
