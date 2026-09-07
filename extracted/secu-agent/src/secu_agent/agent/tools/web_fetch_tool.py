"""v3.81 T3: WebFetchTool — 코어 공통 web fetch (GET-only).

공통툴 이식 (my-claude-code WebFetch 대응) — 기존 `url_safety` 게이트를
그대로 재사용한다 (hard block: file://·loopback·link-local·metadata·CGNAT +
SA_WEB_ALLOWED_DOMAINS/CIDRS/REQUIRE_SCOPE 스코프). 게이트 완화/우회 금지.

- GET 전용, redirect 자동 추적 안 함 (3xx 는 Location 보고 — 재호출은
  agent 몫, 각 hop 이 게이트를 다시 통과하게).
- HTML 은 기본 텍스트 추출 (의존성 최소화 — bs4 없이 stdlib/regex).
- 본문 cap 256KB — 큰 파일/바이너리는 browser/evidence 도구로.
"""
from __future__ import annotations

import asyncio
import collections
from dataclasses import asdict, dataclass
import fnmatch
import html as _html
import http.cookiejar
import json
import os
import re
import threading
from typing import ClassVar, Literal
from urllib.parse import urlsplit, urlunsplit

import httpx
from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)
from secu_agent.agent.tools.url_safety import (
    URLSafetyError, _decode_web_content, _is_internal_host, validate_url_safe,
    validate_url_safe_resolved,
)

_MAX_BYTES = 256 * 1024
_MAX_OUTPUT_CHARS = 80_000
_WEB_FETCH_TRACE_METADATA_KEY = "_web_fetch_traces"
_WEB_FETCH_TRACE_LIMIT = 20
# curl_cffi Session 풀(선택 transport 전용) — LRU 로 상한을 둬 장시간 세션에서
# 호스트/impersonate 조합이 무한 누적돼 fd/메모리 누수 나는 것을 막는다.
# evict 시 반드시 세션을 .close() 한다. 상한은 SA_WEB_SESSION_POOL_MAX 로 조정.
_CURL_CFFI_SESSION_POOL: "collections.OrderedDict[tuple[str, str], object]" = (
    collections.OrderedDict()
)
_CURL_CFFI_SESSION_LOCK = threading.Lock()
_WEB_SESSION_POOL_MAX_DEFAULT = 32


def _web_session_pool_max() -> int:
    """LRU 풀 상한 — SA_WEB_SESSION_POOL_MAX 로 조정(안전 기본 32, 최소 1)."""
    raw = os.environ.get("SA_WEB_SESSION_POOL_MAX")
    if raw is None:
        return _WEB_SESSION_POOL_MAX_DEFAULT
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return _WEB_SESSION_POOL_MAX_DEFAULT
    return value if value >= 1 else 1


