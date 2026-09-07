"""Value types for the MCP client layer (v3.52-A2).

Ported from ai-soc with import paths adjusted.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

MCPTransport = Literal["sse", "streamable-http", "stdio", "mock"]


@dataclass(frozen=True, slots=True)
class MCPServerConfig:
    """Static configuration for an MCP server.

    Credentials referenced via ``${ENV}`` markers are resolved at load
    time by the YAML loader.
    """

    name: str
    url: str
    transport: MCPTransport = "sse"
    headers: dict[str, str] = field(default_factory=dict)
    timeout: int = 60
    tool_prefix: str = ""
    """Prepended to every tool name from this server to avoid collisions."""


@dataclass(frozen=True, slots=True)
class MCPToolDef:
    """A tool as advertised by an MCP server."""

    name: str
    description: str
    input_schema: dict[str, Any]
    annotations: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class MCPCallResult:
    """Result of invoking an MCP tool."""

    content: str
    is_error: bool = False
