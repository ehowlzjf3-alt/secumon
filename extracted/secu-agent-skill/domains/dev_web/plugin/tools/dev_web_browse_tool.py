"""dev_web 브라우저 열람 tool — 무인 워커용 non-destructive 래퍼 (confluence_browser_search 미러).

배경: web_site_sweep(정적 HTTP)로는 SPA/JS 렌더·XHR·인증화면을 못 본다. dev_web 워커 계약은 sweep 후
**실제 브라우저 deep-dive**(dev_web_submit_finding 게이트 + _has_post_sweep_browser_deep_dive)를 요구하지만,
raw `browser_session`/`browser_action` 은 is_destructive → 무인 워커(runtime.run_agent, approval_resolver
없음)에서 승인거부(error:permission)된다. confluence_browser_search 와 **동일 패턴**으로 코어 private
프리미티브(`_start_session`/`_require_page`/`_mark_web_host_visited`)를 non-destructive tool 안에서만 직접
호출해 read-only navigate+snapshot 만 수행한다(코어 무수정 — 사용만, 버전 드리프트 시 이 함수가 먼저 깨짐).

경계·안전:
- **same-origin only**: 입력 url 의 host 가 claim 된 target host(metadata['dev_web_domain'])와 같아야 한다.
  off-host → 차단. 스킴 없는 path 는 target origin 에 붙여 해석(항상 same-origin). goto 후 **최종 URL** 도
  재검증(302/로그인벽 off-origin 안착 시 스캔 금지 — confluence _goto_text 와 동형).
- **read-only**: navigate + snapshot 만. click/login/fill/저장/삭제 없음(그건 여전히 destructive raw 툴).
  자율 SSO 로그인 안 함 — 인증벽이면 스냅샷에 로그인 화면이 잡히고 워커가 'auth-gated'로 판단한다.
- 방문 host 를 코어 `_mark_web_host_visited` 로 기록 → submit_finding(dev_web) 정책 A(브라우저 검증) 충족.
"""
from __future__ import annotations

import json
from typing import Any, ClassVar
from urllib.parse import urlparse

from pydantic import BaseModel, Field

import secu_agent.agent.tools.browser_tool as bt
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess


def _same_host(url: str, host: str | None) -> bool:
    if not host:
        return True
    try:
        return (urlparse(url).hostname or "").lower() == host.lower()
    except ValueError:
        return False


def _target_host(ctx: ToolContext) -> str:
    """claim 된 target 의 host(metadata['dev_web_domain'] 은 hostname 또는 URL)."""
    raw = ""
    try:
        raw = str(ctx.metadata.get("dev_web_domain") or "").strip()
    except Exception:  # noqa: BLE001
        raw = ""
    if not raw:
        return ""
    if "://" in raw:
        return (urlparse(raw).hostname or "").lower()
    return raw.lower()


async def _goto_text(page: Any, url: str, timeout_ms: int, *, require_host: str) -> tuple[str | None, str]:
    """url 로 이동 후 body 텍스트 반환. 실패/off-origin 리다이렉트 시 (None, 최종url).

    goto 는 302/로그인벽으로 다른 origin 에 안착할 수 있어(hostname 사전검증만으론 부족) 이동 후 **최종
    page.url 이 require_host 와 same-origin 인지 재검증**한다(off-origin 유출 차단 — confluence 와 동형).
    """
    for wait in ("networkidle", "domcontentloaded"):
        try:
            await page.goto(url, wait_until=wait, timeout=timeout_ms)
            break
        except Exception:  # noqa: BLE001 — 두 wait 모드 모두 실패 시 아래 else
            continue
    else:
        return None, url
    try:
        final_url = page.url
    except Exception:  # noqa: BLE001
        return None, url
    if not _same_host(final_url, require_host):  # 리다이렉트가 off-origin 에 안착 → 스캔 금지
        return None, final_url
    try:
        return await page.inner_text("body"), final_url
    except Exception:  # noqa: BLE001
        return "", final_url


class DevWebBrowseInput(BaseModel):
    url: str = Field(
        ...,
        description=(
            "열 대상 URL. claim 된 target 과 same-origin 이어야 한다. 스킴 없는 path('/admin')는 "
            "target origin 에 붙여 해석된다. read-only navigate 만 — 클릭/로그인/입력은 하지 않는다."
        ),
    )
    max_chars: int = Field(
        default=12000, ge=500, le=50000,
        description="반환 snapshot(가시 본문 텍스트) 최대 글자수.")
    nav_timeout_ms: int = Field(default=30000, ge=3000, le=90000)


