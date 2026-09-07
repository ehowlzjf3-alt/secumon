"""개인 호스팅 도메인 에이전트.

크롤 + 컨텐츠 detector + 비파괴 web vuln 휴리스틱.

vuln 점검 범위 (모두 비파괴):
  - 노출 파일: /.git/config, /.env, /backup.zip, /phpinfo.php, /server-status, /actuator
  - 보안 헤더 누락: CSP, HSTS, X-Frame-Options, X-Content-Type-Options
  - 디렉토리 인덱스(autoindex on) 노출
  - 기본 페이지 (nginx welcome, apache it works, tomcat manager)
  - reflective XSS: query string에 marker 넣어 본문에 그대로 반사되는지 (payload는 무해 marker)
  - SQLi error-based: ' 만 붙여서 응답에 SQL 에러 fingerprint
  - 인증 없이 접근 가능한 admin 페이지 후보 (/admin, /wp-admin, /phpmyadmin)

SQLi payload는 'AHTH_PROBE 한 종 — DB 변경 절대 일어나지 않음.
"""
from __future__ import annotations

import logging
import os
import re
import urllib.parse
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

_DEFAULT_HEADERS = {
    "User-Agent": os.environ.get(
        "WEB_USER_AGENT", "secu-agent/0.1 (internal-security-scan)",
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

_EXPOSED_PATHS = (
    "/.env", "/.git/config", "/.git/HEAD", "/backup.zip", "/dump.sql",
    "/phpinfo.php", "/server-status", "/server-info",
    "/actuator/env", "/actuator/heapdump", "/actuator/health",
    "/.DS_Store", "/composer.json", "/composer.lock", "/package.json",
    "/wp-config.php.bak", "/web.config", "/Dockerfile", "/docker-compose.yml",
)

_DEFAULT_PAGE_MARKERS = (
    ("nginx_welcome", b"Welcome to nginx!"),
    ("apache_default", b"It works!"),
    ("tomcat_default", b"Apache Tomcat"),
    ("iis_default", b"IIS Windows Server"),
    ("phpmyadmin", b"phpMyAdmin"),
    ("jenkins_login", b"Sign in [Jenkins]"),
)

_AUTOINDEX_MARKERS = (b"Index of /", b"<title>Index of")

_SQL_ERROR_FINGERPRINTS = (
    "you have an error in your sql syntax",
    "warning: mysqli",
    "pg_query():",
    "psycopg2.errors",
    "ora-00933",
    "microsoft odbc",
    "sqlite3.OperationalError",
)

_SEC_HEADERS = (
    "content-security-policy", "strict-transport-security",
    "x-frame-options", "x-content-type-options", "referrer-policy",
)

_XSS_PROBE = "ahth_xss_<>1"  # 본문에 그대로 반사되면 reflective


@dataclass(slots=True)
class CrawledPage:
    url: str
    status: int
    content_type: str
    body: str
    headers: dict[str, str]


@dataclass(slots=True)
class WebFinding:
    url: str
    kind: str            # exposed_file, missing_security_header, default_page, autoindex,
                         # reflective_xss, sqli_error, admin_unauth, basic_auth_url 등
    detail: str
    severity: str = "medium"
    evidence: dict[str, object] = field(default_factory=dict)


_SECRET_ENV_VALUE_RE = re.compile(
    r"(?im)^([A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)"
    r"[A-Z0-9_]*\s*=\s*)(['\"]?)(\S+)(\2)"
)


def _mask_probe_body(text: str) -> str:
    """Keep structure for evidence judgment while masking obvious secrets."""
    return _SECRET_ENV_VALUE_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}***{m.group(4)}", text)


def _response_evidence(r: httpx.Response, *, max_chars: int = 4096) -> dict[str, object]:
    body = r.content[:max_chars].decode("utf-8", errors="replace")
    return {
        "status": r.status_code,
        "content_type": r.headers.get("content-type", ""),
        "content_length": int(r.headers.get("content-length") or len(r.content)),
        "body_preview": _mask_probe_body(body),
    }


def _client(*, timeout: float | None = None, follow_redirects: bool = True) -> httpx.Client:
    return httpx.Client(
        headers=_DEFAULT_HEADERS,
        timeout=timeout or float(os.environ.get("WEB_REQUEST_TIMEOUT", "10")),
        verify=False,
        follow_redirects=follow_redirects,
    )


def _abs(base: str, href: str) -> str:
    return urllib.parse.urljoin(base, href)


def _same_origin(a: str, b: str) -> bool:
    pa, pb = urllib.parse.urlparse(a), urllib.parse.urlparse(b)
    return (pa.scheme, pa.hostname, pa.port) == (pb.scheme, pb.hostname, pb.port)


def crawl(
    seed: str, *, max_pages: int = 50, max_bytes_per_page: int = 256 * 1024,
) -> Iterator[CrawledPage]:
    """BFS 크롤, same-origin 한정."""
    queue: list[str] = [seed]
    seen: set[str] = set()
    with _client(follow_redirects=False) as c:
        while queue and len(seen) < max_pages:
            url = queue.pop(0)
            if url in seen or not _same_origin(seed, url):
                continue
            seen.add(url)
            try:
                r = c.get(url)
            except httpx.HTTPError as e:
                logger.debug("crawl %s failed: %s", url, e)
                continue
            ctype = r.headers.get("content-type", "")
            body = r.content[:max_bytes_per_page]
            text = body.decode("utf-8", errors="replace") if "text" in ctype or "json" in ctype or "xml" in ctype else ""
            yield CrawledPage(
                url=url, status=r.status_code, content_type=ctype,
                body=text, headers=dict(r.headers),
            )
            if not text:
                continue
            # 링크 추출
            try:
                soup = BeautifulSoup(text, "html.parser")
            except Exception:
                continue
            for a in soup.find_all("a", href=True):
                nxt = _abs(url, a["href"])
                if nxt not in seen and _same_origin(seed, nxt):
                    queue.append(nxt)


# ---------- vuln probes ----------

def probe_exposed_files(base: str) -> list[WebFinding]:
    out: list[WebFinding] = []
    with _client(follow_redirects=False) as c:
        for path in _EXPOSED_PATHS:
            url = _abs(base, path)
            try:
                r = c.get(url)
            except httpx.HTTPError:
                continue
            if r.status_code != 200 or len(r.content) < 8:
                continue
            # 기본 페이지면 not really exposed — 그건 default_page에서 별도로 잡힘
            content_lower = r.content[:512].lower()
            if path.endswith(".env") and b"=" in content_lower:
                out.append(WebFinding(url=url, kind="exposed_file",
                                      detail=".env served (200)", severity="high",
                                      evidence=_response_evidence(r)))
            elif path.endswith("/config") or path.endswith("/HEAD"):
                if b"ref:" in content_lower or b"[core]" in content_lower:
                    out.append(WebFinding(url=url, kind="exposed_file",
                                          detail=".git metadata served", severity="high",
                                          evidence=_response_evidence(r)))
            elif path == "/server-status" and b"Server Version" in r.content[:1024]:
                out.append(WebFinding(url=url, kind="exposed_file",
                                      detail="apache server-status open", severity="medium",
                                      evidence=_response_evidence(r)))
            elif "actuator/env" in path and b"propertySources" in r.content[:4096]:
                out.append(WebFinding(url=url, kind="exposed_file",
                                      detail="spring boot actuator/env open", severity="critical",
                                      evidence=_response_evidence(r)))
            elif path in ("/Dockerfile", "/docker-compose.yml", "/composer.json", "/package.json"):
                out.append(WebFinding(url=url, kind="exposed_file",
                                      detail=f"{path} served (likely misconfig)", severity="low",
                                      evidence=_response_evidence(r)))
    return out


def probe_security_headers(page: CrawledPage) -> list[WebFinding]:
    missing = [h for h in _SEC_HEADERS if h not in {k.lower() for k in page.headers}]
    if not missing:
        return []
    return [WebFinding(
        url=page.url, kind="missing_security_header",
        detail="missing: " + ", ".join(missing),
        severity="low",
    )]


def probe_default_page(page: CrawledPage) -> list[WebFinding]:
    raw = page.body.encode("utf-8", errors="ignore")[:4096]
    out: list[WebFinding] = []
    for kind, marker in _DEFAULT_PAGE_MARKERS:
        if marker in raw:
            out.append(WebFinding(
                url=page.url, kind="default_page",
                detail=f"matches {kind}", severity="low",
            ))
            break
    return out


def probe_autoindex(page: CrawledPage) -> list[WebFinding]:
    raw = page.body.encode("utf-8", errors="ignore")[:1024]
    for marker in _AUTOINDEX_MARKERS:
        if marker in raw:
            return [WebFinding(
                url=page.url, kind="autoindex",
                detail="directory listing enabled", severity="medium",
            )]
    return []


def probe_reflective_xss(url: str) -> list[WebFinding]:
    """이미 query 있으면 첫 param에 marker 부착, 없으면 ?q=marker."""
    parsed = urllib.parse.urlparse(url)
    q = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    if q:
        key = q[0][0]
        new_q = [(key, _XSS_PROBE)] + q[1:]
        target = parsed._replace(query=urllib.parse.urlencode(new_q)).geturl()
    else:
        target = url + ("&" if parsed.query else "?") + f"q={urllib.parse.quote(_XSS_PROBE)}"
    with _client() as c:
        try:
            r = c.get(target)
        except httpx.HTTPError:
            return []
    if r.status_code != 200:
        return []
    if _XSS_PROBE in r.text:
        return [WebFinding(
            url=target, kind="reflective_xss",
            detail=f"probe {_XSS_PROBE!r} reflected unescaped", severity="medium",
        )]
    return []


def probe_sqli_error(url: str) -> list[WebFinding]:
    parsed = urllib.parse.urlparse(url)
    q = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    if not q:
        return []
    key = q[0][0]
    new_q = [(key, q[0][1] + "'")] + q[1:]
    target = parsed._replace(query=urllib.parse.urlencode(new_q)).geturl()
    with _client() as c:
        try:
            r = c.get(target)
        except httpx.HTTPError:
            return []
    lower = r.text.lower()
    for fp in _SQL_ERROR_FINGERPRINTS:
        if fp in lower:
            return [WebFinding(
                url=target, kind="sqli_error",
                detail=f"SQL error fingerprint: {fp!r}", severity="high",
            )]
    return []


def probe_admin_unauth(base: str) -> list[WebFinding]:
    out: list[WebFinding] = []
    with _client(follow_redirects=False) as c:
        for path in ("/admin", "/admin/", "/wp-admin/", "/phpmyadmin/", "/manager/html"):
            url = _abs(base, path)
            try:
                r = c.get(url)
            except httpx.HTTPError:
                continue
            if r.status_code == 200 and len(r.content) > 32:
                out.append(WebFinding(
                    url=url, kind="admin_page_reachable",
                    detail=f"{path} returns 200 (no redirect/auth)", severity="medium",
                ))
    return out


def run_vuln_probes(seed: str, pages: Iterable[CrawledPage]) -> list[WebFinding]:
    """1회 헌트에서 vuln 휴리스틱 모음 실행. 호출 측이 enable 결정."""
    out: list[WebFinding] = []
    out.extend(probe_exposed_files(seed))
    out.extend(probe_admin_unauth(seed))
    pages_list = list(pages)
    for p in pages_list:
        if p.status == 200 and "html" in p.content_type:
            out.extend(probe_security_headers(p))
            out.extend(probe_default_page(p))
            out.extend(probe_autoindex(p))
    # XSS/SQLi는 query 있는 페이지에서만
    for p in pages_list:
        if "?" in p.url:
            out.extend(probe_reflective_xss(p.url))
            out.extend(probe_sqli_error(p.url))
    return out