def _close_session_quietly(session: object) -> None:
    """세션을 조용히 닫는다(close 없으면 무시, 예외는 삼킨다)."""
    close = getattr(session, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # noqa: BLE001 — evict 정리는 best-effort
            pass


# httpx keep-alive 풀 — _fetch_sync 가 GET 마다 Client 를 새로 만들면 매 요청 TCP+TLS
# 핸드셰이크가 발생한다. 키는 trust_env(사내 직결 vs 외부 프록시) 두 가지뿐이라 소형 dict
# +lock 으로 유지하고, 교체 시 반드시 이전 클라이언트를 close 한다. verify/redirect 설정은
# 원 _fetch_sync 와 동일하게 보존(SAFETY-KEEP). timeout 은 요청별 override 로 반영한다.
#
# 풀은 전체 Client 를 재사용해 trust_env 프록시 마운트(사내=직결/외부=MWG)까지 그대로 보존한다.
# HTTP/1.1 keep-alive 만 쓴다: HTTP/2 를 켜면 _fetch_sync 의 cap-break(본문을 _MAX_BYTES 에서
# 중단)가 스트림을 drain/reset 하지 않아 재사용 커넥션의 flow-control 창을 소진→이후 GET stall
# 위험이 있다(cap-break 이 상시 경로라 위험이 상수). keep-alive 만으로 핸드셰이크 재사용 이득은
# 이미 확보된다.
_HTTPX_CLIENT_POOL: "dict[bool, httpx.Client]" = {}
_HTTPX_CLIENT_LOCK = threading.Lock()


class _NoStoreCookieJar(http.cookiejar.CookieJar):
    """Set-Cookie 를 저장하지 않는 jar. 풀 Client 는 상태를 공유하므로 그냥 두면 한 fetch 의
    쿠키가 이후 동일 도메인 fetch 에 실려 나간다(원 stateless per-GET 대비 회귀·세션 교차오염).
    set_cookie 를 무력화해 저장 0 → 이후 요청에 Cookie 헤더도 붙지 않는다."""

    def set_cookie(self, cookie):  # noqa: D401 — 저장 자체를 막는다
        return


def _pooled_httpx_client(*, trust_env: bool, timeout: float) -> httpx.Client:
    """keep-alive Client 를 trust_env 별로 재사용. 없거나 닫혀 있으면 새로 만든다."""
    with _HTTPX_CLIENT_LOCK:
        client = _HTTPX_CLIENT_POOL.get(trust_env)
        if client is not None and not client.is_closed:
            return client
        ua = os.environ.get("WEB_USER_AGENT", "secu-agent/0.1")
        new_client = httpx.Client(
            headers={"User-Agent": ua},
            cookies=_NoStoreCookieJar(),  # fetch 간 쿠키 carryover 차단(원 per-GET 무상태 보존)
            verify=False,            # SAFETY-KEEP: 사내 자가서명 흔함 — 원 _fetch_sync 유지
            timeout=timeout,
            follow_redirects=False,  # SAFETY-KEEP: redirect 미추적 — 원 _fetch_sync 유지
            trust_env=trust_env,
            http2=False,             # cap-break 와 HTTP/2 flow-control 상충 → HTTP/1.1 keep-alive
            limits=httpx.Limits(max_keepalive_connections=8, max_connections=16),
        )
        if client is not None:       # 닫힌 채 남아있던 이전 클라이언트 정리
            _close_session_quietly(client)
        _HTTPX_CLIENT_POOL[trust_env] = new_client
        return new_client

_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style|noscript)\b[^>]*>.*?</\1\s*>",
    re.IGNORECASE | re.DOTALL,
)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_BLOCK_TAG_RE = re.compile(
    r"</?(p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|"
    r"footer|blockquote|pre)\b[^>]*>",
    re.IGNORECASE,
)
_TAG_RE = re.compile(r"<[^>]+>")
_BLANK_RE = re.compile(r"\n{3,}")
_HARD_CHALLENGE_MARKERS = (
    "cf-chl-", "cf_clearance", "cloudflare ray id", "__cf_bm",
    "g-recaptcha", "hcaptcha", "arkoselabs", "perimeterx", "_px3",
    "datadome", "incapsula", "distil_r_captcha", "akamai bot manager",
)
_SOFT_CHALLENGE_MARKERS = (
    "enable javascript", "verify you are human", "checking your browser",
    "unusual traffic", "temporarily blocked", "please wait while we check",
    "access denied", "request blocked", "bot detection", "are you human",
)
_WAF_PROFILES: dict[str, dict[str, object]] = {
    "akamai_bot_manager": {
        "detectors": {
            "cookie": ("_abck", "bm_sz", "ak_bmsc", "bm_sv", "bm_so"),
            "header": ("x-akamai-*",),
            "server_contains": ("akamaighost",),
            "body": ("sec-if-cpt-container", "powered and protected by akamai"),
        },
        "confidence_rules": {"strong": 2, "weak": 1},
        "capabilities_needed": ("needs_real_browser_stack", "needs_js_exec"),
        "url_transform_order": ("original", "mobile_subdomain"),
        "fallback_when_challenge": ("browser_api_candidates", "browser_session"),
    },
    "cloudflare_turnstile": {
        "detectors": {
            "cookie": ("cf_clearance", "__cf_bm", "__cfduid"),
            "header": ("cf-ray", "cf-cache-status"),
            "server_contains": ("cloudflare",),
            "body": ("just a moment", "checking your browser", "cf-chl-bypass"),
        },
        "confidence_rules": {"strong": 2, "weak": 1},
        "capabilities_needed": ("needs_js_exec",),
        "url_transform_order": ("original",),
        "fallback_when_challenge": ("browser_api_candidates", "browser_session"),
    },
    "f5_big_ip": {
        "detectors": {
            "cookie": ("BigIPServer", "TS01*", "F5_*"),
            "body": ("the requested url was rejected", "support id is:"),
        },
        "confidence_rules": {"strong": 2, "weak": 1},
        "capabilities_needed": ("needs_real_browser_stack",),
        "url_transform_order": ("original",),
        "fallback_when_challenge": ("browser_api_candidates",),
    },
    "aws_waf": {
        "detectors": {
            "cookie": ("aws-waf-token",),
            "header": ("x-amzn-requestid", "x-amzn-errortype", "x-amzn-waf-*"),
        },
        "confidence_rules": {"strong": 2, "weak": 1},
        "capabilities_needed": ("needs_real_browser_stack",),
        "url_transform_order": ("original",),
        "fallback_when_challenge": ("browser_api_candidates",),
    },
    "datadome_probable": {
        "detectors": {
            "cookie": ("datadome",),
            "body": ("datadome",),
        },
        "confidence_rules": {"strong": 2, "weak": 1},
        "capabilities_needed": ("needs_real_browser_stack", "needs_js_exec"),
        "url_transform_order": ("original",),
        "fallback_when_challenge": ("browser_session",),
    },
    "perimeterx_human": {
        "detectors": {
            "cookie": ("_px3", "_pxhd", "_px2", "pxcts"),
            "body": ("px-captcha", "press & hold to confirm you are a human"),
        },
        "confidence_rules": {"strong": 2, "weak": 1},
        "capabilities_needed": ("needs_real_browser_stack", "needs_js_exec"),
        "url_transform_order": ("original",),
        "fallback_when_challenge": ("browser_session",),
    },
    "unknown_challenge": {
        "detectors": {},
        "confidence_rules": {"strong": 0, "weak": 0},
        "capabilities_needed": ("needs_js_exec",),
        "url_transform_order": ("original", "mobile_subdomain", "drop_www"),
        "fallback_when_challenge": ("browser_api_candidates", "browser_session"),
    },
}


