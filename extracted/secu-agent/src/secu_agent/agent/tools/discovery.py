"""Tool discovery and toolset filtering helpers.

Existing registries can keep manual control, while new tools can be discovered
from modules and grouped with explicit toolset rules.
"""
from __future__ import annotations

import importlib
import inspect
import pkgutil
from collections.abc import Iterable
from dataclasses import dataclass, field
from types import ModuleType
from typing import Any

from secu_agent.agent.tools.base import Tool
from secu_agent.agent.tools.registry import ToolRegistry


@dataclass(frozen=True, slots=True)
class Toolset:
    name: str
    include_names: frozenset[str] = field(default_factory=frozenset)
    include_domains: frozenset[str] = field(default_factory=frozenset)
    exclude_names: frozenset[str] = field(default_factory=frozenset)
    include_deferred: bool = True


def _iter_modules(module_names: Iterable[str]) -> Iterable[ModuleType]:
    for module_name in module_names:
        module = importlib.import_module(module_name)
        yield module
        path = getattr(module, "__path__", None)
        if path is None:
            continue
        prefix = module.__name__ + "."
        for info in pkgutil.walk_packages(path, prefix=prefix):
            yield importlib.import_module(info.name)


def discover_tool_classes(module_names: Iterable[str]) -> list[type[Tool[Any]]]:
    """Import modules/packages and return concrete Tool subclasses sorted by name."""
    found: dict[str, type[Tool[Any]]] = {}
    for module in _iter_modules(module_names):
        for _, obj in inspect.getmembers(module, inspect.isclass):
            if obj is Tool:
                continue
            if not issubclass(obj, Tool):
                continue
            if inspect.isabstract(obj):
                continue
            found[obj.name] = obj
    return [found[name] for name in sorted(found)]


def _included_by_toolset(tool_cls: type[Tool[Any]], toolset: Toolset) -> bool:
    if tool_cls.name in toolset.exclude_names:
        return False
    if tool_cls.deferred and not toolset.include_deferred:
        return False
    has_positive_filter = bool(toolset.include_names or toolset.include_domains)
    if not has_positive_filter:
        return True
    return (
        tool_cls.name in toolset.include_names
        or tool_cls.domain in toolset.include_domains
    )


def build_registry_from_toolset(
    tool_classes: Iterable[type[Tool[Any]]],
    toolset: Toolset,
    *,
    frontend_capabilities: frozenset[str] | set[str] | None = None,
) -> ToolRegistry:
    caps = frozenset(frontend_capabilities or ())
    registry = ToolRegistry()
    for tool_cls in sorted(tool_classes, key=lambda cls: cls.name):
        if not _included_by_toolset(tool_cls, toolset):
            continue
        needed = tool_cls.requires_capabilities
        if needed and not needed.issubset(caps):
            continue
        registry.register(tool_cls)
    return registry
