"""v3.81 T3: WebFetchTool — url_safety 게이트 재사용 + GET-only fetch.

KEEP: url_safety hard block (file://·loopback·metadata·CGNAT 등) 완화 금지 —
이 도구는 게이트를 *재사용*할 뿐 새 구멍을 내지 않는다.
"""
from __future__ import annotations

import asyncio

import pytest

from secu_agent.agent.tools import web_fetch_tool as wf_mod
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.agent.tools.web_fetch_tool import WebFetchTool, _html_to_text


def _run(payload, tmp_path):
    tool = WebFetchTool()
    ctx = ToolContext(evidence_dir=tmp_path)
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def _run_with_ctx(payload, tmp_path):
    tool = WebFetchTool()
    ctx = ToolContext(evidence_dir=tmp_path)
    res = asyncio.run(tool.execute(tool.input_model(**payload), ctx))
    return res, ctx


@pytest.fixture(autouse=True)
def _no_scope(monkeypatch):
    for k in ("SA_WEB_ALLOWED_DOMAINS", "SA_WEB_ALLOWED_CIDRS",
              "WEB_ALLOWED_DOMAINS", "WEB_ALLOWED_CIDRS",
              "SA_WEB_REQUIRE_SCOPE"):
        monkeypatch.delenv(k, raising=False)


# ── url_safety 게이트 (KEEP — 완화 금지) ─────────────────────────────


@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:8080/",
    "http://100.64.1.1/",          # CGNAT
])
def test_hard_blocked_urls_rejected(url, tmp_path):
    res = _run({"url": url}, tmp_path)
    assert isinstance(res, ToolError)
    assert res.kind == "permission"


def test_hard_block_runs_before_optional_transport(tmp_path, monkeypatch):
    def fake(_url, *, impersonate):
        raise AssertionError("transport must not run for hard-blocked URL")

    monkeypatch.setattr(wf_mod, "_fetch_curl_cffi_sync", fake)

    res = _run(
        {
            "url": "http://169.254.169.254/latest/meta-data/",
            "transport": "curl_cffi",
        },
        tmp_path,
    )

    assert isinstance(res, ToolError)
    assert res.kind == "permission"


def test_scope_enforced_when_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "corp.example.com")
    res = _run({"url": "http://outside.example.net/x"}, tmp_path)
    assert isinstance(res, ToolError)
    assert "scope" in res.message


# ── fetch 동작 (HTTP 모킹) ───────────────────────────────────────────


def _patch_fetch(monkeypatch, status, headers, body: bytes):
    def fake(url):
        return status, headers, body
    monkeypatch.setattr(wf_mod, "_fetch_sync", fake)


def test_html_text_extraction(tmp_path, monkeypatch):
    html = (b"<html><head><script>evil()</script><style>.x{}</style></head>"
            b"<body><h1>Title</h1><p>Hello <b>World</b></p>"
            b"<!-- comment --></body></html>")
    _patch_fetch(monkeypatch, 200, {"content-type": "text/html"}, html)
    res = _run({"url": "http://corp.example.com/page"}, tmp_path)
    assert isinstance(res, ToolSuccess)
    assert "Title" in res.content and "Hello World" in res.content
    assert "evil()" not in res.content and "comment" not in res.content


