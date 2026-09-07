"""URL 안전 가드 — 코어 안전하중 (web 도메인 콘텐츠와 독립).

SSRF / 스킴 우회 차단. 사내망 IP 대역 (RFC1918 + 사내 공인 대역) 은
통과 — agent 가 IP 로 사내/외부 판단 금지 룰. 본 가드는 cloud metadata /
loopback / link-local / 비 HTTP 스킴 같은 명백한 위험만 차단.

코어 사용처: browser_tool (operator 브라우저), pivot (GET-only probe).
이 모듈의 하드블록 목록(_BLOCKED_HOSTNAMES / _is_blocked_ip)과 scope 게이트
(SA_WEB_ALLOWED_DOMAINS / SA_WEB_ALLOWED_CIDRS / SA_WEB_REQUIRE_SCOPE)는
안전 검증을 통과한 하중이다 — 완화/제거 금지.
"""
from __future__ import annotations

import ipaddress
import os
import re
import socket
from collections.abc import Callable
from urllib.parse import urlparse

import httpx

from secu_agent.agent.semantic_validation import validate_web_resource

_ALLOWED_SCHEMES = ("http", "https")

_BLOCKED_HOSTNAMES = (
    "localhost",
    "metadata.google.internal",
    "metadata",
    "instance-data",
    "instance-data.ec2.internal",
)

_BLOCKED_HOSTNAME_SUFFIXES = (
    ".localhost",
    ".local",
)

_SCOPE_DOMAIN_ENVS = ("SA_WEB_ALLOWED_DOMAINS", "WEB_ALLOWED_DOMAINS")
_SCOPE_CIDR_ENVS = ("SA_WEB_ALLOWED_CIDRS", "WEB_ALLOWED_CIDRS")


class URLSafetyError(ValueError):
    """URL 가드 거부."""


_DEFAULT_INTERNAL_DOMAINS = "samsungds.net,samsungsemi.com"


def _internal_domain_set() -> set[str]:
    raw = os.environ.get("SA_WEB_INTERNAL_DOMAINS", _DEFAULT_INTERNAL_DOMAINS)
    return {d.strip().lower().lstrip(".") for d in raw.split(",") if d.strip()}


def _is_internal_host(url: str) -> bool:
    """v3.45: 사내 host 면 True — httpx trust_env=False 로 proxy 우회.

    `SA_WEB_INTERNAL_DOMAINS` suffix 매칭. RFC1918 / loopback IP literal 도
    사내 간주. 사내 공인 대역 (12.x / 106.x) 포함.
    """
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return False
    # IP literal 사내 대역
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback:
            return True
        # 사내 공인 IP 대역 — 12.x / 106.x
        oct1 = int(host.split(".")[0])
        if oct1 in (12, 106):
            return True
    except ValueError:
        pass
    domains = _internal_domain_set()
    for d in domains:
        if host == d or host.endswith("." + d):
            return True
    return False


# v3.51-S3: CG-NAT 100.64.0.0/10 — carrier-grade NAT 영역, 사내 대상 외.
_CGNAT_NETWORK = ipaddress.ip_network("100.64.0.0/10")


def _is_blocked_ip(host: str) -> tuple[bool, str]:
    """IP literal 거부 판단. (blocked, reason).

    v3.51-S3:
    - IPv6-mapped IPv4 (::ffff:a.b.c.d) 도 안쪽 IPv4 기준으로 재검사 (이전 우회).
    - CG-NAT 100.64.0.0/10 block (사내 scope 밖).
    """
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False, ""

    # IPv6-mapped IPv4 → 내부 IPv4 로 unwrap (loopback / link-local 우회 차단)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped

    if ip.is_loopback:
        return True, "loopback IP blocked"
    if ip.is_link_local:
        return True, "link-local IP (cloud metadata) blocked"
    if ip.is_unspecified:
        return True, "unspecified IP (0.0.0.0/::) blocked"
    if ip.is_multicast:
        return True, "multicast IP blocked"
    if isinstance(ip, ipaddress.IPv4Address) and ip in _CGNAT_NETWORK:
        return True, "CG-NAT (100.64.0.0/10) IP blocked"
    return False, ""


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _split_scope_values(*names: str) -> list[str]:
    values: list[str] = []
    for name in names:
        raw = os.environ.get(name, "")
        if not raw:
            continue
        values.extend(v.strip() for v in re.split(r"[\s,;]+", raw) if v.strip())
    return values


