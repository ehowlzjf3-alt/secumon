"""GitHub E2E web projection wrapper."""
from __future__ import annotations

from typing import Any

from domains.services.github.application.pipeline_projection import (
    github_pipeline_overview as _github_pipeline_overview,
)
from domains.services.github.infrastructure.runtime import default_state_gateway


def github_pipeline_overview(*, live: bool = False) -> dict[str, Any]:
    return _github_pipeline_overview(store=default_state_gateway(), live=live)
