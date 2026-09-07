"""v3.45: 사내 host MWG proxy 우회 — `_is_internal_host` 판정."""
from __future__ import annotations

import pytest

from secu_agent.agent.tools.url_safety import _is_internal_host


@pytest.fixture(autouse=True)
def _reset_internal_domains(monkeypatch):
    # 테스트는 default suffix 만 사용
    monkeypatch.delenv("SA_WEB_INTERNAL_DOMAINS", raising=False)
    yield


def test_samsungds_subdomain_is_internal():
    assert _is_internal_host("https://diff-data--diff-data-prod.cdep.samsungds.net") is True
    assert _is_internal_host("https://apigw.samsungds.net:8000/x") is True


def test_samsungsemi_is_internal_by_default():
    assert _is_internal_host("https://visit.samsungsemi.com") is True


def test_external_domain_is_not_internal():
    assert _is_internal_host("https://github.com/x") is False
    assert _is_internal_host("https://pypi.org/simple") is False


def test_private_ip_is_internal():
    assert _is_internal_host("http://10.0.0.1") is True
    assert _is_internal_host("http://192.168.1.1") is True
    assert _is_internal_host("http://172.16.5.1") is True


def test_samsung_ds_public_ip_ranges():
    """samsung_ds_network.md: 12.x / 106.x 도 사내 공인 IP."""
    assert _is_internal_host("http://12.25.146.167") is True
    assert _is_internal_host("http://106.10.5.5") is True


def test_external_public_ip_is_not_internal():
    assert _is_internal_host("http://8.8.8.8") is False


def test_custom_internal_domains_env(monkeypatch):
    monkeypatch.setenv("SA_WEB_INTERNAL_DOMAINS", "corp.example.com,intra.local")
    assert _is_internal_host("https://app.corp.example.com") is True
    assert _is_internal_host("https://x.intra.local") is True
    assert _is_internal_host("https://samsungds.net") is False  # custom 만, default override


def test_trailing_dot_normalization(monkeypatch):
    monkeypatch.setenv("SA_WEB_INTERNAL_DOMAINS", ".samsungds.net , samsungsemi.com")
    assert _is_internal_host("https://x.samsungds.net") is True
    assert _is_internal_host("https://visit.samsungsemi.com") is True
