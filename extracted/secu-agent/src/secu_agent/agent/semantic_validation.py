"""Semantic validation helpers for tool observations.

Transport success is not evidence by itself. These helpers classify observed
web responses before the agent turns them into a security claim.
"""
from __future__ import annotations

import hashlib
import re
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import urlparse

from secu_agent.detectors.secrets import find_secrets, mask_secret
from secu_agent.detectors.text_scan import mask_scanned_text


_HTML_RE = re.compile(r"(?is)<\s*(?:!doctype|html|head|body|script|title)\b")
_ROBOTS_RE = re.compile(r"(?im)^\s*(user-agent|allow|disallow|sitemap)\s*:")
_ENV_ASSIGN_RE = re.compile(
    r"(?m)^\s*[A-Za-z_][A-Za-z0-9_.-]{1,80}\s*=\s*['\"]?[^'\"\s#]{2,}"
)

_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]{2,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_PRIVATE_IP_RE = re.compile(
    r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|"
    r"172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b"
)
_URL_RE = re.compile(r"https?://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+")
# de-domain: 도메인 민감어휘 시그널은 plugin 이 등록한다 (v3.82 U3a —
# detectors.sensitive_terms 모듈 import 방식에서 등록형 훅으로 전환).
# generic 신호(env assign/email/private IP/URL/secret 패턴)는 코어 유지.
# category → (kind, terms). 매칭 시 kind=*_keyword_context 시그널을 낸다 —
# '키워드 존재' 리드일 뿐 confirmed finding 이 아니며(#27), evidence_judgment
# 가 keyword_context kind 를 finding 증거로 거부하는 계약과 한 쌍이다.
_TERM_SIGNALS: dict[str, tuple[str, tuple[str, ...]]] = {}


def register_sensitive_term_signal(
    category: str, *, kind: str, terms: tuple[str, ...] | list[str],
) -> None:
    """plugin 민감어휘 시그널 등록 — 중복은 명시 에러 (등록 API 공통 규약)."""
    c = str(category or "").strip()
    if not c:
        raise ValueError("category 비어 있음")
    if c in _TERM_SIGNALS:
        raise ValueError(f"sensitive term signal {c!r} 이미 등록됨")
    cleaned = tuple(str(t) for t in terms if str(t).strip())
    if not cleaned:
        raise ValueError("terms 비어 있음")
    _TERM_SIGNALS[c] = (str(kind or "").strip() or f"{c}_keyword_context", cleaned)


def unregister_sensitive_term_signal(category: str) -> bool:
    return _TERM_SIGNALS.pop(str(category or ""), None) is not None


def _content_type(headers: dict[str, Any] | None) -> str:
    headers = headers or {}
    for key, value in headers.items():
        if str(key).lower() == "content-type":
            return str(value)
    return ""


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def _looks_like_html(text: str, content_type: str = "") -> bool:
    haystack = f"{content_type}\n{text[:4096]}"
    return "text/html" in content_type.lower() or bool(_HTML_RE.search(haystack))


def _same_as_root(body: str, root_body: str | None) -> bool:
    if not body or not root_body:
        return False
    if _sha256(body) == _sha256(root_body):
        return True
    return len(body) == len(root_body) and body[:2048] == root_body[:2048]


def _valid_sitemap(body: str) -> bool:
    try:
        root = ET.fromstring(body.encode("utf-8"))
    except ET.ParseError:
        return False
    tag = root.tag.lower()
    return tag.endswith("urlset") or tag.endswith("sitemapindex")


def _masked_email(value: str) -> str:
    local, _, domain = value.partition("@")
    if not local:
        return "<email>"
    return f"{local[:1]}***@{domain}"


def mask_sensitive_text(text: str) -> str:
    """Mask obvious sensitive values in a bounded preview."""
    return mask_scanned_text(str(text or ""))


def _signal(
    *,
    category: str,
    kind: str,
    masked: str,
    location: str,
    confidence: float,
    context: str = "",
) -> dict[str, Any]:
    return {
        "category": category,
        "kind": kind,
        "masked": mask_sensitive_text(masked[:300]),
        "location": mask_sensitive_text(location[:300]),
        "confidence": confidence,
        "context": mask_sensitive_text(context[:300]),
    }


def scan_sensitive_signals(text: str, *, location: str) -> list[dict[str, Any]]:
    """Find masked sensitive and attack-surface signals in text."""
    signals: list[dict[str, Any]] = []
    lower = text.lower()
    safe_text = mask_sensitive_text(text)

    def _safe_context(start: int, end: int, radius: int = 80) -> str:
        safe_start = max(0, min(int(start), len(safe_text)) - radius)
        safe_end = min(len(safe_text), max(0, int(end)) + radius)
        return safe_text[safe_start:safe_end]

    for match in _EMAIL_RE.finditer(text):
        signals.append(_signal(
            category="pii",
            kind="email",
            masked=_masked_email(match.group(0)),
            location=location,
            confidence=0.75,
            context=_safe_context(match.start(), match.end()),
        ))

    for secret in find_secrets(text):
        signals.append(_signal(
            category="credential",
            kind=secret.kind,
            masked=mask_secret(secret.matched),
            location=location,
            confidence=0.85,
            context=_safe_context(secret.span[0], secret.span[1]),
        ))

    for match in _PRIVATE_IP_RE.finditer(text):
        signals.append(_signal(
            category="internal_system",
            kind="private_ip",
            masked=match.group(0),
            location=location,
            confidence=0.7,
            context=_safe_context(match.start(), match.end()),
        ))

    for match in _URL_RE.finditer(text):
        url = match.group(0).rstrip("'\"),;")
        parsed = urlparse(url)
        host = parsed.hostname or ""
        signals.append(_signal(
            category="attack_surface",
            kind="url",
            masked=url[:300],
            location=location,
            confidence=0.65,
            context=_safe_context(match.start(), match.end()),
        ))
        if host.endswith((".internal", ".local")) or ".internal." in host:
            signals.append(_signal(
                category="internal_system",
                kind="internal_url",
                masked=url[:300],
                location=location,
                confidence=0.7,
                context=_safe_context(match.start(), match.end()),
            ))

    for _cat, (_kind, _terms) in _TERM_SIGNALS.items():
        _matched = [t for t in _terms if t in lower]
        if not _matched:
            continue
        # v3.54: 플레이스홀더 라벨 대신 실제 매칭된 키워드를 담는다(리드용 정보).
        # 단 이건 '키워드 존재' 리드일 뿐 — confirmed finding 아님(#27). evidence_judgment
        # 가 kind=*_keyword_context 를 finding 증거로 거부한다.
        signals.append(_signal(
            category=_cat,
            kind=_kind,
            masked="matched terms: " + ", ".join(_matched[:8]),
            location=location,
            confidence=0.6,
            context=safe_text[:500],
        ))

    deduped: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for signal in signals:
        key = (signal["category"], signal["kind"], signal["masked"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(signal)
    return deduped


def _result(
    *,
    url: str,
    method: str,
    status: int | None,
    headers: dict[str, Any] | None,
    body: str,
    semantic_status: str,
    semantic_type: str,
    reason: str,
    required_actions: list[str] | None = None,
    root_body: str | None = None,
) -> dict[str, Any]:
    content_type = _content_type(headers)
    return {
        "url": url,
        "method": method.upper(),
        "http_status": status,
        "content_type": content_type,
        "body_length": len(body),
        "body_sha256": _sha256(body) if body else "",
        "same_as_root": _same_as_root(body, root_body),
        "semantic_status": semantic_status,
        "semantic_type": semantic_type,
        "reason": reason,
        "required_actions": required_actions or [],
        "body_sample_masked": mask_sensitive_text(body[:800]),
        "sensitive_signals": scan_sensitive_signals(body, location=url),
    }


def validate_web_resource(
    *,
    url: str,
    status: int | None,
    headers: dict[str, Any] | None,
    body: str,
    root_body: str | None = None,
    method: str = "GET",
) -> dict[str, Any]:
    """Classify a fetched web resource using deterministic semantic checks."""
    method = method.upper()
    parsed = urlparse(url)
    path = (parsed.path or "/").lower()
    content_type = _content_type(headers)

    if method == "HEAD":
        return _result(
            url=url, method=method, status=status, headers=headers, body=body,
            semantic_status="inconclusive",
            semantic_type="head_only",
            reason="HEAD/status-only observation cannot prove resource semantics",
            required_actions=["GET the resource and validate bounded body content"],
            root_body=root_body,
        )

    if status is not None and 300 <= status < 400:
        location = ""
        for key, value in (headers or {}).items():
            if str(key).lower() == "location":
                location = str(value)
                break
        return _result(
            url=url, method=method, status=status, headers=headers, body=body,
            semantic_status="inconclusive",
            semantic_type="redirect",
            reason=(
                f"HTTP redirect to {location or '(unknown location)'}; "
                "redirect reachability is not a security finding by itself"
            ),
            required_actions=[
                "follow the redirect only if the destination remains in authorized scope",
                "validate final response semantics before reporting a finding",
            ],
            root_body=root_body,
        )

    if status is None or status >= 400:
        return _result(
            url=url, method=method, status=status, headers=headers, body=body,
            semantic_status="rejected",
            semantic_type="http_error",
            reason=f"HTTP status {status} does not confirm an exposed resource",
            root_body=root_body,
        )

    if not body:
        return _result(
            url=url, method=method, status=status, headers=headers, body=body,
            semantic_status="inconclusive",
            semantic_type="empty_body",
            reason="HTTP success with empty body needs follow-up validation",
            required_actions=["refetch with GET and capture a bounded body sample"],
            root_body=root_body,
        )

    same_root = _same_as_root(body, root_body)
    html = _looks_like_html(body, content_type)
    special_path = any(token in path for token in (
        "robots.txt", "sitemap.xml", ".env", ".git/config", ".git/head",
        "config.php", "admin", "login",
    ))
    if same_root and special_path:
        return _result(
            url=url, method=method, status=status, headers=headers, body=body,
            semantic_status="rejected",
            semantic_type="spa_fallback",
            reason="response body matches root page; likely SPA/CDN fallback",
            root_body=root_body,
        )

    if path.endswith("/robots.txt") or path == "/robots.txt":
        if html:
            return _result(
                url=url, method=method, status=status, headers=headers, body=body,
                semantic_status="rejected",
                semantic_type="html_fallback",
                reason="robots.txt returned HTML instead of robots syntax",
                root_body=root_body,
            )
        if _ROBOTS_RE.search(body):
            return _result(
                url=url, method=method, status=status, headers=headers, body=body,
                semantic_status="confirmed",
                semantic_type="robots_txt",
                reason="body contains robots.txt directives",
                root_body=root_body,
            )
        return _result(
            url=url, method=method, status=status, headers=headers, body=body,
            semantic_status="inconclusive",
            semantic_type="unknown_text",
            reason="robots.txt did not contain standard directives",
            required_actions=["inspect body sample and compare with root response"],
            root_body=root_body,
        )

    if path.endswith("/sitemap.xml") or path == "/sitemap.xml":
        if html:
            return _result(
                url=url, method=method, status=status, headers=headers, body=body,
                semantic_status="rejected",
                semantic_type="html_fallback",
                reason="sitemap.xml returned HTML instead of XML sitemap",
                root_body=root_body,
            )
        if _valid_sitemap(body):
            return _result(
                url=url, method=method, status=status, headers=headers, body=body,
                semantic_status="confirmed",
                semantic_type="sitemap_xml",
                reason="body parses as sitemap XML",
                root_body=root_body,
            )
        return _result(
            url=url, method=method, status=status, headers=headers, body=body,
            semantic_status="inconclusive",
            semantic_type="invalid_xml",
            reason="sitemap.xml did not parse as sitemap XML",
            required_actions=["inspect body sample; do not treat status 200 as sitemap exposure"],
            root_body=root_body,
        )

    if path.endswith("/.env") or path.endswith(".env"):
        if html:
            return _result(
                url=url, method=method, status=status, headers=headers, body=body,
                semantic_status="rejected",
                semantic_type="html_fallback",
                reason=".env returned HTML instead of key=value content",
                root_body=root_body,
            )
        if _ENV_ASSIGN_RE.search(body):
            return _result(
                url=url, method=method, status=status, headers=headers, body=body,
                semantic_status="confirmed",
                semantic_type="env_file",
                reason="body contains key=value assignments",
                root_body=root_body,
            )
        return _result(
            url=url, method=method, status=status, headers=headers, body=body,
            semantic_status="inconclusive",
            semantic_type="unknown_text",
            reason=".env path response lacks key=value evidence",
            root_body=root_body,
        )

    if path.endswith("/.git/config"):
        lower = body.lower()
        if html:
            semantic_status, semantic_type, reason = (
                "rejected", "html_fallback", ".git/config returned HTML"
            )
        elif "[core]" in lower or "repositoryformatversion" in lower:
            semantic_status, semantic_type, reason = (
                "confirmed", "git_config", "body contains git config markers"
            )
        else:
            semantic_status, semantic_type, reason = (
                "inconclusive", "unknown_text", ".git/config lacks git markers"
            )
        return _result(
            url=url, method=method, status=status, headers=headers, body=body,
            semantic_status=semantic_status,
            semantic_type=semantic_type,
            reason=reason,
            root_body=root_body,
        )

    if path.endswith(".js") or "javascript" in content_type.lower():
        return _result(
            url=url, method=method, status=status, headers=headers, body=body,
            semantic_status="confirmed",
            semantic_type="javascript_resource",
            reason="JavaScript resource body captured for analysis",
            root_body=root_body,
        )

    if html:
        status_name = "inconclusive" if any(p in path for p in ("admin", "login")) else "confirmed"
        return _result(
            url=url, method=method, status=status, headers=headers, body=body,
            semantic_status=status_name,
            semantic_type="html_page",
            reason=(
                "HTML page captured; reachability alone is not a vulnerability"
                if status_name == "inconclusive"
                else "HTML page body captured"
            ),
            required_actions=(
                ["validate authentication state and page-specific markers before claiming exposure"]
                if status_name == "inconclusive" else []
            ),
            root_body=root_body,
        )

    return _result(
        url=url, method=method, status=status, headers=headers, body=body,
        semantic_status="confirmed",
        semantic_type="resource",
        reason="non-HTML resource body captured",
        root_body=root_body,
    )
