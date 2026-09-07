"""judge_web_finding — WebFinding(agent_types.webdomain) 기반 테스트 (엔진에서 분리)."""
from __future__ import annotations


def test_judge_web_env_without_body_evidence_is_suspected():
    from secu_agent.agent.evidence_judgment import judge_web_finding
    from domains.web.plugin.agent_types.webdomain import WebFinding

    finding = WebFinding(
        url="https://example.test/.env",
        kind="exposed_file",
        detail=".env served",
        severity="high",
    )

    judgment = judge_web_finding(finding)

    assert judgment.verdict == "suspected"
    assert judgment.should_persist is False
    assert "body evidence" in judgment.reason


def test_judge_web_env_with_key_value_body_is_confirmed():
    from secu_agent.agent.evidence_judgment import judge_web_finding
    from domains.web.plugin.agent_types.webdomain import WebFinding

    finding = WebFinding(
        url="https://example.test/.env",
        kind="exposed_file",
        detail=".env served",
        severity="high",
        evidence={
            "status": 200,
            "content_type": "text/plain",
            "body_preview": "APP_ENV=prod\nSECRET_KEY=abc123\n",
        },
    )

    judgment = judge_web_finding(finding)

    assert judgment.verdict == "confirmed"
    assert judgment.should_persist is True


def test_judge_web_env_with_html_body_is_rejected():
    from secu_agent.agent.evidence_judgment import judge_web_finding
    from domains.web.plugin.agent_types.webdomain import WebFinding

    finding = WebFinding(
        url="https://example.test/.env",
        kind="exposed_file",
        detail=".env served",
        severity="high",
        evidence={
            "status": 200,
            "content_type": "text/html",
            "body_preview": "<html><title>Access denied</title><body>blocked</body></html>",
        },
    )

    judgment = judge_web_finding(finding)

    assert judgment.verdict == "rejected"
    assert judgment.should_persist is False
    assert "html" in judgment.reason.lower()
