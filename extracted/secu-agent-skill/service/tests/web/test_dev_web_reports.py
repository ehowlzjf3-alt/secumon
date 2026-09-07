"""dev_web report API and pipeline projection."""
from __future__ import annotations

from fastapi.testclient import TestClient


def _client() -> TestClient:
    from domains.dev_web.webapp.app import create_app

    return TestClient(create_app())


def test_dev_web_reports_api_includes_finding_tags(tmp_db) -> None:
    from service import state_domain as state
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="dev_web",
        asset="https://dev-api.example.test/swagger",
        asset_kind="url",
        severity="high",
        summary="Swagger 노출",
        extra={
            "hits": [
                {"category": "secret", "kind": "token"},
                {"category": "internal_system", "kind": "swagger"},
            ],
        },
    )
    _, thread_id = state.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=finding_id,
        domain="dev-api.example.test",
        url="https://dev-api.example.test/swagger",
        severity="high",
        status="reported",
    )

    response = _client().get("/api/dev-web/reports")

    assert response.status_code == 200
    item = next(x for x in response.json()["items"] if x["id"] == thread_id)
    assert item["finding_count"] == 1
    assert item["finding_tags"] == [
        {"key": "credential", "label": "크리덴셜"},
        {"key": "internal_system", "label": "시스템정보"},
        {"key": "api_docs", "label": "API 문서"},
    ]


def test_dev_web_pipeline_counts_hitl_and_partial_statuses(tmp_db) -> None:
    from domains.dev_web.webapp.pipeline_view import pipeline_overview
    from service import state_domain as state

    state.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=10,
        domain="partial.example.test",
        url="https://partial.example.test",
        status="partially_remediated",
    )
    state.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=11,
        domain="owner.example.test",
        url="https://owner.example.test",
        status="owner_update_needed",
    )

    stages = {stage["key"]: stage for stage in pipeline_overview()["stages"]}
    report_metrics = {m["label"]: m["value"] for m in stages["report"]["metrics"]}
    reverify_metrics = {m["label"]: m["value"] for m in stages["reverify"]["metrics"]}

    assert report_metrics["hitl"] == 1
    assert reverify_metrics["partial"] == 1
    assert reverify_metrics["hitl"] == 1


def test_dev_web_reports_default_to_current_cycle_and_allow_previous_cycle(
    tmp_db,
    monkeypatch,
) -> None:
    from service import state_domain as state

    monkeypatch.setattr(state, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    _, old_id = state.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=21,
        domain="old.example.test",
        url="https://old.example.test",
        status="awaiting_reply",
        cycle_key="2026-W27",
    )
    _, current_id = state.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=22,
        domain="current.example.test",
        url="https://current.example.test",
        status="reported",
        cycle_key="2026-W28",
    )

    current = _client().get("/api/dev-web/reports")
    assert current.status_code == 200
    current_body = current.json()
    assert current_body["cycle_key"] == "2026-W28"
    assert [item["id"] for item in current_body["items"]] == [current_id]
    assert current_body["summary"]["reported"] == 1

    previous = _client().get("/api/dev-web/reports?cycle_key=2026-W27")
    previous_body = previous.json()
    assert previous_body["cycle_key"] == "2026-W27"
    assert [item["id"] for item in previous_body["items"]] == [old_id]
    assert previous_body["summary"]["awaiting_reply"] == 1

    all_cycles = _client().get("/api/dev-web/reports?cycle_key=all")
    assert {item["id"] for item in all_cycles.json()["items"]} == {old_id, current_id}


def test_dev_web_pipeline_report_counts_current_cycle_only(tmp_db, monkeypatch) -> None:
    from domains.dev_web.webapp.pipeline_view import pipeline_overview
    from service import state_domain as state

    monkeypatch.setattr(state, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    state.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=31,
        domain="old-reported.example.test",
        url="https://old-reported.example.test",
        status="reported",
        cycle_key="2026-W27",
    )
    state.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=32,
        domain="current-reported.example.test",
        url="https://current-reported.example.test",
        status="reported",
        cycle_key="2026-W28",
    )
    state.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=33,
        domain="current-done.example.test",
        url="https://current-done.example.test",
        status="remediated",
        cycle_key="2026-W28",
    )

    body = pipeline_overview()
    stages = {stage["key"]: stage for stage in body["stages"]}

    assert body["cycle_key"] == "2026-W28"
    assert body["report_thread_status_counts"]["reported"] == 1
    assert stages["report"]["queue"] == 1
    assert stages["report"]["done"] == 1
