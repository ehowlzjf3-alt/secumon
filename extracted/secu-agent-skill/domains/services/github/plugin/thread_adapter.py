"""github 스레드 어댑터 — 배관은 `_shared/report_thread_adapter` 한 벌을 쓴다."""
from __future__ import annotations


def github_thread_adapter():
    from domains.services.github.application.contracts import COMPONENT_GITHUB_RECHECK, COMPONENT_GITHUB_REPORT
    from _shared.report_thread_adapter import build_report_thread_adapter

    return build_report_thread_adapter(
        domain="github",
        queue_label="GitHub 저장소 조치요청 큐",
        coord_key="repo",
        application_module="domains.services.github.application.scanner",
        agent_module="service.agents.github_report_agent",
        report_component=COMPONENT_GITHUB_REPORT,
        recheck_component=COMPONENT_GITHUB_RECHECK,
    )
