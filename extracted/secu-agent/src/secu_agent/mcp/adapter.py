"""Adapter factory — wrap an MCP tool as a native ``Tool`` subclass (v3.52-A3).

Ported from ai-soc/soc/infrastructure/mcp/adapter.py with our Tool interface.

The native ``Tool`` base expects a Pydantic ``input_model`` so it can validate
input and generate a JSON schema. MCP tools expose raw JSON Schema directly,
so we use a permissive ``PassthroughInput`` (``extra="allow"``) and override
``input_schema()`` to return the server's schema verbatim.
"""
from __future__ import annotations

from typing import Any, ClassVar

from pydantic import BaseModel, ConfigDict

from secu_agent.agent.secret_redact import redact_secrets
from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    ToolSuccess,
)
from secu_agent.mcp.client import MCPClient
from secu_agent.mcp.types import MCPToolDef


class PassthroughInput(BaseModel):
    """Pass-through: accept any fields, forward to MCP server."""

    model_config = ConfigDict(extra="allow")


def _infer_read_only(mcp_def: MCPToolDef) -> bool:
    return bool(mcp_def.annotations.get("readOnlyHint"))


def _infer_destructive(mcp_def: MCPToolDef) -> bool:
    return bool(mcp_def.annotations.get("destructiveHint"))


def make_mcp_tool(
    *,
    mcp_def: MCPToolDef,
    client: MCPClient,
    local_name: str | None = None,
    description_override: str | None = None,
    search_hint: str = "",
    is_read_only: bool | None = None,
    is_destructive: bool | None = None,
    deferred: bool = False,
    domain: str = "external",
) -> type[Tool[PassthroughInput]]:
    """Build a Tool subclass that proxies calls to an MCP server."""
    _name = local_name or mcp_def.name
    _description = description_override or mcp_def.description
    _read_only = _infer_read_only(mcp_def) if is_read_only is None else is_read_only
    _destructive = (
        _infer_destructive(mcp_def) if is_destructive is None else is_destructive
    )
    _schema = dict(mcp_def.input_schema)
    _mcp_name = mcp_def.name
    _server_name = client.name
    _client = client
    _search_hint = search_hint
    _deferred = deferred
    _domain = domain

    class _MCPTool(Tool[PassthroughInput]):
        name: ClassVar[str] = _name
        description: ClassVar[str] = _description
        input_model: ClassVar[type[BaseModel]] = PassthroughInput
        search_hint: ClassVar[str] = _search_hint
        is_read_only: ClassVar[bool] = _read_only
        is_destructive: ClassVar[bool] = _destructive
        deferred: ClassVar[bool] = _deferred
        domain: ClassVar[str] = _domain

        @classmethod
        def input_schema(cls) -> dict[str, Any]:
            return _schema

        async def execute(
            self,
            validated_input: PassthroughInput,
            context: ToolContext,
        ) -> ToolResult:
            del context
            args = validated_input.model_dump()
            try:
                result = await _client.call_tool(_mcp_name, args)
            except Exception as e:
                return ToolError(
                    kind="execution",
                    message=f"MCP call failed ({_server_name}/{_mcp_name}): {e}",
                )
            # v3.51-S1: MCP 응답에도 secret redact (sensitive env 값 등이 우연 echo).
            content = redact_secrets(result.content)
            if result.is_error:
                return ToolError(kind="execution", message=content)
            return ToolSuccess(content=content)

    _MCPTool.__name__ = f"MCP_{_server_name}_{_name}"
    _MCPTool.__qualname__ = _MCPTool.__name__
    return _MCPTool
