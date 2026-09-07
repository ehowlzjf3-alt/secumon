"""v3.24-D: Playwright browser tools 검증.

- 메타 + registry
- session start/stop/status state machine (실제 chromium headless)
- URL safety 통합 (navigate)
- secret-like fill 거부
- snapshot / html / screenshot 동작
"""
from __future__ import annotations

import asyncio
import http.server
import json
import os
import socketserver
import threading
import time
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.agent.tools.browser_tool import (
    BrowserActionTool, BrowserQueryTool, BrowserSessionTool, BrowserSupervisorTool,
    _BROWSER_CONSOLE_EVENTS, _BROWSER_DIALOG_EVENTS, _BROWSER_DOWNLOAD_EVENTS,
    _BROWSER_DYNAMIC_RESPONSE_EVENTS, _BROWSER_EVENTS, _BROWSER_FRAME_EVENTS,
    _BROWSER_NETWORK_EVENTS, _SESSION_STATE, _browser_health,
    _capture_dynamic_response_body, _looks_like_secret,
    _normalize_cookies, _resolve_session_state,
    _perform_login,
    _record_browser_console_event, _record_browser_dialog_event,
    _record_browser_dynamic_response_event,
    _record_browser_download_event, _record_browser_event,
    _record_browser_frame_event, _record_browser_network_event, _stop_session,
    _idle_timeout_seconds, _touch_session, reap_idle_session, shutdown_browser,
    _validate_browser_url_safe,
    _origin_of, _sso_idp_origins, _sso_origin_permitted, _is_adfs,
    _fetch_gate_decide,
)
from secu_agent.agent.tools.url_safety import URLSafetyError


# ============================================================
# 메타 + registry
# ============================================================

def test_browser_tools_metadata():
    assert BrowserSessionTool.is_destructive is True
    assert BrowserSessionTool.deferred is True
    assert BrowserSessionTool.domain == "web"
    assert BrowserActionTool.is_destructive is True
    assert BrowserActionTool.deferred is True
    assert BrowserQueryTool.is_read_only is True
    assert BrowserQueryTool.deferred is True
    assert BrowserSupervisorTool.is_read_only is True
    assert BrowserSupervisorTool.deferred is True
    assert BrowserSupervisorTool.domain == "web"


def test_browser_tools_registered_for_operator():
    from secu_agent.agent.tools import build_registry_for_task
    r = build_registry_for_task("operator")
    names = {t.name for t in r.all()}
    assert "browser_session" in names
    assert "browser_action" in names
    assert "browser_query" in names
    assert "browser_supervisor" in names


# ============================================================
# secret-like detection — fill 거부 가드
# ============================================================

@pytest.mark.parametrize("text,expected", [
    ("sk-abcdefghijklmnop", True),
    ("ghp_abcdefghijklmnop", True),
    ("Bearer eyJfoo", True),
    ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload", True),
    ("AKIAIOSFODNN7EXAMPLE", True),
    ("hello world", False),
    ("samsung1234", False),
    ("", False),
])
def test_looks_like_secret(text, expected):
    assert _looks_like_secret(text) == expected


# ============================================================
# status / session — playwright 미사용 (no start)
# ============================================================

def _ctx(tmp_path: Path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path, metadata={"charter_ref": "TH-TEST"})


def test_status_when_not_running(tmp_path):
    # 안전을 위해 사전 정리
    asyncio.run(_stop_session())
    res = asyncio.run(BrowserSessionTool().execute(
        BrowserSessionTool.input_model(action="status"), _ctx(tmp_path),
    ))
    assert isinstance(res, ToolSuccess)
    assert "running=False" in res.content


def test_action_without_session_returns_not_started(tmp_path):
    asyncio.run(_stop_session())
    res = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="navigate", url="https://example.com"),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolError)
    assert res.kind == "not_started"


def test_query_without_session_returns_not_started(tmp_path):
    asyncio.run(_stop_session())
    res = asyncio.run(BrowserQueryTool().execute(
        BrowserQueryTool.input_model(action="url"), _ctx(tmp_path),
    ))
    assert isinstance(res, ToolError)
    assert res.kind == "not_started"


def test_browser_url_test_mode_allows_loopback_only_when_explicit(monkeypatch):
    with pytest.raises(URLSafetyError):
        _validate_browser_url_safe("http://127.0.0.1:8123/")

    monkeypatch.setenv("SA_BROWSER_ALLOW_LOOPBACK_FOR_TESTS", "true")
    _validate_browser_url_safe("http://127.0.0.1:8123/")
    _validate_browser_url_safe("http://localhost:8123/")

    with pytest.raises(URLSafetyError):
        _validate_browser_url_safe("file:///etc/passwd")


def test_browser_url_scope_uses_shared_web_policy(monkeypatch):
    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "allowed.example")

    _validate_browser_url_safe("https://app.allowed.example/")

    with pytest.raises(URLSafetyError):
        _validate_browser_url_safe("https://blocked.example/")


def test_default_login_is_skipped_without_opt_in(monkeypatch):
    class _Page:
        url = "https://example.com/login"

        async def query_selector_all(self, _selector):
            return []

    async def _should_not_attempt(*_a, **_k):
        raise AssertionError("default credential login should require explicit opt-in")

    monkeypatch.delenv("SA_WEB_DEFAULT_CREDS_ENABLED", raising=False)
    monkeypatch.setattr(
        "secu_agent.agent.tools.browser_tool._attempt_login",
        _should_not_attempt,
    )

    ok, msg, fatal = asyncio.run(_perform_login(_Page(), "auto"))

    assert ok is False
    assert fatal is False
    assert "skipped" in msg.lower()
    assert "SA_WEB_DEFAULT_CREDS_ENABLED" in msg


def test_default_login_can_be_enabled_explicitly(monkeypatch):
    class _Page:
        url = "https://example.com/login"

        async def query_selector_all(self, _selector):
            return []

    calls = []

    async def _attempt(_page, creds, *, count_breaker=True, origin_guard=None):
        calls.append((creds, count_breaker))
        return False, "attempted"

    monkeypatch.setenv("SA_WEB_DEFAULT_CREDS_ENABLED", "true")
    monkeypatch.setenv("SA_WEB_DEFAULT_CREDS", "probe-user:probe-pass")
    monkeypatch.setattr(
        "secu_agent.agent.tools.browser_tool._attempt_login",
        _attempt,
    )

    ok, msg, fatal = asyncio.run(_perform_login(_Page(), "defaults"))

    assert ok is False
    assert msg == "attempted"
    assert fatal is False
    assert calls == [([("probe-user", "probe-pass")], False)]


# ============================================================
# Slice3 Part B: login origin 재검증 (SSO 자격 fill 前)
# ============================================================

def test_origin_of_normalizes_and_strips_userinfo():
    assert _origin_of("https://IdP.Example.com/adfs") == "https://idp.example.com"
    assert _origin_of("https://idp.example.com:8443/x") == "https://idp.example.com:8443"
    # userinfo(user@) 는 host 로 취급 안 함 — 스푸핑 방지
    assert _origin_of("https://idp.example.com@evil.example/") == "https://evil.example"
    assert _origin_of("secsso.example.com") == "https://secsso.example.com"  # 스킴없음→https
    assert _origin_of("") == ""
    assert _origin_of("not a url") == ""


def test_sso_idp_origins_env_parse(monkeypatch):
    monkeypatch.setenv(
        "SA_WEB_SSO_IDP_ORIGINS",
        "https://secsso.example.com, adfs.example.com ,  ",
    )
    got = _sso_idp_origins()
    assert got == frozenset({"https://secsso.example.com", "https://adfs.example.com"})
    monkeypatch.delenv("SA_WEB_SSO_IDP_ORIGINS", raising=False)
    assert _sso_idp_origins() == frozenset()


def test_sso_origin_permitted_allowlist_exact(monkeypatch):
    monkeypatch.setenv("SA_WEB_SSO_IDP_ORIGINS", "https://secsso.example.com")
    ok, _ = _sso_origin_permitted("https://secsso.example.com/adfs/ls")
    assert ok is True
    # 부분문자열은 통과하던 피싱 origin — exact allowlist 로 차단
    ok2, why2 = _sso_origin_permitted("https://evil.example/adfs/ls")
    assert ok2 is False and "허용 IdP origin" in why2


