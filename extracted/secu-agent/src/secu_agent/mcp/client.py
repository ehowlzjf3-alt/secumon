"""Abstract MCP client interface (v3.52-A2).

Concrete transports (SSE, streamable-http, mock) implement this contract;
callers never depend on the transport.
Ported from ai-soc/soc/infrastructure/mcp/base.py.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from secu_agent.mcp.types import MCPCallResult, MCPToolDef


class MCPClient(ABC):
    """One connection to one MCP server."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Server name used for logs and tool-prefix decisions."""

    @abstractmethod
    async def connect(self) -> None:
        """Open the underlying session; idempotent."""

    @abstractmethod
    async def list_tools(self) -> list[MCPToolDef]:
        """Discover tools exposed by the server."""

    @abstractmethod
    async def call_tool(self, name: str, arguments: dict[str, Any]) -> MCPCallResult:
        """Invoke a tool; errors MUST be returned as ``is_error=True`` results."""

    @abstractmethod
    async def close(self) -> None:
        """Release the session; idempotent."""