@dataclass(frozen=True, slots=True)
class WafDetectionHit:
    profile_id: str
    confidence: float
    signals: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "profile_id": self.profile_id,
            "confidence": self.confidence,
            "signals": list(self.signals),
        }


@dataclass(frozen=True, slots=True)
class _FetchAttemptState:
    url: str
    status: int
    headers: dict[str, str]
    body: bytes
    assessment: "WebFetchAssessment"
    route: str = "direct"
    transform: str = "original"
    transport: str = "httpx"
    error: str | None = None


class WebFetchTransportError(RuntimeError):
    """Optional transport failure surfaced as a tool io_error."""


@dataclass(frozen=True, slots=True)
class WebFetchAssessment:
    verdict: str
    reasons: tuple[str, ...]
    status: int
    body_bytes: int
    content_type: str
    escalation_hints: tuple[str, ...] = ()
    waf_detections: tuple[WafDetectionHit, ...] = ()
    capabilities_needed: tuple[str, ...] = ()
    retry_plan: tuple[dict[str, object], ...] = ()
    untried_routes: tuple[str, ...] = ()
    must_use_browser: bool = False

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        payload["reasons"] = list(self.reasons)
        payload["escalation_hints"] = list(self.escalation_hints)
        payload["waf_detections"] = [hit.to_dict() for hit in self.waf_detections]
        payload["capabilities_needed"] = list(self.capabilities_needed)
        payload["retry_plan"] = list(self.retry_plan)
        payload["untried_routes"] = list(self.untried_routes)
        return payload


def _html_to_text(body: str) -> str:
    """bs4 없는 보수적 HTML → 텍스트 (의존성 최소화). 완벽 추출이 아니라
    '읽을 수 있는 본문' 목표 — 구조 분석이 필요하면 raw=True 로."""
    body = _SCRIPT_STYLE_RE.sub(" ", body)
    body = _COMMENT_RE.sub(" ", body)
    body = _BLOCK_TAG_RE.sub("\n", body)
    body = _TAG_RE.sub(" ", body)
    body = _html.unescape(body)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in body.splitlines()]
    return _BLANK_RE.sub("\n\n", "\n".join(ln for ln in lines if ln)).strip()


def _visible_text_length(text: str) -> int:
    visible = _TAG_RE.sub(" ", text)
    visible = _html.unescape(visible)
    visible = re.sub(r"\s+", " ", visible).strip()
    return len(visible)


def _json_payload_state(text: str) -> str | None:
    stripped = text.strip()
    if not stripped:
        return "empty"
    try:
        parsed = json.loads(stripped)
    except ValueError:
        return None
    if parsed in ({}, [], None, ""):
        return "empty"
    return "non_empty"


def _set_cookie_names(headers: dict[str, str]) -> list[str]:
    raw = headers.get("set-cookie", "")
    names: list[str] = []
    for match in re.finditer(r"(?:^|,\s*)([A-Za-z0-9_%.-]+)=", raw):
        name = match.group(1)
        if name.lower() in {"expires", "path", "domain", "max-age", "samesite"}:
            continue
        names.append(name)
    return names


def _match_patterns(values: list[str], patterns: tuple[str, ...]) -> list[str]:
    lowered = [value.lower() for value in values]
    hits: list[str] = []
    for pattern in patterns:
        pat = pattern.lower()
        if any(ch in pat for ch in "*?["):
            if any(fnmatch.fnmatchcase(value, pat) for value in lowered):
                hits.append(pattern)
        elif pat in lowered:
            hits.append(pattern)
    return hits


def _detect_waf_profiles(
    *,
    headers: dict[str, str],
    body_text: str,
) -> tuple[WafDetectionHit, ...]:
    header_names = list(headers.keys())
    cookie_names = _set_cookie_names(headers)
    body_lower = body_text[:64_000].lower()
    server = headers.get("server", "").lower()
    hits: list[WafDetectionHit] = []

    for profile_id, profile in _WAF_PROFILES.items():
        if profile_id == "unknown_challenge":
            continue
        detectors = profile.get("detectors") or {}
        if not isinstance(detectors, dict):
            continue
        signals: list[str] = []
        for cookie in _match_patterns(
            cookie_names,
            tuple(str(v) for v in detectors.get("cookie", ())),
        ):
            signals.append(f"cookie:{cookie}")
        for header in _match_patterns(
            header_names,
            tuple(str(v) for v in detectors.get("header", ())),
        ):
            signals.append(f"header:{header}")
        for needle in detectors.get("server_contains", ()) or ():
            if str(needle).lower() in server:
                signals.append(f"server:{needle}")
        for needle in detectors.get("body", ()) or ():
            if str(needle).lower() in body_lower:
                signals.append(f"body:{needle}")
        if not signals:
            continue
        rules = profile.get("confidence_rules") or {"strong": 2, "weak": 1}
        strong = int(rules.get("strong", 2)) if isinstance(rules, dict) else 2
        weak = int(rules.get("weak", 1)) if isinstance(rules, dict) else 1
        confidence = 0.9 if len(signals) >= strong else 0.6 if len(signals) >= weak else 0.3
        hits.append(WafDetectionHit(
            profile_id=profile_id,
            confidence=confidence,
            signals=tuple(signals),
        ))

    hits.sort(key=lambda hit: hit.confidence, reverse=True)
    return tuple(hits)


