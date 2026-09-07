"""Confluence 브라우저 키워드 검색 tool — REST rate-limit 회피 경로.

배경: 이 인스턴스는 REST `/rest/api/content/search`(CQL)가 **정책상 영구 차단**(429, retry-after=int64max)이라
`confluence_cql_search`/`confluence_task_scan`(REST)로는 스캔이 불가능하다(B0 canary 확정). 유일한 실 경로는
사람처럼 **브라우저로 SSO 로그인 후 검색창(`/dosearchsite.action`)에 키워드를 넣어** 접근 가능한 페이지만
찾아가는 것이다(권한 없는 스페이스는 애초에 결과에 안 뜸 → path-jail 자동).

경계·안전:
- **모델은 URL 을 넣지 못한다**: 입력은 keyword(+선택 scope space) 뿐이고, tool 이 고정 base origin(`CONFLUENCE_BASE_URL`)
  으로 검색 URL 을 구성한다. 결과 링크도 **same-origin + 허용 page-view path**만 방문(off-site/위험 링크 차단).
- **원문/HTML 을 모델에 반환하지 않는다**: 각 페이지 본문은 코어 `scan_text`(detector 재사용, 재구현 금지)를 통과시켜
  **마스킹된 hit(category/kind/line_no/마스킹 preview)만** 반환한다. 페이지당·전체 페이지 수·글자수 budget 적용.
- **코어 private 프리미티브 격리**: `browser_tool._start_session/_require_page/_perform_login` 은 오직 아래
  `_ensure_session_logged_in` 한 곳에서만 쓴다. 코어는 무수정(사용만). 버전 드리프트 시 이 함수와 계약 테스트가
  먼저 깨지게 하여 조기 감지한다. `browser_session`/`browser_action`(is_destructive, 무인 승인거부) 직접호출 금지 —
  web_site_sweep 과 동일하게 tool 내부에서 세션·로그인·내비게이션을 처리한다.
- SSO 로그인은 1회만(코어 `_perform_login` 의 회로차단기가 AD lockout 방지). 편집/댓글/저장/삭제 없음(read-only).
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, ClassVar
from urllib.parse import quote, urlparse

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess
from secu_agent.detectors.text_scan import mask_scanned_text, scan_text
import secu_agent.agent.tools.browser_tool as bt
from service import state_domain as state
from _shared.queue_ownership import is_delegated_inspector, write_recommendation


def _mask(text: str | None) -> str:
    """방어심층 2차 마스킹 — scan_text 의 per-hit 마스킹이 놓친 preview ±윈도우 인접 시크릿·title/url
    시크릿을 코어 mask_scanned_text 로 한 번 더 봉인(codex: line_preview 는 hit 만 마스킹 → 미탐지 인접 노출)."""
    return mask_scanned_text(str(text or ""))

# 검색 결과에서 방문 허용할 내부 page-view path 마커(same-origin 전제).
_ALLOWED_PATH_MARKERS = ("/pages/viewpage.action", "/display/", "/spaces/")
def _record_browser_host(context: ToolContext, url: str) -> None:
    """정책 A 용 방문 host 기록 — 코어 `browser_tool._record_web_browser_host` 와 동형.

    `submit_finding._require_browser_verification` 이 `metadata['_web_browser_hosts']` 를 보고
    "이 host 를 브라우저로 열어본 적 있나"를 판정한다. 코어 browser_action/browser_query 는
    자동으로 기록하지만, 이 도구는 자체 page 를 몰아 쓰므로 직접 남겨야 한다.

    ⚠️ 호출부는 **본문(body)을 실제로 받은 뒤에만** 부른다. goto 실패·로그인벽·off-origin
    리다이렉트를 기록하면 게이트가 무력화된다.
    """
    try:
        host = (urlparse(url).hostname or "").lower()
        if not host or not hasattr(context, "metadata"):
            return
        hosts = context.metadata.setdefault("_web_browser_hosts", [])
        if host not in hosts:
            hosts.append(host)
    except Exception:  # noqa: BLE001 — 기록 실패가 검색을 멈추면 안 된다
        pass


_SEARCH_PATH = "/dosearchsite.action?queryString="
# 검색결과 상단에 늘 뜨는 네비/공지 링크(콘텐츠 아님) — 스캔 대상에서 제외.
_NAV_NOISE = ("Notice(공지", "Updates(기능", "새 소식", "DS Collaboration Tools")
_HITS_PER_PAGE_MAX = 30


class ConfluenceBrowserSearchInput(BaseModel):
    keywords: list[str] = Field(..., min_length=1, max_length=20, description="검색 키워드(허용목록에서 온 값). tool 이 고정 base 로 검색 URL 을 만든다.")
    scope_space_keys: list[str] | None = Field(default=None, description="지정 시 해당 space 안의 결과 page 만 방문.")
    max_pages: int = Field(default=40, ge=1, le=200, description="이 호출 전체 방문 page 예산. 키워드당 몫=max_pages//len(keywords)로 공정 분배(앞 키워드 독식 방지). keywords 수보다 크게 두면 모든 키워드가 검색됨.")
    result_pages_per_keyword: int = Field(
        default=3, ge=1, le=20,
        description=("키워드당 훑을 **검색결과 페이지** 수(문서 방문 예산과 별개). "
                     "1 이면 예전처럼 첫 화면만 본다. 올리면 커버리지가 늘지만 "
                     "네비게이션도 그만큼 는다."))
    max_page_chars: int = Field(default=200_000, ge=1000, le=2_000_000, description="page 당 scan_text 에 넘길 최대 글자수.")
    nav_timeout_ms: int = Field(default=30000, ge=3000, le=90000)


def _same_host(url: str, host: str | None) -> bool:
    if not host:
        return True
    try:
        return (urlparse(url).hostname or "").lower() == host.lower()
    except ValueError:
        return False


async def _goto_text(page: Any, url: str, timeout_ms: int, *, require_host: str | None = None) -> str | None:
    """url 로 이동 후 body 텍스트 반환. 실패/off-origin 리다이렉트 시 None.

    codex: goto 는 302/로그인벽으로 **다른 origin 에 안착**할 수 있다(hostname 사전검증만으론 부족). 이동 후
    **최종 `page.url` 이 require_host 와 같은 origin 인지 재검증**하고, 아니면 스캔하지 않는다(off-origin 유출 차단).
    """
    for wait in ("networkidle", "domcontentloaded"):
        try:
            await page.goto(url, wait_until=wait, timeout=timeout_ms)
            break
        except Exception:
            continue
    else:
        return None
    if require_host is not None:
        try:
            final_url = page.url
        except Exception:
            return None
        if not _same_host(final_url, require_host):  # 리다이렉트가 off-origin 에 안착 → 스캔 금지
            return None
    try:
        return await page.inner_text("body")
    except Exception:
        return ""


# ── 페이지 작성자(byline) 추출 ────────────────────────────────────────────────
# confluence 담당자의 **유일한 경로**다. REST 는 두 겹으로 막혀 있다 —
# Basic 은 403(`Basic Authentication has been disabled`), Bearer PAT 은 429(상시 rate-limit).
# space CQL 레인도 전량 403 이라, 살아 있는 건 이 브라우저 검색 하나뿐이다.
#
# 실측(2026-08-24, /spaces/4SEASON/pages/3778185555):
#   meta 태그에는 작성자가 **없다**(ajs-* 22개 전부 페이지/스페이스 메타).
#   `.page-metadata` 안의 `/display/~<계정>` 링크에 있다:
#       작성자: 최형우 …            → /display/~hw_0758.choi
#       마지막 업데이트: 편도성 …    → /display/~dosung.pyon
#   ★ 그 계정이 곧 Knox ID 다 — knox 대장 조회로 이름·부서가 byline 과 정확히 일치했다.
#      따라서 `<계정>@samsung.com` 이 그대로 담당자 메일이 된다.
#
# ⚠️ 문서 순서에 의존하지 않는다. 라벨(`작성자`/`Created by`)을 찾아 그 뒤 첫 링크를 쓴다.
#    라벨이 없으면 creator 를 **주장하지 않는다** — 순서만 보고 찍으면 마지막 수정자가
#    작성자로 둔갑한다.
_BYLINE_JS = """() => {
  const box = document.querySelector('.page-metadata, .page-metadata-modification-info');
  if (!box) return null;
  const anchors = [...box.querySelectorAll('a[href*="/display/~"]')].map(a => ({
    href: a.getAttribute('href') || '',
    text: (a.innerText || '').trim().slice(0, 80),
    pos: (box.innerText || '').indexOf((a.innerText || '').trim()),
  }));
  return {text: (box.innerText || '').slice(0, 400), anchors};
}"""

_CREATOR_LABELS = ("작성자", "created by", "creator")
_EDITOR_LABELS = ("마지막 업데이트", "last updated", "last modified", "updated by")


def _knox_id_from_href(href: str) -> str | None:
    """`/display/~hw_0758.choi` → `hw_0758.choi`. 형태가 다르면 None."""
    marker = "/display/~"
    idx = str(href or "").find(marker)
    if idx < 0:
        return None
    uid = href[idx + len(marker):].split("?")[0].split("#")[0].split("/")[0].strip().lower()
    return uid or None


def _label_pos(text: str, labels: tuple[str, ...]) -> int:
    low = str(text or "").lower()
    found = [low.find(lb) for lb in labels]
    found = [i for i in found if i >= 0]
    return min(found) if found else -1


def _byline_authors(dump: Any) -> dict[str, str]:
    """byline dump → {creator, last_editor} Knox ID. 확신 없으면 키를 넣지 않는다."""
    if not isinstance(dump, dict):
        return {}
    text = str(dump.get("text") or "")
    anchors = [a for a in (dump.get("anchors") or []) if isinstance(a, dict)]
    out: dict[str, str] = {}
    for key, labels in (("creator", _CREATOR_LABELS), ("last_editor", _EDITOR_LABELS)):
        at = _label_pos(text, labels)
        if at < 0:
            continue
        # 라벨 뒤에 오는 것 중 가장 가까운 링크. pos 가 없으면(텍스트 매칭 실패) 건너뛴다.
        after = [a for a in anchors if isinstance(a.get("pos"), int) and a["pos"] >= at]
        if not after:
            continue
        uid = _knox_id_from_href(after[0].get("href", ""))
        if uid:
            out[key] = uid
    return out


async def _page_authors(page: Any) -> dict[str, str]:
    try:
        return _byline_authors(await page.evaluate(_BYLINE_JS))
    except Exception:      # noqa: BLE001 — 작성자를 못 얻어도 스캔은 계속한다
        return {}


#: context.metadata 키 — 제출 도구가 같은 이름을 읽는다(키는 생산자가 소유한다).
PAGE_AUTHORS_KEY = "_confluence_page_authors"


def _record_page_authors(context: Any, url: str, authors: dict[str, str]) -> None:
    """url → 작성자 기록. ⚠️ 본문을 실제로 받은 뒤에만 부른다(방문 기록과 같은 규율)."""
    if not authors:
        return
    try:
        store = context.metadata.setdefault(PAGE_AUTHORS_KEY, {})
        store[str(url)] = dict(authors)
    except Exception:      # noqa: BLE001
        pass


# ── 페이지 접근 범위(제한) 추출 ─────────────────────────────────────────────
# ★ 같은 시크릿이라도 **몇 명이 볼 수 있느냐**로 사건의 크기가 달라진다.
#   지금까지 finding 은 `sso_session_established`("로그인하면 보였다") 만 기록했다 —
#   팀 5명이 보는 페이지와 전사가 보는 페이지가 같은 severity 로 나갔다.
#
# 실측(2026-08-26):
#   · 익명 접근은 **사이트 전체가 302 로그인 리다이렉트** — "로그인 없이 보임" 은 없다.
#   · 페이지 제한은 `#content-metadata-page-restrictions` 가 말해 준다.
#     제한 없는 페이지에서 실제로 "무제한" 을 반환했다.
#
# ⚠️ 본문 텍스트에서 "제한"/"Restricted" 를 정규식으로 찾으면 **사이드바 페이지 트리의
#    다른 페이지 이름**이 잡힌다(처음에 그렇게 해서 오탐이 났다). 반드시 이 선택자로 본다.
_RESTRICTIONS_SEL = "#content-metadata-page-restrictions"

#: context.metadata 키 — 제출 도구가 같은 이름을 읽는다(키는 생산자가 소유한다).
PAGE_ACCESS_KEY = "_confluence_page_access"


async def _page_access(page: Any) -> dict[str, str]:
    """페이지 접근 범위. 못 읽으면 **빈 dict** — 모르는 것을 '무제한' 으로 적지 않는다."""
    try:
        n = await page.eval_on_selector_all(_RESTRICTIONS_SEL, "els => els.length")
        if not n:
            return {}
        raw = await page.eval_on_selector_all(
            _RESTRICTIONS_SEL,
            "els => els.map(e => (e.innerText || e.title || '').trim()).join(' ')")
    except Exception:      # noqa: BLE001 — 못 얻어도 스캔은 계속한다
        return {}
    text = str(raw or "").strip()
    if not text:
        return {}
    # "무제한" / "Unrestricted" 면 이 인스턴스에서는 **로그인한 전 임직원**이 본다.
    unrestricted = any(w in text for w in ("무제한", "Unrestricted", "unrestricted"))
    return {
        "restrictions": text[:200],
        "scope": "all_logged_in_employees" if unrestricted else "restricted",
    }


def _record_page_access(context: Any, url: str, access: dict[str, str]) -> None:
    """url → 접근 범위 기록. ⚠️ 본문을 실제로 받은 뒤에만 부른다(방문 기록과 같은 규율)."""
    if not access:
        return
    try:
        store = context.metadata.setdefault(PAGE_ACCESS_KEY, {})
        store[str(url)] = dict(access)
    except Exception:      # noqa: BLE001
        pass


async def _ensure_session_logged_in(base: str) -> tuple[Any, ToolError | None]:
    """(격리 지점) 코어 browser_tool 프리미티브로 세션 확보 + SSO 로그인 1회.

    코어 private API(_start_session/_require_page/_perform_login)는 여기서만 호출한다. 이미 열린 세션이 있으면
    재사용한다. login_ok 는 호출측이 payload 에 실어 worker 가 outcome(auth_failed 등)을 판정하게 한다.
    """
    page, perr = bt._require_page()
    if perr is not None:
        ok, reason = await bt._start_session(headless=True, viewport_width=1280, viewport_height=800)
        if not ok:
            return None, ToolError(kind="execution", message=f"브라우저 세션 시작 실패: {reason}")
        page, perr = bt._require_page()
        if perr is not None:
            return None, perr
    # 홈 방문(로그인 리다이렉트 안착) 후 auto 로그인. 주입 세션이 이미 있으면 코어가 skip.
    # 홈 goto 는 IdP 로 리다이렉트될 수 있어 require_host 를 걸지 않는다(로그인은 _perform_login 이 처리).
    await _goto_text(page, base + "/index.action", 30000)
    try:
        login_ok, login_msg, _fatal = await bt._perform_login(page, "auto")
    except Exception as e:  # noqa: BLE001
        login_ok, login_msg = False, repr(e)
    # codex: 로그인 후 **최종 URL 이 Confluence origin 으로 돌아왔는지 재검증**(web_site_sweep 의 off_origin_final_url
    # 검사와 동형). IdP 화면에 갇혀 있으면 인증 미완 → login_ok 를 내린다(off-origin 콘텐츠 스캔·오탐 방지).
    host = urlparse(base).hostname
    try:
        landed_ok = _same_host(page.url, host)
    except Exception:  # noqa: BLE001
        landed_ok = False
    if not landed_ok:
        login_ok = False
        login_msg = f"로그인 후 off-origin 안착(IdP 갇힘 가능): {str(getattr(page, 'url', ''))[:120]}"
    _set_login_state(login_ok, login_msg)
    return page, None


# 로그인 상태를 execute 로 전달하기 위한 경량 컨텍스트(모듈 전역 아님 — per-call 인스턴스에 저장).
_LOGIN_STATE: dict[str, Any] = {}


def _set_login_state(ok: bool, msg: str) -> None:
    _LOGIN_STATE["ok"] = bool(ok)
    _LOGIN_STATE["msg"] = str(msg)[:200]


def _in_scope(href: str, scope_space_keys: list[str]) -> bool:
    return any(
        (f"/display/{k}" in href) or (f"spaceKey={k}" in href) or (f"/spaces/{k}/" in href)
        for k in scope_space_keys
    )


async def _result_links(
    page: Any, host: str | None, scope_space_keys: list[str] | None,
) -> list[dict[str, str]]:
    """현재 검색결과 페이지의 링크 중 same-origin + 허용 page path + (scope 지정 시) 해당 space 만 수집.

    ⚠️ **시그니처를 바꾸지 마라.** 살아 있는 호출부와 테스트 스텁이 이 세 인자에 묶여
       있다(스텁은 `lambda p, h, s: [...]` 다). 소진 판정에 필요한 "필터 이전 수" 는
       `scope_space_keys=None` 으로 한 번 더 불러서 얻는다 — 같은 DOM 이라 비용이 없다.
    """
    try:
        arr = await page.eval_on_selector_all(
            "a", "els => els.map(e => ({t:(e.textContent||'').trim(), h:e.href}))"
        )
    except Exception:
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for a in arr:
        h = (a.get("h") or "").strip()
        t = (a.get("t") or "").strip()
        if not h or h in seen:
            continue
        try:
            pu = urlparse(h)
        except ValueError:
            continue
        if host and pu.hostname != host:  # same-origin only(off-site 차단)
            continue
        if not any(m in h for m in _ALLOWED_PATH_MARKERS):
            continue
        if "search" in h.lower():
            continue
        if any(n in t for n in _NAV_NOISE):
            continue
        seen.add(h)
        if scope_space_keys and not _in_scope(h, scope_space_keys):
            continue
        out.append({"url": h, "title": t})
    return out


#: 검색결과 한 페이지 항목 수(Confluence DC 기본). startIndex 스텝으로도 쓴다.
_RESULT_PAGE_SIZE = 20
#: 키워드 하나에 넘길 검색결과 페이지 수 상한. 무한루프 방지용 백스톱이지 배급이 아니다.
_MAX_RESULT_PAGES = 50


async def _goto_result_page(
    page: Any, base: str, keyword: str, start: int, timeout_ms: int, host: str | None,
) -> bool:
    """검색결과 N번째 페이지로 이동. URL 로 안 되면 클릭으로 넘긴다.

    ★ 형제 목록에서 배운 것: space directory 는 `?startIndex=N` 을 **서버가 무시하고**
      첫 페이지를 준다(confluence_browser_spaces.py:104 실측 — 24/48/360 전부 같은 결과).
      검색결과가 같은지 다른지는 확인된 바 없으므로 **둘 다 시도하고, 통한 쪽을 기록한다.**
      호출측이 결과 id 집합이 안 바뀌면 소진으로 판정하므로, 여기서 거짓말해도 안전하다.
    """
    url = base + _SEARCH_PATH + quote(keyword)
    if start:
        url = f"{url}&startIndex={start}"
    if await _goto_text(page, url, timeout_ms, require_host=host) is not None:
        return True
    return False


async def _click_next_results(page: Any, start: int) -> bool:
    """`startIndex=N` 링크를 클릭해 다음 결과 페이지로. 없으면 False(=마지막)."""
    sel = f'a[href*="startIndex={start}"]'
    try:
        if await page.eval_on_selector_all(sel, "els => els.length") == 0:
            return False
        await page.click(sel)
        await page.wait_for_timeout(2000)      # XHR 이 DOM 을 갈아끼울 시간
        return True
    except Exception:  # noqa: BLE001 — 못 넘기면 여기까지가 우리가 본 전부다
        return False


async def _all_result_links(
    page: Any, base: str, keyword: str, *, host: str | None,
    scope_space_keys: list[str] | None, timeout_ms: int, max_pages: int,
) -> tuple[list[dict[str, str]], dict[str, Any]]:
    """검색결과를 **끝까지** 훑어 링크를 모은다 → (링크, 계측).

    ★ 예전엔 첫 페이지만 봤다. 키워드 하나가 평생 보는 것이 검색 첫 화면뿐이었고,
      `password` 로 수백 건이 걸려도 거기서 잘렸다. 기준이 "검색돼서 조회한 것 중에
      그런 내용이 있으면 문제" 라면, **검색을 좁히는 것이 곧 커버리지 상한**이다.

    ⚠️ 소진과 절단을 구분해 돌려준다. "더 없다" 와 "여기서 그만 봤다" 는 다른 사실이다.
    """
    links: list[dict[str, str]] = []
    seen: set[str] = set()
    meta: dict[str, Any] = {"result_pages": 0, "pagination": "none", "exhausted": False}

    for i in range(max(1, max_pages)):
        start = i * _RESULT_PAGE_SIZE
        if i == 0:
            if not await _goto_result_page(page, base, keyword, 0, timeout_ms, host):
                return links, meta
        else:
            # URL 먼저, 안 먹으면 클릭. 어느 쪽이 통했는지는 아래 신규 링크 유무로 판정한다.
            moved = await _goto_result_page(page, base, keyword, start, timeout_ms, host)
            if not moved and not await _click_next_results(page, start):
                meta["exhausted"] = True
                break

        page_links = await _result_links(page, host, scope_space_keys)
        # 소진 판정용 **필터 이전** 수. 같은 DOM 을 한 번 더 읽을 뿐이다.
        page_unscoped = len(await _result_links(page, host, None))
        fresh = [x for x in page_links if x["url"] not in seen]
        if i and not fresh:
            # 같은 페이지를 다시 받았다 = 서버가 startIndex 를 무시했다. 클릭으로 재시도.
            if await _click_next_results(page, start):
                page_links = await _result_links(page, host, scope_space_keys)
                page_unscoped = len(await _result_links(page, host, None))
                fresh = [x for x in page_links if x["url"] not in seen]
                if fresh:
                    meta["pagination"] = "click"
            if not fresh:
                meta["exhausted"] = True
                break
        elif i:
            meta["pagination"] = meta["pagination"] if meta["pagination"] != "none" else "url"

        for x in fresh:
            seen.add(x["url"])
        links.extend(fresh)
        meta["result_pages"] = i + 1
        # ⚠️ 소진 판정은 **scope 후필터 이전** 수로 한다. 필터 후 수로 보면 필터가 많이
        #    걷어냈을 때 마지막 페이지로 오해한다 — 실측(2026-08-28): 필터 후 공급량이
        #    12~23이라 생산적 키워드의 94.5%가 첫 페이지에서 잘못 끝났다. 그 상태로
        #    이 함수를 배선하면 페이지 넘기기가 사실상 동작하지 않는다.
        if page_unscoped < _RESULT_PAGE_SIZE:
            meta["exhausted"] = True     # 서버가 준 결과가 한 페이지를 못 채웠다 = 마지막
            break

    return links, meta


class ConfluenceBrowserSearchTool(Tool[ConfluenceBrowserSearchInput]):
    name: ClassVar[str] = "confluence_browser_search"
    domain: ClassVar[str] = "confluence"
    description: ClassVar[str] = (
        "브라우저 SSO 로그인 후 Confluence 검색창(dosearchsite)에 키워드로 검색 → 접근가능한 page 만 방문 → "
        "scan_text 로 마스킹된 후보만 반환(REST rate-limit 회피). 원문/HTML 미반환. 입력은 keyword(+scope space)뿐."
    )
    input_model: ClassVar[type[BaseModel]] = ConfluenceBrowserSearchInput
    search_hint: ClassVar[str] = "confluence browser keyword search dosearchsite masked scan"
    # 브라우저 navigation 을 구동하지만 page 변경/쓰기는 없음(read-only). web_site_sweep 과 동일하게
    # is_destructive 아님 → 무인 워커에서 승인거부되지 않음.
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = True

    async def execute(self, vi: ConfluenceBrowserSearchInput, ctx: ToolContext) -> ToolResult:
        base = os.environ.get("CONFLUENCE_BASE_URL", "").rstrip("/")
        if not base:
            return ToolError(kind="validation", message="CONFLUENCE_BASE_URL 미설정 — 검색 대상 origin 없음")
        host = urlparse(base).hostname

        page, err = await _ensure_session_logged_in(base)
        if err is not None:
            return err

        candidates: list[dict[str, Any]] = []
        scanned = 0
        seen_urls: set[str] = set()
        per_keyword: list[dict[str, Any]] = []
        #: 훑은 **검색결과 페이지** 수(문서 방문과 별개) — 커버리지 판단 재료.
        result_pages_total = 0
        #: 결과가 더 남았는데 상한에 걸려 끊은 키워드. 조용한 절단 금지.
        truncated_keywords: list[str] = []
        # 공정 분배: max_pages 는 이 호출 전체 예산이고, 키워드당 몫 = max_pages//n. 앞 키워드가 결과가
        # 많아도 자기 몫만 쓰게 해 뒤 키워드가 아예 검색조차 안 되는 커버리지 누락(적대검증 지적)을 막는다.
        # 몫 = max_pages//n 이라 마지막 키워드 도달 전 total 은 항상 max_pages 미만 → 모든 키워드가 검색됨.
        n_kw = max(1, len(vi.keywords))
        per_kw_budget = max(1, vi.max_pages // n_kw)
        for kw in vi.keywords:
            kw_scanned = 0
            searched = False
            if scanned < vi.max_pages:
                search_url = base + _SEARCH_PATH + quote(kw)
                # 검색결과 페이지도 confluence origin 재검증(로그인벽/off-origin 안착 시 skip).
                if await _goto_text(page, search_url, vi.nav_timeout_ms, require_host=host) is not None:
                    searched = True
                    # ★ 검색결과를 **여러 페이지** 훑는다. 예전엔 첫 화면만 봤다 —
                    #   `password` 로 수백 건이 걸려도 거기서 잘렸고, 그게 곧 커버리지
                    #   상한이었다. 헬퍼는 있었는데 부르는 데가 없었다(호출부 0).
                    #
                    # ⚠️ 결과 페이지 넘기기는 **추가 네비게이션**이다. `max_pages` 는
                    #    문서 방문 예산이라 이걸 안 세므로, 키워드당 별도 상한을 둔다.
                    #    사내 confluence 의 rate limit/WAF 반응은 미측정이라 보수적으로.
                    kw_links, kw_meta = await _all_result_links(
                        page, base, kw, host=host,
                        scope_space_keys=vi.scope_space_keys,
                        timeout_ms=vi.nav_timeout_ms,
                        max_pages=min(vi.result_pages_per_keyword,
                                      max(1, per_kw_budget)),
                    )
                    meta_pages = int(kw_meta.get("result_pages") or 1)
                    result_pages_total += meta_pages
                    if not kw_meta.get("exhausted"):
                        truncated_keywords.append(kw)
                    for link in kw_links:
                        if kw_scanned >= per_kw_budget or scanned >= vi.max_pages:
                            break
                        if link["url"] in seen_urls:
                            continue
                        seen_urls.add(link["url"])
                        body = await _goto_text(page, link["url"], vi.nav_timeout_ms, require_host=host)
                        kw_scanned += 1
                        scanned += 1
                        if not body:  # 도달 실패 또는 off-origin 리다이렉트 → 스캔 안 함
                            continue
                        # 정책 A(submit_finding._require_browser_verification): 제출하려면 대상 host 를
                        # **browser 로 실제 열어본 기록**이 있어야 한다. 이 도구는 이미 실제 브라우저로
                        # 본문을 열었는데(위 _goto_text 가 성공해 body 를 받았다) 기록만 안 남겨서,
                        # 워커가 진짜 노출을 찾아도 submit 이 전부 거부됐다(2026-08-17 실측).
                        # ⚠️ body 를 받은 뒤에만 기록한다 — goto 실패/로그인벽/off-origin 리다이렉트는
                        #    "열어봤다"가 아니다. 그걸 기록하면 게이트가 무력화된다.
                        _record_browser_host(ctx, link["url"])
                        # 담당자(글 작성자) — 본문을 받은 이 자리에서만 긁는다.
                        _record_page_authors(ctx, link["url"], await _page_authors(page))
                        _record_page_access(ctx, link["url"], await _page_access(page))
                        res = scan_text(
                            body[: vi.max_page_chars], label=link["url"],
                            include_entropy=True, include_document_signals=True,
                        )
                        if res.hits:
                            candidates.append({
                                "keyword": kw,
                                "url": _mask(link["url"]),      # url/title 도 방어심층 마스킹(query 토큰·제목 내 시크릿)
                                "title": _mask(link["title"]),
                                "n_hits": len(res.hits),
                                "hits": [
                                    {
                                        "category": h.category,
                                        "kind": h.kind,
                                        "line_no": h.line_no,
                                        # line_preview 는 hit 만 마스킹 → ±윈도우 미탐지 인접 노출 대비 2차 마스킹.
                                        "masked_preview": _mask(h.line_preview),
                                    }
                                    for h in res.hits[:_HITS_PER_PAGE_MAX]
                                ],
                            })
            # searched=False = 검색조차 안 됨(예산 소진 or 검색페이지 도달 실패) → 워커가 커버리지 판단에 사용.
            per_keyword.append({"keyword": kw, "searched": searched, "pages": kw_scanned})

        payload = {
            "login_ok": _LOGIN_STATE.get("ok"),
            "login_msg": _LOGIN_STATE.get("msg"),
            "keywords": vi.keywords,
            "scanned_pages": scanned,
            # 검색결과를 몇 페이지까지 넘겼나. 1 이면 예전과 같은 커버리지다.
            "result_pages_scanned": result_pages_total,
            # ⚠️ 결과가 더 남았는데 상한(result_pages_per_keyword)에 걸려 끊은 키워드.
            #    비어 있지 않으면 이 검색은 **전수가 아니다** — 조용한 절단 금지.
            "truncated_keywords": truncated_keywords,
            "per_keyword": per_keyword,
            "candidate_pages": len(candidates),
            "candidates": candidates,
        }
        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))


_SEARCH_VALID_STATUSES = {"tasked", "skipped", "error", "pending"}


class ConfluenceSearchSetStatusInput(BaseModel):
    target_ids: list[int] = Field(
        ..., min_length=1, description="confluence_search_target id 목록(이번 워커가 claim한 키워드들)")
    status: str = Field(..., description="tasked | skipped | error | pending")
    finding_count: int = Field(default=0, ge=0, description="이 배치에서 제출한 finding 총수")
    reason: str | None = Field(default=None, description="skipped/error 판단 사유(짧게)")


class ConfluenceSearchSetStatusTool(Tool[ConfluenceSearchSetStatusInput]):
    """keyword_search 워커의 terminal 상태툴 — confluence_search_target rolling 큐 전이.

    ConfluenceSpaceSetStatusTool 의 축약형: keyword_search 는 REST scan 단계가 없어
    `_confluence_task_scan_*` 재분류 메타가 없다. claim 된 target_ids 를 한 번에 닫는다
    (space_batch 와 동일 — 배치 전체에 하나의 finding_count). auth 실패(login_ok=false)나
    검색 불가는 error/skipped, 정상 종료는 tasked 로 닫고 큐에서 빠져 cooldown 후 재검색된다.
    """

    name: ClassVar[str] = "confluence_search_set_status"
    domain: ClassVar[str] = "confluence"
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = True
    input_model: ClassVar[type[BaseModel]] = ConfluenceSearchSetStatusInput
    search_hint: ClassVar[str] = (
        "confluence search target status tasked skipped keyword rolling queue"
    )
    description: ClassVar[str] = (
        "브라우저 키워드 검색(confluence_browser_search) 후 claim 된 confluence_search_target 들의 "
        "상태 전이(tasked/skipped/error). tasked=정상 검색 완료(큐에서 빠지고 cooldown 후 재검색), "
        "skipped=로그인/권한 불가, error=검색 실패. 한 번만 호출하고 배치 전체 target_ids 를 함께 닫는다."
    )

    async def execute(
        self, validated_input: ConfluenceSearchSetStatusInput, context: ToolContext,
    ) -> ToolResult:
        status = validated_input.status
        if status not in _SEARCH_VALID_STATUSES:
            return ToolError(
                kind="validation",
                message=f"invalid status {status!r} — {sorted(_SEARCH_VALID_STATUSES)}",
            )
        try:
            target_ids = [int(tid) for tid in validated_input.target_ids]
        except (TypeError, ValueError):
            return ToolError(kind="validation", message="target_ids must be integers")
        missing = [tid for tid in target_ids if state.confluence_search_target_get(tid) is None]
        if missing:
            return ToolError(
                kind="not_found",
                message=f"confluence_search_target not found: {missing}",
            )
        reason = validated_input.reason
        fields: dict[str, Any] = {"finding_count": validated_input.finding_count}
        if reason:
            fields["last_reason"] = reason[:500]
        # 큐 소유권(Phase 2): 위임된 검토원은 닫지 않는다 — 리드가 닫는다.
        if is_delegated_inspector():
            payload = write_recommendation(
                context.evidence_dir, target_ids=target_ids, status=status,
                finding_count=validated_input.finding_count, reason=reason,
                queue="confluence_search_target",
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))
        n = 0
        for tid in target_ids:
            try:
                state.confluence_search_target_set_status(tid, status, **fields)
                n += 1
            except Exception:  # noqa: BLE001 — 개별 id 실패는 건너뜀(space setter 와 동형)
                continue
        return ToolSuccess(content=f"confluence_search_target {n}개 → {status}.")
