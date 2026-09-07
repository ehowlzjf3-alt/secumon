"""v3.20: URL safety 가드 — WebFetchTool 의 SSRF/스킴 차단.

핵심:
- http/https 만 허용. file://, data:, javascript:, gopher:// 거부.
- 127.0.0.0/8, ::1, 169.254.0.0/16 (cloud metadata) 등 hard-block 대상 IP 거부.
- "localhost", "metadata.google.internal", ".local" hostname 거부.
- 사내망 (RFC1918 + 12.x / 106.x) 은 정상 통과 — agent 가 IP 로 사내/외부 판단 금지 룰 유지.
"""
from __future__ import annotations

import pytest

from secu_agent.agent.tools.url_safety import URLSafetyError, validate_url_safe


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
    monkeypatch.setenv("SA_WEB_ALLOWED_CIDRS", "10.50.1.0/24, 172.20.0.0/16")

    validate_url_safe("https://10.50.1.25/app")
    validate_url_safe("https://172.20.20.30/")

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

# 도구 통합 테스트(web_fetch/crawl/vuln_probe)는 secu-agent-skill/tests/test_url_safety_webtools.py 로 이동


# ─── Slice3: hardblock-only + hardblock+DNS 재바인딩 (CDP fetch 게이트용) ─────────
from secu_agent.agent.tools.url_safety import (  # noqa: E402
    validate_url_safe_hardblock, validate_url_safe_hardblock_resolved,
)


def test_hardblock_ignores_scope(monkeypatch):
    # scope 설정돼도 하드블록-only 는 scope 를 안 봄(off-scope subresource 오차단 방지)
    monkeypatch.setenv("SA_WEB_ALLOWED_DOMAINS", "allowed.example")
    validate_url_safe_hardblock("https://cdn.other.example/lib.js")  # scope 밖이어도 통과
    with pytest.raises(URLSafetyError):
        validate_url_safe_hardblock("http://169.254.169.254/x")     # metadata 는 여전히 차단
    with pytest.raises(URLSafetyError):
        validate_url_safe_hardblock("http://127.0.0.1/x")           # loopback 차단
    with pytest.raises(URLSafetyError):
        validate_url_safe_hardblock("file:///etc/passwd")           # scheme 차단


def test_hardblock_resolved_blocks_dns_name_to_metadata(monkeypatch):
    # 정상 hostname 이 metadata IP 로 resolve 되면 차단(DNS-이름 SSRF, codex #3)
    monkeypatch.setenv("SA_WEB_DNS_REBIND_CHECK", "true")  # kill-switch off 인 env 대비

    def _fake_resolver(host, _):
        return [(2, 1, 6, "", ("169.254.169.254", 0))]
    with pytest.raises(URLSafetyError):
        validate_url_safe_hardblock_resolved(
            "http://rebind.attacker.example/x", resolver=_fake_resolver)


def test_hardblock_resolved_allows_public_resolve(monkeypatch):
    monkeypatch.setenv("SA_WEB_DNS_REBIND_CHECK", "true")

    def _fake_resolver(host, _):
        return [(2, 1, 6, "", ("93.184.216.34", 0))]  # 공인 IP
    validate_url_safe_hardblock_resolved(
        "https://cdn.example/lib.js", resolver=_fake_resolver)  # 통과
