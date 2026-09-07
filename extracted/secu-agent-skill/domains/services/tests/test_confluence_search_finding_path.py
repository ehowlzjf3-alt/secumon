"""confluence keyword_search 의 finding 저장 경로 고정.

배경(2026-08-17 실측) — 2026-08-15 커밋 dfff356 에서 worker.md 에 이렇게 적었다:

    "Do not call `submit_finding` in this kind. `confluence_browser_search` already
     persists a finding for every page it confirms (source='browser_authenticated_search')"

**그 전제가 사실이 아니었다.** `confluence_browser_search` 에는 finding 을 저장하는 코드가
한 줄도 없다. DB 의 기존 finding 5건이 그 source 를 달고 있는 것을 보고 "도구가 저장하겠구나"
하고 **추론**해서 쓴 문장이었다(`git log -S` 로 확인: 그 문자열을 저장소에 처음 들여온 것이
바로 그 커밋이다 — 그런 코드는 존재한 적이 없다).

결과: 워커는 실제 노출을 찾아도 제출하지 않고 `finding_count` 에 숫자만 적었다. 그건
**워커가 타이핑하는 자기보고 값**이라 아무것도 저장하지 않는다. 8/15~8/17 사이 confluence
keyword_search 는 **구조적으로 finding 을 남길 수 없었다**(87개 키워드 전수 검색 후 0건).

두 번째 문제: 정책 A(`submit_finding._require_browser_verification`)는 대상 host 를 브라우저로
열어본 기록(`metadata['_web_browser_hosts']`)을 요구하는데, 이 도구는 **실제로 page.goto 로
본문을 열면서도** 그 기록을 남기지 않았다. 그래서 규약을 되돌려도 제출이 전부 거부됐을 것이다.

이 파일은 두 전제를 코드로 고정한다.
"""
from __future__ import annotations

import inspect
from pathlib import Path

from domains.services.confluence.plugin.tools import confluence_browser_search_tool as cbs

ROOT = Path(__file__).resolve().parents[3]
WORKER_MD = ROOT / "domains/services/confluence/skills/confluence_task/worker.md"


def test_search_tool_does_not_silently_claim_to_persist_findings() -> None:
    """★ 이 도구는 finding 을 저장하지 않는다. 저장한다고 **가정하지 마라**.

    저장 기능이 나중에 실제로 생기면 이 테스트를 고치면서 worker.md 도 같이 고치게 된다 —
    그게 목적이다(둘이 어긋난 채로 굴러간 것이 이번 버그다).
    """
    src = inspect.getsource(cbs)
    persists = any(
        marker in src
        for marker in ("finding_lifecycle", "finding_upsert", "submit_finding(")
    )
    assert not persists, (
        "confluence_browser_search 가 finding 을 저장하게 됐다면 "
        "worker.md 의 '반드시 submit_finding 으로 제출' 지침도 같이 고쳐야 한다"
    )


def test_worker_md_tells_the_worker_to_submit_findings() -> None:
    """★ 저장 경로는 submit_finding 뿐이다 — 규약이 그것을 막으면 finding 이 유실된다."""
    text = WORKER_MD.read_text(encoding="utf-8")
    assert "submit_finding(task_type='confluence')" in text, (
        "keyword_search 규약이 submit_finding 을 지시하지 않는다 — 찾아도 저장되지 않는다"
    )
    assert "Do not call `submit_finding` in this kind" not in text, (
        "제거된 오지침이 되살아났다(dfff356). 검색 도구는 finding 을 저장하지 않는다"
    )


def test_worker_md_warns_that_finding_count_persists_nothing() -> None:
    """`finding_count` 는 워커가 타이핑하는 자기보고 숫자다 — 그 사실을 규약이 말해야 한다."""
    text = WORKER_MD.read_text(encoding="utf-8")
    assert "finding_count" in text and "you type" in text, (
        "finding_count 가 자기보고 값이라는 경고가 규약에 없다"
    )


def test_search_tool_records_visited_hosts_for_policy_a() -> None:
    """★ 정책 A 는 `_web_browser_hosts` 를 본다. 안 남기면 제출이 전부 거부된다."""
    src = inspect.getsource(cbs)
    assert "_web_browser_hosts" in src, (
        "검색 도구가 방문 host 를 기록하지 않는다 — 정책 A 가 submit 을 전부 거부한다"
    )
    assert "def _record_browser_host" in src


def test_visited_host_is_recorded_only_after_the_body_is_fetched() -> None:
    """⚠️ goto 실패·로그인벽·off-origin 리다이렉트를 기록하면 게이트가 무력화된다.

    기록 호출은 `if not body: continue` **뒤에** 있어야 한다.
    """
    src = inspect.getsource(cbs.ConfluenceBrowserSearchTool.execute)
    guard = src.index("if not body:")
    record = src.index("_record_browser_host(")
    assert record > guard, (
        "body 획득 전에 host 를 기록하고 있다 — 도달 못 한 페이지가 '열어봤음'으로 통과한다"
    )


def test_record_helper_is_host_only_and_never_raises() -> None:
    """기록 실패가 검색을 멈추면 안 된다(부가 기능이다)."""
    src = inspect.getsource(cbs._record_browser_host)
    assert "hostname" in src, "URL 전체가 아니라 host 만 기록해야 한다"
    assert "except Exception" in src


