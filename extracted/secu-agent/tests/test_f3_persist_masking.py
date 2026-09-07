"""F3: 영속 경계 마스킹 — finding.json / audit.log 에 평문 PII/secret 이 안 남는다."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolSuccess


@pytest.fixture(autouse=True)
def _web_gate():
    from secu_agent.agent.evidence_judgment import (
        register_browser_verified_task_type, unregister_browser_verified_task_type,
    )
    register_browser_verified_task_type("web")
    try:
        yield
    finally:
        unregister_browser_verified_task_type("web")


def _ctx(tmp_path):
    return ToolContext(evidence_dir=tmp_path, metadata={
        "_web_browser_hosts": ["example.test"], "session_id": 1,
        "agent_type": "agent", "llm_profile": "codex",
    })


def test_f3_finding_json_masks_plaintext_secret(tmp_path):
    from secu_agent.agent.tools.submit_finding import SubmitFindingTool
    tool = SubmitFindingTool()
    vi = tool.input_model.model_validate({"finding": {
        "task_id": "t1", "task_type": "web", "severity": "critical",
        "summary": "설정 파일에 AWS 키 AKIA1234567890ABCDEF 노출",
        "hits": [{"category": "secret", "kind": "aws_access_key_id",
                  "masked": "AKIA1234567890ABCDEF",
                  "location": "https://example.test/config",
                  "preview": "aws_key = AKIA1234567890ABCDEF"}],
        "recommended_actions": ["rotate key"],
    }})
    res = asyncio.run(tool.execute(vi, _ctx(tmp_path)))
    assert isinstance(res, ToolSuccess)
    raw = (tmp_path / "finding.json").read_text()
    # 평문 AWS 키가 영속 산출물에 그대로 남지 않는다(마스킹됨)
    assert "AKIA1234567890ABCDEF" not in raw
    # 비민감 라우팅 필드는 보존
    data = json.loads(raw)
    assert data["hits"][0]["category"] == "secret"
    assert data["hits"][0]["kind"] == "aws_access_key_id"


def test_f3_audit_masks_plaintext_in_payload(tmp_path):
    from secu_agent.agent.harness.audit import AuditLog
    log = AuditLog(tmp_path / "audit.log.jsonl")
    log.append("tool_call_started", {
        "name": "web_fetch", "turn": 3,
        "input": {"body": "password=hunter2secret and AKIA1234567890ABCDEF"},
    })
    raw = (tmp_path / "audit.log.jsonl").read_text()
    assert "hunter2secret" not in raw
    assert "AKIA1234567890ABCDEF" not in raw
    # 비민감 필드 보존 + 체인 필드 존재
    entry = json.loads(raw.splitlines()[0])
    assert entry["payload"]["name"] == "web_fetch"
    assert entry["payload"]["turn"] == 3
    assert "hash" in entry and "prev_hash" in entry
