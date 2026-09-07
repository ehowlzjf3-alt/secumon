"""Core plugin adapter for Confluence fanout registration."""
from __future__ import annotations

from domains.services.confluence.application.fanout import (
    FanoutServices,
    register as register_application_fanout,
)
from domains.services.confluence.infrastructure.runtime import (
    default_state_gateway,
    default_worker_runtime,
)
from service.agents.quality_events import QualityRecorder


def register() -> bool:
    services = FanoutServices(
        store=default_state_gateway(),
        runtime=default_worker_runtime(),
        quality=QualityRecorder("confluence"),
    )
    return register_application_fanout(services)
