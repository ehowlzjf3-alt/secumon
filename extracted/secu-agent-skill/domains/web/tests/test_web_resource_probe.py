from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


class _FakeResponse:
    def __init__(
        self,
        url: str,
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        text: str = "",
    ) -> None:
        self.url = url
        self.status_code = status_code
        self.headers = headers or {"content-type": "text/html"}
        self.content = text.encode("utf-8")


class _FakeClient:
    def __init__(self, responses: dict[str, _FakeResponse], **kwargs) -> None:
        del kwargs
        self.responses = responses

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def get(self, url: str):
        return self.responses[url]


def _run(tool, payload, tmp_path: Path):
    return asyncio.run(tool.execute(
        tool.input_model(**payload),
        ToolContext(evidence_dir=tmp_path),
    ))


@pytest.fixture(autouse=True)
def _allow_example_domain(monkeypatch):
    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "example.com")
    monkeypatch.delenv("SA_WEB_ALLOWED_CIDRS", raising=False)


def test_web_resource_probe_rejects_spa_fallback(monkeypatch, tmp_path):
    from domains.web.plugin.tools import web_tools
    from domains.web.plugin.tools.web_tools import WebResourceProbeTool

    home = "<html><title>SPA</title><script src='/js/app.js'></script></html>"
    responses = {
        "https://example.com/": _FakeResponse("https://example.com/", text=home),
        "https://example.com/.env": _FakeResponse("https://example.com/.env", text=home),
    }
    monkeypatch.setattr(web_tools.httpx, "Client", lambda **kwargs: _FakeClient(responses, **kwargs))

    res = _run(WebResourceProbeTool(), {
        "urls": ["https://example.com/.env"],
        "compare_to_root": True,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    item = payload["resources"][0]
    assert item["semantic_status"] == "rejected"
    assert item["semantic_type"] == "spa_fallback"
    assert Path(payload["evidence_ref"]).exists()


def test_web_resource_probe_detects_masked_sensitive_signals(monkeypatch, tmp_path):
    from domains.web.plugin.tools import web_tools
    from domains.web.plugin.tools.web_tools import WebResourceProbeTool
    from secu_agent.agent.semantic_validation import (
        register_sensitive_term_signal,
        unregister_sensitive_term_signal,
    )

    unregister_sensitive_term_signal("semiconductor_process")
    register_sensitive_term_signal(
        "semiconductor_process",
        kind="process_keyword_context",
        terms=("wafer", "recipe", "yield", "defect"),
    )

    root = "<html>home</html>"
    js = """
    const endpoint = "https://api.internal.example.com/v1/orders";
    const owner = "kim@example.com";
    const token = "API_TOKEN=abcd1234secret";
    const process = "wafer recipe parameter defect yield";
    """
    responses = {
        "https://example.com/": _FakeResponse("https://example.com/", text=root),
        "https://example.com/js/app.js": _FakeResponse(
            "https://example.com/js/app.js",
            headers={"content-type": "application/javascript"},
            text=js,
        ),
    }
    monkeypatch.setattr(web_tools.httpx, "Client", lambda **kwargs: _FakeClient(responses, **kwargs))

    res = _run(WebResourceProbeTool(), {
        "urls": ["https://example.com/js/app.js"],
        "compare_to_root": True,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    signals = payload["resources"][0]["sensitive_signals"]
    categories = {signal["category"] for signal in signals}
    assert {"credential", "pii", "attack_surface", "semiconductor_process"} <= categories
    assert "abcd1234secret" not in json.dumps(payload)
    assert "kim@example.com" not in json.dumps(payload)


def test_web_resource_probe_treats_redirect_as_inconclusive(monkeypatch, tmp_path):
    from domains.web.plugin.tools import web_tools
    from domains.web.plugin.tools.web_tools import WebResourceProbeTool

    responses = {
        "https://example.com/": _FakeResponse("https://example.com/", text="<html>home</html>"),
        "https://example.com/admin": _FakeResponse(
            "https://example.com/admin",
            status_code=302,
            headers={"location": "/login"},
            text="",
        ),
    }
    monkeypatch.setattr(web_tools.httpx, "Client", lambda **kwargs: _FakeClient(responses, **kwargs))

    res = _run(WebResourceProbeTool(), {
        "urls": ["https://example.com/admin"],
        "compare_to_root": True,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    item = payload["resources"][0]
    assert item["semantic_status"] == "inconclusive"
    assert item["semantic_type"] == "redirect"
    assert "not a security finding" in item["reason"]
    assert "validate final response semantics before reporting a finding" in item["required_actions"]


def test_web_resource_probe_blocks_unsafe_url(tmp_path):
    from domains.web.plugin.tools.web_tools import WebResourceProbeTool

    res = _run(WebResourceProbeTool(), {
        "urls": ["file:///etc/passwd"],
    }, tmp_path)

    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"
