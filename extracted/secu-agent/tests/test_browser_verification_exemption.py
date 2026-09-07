"""정책 A(브라우저 검증) **면제 훅** — 등록형이고 fail-closed 다.

## 왜 이 훅이 생겼나 (2026-08-27)

게이트는 `task_type` 단위로 걸리는데, 같은 `task_type='github'` 아래에 성격이 다른 두
레인이 있었다. SSO URL 점검 레인은 브라우저를 쥐고 있어 게이트를 만족시킬 수 있지만,
repo API 스캔 레인은 **브라우저 도구가 없다**(무인 워커라 의도적으로 뺐다). 게다가 코어
`_host_of` 가 스킴 없는 문자열의 첫 세그먼트를 호스트로 만들어내서, 스캔 워커는
존재하지도 않는 호스트('dataservice')를 열어보라는 요구를 받았다. 실측으로 그날 제출
14건이 14건 모두 이걸로 죽었다.

## 이 테스트가 지키는 것

면제 판단을 **자산 문자열**에 두면 게이트 우회로가 된다("비-URL 이면 면제" → 워커가
target/location 을 경로로만 쓰면 브라우저 없이 통과). 그래서 훅은 판단을 도메인에
넘기되, 코어는 두 가지를 보장한다: **기본은 면제 없음**(현행 동작 불변)이고 **판정자가
터지면 면제하지 않는다**(fail-closed).
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from secu_agent.agent.evidence_judgment import (
    browser_verification_exempt,
    register_browser_verification_exemption,
    register_browser_verified_task_type,
    unregister_browser_verification_exemption,
    unregister_browser_verified_task_type,
)
from secu_agent.agent.tools.base import ToolContext, ToolError
from secu_agent.agent.tools.submit_finding import SubmitFindingTool


@pytest.fixture
def web_gate():
    register_browser_verified_task_type("web")
    try:
        yield
    finally:
        unregister_browser_verified_task_type("web")


def _payload(task_id: str = "exempt-1"):
    return {
        "finding": {
            "task_id": task_id,
            "task_type": "web",
            "severity": "critical",
            "summary": "exposed .env with secret",
            "asset_count_scanned": 1,
            "hits": [{
                "category": "secret",
                "kind": "env_file",
                "masked": "SECRET=***",
                "location": "https://example.test/.env",
                "preview": "SECRET=***",
            }],
            "recommended_actions": ["remove file", "rotate secret"],
        }
    }


def _submit(tmp_path: Path):
    tool = SubmitFindingTool()
    ctx = ToolContext(evidence_dir=tmp_path, metadata={})  # 방문 기록 없음
    return asyncio.run(tool.execute(tool.input_model(**_payload()), ctx))


def test_no_exemption_registered_keeps_current_behaviour(tmp_db, tmp_path, web_gate):
    """코어 기본 = 면제 없음. 훅이 생겼다고 게이트가 느슨해지면 안 된다."""
    assert browser_verification_exempt(object(), object()) is False
    result = _submit(tmp_path)
    assert isinstance(result, ToolError)
    assert "browser" in result.message.lower()


def test_registered_exemption_bypasses_the_gate(tmp_db, tmp_path, web_gate):
    def _always(finding, context):
        return True

    register_browser_verification_exemption(_always)
    try:
        result = _submit(tmp_path)
    finally:
        unregister_browser_verification_exemption(_always)
    assert not isinstance(result, ToolError), getattr(result, "message", result)


def test_exemption_that_raises_does_not_open_the_gate(tmp_db, tmp_path, web_gate):
    """판정자 버그는 게이트를 여는 방향으로 작동하면 안 된다 (fail-closed)."""
    def _boom(finding, context):
        raise RuntimeError("판정자 버그")

    register_browser_verification_exemption(_boom)
    try:
        assert browser_verification_exempt(object(), object()) is False
        result = _submit(tmp_path)
    finally:
        unregister_browser_verification_exemption(_boom)
    assert isinstance(result, ToolError)
    assert "browser" in result.message.lower()


def test_duplicate_registration_is_an_explicit_error():
    """등록 API 공통 규약 — 같은 판정자 두 번은 조용히 넘기지 않는다."""
    def _fn(finding, context):
        return False

    register_browser_verification_exemption(_fn)
    try:
        with pytest.raises(ValueError, match="이미 등록됨"):
            register_browser_verification_exemption(_fn)
    finally:
        unregister_browser_verification_exemption(_fn)
