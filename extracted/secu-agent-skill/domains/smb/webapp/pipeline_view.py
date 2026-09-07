"""Compatibility wrapper for the SMB pipeline projection."""
from __future__ import annotations

from typing import Any

from domains.smb.application.pipeline_projection import pipeline_overview as _pipeline_overview
from domains.smb.infrastructure.runtime import default_state_gateway


def pipeline_overview(*, live: bool = False) -> dict[str, Any]:
    return _pipeline_overview(store=default_state_gateway(), live=live)
