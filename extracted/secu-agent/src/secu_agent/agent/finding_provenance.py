"""Helpers for tagging findings with the agent/session that reported them."""
from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any


def _non_empty_str(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def client_model_name(client: object | None) -> str | None:
    """Best-effort model name extraction without depending on concrete clients."""
    if client is None:
        return None
    profile = getattr(client, "_profile", None)
    model = _non_empty_str(getattr(profile, "model", None))
    if model:
        return model
    clients = getattr(client, "_clients", None)
    if isinstance(clients, list):
        models = [client_model_name(c) for c in clients]
        cleaned = [m for m in models if m]
        if cleaned:
            return " -> ".join(cleaned)
    return None


def runtime_llm_metadata(client: object | None) -> dict[str, object]:
    out: dict[str, object] = {}
    profile = _non_empty_str(os.environ.get("SA_CHAT_PROFILE") or "gemma")
    if profile:
        out["llm_profile"] = profile
    chain = _non_empty_str(os.environ.get("SA_CHAT_PROFILE_CHAIN"))
    if chain:
        out["llm_profile_chain"] = [
            part.strip() for part in chain.split(",") if part.strip()
        ]
    name = _non_empty_str(getattr(client, "name", None))
    if name:
        out["llm_client"] = name
    model = client_model_name(client)
    if model:
        out["llm_model"] = model
    return out


def agent_provenance(metadata: Mapping[str, object] | None) -> dict[str, object]:
    if not metadata:
        return {}
    out: dict[str, object] = {}
    session_id = metadata.get("session_id")
    if session_id is not None:
        try:
            out["session_id"] = int(session_id)
        except (TypeError, ValueError):
            text = _non_empty_str(session_id)
            if text:
                out["session_id"] = text
    for key in ("agent_type", "llm_profile", "llm_client", "llm_model"):
        text = _non_empty_str(metadata.get(key))
        if text:
            out[key] = text
    chain = metadata.get("llm_profile_chain")
    if isinstance(chain, (list, tuple)):
        cleaned = [_non_empty_str(item) for item in chain]
        values = [item for item in cleaned if item]
        if values:
            out["llm_profile_chain"] = values
    else:
        text = _non_empty_str(chain)
        if text:
            out["llm_profile_chain"] = [
                part.strip() for part in text.split(",") if part.strip()
            ]
    return out


def with_agent_provenance(
    extra: Mapping[str, Any] | None,
    metadata: Mapping[str, object] | None,
) -> dict[str, Any]:
    out = dict(extra or {})
    provenance = agent_provenance(metadata)
    if provenance:
        out["agent_provenance"] = provenance
    return out
