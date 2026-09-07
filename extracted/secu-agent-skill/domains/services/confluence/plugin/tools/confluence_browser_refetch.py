"""재검증 재조회 — 브라우저 전용 (2026-08-26).

## 왜

`reporter._fetch_recheck_text` 는 `cf.fetch_page_body`/`list_comments`/
`fetch_page_body_version`/`list_attachments`/`fetch_attachment_text` 로 REST 를 쳤다.
그 엔드포인트들은 죽어 있다(실측 2026-08-26, `/rest/api/content`):

    Basic (user+token)  403  "Basic Authentication has been disabled on this instance."
    Bearer PAT          429  "속도 제한이 초과되었습니다."

그래서 `confluence.recheck` 는 켜는 순간 전량 실패한다. 지금 꺼져 있는 이유다.

## 무엇을 덮고 무엇을 못 덮나

    page          ✅  /pages/viewpage.action?pageId=<id> 본문
    comment       ✅  댓글은 page 본문에 함께 렌더된다 — 같은 텍스트로 덮인다
    page_version  ✅  ?pageVersion=<N> 로 특정 버전 본문
    attachment    ❌  첨부 본문 추출은 브라우저로 못 한다(office/pdf 바이너리)

★ **못 하는 것은 못 한다고 답한다.** 첨부는 `unknown` 사유를 돌려주고, 호출측 계약이
그걸 `recheck_requested` 로 남긴다(결과메일 없음 + `retry_after` 8시간). "확인 못 함"
을 "조치됨" 으로 접으면 유출이 열린 채 스레드만 닫힌다 — 조용히 틀리는 쪽이다.

## 계약

`_fetch_recheck_text` 와 **반환형이 같다**: `(text_payloads, fetch_error)`.
`text_payloads` 는 `[{"label": str, "text": str}]`. 그래야 판정 로직
(`_original_hit_signatures` 대조)을 그대로 쓴다 — 재검증의 판정 기준을 건드리지 않는다.
"""
from __future__ import annotations

import logging
import os
from typing import Any
from urllib.parse import urlparse

log = logging.getLogger("confluence.browser_refetch")

_NAV_TIMEOUT_MS = 45000
# 첨부는 브라우저로 본문을 못 뽑는다. 사유를 **한 곳**에 둔다 — 호출측·테스트가 같이 본다.
ATTACHMENT_UNSUPPORTED = (
    "attachment refetch unsupported in browser mode "
    "(REST is 403/429 on this instance) — not assessed, not remediated"
)


async def _page_text(page: Any, url: str, *, host: str | None) -> str | None:
    for wait in ("networkidle", "domcontentloaded"):
        try:
            await page.goto(url, wait_until=wait, timeout=_NAV_TIMEOUT_MS)
            break
        except Exception:  # noqa: BLE001
            continue
    else:
        return None
    # 로그인벽/리다이렉트가 다른 origin 에 안착했으면 읽지 않는다(off-origin 유출 차단).
    try:
        if host and (urlparse(page.url).hostname or "").lower() != host:
            return None
    except Exception:  # noqa: BLE001
        return None
    try:
        return await page.inner_text("body")
    except Exception:  # noqa: BLE001
        return None


async def _collect(base: str, page_id: str, *, version: int | None) -> str | None:
    from domains.services.confluence.plugin.tools.confluence_browser_search_tool import (
        _ensure_session_logged_in,
    )

    page, err = await _ensure_session_logged_in(base)
    if err is not None:
        raise RuntimeError(f"confluence SSO 세션 실패: {getattr(err, 'message', err)}")
    host = (urlparse(base).hostname or "").lower()
    url = f"{base}/pages/viewpage.action?pageId={page_id}"
    if version is not None:
        url = f"{url}&pageVersion={int(version)}"
    return await _page_text(page, url, host=host)


def browser_fetch_recheck_text(
    *, page_id: str, kind: str, version: int | None = None, label_hint: str = "",
) -> tuple[list[dict[str, Any]], str | None]:
    """재검증용 본문을 브라우저로 가져온다. 반환형은 `_fetch_recheck_text` 와 같다."""
    import asyncio

    if kind == "attachment":
        # ★ 못 하는 것을 못 한다고 말한다. 호출측이 unknown → recheck_requested 로 남긴다.
        return [], ATTACHMENT_UNSUPPORTED

    base = (os.environ.get("CONFLUENCE_BASE_URL") or "").rstrip("/")
    if not base:
        return [], "CONFLUENCE_BASE_URL 미설정"
    pid = str(page_id or "").strip()
    if not pid:
        return [], "page id 없음"

    try:
        text = asyncio.run(_collect(base, pid, version=version))
    except Exception as e:  # noqa: BLE001
        return [], f"browser refetch failed: {repr(e)[:300]}"
    if text is None:
        return [], "page body not readable in browser (login wall or off-origin redirect)"

    if version is not None:
        label = f"{pid}/version/{version}"
    elif kind == "comment":
        # ⚠️ 댓글을 개별 인덱스로 못 가른다 — page 본문에 함께 렌더되기 때문이다.
        #    라벨에 그 사실을 남긴다. 판정(서명 대조)에는 영향이 없다: 원래 값이
        #    이 텍스트 안에 있으면 still_open, 없으면 사라진 것이다.
        label = f"{pid}/page+comments"
    else:
        label = label_hint or f"{pid}/page"
    return [{"label": label, "text": text}], None
