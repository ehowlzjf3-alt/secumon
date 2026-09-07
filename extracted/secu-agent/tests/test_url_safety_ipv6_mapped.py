"""v3.51-S3: IPv6-mapped IPv4 우회 + CG-NAT 100.64.0.0/10 block."""
from __future__ import annotations

import pytest

from secu_agent.agent.tools.url_safety import (
    URLSafetyError,
    _is_blocked_ip,
    validate_url_safe,
)


def test_ipv6_mapped_loopback_blocked():
    """::ffff:127.0.0.1 → 우회 차단 검증 (이전 버그)"""
    blocked, reason = _is_blocked_ip("::ffff:127.0.0.1")
    assert blocked
    assert "loopback" in reason.lower()


def test_ipv6_mapped_link_local_blocked():
    """::ffff:169.254.169.254 (cloud metadata) 우회 차단."""
    blocked, reason = _is_blocked_ip("::ffff:169.254.169.254")
    assert blocked
    assert "link-local" in reason.lower() or "metadata" in reason.lower()


def test_validate_url_blocks_ipv6_mapped_loopback():
    with pytest.raises(URLSafetyError, match="loopback"):
        validate_url_safe("http://[::ffff:127.0.0.1]/")


def test_cgnat_100_64_blocked():
    blocked, reason = _is_blocked_ip("100.64.1.1")
    assert blocked
    assert "cg-nat" in reason.lower() or "carrier" in reason.lower() or "100.64" in reason


def test_cgnat_boundary_100_127():
    """100.64.0.0/10 의 마지막 IP."""
    blocked, _ = _is_blocked_ip("100.127.255.254")
    assert blocked


def test_just_outside_cgnat_not_blocked():
    """100.128.0.1 은 CG-NAT 밖 — block 안 함 (다른 가드는 별도)."""
    blocked, _ = _is_blocked_ip("100.128.0.1")
    assert not blocked


def test_normal_public_ip_not_blocked():
    blocked, _ = _is_blocked_ip("8.8.8.8")
    assert not blocked


def test_loopback_still_blocked():
    """기존 가드 회귀."""
    blocked, reason = _is_blocked_ip("127.0.0.1")
    assert blocked
    assert "loopback" in reason
