"""finding pivot enricher — finding 증거에서 라이브 표면을 자동 GET probe.

de-domain v3.84 #3: 구 코어 _shared.pivot.py 원형. SMB UNC / SAML SP /
k8s ingress / 대상 API 표면 추출은 보안점검 도메인 지식이라 skill repo 로 이관됐다.
코어는 register_finding_enricher 훅으로만 이를 안다 — bootstrap 이 이 모듈을
_shared.pivot seam 으로 바인딩(기존 skill importer 호환)하고
run_pivot_for_finding 을 finding enricher 로 등록한다. 안전 게이트(url_safety.
_is_internal_host / _probe_web_resources)는 코어 잔류(KEEP) — 여기선 소비만 한다.

finding emit-site(submit_finding enricher, service_task _persist)에서 finding upsert
직후 1회 호출. **record-only**: 결과는 `finding.extra['pivot']` 에만 기록(게이트/차단 아님).

보안 불변식: GET-only(`url_safety._probe_web_resources` 재사용) · 변조경로 절대 금지
(`_MUTATION_RE`, 후보생성+probe직전 이중방어) · **internal host 만**(`_is_internal_host`,
MWG `trust_env=False` 우회) · 도달불가 → status `"000"` (raise/hang 금지, 짧은 timeout) ·
시크릿/세션값은 이미 마스킹된 `body_sample_masked` 만 노출.
"""
from __future__ import annotations

import re
import time
from typing import Any
from urllib.parse import urlparse

from secu_agent.agent.tools import url_safety

# 변조 가능 경로 토큰 — pivot 은 절대 호출 금지(이중 방어).
_MUTATION_RE = re.compile(
    r"(?i)(recreate|policy|reset|delete|login-count|adhoc|logout|signout|create|update|drop)"
)

_URL_RE = re.compile(r"""https?://[^\s"'<>)\]}]+""", re.IGNORECASE)
# SAML SP entityID="..." / AssertionConsumerService Location="..."
_SAML_ATTR_RE = re.compile(r'(?:entityID|Location)\s*=\s*"([^"]+)"', re.IGNORECASE)
# yaml/properties host-ish keys (same-line value): host:/url:/endpoint:/uri:/baseUrl:/server:
_YAML_HOST_RE = re.compile(
    r"""(?im)^[^\S\n]*[\w.-]*(?:host|url|endpoint|uri|baseurl|server)[^\S\n]*[:=]"""
    r"""[^\S\n]*["']?([^\s"'#,]+)"""
)
# k8s ingress: "- host: foo.bar" / "host: foo.bar"
_INGRESS_HOST_RE = re.compile(r"""(?im)^[\t -]*host[^\S\n]*:[^\S\n]*["']?([a-z0-9.-]+\.[a-z]{2,})""")
# bare FQDN + UNC \\server\share
_FQDN_RE = re.compile(r"\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+)\b", re.IGNORECASE)
_UNC_RE = re.compile(r"\\\\([a-z0-9._-]+)\\", re.IGNORECASE)

_MAX_CANDIDATES = 8
_PIVOT_TIMEOUT = 4.0
_PIVOT_MAX_BYTES = 64 * 1024
_EVIDENCE_CAP = 600

_HIT_TEXT_KEYS = ("location", "preview", "masked", "line_preview")


# ---- 추출기 (순수함수) ----

def extract_raw_urls(text: str) -> list[str]:
    return _URL_RE.findall(text or "")


def extract_saml_endpoints(text: str) -> list[str]:
    return _SAML_ATTR_RE.findall(text or "")


def extract_yaml_property_hosts(text: str) -> list[str]:
    return _YAML_HOST_RE.findall(text or "")


def extract_ingress_hosts(text: str) -> list[str]:
    return _INGRESS_HOST_RE.findall(text or "")


def extract_bare_hosts(text: str) -> list[str]:
    out = list(_UNC_RE.findall(text or ""))
    out += _FQDN_RE.findall(text or "")
    return out


def _normalize_candidate(raw: str) -> str | None:
    raw = (raw or "").strip().strip("\"',;")
    if not raw:
        return None
    if "://" in raw:
        url = raw
    else:
        host = raw.lstrip("/")
        if "." not in host:
            return None
        url = f"https://{host}"
    parsed = urlparse(url)
    if not parsed.hostname:
        return None
    if not parsed.path:
        url = url.rstrip("/") + "/"
    return url


def _hit_texts(hits: Any) -> list[str]:
    texts: list[str] = []
    for h in (hits or []):
        for k in _HIT_TEXT_KEYS:
            v = h.get(k) if isinstance(h, dict) else getattr(h, k, None)
            if v:
                texts.append(str(v))
    return texts


def pivot_candidates(
    *, asset: str, summary: str, hits: Any, cap: int = _MAX_CANDIDATES,
) -> list[str]:
    """finding 증거에서 후속 GET-probe 대상 URL 추출. internal·GET-safe 만, dedup, cap."""
    blob = "\n".join([str(asset or ""), str(summary or ""), *_hit_texts(hits)])
    raw: list[str] = []
    raw += extract_raw_urls(blob)
    raw += extract_saml_endpoints(blob)
    raw += extract_yaml_property_hosts(blob)
    raw += extract_ingress_hosts(blob)
    raw += extract_bare_hosts(blob)

    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        url = _normalize_candidate(item)
        if not url:
            continue
        if _MUTATION_RE.search(url):
            continue
        if not url_safety._is_internal_host(url):
            continue
        try:
            url_safety.validate_url_safe(url)
        except Exception:
            continue
        key = url.rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        out.append(url)
        if len(out) >= cap:
            break
    return out


def probe_pivot_candidates(urls: list[str]) -> list[dict]:
    """GET-only·internal-only probe (url_safety 재사용). 도달불가→status '000'. 절대 raise X."""
    safe: list[str] = []
    for u in urls:
        if _MUTATION_RE.search(u):
            continue
        try:
            if not url_safety._is_internal_host(u):
                continue
        except Exception:
            continue
        safe.append(u)
    if not safe:
        return []
    try:
        resources = url_safety._probe_web_resources(
            safe,
            compare_to_root=True,
            max_bytes=_PIVOT_MAX_BYTES,
            timeout=_PIVOT_TIMEOUT,
        )
    except Exception:
        return [
            {"url": u, "status": "000", "exposed": False, "content_type": "",
             "evidence_masked": ""}
            for u in safe
        ]
    out: list[dict] = []
    for r in resources:
        st = r.get("http_status")
        out.append({
            "url": r.get("url"),
            "status": str(st) if st is not None else "000",
            "exposed": bool(
                r.get("semantic_status") == "confirmed" and (r.get("body_length") or 0) > 0
            ),
            "content_type": str(r.get("content_type") or ""),
            "evidence_masked": str(r.get("body_sample_masked") or "")[:_EVIDENCE_CAP],
        })
    return out


def run_pivot_for_finding(
    *, asset: str, summary: str, hits: Any, now: float | None = None,
) -> dict | None:
    """후보 추출→probe→표준 pivot dict. 후보 0이면 None. 실패해도 raise 안 함."""
    try:
        candidates = pivot_candidates(asset=asset, summary=summary, hits=hits)
        if not candidates:
            return None
        probes = probe_pivot_candidates(candidates)
        return {
            "version": 1,
            "ran_at": now if now is not None else time.time(),
            "candidates": candidates,
            "probes": probes,
            "exposed_count": sum(1 for p in probes if p.get("exposed")),
        }
    except Exception as e:  # pragma: no cover - 방어적
        return {"version": 1, "error": str(e)[:200]}
