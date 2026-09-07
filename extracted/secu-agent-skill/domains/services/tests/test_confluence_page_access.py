"""노출된 글을 **몇 명이 볼 수 있나** (2026-08-26).

## 왜 필요한가

같은 MongoDB admin 비밀번호라도 이 셋은 다른 사건이다:

    팀 5명만 보는 제한 페이지 · 로그인한 전 임직원이 보는 페이지 · 로그인 없이 보이는 페이지

그런데 finding 이 담던 것은 `agent_verification.checks = ['sso_session_established']`
하나뿐이었다 — "로그인한 상태로 읽었다". 즉 셋을 **구분하지 못한 채** 같은 severity 로
나갔다.

## 실측 (2026-08-26)

    익명 접근      사이트 전체가 302 로그인 리다이렉트 → "로그인 없이 보임" 은 없다
    페이지 제한    `#content-metadata-page-restrictions` 가 "무제한" 을 반환

⚠️ 본문 텍스트에서 "제한"/"Restricted" 를 찾으면 **사이드바 페이지 트리의 다른 페이지
   이름**이 잡힌다(처음에 그렇게 해서 오탐이 났다). 반드시 선택자로 본다.
"""
from __future__ import annotations

import pytest


class _Ctx:
    def __init__(self, store=None):
        self.metadata = {}
        if store is not None:
            from domains.services.confluence.plugin.tools.confluence_browser_search_tool import (
                PAGE_ACCESS_KEY,
            )

            self.metadata[PAGE_ACCESS_KEY] = store


class _Hit:
    def __init__(self, location):
        self.location = location
        self.category = "credential"


class _Finding:
    def __init__(self, target, locations):
        self.target = target
        self.hits = [_Hit(x) for x in locations]


def _keys(store, *, target="https://cf/p/1", locations=("https://cf/p/1",)):
    from domains.services.confluence.plugin.tools.confluence_submit_finding_tool import (
        _page_access_keys,
    )

    return _page_access_keys(_Finding(target, locations), _Ctx(store))


def test_unrestricted_page_is_recorded_as_all_employees():
    got = _keys({"https://cf/p/1": {"scope": "all_logged_in_employees",
                                    "restrictions": "무제한"}})
    assert got["page_access"]["scope"] == "all_logged_in_employees"
    assert got["page_access"]["anonymous_readable"] is False


def test_restricted_page_is_recorded_as_restricted():
    got = _keys({"https://cf/p/1": {"scope": "restricted",
                                    "restrictions": "보기 제한: 3명"}})
    assert got["page_access"]["scope"] == "restricted"
    assert "3명" in got["page_access"]["restrictions"]


def test_unknown_access_adds_no_key_at_all():
    """★ 모르는 것을 '무제한' 으로 적으면 severity 가 근거 없이 오르고,
    '제한됨' 으로 적으면 진짜 전사 노출이 묻힌다. 그래서 키 자체를 안 넣는다."""
    assert _keys({}) == {}
    assert _keys(None) == {}
    assert _keys({"https://cf/other": {"scope": "restricted"}}) == {}, (
        "다른 url 의 접근범위를 이 finding 에 붙였다")


def test_hit_location_also_matches():
    """finding.target 이 아니라 hit.location 으로만 잡히는 경우도 있다."""
    got = _keys({"https://cf/p/9": {"scope": "restricted"}},
                target="", locations=("https://cf/p/9",))
    assert got["page_access"]["scope"] == "restricted"


# ── 추출기 자체 ────────────────────────────────────────────────────────

def test_selector_is_used_not_body_text():
    """★ 본문 정규식이면 사이드바의 '[Restricted] …' 페이지 이름에 걸린다."""
    import inspect

    from domains.services.confluence.plugin.tools import confluence_browser_search_tool as m

    src = inspect.getsource(m._page_access)
    assert m._RESTRICTIONS_SEL == "#content-metadata-page-restrictions"
    assert "_RESTRICTIONS_SEL" in src
    assert "inner_text(\"body\")" not in src, "본문 전체에서 찾으면 사이드바가 잡힌다"


@pytest.mark.parametrize("text,expected", [
    ("무제한", "all_logged_in_employees"),
    ("Unrestricted", "all_logged_in_employees"),
    ("보기 제한: 2명", "restricted"),
    ("Viewing restricted", "restricted"),
])
def test_scope_classification(text, expected, monkeypatch):
    import asyncio

    from domains.services.confluence.plugin.tools import confluence_browser_search_tool as m

    class _Page:
        async def eval_on_selector_all(self, sel, js):
            return 1 if "length" in js else [text]

    got = asyncio.run(m._page_access(_Page()))
    assert got["scope"] == expected


def test_missing_indicator_yields_nothing():
    import asyncio

    from domains.services.confluence.plugin.tools import confluence_browser_search_tool as m

    class _Page:
        async def eval_on_selector_all(self, sel, js):
            return 0 if "length" in js else []

    assert asyncio.run(m._page_access(_Page())) == {}
