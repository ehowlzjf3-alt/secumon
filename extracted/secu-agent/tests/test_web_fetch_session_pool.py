"""curl_cffi Session 풀 LRU 상한 회귀 테스트 (webfetch_pool).

선택 transport(curl_cffi) 경로의 세션 캐시가 무한 증가하지 않고 LRU 로
상한을 지키며, evict 되는 세션은 반드시 .close() 되는지 검증한다. 실제
curl_cffi/네트워크는 쓰지 않고 cffi_requests.Session 을 가짜로 주입한다.
"""
from __future__ import annotations

import sys
import types

import pytest

from secu_agent.agent.tools import web_fetch_tool as wf


class _FakeSession:
    """close() 호출 여부만 추적하는 가짜 curl_cffi 세션."""

    def __init__(self, impersonate: str) -> None:
        self.impersonate = impersonate
        self.closed = False

    def close(self) -> None:
        self.closed = True


@pytest.fixture
def fake_curl_cffi(monkeypatch):
    """`from curl_cffi import requests` 를 가짜 모듈로 대체."""
    created: list[_FakeSession] = []

    def _session_factory(*, impersonate: str) -> _FakeSession:
        sess = _FakeSession(impersonate)
        created.append(sess)
        return sess

    fake_requests = types.SimpleNamespace(Session=_session_factory)
    fake_pkg = types.ModuleType("curl_cffi")
    fake_pkg.requests = fake_requests  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "curl_cffi", fake_pkg)
    monkeypatch.setitem(sys.modules, "curl_cffi.requests", fake_requests)
    return created


@pytest.fixture(autouse=True)
def _clean_pool(monkeypatch):
    """각 테스트마다 풀을 비워 상태 오염 방지."""
    wf._CURL_CFFI_SESSION_POOL.clear()
    yield
    wf._CURL_CFFI_SESSION_POOL.clear()


def test_pool_bounded_and_evicts_oldest_with_close(fake_curl_cffi, monkeypatch):
    monkeypatch.setenv("SA_WEB_SESSION_POOL_MAX", "3")

    # 서로 다른 호스트 5개 → 상한 3 이므로 가장 오래된 2개는 evict+close.
    sessions = []
    for i in range(5):
        s = wf._curl_cffi_session(f"https://h{i}.example.com/x", "safari")
        sessions.append(s)

    assert len(wf._CURL_CFFI_SESSION_POOL) == 3
    # 가장 최근 3개(h2,h3,h4)만 남는다.
    remaining_hosts = {k[0] for k in wf._CURL_CFFI_SESSION_POOL}
    assert remaining_hosts == {"h2.example.com", "h3.example.com", "h4.example.com"}
    # evict 된 h0,h1 세션은 close() 되어야 한다.
    assert sessions[0].closed is True
    assert sessions[1].closed is True
    # 남아있는 세션은 열려 있어야 한다.
    assert sessions[4].closed is False


def test_same_key_reuses_session_no_growth(fake_curl_cffi):
    a = wf._curl_cffi_session("https://host.example.com/one", "safari")
    b = wf._curl_cffi_session("https://host.example.com/two", "safari")
    # 동일 (host, impersonate) → 같은 세션 재사용, 풀 크기 1.
    assert a is b
    assert len(wf._CURL_CFFI_SESSION_POOL) == 1
    assert len(fake_curl_cffi) == 1


def test_move_to_end_protects_recently_used(fake_curl_cffi, monkeypatch):
    monkeypatch.setenv("SA_WEB_SESSION_POOL_MAX", "2")

    s0 = wf._curl_cffi_session("https://h0.example.com/", "safari")
    _s1 = wf._curl_cffi_session("https://h1.example.com/", "safari")
    # h0 를 다시 사용 → LRU 상 최근으로 이동.
    again = wf._curl_cffi_session("https://h0.example.com/", "safari")
    assert again is s0
    # 새 호스트 삽입 → 이제 가장 오래된 것은 h1 이어야 한다(h0 아님).
    wf._curl_cffi_session("https://h2.example.com/", "safari")

    remaining_hosts = {k[0] for k in wf._CURL_CFFI_SESSION_POOL}
    assert remaining_hosts == {"h0.example.com", "h2.example.com"}


def test_pool_max_env_default_and_floor(monkeypatch):
    monkeypatch.delenv("SA_WEB_SESSION_POOL_MAX", raising=False)
    assert wf._web_session_pool_max() == wf._WEB_SESSION_POOL_MAX_DEFAULT

    monkeypatch.setenv("SA_WEB_SESSION_POOL_MAX", "not-an-int")
    assert wf._web_session_pool_max() == wf._WEB_SESSION_POOL_MAX_DEFAULT

    # 0/음수는 최소 1 로 바닥 처리.
    monkeypatch.setenv("SA_WEB_SESSION_POOL_MAX", "0")
    assert wf._web_session_pool_max() == 1
