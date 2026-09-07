from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


@pytest.fixture(autouse=True)
def _web_browser_gate_registered():
    """v3.82 U3a: browser 검증 게이트 대상은 plugin 등록형 — SSO 점검 plugin 이
    'web' 을 등록한 운영 형상을 시뮬레이션한다 (이 파일 픽스처는 task_type=web)."""
    from secu_agent.agent.evidence_judgment import (
        register_browser_verified_task_type,
        unregister_browser_verified_task_type,
    )

    register_browser_verified_task_type("web")
    try:
        yield
    finally:
        unregister_browser_verified_task_type("web")


def _ctx(tmp_path: Path) -> ToolContext:
    # web finding 게이트(정책 A): 대상 호스트를 browser 로 열어본 기록이 있어야 제출 가능.
    # 테스트 픽스처는 example.test 를 사용하므로 방문 기록을 미리 심는다.
    return ToolContext(
        evidence_dir=tmp_path,
        metadata={
            "_web_browser_hosts": ["example.test"],
            "session_id": 10,
            "agent_type": "agent",
            "llm_profile": "codex",
            "llm_client": "codex",
            "llm_model": "gpt-5",
        },
    )


def _payload(task_id: str = "task-1"):
    return {
        "finding": {
            "task_id": task_id,
            "task_type": "web",
            "severity": "critical",
            "summary": "exposed .env with secret",
            "asset_count_scanned": 1,
            "hits": [
                {
                    "category": "secret",
                    "kind": "env_file",
                    "masked": "SECRET=***",
                    "location": "https://example.test/.env",
                    "preview": "SECRET=***",
                }
            ],
            "recommended_actions": ["remove file", "rotate secret"],
        }
    }


def test_submit_finding_web_blocked_without_browser_visit(tmp_db, tmp_path):
    """정책 A: 대상 호스트를 browser 로 열어본 기록 없으면 web finding 거부."""
    from secu_agent import state
    from secu_agent.agent.tools.base import ToolContext
    from secu_agent.agent.tools.submit_finding import SubmitFindingTool

    tool = SubmitFindingTool()
    ctx = ToolContext(evidence_dir=tmp_path, metadata={})  # 방문 기록 없음
    result = asyncio.run(tool.execute(tool.input_model(**_payload()), ctx))

    assert isinstance(result, ToolError)
    assert "browser" in result.message.lower()
    assert state.finding_list() == []


