"""Read-only validation helpers for credential-like SMB hits.

The probe is intentionally narrow:
- only HTTP GET is sent;
- POST is sent only to endpoints that look like login/auth forms;
- PUT/PATCH/DELETE are never sent;
- raw secrets are never returned in the validation payload.
"""
from __future__ import annotations

import ipaddress
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from base64 import b64encode
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx


_URL_RE = re.compile(r"https?://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+", re.I)
_HOST_RE = re.compile(
    r"(?<![A-Za-z0-9_.-])("
    r"(?:\d{1,3}\.){3}\d{1,3}"
    r"|(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,63}"
    r")(?::(\d{1,5}))?(?![A-Za-z0-9_.-])"
)
_SECRET_KINDS = (
    "access",
    "api",
    "auth",
    "bearer",
    "credential",
    "key",
    "pass",
    "password",
    "secret",
    "token",
)
_SENSITIVE_QUERY_KEYS = (
    "access_token",
    "api_key",
    "apikey",
    "auth",
    "credential",
    "key",
    "pass",
    "password",
    "secret",
    "session",
    "signature",
    "token",
)
_WRITE_HINTS = (
    "post",
    "put",
    "patch",
    "delete",
    "upload",
    "write",
    "create",
    "update",
    "admin",
)
_LOGIN_PATH_HINTS = (
    "auth",
    "login",
    "logon",
    "signin",
    "sign-in",
    "session",
    "token",
)
_USERNAME_KEYS = {
    "account",
    "email",
    "id",
    "login",
    "user",
    "username",
}
_PASSWORD_KEYS = {
    "pass",
    "passwd",
    "password",
    "pw",
    "pwd",
}
_TOKEN_KEYS = {
    "access_token",
    "api_key",
    "apikey",
    "api_token",
    "auth_token",
    "bearer",
    "key",
    "secret",
    "token",
}
_KV_RE = re.compile(
    r"(?P<key>[A-Za-z_][A-Za-z0-9_.:-]{0,80})\s*[:=]\s*"
    r"(?P<value>\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^,\s}\]\n\r;]{1,500})"
)


@dataclass(frozen=True, slots=True)
class _CredentialContext:
    username_key: str | None = None
    username: str | None = None
    password_key: str | None = None
    password: str | None = None
    token_key: str | None = None
    token: str | None = None


def _hit_value(hit: Any, name: str, default: Any = None) -> Any:
    if isinstance(hit, dict):
        return hit.get(name, default)
    return getattr(hit, name, default)


def _is_credential_hit(hit: Any) -> bool:
    category = str(_hit_value(hit, "category", "") or "").lower()
    kind = str(_hit_value(hit, "kind", "") or "").lower()
    if category in {"secret", "secret_heuristic", "credential"}:
        return True
    return any(part in kind for part in _SECRET_KINDS)


def _context_for_hit(text: str, hit: Any, *, radius: int = 4) -> str:
    lines = str(text or "").splitlines()
    line_no = int(_hit_value(hit, "line_no", 0) or 0)
    if line_no <= 0 or line_no > len(lines):
        return str(_hit_value(hit, "line_preview", "") or "")
    start = max(0, line_no - 1 - radius)
    end = min(len(lines), line_no + radius)
    return "\n".join(lines[start:end])


def _valid_host(value: str) -> bool:
    host = str(value or "").strip().strip("[]")
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return "." in host and not host.startswith(".") and not host.endswith(".")
    return ip.version in {4, 6}


