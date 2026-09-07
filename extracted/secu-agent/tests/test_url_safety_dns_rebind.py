"""audit #7: DNS 재바인딩 방어 — 악성 호스트명이 하드블록 IP 로 해석되는 것 차단.

validate_url_safe 는 문자열만 보므로 attacker.com→169.254.169.254 같은 A레코드를
못 막는다. validate_url_safe_resolved 가 연결 직전 resolve 결과 IP 를 재검사한다.
실제 DNS 대신 resolver 를 주입해 결정론 검증한다(conftest autouse 가 실 DNS off).
"""
from __future__ import annotations

import pytest

from secu_agent.agent.tools.url_safety import (
    URLSafetyError,
    _resolve_host_or_block,
    validate_url_safe_resolved,
)


def _fake_resolver(ip: str):
    # socket.getaddrinfo shape: (family, type, proto, canonname, sockaddr)
    def resolve(host, port):
        return [(2, 1, 6, "", (ip, 0))]
    return resolve


@pytest.mark.parametrize("blocked_ip", [
    "169.254.169.254",  # link-local / cloud metadata
    "127.0.0.1",        # loopback
    "100.64.1.1",       # CG-NAT
    "0.0.0.0",          # unspecified
])
def test_resolve_host_blocks_rebind_to_hardblocked_ip(blocked_ip):
    with pytest.raises(URLSafetyError):
        _resolve_host_or_block("evil.example.test", resolver=_fake_resolver(blocked_ip))


def test_resolve_host_allows_public_ip():
    _resolve_host_or_block("good.example.test", resolver=_fake_resolver("93.184.216.34"))


def test_resolve_host_allows_internal_rfc1918():
    # 사내 RFC1918 대역은 하드블록이 아니다 — 정상 점검 대상.
    _resolve_host_or_block("intranet.example.test", resolver=_fake_resolver("10.50.1.10"))


def test_resolve_host_skips_ip_literal():
    def boom(host, port):
        raise AssertionError("resolver should not run for IP literal")
    _resolve_host_or_block("1.2.3.4", resolver=boom)  # no raise, no resolve


def test_resolve_host_fail_open_on_resolution_error():
    def boom(host, port):
        raise OSError("nxdomain")
    _resolve_host_or_block("nope.example.test", resolver=boom)  # fail-open → no raise


def test_validate_url_safe_resolved_blocks_rebind_when_enabled(monkeypatch):
    monkeypatch.setenv("SA_WEB_DNS_REBIND_CHECK", "1")
    with pytest.raises(URLSafetyError):
        validate_url_safe_resolved(
            "http://evil.example.test/x", resolver=_fake_resolver("169.254.169.254"),
        )


def test_validate_url_safe_resolved_killswitch_disables_dns(monkeypatch):
    monkeypatch.setenv("SA_WEB_DNS_REBIND_CHECK", "0")
    # kill-switch 로 resolve 검사만 끈다 — 문자열 하드블록은 여전히 적용된다.
    validate_url_safe_resolved(
        "http://good.example.test/x", resolver=_fake_resolver("169.254.169.254"),
    )
    with pytest.raises(URLSafetyError):
        validate_url_safe_resolved(
            "http://127.0.0.1/x", resolver=_fake_resolver("93.184.216.34"),
        )