def _replace_host(url: str, new_host: str) -> str:
    parts = urlsplit(url)
    return urlunsplit(parts._replace(netloc=new_host))


def _transformed_urls(url: str, order: tuple[str, ...]) -> list[tuple[str, str]]:
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    parts = urlsplit(url)
    host = parts.hostname or ""
    def with_port(new_host: str) -> str:
        return f"{new_host}:{parts.port}" if parts.port else new_host

    transforms: dict[str, str | None] = {
        "original": url,
        "mobile_subdomain": None,
        "am_prefix": None,
        "drop_www": None,
    }
    if host.startswith("www."):
        new_host = with_port("m." + host[4:])
        transforms["mobile_subdomain"] = _replace_host(url, new_host)
        transforms["drop_www"] = _replace_host(url, with_port(host[4:]))
    elif host and not host.startswith("m.") and host.count(".") <= 1:
        transforms["am_prefix"] = _replace_host(url, with_port("m." + host))

    for name in order:
        candidate = transforms.get(name)
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        out.append((name, candidate))
    return out


def _profile_config(detections: tuple[WafDetectionHit, ...], verdict: str) -> tuple[str, dict[str, object]]:
    if detections:
        profile_id = detections[0].profile_id
        return profile_id, _WAF_PROFILES.get(profile_id, _WAF_PROFILES["unknown_challenge"])
    if verdict in {"blocked", "suspect_challenge", "suspect_ok", "rate_limited"}:
        return "unknown_challenge", _WAF_PROFILES["unknown_challenge"]
    return "", {}


def _build_retry_plan(
    url: str,
    *,
    profile: dict[str, object],
) -> tuple[dict[str, object], ...]:
    order = tuple(str(v) for v in profile.get("url_transform_order", ("original",)) or ("original",))
    plan: list[dict[str, object]] = []
    for transform, candidate in _transformed_urls(url, order):
        item: dict[str, object] = {
            "route": "web_fetch_url_transform",
            "transform": transform,
            "url": candidate[:2048],
            "allowed_by_scope": True,
        }
        try:
            validate_url_safe(candidate)
        except URLSafetyError as e:
            item["allowed_by_scope"] = False
            item["blocked_reason"] = str(e)[:300]
        plan.append(item)
    for fallback in profile.get("fallback_when_challenge", ()) or ():
        route = str(fallback)
        if route == "browser_api_candidates":
            plan.append({
                "route": "browser_supervisor",
                "action": "api_candidates",
                "allowed_by_scope": True,
            })
        elif route == "browser_session":
            plan.append({
                "route": "browser_session",
                "action": "start_then_navigate",
                "allowed_by_scope": True,
            })
    return tuple(plan)


def _untried_routes_for(
    *,
    verdict: str,
    retry_plan: tuple[dict[str, object], ...],
) -> tuple[tuple[str, ...], bool]:
    if verdict in {"auth_required", "not_found"}:
        return (), False
    routes: list[str] = []
    must_browser = False
    if verdict == "rate_limited":
        routes.append("rate-limited: back off before retry; do not hammer the grid")
    transform_count = sum(
        1 for item in retry_plan
        if item.get("route") == "web_fetch_url_transform" and item.get("allowed_by_scope")
    )
    if transform_count > 1:
        routes.append("url-transform candidates available; re-fetch only candidates allowed by url_safety")
    if any(item.get("route") == "browser_supervisor" for item in retry_plan):
        routes.append("browser_supervisor(action='api_candidates') to inspect captured /api, graphql, json endpoints")
        must_browser = True
    if any(item.get("route") == "browser_session" for item in retry_plan):
        routes.append("browser_session + browser_action navigate for JS-rendered or challenge-gated pages")
        must_browser = True
    return tuple(dict.fromkeys(routes)), must_browser


