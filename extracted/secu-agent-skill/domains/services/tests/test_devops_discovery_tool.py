"""v3.61 D2: RunDevopsDiscoveryTool — splunk mock + URL 정규화 + devops_target upsert."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
from typing import Any, ClassVar

import pytest
from pydantic import BaseModel

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)
from secu_agent.agent.tools.registry import ToolRegistry
from domains.services.plugin.tools.devops_discovery_tool import DevopsTargetSetStatusTool, normalize_devops_url
from service import state_domain as state


@pytest.fixture(autouse=True)
def _isolated_db():
    from service.tests.db_setup import _ensure_test_db, _resolve_test_dsn, _truncate_all_managed
    from secu_agent import state as core_state

    dsn = _resolve_test_dsn()
    _ensure_test_db(dsn)
    os.environ["SECU_AGENT_PG_DSN"] = dsn
    core_state._reset_pg_pool()
    state._SCHEMA_READY = False
    with state.connect() as c:
        _truncate_all_managed(c)
    yield


_FAKE_PAYLOAD: dict[str, Any] = {}


class _FakeSplunkInput(BaseModel):
    query: str
    max_results: int | None = None


class _FakeSplunkTool(Tool[_FakeSplunkInput]):
    name: ClassVar[str] = "splunk_search"
    description: ClassVar[str] = "fake"
    input_model: ClassVar[type[BaseModel]] = _FakeSplunkInput
    is_read_only: ClassVar[bool] = True
    domain: ClassVar[str] = "external"

    async def execute(self, vi, ctx) -> ToolResult:
        return ToolSuccess(content=json.dumps(_FAKE_PAYLOAD))


def _ctx(tmp_path):
    r = ToolRegistry()
    r.register(_FakeSplunkTool)
    return ToolContext(evidence_dir=tmp_path, registry=r)


# ─── URL 정규화 ────────────────────────────────────────────


@pytest.mark.parametrize("url,expected", [
    ("https://github.samsungds.net/RE-CODE/ope-ui.git/info/refs?service=git-upload-pack",
     ("github", "https://github.samsungds.net/RE-CODE/ope-ui")),
    ("https://github.samsungds.net/teamA/proj/blob/main/x.py",
     ("github", "https://github.samsungds.net/teamA/proj")),
    ("https://confluence.samsungds.net/display/SECOPS/Runbook+Page",
     ("confluence", "https://confluence.samsungds.net/display/SECOPS")),
    ("https://confluence.samsungds.net/spaces/DEVX/pages/123",
     ("confluence", "https://confluence.samsungds.net/spaces/DEVX")),
])
def test_normalize_ok(url, expected):
    assert normalize_devops_url(url) == expected


@pytest.mark.parametrize("url", [
    "https://github.samsungds.net/login",                # 1-seg, 비repo
    "https://github.samsungds.net/assets/x.css",         # 정적
    "https://github.samsungds.net/org!/repo/blob/main/.env",
    "https://github.samsungds.net/org/repo$/tree/main/config",
    "https://github.samsungds.net/orgs/platform/teams/secops",
    "https://github.samsungds.net/users/alice/repositories",
    "https://img.shields.io/badge/x",                    # 외부
    "https://confluence.samsungds.net/dologin.action",   # space 아님
    "https://confluence.samsungds.net/display/OPS!/Runbook",
    "https://confluence.samsungds.net/spaces/SEC-/pages/123",
    "https://confluence.samsungds.net/spaces/1OPS/pages/123",
])
def test_normalize_reject(url):
    assert normalize_devops_url(url) is None


# ─── 디스커버리 ────────────────────────────────────────────


def test_devops_set_status_honors_github_scan_recommended_error(tmp_path):
    target_id = state.devops_target_upsert(
        "https://github.samsungds.net/org/api-down",
        service="github",
        source="proxy",
        day_bucket=dt.date.today().isoformat(),
        access_count=3,
    )
    ctx = ToolContext(
        evidence_dir=tmp_path,
        metadata={
            "_github_task_scan_recommended_status": "error",
            "_github_task_scan_status_reason": "GitHub code search API returned HTTP 503",
        },
    )
    tool = DevopsTargetSetStatusTool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_id=target_id, status="tasked", finding_count=0),
        ctx,
    ))

    assert isinstance(res, ToolSuccess)
    assert "scan recommended error" in res.content
    row = state.devops_target_get(target_id)
    assert row["status"] == "error"
    assert row["finding_count"] == 0
    assert row["last_reason"] == "GitHub code search API returned HTTP 503"


def test_devops_set_status_preserves_github_error_over_requested_skipped(tmp_path):
    target_id = state.devops_target_upsert(
        "https://github.samsungds.net/org/api-down",
        service="github",
        source="proxy",
        day_bucket=dt.date.today().isoformat(),
        access_count=3,
    )
    ctx = ToolContext(
        evidence_dir=tmp_path,
        metadata={
            "_github_task_scan_recommended_status": "error",
            "_github_task_scan_status_reason": "GitHub exact file detail failed",
        },
    )
    tool = DevopsTargetSetStatusTool()

    res = asyncio.run(tool.execute(
        tool.input_model(
            target_id=target_id,
            status="skipped",
            finding_count=0,
            reason="agent saw an access wall",
        ),
        ctx,
    ))

    assert isinstance(res, ToolSuccess)
    assert "requested skipped; scan recommended error" in res.content
    row = state.devops_target_get(target_id)
    assert row["status"] == "error"
    assert row["last_reason"] == "GitHub exact file detail failed"


def test_devops_set_status_honors_confluence_scan_recommended_skipped(tmp_path):
    target_id = state.devops_target_upsert(
        "https://confluence.samsungds.net/display/MISSING",
        service="confluence",
        source="proxy",
        day_bucket=dt.date.today().isoformat(),
        access_count=2,
    )
    ctx = ToolContext(
        evidence_dir=tmp_path,
        metadata={
            "_confluence_task_scan_recommended_status": "skipped",
            "_confluence_task_scan_status_reason": "Confluence page returned HTTP 404",
        },
    )
    tool = DevopsTargetSetStatusTool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_id=target_id, status="tasked", finding_count=0),
        ctx,
    ))

    assert isinstance(res, ToolSuccess)
    assert "scan recommended skipped" in res.content
    row = state.devops_target_get(target_id)
    assert row["status"] == "skipped"
    assert row["finding_count"] == 0
    assert row["last_reason"] == "Confluence page returned HTTP 404"


def test_devops_set_status_ignores_other_service_scan_metadata(tmp_path):
    target_id = state.devops_target_upsert(
        "https://github.samsungds.net/org/repo",
        service="github",
        source="proxy",
        day_bucket=dt.date.today().isoformat(),
        access_count=1,
    )
    ctx = ToolContext(
        evidence_dir=tmp_path,
        metadata={
            "_confluence_task_scan_recommended_status": "error",
            "_confluence_task_scan_status_reason": "unrelated Confluence failure",
        },
    )
    tool = DevopsTargetSetStatusTool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_id=target_id, status="tasked", finding_count=0),
        ctx,
    ))

    assert isinstance(res, ToolSuccess)
    row = state.devops_target_get(target_id)
    assert row["status"] == "tasked"
    assert row["last_reason"] is None


@pytest.mark.parametrize(
    ("service", "url", "metadata"),
    [
        (
            "github",
            "https://github.samsungds.net/org/status-gap",
            {
                "_github_task_scan_status": "ok",
                "_github_task_scan_recommended_status": "",
            },
        ),
        (
            "confluence",
            "https://confluence.samsungds.net/display/STATUS",
            {
                "_confluence_task_scan_status": "ok",
                "_confluence_task_scan_recommended_status": "done",
            },
        ),
    ],
)
def test_devops_set_status_rejects_invalid_scan_recommendation(
    tmp_path,
    service,
    url,
    metadata,
):
    target_id = state.devops_target_upsert(
        url,
        service=service,
        source="proxy",
        day_bucket=dt.date.today().isoformat(),
        access_count=1,
    )
    ctx = ToolContext(evidence_dir=tmp_path, metadata=metadata)
    tool = DevopsTargetSetStatusTool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_id=target_id, status="tasked", finding_count=0),
        ctx,
    ))

    assert isinstance(res, ToolError)
    assert res.kind == "validation"
    assert "invalid" in res.message
    assert "recommended status" in res.message
    row = state.devops_target_get(target_id)
    assert row["status"] == "pending"
    assert row["cycle_scanned_at"] is None


def test_devops_set_status_rejects_missing_target_id(tmp_path):
    tool = DevopsTargetSetStatusTool()

    res = asyncio.run(tool.execute(
        tool.input_model(target_id=999_999, status="tasked", finding_count=0),
        ToolContext(evidence_dir=tmp_path, metadata={}),
    ))

    assert isinstance(res, ToolError)
    assert res.kind == "not_found"
    assert "devops_target not found" in res.message
