"""github_repo_set_status — repo 스캔 워커의 종료 도구.

## 이 도구가 왜 없었는지가 이 파일의 존재 이유다

`github_scan/worker.md` 8항이 이 도구를 이름으로 지시하고, `github_task_scan` 이
`context.metadata["_github_task_scan_*"]` 로 인계값을 쓰는데, **받을 도구가 없었다.**
그래서 워커는 계약을 안 읽고 정규식 함수를 직접 불렀고, finding 이 판정 경로를
건너뛰었다(2026-08-26: kr_phone 오탐 3,867건).

`ConfluenceSpaceSetStatusTool` 테스트의 미러다 — 같은 계약이면 같은 검사를 받아야 한다.
"""
from __future__ import annotations

import asyncio
import os

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


@pytest.fixture(autouse=True)
def _isolated_db():
    from service.tests.db_setup import _ensure_test_db, _resolve_test_dsn, _truncate_all_managed
    from secu_agent import state as core_state
    from service import state_domain as state

    dsn = _resolve_test_dsn()
    _ensure_test_db(dsn)
    os.environ["SECU_AGENT_PG_DSN"] = dsn
    core_state._reset_pg_pool()
    state._SCHEMA_READY = False
    with state.connect() as c:
        _truncate_all_managed(c)
    yield


def _tool():
    from domains.services.github.plugin.tools.github_repo_set_status_tool import (
        GithubRepoSetStatusTool,
    )
    return GithubRepoSetStatusTool()


def _ctx(tmp_path, **metadata):
    return ToolContext(evidence_dir=tmp_path, metadata=dict(metadata))


def test_bulk_transition_closes_targets(tmp_path):
    from service import state_domain as state

    ids = [state.github_repo_target_upsert(f"org/r{i}") for i in range(3)]
    tool = _tool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=ids, status="tasked", finding_count=4, reason="done"),
        _ctx(tmp_path)))

    assert isinstance(res, ToolSuccess)
    for tid in ids:
        row = state.github_repo_target_get(tid)
        assert row["status"] == "tasked"
        assert row["finding_count"] == 4
        assert row["last_reason"] == "done"


def test_unknown_target_is_not_found(tmp_path):
    tool = _tool()
    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[987654], status="tasked"), _ctx(tmp_path)))
    assert isinstance(res, ToolError)
    assert res.kind == "not_found"


@pytest.mark.parametrize("recommended", ["", "done", "pending"])
def test_refuses_to_close_when_scan_recommendation_is_not_terminal(tmp_path, recommended):
    """스캔이 돌았는데 분류가 종료값이 아니면 **닫지 않는다.**

    스캔 상태를 모르는 채 닫으면 큐에서 빠지고 다시 안 온다 — 못 본 것을 봤다고
    기록하는 것과 같다.
    """
    from service import state_domain as state

    tid = state.github_repo_target_upsert("org/repo")
    tool = _tool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[tid], status="tasked", finding_count=0),
        _ctx(tmp_path,
             _github_task_scan_status="ok",
             _github_task_scan_recommended_status=recommended)))

    assert isinstance(res, ToolError)
    assert res.kind == "validation"
    assert "invalid github_task_scan recommended status" in res.message
    row = state.github_repo_target_get(tid)
    assert row["status"] == "pending", "거부했으면 큐에 남아 있어야 한다"


@pytest.mark.parametrize("requested", ["tasked", "skipped"])
def test_scanner_error_recommendation_wins_over_worker_request(tmp_path, requested):
    """★ worker.md 8항: 스캐너의 error/skipped 분류를 워커가 덮지 못한다.

    `partial detail missing` 처럼 **반쯤 읽은** repo 를 모델이 `tasked` 로 닫으면
    그대로 큐에서 빠진다. 2026-08-26 실측으로 finding 27,424건 중 26,458건(96%)이
    바로 그 '반쯤 읽은' repo 에서 나왔다.
    """
    from service import state_domain as state

    tid = state.github_repo_target_upsert("org/repo")
    tool = _tool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[tid], status=requested, finding_count=7),
        _ctx(tmp_path,
             _github_task_scan_recommended_status="error",
             _github_task_scan_status_reason="detail fetch returned no content")))

    assert isinstance(res, ToolSuccess)
    assert "scan recommended error" in res.content
    row = state.github_repo_target_get(tid)
    assert row["status"] == "error"
    assert row["last_reason"] == "detail fetch returned no content"


def test_worker_may_close_more_strictly_than_the_scanner(tmp_path):
    """반대 방향은 막지 않는다 — 덜 닫는 것은 안전하다."""
    from service import state_domain as state

    tid = state.github_repo_target_upsert("org/repo")
    tool = _tool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[tid], status="error", finding_count=0,
                         reason="worker saw an inconsistency"),
        _ctx(tmp_path, _github_task_scan_recommended_status="tasked")))

    assert isinstance(res, ToolSuccess)
    assert state.github_repo_target_get(tid)["status"] == "error"


