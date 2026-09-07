"""v3.52: MCP client + adapter + loader + state cache."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.agent.tools.registry import ToolRegistry
from secu_agent.mcp import (
    MCPCallResult,
    MCPServerConfig,
    MCPToolDef,
    MockMCPClient,
    bootstrap_mcp_tools,
    default_client_factory,
    load_mcp_configs,
    make_mcp_tool,
)
from secu_agent.mcp.loader import bootstrap_mcp_clients_and_tools


# ─── types / factory ───────────────────────────────────────


def test_factory_picks_mock():
    cfg = MCPServerConfig(name="m", url="x", transport="mock")
    client = default_client_factory(cfg)
    assert isinstance(client, MockMCPClient)


def test_factory_rejects_unknown():
    cfg = MCPServerConfig(name="m", url="x", transport="bogus")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="unsupported MCP transport"):
        default_client_factory(cfg)


# ─── load_mcp_configs ──────────────────────────────────────


def test_load_configs_env_interpolation(tmp_path, monkeypatch):
    monkeypatch.setenv("MCP_INTERNAL_HOST", "10.20.30.40")
    yaml_path = tmp_path / "mcp_servers.yaml"
    yaml_path.write_text(
        "servers:\n"
        "  splunk:\n"
        "    url: http://${MCP_INTERNAL_HOST}:8002/sse\n"
        "    transport: sse\n"
        "    timeout: 90\n",
        encoding="utf-8",
    )
    configs = load_mcp_configs(yaml_path)
    assert "splunk" in configs
    assert configs["splunk"].url == "http://10.20.30.40:8002/sse"
    assert configs["splunk"].timeout == 90


def test_load_configs_missing_file_ok(tmp_path):
    assert load_mcp_configs(tmp_path / "does_not_exist.yaml") == {}


def test_load_configs_rejects_non_mapping_servers(tmp_path):
    p = tmp_path / "bad.yaml"
    p.write_text("servers: [1,2,3]\n", encoding="utf-8")
    with pytest.raises(ValueError, match="'servers' must be a mapping"):
        load_mcp_configs(p)


# ─── adapter ───────────────────────────────────────────────


def test_adapter_proxies_call_to_mcp(tmp_path):
    client = MockMCPClient(name="splunk")
    asyncio.run(client.connect())

    async def _h(args):
        return MCPCallResult(content=f"SPL ran with: {args}", is_error=False)
    client.register("splunk_search", _h)

    tool_def = MCPToolDef(
        name="splunk_search", description="run SPL",
        input_schema={"type": "object", "properties": {"spl": {"type": "string"}}},
    )
    ToolCls = make_mcp_tool(mcp_def=tool_def, client=client)
    tool = ToolCls()
    ctx = ToolContext(evidence_dir=tmp_path)
    inp = ToolCls.input_model(spl="index=_internal | head 1")
    res = asyncio.run(tool.execute(inp, ctx))
    assert isinstance(res, ToolSuccess)
    assert "SPL ran with" in res.content
    assert client.calls[0][0] == "splunk_search"


def test_adapter_returns_tool_error_on_mcp_is_error(tmp_path):
    client = MockMCPClient(name="x")
    asyncio.run(client.connect())

    async def _h(args):
        return MCPCallResult(content="bad SPL", is_error=True)
    client.register("t", _h)
    ToolCls = make_mcp_tool(
        mcp_def=MCPToolDef(name="t", description="", input_schema={}),
        client=client,
    )
    res = asyncio.run(ToolCls().execute(ToolCls.input_model(), ToolContext(evidence_dir=tmp_path)))
    assert isinstance(res, ToolError)
    assert res.kind == "execution"
    assert "bad SPL" in res.message


def test_adapter_input_schema_passthrough():
    client = MockMCPClient(name="x")
    schema = {"type": "object", "required": ["a"], "properties": {"a": {"type": "integer"}}}
    ToolCls = make_mcp_tool(
        mcp_def=MCPToolDef(name="t", description="", input_schema=schema),
        client=client,
    )
    assert ToolCls.input_schema() == schema


def test_adapter_secret_redact_applies(tmp_path, monkeypatch):
    """tool 출력에 sensitive env 값이 우연 포함되면 redact."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-mcp-leaked-12345678")
    client = MockMCPClient(name="x")
    asyncio.run(client.connect())

    async def _h(args):
        return MCPCallResult(
            content="user query result: token=sk-mcp-leaked-12345678 OK",
            is_error=False,
        )
    client.register("t", _h)
    ToolCls = make_mcp_tool(
        mcp_def=MCPToolDef(name="t", description="", input_schema={}),
        client=client,
    )
    res = asyncio.run(ToolCls().execute(ToolCls.input_model(), ToolContext(evidence_dir=tmp_path)))
    assert isinstance(res, ToolSuccess)
    assert "sk-mcp-leaked-12345678" not in res.content
    assert "***REDACTED***" in res.content


