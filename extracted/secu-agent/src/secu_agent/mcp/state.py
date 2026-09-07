"""Module-level cache of MCP-bootstrapped tools + clients (v3.52-A4).

Chat session 마다 fresh registry 만드는 우리 구조에 맞춰, lifespan 이 한 번
bootstrap 한 결과를 모듈 변수에 보관. `build_registry_for_task` 가 후반에
`registered_mcp_tools()` 가져다 같이 register.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from secu_agent.agent.tools.base import Tool
from secu_agent.mcp.client import MCPClient
from secu_agent.mcp.factory import default_client_factory
from secu_agent.mcp.loader import (
    bootstrap_mcp_clients_and_tools,
    load_mcp_configs,
)

log = logging.getLogger(__name__)

_TOOLS: list[type[Tool[Any]]] = []
_CLIENTS: list[MCPClient] = []


def registered_mcp_tools() -> list[type[Tool[Any]]]:
    """Snapshot of MCP tool classes currently available."""
    return list(_TOOLS)


def _set_state(clients: list[MCPClient], tools: list[type[Tool[Any]]]) -> None:
    _CLIENTS.clear()
    _TOOLS.clear()
    _CLIENTS.extend(clients)
    _TOOLS.extend(tools)


async def bootstrap_from_yaml(config_path: Path | None = None) -> int:
    """Read config/mcp_servers.yaml, connect, adapt — return tool count."""
    if config_path is None:
        config_path = Path("config/mcp_servers.yaml")
    configs = load_mcp_configs(config_path)
    if not configs:
        log.info("mcp_bootstrap_skipped — no servers in %s", config_path)
        return 0
    clients, tools = await bootstrap_mcp_clients_and_tools(
        configs, client_factory=default_client_factory,
    )
    _set_state(clients, tools)
    log.info(
        "mcp_bootstrap_done servers=%d tools=%d",
        len(clients), len(tools),
    )
    return len(tools)


async def shutdown_mcp() -> None:
    """Close all MCP clients (idempotent)."""
    for c in _CLIENTS:
        try:
            await c.close()
        except Exception as e:
            log.warning("mcp_close_failed server=%s err=%s", c.name, e)
    _CLIENTS.clear()
    _TOOLS.clear()
