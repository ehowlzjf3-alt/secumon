"""v3.20: URL safety 가드 — WebFetchTool 의 SSRF/스킴 차단.

핵심:
- http/https 만 허용. file://, data:, javascript:, gopher:// 거부.
- 127.0.0.0/8, ::1, 169.254.0.0/16 (cloud metadata) 등 hard-block 대상 IP 거부.
- "localhost", "metadata.google.internal", ".local" hostname 거부.
- 사내망 (RFC1918 + 12.x / 106.x) 은 정상 통과 — agent 가 IP 로 사내/외부 판단 금지 룰 유지.
"""
from __future__ import annotations

import pytest

from domains.web.plugin.tools.web_tools import URLSafetyError, validate_url_safe


@pytest.fixture(autouse=True)
def _clear_web_scope_env(monkeypatch):
    """URL safety defaults should not depend on a developer's local .env."""
    for name in (
        "SA_WEB_ALLOWED_DOMAINS",
        "WEB_ALLOWED_DOMAINS",
        "SA_WEB_ALLOWED_CIDRS",
        "WEB_ALLOWED_CIDRS",
        "SA_WEB_REQUIRE_SCOPE",
    ):
        monkeypatch.delenv(name, raising=False)


# ─── scoped browsing allowlist ───────────────────────────────────────


def test_scope_domains_allow_exact_and_subdomains(monkeypatch):
    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "example.com, *.corp.internal")

    validate_url_safe("https://example.com/")
    validate_url_safe("https://app.example.com/dashboard")
    validate_url_safe("https://jenkins.corp.internal/job/main")


def test_scope_domains_block_out_of_scope_hosts(monkeypatch):
    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "example.com")

    with pytest.raises(URLSafetyError) as e:
        validate_url_safe("https://evil.example.net/")

    assert "outside allowed web scope" in str(e.value).lower()


def test_scope_cidrs_allow_matching_ip_and_block_other_ip(monkeypatch):
    monkeypatch.setenv("SA_WEB_ALLOWED_CIDRS", "10.50.1.0/24, 106.10.0.0/16")

    validate_url_safe("https://10.50.1.25/app")
    validate_url_safe("https://106.10.20.30/")

    with pytest.raises(URLSafetyError):
        validate_url_safe("https://10.60.1.25/app")


def test_scope_does_not_override_hard_blocks(monkeypatch):
    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "localhost")
    monkeypatch.setenv("SA_WEB_ALLOWED_CIDRS", "127.0.0.0/8, 169.254.0.0/16")

    for bad in ("http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/"):
        with pytest.raises(URLSafetyError):
            validate_url_safe(bad)


def test_scope_can_require_configuration(monkeypatch):
    monkeypatch.setenv("SA_WEB_REQUIRE_SCOPE", "true")

    with pytest.raises(URLSafetyError) as e:
        validate_url_safe("https://example.com/")

    assert "no allowed web scope configured" in str(e.value).lower()


# ─── scheme allowlist ────────────────────────────────────────────────


@pytest.mark.parametrize("bad", [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "gopher://x.example.com",
    "ftp://files.example.com",
    "",
    "   ",
    "not-a-url",
])
def test_disallowed_scheme_or_invalid(bad):
    with pytest.raises(URLSafetyError):
        validate_url_safe(bad)


@pytest.mark.parametrize("good", [
    "http://example.com",
    "https://wiki.internal-gateway.invalid/page",
    "https://10.20.30.40/internal",   # RFC1918 사내망
    "https://192.0.2.40/asset",      # Samsung 공인 IP
])
def test_allowed_scheme_and_hosts(good):
    validate_url_safe(good)  # no raise


# ─── SSRF 가드: IP literal ───────────────────────────────────────────


@pytest.mark.parametrize("bad", [
    "http://127.0.0.1/x",
    "http://127.0.0.5/y",
    "https://[::1]/z",
    "http://169.254.169.254/latest/meta-data/",  # AWS metadata
    "http://169.254.170.2/",                    # ECS metadata
])
def test_blocked_ip_literals(bad):
    with pytest.raises(URLSafetyError):
        validate_url_safe(bad)


# ─── SSRF 가드: hostname pattern ─────────────────────────────────────


@pytest.mark.parametrize("bad", [
    "http://localhost/",
    "http://localhost:8080/",
    "https://Localhost/",                       # 대소문자 무관
    "http://metadata.google.internal/",
    "http://anything.localhost/",
    "http://srv.local/",
])
def test_blocked_hostnames(bad):
    with pytest.raises(URLSafetyError):
        validate_url_safe(bad)


# ─── intranet 정상 통과 (RFC1918 + samsung 대역) ────────────────────


@pytest.mark.parametrize("good", [
    "http://10.0.0.5/",
    "https://172.16.5.10/",
    "http://192.168.1.1/",
    "https://106.10.20.30/",   # samsung 공인 IP
    "http://share-srv-01.internal-gateway.invalid/",
])
def test_intranet_passes(good):
    validate_url_safe(good)


# ─── error message 정보성 ────────────────────────────────────────────


def test_error_message_has_reason():
    with pytest.raises(URLSafetyError) as e:
        validate_url_safe("file:///etc/passwd")
    assert "scheme" in str(e.value).lower()

    with pytest.raises(URLSafetyError) as e:
        validate_url_safe("http://127.0.0.1/")
    msg = str(e.value).lower()
    assert "loopback" in msg or "blocked" in msg


# ─── tool integration — blocked URL → ToolError(forbidden) ───────────


import asyncio
import json
from pathlib import Path

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


def _ctx(tmp_path: Path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path)


def _run(tool, payload):
    return asyncio.run(tool.execute(tool.input_model(**payload), _ctx(Path("/tmp"))))


def test_web_fetch_tool_blocks_loopback(tmp_path):
    from domains.web.plugin.tools.web_tools import WebFetchTool
    res = _run(WebFetchTool(), {"url": "http://127.0.0.1/", "max_bytes": 1024})
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"
    assert "blocked" in res.message.lower() or "loopback" in res.message.lower()


def test_web_fetch_tool_blocks_file_scheme(tmp_path):
    from domains.web.plugin.tools.web_tools import WebFetchTool
    res = _run(WebFetchTool(), {"url": "file:///etc/passwd", "max_bytes": 1024})
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"


def test_web_fetch_tool_blocks_out_of_scope_when_scope_configured(tmp_path, monkeypatch):
    from domains.web.plugin.tools.web_tools import WebFetchTool

    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "allowed.example")
    res = _run(WebFetchTool(), {"url": "https://blocked.example/", "max_bytes": 1024})

    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"
    assert "outside allowed web scope" in res.message.lower()