# ─── bootstrap_mcp_clients_and_tools ───────────────────────


def test_bootstrap_returns_adapted_tools(tmp_path):
    # 가짜 client factory: 각 cfg 에 대해 MockMCPClient + 1개 도구
    def _factory(cfg):
        c = MockMCPClient(name=cfg.name)
        # 도구 1개 등록 (list_tools 가 반환)
        c.add_tool(MCPToolDef(
            name="search", description=f"{cfg.name} search", input_schema={},
        ))
        return c

    configs = {
        "splunk": MCPServerConfig(name="splunk", url="mock", transport="mock"),
    }
    clients, tools = asyncio.run(bootstrap_mcp_clients_and_tools(
        configs, client_factory=_factory,
    ))
    assert len(clients) == 1
    assert len(tools) == 1
    assert tools[0].name == "search"


def test_bootstrap_excluded_tools_skipped(tmp_path):
    def _factory(cfg):
        c = MockMCPClient(name=cfg.name)
        c.add_tool(MCPToolDef(name="search", description="", input_schema={}))
        c.add_tool(MCPToolDef(name="dangerous", description="", input_schema={}))
        return c

    configs = {"x": MCPServerConfig(name="x", url="mock", transport="mock")}
    _, tools = asyncio.run(bootstrap_mcp_clients_and_tools(
        configs, client_factory=_factory, excluded_tools={"dangerous"},
    ))
    names = [t.name for t in tools]
    assert "search" in names
    assert "dangerous" not in names


def test_bootstrap_continues_on_per_server_connect_failure():
    """한 server 가 connect 실패해도 나머지는 계속."""
    class _BoomClient(MockMCPClient):
        async def connect(self):
            raise ConnectionError("dead")

    def _factory(cfg):
        if cfg.name == "dead":
            return _BoomClient(name=cfg.name)
        c = MockMCPClient(name=cfg.name)
        c.add_tool(MCPToolDef(name="ok_tool", description="", input_schema={}))
        return c

    configs = {
        "dead": MCPServerConfig(name="dead", url="mock", transport="mock"),
        "alive": MCPServerConfig(name="alive", url="mock", transport="mock"),
    }
    clients, tools = asyncio.run(bootstrap_mcp_clients_and_tools(
        configs, client_factory=_factory,
    ))
    assert len(clients) == 1  # only "alive"
    assert clients[0].name == "alive"
    assert any(t.name == "ok_tool" for t in tools)


# ─── legacy bootstrap_mcp_tools (registry direct) ─────────


def test_legacy_bootstrap_registers_into_registry(tmp_path):
    def _factory(cfg):
        c = MockMCPClient(name=cfg.name)
        c.add_tool(MCPToolDef(name="legacy_search", description="run SPL", input_schema={}))
        return c

    r = ToolRegistry()
    configs = {"x": MCPServerConfig(name="x", url="mock", transport="mock")}
    asyncio.run(bootstrap_mcp_tools(configs, r, client_factory=_factory))
    assert r.get("legacy_search") is not None


# ─── module cache (state.py) ───────────────────────────────


def test_state_cache_roundtrip(tmp_path, monkeypatch):
    """bootstrap_from_yaml + registered_mcp_tools + shutdown."""
    from secu_agent.mcp import state as mcp_state

    yaml_path = tmp_path / "mcp.yaml"
    yaml_path.write_text(
        "servers:\n"
        "  m1:\n"
        "    url: mock://anything\n"
        "    transport: mock\n",
        encoding="utf-8",
    )

    # MockMCPClient 에는 도구 등록 안 됨 → 결과 0개 도구. 그래도 bootstrap 자체는 동작.
    n = asyncio.run(mcp_state.bootstrap_from_yaml(yaml_path))
    assert n == 0
    assert mcp_state.registered_mcp_tools() == []
    asyncio.run(mcp_state.shutdown_mcp())