def test_record_helper_appends_lowercased_host_without_duplicates() -> None:
    """정책 A 는 소문자 host 집합과 대조한다 — 표기가 어긋나면 매칭이 안 된다."""

    class _Ctx:
        metadata: dict = {}

    ctx = _Ctx()
    ctx.metadata = {}
    cbs._record_browser_host(ctx, "https://Confluence.SamsungDS.net/spaces/X/pages/1")
    cbs._record_browser_host(ctx, "https://confluence.samsungds.net/spaces/Y/pages/2")
    assert ctx.metadata["_web_browser_hosts"] == ["confluence.samsungds.net"]


def test_record_helper_ignores_unusable_input() -> None:
    class _Ctx:
        metadata: dict = {}

    ctx = _Ctx()
    ctx.metadata = {}
    cbs._record_browser_host(ctx, "")
    cbs._record_browser_host(ctx, "not a url")
    assert ctx.metadata.get("_web_browser_hosts", []) == []


# ── 실행 테스트 ────────────────────────────────────────────────────────────
# ⚠️ 위 테스트들은 전부 **소스 문자열**만 본다. 그래서 2026-08-17 에 내가 넣은
#    `_record_browser_host(context, ...)` 의 변수명 오류(실제 파라미터는 `ctx`)를
#    스위트 1944건이 통과시켰다. 라이브에서 `error:execution` 으로 검색이 통째로
#    죽고 나서야 발견했다. → 가짜 브라우저로 execute 를 **실제로 태운다**.
import asyncio

import pytest

from secu_agent.agent.tools.base import ToolContext


class _FakePage:
    """page.goto/inner_text/url 만 흉내내는 최소 스텁."""

    def __init__(self, bodies: dict[str, str]):
        self._bodies = bodies
        self.url = ""

    async def goto(self, url, **_kw):
        self.url = url
        if url not in self._bodies:
            raise RuntimeError("nav failed")

    async def inner_text(self, _sel):
        return self._bodies.get(self.url, "")


@pytest.fixture
def _fake_confluence(monkeypatch, tmp_path):
    base = "https://confluence.example.net"
    page_url = f"{base}/spaces/OPS/pages/1/secret-doc"
    bodies = {
        f"{base}/index.action": "home",
        f"{base}{cbs._SEARCH_PATH}password": "results",
        page_url: "db_password=hunter2ExposedValue\n",
    }
    page = _FakePage(bodies)
    monkeypatch.setenv("CONFLUENCE_BASE_URL", base)
    monkeypatch.setattr(cbs, "_ensure_session_logged_in",
                        lambda _b: asyncio.sleep(0, result=(page, None)))
    monkeypatch.setattr(cbs, "_LOGIN_STATE", {"ok": True, "msg": ""}, raising=False)
    monkeypatch.setattr(cbs, "_result_links",
                        lambda _p, _h, _s: asyncio.sleep(
                            0, result=[{"url": page_url, "title": "secret doc"}]))
    return page_url, ToolContext(evidence_dir=tmp_path, metadata={})


def test_execute_runs_and_records_the_visited_host(_fake_confluence) -> None:
    """★ execute 를 실제로 태운다 — 변수명 오류/NameError 를 여기서 잡는다."""
    page_url, ctx = _fake_confluence
    vi = cbs.ConfluenceBrowserSearchInput(keywords=["password"], max_pages=5)
    res = asyncio.run(cbs.ConfluenceBrowserSearchTool().execute(vi, ctx))

    assert not isinstance(res, type(None))
    assert getattr(res, "kind", None) != "execution", f"execute 가 실패했다: {res}"
    assert ctx.metadata.get("_web_browser_hosts") == ["confluence.example.net"], (
        "방문 host 가 기록되지 않았다 — 정책 A 가 submit 을 전부 거부하게 된다"
    )


def test_execute_does_not_record_unreachable_pages(monkeypatch, tmp_path) -> None:
    """도달 실패(goto 예외)는 '열어봤다'가 아니다 — 기록하면 게이트가 무력화된다."""
    base = "https://confluence.example.net"
    page = _FakePage({f"{base}/index.action": "home",
                      f"{base}{cbs._SEARCH_PATH}password": "results"})
    monkeypatch.setenv("CONFLUENCE_BASE_URL", base)
    monkeypatch.setattr(cbs, "_ensure_session_logged_in",
                        lambda _b: asyncio.sleep(0, result=(page, None)))
    monkeypatch.setattr(cbs, "_LOGIN_STATE", {"ok": True, "msg": ""}, raising=False)
    monkeypatch.setattr(cbs, "_result_links",
                        lambda _p, _h, _s: asyncio.sleep(
                            0, result=[{"url": f"{base}/spaces/X/pages/9/gone", "title": "gone"}]))
    ctx = ToolContext(evidence_dir=tmp_path, metadata={})
    vi = cbs.ConfluenceBrowserSearchInput(keywords=["password"], max_pages=5)
    asyncio.run(cbs.ConfluenceBrowserSearchTool().execute(vi, ctx))
    assert ctx.metadata.get("_web_browser_hosts", []) == []
