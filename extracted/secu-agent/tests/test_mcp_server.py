"""v3.41-A1: secu-agent MCP server — read-only 도구 노출 검증.

FastMCP 인스턴스 in-process 로 list_tools / call_tool 호출, 우리 state 의
findings / shares / subnets 가 round-trip 통과하는지 확인.
"""
from __future__ import annotations

import asyncio
import json

from secu_agent import state
from secu_agent.mcp.server import build_mcp_server


def _run(coro):
    return asyncio.run(coro)


def _call(server, name: str, args: dict) -> str:
    """MCP call_tool 호출 → 결과를 plain text 로 normalize."""
    res = _run(server.call_tool(name, args))
    if isinstance(res, tuple):
        content, _structured = res
    else:
        content = res
    parts: list[str] = []
    for c in content:
        if hasattr(c, "text"):
            parts.append(c.text)
        elif isinstance(c, dict) and "text" in c:
            parts.append(c["text"])
        else:
            parts.append(str(c))
    return "\n".join(parts)


def test_mcp_server_exposes_expected_tools(tmp_db):
    server = build_mcp_server()
    tools = _run(server.list_tools())
    names = {t.name for t in tools}
    # v3.82 U3c: 도메인 도구(list_shares/query_share/list_subnets)는 코어 제거.
    expected = {"list_findings", "get_finding"}
    assert expected.issubset(names), f"missing: {expected - names}"
    assert not {"list_shares", "query_share", "list_subnets"} & names


def test_mcp_server_list_findings_empty(tmp_db):
    server = build_mcp_server()
    out = _call(server, "list_findings", {"limit": 10})
    data = json.loads(out)
    assert data == {"findings": [], "count": 0}


def test_mcp_server_list_findings_returns_seeded(tmp_db):
    fid, _ = state.finding_upsert(
        task_type="smb", asset="//1.1.1.1/share", asset_kind="smb_share",
        severity="high", summary="leaked api key",
        extra={"file": "config.ini", "line": 7},
    )
    server = build_mcp_server()
    out = _call(server, "list_findings", {"limit": 10})
    data = json.loads(out)
    assert data["count"] == 1
    assert data["findings"][0]["id"] == fid
    assert data["findings"][0]["severity"] == "high"


def test_mcp_server_get_finding_roundtrip(tmp_db):
    fid, _ = state.finding_upsert(
        task_type="smb", asset="//2.2.2.2/x", asset_kind="smb_share",
        severity="medium", summary="test summary",
        extra={"k": "v"},
    )
    server = build_mcp_server()
    out = _call(server, "get_finding", {"id": fid})
    data = json.loads(out)
    assert data["finding"]["id"] == fid
    assert data["finding"]["summary"] == "test summary"


def test_mcp_server_get_finding_missing_returns_none(tmp_db):
    server = build_mcp_server()
    out = _call(server, "get_finding", {"id": 999999})
    assert json.loads(out) == {"finding": None}


# v3.82 U3c: list_shares/query_share/list_subnets 도구는 코어 MCP 에서 제거 —
# 도메인 현황 노출은 도메인 서비스 소유 (테스트도 함께 이동).