def _assess_web_fetch_response(
    *,
    url: str,
    status: int,
    headers: dict[str, str],
    body: bytes,
) -> WebFetchAssessment:
    ctype = headers.get("content-type", "")
    text = _decode_web_content(body[:_MAX_BYTES])
    lowered = text[:64_000].lower()
    reasons: list[str] = []
    hints: list[str] = []
    detections = _detect_waf_profiles(headers=headers, body_text=text)

    if status in {429, 401, 407, 404, 410}:
        if status == 429:
            verdict = "rate_limited"
            reasons.append("rate_limited")
            hints.append("요청 간격을 늦추고 browser 이벤트에서 429 원인을 확인")
        elif status in {401, 407}:
            verdict = "auth_required"
            reasons.append("auth_required")
            hints.append("인증 세션이 필요한 경우 browser 세션 주입 경로 사용")
        else:
            verdict = "not_found"
            reasons.append("not_found")
        _, profile = _profile_config(detections, verdict)
        capabilities = tuple(str(v) for v in profile.get("capabilities_needed", ()) or ())
        retry_plan = _build_retry_plan(url, profile=profile) if profile else ()
        untried, must_browser = _untried_routes_for(verdict=verdict, retry_plan=retry_plan)
        return WebFetchAssessment(
            verdict=verdict,
            reasons=tuple(reasons),
            status=status,
            body_bytes=len(body),
            content_type=ctype,
            escalation_hints=tuple(hints),
            waf_detections=detections,
            capabilities_needed=capabilities,
            retry_plan=retry_plan,
            untried_routes=untried,
            must_use_browser=must_browser,
        )

    for marker in _HARD_CHALLENGE_MARKERS:
        if marker in lowered:
            reasons.append(f"challenge_marker:{marker}")
            hints.append("browser_supervisor(action='events')로 네트워크/동적 응답을 확인")
            break
    if reasons:
        _, profile = _profile_config(detections, "suspect_challenge")
        retry_plan = _build_retry_plan(url, profile=profile) if profile else ()
        untried, must_browser = _untried_routes_for(
            verdict="suspect_challenge",
            retry_plan=retry_plan,
        )
        return WebFetchAssessment(
            verdict="suspect_challenge",
            reasons=tuple(reasons),
            status=status,
            body_bytes=len(body),
            content_type=ctype,
            escalation_hints=tuple(hints),
            waf_detections=detections,
            capabilities_needed=tuple(
                str(v) for v in profile.get("capabilities_needed", ()) or ()
            ),
            retry_plan=retry_plan,
            untried_routes=untried,
            must_use_browser=must_browser,
        )

    for marker in _SOFT_CHALLENGE_MARKERS:
        if marker in lowered:
            reasons.append(f"soft_challenge_marker:{marker}")
            hints.append("JS 렌더링이 필요하면 browser 도구로 재확인")
            break

    if 300 <= status < 400:
        reasons.append("redirect")
        verdict = "redirect"
    elif status == 429:
        reasons.append("rate_limited")
        hints.append("요청 간격을 늦추고 browser 이벤트에서 429 원인을 확인")
        verdict = "rate_limited"
    elif status in {401, 407}:
        reasons.append("auth_required")
        hints.append("인증 세션이 필요한 경우 browser 세션 주입 경로 사용")
        verdict = "auth_required"
    elif status in {403, 451}:
        reasons.append("blocked_status")
        hints.append("browser_supervisor(action='api_candidates')로 공개 API 후보 확인")
        verdict = "blocked"
    elif status in {404, 410}:
        reasons.append("not_found")
        verdict = "not_found"
    elif 500 <= status < 600:
        reasons.append("server_error")
        hints.append("일시 오류 가능성: 다른 경로/시간대에서 재시도")
        verdict = "transient_error"
    elif 400 <= status < 500:
        reasons.append("client_error")
        verdict = "client_error"
    else:
        verdict = "ok"

    is_json = "json" in ctype.lower()
    json_state = _json_payload_state(text) if is_json or text.lstrip().startswith(("{", "[")) else None
    if json_state == "non_empty" and verdict == "ok":
        reasons.append("json_non_empty")
        return WebFetchAssessment(
            verdict="json_ok",
            reasons=tuple(reasons or ["status_ok"]),
            status=status,
            body_bytes=len(body),
            content_type=ctype,
            escalation_hints=tuple(hints),
            waf_detections=detections,
        )
    if json_state == "empty" and status < 400:
        reasons.append("empty_json")
        if verdict == "ok":
            verdict = "suspect_ok"

    visible_len = _visible_text_length(text)
    if status < 300 and len(body) < 512 and visible_len < 80 and json_state is None:
        reasons.append("small_low_text_body")
        if verdict == "ok":
            verdict = "suspect_challenge"
            hints.append("본문이 너무 작아 challenge/placeholder 여부 확인 필요")

    if not reasons:
        reasons.append("status_ok")
    if hints and verdict in {"ok", "json_ok"}:
        verdict = "weak_ok"
    _, profile = _profile_config(detections, verdict)
    capabilities = tuple(str(v) for v in profile.get("capabilities_needed", ()) or ())
    retry_plan = _build_retry_plan(url, profile=profile) if profile else ()
    untried, must_browser = _untried_routes_for(verdict=verdict, retry_plan=retry_plan)

    return WebFetchAssessment(
        verdict=verdict,
        reasons=tuple(dict.fromkeys(reasons)),
        status=status,
        body_bytes=len(body),
        content_type=ctype,
        escalation_hints=tuple(dict.fromkeys(hints)),
        waf_detections=detections,
        capabilities_needed=capabilities,
        retry_plan=retry_plan,
        untried_routes=untried,
        must_use_browser=must_browser,
    )


