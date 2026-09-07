from __future__ import annotations

import asyncio
import json

from secu_agent.agent.tools.base import ToolContext, ToolSuccess


def _run(tool, payload, tmp_path):
    return asyncio.run(tool.execute(tool.input_model(**payload), ToolContext(evidence_dir=tmp_path)))


def test_web_task_scan_splits_confirmed_unconfirmed_and_followups(
    tmp_path, monkeypatch,
):
    from domains.web.plugin.tools import web_tools
    from domains.web.plugin.tools.web_tools import WebTaskScanTool
    from domains.web.plugin.agent_types.webdomain import CrawledPage, WebFinding

    pages = [
        CrawledPage(
            url="https://example.com/",
            status=200,
            content_type="text/html",
            body='<html><script src="/app.js"></script></html>',
            headers={"content-type": "text/html"},
        )
    ]
    findings = [
        WebFinding(
            url="https://example.com/.env",
            kind="exposed_file",
            detail=".env served",
            severity="high",
            evidence={
                "status": 200,
                "content_type": "text/plain",
                "body_preview": "APP_ENV=prod\nSECRET_KEY=***\n",
            },
        ),
        WebFinding(
            url="https://example.com/admin",
            kind="admin_page_reachable",
            detail="/admin returns 200",
            severity="medium",
        ),
    ]

    monkeypatch.delenv("SA_WEB_REQUIRE_SCOPE", raising=False)
    monkeypatch.delenv("SA_WEB_ALLOWED_DOMAINS", raising=False)
    monkeypatch.delenv("WEB_ALLOWED_DOMAINS", raising=False)
    monkeypatch.delenv("SA_WEB_ALLOWED_CIDRS", raising=False)
    monkeypatch.delenv("WEB_ALLOWED_CIDRS", raising=False)
    monkeypatch.setattr(web_tools.web, "crawl", lambda seed, max_pages: pages)
    monkeypatch.setattr(web_tools.web, "run_vuln_probes", lambda seed, got: findings)
    monkeypatch.setattr(
        web_tools,
        "_probe_web_resources",
        lambda urls, compare_to_root=True, max_bytes=262144: [
            {
                "url": url,
                "semantic_status": "confirmed" if url.endswith("/app.js") else "rejected",
                "semantic_type": "javascript_resource" if url.endswith("/app.js") else "html_fallback",
                "reason": "test",
                "required_actions": [],
                "sensitive_signals": [],
            }
            for url in urls
        ],
    )

    res = _run(
        WebTaskScanTool(),
        {"seed": "https://example.com/", "max_pages": 5},
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "web_task_scan"
    assert payload["confirmed_findings"][0]["url"] == "https://example.com/.env"
    assert payload["unconfirmed_findings"][0]["url"] == "https://example.com/admin"
    assert "https://example.com/admin" in payload["follow_up"]["urls"]
    assert payload["resource_summary"]["confirmed"] >= 1
    assert payload["evidence_ref"]


def test_web_task_scan_registered_for_operator_and_web():
    from domains.web.plugin.tools.web_tools import WebTaskScanTool
    from secu_agent.agent.tools.registry import ToolRegistry

    registry = ToolRegistry()
    registry.register(WebTaskScanTool)

    assert registry.get("web_task_scan") is WebTaskScanTool


def test_admin_probe_does_not_follow_redirect_to_report_reachable(monkeypatch):
    from domains.web.plugin.agent_types import webdomain

    class _RedirectResponse:
        status_code = 302
        headers = {"location": "/login"}
        content = b""
        text = ""

    class _FakeClient:
        def __init__(self, **kwargs):
            self.follow_redirects = kwargs.get("follow_redirects")

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, url):
            return _RedirectResponse()

    clients = []

    def _client_factory(**kwargs):
        client = _FakeClient(**kwargs)
        clients.append(client)
        return client

    monkeypatch.setattr(webdomain.httpx, "Client", _client_factory)

    findings = webdomain.probe_admin_unauth("https://example.com/")

    assert findings == []
    assert clients
    assert clients[0].follow_redirects is False
