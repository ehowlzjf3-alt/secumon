from __future__ import annotations

import sys
import types
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.tools.base import EmptyInput, Tool, ToolContext, ToolSuccess
from secu_agent.agent.tools.discovery import (
    Toolset,
    build_registry_from_toolset,
    discover_tool_classes,
)


class DomainInput(BaseModel):
    value: str = "ok"


class SmbDomainTool(Tool[DomainInput]):
    name: ClassVar[str] = "smb_domain_probe"
    description: ClassVar[str] = "SMB domain probe."
    input_model: ClassVar[type[BaseModel]] = DomainInput
    domain: ClassVar[str] = "smb"

    async def execute(self, validated_input: DomainInput, context: ToolContext):
        del context
        return ToolSuccess(content=validated_input.value)


class WebDomainTool(Tool[EmptyInput]):
    name: ClassVar[str] = "web_domain_probe"
    description: ClassVar[str] = "Web domain probe."
    input_model: ClassVar[type[BaseModel]] = EmptyInput
    domain: ClassVar[str] = "web"

    async def execute(self, validated_input: EmptyInput, context: ToolContext):
        del validated_input, context
        return ToolSuccess(content="web")


class DeferredTool(Tool[EmptyInput]):
    name: ClassVar[str] = "deferred_probe"
    description: ClassVar[str] = "Deferred probe."
    input_model: ClassVar[type[BaseModel]] = EmptyInput
    domain: ClassVar[str] = "smb"
    deferred: ClassVar[bool] = True

    async def execute(self, validated_input: EmptyInput, context: ToolContext):
        del validated_input, context
        return ToolSuccess(content="deferred")


class CapabilityTool(Tool[EmptyInput]):
    name: ClassVar[str] = "capability_probe"
    description: ClassVar[str] = "Capability probe."
    input_model: ClassVar[type[BaseModel]] = EmptyInput
    domain: ClassVar[str] = "smb"
    requires_capabilities: ClassVar[frozenset[str]] = frozenset({"interactive_approval"})

    async def execute(self, validated_input: EmptyInput, context: ToolContext):
        del validated_input, context
        return ToolSuccess(content="capability")


def test_discover_tool_classes_from_module_names():
    module_name = "_ath_test_discovery_module"
    module = types.ModuleType(module_name)
    module.SmbDomainTool = SmbDomainTool
    module.NotATool = object
    sys.modules[module_name] = module
    try:
        discovered = discover_tool_classes([module_name])
    finally:
        sys.modules.pop(module_name, None)

    assert discovered == [SmbDomainTool]


def test_build_registry_from_toolset_filters_by_domain_and_deferred():
    registry = build_registry_from_toolset(
        [SmbDomainTool, WebDomainTool, DeferredTool],
        Toolset(name="smb-light", include_domains=frozenset({"smb"}), include_deferred=False),
    )

    assert registry.get("smb_domain_probe") is SmbDomainTool
    assert registry.get("web_domain_probe") is None
    assert registry.get("deferred_probe") is None


def test_build_registry_from_toolset_allows_explicit_names():
    registry = build_registry_from_toolset(
        [SmbDomainTool, WebDomainTool],
        Toolset(name="explicit", include_names=frozenset({"web_domain_probe"})),
    )

    assert [tool.name for tool in registry.all()] == ["web_domain_probe"]


def test_build_registry_from_toolset_filters_capabilities():
    without_caps = build_registry_from_toolset(
        [CapabilityTool],
        Toolset(name="no-caps", include_domains=frozenset({"smb"})),
        frontend_capabilities=frozenset(),
    )
    with_caps = build_registry_from_toolset(
        [CapabilityTool],
        Toolset(name="with-caps", include_domains=frozenset({"smb"})),
        frontend_capabilities=frozenset({"interactive_approval"}),
    )

    assert without_caps.get("capability_probe") is None
    assert with_caps.get("capability_probe") is CapabilityTool


def test_toolset_excludes_names_after_inclusion():
    registry = build_registry_from_toolset(
        [SmbDomainTool, WebDomainTool],
        Toolset(
            name="exclude",
            include_domains=frozenset({"smb", "web"}),
            exclude_names=frozenset({"web_domain_probe"}),
        ),
    )

    assert registry.get("smb_domain_probe") is SmbDomainTool
    assert registry.get("web_domain_probe") is None