def _record_web_fetch_trace(
    ctx: ToolContext,
    *,
    url: str,
    strategy: str,
    assessment: WebFetchAssessment,
    route: str = "direct",
    transform: str = "original",
    transport: str = "httpx",
    selected: bool = False,
    error: str | None = None,
) -> None:
    traces = ctx.metadata.get(_WEB_FETCH_TRACE_METADATA_KEY)
    if not isinstance(traces, list):
        traces = []
        ctx.metadata[_WEB_FETCH_TRACE_METADATA_KEY] = traces
    traces.append({
        "url": url[:2048],
        "strategy": strategy,
        "route": route,
        "transform": transform,
        "transport": transport,
        "selected": selected,
        "assessment": assessment.to_dict(),
        "error": error,
    })
    if len(traces) > _WEB_FETCH_TRACE_LIMIT:
        del traces[:-_WEB_FETCH_TRACE_LIMIT]


def _format_assessment_lines(
    *,
    strategy: str,
    assessment: WebFetchAssessment,
) -> str:
    lines = [
        f"strategy={strategy} verdict={assessment.verdict} "
        f"reasons={','.join(assessment.reasons)}",
    ]
    if assessment.waf_detections:
        top = assessment.waf_detections[0]
        signals = ",".join(top.signals[:3])
        lines.append(
            f"waf_profile={top.profile_id} confidence={top.confidence:.1f} "
            f"signals={signals or 'none'}",
        )
    if assessment.capabilities_needed:
        lines.append(f"capabilities_needed={','.join(assessment.capabilities_needed)}")
    if assessment.untried_routes:
        lines.append(f"untried_routes={'; '.join(assessment.untried_routes)}")
    if assessment.escalation_hints:
        lines.append(f"escalation_hint={'; '.join(assessment.escalation_hints)}")
    else:
        lines.append("escalation_hint=none")
    if strategy == "adaptive" and assessment.retry_plan:
        lines.append(
            "adaptive_retry_plan="
            + json.dumps(list(assessment.retry_plan), ensure_ascii=False),
        )
    return "\n".join(lines)


def _fetch_sync(url: str) -> tuple[int, dict[str, str], bytes]:
    """GET 1회 — redirect 미추적. (status, headers, body[:cap+1])."""
    timeout = float(os.environ.get("WEB_REQUEST_TIMEOUT", "10"))
    # url_safety._probe_web_resources 와 동일 결: 사내=직결, 외부=MWG proxy.
    trust_env = not _is_internal_host(url)
    # A1(perf): GET 마다 Client(=매 요청 TCP+TLS 핸드셰이크) 대신 keep-alive 풀 재사용.
    # timeout 은 요청별 override 로 넘겨 WEB_REQUEST_TIMEOUT 런타임 변경을 반영한다.
    client = _pooled_httpx_client(trust_env=trust_env, timeout=timeout)
    # 조기중단(cap 초과)으로 body 를 다 안 읽어도 httpx 는 stream 컨텍스트 종료 시 해당
    # 커넥션을 풀에 되돌리지 않고 닫으므로 keep-alive 오염이 없다.
    with client.stream("GET", url, timeout=timeout) as resp:
        chunks: list[bytes] = []
        total = 0
        for chunk in resp.iter_bytes():
            chunks.append(chunk)
            total += len(chunk)
            if total > _MAX_BYTES:
                break
        headers = {k.lower(): v for k, v in resp.headers.items()}
        return resp.status_code, headers, b"".join(chunks)


def _self_root(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}/"


def _curl_cffi_session(url: str, impersonate: str):
    try:
        from curl_cffi import requests as cffi_requests  # type: ignore
    except ImportError as e:
        raise WebFetchTransportError(
            "curl_cffi not installed; install optional extra web-adaptive",
        ) from e
    host = (urlsplit(url).hostname or "").lower()
    key = (host, impersonate)
    with _CURL_CFFI_SESSION_LOCK:
        session = _CURL_CFFI_SESSION_POOL.get(key)
        if session is not None:
            _CURL_CFFI_SESSION_POOL.move_to_end(key)  # LRU: 최근 사용으로 갱신
            return session
        try:
            session = cffi_requests.Session(impersonate=impersonate)
        except Exception as e:  # noqa: BLE001
            raise WebFetchTransportError(
                f"curl_cffi session create failed for impersonate={impersonate!r}: {e}",
            ) from e
        _CURL_CFFI_SESSION_POOL[key] = session
        _CURL_CFFI_SESSION_POOL.move_to_end(key)
        # 상한 초과분은 가장 오래된 것부터 evict + close (fd/메모리 누수 방지).
        cap = _web_session_pool_max()
        while len(_CURL_CFFI_SESSION_POOL) > cap:
            _, evicted = _CURL_CFFI_SESSION_POOL.popitem(last=False)
            _close_session_quietly(evicted)
        return session


