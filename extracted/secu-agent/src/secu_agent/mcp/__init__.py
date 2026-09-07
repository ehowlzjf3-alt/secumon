"""secu-agent Model Context Protocol layer (v3.41 server / v3.52 client).

server.py     — 우리 read-only 도구를 외부에 MCP 표준으로 노출 (FastMCP).
client.py     — Abstract MCPClient base.
transports.py — SSE + Streamable HTTP transports (real).
mock.py       — In-memory MCP client for tests.
factory.py    — config.transport → MCPClient.
adapter.py    — MCP tool → 우리 Tool subclass wrapper.
loader.py     — config/mcp_servers.yaml 읽어 bootstrap.
"""
from secu_agent.mcp.adapter import make_mcp_tool
from secu_agent.mcp.client import MCPClient
from secu_agent.mcp.factory import default_client_factory
from secu_agent.mcp.loader import bootstrap_mcp_tools, load_mcp_configs
from secu_agent.mcp.mock import MockMCPClient
from secu_agent.mcp.server import build_mcp_server
from secu_agent.mcp.types import (
    MCPCallResult,
    MCPServerConfig,
    MCPToolDef,
    MCPTransport,
)

__all__ = [
    "MCPCallResult",
    "MCPClient",
    "MCPServerConfig",
    "MCPToolDef",
    "MCPTransport",
    "MockMCPClient",
    "bootstrap_mcp_tools",
    "build_mcp_server",
    "default_client_factory",
    "load_mcp_configs",
    "make_mcp_tool",
]
