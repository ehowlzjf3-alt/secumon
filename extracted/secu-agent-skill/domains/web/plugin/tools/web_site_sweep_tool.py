"""web_site_sweep — 사이트 1개의 필수 점검 패스를 결정론적으로 코드가 수행.

v3.54: operator(gpt-oss-120b) 가 SKILL 서술형 절차를 안 지켜 사이트마다 커버리지가
들쭉날쭉(누락) → "정해진 동작"을 프롬프트에서 코드로 이전.

- L1: navigate → root snapshot → 로그인벽 감지·로그인 시도 → 재snapshot → scan_text
       → 표준 endpoint probe. (사이트 무관 동일)
- L2: 렌더 DOM 링크 + JS fetch/axios URL 에서 same-origin 라우트 발견 → cap 내 각 페이지
       navigate+snapshot+scan. cap 초과분은 coverage.not_inspected 로 **명시 기록**.

이 도구는 finding/status 를 적재하지 않는다 — 모델이 디지스트를 보고 submit_finding /
web_target_set_status 를 호출(L3, 메인 루프). 커버리지=코드 결정론, 판단=LLM.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, ClassVar
from urllib.parse import urljoin, urlparse
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator

from secu_agent.agent.tools import browser_tool as bt
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)
from secu_agent.agent.tools.scan_text import _record_web_content_inspected
from secu_agent.detectors.text_scan import scan_text as _scan_text

from domains.web.plugin.tools import web_tools as wt

_CONTENT_SCAN_CAP = 256 * 1024
_SWEEP_TEXT_CAP = 20000  # 페이지당 snapshot 텍스트 cap (기본 6000 → 상향, 긴 페이지 누락 방지)
_SCROLL_STEPS = 4        # navigate 후 lazy-load 트리거용 스크롤 횟수
_SSO_ACTION_MARKERS = (
    "sso login", "sso 로그인", "sign in with sso", "login with sso",
    "통합인증으로 로그인", "통합 인증 로그인", "통합계정 로그인", "knox sso login",
)
_ACCESS_DENIED_MARKERS = (
    "access denied", "permission denied", "not authorized", "not authorised",
    "권한 없음", "권한이 없습니다", "접근 권한이 없습니다", "접근이 거부",
    "인가되지",
)
_AUTH_REQUIRED_MARKERS = (
    "unauthorized", "authentication required", "authorization required",
    "please sign in", "please login", "session expired", "login required",
    "로그인이 필요", "인증이 필요", "세션이 만료", "로그인 후 이용",
)
_IDP_ADFS_HOST_RE = re.compile(r"(^|[.-])adfs([.-]|$)")
_IDP_SAML_PATH_RE = re.compile(
    r"(^|/)(?:saml2?|sso)/(?:sso|login|signin|authorize|auth|authn|acs)(?:/|$)"
    r"|(^|/)(?:sso|login|signin)/(?:saml2?)(?:/|$)"
)
_WEAK_AUTH_REFERENCE_RE = re.compile(
    r"(?<![a-z0-9])(?:login|log\s+in|sign\s+in|sso|saml2?|oauth2?|oidc|"
    r"openid\s+connect|single\s+sign[-\s]on)(?![a-z0-9])"
    r"|로그인|통합\s*인증|통합계정",
    re.IGNORECASE,
)
_LOGIN_TITLE_MARKERS = ("login", "log in", "sign in", "로그인")
_DEFAULT_PORTS = {"http": 80, "https": 443}
_PROTECTED_HTTP_STATUSES = {401, 403, 407}


def _host_of(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        return (urlparse(raw if "://" in raw else f"//{raw}").hostname or "").lower()
    except Exception:
        return ""


def _origin_of(value: str) -> tuple[str, str, int | None]:
    raw = str(value or "").strip()
    if not raw:
        return "", "", None
    try:
        parsed = urlparse(raw if "://" in raw else f"https://{raw}")
        scheme = (parsed.scheme or "").lower()
        host = (parsed.hostname or "").lower()
        port = parsed.port if parsed.port is not None else _DEFAULT_PORTS.get(scheme)
        return scheme, host, port
    except Exception:
        return "", "", None


def _hits_to_dicts(hits: list) -> list[dict]:
    out = []
    for h in hits:
        out.append({
            "category": h.category, "kind": h.kind, "masked": h.masked,
            "line_no": h.line_no, "line_preview": h.line_preview,
        })
    return out


def _has_password_field(snap: dict) -> bool:
    for el in snap.get("elements") or []:
        if isinstance(el, dict) and str(el.get("input_type") or "").lower() == "password":
            return True
    return False


def _contains_any(text: str, markers: tuple[str, ...]) -> bool:
    haystack = str(text or "").lower()
    return any(marker in haystack for marker in markers)


def _squash_text(value: str) -> str:
    return " ".join(str(value or "").lower().split())


def _snap_text_for_auth(snap: dict, *, include_hrefs: bool = False) -> str:
    pieces = [str(snap.get("title") or ""), str(snap.get("text") or "")]
    for el in snap.get("elements") or []:
        if not isinstance(el, dict):
            continue
        pieces.append(str(el.get("label") or ""))
        pieces.append(str(el.get("role") or ""))
        if include_hrefs:
            pieces.append(str(el.get("href") or ""))
    return "\n".join(pieces)


def _visible_page_text_for_auth(snap: dict) -> str:
    return "\n".join([str(snap.get("title") or ""), str(snap.get("text") or "")])


def _path_is_or_under(path: str, endpoint: str) -> bool:
    normalized = str(path or "/").rstrip("/") or "/"
    target = str(endpoint or "/").rstrip("/") or "/"
    return normalized == target or normalized.startswith(f"{target}/")


def _is_idp_url(url: str) -> bool:
    raw = str(url or "").strip()
    if not raw:
        return False
    try:
        parsed = urlparse(raw if "://" in raw else f"https://{raw}")
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    path = "/" + str(parsed.path or "").lstrip("/")
    path = path.lower()
    query = str(parsed.query or "").lower()

    if "secsso" in host or bool(_IDP_ADFS_HOST_RE.search(host)):
        return True
    if any(_path_is_or_under(path, p) for p in ("/oauth2/authorize", "/oauth/authorize")):
        return True
    if any(_path_is_or_under(path, p) for p in ("/idp", "/adfs")):
        return True
    if _IDP_SAML_PATH_RE.search(path):
        return True
    return "samlrequest=" in query or "wa=wsignin" in query


def _is_expected_host(url: str, expected_host: str | None) -> bool:
    if not expected_host:
        return True
    host = _host_of(url)
    return bool(host and host == expected_host.lower())


def _is_expected_origin(
    url: str,
    *,
    expected_origin: str | None = None,
    expected_host: str | None = None,
) -> bool:
    if expected_origin:
        origin = _origin_of(url)
        expected = _origin_of(expected_origin)
        if origin[0] and origin[1] and expected[0] and expected[1]:
            return origin == expected
        return False
    return _is_expected_host(url, expected_host)


def _same_page_url(left: str, right: str) -> bool:
    try:
        a = urlparse(left if "://" in left else f"https://{left}")
        b = urlparse(right if "://" in right else f"https://{right}")
    except Exception:
        return False
    if not a.hostname or not b.hostname:
        return False
    a_port = a.port if a.port is not None else _DEFAULT_PORTS.get((a.scheme or "").lower())
    b_port = b.port if b.port is not None else _DEFAULT_PORTS.get((b.scheme or "").lower())
    return (
        (a.scheme or "").lower() == (b.scheme or "").lower()
        and (a.hostname or "").lower() == (b.hostname or "").lower()
        and a_port == b_port
        and (a.path or "/").rstrip("/") == (b.path or "/").rstrip("/")
        and (a.query or "") == (b.query or "")
    )


def _has_sso_control(snap: dict) -> bool:
    for el in snap.get("elements") or []:
        if not isinstance(el, dict):
            continue
        label = _squash_text(str(el.get("label") or ""))
        role = _squash_text(str(el.get("role") or ""))
        if not label:
            continue
        if _contains_any(label, _SSO_ACTION_MARKERS):
            return True
        has_sso = "sso" in label or "통합인증" in label or "통합 인증" in label
        has_login_action = (
            "login" in label or "log in" in label or "sign in" in label
            or "로그인" in label
        )
        is_control = str(el.get("tag") or "").lower() in {"button", "a", "input"} or role in {
            "button", "link", "menuitem",
        }
        if is_control and has_sso and has_login_action:
            return True
    return False


def _has_strong_sso_text(snap: dict) -> bool:
    text = _snap_text_for_auth(snap, include_hrefs=False)
    return _contains_any(text, _SSO_ACTION_MARKERS) or _has_sso_control(snap)


def _is_login_title(title: str) -> bool:
    cleaned = _squash_text(title).strip(" -_|:/")
    if cleaned in _LOGIN_TITLE_MARKERS:
        return True
    return any(
        cleaned.startswith(f"{marker} ")
        or cleaned.endswith(f" {marker}")
        or f" - {marker}" in cleaned
        or f"{marker} -" in cleaned
        for marker in _LOGIN_TITLE_MARKERS
    )


def _has_access_denied_signal(snap: dict) -> bool:
    title = _squash_text(str(snap.get("title") or ""))
    text = _snap_text_for_auth(snap, include_hrefs=False)
    if "403" in title or "forbidden" in title:
        return True
    return _contains_any(text, _ACCESS_DENIED_MARKERS)


def _has_auth_required_signal(snap: dict) -> bool:
    title = str(snap.get("title") or "")
    text = _snap_text_for_auth(snap, include_hrefs=False)
    return _contains_any(text, _AUTH_REQUIRED_MARKERS) or _is_login_title(title)


def _has_weak_auth_reference(snap: dict) -> bool:
    return bool(_WEAK_AUTH_REFERENCE_RE.search(_visible_page_text_for_auth(snap)))


def _has_rendered_content_evidence(snap: dict) -> bool:
    if snap.get("error"):
        return False
    title = _squash_text(str(snap.get("title") or ""))
    text = _squash_text(str(snap.get("text") or ""))
    if len(text) >= 2:
        return True
    return len(title) >= 2


def _is_success_status(http_status: int | None) -> bool:
    return http_status is not None and 200 <= int(http_status) < 300


def _classify_auth_state(
    snap: dict,
    *,
    http_status: int | None = None,
    expected_host: str | None = None,
    expected_origin: str | None = None,
    trusted_login_success: bool = False,
) -> dict:
    """Fail-closed auth-state classifier for rendered pages."""
    url = str(snap.get("url") or "")
    signals: list[str] = []
    state = "unknown"

    if _is_idp_url(url):
        state = "sso"
        signals.append("idp_redirect")
    elif (
        url
        and (expected_origin or expected_host)
        and not _is_expected_origin(
            url, expected_origin=expected_origin, expected_host=expected_host,
        )
    ):
        state = "off_origin"
        signals.append("off_origin_final_url")
    elif http_status == 401:
        state = "auth_required"
        signals.append("http_status_401")
    elif http_status == 407:
        state = "auth_required"
        signals.append("http_status_407")
    elif http_status == 403:
        state = "access_denied"
        signals.append("http_status_403")
    elif http_status is not None and not _is_success_status(http_status):
        signals.append(f"http_status_{http_status}")
    elif _has_password_field(snap):
        state = "login_form"
        signals.append("password_field")
    elif _has_access_denied_signal(snap):
        state = "access_denied"
        signals.append("access_denied_marker")
    elif _has_strong_sso_text(snap):
        state = "sso"
        signals.append("sso_control")
    elif _has_auth_required_signal(snap):
        state = "auth_required"
        signals.append("auth_required_marker")
    elif _has_weak_auth_reference(snap):
        signals.append("weak_auth_marker")
    elif _is_success_status(http_status) and _has_rendered_content_evidence(snap):
        state = "open"
        signals.append("same_origin_success_content")
    elif trusted_login_success and _has_rendered_content_evidence(snap):
        state = "open"
        signals.append("trusted_post_login_content")
    elif http_status is None:
        signals.append("missing_http_status")
    else:
        signals.append("insufficient_open_evidence")

    return {
        "state": state,
        "kind": "none" if state == "open" else state,
        "wall_detected": state != "open",
        "is_authed_view": state == "open",
        "login_candidate": state in {"access_denied", "auth_required", "login_form", "sso"},
        "reason": ",".join(signals),
    }


def _detect_auth_wall(snap: dict) -> tuple[bool, str]:
    """(wall_detected, kind). kind: sso|login_form|access_denied|auth_required|off_origin|none."""
    auth_state = _classify_auth_state(snap)
    return bool(auth_state["wall_detected"]), str(auth_state["kind"])


async def _safe_navigate(page: Any, url: str, timeout_ms: int) -> tuple[bool, int | None, str]:
    """navigate. 실패해도 예외 안 던지고 (ok, status, reason)."""
    try:
        bt._validate_browser_url_safe(url)
    except Exception as e:  # noqa: BLE001
        return False, None, f"url blocked: {e}"
    try:
        resp = await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        status = getattr(resp, "status", None) if resp is not None else None
        return True, status, ""
    except Exception as e:  # noqa: BLE001
        return False, None, f"navigate failed: {type(e).__name__}: {str(e)[:120]}"


async def _scroll_and_settle(page: Any) -> None:
    """navigate 후 페이지를 끝까지 스크롤(lazy-load/무한스크롤 트리거) + networkidle 대기.

    SPA 가 동적으로 채우는 콘텐츠를 snapshot 전에 실제로 렌더시키기 위함 (껍데기만 보던 문제)."""
    try:
        await page.wait_for_load_state("networkidle", timeout=4000)
    except Exception:  # noqa: BLE001
        pass
    for _ in range(_SCROLL_STEPS):
        try:
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:  # noqa: BLE001
            break
        await asyncio.sleep(0.4)
    try:
        await page.evaluate("window.scrollTo(0, 0)")
    except Exception:  # noqa: BLE001
        pass


async def _snapshot_with_retry(page: Any, selector: str | None = None,
                               max_text: int = _SWEEP_TEXT_CAP) -> dict:
    """_snapshot_data + 'Execution context was destroyed' (redirect 경쟁) 재시도."""
    for attempt in range(3):
        try:
            return await bt._snapshot_data(page, selector, max_text=max_text)
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if "Execution context was destroyed" in msg or "navigating" in msg.lower():
                try:
                    await page.wait_for_load_state("domcontentloaded", timeout=3000)
                except Exception:  # noqa: BLE001
                    await asyncio.sleep(0.5 * (attempt + 1))
                continue
            return {"url": getattr(page, "url", ""), "title": "", "text": "",
                    "elements": [], "error": f"snapshot failed: {type(e).__name__}"}
    return {"url": getattr(page, "url", ""), "title": "", "text": "",
            "elements": [], "error": "snapshot failed after retries"}


async def _page_routes(page: Any, root_url: str, snap: dict) -> list[str]:
    """렌더 DOM 링크 + JS fetch/axios URL 에서 same-origin 라우트 후보 수집."""
    candidates: list[str] = []
    for el in snap.get("elements") or []:
        if isinstance(el, dict) and el.get("href"):
            candidates.append(urljoin(root_url, str(el["href"]).strip()))
    try:
        html = await page.content()
    except Exception:  # noqa: BLE001
        html = ""
    if html:
        body = html[:_CONTENT_SCAN_CAP]
        for m in wt._WEB_ATTR_RE.finditer(body):
            candidates.append(urljoin(root_url, m.group(1).strip()))
        for m in wt._WEB_JS_URL_RE.finditer(body):
            candidates.append(urljoin(root_url, m.group(1).strip()))
    host = _host_of(root_url)
    # 넉넉히(라우트 인벤토리 보존용) — 실제 방문은 cap 으로 별도 제한.
    return wt._same_origin_urls(host, candidates, limit=500)


class WebSiteSweepInput(BaseModel):
    target_id: int | None = Field(None, description="web_target_domain.id")
    domain: str | None = Field(None, description="호스트 (target_id 없을 때)")
    max_route_pages: int = Field(8, ge=1, le=25)
    max_probe_urls: int = Field(30, ge=1, le=60)
    max_api_samples: int = Field(8, ge=0, le=20)
    max_dynamic_responses: int = Field(12, ge=0, le=50)
    attempt_login: bool = True
    nav_timeout_ms: int = Field(15000, ge=3000, le=30000)

    @model_validator(mode="after")
    def _need_target(self) -> "WebSiteSweepInput":
        if self.target_id is None and not (self.domain or "").strip():
            raise ValueError("target_id 또는 domain 중 하나 필수")
        return self


class WebSiteSweepTool(Tool[WebSiteSweepInput]):
    name: ClassVar[str] = "web_site_sweep"
    domain: ClassVar[str] = "web"
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = True
    description: ClassVar[str] = (
        "사이트 1개의 필수 점검 패스를 결정론적으로 수행: navigate → (로그인벽이면) 로그인 "
        "→ root + 발견 라우트 snapshot → scan_text(secret/PII) → 표준 endpoint probe. "
        "구조화 디지스트 반환(pages/scan_hits/probes/route_inventory/coverage). "
        "**finding/status 는 적재하지 않는다** — 디지스트를 보고 submit_finding / "
        "web_target_set_status 는 직접 호출하라. coverage.not_inspected 로 미점검 라우트 명시."
    )
    input_model: ClassVar[type[BaseModel]] = WebSiteSweepInput
    search_hint: ClassVar[str] = "web site sweep per-site mandatory baseline navigate snapshot scan probe"
    prompt_section: ClassVar[str] = (
        "### web_site_sweep(target_id 또는 domain)\n"
        "사이트 1개 필수 패스를 코드가 결정론적으로 수행(navigate·로그인·snapshot·scan·"
        "표준probe) 후 디지스트 반환. 사이트당 이거 1회 호출 → 디지스트의 scan_hits/probes/"
        "coverage 보고 deepdive(SPA 라우트·API) 판단 → 실제 위협마다 submit_finding → "
        "web_target_set_status. finding 은 이 도구가 적재 안 함."
    )

    async def execute(self, vi: WebSiteSweepInput, ctx: ToolContext) -> ToolResult:
        from service import state_domain as state

        # 1) 대상 해석
        domain = (vi.domain or "").strip()
        if vi.target_id is not None:
            row = state.web_target_get(vi.target_id)
            if not row:
                return ToolError(kind="validation",
                                 message=f"target_id={vi.target_id} 없음")
            row_domain = str(row.get("domain") or "")
            if domain and _host_of(domain) != _host_of(row_domain):
                return ToolError(
                    kind="validation",
                    message=(f"target_id={vi.target_id}({row_domain}) 와 domain={domain} "
                             "불일치 — 한 번에 한 사이트만."),
                )
            domain = row_domain
        host = _host_of(domain)
        if not host:
            return ToolError(kind="validation", message=f"도메인 파싱 실패: {domain!r}")
        root_url = f"https://{host}"

        async with bt._BROWSER_LOCK:
            bt._remember_evidence_dir(ctx)
            if not bt._is_running():
                ok, reason = await bt._start_session(
                    headless=True, viewport_width=1280, viewport_height=800,
                )
                if not ok:
                    return ToolError(kind="io_error",
                                     message=f"browser 세션 시작 실패: {reason}")
            page, perr = bt._require_page()
            if perr is not None:
                return perr
            return await self._sweep(vi, ctx, state, page, host, root_url)

    async def _sweep(self, vi, ctx, state, page, host, root_url) -> ToolResult:
        started = time.monotonic()
        budget_s = max(20.0, (vi.max_route_pages + 1) * (vi.nav_timeout_ms / 1000.0) * 1.5)
        pages_out: list[dict] = []
        dynamic_start_seq = bt._dynamic_response_current_seq()
        notes: list[str] = [
            "SPA 라우트는 렌더 DOM + JS 리터럴에서 발견가능한 것만 — 런타임 생성/번들 내부 "
            "라우트는 미열거. not_inspected 는 명시 기록(은폐 아님).",
        ]

        # ---- L1: root navigate + snapshot ----
        nav_ok, status, nav_msg = await _safe_navigate(page, root_url, vi.nav_timeout_ms)
        bt._mark_web_host_visited(ctx, page)
        if not nav_ok:
            return ToolSuccess(content=json.dumps({
                "kind": "web_site_sweep", "domain": host, "root_url": root_url,
                "auth": {"wall_detected": False, "kind": "none", "auth_state": "unreachable",
                         "auth_reason": nav_msg, "login_attempted": False,
                         "login_ok": False, "circuit_broken": False},
                "pages": [], "probes": [], "route_inventory": {"discovered_total": 0,
                "dom_links": [], "js_api_urls": []},
                "coverage": {"pages_inspected": 0, "routes_discovered": 0,
                "not_inspected_count": 0, "not_inspected": [], "cap_reached": False,
                "notes": [nav_msg]},
                "scan_hit_summary": {"total": 0},
                "reachable": False,
                "reporting_contract": "접속 불가 — web_target_set_status(..., 'skipped', "
                                      f"reason='{nav_msg}').",
            }, ensure_ascii=False))

        await _scroll_and_settle(page)
        snap = await _snapshot_with_retry(page)
        root_auth = _classify_auth_state(
            snap, http_status=status, expected_host=host, expected_origin=root_url,
        )
        wall, wall_kind = bool(root_auth["wall_detected"]), str(root_auth["kind"])
        root_auth_status = status
        trusted_post_login_content = False
        auth = {"wall_detected": wall, "kind": wall_kind,
                "auth_state": str(root_auth["state"]),
                "auth_reason": str(root_auth["reason"]), "login_attempted": False,
                "login_ok": False, "login_message": "", "circuit_broken": False}

        # ---- L1: 로그인 시도 (벽 있고 attempt_login) ----
        if wall and vi.attempt_login and bool(root_auth.get("login_candidate")):
            pre_login_url = str(snap.get("url") or getattr(page, "url", "") or root_url)
            auth["login_attempted"] = True
            ok, msg, fatal = await bt._perform_login(page, "auto")
            auth["login_ok"] = bool(ok)
            auth["login_message"] = msg
            auth["circuit_broken"] = bool(
                bt._SESSION_STATE.get("login_halted")
            ) if hasattr(bt, "_SESSION_STATE") else False
            bt._mark_web_host_visited(ctx, page)
            if ok:
                await _scroll_and_settle(page)
                snap = await _snapshot_with_retry(page)  # 인증 후 재snapshot
                post_login_url = str(snap.get("url") or getattr(page, "url", "") or "")
                same_page = _same_page_url(pre_login_url, post_login_url)
                root_auth_status = status if same_page else None
                same_page_protected_status = same_page and status in _PROTECTED_HTTP_STATUSES
                post_auth = _classify_auth_state(
                    snap, http_status=root_auth_status, expected_host=host,
                    expected_origin=root_url,
                    trusted_login_success=bool(ok and not same_page_protected_status),
                )
                post_host_ok = _is_expected_host(str(snap.get("url") or ""), host)
                post_origin_ok = _is_expected_origin(
                    str(snap.get("url") or ""),
                    expected_origin=root_url,
                    expected_host=host,
                )
                auth["post_login_auth_state"] = str(post_auth["state"])
                auth["post_login_reason"] = str(post_auth["reason"])
                auth["post_login_host_ok"] = post_host_ok
                auth["post_login_origin_ok"] = post_origin_ok
                auth["post_login_same_page"] = same_page
                auth["login_ok"] = bool(
                    post_origin_ok and post_auth["state"] == "open"
                )
                trusted_post_login_content = bool(auth["login_ok"])

        # root scan_text
        root_text = str(snap.get("text") or "")
        root_hits = _scan_text(root_text, label=root_url).hits
        _record_web_content_inspected(ctx, root_url)
        page_auth = _classify_auth_state(
            snap, http_status=root_auth_status,
            expected_host=host, expected_origin=root_url,
            trusted_login_success=trusted_post_login_content,
        )
        pages_out.append({
            "url": str(snap.get("url") or root_url), "title": str(snap.get("title") or ""),
            "http_status": status, "auth_state": str(page_auth["state"]),
            "auth_reason": str(page_auth["reason"]),
            "is_authed_view": bool(page_auth["is_authed_view"]),
            "scan_hits": _hits_to_dicts(root_hits),
            "snapshot_chars": len(root_text),
            "snapshot_text": root_text,  # evidence 용 — inline 출력 시 제거
        })

        # ---- L1: 표준 endpoint probe ----
        probe_urls = wt._candidate_web_probe_urls(
            seed=root_url, pages=[], findings=[], limit=vi.max_probe_urls,
        )
        try:
            probes = await asyncio.to_thread(
                wt._probe_web_resources, probe_urls, compare_to_root=True,
                max_bytes=_CONTENT_SCAN_CAP,
            )
        except Exception as e:  # noqa: BLE001
            probes = []
            notes.append(f"probe 실패: {type(e).__name__}")
        _record_web_content_inspected(ctx, root_url)

        # ---- L2: 라우트 발견 + cap 내 방문 ----
        routes = await _page_routes(page, root_url, snap)
        root_norm = root_url.rstrip("/")
        routes = [r for r in routes if r.rstrip("/") != root_norm]
        dom_links = [r for r in routes if "/api" not in r.lower()]
        js_api = [r for r in routes if "/api" in r.lower()]
        to_visit = routes[: vi.max_route_pages]
        not_inspected = routes[vi.max_route_pages:]

        # ---- 코드 deepdive: 노출 API GET 샘플링 ----
        # 가치 있는 deepdive = "API 가 실제 데이터를 인증 없이 흘리나" 를 직접 GET 으로 확인.
        # 모델 판단(프롬프트)에 맡기면 안 함 → 코드가 결정론적으로 샘플. js 에서 발견한 API
        # URL + 표준 probe 에서 confirmed 된 api-doc/openapi 류를 모아 bounded GET + 분류.
        api_samples: list[dict] = []
        if vi.max_api_samples > 0:
            api_candidates = list(js_api)
            for pr in probes:
                st = str(pr.get("semantic_type") or "").lower()
                if pr.get("semantic_status") == "confirmed" and (
                    "api" in st or "openapi" in st or "swagger" in st or "doc" in st
                ):
                    api_candidates.append(str(pr.get("url") or ""))
            api_candidates = wt._same_origin_urls(
                host, [u for u in api_candidates if u], limit=vi.max_api_samples,
            )
            if api_candidates:
                try:
                    api_samples = await asyncio.to_thread(
                        wt._probe_web_resources, api_candidates,
                        compare_to_root=True, max_bytes=_CONTENT_SCAN_CAP,
                    )
                except Exception as e:  # noqa: BLE001
                    notes.append(f"api 샘플링 실패: {type(e).__name__}")
                else:
                    _record_web_content_inspected(ctx, root_url)

        for route in to_visit:
            if ctx.aborted:
                notes.append("취소(ctx.aborted) — 잔여 라우트 미점검")
                not_inspected = routes[routes.index(route):]
                break
            if time.monotonic() - started > budget_s:
                idx = routes.index(route)
                not_inspected = routes[idx:]
                notes.append(f"벽시계 예산({budget_s:.0f}s) 초과 — 잔여 {len(not_inspected)} 미점검")
                break
            r_ok, r_status, r_msg = await _safe_navigate(page, route, vi.nav_timeout_ms)
            if not r_ok:
                pages_out.append({"url": route, "title": "", "http_status": None,
                                  "is_authed_view": False, "scan_hits": [],
                                  "snapshot_chars": 0, "error": r_msg})
                continue
            bt._mark_web_host_visited(ctx, page)
            await _scroll_and_settle(page)
            rsnap = await _snapshot_with_retry(page)
            rtext = str(rsnap.get("text") or "")
            rhits = _scan_text(rtext, label=route).hits
            _record_web_content_inspected(ctx, route)
            route_auth = _classify_auth_state(
                rsnap, http_status=r_status,
                expected_host=host, expected_origin=root_url,
            )
            pages_out.append({
                "url": str(rsnap.get("url") or route),
                "title": str(rsnap.get("title") or ""),
                "http_status": r_status, "auth_state": str(route_auth["state"]),
                "auth_reason": str(route_auth["reason"]),
                "is_authed_view": bool(route_auth["is_authed_view"]),
                "scan_hits": _hits_to_dicts(rhits),
                "snapshot_chars": len(rtext),
                "snapshot_text": rtext,
            })

        dynamic_all = (
            bt._dynamic_response_events_for_origin(
                root_url, start_seq=dynamic_start_seq, limit=None,
            )
            if vi.max_dynamic_responses > 0 else []
        )
        dynamic_responses = dynamic_all[: vi.max_dynamic_responses]
        for event in dynamic_responses:
            _record_web_content_inspected(ctx, str(event.get("url") or root_url))

        # ---- 집계 ----
        hit_summary: dict[str, int] = {}
        total_hits = 0
        for p in pages_out:
            for h in p["scan_hits"]:
                hit_summary[h["category"]] = hit_summary.get(h["category"], 0) + 1
                total_hits += 1
        for event in dynamic_responses:
            for h in event.get("scan_hits") or []:
                category = str(h.get("category") or "unknown")
                hit_summary[category] = hit_summary.get(category, 0) + 1
                total_hits += 1
        hit_summary["total"] = total_hits

        coverage = {
            "pages_inspected": len([p for p in pages_out if "error" not in p]),
            "routes_discovered": len(routes),
            "not_inspected_count": len(not_inspected),
            "not_inspected": not_inspected[:30],
            "cap_reached": len(routes) > vi.max_route_pages,
            "dynamic_responses_captured": len(dynamic_responses),
            "dynamic_responses_not_included": max(0, len(dynamic_all) - len(dynamic_responses)),
            "notes": notes,
        }

        # ---- evidence offload (전체 snapshot 텍스트 포함) ----
        evidence_ref = self._write_evidence(
            ctx, host=host, root_url=root_url, auth=auth,
            pages_full=pages_out, probes=probes, routes=routes,
            not_inspected=not_inspected, coverage=coverage, api_samples=api_samples,
            dynamic_responses=dynamic_responses,
        )

        # inline payload: snapshot_text 제거(길이만), 라우트 capped
        inline_pages = []
        for p in pages_out:
            q = {k: v for k, v in p.items() if k != "snapshot_text"}
            inline_pages.append(q)
        payload = {
            "kind": "web_site_sweep", "domain": host, "root_url": root_url,
            "target_id": vi.target_id, "reachable": True,
            "auth": auth,
            "pages": inline_pages,
            "probes": probes,
            "api_samples": api_samples,
            "dynamic_responses": dynamic_responses,
            "route_inventory": {"discovered_total": len(routes),
                                "dom_links": dom_links[:25], "js_api_urls": js_api[:25]},
            "coverage": coverage,
            "scan_hit_summary": hit_summary,
            "evidence_ref": str(evidence_ref),
            "reporting_contract": (
                "scan_hits 는 secret/PII 단서일 뿐. 화면 텍스트/probe 를 보고 공정·경영·계정 "
                "정보 노출 여부는 직접 판단하라. browser 로 확인된 것만 submit_finding(한국어 "
                "분류). 이 도구는 finding/status 적재 안 함 — 끝나면 web_target_set_status "
                "(tasked=노출검토완료 / skipped=접속·인증불가) 직접 호출."
            ),
        }
        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))

    def _write_evidence(self, ctx, *, host, root_url, auth, pages_full, probes,
                        routes, not_inspected, coverage, api_samples=None,
                        dynamic_responses=None) -> Any:
        from pathlib import Path
        out_dir = Path(ctx.evidence_dir) / "web_site_sweeps"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"web_site_sweep_{uuid4().hex[:12]}.json"
        out_path.write_text(json.dumps({
            "kind": "web_site_sweep_evidence", "created_at": time.time(),
            "domain": host, "root_url": root_url, "auth": auth,
            "pages": pages_full, "probes": probes, "api_samples": api_samples or [],
            "dynamic_responses": dynamic_responses or [],
            "routes_discovered_full": routes, "not_inspected_full": not_inspected,
            "coverage": coverage,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        return out_path


__all__ = ["WebSiteSweepTool", "WebSiteSweepInput"]