def _response_body_capped(resp: object) -> bytes:
    chunks: list[bytes] = []
    total = 0
    iter_content = getattr(resp, "iter_content", None)
    if callable(iter_content):
        for chunk in iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            if isinstance(chunk, str):
                chunk = chunk.encode("utf-8", errors="replace")
            chunks.append(bytes(chunk))
            total += len(chunk)
            if total > _MAX_BYTES:
                break
        return b"".join(chunks)
    content = getattr(resp, "content", b"")
    if isinstance(content, str):
        content = content.encode("utf-8", errors="replace")
    if not isinstance(content, (bytes, bytearray)):
        text = getattr(resp, "text", "") or ""
        content = str(text).encode("utf-8", errors="replace")
    return bytes(content[:_MAX_BYTES + 1])


def _fetch_curl_cffi_sync(
    url: str,
    *,
    impersonate: str,
) -> tuple[int, dict[str, str], bytes]:
    """Optional curl_cffi GET — redirect 미추적, url_safety는 호출자가 수행."""
    ua = os.environ.get("WEB_USER_AGENT", "secu-agent/0.1")
    timeout = float(os.environ.get("WEB_REQUEST_TIMEOUT", "10"))
    headers = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "application/json;q=0.8,*/*;q=0.7",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": _self_root(url),
    }
    session = _curl_cffi_session(url, impersonate)
    try:
        resp = session.get(
            url,
            headers=headers,
            timeout=timeout,
            allow_redirects=False,
            stream=True,
            verify=False,
        )
    except TypeError:
        resp = session.get(
            url,
            headers=headers,
            timeout=timeout,
            allow_redirects=False,
            verify=False,
        )
    except Exception as e:  # noqa: BLE001
        raise WebFetchTransportError(f"curl_cffi fetch failed: {e!r}") from e
    try:
        body = _response_body_capped(resp)
    finally:
        close = getattr(resp, "close", None)
        if callable(close):
            close()
    headers_out = {str(k).lower(): str(v) for k, v in dict(getattr(resp, "headers", {}) or {}).items()}
    return int(getattr(resp, "status_code", 0) or 0), headers_out, body


def _fetch_sync_transport(
    url: str,
    *,
    transport: str,
    impersonate: str,
) -> tuple[int, dict[str, str], bytes]:
    if transport == "httpx":
        return _fetch_sync(url)
    if transport == "curl_cffi":
        return _fetch_curl_cffi_sync(url, impersonate=impersonate)
    raise WebFetchTransportError(f"unknown web_fetch transport: {transport}")


def _terminal_success(assessment: WebFetchAssessment) -> bool:
    return assessment.verdict in {"ok", "weak_ok", "json_ok"}


def _should_try_adaptive_routes(assessment: WebFetchAssessment) -> bool:
    return assessment.verdict in {
        "blocked", "suspect_challenge", "suspect_ok", "client_error", "transient_error",
    }


def _fetch_error_assessment(error: str) -> WebFetchAssessment:
    return WebFetchAssessment(
        verdict="unknown",
        reasons=("fetch_error",),
        status=0,
        body_bytes=0,
        content_type="",
        escalation_hints=(error[:300],),
    )


async def _fetch_assessed(
    *,
    url: str,
    route: str = "direct",
    transform: str = "original",
    transport: str = "httpx",
    impersonate: str = "safari",
) -> _FetchAttemptState:
    try:
        status, headers, body = await asyncio.to_thread(
            _fetch_sync_transport,
            url,
            transport=transport,
            impersonate=impersonate,
        )
    except (httpx.HTTPError, WebFetchTransportError) as e:
        err = f"fetch 실패: {e!r}"
        return _FetchAttemptState(
            url=url,
            status=0,
            headers={},
            body=b"",
            assessment=_fetch_error_assessment(err),
            route=route,
            transform=transform,
            transport=transport,
            error=err,
        )
    assessment = _assess_web_fetch_response(
        url=url,
        status=status,
        headers=headers,
        body=body,
    )
    return _FetchAttemptState(
        url=url,
        status=status,
        headers=headers,
        body=body,
        assessment=assessment,
        route=route,
        transform=transform,
        transport=transport,
    )


class WebFetchInput(BaseModel):
    url: str = Field(..., max_length=2000, description="http/https URL")
    raw: bool = Field(
        False,
        description="true 면 HTML 텍스트 추출 없이 원문 반환",
    )
    strategy: Literal["normal", "adaptive"] = Field(
        "normal",
        description=(
            "normal=기존 GET. adaptive=동일 안전 게이트 안에서 URL transform 재시도와 "
            "차단/챌린지/browser 진단 힌트를 수행."
        ),
    )
    max_attempts: int = Field(
        3,
        ge=1,
        le=8,
        description="adaptive 전략에서 원본 포함 최대 GET 시도 횟수",
    )
    transport: Literal["httpx", "curl_cffi"] = Field(
        "httpx",
        description="httpx=기본. curl_cffi=선택 설치된 TLS impersonation transport 사용.",
    )
    impersonate: str = Field(
        "safari",
        max_length=64,
        pattern=r"^[A-Za-z0-9_.-]+$",
        description="transport=curl_cffi 일 때 사용할 impersonate profile",
    )


