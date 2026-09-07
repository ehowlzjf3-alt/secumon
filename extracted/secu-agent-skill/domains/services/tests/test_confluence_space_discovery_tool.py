"""v3.76: RunConfluenceSpaceDiscoveryTool — 전사 space enum → rolling 큐 적재."""
from __future__ import annotations

import asyncio
import os

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolSuccess


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


def _ctx(tmp_path):
    return ToolContext(evidence_dir=tmp_path, metadata={})


def _fake_spaces():
    from domains.services.confluence.plugin.agent_types.confluence import CfSpace
    return [
        CfSpace(key="RSIP", name="Recipe SIP", type="global", url=""),
        CfSpace(key="OPS", name="Ops Runbook", type="global", url=""),
    ]


def test_set_status_bulk_transitions(tmp_path):
    from domains.services.confluence.plugin.tools import confluence_space_discovery_tool as mod
    from service import state_domain as state
    from secu_agent.agent.tools.base import ToolSuccess as TS

    ids = [state.confluence_space_target_upsert(f"S{i}") for i in range(3)]
    tool = mod.ConfluenceSpaceSetStatusTool()
    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=ids, status="tasked", finding_count=4, reason="done"),
        _ctx(tmp_path)))
    assert isinstance(res, TS)
    for tid in ids:
        row = state.confluence_space_target_get(tid)
        assert row["status"] == "tasked"
        assert row["finding_count"] == 4


@pytest.mark.parametrize("recommended", ["", "done"])
def test_set_status_rejects_invalid_scan_recommendation(tmp_path, recommended):
    from domains.services.confluence.plugin.tools import confluence_space_discovery_tool as mod
    from service import state_domain as state
    from secu_agent.agent.tools.base import ToolError

    tid = state.confluence_space_target_upsert("S0")
    ctx = ToolContext(
        evidence_dir=tmp_path,
        metadata={
            "_confluence_task_scan_status": "ok",
            "_confluence_task_scan_recommended_status": recommended,
        },
    )
    tool = mod.ConfluenceSpaceSetStatusTool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[tid], status="tasked", finding_count=0),
        ctx,
    ))

    assert isinstance(res, ToolError)
    assert res.kind == "validation"
    assert "invalid confluence_task_scan recommended status" in res.message
    row = state.confluence_space_target_get(tid)
    assert row["status"] == "pending"
    assert row["last_scanned_at"] is None


def test_set_status_honors_scan_recommended_error(tmp_path):
    from domains.services.confluence.plugin.tools import confluence_space_discovery_tool as mod
    from service import state_domain as state

    tid = state.confluence_space_target_upsert("S0")
    ctx = ToolContext(
        evidence_dir=tmp_path,
        metadata={
            "_confluence_task_scan_recommended_status": "error",
            "_confluence_task_scan_status_reason": "detail fetch returned no content",
        },
    )
    tool = mod.ConfluenceSpaceSetStatusTool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[tid], status="tasked", finding_count=0),
        ctx))

    assert isinstance(res, ToolSuccess)
    assert "scan recommended error" in res.content
    row = state.confluence_space_target_get(tid)
    assert row["status"] == "error"
    assert row["finding_count"] == 0
    assert row["last_reason"] == "detail fetch returned no content"


def test_set_status_preserves_error_recommendation_over_requested_skipped(tmp_path):
    from domains.services.confluence.plugin.tools import confluence_space_discovery_tool as mod
    from service import state_domain as state

    tid = state.confluence_space_target_upsert("S0")
    ctx = ToolContext(
        evidence_dir=tmp_path,
        metadata={
            "_confluence_task_scan_recommended_status": "error",
            "_confluence_task_scan_status_reason": "CQL detail fetch failed",
        },
    )
    tool = mod.ConfluenceSpaceSetStatusTool()

    res = asyncio.run(tool.execute(
        tool.input_model(
            target_ids=[tid],
            status="skipped",
            finding_count=0,
            reason="agent thought page was inaccessible",
        ),
        ctx))

    assert isinstance(res, ToolSuccess)
    assert "requested skipped; scan recommended error" in res.content
    row = state.confluence_space_target_get(tid)
    assert row["status"] == "error"
    assert row["last_reason"] == "CQL detail fetch failed"


def test_set_status_honors_scan_recommended_skipped(tmp_path):
    from domains.services.confluence.plugin.tools import confluence_space_discovery_tool as mod
    from service import state_domain as state

    tid = state.confluence_space_target_upsert("S0")
    ctx = ToolContext(
        evidence_dir=tmp_path,
        metadata={
            "_confluence_task_scan_recommended_status": "skipped",
            "_confluence_task_scan_status_reason": "space deleted or inaccessible",
        },
    )
    tool = mod.ConfluenceSpaceSetStatusTool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[tid], status="tasked", finding_count=0),
        ctx))

    assert isinstance(res, ToolSuccess)
    assert "scan recommended skipped" in res.content
    row = state.confluence_space_target_get(tid)
    assert row["status"] == "skipped"
    assert row["finding_count"] == 0
    assert row["last_reason"] == "space deleted or inaccessible"


def test_set_status_applies_per_space_scan_recommendations(tmp_path):
    from domains.services.confluence.plugin.tools import confluence_space_discovery_tool as mod
    from service import state_domain as state

    ops_id = state.confluence_space_target_upsert("OPS")
    sec_id = state.confluence_space_target_upsert("SEC")
    ctx = ToolContext(
        evidence_dir=tmp_path,
        metadata={
            "_confluence_task_scan_recommended_status": "tasked",
            "_confluence_task_scan_space_statuses": {
                "OPS": {
                    "status": "tasked",
                    "finding_count": 1,
                    "reason": "space scan completed; findings=1",
                },
                "SEC": {
                    "status": "error",
                    "finding_count": 0,
                    "reason": "SecCqlFailure('Confluence CQL HTTP 503')",
                },
            },
        },
    )
    tool = mod.ConfluenceSpaceSetStatusTool()

    res = asyncio.run(tool.execute(
        tool.input_model(
            target_ids=[ops_id, sec_id],
            status="tasked",
            finding_count=1,
            reason="agent completed batch",
        ),
        ctx,
    ))

    assert isinstance(res, ToolSuccess)
    assert "per-space" in res.content
    ops = state.confluence_space_target_get(ops_id)
    sec = state.confluence_space_target_get(sec_id)
    assert ops["status"] == "tasked"
    assert ops["finding_count"] == 1
    assert ops["last_reason"] == "space scan completed; findings=1"
    assert sec["status"] == "error"
    assert sec["finding_count"] == 0
    assert sec["last_reason"] == "SecCqlFailure('Confluence CQL HTTP 503')"


def test_set_status_rejects_invalid(tmp_path):
    from domains.services.confluence.plugin.tools import confluence_space_discovery_tool as mod
    from service import state_domain as state
    from secu_agent.agent.tools.base import ToolError

    tid = state.confluence_space_target_upsert("S0")
    tool = mod.ConfluenceSpaceSetStatusTool()
    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[tid], status="banana"), _ctx(tmp_path)))
    assert isinstance(res, ToolError)


def test_set_status_rejects_missing_target_id(tmp_path):
    from domains.services.confluence.plugin.tools import confluence_space_discovery_tool as mod
    from secu_agent.agent.tools.base import ToolError

    tool = mod.ConfluenceSpaceSetStatusTool()
    res = asyncio.run(tool.execute(
        tool.input_model(target_ids=[999_999], status="tasked"),
        _ctx(tmp_path)))

    assert isinstance(res, ToolError)
    assert res.kind == "not_found"
    assert "confluence_space_target not found" in res.message
