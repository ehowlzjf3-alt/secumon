"""confluence 제출 시 agent_verification 마킹 계약.

배경: `sync_report_threads` 가 `is_agent_verified_extra` 로 거르는데 confluence 만 이 마커를
안 붙여서 finding 10건이 **전량** `skipped_unverified` 로 버려졌다(라이브 3회 재현).

★ 이 테스트가 지키는 핵심은 "마커가 붙는다" 가 아니라 **"근거 없이는 안 붙는다"** 다.
  형식만 채우면 status="verified" 를 무조건 박는 셈이라 게이트가 무의미해진다.
"""
from __future__ import annotations

import pytest

from domains.services.confluence.plugin.tools import confluence_submit_finding_tool as cst


class _Ctx:
    def __init__(self, hosts=()):
        self.metadata = {"_web_browser_hosts": list(hosts)}


class _Hit:
    def __init__(self, location, category="credential"):
        self.location, self.category = location, category


class _Finding:
    def __init__(self, target="", hits=(), task_id="t1", task_type="confluence"):
        self.target, self.hits, self.task_id, self.task_type = target, list(hits), task_id, task_type


_URL = "https://confluence.samsungds.net/spaces/TPYE/pages/1/x"


def test_방문_기록이_없으면_마커를_안_붙인다(monkeypatch):
    """★ '확인 안 함' 과 '확인했는데 실패' 를 섞지 않는다 — 없는 게 낫다."""
    called: list = []
    monkeypatch.setattr(cst, "_finding_id_by_fingerprint", lambda fp: called.append(fp))
    cst._stamp_extra(_Finding(target=_URL, hits=[_Hit(_URL)]), _Ctx(hosts=()))
    assert called == []


def test_다른_호스트만_방문했으면_안_붙인다(monkeypatch):
    called: list = []
    monkeypatch.setattr(cst, "_finding_id_by_fingerprint", lambda fp: called.append(fp))
    cst._stamp_extra(
        _Finding(target=_URL, hits=[_Hit(_URL)]), _Ctx(hosts=["evil.example.com"]),
    )
    assert called == []


def test_본문을_연_호스트면_붙는다(monkeypatch):
    updates: list[dict] = []

    class _CoreState:
        @staticmethod
        def finding_fingerprint(**kw):
            return "fp-1"

        @staticmethod
        def finding_update(fid, extra=None, merge_extra=False):
            updates.append({"id": fid, "extra": extra, "merge": merge_extra})

    # ⚠️ sys.modules 만 갈아끼우면 안 된다 — `from secu_agent import state` 는 이미 import 된
    #    패키지의 **속성**을 먼저 본다(오늘 같은 함정을 한 번 더 밟았다). 속성을 대체한다.
    import secu_agent
    monkeypatch.setattr(secu_agent, "state", _CoreState)
    monkeypatch.setattr(cst, "_finding_id_by_fingerprint", lambda fp: 77)

    cst._stamp_extra(
        _Finding(target=_URL, hits=[_Hit(_URL)]),
        _Ctx(hosts=["confluence.samsungds.net"]),
    )
    assert len(updates) == 1
    av = updates[0]["extra"]["agent_verification"]
    assert av["status"] == "verified"
    assert av["method"] == "confluence_browser_authenticated_search"
    assert av["source"] == "confluence_submit_finding"
    # ⚠️ merge_extra 여야 한다 — 덮어쓰면 스캐너가 넣은 hits/masked_hits 가 날아간다.
    assert updates[0]["merge"] is True


def test_finding_행을_못_찾으면_엉뚱한_곳에_안_붙인다(monkeypatch):
    updates: list = []

    class _CoreState:
        @staticmethod
        def finding_fingerprint(**kw):
            return "fp-x"

        @staticmethod
        def finding_update(*a, **k):
            updates.append(a)

    import secu_agent
    monkeypatch.setattr(secu_agent, "state", _CoreState)
    monkeypatch.setattr(cst, "_finding_id_by_fingerprint", lambda fp: None)
    cst._stamp_extra(
        _Finding(target=_URL, hits=[_Hit(_URL)]), _Ctx(hosts=["confluence.samsungds.net"]),
    )
    assert updates == []


def test_target_이_없으면_hit_위치의_호스트로_판단한다(monkeypatch):
    monkeypatch.setattr(cst, "_finding_id_by_fingerprint", lambda fp: None)
    hosts = cst._finding_hosts(_Finding(target="", hits=[_Hit(_URL)]))
    assert hosts == {"confluence.samsungds.net"}