def test_sso_origin_permitted_unset_is_backward_compat(monkeypatch):
    monkeypatch.delenv("SA_WEB_SSO_IDP_ORIGINS", raising=False)
    ok, why = _sso_origin_permitted("https://anything.example/adfs")
    assert ok is True and "후방호환" in why


def test_sso_origin_permitted_malformed_allowlist_fail_closed(monkeypatch):
    # ★ codex 높음: raw 설정됐으나 유효 origin 0개(",")면 후방호환 아니라 fail-closed
    for bad in (",", "not a url", "http://x , http://y"):  # http 항목은 https floor 로 탈락
        monkeypatch.setenv("SA_WEB_SSO_IDP_ORIGINS", bad)
        ok, why = _sso_origin_permitted("https://evil.example/adfs")
        assert ok is False and "0개" in why, bad


def test_sso_idp_origins_https_floor(monkeypatch):
    # http 항목은 무시(실 SSO 자격 평문 방지) — https 만 채택
    monkeypatch.setenv("SA_WEB_SSO_IDP_ORIGINS", "http://idp.example, https://idp.example")
    assert _sso_idp_origins() == frozenset({"https://idp.example"})


def test_sso_origin_permitted_https_floor_rejects_http_landing(monkeypatch):
    monkeypatch.setenv("SA_WEB_SSO_IDP_ORIGINS", "https://idp.example")
    # landing 이 http 면(scope 미설정이라 url_safety 는 통과) HTTPS floor 로 거부
    ok, why = _sso_origin_permitted("http://idp.example/adfs")
    assert ok is False and "HTTPS floor" in why


def test_origin_of_ipv6_brackets():
    assert _origin_of("https://[2001:db8::1]:8443/x") == "https://[2001:db8::1]:8443"
    # bracket 없는 IPv6 도 복원돼 8443 이 host 로 흡수되는 collision 방지
    assert _origin_of("https://[2001:db8::1]/x") == "https://[2001:db8::1]"


def test_origin_of_rejects_backslash():
    assert _origin_of("https://idp.example\\@evil.example/") == ""


def test_sso_origin_permitted_hardblock_wins(monkeypatch):
    # allowlist 에 넣어도 loopback/metadata 하드블록은 origin 에도 성립해야 함
    monkeypatch.delenv("SA_BROWSER_ALLOW_LOOPBACK_FOR_TESTS", raising=False)
    monkeypatch.setenv("SA_WEB_SSO_IDP_ORIGINS", "http://127.0.0.1:8443")
    ok, why = _sso_origin_permitted("http://127.0.0.1:8443/adfs")
    assert ok is False and "url_safety" in why


def test_perform_login_blocks_fill_on_phishing_origin(monkeypatch):
    class _Page:
        url = "https://evil.example/adfs/ls"

        async def query_selector_all(self, _selector):
            return []

    async def _must_not_attempt(*_a, **_k):
        raise AssertionError("피싱 origin 에 실계정 자격을 fill 하면 안 됨")

    monkeypatch.setenv("SA_WEB_SSO_USER", "realuser")
    monkeypatch.setenv("SA_WEB_SSO_PASS", "realpass")
    monkeypatch.setenv("SA_WEB_SSO_IDP_ORIGINS", "https://secsso.example.com")
    monkeypatch.setattr(
        "secu_agent.agent.tools.browser_tool._attempt_login", _must_not_attempt,
    )
    ok, msg, fatal = asyncio.run(_perform_login(_Page(), "sso"))
    assert ok is False and fatal is False
    assert "fill 차단" in msg


def test_perform_login_allows_fill_on_allowed_idp(monkeypatch):
    class _Page:
        url = "https://secsso.example.com/adfs/ls"

        async def query_selector_all(self, _selector):
            return []

    calls = []

    async def _attempt(_page, creds, *, count_breaker=True, origin_guard=None):
        calls.append((creds, count_breaker))
        return True, "ok"

    monkeypatch.setenv("SA_WEB_SSO_USER", "realuser")
    monkeypatch.setenv("SA_WEB_SSO_PASS", "realpass")
    monkeypatch.setenv("SA_WEB_SSO_IDP_ORIGINS", "https://secsso.example.com")
    monkeypatch.setattr(
        "secu_agent.agent.tools.browser_tool._attempt_login", _attempt,
    )
    ok, msg, fatal = asyncio.run(_perform_login(_Page(), "sso"))
    assert ok is True
    assert calls == [([("realuser", "realpass")], True)]


# ============================================================
# Slice3 Part A: navigate redirect 사전차단 (CDP Fetch 게이트 decision)
# page.route 는 redirect hop 에 재발화 안 함(실측) → CDP Fetch.requestPaused 로 매 hop 검사.
# 여기선 결정 함수(_fetch_gate_decide)를 단위검증하고, 실 redirect 차단은 integration 테스트로.
# ============================================================

def test_fetch_gate_blocks_document_to_metadata(monkeypatch):
    monkeypatch.delenv("SA_BROWSER_ALLOW_LOOPBACK_FOR_TESTS", raising=False)
    block, reason = asyncio.run(
        _fetch_gate_decide("http://169.254.169.254/latest/meta-data/", "Document"))
    assert block is True and reason


def test_fetch_gate_blocks_document_off_scope(monkeypatch):
    # scope 설정 시 Document 는 off-scope redirect 도 차단(full url_safety)
    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "allowed.example")
    block, _ = asyncio.run(_fetch_gate_decide("https://evil.example/x", "Document"))
    assert block is True


def test_fetch_gate_allows_safe_document(monkeypatch):
    monkeypatch.delenv("SA_WEB_ALLOWED_DOMAINS", raising=False)
    monkeypatch.delenv("SA_WEB_REQUIRE_SCOPE", raising=False)
    block, _ = asyncio.run(_fetch_gate_decide("https://example.com/next", "Document"))
    assert block is False


def test_fetch_gate_subresource_hardblock_default(monkeypatch):
    # 기본: 비-Document(subresource)는 하드블록만(DNS 없이) — metadata IP 리터럴은 차단
    monkeypatch.delenv("SA_BROWSER_ALLOW_LOOPBACK_FOR_TESTS", raising=False)
    monkeypatch.delenv("SA_WEB_SUBRESOURCE_DNS_CHECK", raising=False)
    block, _ = asyncio.run(_fetch_gate_decide("http://169.254.169.254/x", "Image"))
    assert block is True
    # off-scope 정상 외부자원은 subresource 로는 통과(scope 미적용 → 오차단 방지)
    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "allowed.example")
    block2, _ = asyncio.run(_fetch_gate_decide("https://cdn.example/lib.js", "Script"))
    assert block2 is False


def test_fetch_gate_subresource_dns_optin(monkeypatch):
    # opt-in: SA_WEB_SUBRESOURCE_DNS_CHECK=true 면 subresource 도 DNS 재바인딩 검사(강화)
    monkeypatch.setenv("SA_WEB_SUBRESOURCE_DNS_CHECK", "true")
    monkeypatch.delenv("SA_BROWSER_ALLOW_LOOPBACK_FOR_TESTS", raising=False)
    block, _ = asyncio.run(_fetch_gate_decide("http://169.254.169.254/x", "Image"))
    assert block is True


def test_origin_of_default_ports_normalized():
    # codex 라운드4 #7: https://idp:443 == https://idp, http://x:80 == http://x
    assert _origin_of("https://idp.example.com:443/adfs") == "https://idp.example.com"
    assert _origin_of("http://idp.example.com:80/") == "http://idp.example.com"
    assert _origin_of("https://idp.example.com:8443/") == "https://idp.example.com:8443"  # 비기본 유지


