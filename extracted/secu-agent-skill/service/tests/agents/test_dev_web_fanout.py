from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.agent.schema.finding import FindingHit, TaskFinding


class _Runtime:
    def __init__(self, root: Path) -> None:
        self.root = root

    def make_evidence_dir(self, label: str) -> Path:
        out = self.root / label
        out.mkdir(parents=True, exist_ok=True)
        return out

    def worker_env(self) -> dict[str, str]:
        return {"PYTHONPATH": "test"}


def test_dev_web_report_adapter_release_schedules_retry_with_reason(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.dev_web.application import fanout
    from domains.dev_web.infrastructure.runtime import DevWebStateGateway

    monkeypatch.setenv("DEV_WEB_REPORT_FAILURE_RETRY_SECONDS", "42")
    _, thread_id = sd.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=17,
        domain="dev-report-failing.example.test",
        url="https://dev-report-failing.example.test",
        severity="high",
        status="reported",
    )
    services = fanout.FanoutServices(
        store=DevWebStateGateway(),
        runtime=_Runtime(tmp_path),
    )
    adapter = fanout._make_report_adapter(services)
    completion = SimpleNamespace(
        outcome="exited",
        rc=1,
        result=SimpleNamespace(summary="reason=deliver failed"),
    )

    async def _go():
        target = await adapter.claim_next()
        spec = await adapter.build_spec(target)
        before = time.time()
        await adapter.release(target, completion, success=False)
        retry = await adapter.claim_next()
        return spec, before, retry

    spec, before, retry = asyncio.run(_go())

    assert retry is None
    assert spec.timeout_sec == 900
    thread = sd.dev_web_report_thread_get(thread_id)
    assert thread is not None
    assert thread["status"] == "reported"
    assert thread["claimed_by"] is None
    assert thread["claimed_at"] is None
    assert thread["retry_after"] >= before + 41
    assert "exited rc=1 reason=deliver failed" in thread["last_reason"]


def test_dev_web_target_status_tool_rejects_missing_target_id(tmp_db, tmp_path) -> None:
    from domains.dev_web.plugin.tools.dev_web_discovery_tool import (
        DevWebTargetSetStatusInput,
        DevWebTargetSetStatusTool,
    )

    result = asyncio.run(
        DevWebTargetSetStatusTool().execute(
            DevWebTargetSetStatusInput(target_id=987654321, status="tasked"),
            ToolContext(evidence_dir=tmp_path),
        ),
    )

    assert isinstance(result, ToolError)
    assert result.kind == "not_found"
    assert "dev_web_target not found" in result.message


def _finding(*, task_type: str = "dev_web") -> TaskFinding:
    return TaskFinding(
        task_type=task_type,
        target="https://app.cdep.samsungds.net",
        severity="high",
        summary="인증 없이 내부 API 문서와 토큰 형식 정보가 노출됩니다.",
        hits=[
            FindingHit(
                category="credential",
                kind="api_token",
                location="https://app.cdep.samsungds.net/admin",
                masked="TOKEN=ab***",
                preview="TOKEN=ab***",
            )
        ],
        recommended_actions=["인증/인가를 적용하고 토큰 노출 여부를 점검하세요."],
    )


def test_dev_web_submit_finding_rejects_other_task_type(tmp_db, tmp_path) -> None:
    from domains.dev_web.plugin.tools.dev_web_submit_finding_tool import (
        DevWebSubmitFindingInput,
        DevWebSubmitFindingTool,
    )

    result = asyncio.run(
        DevWebSubmitFindingTool().execute(
            DevWebSubmitFindingInput(finding=_finding(task_type="web")),
            ToolContext(
                evidence_dir=tmp_path,
                metadata={"_dev_web_browser_deep_dive_seen": True},
            ),
        ),
    )

    assert isinstance(result, ToolError)
    assert result.kind == "validation"
    assert "task_type='dev_web'" in result.message


def test_dev_web_submit_finding_requires_browser_deep_dive(tmp_db, tmp_path) -> None:
    from domains.dev_web.plugin.tools.dev_web_submit_finding_tool import (
        DevWebSubmitFindingInput,
        DevWebSubmitFindingTool,
    )

    result = asyncio.run(
        DevWebSubmitFindingTool().execute(
            DevWebSubmitFindingInput(finding=_finding()),
            ToolContext(evidence_dir=tmp_path, metadata={}),
        ),
    )

    assert isinstance(result, ToolError)
    assert result.kind == "validation"
    assert "browser deep-dive evidence" in result.message


def test_dev_web_submit_finding_marks_agent_verified(tmp_db, tmp_path) -> None:
    import service.state_domain as sd
    from domains.dev_web.plugin.tools.dev_web_submit_finding_tool import (
        DevWebSubmitFindingInput,
        DevWebSubmitFindingTool,
    )
    from secu_agent import state as core_state

    target_id = sd.dev_web_target_upsert(
        "https://app.cdep.samsungds.net",
        source="unit",
        day_bucket="2026-07-08",
        event_count=1,
    )

    result = asyncio.run(
        DevWebSubmitFindingTool().execute(
            DevWebSubmitFindingInput(finding=_finding(), target_id=target_id),
            ToolContext(
                evidence_dir=tmp_path,
                metadata={"_dev_web_browser_deep_dive_seen": True},
            ),
        ),
    )

    assert isinstance(result, ToolSuccess)
    row = core_state.finding_list(task_type="dev_web", limit=1)[0]
    assert row["extra"]["agent_verification"]["status"] == "verified"
    assert row["extra"]["agent_verification"]["method"] == "dev_web_browser_deep_dive"
    thread = sd.dev_web_report_threads_overview(status="draft", limit=1)[0]
    assert thread["finding_id"] == row["id"]
