"""Load MCP server configs from YAML, connect, and register their tools (v3.52-A4).

Ported from ai-soc/soc/infrastructure/mcp/loader.py with our registry + logging.

At startup the app calls :func:`bootstrap_mcp_tools` to:
  1. parse ``config/mcp_servers.yaml``
  2. build a client per server (transport chosen by ``transport`` field)
  3. discover tools on each server
  4. wrap each one via :func:`make_mcp_tool`
  5. register the resulting Tool classes in the ToolRegistry

Shutdown: callers keep the returned clients and ``await client.close()``
on each.
"""
from __future__ import annotations

import logging
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import yaml

from secu_agent.agent.tools.base import Tool
from secu_agent.agent.tools.registry import ToolRegistry
from secu_agent.mcp.adapter import make_mcp_tool
from secu_agent.mcp.client import MCPClient
from secu_agent.mcp.types import MCPServerConfig

log = logging.getLogger(__name__)

ClientFactory = Callable[[MCPServerConfig], MCPClient]

_ENV_PATTERN = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")


def _interpolate(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _interpolate(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_interpolate(v) for v in obj]
    if isinstance(obj, str):
        return _ENV_PATTERN.sub(lambda m: os.environ.get(m.group(1), ""), obj)
    return obj


def load_mcp_configs(path: Path) -> dict[str, MCPServerConfig]:
    """Parse a YAML file listing MCP server configs. Missing file = empty dict."""
    if not path.exists():
        log.info("mcp_config_missing path=%s", path)
        return {}
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    servers_raw = _interpolate(raw.get("servers", {}))
    if not isinstance(servers_raw, dict):
        raise ValueError(f"'servers' must be a mapping in {path}")

    out: dict[str, MCPServerConfig] = {}
    for name, cfg in servers_raw.items():
        if not isinstance(cfg, dict):
            raise ValueError(f"MCP server '{name}' must be a mapping")
        out[name] = MCPServerConfig(
            name=name,
            url=cfg["url"],
            transport=cfg.get("transport", "sse"),
            headers=cfg.get("headers") or {},
            timeout=cfg.get("timeout", 60),
            tool_prefix=cfg.get("tool_prefix", ""),
        )
    return out


async def bootstrap_mcp_clients_and_tools(
    configs: dict[str, MCPServerConfig] | list[MCPServerConfig],
    *,
    client_factory: ClientFactory,
    excluded_tools: set[str] | None = None,
) -> tuple[list[MCPClient], list[type[Tool[Any]]]]:
    """Connect + list_tools + adapt — return (clients, tool_classes).

    우리는 chat session 마다 registry 새로 만들어. 그래서 registry 에 직접
    register 하는 게 아니라 만들어진 tool class 들 반환 → caller 가 module
    cache 에 보관 → build_registry_for_task 가 가져다 register.
    """
    cfg_list = list(configs.values()) if isinstance(configs, dict) else list(configs)
    excluded = excluded_tools or set()

    clients: list[MCPClient] = []
    tool_classes: list[type[Tool[Any]]] = []
    for cfg in cfg_list:
        try:
            client = client_factory(cfg)
            await client.connect()
        except Exception as e:
            log.error("mcp_connect_failed server=%s err=%s", cfg.name, e)
            continue
        clients.append(client)

        try:
            tools = await client.list_tools()
        except Exception as e:
            log.error("mcp_list_tools_failed server=%s err=%s", cfg.name, e)
            continue

        for td in tools:
            local_name = f"{cfg.tool_prefix}{td.name}"
            if local_name in excluded:
                log.info("mcp_tool_excluded server=%s tool=%s", cfg.name, local_name)
                continue
            try:
                tool_cls = make_mcp_tool(
                    mcp_def=td,
                    client=client,
                    local_name=local_name,
                )
                tool_classes.append(tool_cls)
                log.info("mcp_tool_adapted server=%s tool=%s", cfg.name, local_name)
            except ValueError as e:
                log.warning(
                    "mcp_tool_adapt_failed server=%s tool=%s err=%s",
                    cfg.name, local_name, e,
                )
    return clients, tool_classes


async def bootstrap_mcp_tools(
    configs: dict[str, MCPServerConfig] | list[MCPServerConfig],
    registry: ToolRegistry,
    *,
    client_factory: ClientFactory,
    excluded_tools: set[str] | None = None,
) -> list[MCPClient]:
    """Connect to every configured MCP server, register discovered tools.

    Individual server failures are logged but don't abort bootstrap — a dead
    Splunk MCP shouldn't take down the whole agent.
    """
    cfg_list = list(configs.values()) if isinstance(configs, dict) else list(configs)
    excluded = excluded_tools or set()

    clients: list[MCPClient] = []
    for cfg in cfg_list:
        try:
            client = client_factory(cfg)
            await client.connect()
        except Exception as e:
            log.error("mcp_connect_failed server=%s err=%s", cfg.name, e)
            continue
        clients.append(client)

        try:
            tools = await client.list_tools()
        except Exception as e:
            log.error("mcp_list_tools_failed server=%s err=%s", cfg.name, e)
            continue

        for td in tools:
            local_name = f"{cfg.tool_prefix}{td.name}"
            if local_name in excluded:
                log.info("mcp_tool_excluded server=%s tool=%s", cfg.name, local_name)
                continue
            try:
                tool_cls = make_mcp_tool(
                    mcp_def=td,
                    client=client,
                    local_name=local_name,
                )
                registry.register(tool_cls)
                log.info(
                    "mcp_tool_registered server=%s tool=%s",
                    cfg.name, local_name,
                )
            except ValueError as e:
                log.warning(
                    "mcp_tool_register_failed server=%s tool=%s err=%s",
                    cfg.name, local_name, e,
                )
    return clients