def test_cdp_gate_blocks_redirect_to_metadata_real_browser(monkeypatch):
    """실 chromium: in-scope loopback 페이지가 302→metadata 로 튕겨도 CDP Fetch 게이트가
    요청 前 차단(request_blocked 이벤트). page.route 로는 못 잡던 redirect hop 검증."""
    import http.server as _h
    import socketserver as _s
    from secu_agent.agent.tools import browser_tool as _bt

    monkeypatch.setenv("SA_BROWSER_ALLOW_LOOPBACK_FOR_TESTS", "true")
    monkeypatch.delenv("SA_WEB_ALLOWED_DOMAINS", raising=False)
    monkeypatch.delenv("SA_WEB_REQUIRE_SCOPE", raising=False)
    target = "http://169.254.169.254/latest/meta-data/"

    class _Handler(_h.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", target)
            self.end_headers()

        def log_message(self, *a):
            pass

    holder = []
    ev = threading.Event()

    def _serve():
        with _s.TCPServer(("127.0.0.1", 0), _Handler) as httpd:
            holder.append(httpd.server_address[1])
            ev.set()
            httpd.serve_forever()

    threading.Thread(target=_serve, daemon=True).start()
    assert ev.wait(5)
    port = holder[0]

    async def _run():
        try:
            from playwright.async_api import async_playwright
        except Exception:
            pytest.skip("playwright 미설치")
        pw = await async_playwright().start()
        try:
            browser = await pw.chromium.launch(headless=True)
        except Exception:
            await pw.stop()
            pytest.skip("chromium 미설치")
        ctx = await browser.new_context(ignore_https_errors=True)
        page = await ctx.new_page()
        page.set_default_timeout(8000)
        await _bt._install_fetch_gate(page)
        _bt._BROWSER_EVENTS.clear()
        try:
            await page.goto(f"http://127.0.0.1:{port}/start", wait_until="domcontentloaded")
        except Exception:
            pass  # ERR_BLOCKED_BY_CLIENT 기대
        finally:
            blocked = [e for e in _bt._BROWSER_EVENTS
                       if e.get("action") == "request_blocked"
                       and "169.254.169.254" in str(e.get("url", ""))]
            _bt._SESSION_STATE["cdp_gates"] = []
            await browser.close()
            await pw.stop()
        return blocked

    blocked = asyncio.run(_run())
    assert blocked, "redirect hop to metadata was NOT blocked by CDP gate"


def test_browser_event_ring_is_bounded_and_ordered():
    _BROWSER_EVENTS.clear()
    for i in range(105):
        _record_browser_event(
            kind="action",
            action="navigate",
            ok=True,
            message=f"event-{i}",
            url=f"https://example.com/{i}",
        )

    assert len(_BROWSER_EVENTS) == 100
    assert _BROWSER_EVENTS[0]["message"] == "event-5"
    assert _BROWSER_EVENTS[-1]["message"] == "event-104"
    assert _BROWSER_EVENTS[-1]["action"] == "navigate"
    assert _BROWSER_EVENTS[-1]["ok"] is True


def test_browser_network_event_redacts_url_secrets():
    _BROWSER_NETWORK_EVENTS.clear()
    _record_browser_network_event(
        phase="request",
        url="https://example.com/login?token=secret-token&q=hello",
        method="GET",
        resource_type="document",
    )

    event = _BROWSER_NETWORK_EVENTS[-1]
    assert "secret-token" not in json.dumps(event)
    assert event["url"] == "https://example.com/login?token=%3Credacted%3E&q=hello"


def test_supervisor_api_candidates_summarizes_network_and_dynamic_events(tmp_path):
    _BROWSER_NETWORK_EVENTS.clear()
    _BROWSER_DYNAMIC_RESPONSE_EVENTS.clear()
    _record_browser_network_event(
        phase="request",
        url="https://app.example.test/api/session?token=secret-token",
        method="GET",
        resource_type="fetch",
    )
    _record_browser_network_event(
        phase="response",
        url="https://app.example.test/assets/app.js",
        method="GET",
        status=200,
        resource_type="script",
    )
    _record_browser_dynamic_response_event(
        url="https://app.example.test/graphql",
        method="POST",
        status=200,
        resource_type="fetch",
        content_type="application/json",
        body_length=24,
        bytes_scanned=24,
        body_truncated=False,
        body_sha256="abc123",
        body_sample_masked='{"data": {"ok": true}}',
        scan_hits=[{"kind": "token", "masked": "<redacted>"}],
        body_path=str(tmp_path / "graphql.json"),
    )

    res = asyncio.run(BrowserSupervisorTool().execute(
        BrowserSupervisorTool.input_model(action="api_candidates"), _ctx(tmp_path),
    ))

    assert isinstance(res, ToolSuccess)
    assert "secret-token" not in res.content
    payload = json.loads(res.content)
    assert payload["summary"]["total"] == 2
    urls = {item["url"] for item in payload["candidates"]}
    assert "https://app.example.test/api/session?token=%3Credacted%3E" in urls
    assert "https://app.example.test/graphql" in urls
    session = next(item for item in payload["candidates"] if "/api/session" in item["url"])
    assert session["candidate_reasons"] == ["path_api"]
    graphql = next(item for item in payload["candidates"] if item["url"].endswith("/graphql"))
    assert graphql["method"] == "POST"
    assert set(graphql["candidate_reasons"]) == {"path_graphql", "fetch_json"}
    assert graphql["scan_hit_count"] == 1
    assert payload["summary"]["by_reason"]["path_api"] == 1
    assert payload["summary"]["by_reason"]["path_graphql"] == 1


def test_dynamic_response_capture_small_body_file_scans_and_masks(tmp_path):
    secret = "AKIA3MJ7QK2PLZ9WD4XR"
    email = "jane@example.com"
    body = json.dumps({"token": secret, "user": email}).encode()

    class _Request:
        url = "https://app.example.test/api/session"
        method = "GET"
        resource_type = "fetch"

    class _Response:
        url = "https://app.example.test/api/session"
        status = 200
        request = _Request()

        def __init__(self):
            self.headers = {"content-type": "application/json", "content-length": str(len(body))}
            self.body_called = False

        async def body(self):
            self.body_called = True
            return body

    class _Page:
        url = "https://app.example.test/dashboard"

    response = _Response()
    _BROWSER_DYNAMIC_RESPONSE_EVENTS.clear()
    asyncio.run(_capture_dynamic_response_body(_Page(), response, evidence_dir=tmp_path))

    assert response.body_called is True
    event = _BROWSER_DYNAMIC_RESPONSE_EVENTS[-1]
    body_path = Path(event["body_path"])
    assert body_path.is_file()
    assert body_path.read_bytes() == body
    assert event["bytes_scanned"] == len(body)
    assert event["body_truncated"] is False
    assert any(h["kind"] == "aws_access_key_id" for h in event["scan_hits"])
    surfaced = json.dumps(event, ensure_ascii=False)
    assert secret not in surfaced
    assert email not in surfaced


def test_dynamic_response_capture_large_body_finds_deep_secret_via_file_scan(tmp_path, monkeypatch):
    monkeypatch.setenv("SA_BROWSER_DYNAMIC_RESPONSE_BODY_CEILING_BYTES", str(1024 * 1024))
    secret = "AKIA3MJ7QK2PLZ9WD4XR"
    body = (b"a" * (300 * 1024)) + f"\nfinal_token={secret}\n".encode()

    class _Request:
        url = "https://app.example.test/api/large"
        method = "GET"
        resource_type = "fetch"

    class _Response:
        url = "https://app.example.test/api/large"
        status = 200
        request = _Request()

        def __init__(self):
            self.headers = {"content-type": "text/plain", "content-length": str(len(body))}
            self.body_called = False

        async def body(self):
            self.body_called = True
            return body

    class _Page:
        url = "https://app.example.test/dashboard"

    response = _Response()
    _BROWSER_DYNAMIC_RESPONSE_EVENTS.clear()
    asyncio.run(_capture_dynamic_response_body(_Page(), response, evidence_dir=tmp_path))

    event = _BROWSER_DYNAMIC_RESPONSE_EVENTS[-1]
    body_path = Path(event["body_path"])
    assert response.body_called is True
    assert body_path.is_file()
    assert body_path.stat().st_size == len(body)
    assert event["bytes_scanned"] == len(body)
    assert event["body_truncated"] is False
    assert event["scan_hits"]
    assert any(h["kind"] == "aws_access_key_id" for h in event["scan_hits"])
    surfaced = json.dumps(event, ensure_ascii=False)
    assert secret not in surfaced
    for hit in event["scan_hits"]:
        assert secret not in hit["line_preview"]


def test_dynamic_response_capture_masks_pii_credentials_and_urls_in_surfaces(tmp_path):
    password = "plain-password-value"
    api_key = "plain-api-key-value"
    token = "url-token-value-12345"
    sig = "url-signature-value-67890"
    name = "Jane Doe"
    phone = "010-1234-5678"
    address = "129 Samsung-ro, Yeongtong-gu, Suwon-si, Gyeonggi-do"
    body = json.dumps({
        "password": password,
        "api_key": api_key,
        "name": name,
        "phone": phone,
        "address": address,
        "callback": f"https://user:pass@host.example/p?token={token}&sig={sig}&q=ok",
    }).encode()

    class _Request:
        url = "https://app.example.test/api/customer"
        method = "GET"
        resource_type = "fetch"

    class _Response:
        url = "https://app.example.test/api/customer"
        status = 200
        request = _Request()

        def __init__(self):
            self.headers = {"content-type": "application/json", "content-length": str(len(body))}

        async def body(self):
            return body

    class _Page:
        url = "https://app.example.test/dashboard"

    _BROWSER_DYNAMIC_RESPONSE_EVENTS.clear()
    asyncio.run(_capture_dynamic_response_body(_Page(), _Response(), evidence_dir=tmp_path))

    event = _BROWSER_DYNAMIC_RESPONSE_EVENTS[-1]
    surfaced = json.dumps(event, ensure_ascii=False)
    for raw in (password, api_key, token, sig, name, phone, address, "user:pass@"):
        assert raw not in surfaced
    assert event["body_sample_masked"]
    assert event["scan_hits"]
    assert {h["kind"] for h in event["scan_hits"]} >= {
        "person_name_with_label",
        "kr_phone",
        "address_with_label",
    }
    for hit in event["scan_hits"]:
        assert name not in hit["line_preview"]
        assert phone not in hit["line_preview"]
        assert address not in hit["line_preview"]

    res = asyncio.run(BrowserSupervisorTool().execute(
        BrowserSupervisorTool.input_model(action="events"), _ctx(tmp_path),
    ))
    assert isinstance(res, ToolSuccess)
    for raw in (password, api_key, token, sig, name, phone, address, "user:pass@"):
        assert raw not in res.content


def test_dynamic_response_capture_skips_body_over_ceiling_without_materializing(
    tmp_path, monkeypatch,
):
    monkeypatch.setenv("SA_BROWSER_DYNAMIC_RESPONSE_BODY_CEILING_BYTES", "1024")

    class _Request:
        url = "https://app.example.test/api/huge"
        method = "GET"
        resource_type = "fetch"

    class _Response:
        url = "https://app.example.test/api/huge"
        status = 200
        request = _Request()
        headers = {"content-type": "application/json", "content-length": "4096"}

        def __init__(self):
            self.body_called = False

        async def body(self):
            self.body_called = True
            return b"a" * 4096

    class _Page:
        url = "https://app.example.test/dashboard"

    response = _Response()
    _BROWSER_DYNAMIC_RESPONSE_EVENTS.clear()
    asyncio.run(_capture_dynamic_response_body(_Page(), response, evidence_dir=tmp_path))

    assert response.body_called is False
    event = _BROWSER_DYNAMIC_RESPONSE_EVENTS[-1]
    assert "body_path" not in event
    assert event["bytes_scanned"] == 0
    assert event["body_truncated"] is True
    assert "content-length exceeds capture ceiling" in event["capture_error"]


def test_dynamic_response_capture_streams_to_file_up_to_ceiling(tmp_path, monkeypatch):
    monkeypatch.setenv("SA_BROWSER_DYNAMIC_RESPONSE_BODY_CEILING_BYTES", "1024")

    class _Stream:
        def __init__(self):
            self.remaining = 4096
            self.bytes_read = 0
            self.requests: list[int] = []

        async def read(self, n):
            self.requests.append(n)
            if self.remaining <= 0:
                return b""
            take = min(n, self.remaining)
            self.remaining -= take
            self.bytes_read += take
            return b"a" * take

    stream = _Stream()

    class _Request:
        url = "https://app.example.test/api/stream"
        method = "GET"
        resource_type = "fetch"

    class _Response:
        url = "https://app.example.test/api/stream"
        status = 200
        request = _Request()
        headers = {"content-type": "text/plain"}
        content = stream

        async def body(self):
            raise AssertionError("stream capture should not call body()")

    class _Page:
        url = "https://app.example.test/dashboard"

    _BROWSER_DYNAMIC_RESPONSE_EVENTS.clear()
    asyncio.run(_capture_dynamic_response_body(_Page(), _Response(), evidence_dir=tmp_path))

    event = _BROWSER_DYNAMIC_RESPONSE_EVENTS[-1]
    body_path = Path(event["body_path"])
    assert stream.bytes_read == 1024
    assert stream.requests == [1024]
    assert body_path.stat().st_size == 1024
    assert event["body_truncated"] is True
    assert event["bytes_scanned"] == 1024


def test_dynamic_response_capture_skips_cross_origin_fetch():
    class _Request:
        url = "https://other.example.test/api/session"
        method = "GET"
        resource_type = "xhr"

    class _Response:
        url = "https://other.example.test/api/session"
        status = 200
        request = _Request()
        headers = {"content-type": "application/json"}

        async def body(self):
            raise AssertionError("cross-origin body must not be read")

    class _Page:
        url = "https://app.example.test/dashboard"

    _BROWSER_DYNAMIC_RESPONSE_EVENTS.clear()
    asyncio.run(_capture_dynamic_response_body(_Page(), _Response()))

    assert list(_BROWSER_DYNAMIC_RESPONSE_EVENTS) == []


def test_supervisor_events_include_network_and_console_streams(tmp_path):
    _BROWSER_EVENTS.clear()
    _BROWSER_NETWORK_EVENTS.clear()
    _BROWSER_DYNAMIC_RESPONSE_EVENTS.clear()
    _BROWSER_CONSOLE_EVENTS.clear()
    _BROWSER_FRAME_EVENTS.clear()
    _BROWSER_DIALOG_EVENTS.clear()
    _BROWSER_DOWNLOAD_EVENTS.clear()
    _record_browser_event(kind="action", action="navigate", ok=True, message="ok")
    _record_browser_network_event(
        phase="response",
        url="https://example.com/app",
        method="GET",
        status=200,
        resource_type="document",
    )
    _record_browser_console_event(
        level="error",
        text="ReferenceError: missingThing is not defined",
        url="https://example.com/app",
    )
    _record_browser_frame_event(
        phase="navigated",
        url="https://example.com/app/frame",
        name="child",
        parent_url="https://example.com/app",
    )
    _record_browser_dialog_event(
        phase="opened",
        dialog_type="alert",
        message="Danger",
        default_value="",
        url="https://example.com/app",
    )
    _record_browser_download_event(
        phase="created",
        url="https://example.com/report.csv",
        suggested_filename="report.csv",
    )

    res = asyncio.run(BrowserSupervisorTool().execute(
        BrowserSupervisorTool.input_model(action="events"), _ctx(tmp_path),
    ))

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["events"][0]["action"] == "navigate"
    assert payload["network_events"][0]["status"] == 200
    assert payload["console_events"][0]["level"] == "error"
    assert payload["frame_events"][0]["name"] == "child"
    assert payload["dialog_events"][0]["type"] == "alert"
    assert payload["download_events"][0]["suggested_filename"] == "report.csv"


def test_closed_page_is_reported_as_stale_session(tmp_path):
    class _ClosedPage:
        url = "https://example.com/closed"

        def is_closed(self):
            return True

    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = _ClosedPage()
    health = _browser_health()

    assert health["running"] is True
    assert health["page_alive"] is False
    assert health["page_closed"] is True

    res = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="navigate", url="https://example.com"),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolError)
    assert res.kind == "stale_session"


