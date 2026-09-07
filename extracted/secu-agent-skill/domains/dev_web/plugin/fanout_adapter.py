"""Core plugin adapter for dev_web fanout registration."""
from __future__ import annotations

from domains.dev_web.application.fanout import FanoutServices, register as register_application_fanout
from domains.dev_web.infrastructure.runtime import default_state_gateway, default_worker_runtime
from service.agents.quality_events import QualityRecorder


def register() -> bool:
    services = FanoutServices(
        store=default_state_gateway(),
        runtime=default_worker_runtime(),
        quality=QualityRecorder("dev_web"),
    )
    return register_application_fanout(services)