def _normalize_scope_domain(value: str) -> str | None:
    raw = value.strip().lower()
    if not raw or raw == "*":
        return None
    if "://" in raw:
        parsed = urlparse(raw)
        raw = parsed.hostname or ""
    else:
        # Accept operator-friendly entries such as "https://x", "x:8443",
        # "*.example.com", or "example.com/path" without treating ports/paths
        # as part of the hostname.
        parsed = urlparse("//" + raw)
        raw = parsed.hostname or raw
    raw = raw.strip().lower().rstrip(".")
    if raw.startswith("*."):
        raw = raw[2:]
    return raw or None


def _allowed_scope_domains() -> tuple[str, ...]:
    out: list[str] = []
    seen: set[str] = set()
    for value in _split_scope_values(*_SCOPE_DOMAIN_ENVS):
        domain = _normalize_scope_domain(value)
        if domain and domain not in seen:
            seen.add(domain)
            out.append(domain)
    return tuple(out)


def _allowed_scope_cidrs() -> tuple[ipaddress._BaseNetwork, ...]:
    out: list[ipaddress._BaseNetwork] = []
    for value in _split_scope_values(*_SCOPE_CIDR_ENVS):
        try:
            out.append(ipaddress.ip_network(value, strict=False))
        except ValueError as e:
            raise URLSafetyError(f"invalid allowed CIDR {value!r}: {e}") from e
    return tuple(out)


def _scope_is_configured() -> bool:
    return bool(_split_scope_values(*_SCOPE_DOMAIN_ENVS, *_SCOPE_CIDR_ENVS))


def web_scope_active() -> bool:
    """web scope 게이트가 실제 활성인지 = allowed domains/cidrs 설정됨 OR SA_WEB_REQUIRE_SCOPE.
    자율 브라우징(무인 navigate/login)을 이 안으로 가두기 위한 공개 술어(capability floor)."""
    return _scope_is_configured() or _truthy_env("SA_WEB_REQUIRE_SCOPE")


def _hostname_in_allowed_domains(host: str, allowed_domains: tuple[str, ...]) -> bool:
    normalized = host.lower().rstrip(".")
    return any(
        normalized == domain or normalized.endswith("." + domain)
        for domain in allowed_domains
    )


def _host_in_allowed_scope(host: str) -> bool:
    allowed_domains = _allowed_scope_domains()
    allowed_cidrs = _allowed_scope_cidrs()
    if not allowed_domains and not allowed_cidrs:
        if _truthy_env("SA_WEB_REQUIRE_SCOPE"):
            raise URLSafetyError(
                "no allowed web scope configured — set SA_WEB_ALLOWED_DOMAINS "
                "or SA_WEB_ALLOWED_CIDRS"
            )
        return True

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return _hostname_in_allowed_domains(host, allowed_domains)
    return any(ip in network for network in allowed_cidrs)