def test_snapshot_stores_refs_and_actions_use_ref_selectors(tmp_path):
    class _Page:
        url = "https://example.com/app"

        def __init__(self):
            self.clicked = None
            self.filled = None
            self.pressed = None

        def is_closed(self):
            return False

        async def evaluate(self, _js, args):
            assert args.get("rootSelector") is None
            return json.dumps({
                "url": self.url,
                "title": "Example App",
                "text": "Hello Browser",
                "elements": [
                    {
                        "ref": "@e1",
                        "selector": "button#go",
                        "tag": "button",
                        "role": "button",
                        "label": "Go",
                    },
                    {
                        "ref": "@e2",
                        "selector": "input#q",
                        "tag": "input",
                        "role": "textbox",
                        "label": "Search",
                    },
                ],
            })

        async def click(self, selector):
            self.clicked = selector

        async def fill(self, selector, text):
            self.filled = (selector, text)

        async def press(self, selector, key):
            self.pressed = (selector, key)

    page = _Page()
    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = page

    snapshot = asyncio.run(BrowserQueryTool().execute(
        BrowserQueryTool.input_model(action="snapshot"),
        _ctx(tmp_path),
    ))
    assert isinstance(snapshot, ToolSuccess)
    assert "@e1 button role=button label=\"Go\"" in snapshot.content
    assert "@e2 input role=textbox label=\"Search\"" in snapshot.content
    assert _SESSION_STATE["ref_map"]["@e1"]["selector"] == "button#go"

    click = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="click", ref="@e1"),
        _ctx(tmp_path),
    ))
    assert isinstance(click, ToolSuccess)
    assert page.clicked == "button#go"

    fill = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="fill", ref="@e2", text="hello"),
        _ctx(tmp_path),
    ))
    assert isinstance(fill, ToolSuccess)
    assert page.filled == ("input#q", "hello")

    press = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="press", ref="@e2", key="Enter"),
        _ctx(tmp_path),
    ))
    assert isinstance(press, ToolSuccess)
    assert page.pressed == ("input#q", "Enter")


