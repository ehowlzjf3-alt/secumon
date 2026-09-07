"""검색결과를 첫 화면에서 끊지 않는다 — 그리고 소진 판정이 스스로를 속이지 않는다.

## 왜 (2026-08-28 조사)

`_all_result_links`(페이지 넘기기)는 있었는데 **부르는 데가 없었다** — 저장소
전체에서 참조가 자기 정의 하나뿐이었다. 살아 있는 수집은 `_result_links(...)`
한 번, 즉 **검색결과 첫 화면**뿐이고 그게 곧 커버리지 상한이었다.

그런데 그대로 배선하면 무동작이다. 소진 판정이
`len(page_links) < _RESULT_PAGE_SIZE` 인데 `page_links` 는 **scope 후필터를 거친**
목록이라, 필터가 많이 걷어내면 마지막 페이지로 오해한다. 실측 공급량이 12~23이라
생산적 키워드의 94.5%가 첫 페이지에서 끝난다.

그래서 순서가 있다: **판정을 먼저 고치고, 그 다음 배선한다.**
"""
from __future__ import annotations

import asyncio
import inspect

from domains.services.confluence.plugin.tools import confluence_browser_search_tool as m


class _Page:
    """`eval_on_selector_all` 만 흉내낸다."""

    def __init__(self, anchors):
        self._anchors = anchors

    async def eval_on_selector_all(self, _sel, _js):
        return self._anchors


def _anchor(href, text="문서"):
    return {"t": text, "h": href}


def test_scope_none_gives_the_pre_filter_count():
    """★ 소진 판정의 근거 — 필터가 걷어낸 것도 '서버가 준 결과' 다.

    scope 를 준 호출과 안 준 호출의 차이가 곧 필터가 걷어낸 양이다.
    """
    page = _Page([
        _anchor("https://cf.test/display/KEEP/a"),
        _anchor("https://cf.test/display/DROP/b"),
        _anchor("https://cf.test/display/DROP/c"),
    ])
    scoped = asyncio.run(m._result_links(page, "cf.test", ["KEEP"]))
    unscoped = asyncio.run(m._result_links(page, "cf.test", None))
    assert [x["url"] for x in scoped] == ["https://cf.test/display/KEEP/a"]
    assert len(unscoped) == 3, "scope 로 걸러낸 것도 세야 '한 페이지가 찼나' 를 알 수 있다"


def test_the_signature_stays_at_three_arguments():
    """⚠️ 이 시그니처는 살아 있는 호출부와 **테스트 스텁**이 묶여 있다.

    한 번 `with_stats` 키워드를 더했다가 `lambda p, h, s: [...]` 스텁 두 개가
    TypeError 로 깨졌다. 소진 판정용 수는 scope=None 으로 한 번 더 불러서 얻는다.
    """
    import inspect

    params = list(inspect.signature(m._result_links).parameters)
    assert params == ["page", "host", "scope_space_keys"]


def test_a_failed_dom_read_returns_an_empty_list():
    class _Boom:
        async def eval_on_selector_all(self, *_a):
            raise RuntimeError("DOM 없음")

    assert asyncio.run(m._result_links(_Boom(), "cf.test", None)) == []


def test_exhaustion_uses_the_pre_filter_count():
    """★ 이 한 줄이 틀리면 배선해도 첫 페이지에서 끝난다."""
    src = inspect.getsource(m._all_result_links)
    assert "page_unscoped < _RESULT_PAGE_SIZE" in src
    assert "len(page_links) < _RESULT_PAGE_SIZE" not in src


def test_the_live_loop_actually_calls_the_paginator():
    """헬퍼가 있는데 부르는 데가 없던 것이 이 항목의 전부였다."""
    src = inspect.getsource(m)
    body = src.split("per_kw_budget", 1)[1]
    assert "_all_result_links(" in body, "살아 있는 수집 경로가 페이지 넘기기를 안 쓴다"


def test_result_page_budget_is_separate_from_the_document_budget():
    """결과 페이지 넘기기는 **추가 네비게이션**이라 문서 예산과 따로 센다."""
    fields = m.ConfluenceBrowserSearchInput.model_fields
    assert "result_pages_per_keyword" in fields
    f = fields["result_pages_per_keyword"]
    assert f.default == 3, "라이브 rate limit 이 미측정이라 보수적 기본값"


def test_truncation_is_reported_not_swallowed():
    """상한에 걸려 끊었으면 그 사실이 나가야 한다 — 조용한 절단 금지."""
    src = inspect.getsource(m)
    assert '"truncated_keywords": truncated_keywords' in src
    assert '"result_pages_scanned": result_pages_total' in src