class DevWebBrowseTool(Tool[DevWebBrowseInput]):
    name: ClassVar[str] = "dev_web_browse"
    domain: ClassVar[str] = "dev_web"
    description: ClassVar[str] = (
        "dev_web 대상 URL 을 브라우저로 read-only 로 열고(세션 자동 확보) 렌더된 화면의 가시 본문 "
        "snapshot 을 반환한다. web_site_sweep(정적)이 못 보는 SPA/JS 렌더·인증화면을 실제로 본다. "
        "same-origin 만(off-host/off-origin 리다이렉트 차단). 클릭/로그인/입력 없음(read-only). "
        "sweep 후 이 도구(또는 browser_query)로 실제 화면을 확인해야 dev_web_submit_finding 이 허용된다."
    )
    input_model: ClassVar[type[BaseModel]] = DevWebBrowseInput
    search_hint: ClassVar[str] = "dev_web browser open navigate snapshot render read-only site page"
    # 브라우저 navigation 을 구동하지만 page 변경/쓰기는 없음(read-only). web_site_sweep·
    # confluence_browser_search 와 동일하게 is_destructive 아님 → 무인 워커에서 승인거부되지 않음.
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = True
    prompt_section: ClassVar[str] = (
        "### dev_web_browse(url, max_chars=12000)\n"
        "대상 URL 을 브라우저로 read-only 로 열고 렌더된 가시 본문 snapshot 반환. same-origin only. "
        "raw browser_session/browser_action 대신 이 도구를 쓴다(무인 워커에서 승인거부 안 됨)."
    )

    async def execute(self, vi: DevWebBrowseInput, ctx: ToolContext) -> ToolResult:
        target_host = _target_host(ctx)
        raw_url = (vi.url or "").strip()
        if not raw_url:
            return ToolError(kind="validation", message="url 이 비어 있음")
        # 스킴 없는 path 는 target origin 에 붙여 해석(항상 same-origin).
        if "://" not in raw_url:
            if not target_host:
                return ToolError(
                    kind="validation",
                    message="상대 path 는 target host 를 알 수 없어 해석 불가 — 전체 https URL 로 호출")
            path = raw_url if raw_url.startswith("/") else "/" + raw_url
            url = f"https://{target_host}{path}"
        else:
            url = raw_url
        req_host = (urlparse(url).hostname or "").lower()
        if not req_host:
            return ToolError(kind="validation", message=f"url 에 host 가 없음: {url!r}")
        if target_host and req_host != target_host:
            return ToolError(
                kind="forbidden",
                message=(
                    f"off-scope host {req_host!r} — same-origin only (허용 host: {target_host!r}). "
                    "대상 URL/동일 origin 만 검사한다."
                ),
            )

        # 세션 확보(코어 private 프리미티브 — 격리 지점). 이미 열린 세션은 재사용.
        page, perr = bt._require_page()
        if perr is not None:
            ok, reason = await bt._start_session(
                headless=True, viewport_width=1280, viewport_height=900)
            if not ok:
                return ToolError(kind="execution", message=f"브라우저 세션 시작 실패: {reason}")
            page, perr = bt._require_page()
            if perr is not None:
                return perr

        body, final_url = await _goto_text(page, url, vi.nav_timeout_ms, require_host=req_host)
        if body is None:
            return ToolError(
                kind="execution",
                message=(
                    f"navigate 실패 또는 off-origin 리다이렉트(로그인벽 가능): {url} → {final_url}. "
                    "auth-gated 이면 read-only 자율 로그인은 하지 않는다."
                ),
            )
        # 방문 host 기록 → submit_finding(dev_web) 정책 A(브라우저 검증) 충족.
        bt._mark_web_host_visited(ctx, page)

        payload = {
            "requested_url": url,
            "final_url": final_url,
            "snapshot_chars": len(body),
            "snapshot": body[: vi.max_chars],
            "note": "read-only navigate+snapshot. 클릭/로그인 미수행. 추가 화면은 dev_web_browse(다른 same-origin path) 또는 browser_query(screenshot).",
        }
        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))
