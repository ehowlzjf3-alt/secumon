"""confluence 스레드 어댑터 — 배관은 `_shared/report_thread_adapter` 한 벌을 쓴다."""
from __future__ import annotations


def confluence_thread_adapter():
    from domains.services.confluence.application.contracts import COMPONENT_CONFLUENCE_RECHECK, COMPONENT_CONFLUENCE_REPORT
    from _shared.report_thread_adapter import build_report_thread_adapter

    return build_report_thread_adapter(
        domain="confluence",
        queue_label="Confluence space 조치요청 큐",
        coord_key="space_key",
        application_module="domains.services.confluence.application.reporter",
        agent_module="service.agents.confluence_report_agent",
        report_component=COMPONENT_CONFLUENCE_REPORT,
        recheck_component=COMPONENT_CONFLUENCE_RECHECK,
    )