def test_ref_action_unknown_ref_returns_not_found(tmp_path):
    class _Page:
        url = "https://example.com/app"

        def is_closed(self):
            return False

    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = _Page()
    _SESSION_STATE["ref_map"] = {}

    res = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="click", ref="@e99"),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolError)
    assert res.kind == "not_found"
    assert "@e99" in res.message


def test_browser_action_eval_returns_bounded_json(tmp_path):
    class _Page:
        url = "https://example.com/app"

        def is_closed(self):
            return False

        async def evaluate(self, _js, expression):
            assert expression == "document.title"
            return {
                "type": "string",
                "value": "Example App",
                "json": True,
            }

    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = _Page()

    res = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="eval", expression="document.title"),
        _ctx(tmp_path),
    ))

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["type"] == "string"
    assert payload["value"] == "Example App"
    assert payload["truncated"] is False


def test_browser_action_eval_requires_expression(tmp_path):
    class _Page:
        url = "https://example.com/app"

        def is_closed(self):
            return False

    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = _Page()

    res = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="eval"),
        _ctx(tmp_path),
    ))

    assert isinstance(res, ToolError)
    assert res.kind == "validation"
    assert "expression" in res.message


def test_browser_query_screenshot_can_export_to_requested_dir(tmp_path):
    class _Page:
        url = "https://example.com/app"

        def is_closed(self):
            return False

        async def screenshot(self, *, path, full_page=False):
            assert full_page is False
            Path(path).write_bytes(b"fake-png")

    out_dir = tmp_path / "Documents"
    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = _Page()

    res = asyncio.run(BrowserQueryTool().execute(
        BrowserQueryTool.input_model(
            action="screenshot",
            output_dir=str(out_dir),
            filename_prefix="visit_samsungsemi",
        ),
        _ctx(tmp_path),
    ))

    assert isinstance(res, ToolSuccess)
    exported = list(out_dir.glob("visit_samsungsemi_*.png"))
    assert len(exported) == 1
    assert exported[0].read_bytes() == b"fake-png"
    assert "verified" in res.content
    assert str(exported[0]) in res.content


def test_browser_query_screenshot_custom_path_requires_approval(tmp_path):
    tool = BrowserQueryTool()
    vi = BrowserQueryTool.input_model(
        action="screenshot",
        output_path=str(tmp_path / "shot.png"),
    )

    decision = asyncio.run(tool.check_permission(vi, _ctx(tmp_path)))

    assert decision.behavior == "ask"
    assert "custom screenshot output path" in decision.reason


