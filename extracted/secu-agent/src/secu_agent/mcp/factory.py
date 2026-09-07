"""Pick the right MCPClient for a server config (v3.52-A2)."""
from __future__ import annotations

from secu_agent.mcp.client import MCPClient
from secu_agent.mcp.mock import MockMCPClient
from secu_agent.mcp.transports import SSEMCPClient, StreamableHTTPMCPClient
from secu_agent.mcp.types import MCPServerConfig


def default_client_factory(config: MCPServerConfig) -> MCPClient:
    """Construct an MCPClient matching ``config.transport``."""
    if config.transport == "sse":
        return SSEMCPClient(config)
    if config.transport == "streamable-http":
        return StreamableHTTPMCPClient(config)
    if config.transport == "mock":
        return MockMCPClient(name=config.name)
    raise ValueError(f"unsupported MCP transport: {config.transport!r}")
