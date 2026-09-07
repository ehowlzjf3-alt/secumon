"""httpx keep-alive 풀(A1 perf) 회귀 테스트.

_fetch_sync 가 GET 마다 httpx.Client 를 새로 만들지 않고 trust_env(사내 직결 vs 외부
프록시)별로 keep-alive 클라이언트를 재사용하는지, 닫힌 클라이언트는 새로 만드는지,
그리고 풀 Client 가 fetch 간 쿠키를 실어나르지 않는지(원 stateless per-GET 보존)를
검증한다. 실제 네트워크는 쓰지 않는다.
"""
from __future__ import annotations

import http.cookiejar

import pytest

from secu_agent.agent.tools import web_fetch_tool as wf


@pytest.fixture(autouse=True)
def _clean_httpx_pool():
    """각 테스트마다 풀을 비우고, 만들어진 실제 클라이언트를 닫는다."""
    for c in list(wf._HTTPX_CLIENT_POOL.values()):
        wf._close_session_quietly(c)
    wf._HTTPX_CLIENT_POOL.clear()
    yield
    for c in list(wf._HTTPX_CLIENT_POOL.values()):
        wf._close_session_quietly(c)
    wf._HTTPX_CLIENT_POOL.clear()


def test_same_trust_env_reuses_client():
    a = wf._pooled_httpx_client(trust_env=True, timeout=10.0)
    b = wf._pooled_httpx_client(trust_env=True, timeout=10.0)
    assert a is b
    assert len(wf._HTTPX_CLIENT_POOL) == 1


def test_internal_vs_external_are_separate_clients():
    internal = wf._pooled_httpx_client(trust_env=False, timeout=10.0)
    external = wf._pooled_httpx_client(trust_env=True, timeout=10.0)
    assert internal is not external
    assert len(wf._HTTPX_CLIENT_POOL) == 2
    # trust_env 설정이 키대로 반영돼야 한다.
    assert wf._HTTPX_CLIENT_POOL[False].trust_env is False
    assert wf._HTTPX_CLIENT_POOL[True].trust_env is True


def test_closed_client_is_rebuilt():
    first = wf._pooled_httpx_client(trust_env=True, timeout=10.0)
    first.close()
    assert first.is_closed
    second = wf._pooled_httpx_client(trust_env=True, timeout=10.0)
    assert second is not first
    assert not second.is_closed


def test_safety_settings_preserved_on_pooled_client():
    """SAFETY-KEEP: redirect 미추적 보존 + HTTP/1.1(cap-break 안전)."""
    client = wf._pooled_httpx_client(trust_env=True, timeout=10.0)
    assert client.follow_redirects is False


def test_pooled_client_does_not_carry_cookies():
    """풀 Client 는 Set-Cookie 를 저장하지 않아 fetch 간 쿠키가 새지 않는다(Q2 회귀)."""
    client = wf._pooled_httpx_client(trust_env=True, timeout=10.0)
    # no-store jar 이므로 어떤 쿠키를 세팅하려 해도 저장 0.
    jar = client.cookies.jar
    assert isinstance(jar, wf._NoStoreCookieJar)
    cookie = http.cookiejar.Cookie(
        version=0, name="session", value="secret", port=None, port_specified=False,
        domain="corp.test", domain_specified=True, domain_initial_dot=False,
        path="/", path_specified=True, secure=False, expires=None, discard=True,
        comment=None, comment_url=None, rest={},
    )
    jar.set_cookie(cookie)
    assert len(list(jar)) == 0  # 저장 안 됨 → 이후 요청에 Cookie 헤더도 없음