def test_response_classifier_marks_waf_like_challenge(tmp_path, monkeypatch):
    body = b"<html><body><div id='cf-chl-widget'>Checking your browser</div></body></html>"
    _patch_fetch(monkeypatch, 403, {"content-type": "text/html"}, body)

    res, ctx = _run_with_ctx(
        {"url": "http://corp.example.com/page", "strategy": "adaptive"},
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    assert "strategy=adaptive" in res.content
    assert "verdict=suspect_challenge" in res.content
    assert "challenge_marker:cf-chl-" in res.content
    traces = ctx.metadata[wf_mod._WEB_FETCH_TRACE_METADATA_KEY]
    assert traces[-1]["strategy"] == "adaptive"
    assert traces[-1]["assessment"]["verdict"] == "suspect_challenge"


def test_soft_challenge_words_do_not_override_real_200_content(tmp_path, monkeypatch):
    body = (
        b"<html><body><article>"
        b"This internal documentation explains why an access denied message can "
        b"appear during normal authorization testing. It is not a challenge page."
        b"</article></body></html>"
    )
    _patch_fetch(monkeypatch, 200, {"content-type": "text/html"}, body)

    res = _run({"url": "http://corp.example.com/docs"}, tmp_path)

    assert isinstance(res, ToolSuccess)
    assert "verdict=weak_ok" in res.content
    assert "soft_challenge_marker:access denied" in res.content
    assert "verdict=suspect_challenge" not in res.content


def test_empty_json_is_ambiguous_not_terminal_success(tmp_path, monkeypatch):
    calls = []

    def fake(url):
        calls.append(url)
        if url == "http://www.corp.example.com/api":
            return 200, {"content-type": "application/json"}, b"{}"
        if url == "http://m.corp.example.com/api":
            return 200, {"content-type": "application/json"}, b'{"ok": true}'
        raise AssertionError(f"unexpected fetch url: {url}")

    monkeypatch.setattr(wf_mod, "_fetch_sync", fake)

    res, ctx = _run_with_ctx(
        {
            "url": "http://www.corp.example.com/api",
            "strategy": "adaptive",
            "max_attempts": 3,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    assert calls == [
        "http://www.corp.example.com/api",
        "http://m.corp.example.com/api",
    ]
    assert "verdict=json_ok" in res.content
    assert "json_non_empty" in res.content
    traces = ctx.metadata[wf_mod._WEB_FETCH_TRACE_METADATA_KEY]
    assert traces[0]["assessment"]["verdict"] == "suspect_ok"
    assert traces[0]["selected"] is False
    assert traces[1]["selected"] is True


@pytest.mark.parametrize("status,verdict", [
    (401, "auth_required"),
    (404, "not_found"),
    (429, "rate_limited"),
])
def test_terminal_status_takes_priority_over_challenge_markers(
    tmp_path, monkeypatch, status, verdict,
):
    _patch_fetch(
        monkeypatch,
        status,
        {"content-type": "text/html"},
        b"<html><body><div id='cf-chl-widget'>Checking your browser</div></body></html>",
    )

    res, ctx = _run_with_ctx(
        {
            "url": "http://corp.example.com/page",
            "strategy": "adaptive",
            "max_attempts": 3,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    assert f"verdict={verdict}" in res.content
    traces = ctx.metadata[wf_mod._WEB_FETCH_TRACE_METADATA_KEY]
    assert len(traces) == 1
    assert traces[0]["assessment"]["verdict"] == verdict


def test_curl_cffi_transport_uses_optional_fetcher(tmp_path, monkeypatch):
    calls = []

    def fake(url, *, impersonate):
        calls.append((url, impersonate))
        return 200, {"content-type": "application/json"}, b'{"transport": "curl"}'

    monkeypatch.setattr(wf_mod, "_fetch_curl_cffi_sync", fake)

    res, ctx = _run_with_ctx(
        {
            "url": "http://corp.example.com/api",
            "transport": "curl_cffi",
            "impersonate": "chrome",
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    assert calls == [("http://corp.example.com/api", "chrome")]
    assert "transport=curl_cffi" in res.content
    trace = ctx.metadata[wf_mod._WEB_FETCH_TRACE_METADATA_KEY][-1]
    assert trace["transport"] == "curl_cffi"
    assert trace["selected"] is True


def test_curl_cffi_transport_missing_dependency_is_io_error(tmp_path, monkeypatch):
    def fake(_url, *, impersonate):
        raise wf_mod.WebFetchTransportError(f"missing for {impersonate}")

    monkeypatch.setattr(wf_mod, "_fetch_curl_cffi_sync", fake)

    res = _run(
        {
            "url": "http://corp.example.com/api",
            "transport": "curl_cffi",
            "impersonate": "safari",
        },
        tmp_path,
    )

    assert isinstance(res, ToolError)
    assert res.kind == "io_error"
    assert "missing for safari" in res.message


def test_adaptive_trace_detects_waf_profile_and_untried_routes(tmp_path, monkeypatch):
    _patch_fetch(
        monkeypatch,
        403,
        {
            "content-type": "text/html",
            "server": "cloudflare",
            "cf-ray": "abc123",
            "set-cookie": "__cf_bm=1; Path=/; Secure",
        },
        b"<html><title>Just a moment...</title>Checking your browser</html>",
    )

    res, ctx = _run_with_ctx(
        {"url": "http://corp.example.com/page", "strategy": "adaptive"},
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    assert "waf_profile=cloudflare_turnstile" in res.content
    assert "capabilities_needed=needs_js_exec" in res.content
    assert "browser_supervisor(action='api_candidates')" in res.content
    assessment = ctx.metadata[wf_mod._WEB_FETCH_TRACE_METADATA_KEY][-1]["assessment"]
    assert assessment["waf_detections"][0]["profile_id"] == "cloudflare_turnstile"
    assert assessment["waf_detections"][0]["confidence"] == 0.9
    assert assessment["must_use_browser"] is True
    assert any(item["route"] == "browser_supervisor" for item in assessment["retry_plan"])


def test_adaptive_retry_plan_marks_scope_blocked_url_transforms(
    tmp_path, monkeypatch,
):
    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "www.corp.example.com")
    _patch_fetch(
        monkeypatch,
        403,
        {"content-type": "text/html"},
        b"<html><body>Access denied</body></html>",
    )

    res, ctx = _run_with_ctx(
        {"url": "http://www.corp.example.com/page", "strategy": "adaptive"},
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    assessment = ctx.metadata[wf_mod._WEB_FETCH_TRACE_METADATA_KEY][-1]["assessment"]
    mobile = next(
        item for item in assessment["retry_plan"]
        if item.get("transform") == "mobile_subdomain"
    )
    assert mobile["url"] == "http://m.corp.example.com/page"
    assert mobile["allowed_by_scope"] is False
    assert "outside allowed web scope" in mobile["blocked_reason"]


def test_adaptive_strategy_fetches_allowed_url_transform_until_success(
    tmp_path, monkeypatch,
):
    calls = []

    def fake(url):
        calls.append(url)
        if url == "http://www.corp.example.com:8443/page":
            return 403, {"content-type": "text/html"}, b"<html><body>Access denied</body></html>"
        if url == "http://m.corp.example.com:8443/page":
            return (
                200,
                {"content-type": "text/html"},
                b"<html><body><p>Mobile page contains enough real visible "
                b"content to count as a clean fallback response.</p></body></html>",
            )
        raise AssertionError(f"unexpected fetch url: {url}")

    monkeypatch.setattr(wf_mod, "_fetch_sync", fake)

    res, ctx = _run_with_ctx(
        {
            "url": "http://www.corp.example.com:8443/page",
            "strategy": "adaptive",
            "max_attempts": 3,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    assert calls == [
        "http://www.corp.example.com:8443/page",
        "http://m.corp.example.com:8443/page",
    ]
    assert "http://www.corp.example.com:8443/page ⇒ http://m.corp.example.com:8443/page" in res.content
    assert "adaptive_attempts=2" in res.content
    assert "selected_transform=mobile_subdomain" in res.content
    assert "clean fallback response" in res.content
    traces = ctx.metadata[wf_mod._WEB_FETCH_TRACE_METADATA_KEY]
    assert len(traces) == 2
    assert traces[0]["selected"] is False
    assert traces[1]["selected"] is True
    assert traces[1]["transform"] == "mobile_subdomain"


def test_raw_mode_returns_original(tmp_path, monkeypatch):
    html = b"<html><body><p>Raw</p></body></html>"
    _patch_fetch(monkeypatch, 200, {"content-type": "text/html"}, html)
    res = _run({"url": "http://corp.example.com/", "raw": True}, tmp_path)
    assert isinstance(res, ToolSuccess)
    assert "<p>Raw</p>" in res.content


def test_redirect_not_followed(tmp_path, monkeypatch):
    _patch_fetch(monkeypatch, 302,
                 {"location": "http://corp.example.com/next"}, b"")
    res = _run({"url": "http://corp.example.com/"}, tmp_path)
    assert isinstance(res, ToolSuccess)
    assert "302 redirect" in res.content
    assert "verdict=redirect" in res.content
    assert "http://corp.example.com/next" in res.content
    assert "자동 추적 안 함" in res.content


def test_body_truncation_flag(tmp_path, monkeypatch):
    big = b"a" * (wf_mod._MAX_BYTES + 100)
    _patch_fetch(monkeypatch, 200, {"content-type": "text/plain"}, big)
    res = _run({"url": "http://corp.example.com/big"}, tmp_path)
    assert isinstance(res, ToolSuccess)
    assert "truncated" in res.content


def test_html_to_text_helper():
    assert _html_to_text("<ul><li>a</li><li>b</li></ul>") == "a\nb"
    assert _html_to_text("x &amp; y") == "x & y"


def test_registered_in_operator_registry():
    from secu_agent.agent.tools import build_registry_for_task
    r = build_registry_for_task("operator")
    assert r.get("web_fetch") is not None
    assert r.get("deliver") is not None  # T2 도구도 함께 확인