def _redact_url(value: str) -> str:
    parsed = urlparse(str(value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return str(value or "")
    host = parsed.hostname or ""
    netloc = host
    try:
        port = parsed.port
    except ValueError:
        port = None
    if port:
        netloc = f"{netloc}:{port}"
    pairs = []
    for key, query_value in parse_qsl(parsed.query, keep_blank_values=True):
        key_l = key.lower()
        if any(part in key_l for part in _SENSITIVE_QUERY_KEYS):
            query_value = "<redacted>"
        pairs.append((key, query_value))
    return urlunparse((
        parsed.scheme,
        netloc,
        parsed.path,
        parsed.params,
        urlencode(pairs),
        "",
    ))


def _candidate_urls(context: str, *, max_targets: int = 2) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    url_hosts: set[str] = set()
    for match in _URL_RE.finditer(context or ""):
        url = match.group(0).rstrip("'\"),;")
        parsed = urlparse(url)
        if parsed.scheme in {"http", "https"} and parsed.hostname and _valid_host(parsed.hostname):
            url_hosts.add(parsed.hostname.lower())
            if url not in seen:
                found.append(url)
                seen.add(url)
        if len(found) >= max_targets:
            return found
    for match in _HOST_RE.finditer(context or ""):
        host = match.group(1)
        port = match.group(2)
        if not _valid_host(host):
            continue
        if host.lower() in url_hosts:
            continue
        target_host = f"{host}:{port}" if port else host
        http_url = f"http://{target_host}/"
        if http_url not in seen:
            found.append(http_url)
            seen.add(http_url)
        if len(found) >= max_targets:
            return found
        https_url = f"https://{target_host}/"
        if https_url not in seen:
            found.append(https_url)
            seen.add(https_url)
        if len(found) >= max_targets:
            return found
    return found[:max_targets]


def _looks_like_login_url(url: str) -> bool:
    parsed = urlparse(str(url or ""))
    haystack = " ".join([parsed.path, parsed.query, parsed.fragment]).lower()
    return any(hint in haystack for hint in _LOGIN_PATH_HINTS)


def _login_urls(urls: list[str], *, max_targets: int = 1) -> list[str]:
    out = [url for url in urls if _looks_like_login_url(url)]
    return out[:max_targets]


def _post_possible(context: str) -> bool:
    lowered = str(context or "").lower()
    return any(hint in lowered for hint in _WRITE_HINTS)


def _strip_value_quotes(value: str) -> str:
    raw = str(value or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {"'", '"'}:
        return raw[1:-1]
    return raw


def _key_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")


def _mask_value(value: str | None) -> str | None:
    raw = str(value or "")
    if not raw:
        return None
    if len(raw) <= 4:
        return raw[0] + "***"
    return raw[:2] + "****" + raw[-2:]


def _credential_context(context: str, hit: Any) -> _CredentialContext:
    pairs: list[tuple[str, str]] = []
    for match in _KV_RE.finditer(context or ""):
        pairs.append((match.group("key"), _strip_value_quotes(match.group("value"))))
    username_key = username = password_key = password = token_key = token = None
    for key, value in pairs:
        normalized = _key_name(key)
        compact = normalized.replace("_", "")
        if username is None and (normalized in _USERNAME_KEYS or compact in _USERNAME_KEYS):
            username_key, username = key, value
        if password is None and (normalized in _PASSWORD_KEYS or compact in _PASSWORD_KEYS):
            password_key, password = key, value
        if token is None and (normalized in _TOKEN_KEYS or compact in _TOKEN_KEYS):
            token_key, token = key, value

    hit_kind = _key_name(str(_hit_value(hit, "kind", "") or ""))
    if token is None and any(part in hit_kind for part in _TOKEN_KEYS):
        span = _hit_value(hit, "span")
        if isinstance(span, tuple) and len(span) == 2:
            # The detector span may include the whole assignment. Prefer a parsed value
            # from context; this fallback is only for token-like standalone hits.
            token_key, token = str(_hit_value(hit, "kind", "token")), None
    return _CredentialContext(
        username_key=username_key,
        username=username,
        password_key=password_key,
        password=password,
        token_key=token_key,
        token=token,
    )


def _default_request(request: dict[str, Any], timeout: float) -> dict[str, Any]:
    started = time.monotonic()
    method = str(request.get("method") or "GET").upper()
    url = str(request.get("url") or "")
    headers = dict(request.get("headers") or {})
    data = dict(request.get("data") or {})
    auth = request.get("auth")
    try:
        with httpx.Client(
            timeout=timeout,
            follow_redirects=False,
            verify=False,
            trust_env=False,
            headers={"User-Agent": "secu-agent-safe-login-probe/1.0"},
        ) as client:
            if method == "POST":
                response = client.post(url, data=data, headers=headers)
            elif method == "GET":
                if auth:
                    response = client.get(url, headers=headers, auth=tuple(auth))
                else:
                    response = client.get(url, headers=headers)
            else:
                return {
                    "result": "not_sent_policy",
                    "error": "method_not_allowed",
                    "elapsed_ms": int((time.monotonic() - started) * 1000),
                }
    except Exception as exc:  # noqa: BLE001
        return {
            "result": "unreachable",
            "error": type(exc).__name__,
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }
    return {
        "result": "reachable" if response.status_code < 500 else "server_error",
        "status_code": response.status_code,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


def _default_get(url: str, timeout: float) -> dict[str, Any]:
    return _default_request({"method": "GET", "url": url}, timeout)


def _login_result(result: dict[str, Any]) -> str:
    status = result.get("status_code")
    if not isinstance(status, int):
        return str(result.get("result") or "unknown")
    if status in {200, 201, 202, 204, 301, 302, 303, 307, 308}:
        return "possible_success"
    if status in {400, 401, 403, 422}:
        return "rejected_or_csrf_required"
    if status >= 500:
        return "server_error"
    return "unknown"


def _auth_attempts(
    urls: list[str],
    context: str,
    hit: Any,
    *,
    request_func: Callable[[dict[str, Any], float], dict[str, Any]] | None,
    timeout: float,
) -> list[dict[str, Any]]:
    creds = _credential_context(context, hit)
    runner = request_func or _default_request
    attempts: list[dict[str, Any]] = []

    # Token-style login/read-only auth probe. This is still a GET.
    if creds.token:
        for url in urls[:1]:
            headers = {"Authorization": f"Bearer {creds.token}"}
            if creds.token_key and "api" in _key_name(creds.token_key):
                headers = {"X-API-Key": creds.token}
            result = runner({"method": "GET", "url": url, "headers": headers}, timeout)
            attempts.append({
                "type": "token_get",
                "method": "GET",
                "url": _redact_url(url),
                "credential": _key_name(creds.token_key or "token"),
                "credential_fields": {
                    "token_key": creds.token_key or "token",
                    "token_masked": _mask_value(creds.token),
                },
                "secret_saved": False,
                **result,
            })
            break

    if creds.username and creds.password:
        # Basic auth is a read-only GET handshake.
        for url in urls[:1]:
            basic = b64encode(f"{creds.username}:{creds.password}".encode()).decode()
            result = runner({
                "method": "GET",
                "url": url,
                "headers": {"Authorization": f"Basic {basic}"},
            }, timeout)
            attempts.append({
                "type": "basic_get",
                "method": "GET",
                "url": _redact_url(url),
                "credential": "username_password",
                "credential_fields": {
                    "username_key": creds.username_key or "username",
                    "username": creds.username,
                    "password_key": creds.password_key or "password",
                    "password_masked": _mask_value(creds.password),
                },
                "secret_saved": False,
                **result,
            })
            break

        # Form login POST is allowed only for login-looking endpoints.
        for url in _login_urls(urls, max_targets=1):
            result = runner({
                "method": "POST",
                "url": url,
                "data": {
                    creds.username_key or "username": creds.username,
                    creds.password_key or "password": creds.password,
                },
            }, timeout)
            attempts.append({
                "type": "form_login_post",
                "method": "POST",
                "url": _redact_url(url),
                "credential": "username_password",
                "credential_fields": {
                    "username_key": creds.username_key or "username",
                    "username": creds.username,
                    "password_key": creds.password_key or "password",
                    "password_masked": _mask_value(creds.password),
                },
                "login_result": _login_result(result),
                "secret_saved": False,
                **result,
            })
            break

    return attempts


def _probe_hit(
    text: str,
    hit: Any,
    *,
    get_func: Callable[[str, float], dict[str, Any]] | None,
    request_func: Callable[[dict[str, Any], float], dict[str, Any]] | None,
    timeout: float,
    max_targets: int,
) -> dict[str, Any] | None:
    if not _is_credential_hit(hit):
        return None
    context = _context_for_hit(text, hit)
    urls = _candidate_urls(context, max_targets=max_targets)
    post_possible = _post_possible(context)
    validation: dict[str, Any] = {
        "kind": "credential_reachability",
        "policy": "GET and login-form POST only; non-login POST/PUT/PATCH/DELETE not sent",
        "attempted": bool(urls),
        "post_possible": post_possible,
        "post_status": "login_only_allowed",
        "targets": [],
        "auth_attempts": [],
    }
    if not urls:
        validation["reason"] = "no_http_target_in_context"
        return validation
    runner = get_func or _default_get
    for url in urls:
        result = runner(url, timeout)
        validation["targets"].append({
            "method": "GET",
            "url": _redact_url(url),
            **result,
        })
    validation["auth_attempts"] = _auth_attempts(
        urls,
        context,
        hit,
        request_func=request_func,
        timeout=timeout,
    )
    if not validation["auth_attempts"] and post_possible:
        validation["post_status"] = "not_sent_no_login_endpoint_or_credentials"
    return validation


def enrich_hits_with_safe_probes(
    text: str,
    hits: list[Any],
    *,
    timeout: float = 2.0,
    max_hits: int = 5,
    max_targets_per_hit: int = 2,
    get_func: Callable[[str, float], dict[str, Any]] | None = None,
    request_func: Callable[[dict[str, Any], float], dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Return state.add_file_hits-compatible dicts with optional validation metadata."""
    out: list[dict[str, Any]] = []
    probed = 0
    for hit in hits:
        item = {
            "category": _hit_value(hit, "category"),
            "kind": _hit_value(hit, "kind"),
            "masked": _hit_value(hit, "masked"),
            "line_no": _hit_value(hit, "line_no"),
            "line_preview": _hit_value(hit, "line_preview", _hit_value(hit, "preview", "")),
        }
        validation = None
        if probed < max_hits and _is_credential_hit(hit):
            validation = _probe_hit(
                text,
                hit,
                get_func=get_func,
                request_func=request_func,
                timeout=timeout,
                max_targets=max_targets_per_hit,
            )
            probed += 1
        if validation is not None:
            item["validation"] = validation
        out.append(item)
    return out