def validate_url_safe_hardblock(url: str) -> None:
    """scope-무관 **하드블록만** 검사(raise URLSafetyError). side-effect free.

    1. scheme http/https 만 허용.
    2. host 비어있지 않음.
    3. IP literal → loopback / link-local / unspecified / multicast 거부.
    4. hostname 패턴 — localhost / *.local / cloud metadata 명시 거부.

    scope(SA_WEB_ALLOWED_*)는 검사 안 한다 — subresource/iframe 등 off-scope 정상 외부자원을
    오차단하지 않으면서 SSRF-to-metadata/loopback 만 막을 때 쓴다(browser CDP fetch 게이트).
    """
    if not url or not url.strip():
        raise URLSafetyError("empty url")

    parsed = urlparse(url.strip())
    scheme = (parsed.scheme or "").lower()
    if scheme not in _ALLOWED_SCHEMES:
        raise URLSafetyError(
            f"disallowed scheme {scheme!r} — http/https only"
        )

    host_raw = parsed.hostname  # urlparse 가 [::1] → "::1" 로 정리해줌
    if not host_raw:
        raise URLSafetyError("missing host")
    host = host_raw.lower()

    blocked, reason = _is_blocked_ip(host)
    if blocked:
        raise URLSafetyError(f"{host}: {reason}")

    if host in _BLOCKED_HOSTNAMES:
        raise URLSafetyError(f"hostname {host!r} blocked")
    for suffix in _BLOCKED_HOSTNAME_SUFFIXES:
        if host.endswith(suffix):
            raise URLSafetyError(f"hostname suffix {suffix!r} blocked ({host})")


def validate_url_safe(url: str) -> None:
    """raise URLSafetyError on disallowed URL. side-effect free.

    검사:
    1~4. 하드블록(validate_url_safe_hardblock).
    5. SA_WEB_ALLOWED_DOMAINS / SA_WEB_ALLOWED_CIDRS 설정 시 해당 scope 외 거부.
    """
    validate_url_safe_hardblock(url)
    host = (urlparse(url.strip()).hostname or "").lower()
    if (_scope_is_configured() or _truthy_env("SA_WEB_REQUIRE_SCOPE")) and not _host_in_allowed_scope(host):
        raise URLSafetyError(
            f"{host}: outside allowed web scope — set SA_WEB_ALLOWED_DOMAINS "
            "or SA_WEB_ALLOWED_CIDRS"
        )


DNS_REBIND_CHECK_ENV = "SA_WEB_DNS_REBIND_CHECK"
_Resolver = Callable[[str, object], list]


def _resolve_host_or_block(host: str, resolver: _Resolver = socket.getaddrinfo) -> None:
    """host 를 DNS resolve 해 **모든** 결과 IP 가 하드블록에 안 걸리는지 재검사한다.

    audit #7: validate_url_safe 는 side-effect-free 문자열 검사라 악성 호스트명이
    loopback/link-local(cloud metadata)/CGNAT 로 해석되는 것을 못 막는다(DNS 재바인딩).
    IP literal 은 이미 validate_url_safe 의 _is_blocked_ip 가 처리하므로 건너뛴다.
    resolve 실패(NXDOMAIN/네트워크 없음)는 fail-open — 연결 단계에서 어차피 실패한다.

    TOCTOU 주의: resolve 시점과 연결 시점의 DNS 응답이 다르면(fast-flux rebinding)
    완전히 막지 못한다. 그 경우엔 SA_WEB_ALLOWED_* scope 게이트가 강한 통제다.
    """
    try:
        ipaddress.ip_address(host)
        return  # IP literal — validate_url_safe 가 이미 검사
    except ValueError:
        pass
    try:
        infos = resolver(host, None)
    except OSError:
        return  # resolve 실패 → fail-open
    for info in infos:
        sockaddr = info[4] if len(info) > 4 else None
        raw_ip = str(sockaddr[0]) if sockaddr else ""
        ip = raw_ip.split("%", 1)[0]  # IPv6 zone id 제거
        if not ip:
            continue
        blocked, reason = _is_blocked_ip(ip)
        if blocked:
            raise URLSafetyError(f"{host} resolves to blocked {ip}: {reason}")


def validate_url_safe_resolved(
    url: str, *, resolver: _Resolver = socket.getaddrinfo,
) -> None:
    """validate_url_safe(문자열 검사) + DNS resolve 재바인딩 검사.

    실제 연결 직전 경로(web_fetch/browser/pivot)에서 쓴다. 기본 활성 —
    `SA_WEB_DNS_REBIND_CHECK` 를 0/false/no/off 로 두면 resolve 검사만 끈다
    (문자열 하드블록·scope 는 그대로 유지). 운영 kill-switch.
    """
    validate_url_safe(url)
    if os.environ.get(DNS_REBIND_CHECK_ENV, "").strip().lower() in {"0", "false", "no", "off"}:
        return
    host = (urlparse(url.strip()).hostname or "").lower()
    if host:
        _resolve_host_or_block(host, resolver=resolver)