def test_supervisor_capture_writes_snapshot_html_network_console_and_diff(tmp_path):
    class _Element:
        async def inner_html(self):
            return "<h1>Hello Browser</h1>"

    class _Page:
        url = "https://example.com/app"
        screenshot_count = 0

        def is_closed(self):
            return False

        async def title(self):
            return "Example App"

        async def query_selector(self, selector):
            assert selector == "body"
            return _Element()

        async def evaluate(self, _js, args):
            assert args.get("rootSelector") is None
            return json.dumps({
                "url": self.url,
                "title": "Example App",
                "text": "Hello Browser",
                "elements": ["button#go [Go]"],
            })

        async def screenshot(self, *, path, full_page=False):
            assert full_page is False
            self.screenshot_count += 1
            Path(path).write_bytes(f"fake-png-{self.screenshot_count}".encode())

    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = _Page()
    _SESSION_STATE["last_screenshot"] = None
    _BROWSER_NETWORK_EVENTS.clear()
    _BROWSER_CONSOLE_EVENTS.clear()
    _BROWSER_FRAME_EVENTS.clear()
    _BROWSER_DIALOG_EVENTS.clear()
    _BROWSER_DOWNLOAD_EVENTS.clear()
    _record_browser_network_event(
        phase="request",
        url="https://example.com/app?password=do-not-store",
        method="GET",
        resource_type="document",
    )
    _record_browser_console_event(
        level="error",
        text="Console failure",
        url="https://example.com/app",
    )
    _record_browser_frame_event(
        phase="navigated",
        url="https://example.com/app/frame?token=do-not-store",
        name="child",
        parent_url="https://example.com/app",
    )
    _record_browser_dialog_event(
        phase="opened",
        dialog_type="confirm",
        message="Proceed?",
        default_value="",
        url="https://example.com/app",
    )
    _record_browser_download_event(
        phase="created",
        url="https://example.com/export?secret=do-not-store",
        suggested_filename="export.csv",
    )

    res = asyncio.run(BrowserSupervisorTool().execute(
        BrowserSupervisorTool.input_model(action="capture", include_screenshot=True),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)

    meta_path = Path(payload["metadata_path"])
    snapshot_path = Path(payload["snapshot_path"])
    html_path = Path(payload["html_path"])
    screenshot_path = Path(payload["screenshot_path"])
    network_path = Path(payload["network_path"])
    console_path = Path(payload["console_path"])
    diff_path = Path(payload["screenshot_diff_path"])
    frame_path = Path(payload["frame_path"])
    dialog_path = Path(payload["dialog_path"])
    download_path = Path(payload["download_path"])

    assert meta_path.exists()
    assert snapshot_path.read_text(encoding="utf-8").startswith("URL: https://example.com/app")
    assert html_path.read_text(encoding="utf-8") == "<h1>Hello Browser</h1>"
    assert screenshot_path.read_bytes() == b"fake-png-1"
    assert "do-not-store" not in network_path.read_text(encoding="utf-8")
    assert json.loads(console_path.read_text(encoding="utf-8"))["summary"]["errors"] == 1
    assert json.loads(diff_path.read_text(encoding="utf-8"))["changed"] is None
    assert "do-not-store" not in frame_path.read_text(encoding="utf-8")
    assert json.loads(frame_path.read_text(encoding="utf-8"))["summary"]["total"] == 1
    assert json.loads(dialog_path.read_text(encoding="utf-8"))["summary"]["by_type"]["confirm"] == 1
    assert "do-not-store" not in download_path.read_text(encoding="utf-8")
    assert json.loads(download_path.read_text(encoding="utf-8"))["summary"]["total"] == 1

    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    assert metadata["url"] == "https://example.com/app"
    assert metadata["title"] == "Example App"
    assert metadata["artifacts"]["snapshot_path"] == str(snapshot_path)
    assert metadata["artifacts"]["network_path"] == str(network_path)
    assert metadata["artifacts"]["frame_path"] == str(frame_path)
    assert metadata["frame_summary"]["total"] == 1
    assert metadata["dialog_summary"]["total"] == 1
    assert metadata["download_summary"]["total"] == 1

    second = asyncio.run(BrowserSupervisorTool().execute(
        BrowserSupervisorTool.input_model(action="capture", include_screenshot=True),
        _ctx(tmp_path),
    ))
    second_payload = json.loads(second.content)
    second_diff = json.loads(Path(second_payload["screenshot_diff_path"]).read_text(
        encoding="utf-8",
    ))
    assert second_diff["has_baseline"] is True
    assert second_diff["changed"] is True


# ============================================================
# 실제 chromium 통합 — 가벼운 local HTTP server 띄움
# ============================================================

@pytest.fixture(scope="module")
def local_server():
    """tmp 디렉토리 root 로 SimpleHTTPServer. 테스트마다 끄지 않고 module-scope."""
    import tempfile
    tmp = tempfile.mkdtemp()
    p = Path(tmp)
    # 간단한 HTML 페이지
    (p / "index.html").write_text(
        "<html><head><title>Test Page</title></head>"
        "<body><h1 id='hello'>Hello Browser</h1>"
        "<input id='q' placeholder='search' />"
        "<button id='go'>Go</button>"
        "</body></html>"
    )
    handler = http.server.SimpleHTTPRequestHandler

    class _Handler(handler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(p), **kwargs)
        def log_message(self, *_a, **_k):
            pass  # silent

    server = socketserver.TCPServer(("127.0.0.1", 0), _Handler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{port}/index.html", port
    server.shutdown()
    server.server_close()


@pytest.fixture(autouse=True)
def _reset_session_state():
    """매 테스트 전 module-level state 리셋 — start 전 누수 시뮬."""
    _BROWSER_EVENTS.clear()
    _BROWSER_NETWORK_EVENTS.clear()
    _BROWSER_DYNAMIC_RESPONSE_EVENTS.clear()
    _BROWSER_CONSOLE_EVENTS.clear()
    _BROWSER_FRAME_EVENTS.clear()
    _BROWSER_DIALOG_EVENTS.clear()
    _BROWSER_DOWNLOAD_EVENTS.clear()
    _SESSION_STATE["playwright"] = None
    _SESSION_STATE["browser"] = None
    _SESSION_STATE["context"] = None
    _SESSION_STATE["page"] = None
    _SESSION_STATE["started_at"] = None
    _SESSION_STATE["navigations"] = 0
    _SESSION_STATE["last_screenshot"] = None
    _SESSION_STATE["ref_map"] = {}
    _SESSION_STATE["ref_url"] = ""
    _SESSION_STATE["evidence_dir"] = None
    yield
    _BROWSER_EVENTS.clear()
    _BROWSER_NETWORK_EVENTS.clear()
    _BROWSER_DYNAMIC_RESPONSE_EVENTS.clear()
    _BROWSER_CONSOLE_EVENTS.clear()
    _BROWSER_FRAME_EVENTS.clear()
    _BROWSER_DIALOG_EVENTS.clear()
    _BROWSER_DOWNLOAD_EVENTS.clear()
    _SESSION_STATE["playwright"] = None
    _SESSION_STATE["browser"] = None
    _SESSION_STATE["context"] = None
    _SESSION_STATE["page"] = None
    _SESSION_STATE["started_at"] = None
    _SESSION_STATE["navigations"] = 0
    _SESSION_STATE["last_screenshot"] = None
    _SESSION_STATE["ref_map"] = {}
    _SESSION_STATE["ref_url"] = ""
    _SESSION_STATE["evidence_dir"] = None


def _has_chromium() -> bool:
    """playwright chromium 바이너리 있나 (없으면 통합 테스트 skip)."""
    try:
        import playwright  # noqa
    except ImportError:
        return False
    candidates = []
    env_path = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if env_path and env_path != "0":
        candidates.append(Path(env_path).expanduser())
    # Linux / macOS 기본 cache 디렉토리 확인
    candidates.extend([
        Path.home() / ".cache" / "ms-playwright",
        Path.home() / "Library" / "Caches" / "ms-playwright",
    ])
    # chromium 또는 chromium_headless_shell 디렉토리 매치
    for home in candidates:
        if not home.exists():
            continue
        for entry in home.iterdir():
            if entry.name.startswith("chromium"):
                return True
    return False


pytestmark_integration = pytest.mark.skipif(
    not _has_chromium(),
    reason="playwright chromium 미설치 (playwright install chromium)",
)


async def _start(ctx):
    return await BrowserSessionTool().execute(
        BrowserSessionTool.input_model(action="start"), ctx,
    )


async def _action(payload, ctx):
    return await BrowserActionTool().execute(
        BrowserActionTool.input_model(**payload), ctx,
    )


async def _query(payload, ctx):
    return await BrowserQueryTool().execute(
        BrowserQueryTool.input_model(**payload), ctx,
    )


async def _session(payload, ctx):
    return await BrowserSessionTool().execute(
        BrowserSessionTool.input_model(**payload), ctx,
    )


@pytestmark_integration
def test_session_start_stop_status(tmp_path):
    """실제 chromium 띄우고 status / stop 라이프사이클 — 한 loop 안에서 모든 액션."""
    async def scenario():
        ctx = _ctx(tmp_path)
        try:
            start = await _start(ctx)
            assert isinstance(start, ToolSuccess), start
            status = await _session({"action": "status"}, ctx)
            assert "running=True" in status.content
        finally:
            await _stop_session()
    asyncio.run(scenario())


@pytestmark_integration
def test_navigate_rejects_loopback_via_url_safety(tmp_path, local_server):
    url, _port = local_server
    async def scenario():
        ctx = _ctx(tmp_path)
        try:
            await _start(ctx)
            res = await _action({"action": "navigate", "url": url}, ctx)
            assert isinstance(res, ToolError)
            assert res.kind == "forbidden"
            assert "loopback" in res.message.lower() or "127" in res.message
        finally:
            await _stop_session()
    asyncio.run(scenario())


@pytestmark_integration
def test_navigate_rejects_file_scheme(tmp_path):
    async def scenario():
        ctx = _ctx(tmp_path)
        try:
            await _start(ctx)
            res = await _action(
                {"action": "navigate", "url": "file:///etc/passwd"}, ctx,
            )
            assert isinstance(res, ToolError)
            assert res.kind == "forbidden"
        finally:
            await _stop_session()
    asyncio.run(scenario())


@pytestmark_integration
def test_fill_rejects_secret_text(tmp_path):
    async def scenario():
        ctx = _ctx(tmp_path)
        try:
            await _start(ctx)
            res = await _action({
                "action": "fill", "selector": "input#q",
                "text": "sk-abcdefghijklmnop",
            }, ctx)
            assert isinstance(res, ToolError)
            assert res.kind == "forbidden"
            assert "secret" in res.message.lower()
        finally:
            await _stop_session()
    asyncio.run(scenario())


@pytestmark_integration
def test_navigate_requires_url(tmp_path):
    async def scenario():
        ctx = _ctx(tmp_path)
        try:
            await _start(ctx)
            res = await _action({"action": "navigate"}, ctx)
            assert isinstance(res, ToolError)
            assert res.kind == "validation"
        finally:
            await _stop_session()
    asyncio.run(scenario())


@pytestmark_integration
def test_click_requires_selector(tmp_path):
    async def scenario():
        ctx = _ctx(tmp_path)
        try:
            await _start(ctx)
            res = await _action({"action": "click"}, ctx)
            assert isinstance(res, ToolError)
            assert res.kind == "validation"
        finally:
            await _stop_session()
    asyncio.run(scenario())


# ============================================================
# v3.67: 사전 인증 세션 주입 (storage_state / cookies)
#   — Knox 로컬트레이 등 봇이 로그인 못하는 SSO 용. 운영자가 인증세션을
#     export → SA_WEB_SESSION_STATE 경로로 주입. 비번은 봇에 절대 안 줌.
# ============================================================

def test_resolve_session_state_none(monkeypatch):
    monkeypatch.delenv("SA_WEB_SESSION_STATE", raising=False)
    assert _resolve_session_state()["mode"] == "none"


def test_resolve_session_state_missing_file(monkeypatch, tmp_path):
    monkeypatch.setenv("SA_WEB_SESSION_STATE", str(tmp_path / "nope.json"))
    r = _resolve_session_state()
    assert r["mode"] == "error" and "없음" in r["error"]


def test_resolve_session_state_storage_state(monkeypatch, tmp_path):
    f = tmp_path / "state.json"
    f.write_text(json.dumps({
        "cookies": [{"name": "a", "value": "1",
                     "domain": "x.cdep.samsungds.net", "path": "/"}],
        "origins": [],
    }), encoding="utf-8")
    monkeypatch.setenv("SA_WEB_SESSION_STATE", str(f))
    r = _resolve_session_state()
    assert r["mode"] == "storage_state"
    assert r["count"] == 1
    assert r["path"] == str(f)   # new_context 에 path 그대로 전달


def test_resolve_session_state_cookies_list_extension_format(monkeypatch, tmp_path):
    # Cookie-Editor / EditThisCookie 류 export 포맷
    f = tmp_path / "cookies.json"
    f.write_text(json.dumps([{
        "name": "JSESSIONID", "value": "abc123",
        "domain": "phdev--eqpchg-dev.cdep.samsungds.net", "path": "/",
        "expirationDate": 1900000000.5, "httpOnly": True, "secure": True,
        "sameSite": "no_restriction", "hostOnly": False, "session": False,
        "storeId": "0",
    }]), encoding="utf-8")
    monkeypatch.setenv("SA_WEB_SESSION_STATE", str(f))
    r = _resolve_session_state()
    assert r["mode"] == "cookies" and r["count"] == 1
    ck = r["cookies"][0]
    assert ck["name"] == "JSESSIONID" and ck["value"] == "abc123"
    assert ck["domain"].endswith("samsungds.net") and ck["path"] == "/"
    assert ck["expires"] == 1900000000.5
    assert ck["httpOnly"] is True and ck["secure"] is True
    assert ck["sameSite"] == "None"          # no_restriction → None
    assert "expirationDate" not in ck and "storeId" not in ck  # 잡키 제거


def test_resolve_session_state_malformed(monkeypatch, tmp_path):
    f = tmp_path / "bad.json"
    f.write_text("{not valid json", encoding="utf-8")
    monkeypatch.setenv("SA_WEB_SESSION_STATE", str(f))
    assert _resolve_session_state()["mode"] == "error"


def test_resolve_session_state_empty_cookies_is_error(monkeypatch, tmp_path):
    f = tmp_path / "empty.json"
    f.write_text("[]", encoding="utf-8")
    monkeypatch.setenv("SA_WEB_SESSION_STATE", str(f))
    assert _resolve_session_state()["mode"] == "error"


def test_resolve_session_state_unknown_shape_is_error(monkeypatch, tmp_path):
    f = tmp_path / "weird.json"
    f.write_text('{"foo": "bar"}', encoding="utf-8")  # cookies 키도 없고 list 도 아님
    monkeypatch.setenv("SA_WEB_SESSION_STATE", str(f))
    assert _resolve_session_state()["mode"] == "error"


def test_normalize_cookies_filters_invalid():
    raw = [
        {"name": "ok", "value": "v", "domain": "d.samsungds.net"},
        {"value": "noName", "domain": "d.samsungds.net"},      # name 없음 → drop
        {"name": "noTarget", "value": "v"},                    # domain/url 없음 → drop
        {"name": "byurl", "value": "v", "url": "https://d.samsungds.net"},
        "garbage", 123, None,                                  # 비-dict → drop
    ]
    out = _normalize_cookies(raw)
    names = {c["name"] for c in out}
    assert names == {"ok", "byurl"}
    ok = next(c for c in out if c["name"] == "ok")
    assert ok["path"] == "/"   # domain 모드 기본 path
    byurl = next(c for c in out if c["name"] == "byurl")
    assert byurl.get("url") and "domain" not in byurl   # url 모드는 domain/path 안 넣음


def test_normalize_cookies_samesite_map():
    cases = {"lax": "Lax", "strict": "Strict", "none": "None",
             "no_restriction": "None", "unspecified": "Lax", "BOGUS": None}
    for raw_ss, expect in cases.items():
        out = _normalize_cookies([{"name": "a", "value": "1",
                                   "domain": "d", "sameSite": raw_ss}])
        if expect is None:
            assert "sameSite" not in out[0]
        else:
            assert out[0]["sameSite"] == expect


def test_normalize_cookies_session_cookie_no_expires():
    # 만료 없는 세션 쿠키 → expires 키 생략 (Playwright 가 세션쿠키로 취급)
    out = _normalize_cookies([{"name": "s", "value": "v", "domain": "d"}])
    assert "expires" not in out[0]


def test_normalize_cookies_drops_empty_value():
    # 빈 문자열 값 쿠키는 Playwright 가 거부 → 미리 버린다 (review finding #3)
    out = _normalize_cookies([
        {"name": "empty", "value": "", "domain": "d"},
        {"name": "ok", "value": "v", "domain": "d"},
    ])
    assert {c["name"] for c in out} == {"ok"}


def test_normalize_cookies_samesite_none_forces_secure():
    # SameSite=None 쿠키는 Secure 필수 — secure=False 로 와도 강제 True (review finding #8)
    out = _normalize_cookies([{"name": "a", "value": "1", "domain": "d",
                               "sameSite": "no_restriction", "secure": False}])
    assert out[0]["sameSite"] == "None"
    assert out[0]["secure"] is True


def test_browser_health_reports_injected_session():
    # 기본(주입 없음)엔 injected_session 키가 있고 None
    _SESSION_STATE["injected_session"] = None
    assert _browser_health()["injected_session"] is None
    _SESSION_STATE["injected_session"] = {"mode": "cookies", "count": 3,
                                          "source": "/tmp/x.json"}
    try:
        h = _browser_health()
        assert h["injected_session"]["count"] == 3
        assert h["injected_session"]["mode"] == "cookies"
    finally:
        _SESSION_STATE["injected_session"] = None


# ============================================================
# v3.69: idle reaper + graceful 종료훅
# ============================================================


def _fake_running_session(last_used: float) -> None:
    """_stop_session 이 견딜 수 있는 가짜 running 세션. browser=object() 는
    close 가 실패해도 _stop_session 이 삼키므로 안전."""
    asyncio.run(_stop_session())
    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["last_used"] = last_used


def test_idle_timeout_seconds_env(monkeypatch):
    monkeypatch.delenv("SA_BROWSER_IDLE_TIMEOUT", raising=False)
    assert _idle_timeout_seconds() == 600.0
    monkeypatch.setenv("SA_BROWSER_IDLE_TIMEOUT", "120")
    assert _idle_timeout_seconds() == 120.0
    monkeypatch.setenv("SA_BROWSER_IDLE_TIMEOUT", "garbage")
    assert _idle_timeout_seconds() == 600.0


def test_touch_session_updates_last_used():
    _SESSION_STATE["last_used"] = None
    _touch_session()
    assert isinstance(_SESSION_STATE["last_used"], float)
    _SESSION_STATE["last_used"] = None


def test_reap_idle_session_noop_when_not_running(monkeypatch):
    asyncio.run(_stop_session())
    monkeypatch.setenv("SA_BROWSER_IDLE_TIMEOUT", "600")
    assert asyncio.run(reap_idle_session()) is False


def test_reap_idle_session_keeps_fresh(monkeypatch):
    monkeypatch.setenv("SA_BROWSER_IDLE_TIMEOUT", "600")
    _fake_running_session(last_used=1000.0)
    try:
        # now = last + 10s → 임계 미만 → 살린다
        assert asyncio.run(reap_idle_session(now=1010.0)) is False
        assert _SESSION_STATE["browser"] is not None
    finally:
        asyncio.run(_stop_session())


def test_reap_idle_session_closes_after_timeout(monkeypatch):
    monkeypatch.setenv("SA_BROWSER_IDLE_TIMEOUT", "600")
    _fake_running_session(last_used=1000.0)
    try:
        # now = last + 601s → 임계 초과 → 회수
        assert asyncio.run(reap_idle_session(now=1601.0)) is True
        assert _SESSION_STATE["browser"] is None
        assert _SESSION_STATE["last_used"] is None
    finally:
        asyncio.run(_stop_session())


def test_reap_idle_session_disabled_when_timeout_zero(monkeypatch):
    monkeypatch.setenv("SA_BROWSER_IDLE_TIMEOUT", "0")
    _fake_running_session(last_used=1000.0)
    try:
        # timeout<=0 → reaper 비활성, 아무리 오래돼도 안 죽임
        assert asyncio.run(reap_idle_session(now=999999.0)) is False
        assert _SESSION_STATE["browser"] is not None
    finally:
        asyncio.run(_stop_session())


def test_shutdown_browser_closes_running():
    _fake_running_session(last_used=1000.0)
    asyncio.run(shutdown_browser())
    assert _SESSION_STATE["browser"] is None
    assert _SESSION_STATE["last_used"] is None


def test_shutdown_browser_noop_when_not_running():
    asyncio.run(_stop_session())
    asyncio.run(shutdown_browser())  # 예외 없이 통과해야
    assert _SESSION_STATE["browser"] is None


# ============================================================
# F4-A: 좌표 클릭 (click_xy) — 비전 브라우징 기반
# ============================================================

def test_click_xy_calls_mouse_click(tmp_path):
    class _Mouse:
        def __init__(self):
            self.clicked = None

        async def click(self, x, y):
            self.clicked = (x, y)

    class _Page:
        url = "https://app.example.test/x"

        def __init__(self):
            self.mouse = _Mouse()

        async def evaluate(self, js, arg=None):
            return {"iframe": False}  # 지점이 iframe 아님 → 통과

    page = _Page()
    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = page
    res = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="click_xy", x=120, y=340),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolSuccess)
    assert page.mouse.clicked == (120, 340)
    assert "(120,340)" in res.content


