"""Real MCP transports (SSE + streamable-HTTP) wrapping the ``mcp`` SDK.

Ported from ai-soc/soc/infrastructure/mcp/_real.py with our import paths.

Proxy handling: MCP 호스트는 사내 internal(10.x / 12.x). shell 의 http_proxy
env 를 따라가면 timeout. httpx 의 trust_env=True 가 기본이라 강제로
trust_env=False 팩토리 주입해 proxy bypass. (v3.45 web_tools 와 같은 패턴.)
"""
from __future__ import annotations

from contextlib import AsyncExitStack
from datetime import timedelta
from typing import Any

import httpx
from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamablehttp_client

from secu_agent.mcp.client import MCPClient
from secu_agent.mcp.types import MCPCallResult, MCPServerConfig, MCPToolDef


def _no_proxy_http_client_factory(
    headers: dict[str, Any] | None = None,
    timeout: httpx.Timeout | float | None = None,
    auth: httpx.Auth | None = None,
) -> httpx.AsyncClient:
    """Factory mirroring mcp's create_mcp_http_client but trust_env=False."""
    kwargs: dict[str, Any] = {"follow_redirects": True, "trust_env": False}
    if timeout is not None:
        kwargs["timeout"] = timeout
    if headers is not None:
        kwargs["headers"] = headers
    if auth is not None:
        kwargs["auth"] = auth
    return httpx.AsyncClient(**kwargs)


def _render_block(block: Any) -> str:
    """Best-effort text rendering of an MCP content block."""
    text = getattr(block, "text", None)
    if isinstance(text, str):
        return text
    resource = getattr(block, "resource", None)
    if resource is not None:
        return str(resource)
    return str(block)


def _render_content(blocks: list[Any]) -> str:
    return "\n".join(_render_block(b) for b in blocks)


class _SessionClient(MCPClient):
    """Shared base for transport-backed clients."""

    def __init__(self, config: MCPServerConfig) -> None:
        self._cfg = config
        self._stack: AsyncExitStack | None = None
        self._session: ClientSession | None = None

    @property
    def name(self) -> str:
        return self._cfg.name

    async def _open_transport(self, stack: AsyncExitStack) -> tuple[Any, Any]:
        raise NotImplementedError

    async def connect(self) -> None:
        if self._session is not None:
            return
        stack = AsyncExitStack()
        try:
            read, write = await self._open_transport(stack)
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
        except BaseException:
            await stack.aclose()
            raise
        self._stack = stack
        self._session = session

    async def list_tools(self) -> list[MCPToolDef]:
        if self._session is None:
            raise RuntimeError(f"MCP client {self._cfg.name!r} not connected")
        result = await self._session.list_tools()
        out: list[MCPToolDef] = []
        for t in result.tools:
            out.append(
                MCPToolDef(
                    name=t.name,
                    description=t.description or "",
                    input_schema=dict(t.inputSchema) if t.inputSchema else {},
                    annotations=(
                        t.annotations.model_dump() if t.annotations else {}
                    ),
                )
            )
        return out

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> MCPCallResult:
        if self._session is None:
            raise RuntimeError(f"MCP client {self._cfg.name!r} not connected")
        result = await self._session.call_tool(
            name,
            arguments=arguments,
            read_timeout_seconds=timedelta(seconds=self._cfg.timeout),
        )
        content = _render_content(list(result.content))
        return MCPCallResult(content=content, is_error=bool(result.isError))

    async def close(self) -> None:
        if self._stack is None:
            return
        try:
            await self._stack.aclose()
        finally:
            self._stack = None
            self._session = None


class SSEMCPClient(_SessionClient):
    """MCP client over Server-Sent Events."""

    async def _open_transport(self, stack: AsyncExitStack) -> tuple[Any, Any]:
        streams = await stack.enter_async_context(
            sse_client(
                self._cfg.url,
                headers=dict(self._cfg.headers),
                timeout=self._cfg.timeout,
                httpx_client_factory=_no_proxy_http_client_factory,
            )
        )
        return streams[0], streams[1]


class StreamableHTTPMCPClient(_SessionClient):
    """MCP client over streamable HTTP (post-SSE spec)."""

    async def _open_transport(self, stack: AsyncExitStack) -> tuple[Any, Any]:
        streams = await stack.enter_async_context(
            streamablehttp_client(
                self._cfg.url,
                headers=dict(self._cfg.headers),
                timeout=timedelta(seconds=self._cfg.timeout),
                httpx_client_factory=_no_proxy_http_client_factory,
            )
        )
        return streams[0], streams[1]
