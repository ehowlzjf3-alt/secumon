"""space 열거를 브라우저로 (2026-08-26).

`cf.list_spaces` 는 `/rest/api/space` 를 치는데 그 엔드포인트는 죽어 있다
(Basic 403 "Basic Authentication has been disabled" / Bearer PAT 429). 그 결과
`confluence.space_discovery` 가 매 런 error 로 끝났고 space 큐가 id 1~25 에서
몇 주째 멈춰 있었다.
"""
from __future__ import annotations

import pytest

from domains.services.confluence.plugin.tools.confluence_browser_spaces import (
    BrowserSpace, _space_keys_from_html, browser_list_spaces,
)


def test_keys_come_from_hrefs_not_from_dom_shape():
    """★ 링크에서 뽑는다 — 테마가 바뀌어도 조용히 0건이 되지 않게."""
    html = """
    <a href="/display/DSCERT">DS CERT</a>
    <a href="/spaces/DUOKNOWHOW/pages/123">Duo</a>
    <a href="/display/DSCERT/Some+Page">같은 space, 다른 page</a>
    <a href='/spaces/4SEASON'>홑따옴표</a>
    <a href="/spaces/B?src=sidebar">쿼리 붙음</a>
    """
    assert _space_keys_from_html(html) == ["DSCERT", "DUOKNOWHOW", "4SEASON", "B"]


def test_a_key_that_ends_the_href_is_not_missed():
    """★ 처음 정규식이 여기서 틀렸다.

    경계를 `(?:[/?#]|$)` 로 두면 `"/spaces/4SEASON"` 처럼 키에서 끝나는 href 는
    뒤에 오는 것이 따옴표라 **하나도 안 잡힌다**. 실제 space directory 링크는
    대부분 이 형태다 — 통과했다면 큐가 조용히 안 늘었을 것이다.
    """
    assert _space_keys_from_html('<a href="/spaces/ONLYKEY">x</a>') == ["ONLYKEY"]
    assert _space_keys_from_html("<a href='/display/ALSO'>y</a>") == ["ALSO"]


def test_reserved_paths_are_not_mistaken_for_space_keys():
    html = """
    <a href="/spacedirectory/view.action">디렉터리</a>
    <a href="/display/viewpage.action">예약어</a>
    <a href="/pages/viewpage.action?pageId=1">page</a>
    """
    assert _space_keys_from_html(html) == []


def test_empty_html_yields_nothing():
    assert _space_keys_from_html("") == []
    assert _space_keys_from_html(None) == []


def test_missing_base_url_is_a_failure_not_an_empty_list(monkeypatch):
    """★ 0건과 실패를 구분한다 — 빈 목록을 성공으로 기록하면 큐가 조용히 안 는다."""
    monkeypatch.delenv("CONFLUENCE_BASE_URL", raising=False)
    got = browser_list_spaces()
    assert got["ok"] is False and got["spaces"] == []
    assert "CONFLUENCE_BASE_URL" in got["detail"]


def test_a_browser_failure_is_reported_not_swallowed(monkeypatch):
    monkeypatch.setenv("CONFLUENCE_BASE_URL", "https://confluence.example")
    import domains.services.confluence.plugin.tools.confluence_browser_spaces as m

    async def _boom(base, *, limit):
        raise RuntimeError("SSO 세션 실패")

    monkeypatch.setattr(m, "_collect", _boom)
    got = browser_list_spaces()
    assert got["ok"] is False and "SSO 세션 실패" in got["detail"]


def test_zero_links_is_reported_as_unreadable(monkeypatch):
    """★ 링크 0건은 'space 가 없다' 가 아니라 '못 읽었다' 다."""
    monkeypatch.setenv("CONFLUENCE_BASE_URL", "https://confluence.example")
    import domains.services.confluence.plugin.tools.confluence_browser_spaces as m

    async def _empty(base, *, limit):
        return [], ""

    monkeypatch.setattr(m, "_collect", _empty)
    got = browser_list_spaces()
    assert got["ok"] is False
    assert "못 읽었다" in got["detail"]


def test_success_shape_matches_what_discovery_consumes(monkeypatch):
    """discovery 가 읽는 것은 `key`/`name`/`type` 뿐이다 — 소비 계약을 고정한다."""
    monkeypatch.setenv("CONFLUENCE_BASE_URL", "https://confluence.example")
    import domains.services.confluence.plugin.tools.confluence_browser_spaces as m

    async def _ok(base, *, limit):
        return ["DSCERT", "B"], "/spacedirectory/view.action"

    monkeypatch.setattr(m, "_collect", _ok)
    got = browser_list_spaces()
    assert got["ok"] is True and got["source"] == "/spacedirectory/view.action"
    for s in got["spaces"]:
        assert isinstance(s, BrowserSpace)
        assert getattr(s, "key") and hasattr(s, "name") and hasattr(s, "type")
    assert [s.key for s in got["spaces"]] == ["DSCERT", "B"]


def test_discovery_no_longer_calls_the_rest_enumerator():
    """★ discovery 가 `cf.list_spaces` 를 부르면 다시 403 으로 죽는다."""
    import inspect

    from service.agents import confluence_discovery_agent as m

    src = inspect.getsource(m.run_space_discovery_pass)
    assert "cf.list_spaces(" not in src, "discovery 가 아직 REST 열거기를 부른다"
    assert "browser_list_spaces(" in src


def test_discovery_raises_when_enumeration_fails():
    """열거 실패를 성공으로 기록하지 않는다 — pipeline_run 이 error 로 남아야 한다."""
    import inspect

    from service.agents import confluence_discovery_agent as m

    src = inspect.getsource(m.run_space_discovery_pass)
    assert 'if not got.get("ok")' in src and "raise RuntimeError" in src