def test_click_xy_fails_closed_on_eval_error(tmp_path):
    """V2: 지점 검증(elementFromPoint) 이 실패하면 fail-closed — 클릭 안 함."""
    class _Mouse:
        def __init__(self):
            self.clicked = None

        async def click(self, x, y):
            self.clicked = (x, y)

    class _Page:
        url = "https://app.example.test/x"

        def __init__(self):
            self.mouse = _Mouse()

        async def evaluate(self, js, arg=None):
            raise RuntimeError("elementFromPoint 불가")

    page = _Page()
    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = page
    res = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="click_xy", x=5, y=5),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"
    assert page.mouse.clicked is None


def test_click_xy_missing_coords_is_validation_error(tmp_path):
    class _Page:
        url = "https://app.example.test/x"
        mouse = None

    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = _Page()
    res = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="click_xy", x=10),  # y 없음
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolError)
    assert res.kind == "validation"


def test_click_xy_out_of_range_rejected(tmp_path):
    class _Mouse:
        async def click(self, x, y):
            raise AssertionError("범위 밖인데 클릭이 실행되면 안 됨")

    class _Page:
        url = "https://app.example.test/x"
        mouse = _Mouse()

    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = _Page()
    for x, y in [(-1, 5), (5, -1), (999999, 5)]:
        res = asyncio.run(BrowserActionTool().execute(
            BrowserActionTool.input_model(action="click_xy", x=x, y=y),
            _ctx(tmp_path),
        ))
        assert isinstance(res, ToolError)
        assert res.kind == "validation"


