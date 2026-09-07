"""Core plugin adapter for SMB fanout registration."""
from __future__ import annotations

from domains.smb.application.fanout import FanoutServices, register as register_application_fanout
from domains.smb.infrastructure.runtime import default_state_gateway, default_worker_runtime
from service.agents.quality_events import QualityRecorder


def register() -> bool:
    services = FanoutServices(
        store=default_state_gateway(),
        runtime=default_worker_runtime(),
        quality=QualityRecorder("smb"),
    )
    return register_application_fanout(services)
