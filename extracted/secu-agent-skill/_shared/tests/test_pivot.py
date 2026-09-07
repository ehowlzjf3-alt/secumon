"""finding pivot enricher — 추출기 + GET-only internal probe.

de-domain v3.84 #3: 구 코어 test_pivot.py 이관. pivot 로직은 skill _shared/pivot.py 로
옮겨졌다 (skill-상대 경로 import — pytest pythonpath="." 로 resolve).
"""
from __future__ import annotations

import _shared.pivot as pivot
from secu_agent.agent.tools import url_safety


def test_extract_raw_urls():
    urls = pivot.extract_raw_urls(
        "see http://a.samsungds.net/x and https://b.samsungds.net/y end"
    )
    assert "http://a.samsungds.net/x" in urls
    assert "https://b.samsungds.net/y" in urls


def test_extract_saml_endpoints():
    xml = (
        '<EntityDescriptor entityID="http://sdldev.misdev.sdspaas.io/">'
        '<AssertionConsumerService Location="https://app.samsungds.net/noauth/login/ad"/>'
    )
    eps = pivot.extract_saml_endpoints(xml)
    assert "http://sdldev.misdev.sdspaas.io/" in eps
    assert "https://app.samsungds.net/noauth/login/ad" in eps


def test_extract_yaml_property_hosts():
    y = (
        "server:\n"
        "  host: api.samsungds.net\n"
        "  url: https://svc.samsungds.net/v1\n"
        "endpoint: ep.samsungds.net\n"
    )
    hosts = pivot.extract_yaml_property_hosts(y)
    assert "api.samsungds.net" in hosts
    assert any("svc.samsungds.net" in h for h in hosts)
    assert "ep.samsungds.net" in hosts


def test_extract_ingress_host():
    y = "rules:\n  - host: ingress.samsungds.net\n"
    assert "ingress.samsungds.net" in pivot.extract_ingress_hosts(y)


def test_extract_bare_and_unc_hosts():
    t = r"connect to fileserver.samsungds.net or \\winhost\share\x"
    hosts = pivot.extract_bare_hosts(t)
    assert "fileserver.samsungds.net" in hosts
    assert "winhost" in hosts


def test_pivot_candidates_internal_only():
    cands = pivot.pivot_candidates(
        asset="https://github.samsungds.net/o/r/raw/app.yaml",
        summary="refs https://evil.example.com/x and https://svc.samsungds.net/api",
        hits=[],
    )
    assert any("svc.samsungds.net" in c for c in cands)
    assert all("evil.example.com" not in c for c in cands)


def test_pivot_candidates_blocks_mutation_paths():
    cands = pivot.pivot_candidates(
        asset="repo:x",
        summary=(
            "api https://svc.samsungds.net/api/devtools/reset-login-count/123 "
            "and https://svc.samsungds.net/safe"
        ),
        hits=[],
    )
    assert all("reset-login-count" not in c for c in cands)
    assert any(c.endswith("/safe") for c in cands)


def test_pivot_candidates_caps_and_dedups():
    summary = " ".join(f"https://h{i}.samsungds.net/p" for i in range(20))
    summary += " https://h0.samsungds.net/p"  # dup
    cands = pivot.pivot_candidates(asset="", summary=summary, hits=[])
    assert len(cands) <= 8
    assert len(cands) == len({c.rstrip("/") for c in cands})


def test_pivot_candidates_reads_hit_fields():
    cands = pivot.pivot_candidates(
        asset="github:org/repo/app.yaml",
        summary="",
        hits=[{"category": "secret", "location": "https://svc.samsungds.net/v3/api-docs"}],
    )
    assert any("v3/api-docs" in c for c in cands)


def test_probe_pivot_unreachable_status_000(monkeypatch):
    def fake_probe(urls, **kw):
        return [{
            "url": urls[0], "http_status": None, "semantic_status": "rejected",
            "body_length": 0, "content_type": "", "body_sample_masked": "",
        }]
    monkeypatch.setattr(url_safety, "_probe_web_resources", fake_probe)
    out = pivot.probe_pivot_candidates(["https://svc.samsungds.net/x"])
    assert out[0]["status"] == "000"
    assert out[0]["exposed"] is False


def test_probe_pivot_exposed_classification(monkeypatch):
    def fake_probe(urls, **kw):
        return [{
            "url": urls[0], "http_status": 200, "semantic_status": "confirmed",
            "body_length": 120, "content_type": "application/json",
            "body_sample_masked": "DB_PASS=ab****yz (len=10)",
        }]
    monkeypatch.setattr(url_safety, "_probe_web_resources", fake_probe)
    out = pivot.probe_pivot_candidates(["https://svc.samsungds.net/api"])
    assert out[0]["exposed"] is True
    assert out[0]["status"] == "200"
    assert "****" in out[0]["evidence_masked"]


def test_probe_pivot_blocks_mutation_before_probe(monkeypatch):
    seen = {}

    def fake_probe(urls, **kw):
        seen["urls"] = list(urls)
        return [{
            "url": u, "http_status": 200, "semantic_status": "confirmed",
            "body_length": 1, "content_type": "", "body_sample_masked": "",
        } for u in urls]
    monkeypatch.setattr(url_safety, "_probe_web_resources", fake_probe)
    pivot.probe_pivot_candidates([
        "https://svc.samsungds.net/api/reset/1",
        "https://svc.samsungds.net/ok",
    ])
    assert seen["urls"] == ["https://svc.samsungds.net/ok"]


def test_run_pivot_for_finding_shape(monkeypatch):
    def fake_probe(urls, **kw):
        return [{
            "url": u, "http_status": 200, "semantic_status": "confirmed",
            "body_length": 5, "content_type": "text/plain", "body_sample_masked": "x",
        } for u in urls]
    monkeypatch.setattr(url_safety, "_probe_web_resources", fake_probe)
    p = pivot.run_pivot_for_finding(
        asset="https://svc.samsungds.net/api", summary="", hits=[], now=123.0,
    )
    assert p["version"] == 1 and p["ran_at"] == 123.0
    assert "https://svc.samsungds.net/api" in p["candidates"]
    # 모든 probe 가 confirmed → exposed_count == probe 수 (asset URL + root host)
    assert p["probes"] and p["exposed_count"] == len(p["probes"])


def test_run_pivot_none_when_no_candidates():
    assert pivot.run_pivot_for_finding(
        asset="smb://fs/share/file", summary="no urls here", hits=[],
    ) is None