def test_click_xy_blocks_off_scope_iframe(tmp_path):
    """S2: (x,y) 지점이 off-scope(하드블록) iframe 위면 클릭 차단 + mouse 미호출."""
    class _Mouse:
        def __init__(self):
            self.clicked = None

        async def click(self, x, y):
            self.clicked = (x, y)

    class _Page:
        url = "https://app.example.test/x"

        def __init__(self):
            self.mouse = _Mouse()

        async def evaluate(self, js, arg=None):
            # 이 지점은 link-local(하드블록) origin 의 iframe 위.
            return {"iframe": True, "src": "http://169.254.169.254/admin"}

    page = _Page()
    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = page
    res = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="click_xy", x=50, y=60),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"
    assert page.mouse.clicked is None  # 클릭 안 됨


def test_click_xy_allows_non_iframe_point(tmp_path):
    class _Mouse:
        def __init__(self):
            self.clicked = None

        async def click(self, x, y):
            self.clicked = (x, y)

    class _Page:
        url = "https://app.example.test/x"

        def __init__(self):
            self.mouse = _Mouse()

        async def evaluate(self, js, arg=None):
            return {"iframe": False}

    page = _Page()
    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = page
    res = asyncio.run(BrowserActionTool().execute(
        BrowserActionTool.input_model(action="click_xy", x=7, y=8),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolSuccess)
    assert page.mouse.clicked == (7, 8)


# ============================================================
# F4-C: screenshot 픽셀 되먹임 (return_image)
# ============================================================

class _ShotPage:
    url = "https://app.example.test/x"

    def is_closed(self):
        return False

    async def screenshot(self, *, path, full_page=False):
        Path(path).write_bytes(b"fake-png")


def test_screenshot_return_image_inlines_base64(tmp_path):
    import base64 as _b64
    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = _ShotPage()
    res = asyncio.run(BrowserQueryTool().execute(
        BrowserQueryTool.input_model(
            action="screenshot", output_dir=str(tmp_path / "s"), return_image=True,
        ),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolSuccess)
    assert len(res.images) == 1
    assert res.images[0].media_type == "image/png"
    assert res.images[0].data_b64 == _b64.b64encode(b"fake-png").decode("ascii")


def test_screenshot_default_no_image(tmp_path):
    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = _ShotPage()
    res = asyncio.run(BrowserQueryTool().execute(
        BrowserQueryTool.input_model(
            action="screenshot", output_dir=str(tmp_path / "s"),
        ),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolSuccess)
    assert res.images == ()  # 기본은 픽셀 미반환


def test_screenshot_over_inline_cap_skips_image(tmp_path, monkeypatch):
    monkeypatch.setenv("SA_BROWSER_SCREENSHOT_INLINE_MAX_BYTES", "1")  # 8바이트 > 1
    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = _ShotPage()
    res = asyncio.run(BrowserQueryTool().execute(
        BrowserQueryTool.input_model(
            action="screenshot", output_dir=str(tmp_path / "s"), return_image=True,
        ),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolSuccess)
    assert res.images == ()          # cap 초과 → 인라인 생략
    assert "inline 생략" in res.content


# ============================================================
# F4-B: 비전 피드백 루프 — 프롬프트 배선 + 데이터 경로 연결
# ============================================================

def test_vision_loop_prompt_guidance_present():
    ps = BrowserQueryTool.prompt_section
    assert "return_image" in ps
    assert "click_xy" in ps
    assert "비전" in ps  # 비전 브라우징 루프 안내
    assert "return_image" in BrowserQueryTool.description


def test_vision_loop_pieces_connect(tmp_path):
    """screenshot(return_image)→이미지 반환→엔진 주입이 ImageBlock 생성(모델이 화면을 봄)."""
    from secu_agent.agent.engine import _append_tool_images
    from secu_agent.agent.llm.messages import (
        ImageBlock as _IB, ToolResultBlock as _TRB, ToolUseBlock as _TUB,
    )

    _SESSION_STATE["browser"] = object()
    _SESSION_STATE["page"] = _ShotPage()
    shot = asyncio.run(BrowserQueryTool().execute(
        BrowserQueryTool.input_model(
            action="screenshot", output_dir=str(tmp_path / "s"), return_image=True,
        ),
        _ctx(tmp_path),
    ))
    assert isinstance(shot, ToolSuccess) and shot.images  # 픽셀 반환

    # 엔진이 tool-result 뒤에 ImageBlock 주입 → 모델이 화면을 '본다'.
    blocks = [_TRB(tool_use_id="c1", content=shot.content)]
    _append_tool_images(
        blocks, [_TUB(id="c1", name="browser_query", input={})], {"c1": shot.images},
    )
    assert any(isinstance(b, _IB) for b in blocks)