def test_no_scan_metadata_means_no_guard(tmp_path):
    """스캔 도구를 안 쓴 경로(수동·재분류)는 그대로 닫힌다 — 가드는 스캔이 돌았을 때만."""
    from service import state_domain as state

    tid = state.github_repo_target_upsert("org/repo")
    tool = _tool()
    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[tid], status="skipped", reason="repo deleted"),
        _ctx(tmp_path)))
    assert isinstance(res, ToolSuccess)
    assert state.github_repo_target_get(tid)["status"] == "skipped"


def test_delegated_inspector_recommends_instead_of_closing(tmp_path, monkeypatch):
    """위임된 검토원은 남의 큐를 닫지 않는다(Phase 2) — 리드가 닫는다."""
    import json
    from service import state_domain as state
    from _shared.queue_ownership import RECOMMENDATION_FILENAME

    monkeypatch.setenv("SA_AGENT_DEPTH", "1")
    tid = state.github_repo_target_upsert("org/repo")
    tool = _tool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[tid], status="tasked", finding_count=2),
        _ctx(tmp_path)))

    assert isinstance(res, ToolSuccess)
    assert json.loads(res.content)["recommended_status"] == "tasked"
    assert (tmp_path / RECOMMENDATION_FILENAME).exists()
    assert state.github_repo_target_get(tid)["status"] == "pending", "검토원은 닫지 않는다"


# ── commit dedup 커서 인계 (2026-08-27) ──────────────────────────────────────
#
# `github_task_scan` 은 커서를 **직접 전진시키지 않는다**. 후보만 돌려주고 등록은
# 에이전트가 하므로, 스캔 시점의 전진은 "제출이 거부돼도 그 커밋을 다시 안 본다" 를
# 뜻했다. 이제 스캔은 `_github_pending_scanned_sha` 로 넘기고, target 을 실제로 닫는
# 이 도구가 전진시킨다. 워커가 죽으면 metadata 와 함께 사라져 전진하지 않는다.

def test_closing_a_target_advances_the_pending_commit_cursor(tmp_path):
    from service import state_domain as state

    tid = state.github_repo_target_upsert("org/cursor-ok")
    tool = _tool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[tid], status="tasked", finding_count=1),
        _ctx(tmp_path, _github_pending_scanned_sha={"org/cursor-ok": "deadbeef"})))

    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    assert state.github_repo_target_get(tid)["last_scanned_sha"] == "deadbeef"


def test_error_close_does_not_advance_the_cursor(tmp_path):
    """스캔이 불완전했다는 뜻이므로 그 커밋들을 다시 봐야 한다."""
    from service import state_domain as state

    tid = state.github_repo_target_upsert("org/cursor-error")
    tool = _tool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[tid], status="error", finding_count=0,
                         reason="detail fetch 전부 비었다"),
        _ctx(tmp_path, _github_pending_scanned_sha={"org/cursor-error": "deadbeef"})))

    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    assert state.github_repo_target_get(tid)["last_scanned_sha"] is None


def test_scan_tool_hands_the_cursor_over_instead_of_advancing_it():
    """★ 스캔 도구가 커서를 직접 쓰면 이 배선이 무의미해진다."""
    import inspect

    from domains.services.plugin.tools import service_task_tools

    src = inspect.getsource(service_task_tools)
    assert '_github_pending_scanned_sha' in src, "스캔 도구가 커서를 인계하지 않는다"
    assert 'state_domain.github_repo_set_scanned_sha(repo_name, sha)' not in src, (
        "스캔 도구가 커서를 여전히 직접 전진시킨다 — 제출 거부/크래시에도 커밋이 사라진다")


def test_cursor_only_advances_for_the_repos_actually_closed(tmp_path):
    """★ 무관한 target 하나를 닫았다고 pending 에 있는 모든 repo 커서를 밀면 안 된다."""
    from service import state_domain as state

    closed = state.github_repo_target_upsert("org/closed-one")
    other = state.github_repo_target_upsert("org/untouched")
    tool = _tool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[closed], status="tasked", finding_count=0),
        _ctx(tmp_path, _github_pending_scanned_sha={
            "org/closed-one": "aaa111", "org/untouched": "bbb222"})))

    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    assert state.github_repo_target_get(closed)["last_scanned_sha"] == "aaa111"
    assert state.github_repo_target_get(other)["last_scanned_sha"] is None


def test_cursor_does_not_advance_when_no_target_was_closed(tmp_path):
    """상태 변경이 전부 실패했는데 커서만 전진하면 그 커밋을 다시 못 본다."""
    from unittest.mock import patch

    from service import state_domain as state

    tid = state.github_repo_target_upsert("org/write-fails")
    tool = _tool()

    with patch.object(state, "github_repo_target_set_status", side_effect=RuntimeError("db")):
        res = asyncio.run(tool.execute(
            tool.input_model(target_ids=[tid], status="tasked", finding_count=0),
            _ctx(tmp_path, _github_pending_scanned_sha={"org/write-fails": "ccc333"})))

    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    assert state.github_repo_target_get(tid)["last_scanned_sha"] is None
