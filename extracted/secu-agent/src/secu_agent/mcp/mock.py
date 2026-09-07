"""In-memory MCP client for tests (v3.52-A2).

Ported from ai-soc/soc/infrastructure/mcp/mock.py.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from secu_agent.mcp.client import MCPClient
from secu_agent.mcp.types import MCPCallResult, MCPToolDef

CallHandler = Callable[[dict[str, Any]], Awaitable[MCPCallResult]]


class MockMCPClient(MCPClient):
    """Simple scripted MCP client for tests."""

    def __init__(self, name: str = "mock") -> None:
        self._name = name
        self._tools: list[MCPToolDef] = []
        self._handlers: dict[str, CallHandler] = {}
        self._connected = False
        self.calls: list[tuple[str, dict[str, Any]]] = []

    @property
    def name(self) -> str:
        return self._name

    def add_tool(self, tool: MCPToolDef) -> None:
        self._tools.append(tool)

    def register(self, tool_name: str, handler: CallHandler) -> None:
        self._handlers[tool_name] = handler

    async def connect(self) -> None:
        self._connected = True

    async def list_tools(self) -> list[MCPToolDef]:
        if not self._connected:
            raise RuntimeError("MockMCPClient not connected")
        return list(self._tools)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> MCPCallResult:
        if not self._connected:
            raise RuntimeError("MockMCPClient not connected")
        self.calls.append((name, dict(arguments)))
        handler = self._handlers.get(name)
        if handler is None:
            return MCPCallResult(content=f"no handler registered for {name}", is_error=True)
        return await handler(arguments)

    async def close(self) -> None:
        self._connected = False
