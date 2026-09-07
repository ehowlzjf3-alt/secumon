"""space 열거 — 브라우저 전용 (2026-08-26).

## 왜 REST 가 아닌가

`cf.list_spaces` 는 `/rest/api/space` 를 친다. 그 엔드포인트는 죽어 있다(실측 2026-08-26):

    Basic (user+token)  403  "Basic Authentication has been disabled on this instance."
    Bearer PAT          429  "속도 제한이 초과되었습니다."

그래서 `confluence.space_discovery` 가 매 런 실패해 왔다 —
`pipeline_run` 에 `RuntimeError('Confluence list_spaces failed: HTTP 403')` 가
25시간 전·1시간 전 모두 남아 있고, **space 큐는 id 1~25 에서 몇 주째 안 늘었다.**

★ 다행히 **조용히 실패하진 않았다**(status=error + 사유). 그래서 "0건이니 깨끗함" 으로
읽히지는 않았다. 그 대신 아무도 안 봤을 뿐이다.

## 어떻게 세나

Confluence DC 의 space directory 를 브라우저로 연다. SSO 세션은
`confluence_browser_search_tool._ensure_session_logged_in` 을 그대로 재사용한다 —
로그인 회로차단기(AD lockout 방지)가 거기 하나에만 있어야 하기 때문이다.

space key 는 **링크에서** 뽑는다. `/display/<KEY>` · `/spaces/<KEY>` 두 형태다.
DOM 클래스나 테이블 열 위치에 기대지 않는다 — Confluence 테마가 바뀌면 조용히 0건이 된다.

⚠️ **0건과 실패를 구분한다.** 링크를 하나도 못 찾으면 그건 "space 가 없다" 가 아니라
"못 읽었다" 다. 호출측이 그걸 알 수 있게 `ok=False` 로 답한다 — 조용히 빈 목록을
돌려주면 discovery 가 성공으로 기록되고 큐가 비어 가는 것을 아무도 모른다.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

log = logging.getLogger("confluence.browser_spaces")

# space directory 후보 경로. Confluence DC 버전마다 다르므로 순서대로 시도한다.
_DIRECTORY_PATHS = (
    "/spacedirectory/view.action",
    "/spaces/viewspacesummary.action",
    "/dosearchsite.action?queryString=&where=conf_all",
)

# space key 가 링크에 나타나는 **세 가지** 형태를 모두 잡는다.
#
#   ① /display/<KEY>                            page 링크
#   ② /spaces/<KEY>                              space 홈
#   ③ /spaces/viewspacesummary.action?key=<KEY>  ← **space directory 가 실제로 쓰는 형태**
#
# ★ ③ 을 빠뜨려서 26개만 잡혔다(2026-08-26). `viewspacesummary.action` 이 `_RESERVED`
#   에 있어 오히려 **걸러지고** 있었고, 그래서 디렉터리 본문의 진짜 항목이 전부 버려졌다.
#   실측으로 확인: 페이지네이션 클릭 한 번에 `?key=` 형태가 48개 새로 나타났다.
#
# ⚠️ 경계는 **lookahead** 다. `(?:[/?#]|$)` 로 두면 `"/spaces/4SEASON"` 처럼 키에서
#    끝나는 href 는 뒤가 따옴표라 하나도 안 잡힌다(이것도 자기 테스트가 잡았다).
_SPACE_HREF_RE = re.compile(
    r"""/(?:display|spaces)/([A-Za-z0-9._~-]{1,80})(?=["'/?#\s>]|$)""")
_SPACE_KEY_PARAM_RE = re.compile(
    r"""[?&]key=([A-Za-z0-9._~-]{1,80})(?=["'&#\s>]|$)""")

# space key 가 아닌 것들 — Confluence 가 같은 경로 모양으로 쓰는 예약어.
_RESERVED = frozenset({
    "viewspacesummary.action", "createspace.action", "listspaces.action",
    "index.action", "dashboard.action", "viewpage.action", "login.action",
})

_MAX_SPACES = 5000


@dataclass(frozen=True, slots=True)
class BrowserSpace:
    """`cf.CfSpace` 와 **소비 계약이 같다** — discovery 가 읽는 것은 key/name/type 뿐이다."""

    key: str
    name: str = ""
    type: str = ""
    url: str = ""


def _space_keys_from_html(html: str) -> list[str]:
    """앵커 href 에서 space key 를 뽑는다. 순서 보존 + 중복 제거."""
    raw = str(html or "")
    seen: dict[str, None] = {}
    for regex in (_SPACE_KEY_PARAM_RE, _SPACE_HREF_RE):
        for m in regex.finditer(raw):
            key = m.group(1)
            if key.lower() in _RESERVED or key.endswith(".action"):
                continue
            seen.setdefault(key, None)
    return list(seen)


_PAGE_SIZE = 24          # space directory 한 페이지 항목 수 (실측: startIndex 가 24 배수)
_MAX_PAGES = 60          # 24×60 = 1,440 — 실측 링크 최대치(648)의 두 배 여유
_SETTLE_MS = 3000        # 클릭 후 XHR 이 DOM 을 갈아끼울 시간


async def _collect(base: str, *, limit: int) -> tuple[list[str], str]:
    """directory 를 열고 **페이지네이션을 클릭해 가며** space key 를 모은다.

    ★ URL 로는 안 넘어간다. `?startIndex=N` 을 직접 열어도 서버가 무시하고 첫 페이지를
      준다(실측: startIndex=24/48/360 전부 같은 결과). 목록은 클릭 시 XHR 로 DOM 에
      갈아끼워진다 — 그래서 **클릭**해야 한다.

    ⚠️ 링크에 보인 최대 `startIndex` 는 648 이었다(≈672 space). 첫 페이지만 읽으면
      큐가 26개에서 멈춘 채 "그게 전부" 로 보인다.
    """
    from domains.services.confluence.plugin.tools.confluence_browser_search_tool import (
        _ensure_session_logged_in,
    )

    page, err = await _ensure_session_logged_in(base)
    if err is not None:
        raise RuntimeError(f"confluence SSO 세션 실패: {getattr(err, 'message', err)}")

    host = (urlparse(base).hostname or "").lower()
    for path in _DIRECTORY_PATHS:
        try:
            await page.goto(f"{base}{path}", wait_until="networkidle", timeout=45000)
        except Exception:  # noqa: BLE001 — 다음 경로를 시도한다
            log.warning("[spaces] 이동 실패: %s%s", base, path)
            continue
        # 로그인벽/리다이렉트가 다른 origin 에 안착했으면 그 페이지를 읽지 않는다.
        try:
            if host and (urlparse(page.url).hostname or "").lower() != host:
                log.warning("[spaces] off-origin 리다이렉트: %s", page.url)
                continue
        except Exception:  # noqa: BLE001
            continue

        seen: dict[str, None] = {}
        for pageno in range(_MAX_PAGES):
            try:
                html = await page.content()
            except Exception:  # noqa: BLE001
                break
            before = len(seen)
            for key in _space_keys_from_html(html):
                seen.setdefault(key, None)
            log.info("[spaces] page %d — 누적 %d개 (+%d)", pageno, len(seen), len(seen) - before)
            if len(seen) >= limit:
                break
            nxt = f'a[href*="startIndex={(pageno + 1) * _PAGE_SIZE}"]'
            try:
                if await page.eval_on_selector_all(nxt, "els => els.length") == 0:
                    break          # 마지막 페이지 — 정상 종료
                await page.click(nxt)
                await page.wait_for_timeout(_SETTLE_MS)
            except Exception:  # noqa: BLE001 — 더 못 넘기면 여기까지가 우리가 본 전부다
                log.warning("[spaces] page %d 이후 페이지네이션 실패 — 여기까지만 센다", pageno)
                break
        if seen:
            return list(seen)[: max(1, min(limit, _MAX_SPACES))], path
    return [], ""


def browser_list_spaces(*, limit: int = 200) -> dict[str, Any]:
    """space 목록을 브라우저로 연다.

    반환: `{"ok": bool, "spaces": [BrowserSpace], "source": <경로>, "detail": <사유>}`

    ★ `ok=False` 와 빈 목록을 **구분해서** 돌려준다. 0건을 성공으로 기록하면
      discovery 가 조용히 아무것도 안 하는 상태가 된다.
    """
    import asyncio

    base = (os.environ.get("CONFLUENCE_BASE_URL") or "").rstrip("/")
    if not base:
        return {"ok": False, "spaces": [], "source": "",
                "detail": "CONFLUENCE_BASE_URL 미설정"}
    try:
        keys, source = asyncio.run(_collect(base, limit=limit))
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "spaces": [], "source": "", "detail": repr(e)[:400]}
    if not keys:
        return {
            "ok": False, "spaces": [], "source": "",
            "detail": ("space directory 에서 링크를 하나도 못 찾았다 — "
                       "'space 가 없다' 가 아니라 '못 읽었다' 다. "
                       f"시도한 경로: {list(_DIRECTORY_PATHS)}"),
        }
    return {
        "ok": True,
        "spaces": [BrowserSpace(key=k, url=f"{base}/display/{k}") for k in keys],
        "source": source,
        "detail": "",
    }