def validate_url_safe_hardblock_resolved(
    url: str, *, resolver: _Resolver = socket.getaddrinfo,
) -> None:
    """하드블록(scope 무관) + DNS resolve 재바인딩 검사. scope 없이 hostname→metadata/loopback
    resolve 를 막을 때(browser subresource/iframe egress). 완전 TOCTOU 는 못 막고(연결시점 DNS
    변경) scope 게이트가 강한 통제 — validate_url_safe_resolved 와 동일 한계."""
    validate_url_safe_hardblock(url)
    if os.environ.get(DNS_REBIND_CHECK_ENV, "").strip().lower() in {"0", "false", "no", "off"}:
        return
    host = (urlparse(url.strip()).hostname or "").lower()
    if host:
        _resolve_host_or_block(host, resolver=resolver)


def _origin(url: str) -> str:
    parsed = urlparse(url)
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}/"


def _decode_web_content(content: bytes) -> str:
    if content[:8192].count(b"\x00") > 4:
        return ""
    return content.decode("utf-8", errors="replace")


def _probe_web_resources(
    urls: list[str],
    *,
    compare_to_root: bool = True,
    max_bytes: int = 256 * 1024,
    timeout: float | None = None,
) -> list[dict]:
    """Fetch URLs and classify the observed body semantics.

    This helper is intentionally sync so callers can run it inside
    asyncio.to_thread and tests can monkeypatch it without async ceremony.

    `timeout` overrides the per-request timeout (default = WEB_REQUEST_TIMEOUT env,
    10s). v3.74 pivot passes a short bound so unreachable hosts fail fast.
    """
    ua = os.environ.get("WEB_USER_AGENT", "secu-agent/0.1")
    if timeout is None:
        timeout = float(os.environ.get("WEB_REQUEST_TIMEOUT", "10"))
    root_cache: dict[str, str] = {}
    resources: list[dict] = []
    # v3.45: 사내/외부 분리 client. 둘 다 만들어 두고 url 별로 선택.
    def _make_client(trust_env: bool) -> httpx.Client:
        return httpx.Client(
            headers={"User-Agent": ua},
            verify=False,
            timeout=timeout,
            follow_redirects=False,
            trust_env=trust_env,
        )
    client_internal = _make_client(trust_env=False)
    client_external = _make_client(trust_env=True)
    try:
        for url in urls:
            client = client_internal if _is_internal_host(url) else client_external
            root_body: str | None = None
            if compare_to_root:
                origin = _origin(url)
                if origin not in root_cache:
                    try:
                        root_resp = client.get(origin)
                    except httpx.HTTPError:
                        root_cache[origin] = ""
                    else:
                        root_cache[origin] = _decode_web_content(
                            root_resp.content[:max_bytes],
                        )
                root_body = root_cache.get(origin) or None

            try:
                resp = client.get(url)
            except httpx.HTTPError as e:
                resources.append({
                    "url": url,
                    "method": "GET",
                    "http_status": None,
                    "content_type": "",
                    "body_length": 0,
                    "body_sha256": "",
                    "same_as_root": False,
                    "semantic_status": "rejected",
                    "semantic_type": "fetch_error",
                    "reason": repr(e),
                    "required_actions": ["retry if this URL is still in scope"],
                    "body_sample_masked": "",
                    "sensitive_signals": [],
                })
                continue

            body = _decode_web_content(resp.content[:max_bytes])
            resources.append(validate_web_resource(
                url=url,
                status=resp.status_code,
                headers=dict(resp.headers),
                body=body,
                root_body=root_body,
                method="GET",
            ))
    finally:
        for c in (client_internal, client_external):
            close = getattr(c, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
    return resources