def test_submit_finding_upserts_lifecycle_row(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.submit_finding import SubmitFindingTool

    tool = SubmitFindingTool()
    ctx = _ctx(tmp_path)
    result = asyncio.run(tool.execute(tool.input_model(**_payload()), ctx))

    assert isinstance(result, ToolSuccess)
    rows = state.finding_list()
    assert len(rows) == 1
    row = rows[0]
    assert row["task_type"] == "web"
    assert row["asset"] == "https://example.test/.env"
    assert row["asset_kind"] == "url"
    assert row["severity"] == "critical"
    assert row["status"] == "open"
    assert row["seen_count"] == 1
    assert row["evidence_ref"].endswith("finding.json")
    assert row["extra"]["agent_provenance"]["llm_profile"] == "codex"
    assert row["extra"]["agent_observations"][0]["session_id"] == 10
    assert ctx.metadata["finding_followup_pending"] is True
    assert ctx.metadata["finding_signals"][0]["finding_id"] == row["id"]
    assert ctx.metadata["finding_signals"][0]["status"] == "confirmed"
    assert ctx.metadata["finding_signals"][0]["report_updated"] is True


def test_submit_finding_deduplicates_repeated_report(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.submit_finding import SubmitFindingTool

    tool = SubmitFindingTool()
    ctx = _ctx(tmp_path)
    first = asyncio.run(tool.execute(tool.input_model(**_payload("task-1")), ctx))
    second = asyncio.run(tool.execute(tool.input_model(**_payload("task-2")), ctx))

    assert isinstance(first, ToolSuccess)
    assert isinstance(second, ToolSuccess)
    rows = state.finding_list()
    assert len(rows) == 1
    assert rows[0]["seen_count"] == 2


def test_submit_finding_rejects_unconfirmed_web_env_claim(tmp_db, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.submit_finding import SubmitFindingTool

    payload = _payload()
    payload["finding"]["hits"][0].update({
        "category": "web_vuln",
        "kind": "exposed_file",
        "masked": None,
        "preview": "<html><title>Access denied</title></html>",
    })

    tool = SubmitFindingTool()
    result = asyncio.run(tool.execute(tool.input_model(**payload), _ctx(tmp_path)))

    assert isinstance(result, ToolError)
    assert result.kind == "validation"
    assert "evidence judgment" in result.message.lower()
    assert state.finding_list() == []
    assert not (tmp_path / "finding.json").exists()


def test_submit_finding_runs_pivot_once_and_attaches(tmp_db, tmp_path):
    """de-domain v3.84 #3 / v3.85 #4: submit 후 등록된 finding enricher 1회 실행 +
    결과를 슬롯 병합 + signal.pivot_exposed. descriptor 미선언 구 enricher 는
    slot="pivot" 기본값 + exposed_count 합계로 종전 동작 보존."""
    from secu_agent import state
    from secu_agent.agent.finding_enrichment import (
        register_finding_enricher,
        unregister_all_finding_enrichers,
    )
    from secu_agent.agent.tools.submit_finding import SubmitFindingTool

    calls = []

    def fake_enricher(*, asset, summary, hits):
        calls.append({"asset": asset, "summary": summary, "hits": hits})
        return {
            "version": 1,
            "candidates": ["https://example.test/.git/config"],
            "probes": [{"url": "https://example.test/.git/config", "status": "200",
                        "exposed": True, "content_type": "text/plain",
                        "evidence_masked": "[core]"}],
            "exposed_count": 1,
        }

    unregister_all_finding_enrichers()
    register_finding_enricher(fake_enricher)
    try:
        tool = SubmitFindingTool()
        ctx = _ctx(tmp_path)
        result = asyncio.run(tool.execute(tool.input_model(**_payload()), ctx))

        assert isinstance(result, ToolSuccess)
        assert len(calls) == 1
        assert calls[0]["asset"] == "https://example.test/.env"
        row = state.finding_list()[0]
        assert row["extra"]["pivot"]["exposed_count"] == 1  # 구 slot 기본값 보존
        assert ctx.metadata["finding_signals"][0]["pivot_exposed"] == 1
    finally:
        unregister_all_finding_enrichers()


def test_submit_finding_pivot_failure_does_not_fail_finding(tmp_db, tmp_path):
    """enricher 가 예외를 던져도 finding 은 정상 적재된다(record-only, 비차단)."""
    from secu_agent import state
    from secu_agent.agent.finding_enrichment import (
        register_finding_enricher,
        unregister_all_finding_enrichers,
    )
    from secu_agent.agent.tools.submit_finding import SubmitFindingTool

    def boom(*, asset, summary, hits):
        raise RuntimeError("probe exploded")

    unregister_all_finding_enrichers()
    register_finding_enricher(boom)
    try:
        tool = SubmitFindingTool()
        result = asyncio.run(tool.execute(tool.input_model(**_payload()), _ctx(tmp_path)))
        assert isinstance(result, ToolSuccess)
        rows = state.finding_list()
        assert len(rows) == 1
    finally:
        unregister_all_finding_enrichers()
    assert "pivot" not in (rows[0]["extra"] or {})


def test_submit_finding_accepts_registered_plugin_category(tmp_db, tmp_path):
    """v3.82 U3a: plugin 등록 분류(content 증거 필수)도 증거가 있으면 정상 적재."""
    from secu_agent import state
    from secu_agent.agent.tools.submit_finding import SubmitFindingTool
    from secu_agent.finding_taxonomy import (
        register_finding_category, unregister_finding_category,
    )

    payload = {
        "finding": {
            "task_id": "task-process-1",
            "task_type": "web",
            "severity": "high",
            "summary": "sensitive process information exposed",
            "asset_count_scanned": 1,
            "hits": [
                {
                    "category": "plugtest_process",
                    "kind": "recipe_parameter",
                    "masked": None,
                    "location": "https://example.test/process.html",
                    "preview": "internal recipe parameter and yield data",
                }
            ],
            "recommended_actions": ["restrict access"],
        }
    }

    register_finding_category(
        "plugtest_process", label="공정류 민감 정보", priority=7,
        requires_content_evidence=True,
    )
    try:
        tool = SubmitFindingTool()
        result = asyncio.run(tool.execute(tool.input_model(**payload), _ctx(tmp_path)))
    finally:
        unregister_finding_category("plugtest_process")

    assert isinstance(result, ToolSuccess)
    rows = state.finding_list()
    assert len(rows) == 1
    assert rows[0]["asset"] == "https://example.test/process.html"