class WebFetchTool(Tool[WebFetchInput]):
    name: ClassVar[str] = "web_fetch"
    description: ClassVar[str] = (
        "URL GET 후 본문 반환 (읽기 전용 공통 도구).\n"
        "- HTML 은 기본 텍스트 추출 (raw=true 면 원문)\n"
        "- redirect 자동 추적 안 함 — 3xx 면 Location 보고, 필요 시 재호출\n"
        "- url_safety 게이트 통과 필수 (스코프 밖/내부 metadata 등 거부)\n"
        "- 본문 cap 256KB. JS 렌더링 필요하면 browser 도구 사용.\n"
        "- strategy='adaptive'는 같은 url_safety 게이트 안에서 URL transform 재시도와 "
        "challenge/API 후보 진단을 수행.\n"
        "- transport='curl_cffi'는 선택 의존성 설치 시에만 동작하는 opt-in TLS impersonation."
    )
    input_model: ClassVar[type[BaseModel]] = WebFetchInput
    is_read_only: ClassVar[bool] = True
    domain: ClassVar[str] = "core"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "web fetch", "url 가져오기", "http get",
    )
    prompt_section: ClassVar[str] = (
        "### web_fetch(url, raw=false, strategy='normal', max_attempts=3, transport='httpx')\n"
        "URL GET-only fetch — HTML 은 텍스트 추출, redirect 는 Location 보고만. "
        "JS 렌더링/로그인 필요 페이지는 browser 도구. 허용 스코프 밖 URL 은 거부된다. "
        "adaptive 는 안전 게이트를 통과한 URL transform 후보를 제한적으로 재시도하고 "
        "응답 판정/후속 진단 힌트를 남긴다. curl_cffi transport 는 선택 설치된 경우에만 사용한다."
    )

    async def execute(self, vi: WebFetchInput, ctx: ToolContext) -> ToolResult:
        url = vi.url.strip()
        try:
            validate_url_safe_resolved(url)  # audit #7: +DNS 재바인딩 검사
        except URLSafetyError as e:
            return ToolError(kind="permission", message=f"url_safety 거부: {e}")

        initial = await _fetch_assessed(
            url=url,
            transport=vi.transport,
            impersonate=vi.impersonate,
        )
        if initial.error:
            return ToolError(kind="io_error", message=initial.error)

        attempts: list[_FetchAttemptState] = [initial]
        selected = initial

        if (
            vi.strategy == "adaptive"
            and not (300 <= initial.status < 400)
            and not _terminal_success(initial.assessment)
            and _should_try_adaptive_routes(initial.assessment)
        ):
            for item in initial.assessment.retry_plan:
                if len(attempts) >= vi.max_attempts:
                    break
                if item.get("route") != "web_fetch_url_transform":
                    continue
                if not item.get("allowed_by_scope"):
                    continue
                candidate = str(item.get("url") or "").strip()
                if not candidate or candidate == url:
                    continue
                try:
                    validate_url_safe_resolved(candidate)  # audit #7
                except URLSafetyError:
                    continue
                attempt = await _fetch_assessed(
                    url=candidate,
                    route="web_fetch_url_transform",
                    transform=str(item.get("transform") or "unknown"),
                    transport=vi.transport,
                    impersonate=vi.impersonate,
                )
                attempts.append(attempt)
                if _terminal_success(attempt.assessment):
                    selected = attempt
                    break

        for attempt in attempts:
            _record_web_fetch_trace(
                ctx,
                url=attempt.url,
                strategy=vi.strategy,
                assessment=attempt.assessment,
                route=attempt.route,
                transform=attempt.transform,
                transport=attempt.transport,
                selected=attempt is selected,
                error=attempt.error,
            )

        status = selected.status
        headers = selected.headers
        body = selected.body
        assessment = selected.assessment
        selected_label = url if selected.url == url else f"{url} ⇒ {selected.url}"
        attempt_line = f"transport={selected.transport}\n"
        if vi.strategy == "adaptive":
            attempt_line += (
                f"adaptive_attempts={len(attempts)} "
                f"selected_transform={selected.transform}\n"
            )

        if 300 <= status < 400:
            loc = headers.get("location", "(없음)")
            return ToolSuccess(content=(
                f"[web_fetch] {selected_label} → {status} redirect\n"
                f"{attempt_line}"
                f"{_format_assessment_lines(strategy=vi.strategy, assessment=assessment)}\n"
                f"Location: {loc}\n"
                f"(자동 추적 안 함 — 필요하면 해당 URL 로 재호출. "
                f"재호출도 url_safety 게이트를 통과해야 함)"
            ))

        truncated = len(body) > _MAX_BYTES
        text = _decode_web_content(body[:_MAX_BYTES])
        ctype = headers.get("content-type", "")
        if not vi.raw and "html" in ctype.lower():
            text = _html_to_text(text)
        if len(text) > _MAX_OUTPUT_CHARS:
            text = text[:_MAX_OUTPUT_CHARS]
            truncated = True

        head = (
            f"[web_fetch] {selected_label} → {status} "
            f"({ctype or 'content-type 미상'}, {len(body)}B"
            f"{', truncated' if truncated else ''})\n"
            f"{attempt_line}"
            f"{_format_assessment_lines(strategy=vi.strategy, assessment=assessment)}\n\n"
        )
        return ToolSuccess(content=head + text)