def test_코어_게이트와_같은_metadata_키를_본다():
    """★ 근거를 새로 만들지 않고 정책 A 가 쓰는 기록을 그대로 쓴다.

    `confluence_browser_search` 가 **본문을 받은 뒤에만** 남기는 키다 —
    goto 실패·로그인벽·off-origin 리다이렉트는 기록되지 않는다.
    """
    assert cst._visited_hosts(_Ctx(hosts=["A.Example.COM"])) == {"a.example.com"}
    assert cst._visited_hosts(_Ctx()) == set()

    import inspect

    from secu_agent.agent.tools import submit_finding as core

    assert '"_web_browser_hosts"' in inspect.getsource(core._require_browser_verification)


# ── 글 작성자(byline) → 담당자 키 ─────────────────────────────────────────────
from domains.services.confluence.plugin.tools import confluence_browser_search_tool as cb


def _ctx_with_authors(url, authors, hosts=("confluence.samsungds.net",)):
    ctx = _Ctx(hosts=hosts)
    ctx.metadata[cb.PAGE_AUTHORS_KEY] = {url: authors}
    return ctx


def test_byline_계정은_그대로_사내_메일이_된다():
    """실측: /display/~hw_0758.choi 의 계정이 곧 Knox ID 이고, knox 대장의 이름·부서가
    byline 과 정확히 일치했다. 그래서 <계정>@samsung.com 이 담당자 메일이다."""
    ctx = _ctx_with_authors(_URL, {"creator": "hw_0758.choi", "last_editor": "dosung.pyon"})
    keys = cst._page_author_keys(_Finding(target=_URL, hits=[_Hit(_URL)]), ctx)
    assert keys == {
        "creator_email": "hw_0758.choi@samsung.com",
        "last_modified_by_email": "dosung.pyon@samsung.com",
    }


def test_작성자를_못_얻으면_키_자체가_없다():
    """★ 빈 문자열을 넣으면 리포터가 '담당자 있음' 으로 읽는다."""
    assert cst._page_author_keys(_Finding(target=_URL, hits=[_Hit(_URL)]), _Ctx()) == {}
    ctx = _ctx_with_authors("https://other/page", {"creator": "x.y"})
    assert cst._page_author_keys(_Finding(target=_URL, hits=[_Hit(_URL)]), ctx) == {}


def test_작성자만_있으면_수정자_키는_안_넣는다():
    ctx = _ctx_with_authors(_URL, {"creator": "hw_0758.choi"})
    assert cst._page_author_keys(_Finding(target=_URL, hits=[_Hit(_URL)]), ctx) == {
        "creator_email": "hw_0758.choi@samsung.com",
    }


def test_리포터가_기대하던_키_이름과_일치한다():
    """읽는 쪽은 처음부터 있었고 쓰는 쪽이 없었다 — 이름이 어긋나면 또 조용히 빈다."""
    from service.services import owner_recipients as orx

    for key in ("creator_email", "last_modified_by_email"):
        assert key in orx.CONFLUENCE_KEYS


# ── byline 파싱 ───────────────────────────────────────────────────────────────
def test_라벨_뒤_링크를_쓴다_순서에_의존하지_않는다():
    dump = {
        "text": "작성자: 최형우 / P4-2P/J, 마지막 업데이트: 편도성 / 파트장, 업데이트 날짜: 2026.08.21",
        "anchors": [
            {"href": "/display/~hw_0758.choi", "text": "최형우 / P4-2P/J", "pos": 5},
            {"href": "/display/~dosung.pyon", "text": "편도성 / 파트장", "pos": 30},
        ],
    }
    assert cb._byline_authors(dump) == {
        "creator": "hw_0758.choi", "last_editor": "dosung.pyon",
    }


def test_라벨이_없으면_작성자를_주장하지_않는다():
    """★ 순서만 보고 찍으면 마지막 수정자가 작성자로 둔갑한다."""
    dump = {"text": "2026.08.21  3분 읽기",
            "anchors": [{"href": "/display/~someone", "text": "누구", "pos": 0}]}
    assert cb._byline_authors(dump) == {}


def test_byline_이_없으면_빈_dict():
    assert cb._byline_authors(None) == {}
    assert cb._byline_authors({"text": "작성자:", "anchors": []}) == {}


def test_display_링크_형태가_아니면_버린다():
    assert cb._knox_id_from_href("/people/abc") is None
    assert cb._knox_id_from_href("") is None
    assert cb._knox_id_from_href("/display/~HW_0758.Choi?src=x") == "hw_0758.choi"
