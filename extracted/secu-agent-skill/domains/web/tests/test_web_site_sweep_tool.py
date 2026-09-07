"""web_site_sweep 도구 — fake page + helper monkeypatch (실제 Playwright 없이)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from secu_agent.agent.tools import browser_tool as bt
from domains.web.plugin.tools import web_tools as wt
from domains.web.plugin.tools import web_site_sweep_tool as sweep
from secu_agent.agent.tools.base import ToolContext, ToolSuccess
from domains.web.plugin.tools.web_site_sweep_tool import WebSiteSweepTool

ROOT = "https://app--demo-prod.cdep.samsungds.net"
HOST = "app--demo-prod.cdep.samsungds.net"


class FakeResp:
    def __init__(self, status=200):
        self.status = status


class FakePage:
    def __init__(self, *, html_by_url=None, fail_urls=None, snaps=None, status_by_url=None):
        self.url = "about:blank"
        self.html_by_url = html_by_url or {}
        self.fail_urls = set(fail_urls or [])
        self.snaps = snaps or {}
        self.status_by_url = status_by_url or {}
        self.goto_calls: list[str] = []

    async def goto(self, url, wait_until=None, timeout=None):
        self.goto_calls.append(url)
        if url in self.fail_urls:
            raise asyncio.TimeoutError("nav timeout")
        self.url = url
        return FakeResp(self.status_by_url.get(url, 200))

    async def content(self):
        return self.html_by_url.get(self.url, "")

    async def wait_for_load_state(self, *a, **k):
        return None

    async def evaluate(self, expr, *a, **k):
        return None  # scrollTo 등 — fake no-op


def _install(monkeypatch, page, *, snap_fn, login=(True, "ok", False), probes=None):
    monkeypatch.setattr(bt, "_is_running", lambda: True)
    monkeypatch.setattr(bt, "_require_page", lambda: (page, None))
    monkeypatch.setattr(bt, "_validate_browser_url_safe", lambda u: None)
    monkeypatch.setattr(bt, "_snapshot_data", snap_fn)

    async def _login(p, mode="auto"):
        return login
    monkeypatch.setattr(bt, "_perform_login", _login)
    monkeypatch.setattr(wt, "_probe_web_resources",
                        lambda urls, **k: list(probes or []))


def _run(tool, vi, ctx):
    return asyncio.run(tool.execute(vi, ctx))


def _ctx(tmp_path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path)


def _payload(res) -> dict:
    assert isinstance(res, ToolSuccess), res
    return json.loads(res.content)


# ---------------------------------------------------------------- meta/registry

def test_metadata_and_registry():
    assert WebSiteSweepTool.name == "web_site_sweep"
    assert WebSiteSweepTool.domain == "web"
    from secu_agent.agent.tools.registry import ToolRegistry

    r = ToolRegistry()
    r.register(WebSiteSweepTool)
    assert "web_site_sweep" in {t.name for t in r.all()}


# ---------------------------------------------------------------- baseline

def test_baseline_no_auth_wall(tmp_path, monkeypatch):
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "Demo", "elements": [
            {"href": "/list", "input_type": ""}, {"href": "/about", "input_type": ""},
        ], "text": "환영합니다 일반 콘텐츠"}
    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap,
             probes=[{"url": ROOT + "/robots.txt", "semantic_status": "confirmed"}])
    tool = WebSiteSweepTool()
    res = _run(tool, tool.input_model(domain=HOST, max_route_pages=5), _ctx(tmp_path))
    p = _payload(res)
    assert p["reachable"] is True
    assert p["auth"]["wall_detected"] is False
    assert p["probes"] and p["probes"][0]["semantic_status"] == "confirmed"
    # gate metadata 양쪽 set
    # (ctx 는 _run 안에서 못 꺼내므로 별도 테스트에서 검증)
    assert p["coverage"]["routes_discovered"] >= 1


def test_gate_metadata_set(tmp_path, monkeypatch):
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "x", "elements": [], "text": "hi"}
    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap)
    ctx = _ctx(tmp_path)
    tool = WebSiteSweepTool()
    _run(tool, tool.input_model(domain=HOST), ctx)
    assert HOST in [h.lower() for h in ctx.metadata.get("_web_browser_hosts", [])]
    assert HOST in [h.lower() for h in ctx.metadata.get("_web_content_inspected_hosts", [])]


# ---------------------------------------------------------------- auth/login

def test_auth_wall_login_success(tmp_path, monkeypatch):
    calls = {"n": 0}
    async def snap(page, sel, **k):
        calls["n"] += 1
        # 첫 snapshot 은 password 필드(벽), 로그인 후 재snapshot 은 없음
        if calls["n"] == 1:
            return {"url": page.url, "title": "Login", "elements": [
                {"input_type": "password"}], "text": "login"}
        return {"url": page.url, "title": "Home", "elements": [], "text": "authed content"}
    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap, login=(True, "로그인 성공", False))
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST), _ctx(tmp_path)))
    assert p["auth"]["wall_detected"] is True
    assert p["auth"]["kind"] == "login_form"
    assert p["auth"]["login_attempted"] is True
    assert p["auth"]["login_ok"] is True
    assert calls["n"] >= 2  # 재snapshot 발생


def test_auth_wall_login_fail(tmp_path, monkeypatch):
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "Login", "elements": [
            {"input_type": "password"}], "text": "login wall"}
    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap, login=(False, "로그인 실패", False))
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST), _ctx(tmp_path)))
    assert p["auth"]["login_ok"] is False


def test_auth_wall_detects_access_denied_without_password(tmp_path, monkeypatch):
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "403 Forbidden",
                "elements": [], "text": "Access denied. 권한 없음."}
    page = FakePage(status_by_url={ROOT: 403})
    _install(monkeypatch, page, snap_fn=snap)
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST, attempt_login=False), _ctx(tmp_path)))
    assert p["auth"]["wall_detected"] is True
    assert p["auth"]["auth_state"] == "access_denied"
    assert p["auth"]["kind"] == "access_denied"
    assert p["pages"][0]["is_authed_view"] is False
    assert p["pages"][0]["auth_state"] == "access_denied"


def test_auth_wall_detects_off_origin_without_idp_markers(tmp_path, monkeypatch):
    async def snap(page, sel, **k):
        return {"url": "https://gateway.example.net/challenge", "title": "Continue",
                "elements": [], "text": "Continue to workspace"}
    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap)
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST, attempt_login=False), _ctx(tmp_path)))
    assert p["auth"]["wall_detected"] is True
    assert p["auth"]["auth_state"] == "off_origin"
    assert p["auth"]["kind"] == "off_origin"
    assert p["auth"]["auth_reason"] == "off_origin_final_url"
    assert p["pages"][0]["is_authed_view"] is False
    assert p["pages"][0]["auth_state"] == "off_origin"


def test_auth_wall_detects_sso_button_without_password(tmp_path, monkeypatch):
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "Welcome", "elements": [
            {"tag": "button", "label": "SSO Login", "input_type": ""},
        ], "text": "통합인증으로 로그인"}
    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap, login=(False, "SSO 자격증명 미설정", True))
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST), _ctx(tmp_path)))
    assert p["auth"]["wall_detected"] is True
    assert p["auth"]["auth_state"] == "sso"
    assert p["auth"]["kind"] == "sso"
    assert p["auth"]["login_attempted"] is True


def test_post_login_requires_return_to_original_host(tmp_path, monkeypatch):
    calls = {"n": 0}

    async def snap(page, sel, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"url": page.url, "title": "Login",
                    "elements": [{"input_type": "password"}], "text": "login"}
        return {"url": page.url, "title": "SSO", "elements": [],
                "text": "Signed in at identity provider"}

    async def login(page, mode="auto"):
        page.url = "https://secsso.samsungds.net/adfs/ls/"
        return True, "로그인 성공", False

    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap)
    monkeypatch.setattr(bt, "_perform_login", login)
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST), _ctx(tmp_path)))
    assert p["auth"]["login_attempted"] is True
    assert p["auth"]["login_ok"] is False
    assert p["auth"]["post_login_host_ok"] is False
    assert p["auth"]["post_login_auth_state"] == "sso"


def test_same_page_login_success_preserves_denied_status(tmp_path, monkeypatch):
    calls = {"n": 0}

    async def snap(page, sel, **k):
        calls["n"] += 1
        return {"url": page.url, "title": "Workspace",
                "elements": [], "text": "Workspace shell loaded"}

    page = FakePage(status_by_url={ROOT: 403})
    _install(monkeypatch, page, snap_fn=snap, login=(True, "injected session", False))
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST), _ctx(tmp_path)))
    assert p["auth"]["login_attempted"] is True
    assert p["auth"]["login_ok"] is False
    assert p["auth"]["post_login_same_page"] is True
    assert p["auth"]["post_login_auth_state"] == "access_denied"
    assert p["pages"][0]["auth_state"] == "access_denied"
    assert p["pages"][0]["is_authed_view"] is False


def test_weak_saml_marker_fails_closed_without_sso_false_positive(tmp_path, monkeypatch):
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "Architecture Notes",
                "elements": [{"href": "/docs/saml-metadata", "input_type": ""}],
                "text": "Reference material for SAML metadata and OAuth settings."}

    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap)
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST), _ctx(tmp_path)))
    assert p["auth"]["wall_detected"] is True
    assert p["auth"]["login_attempted"] is False
    assert p["auth"]["auth_state"] == "unknown"
    assert p["auth"]["kind"] == "unknown"
    assert p["auth"]["auth_reason"] == "weak_auth_marker"
    assert p["pages"][0]["auth_state"] == "unknown"
    assert p["pages"][0]["is_authed_view"] is False


def test_reachable_auth_reference_links_remain_open(tmp_path, monkeypatch):
    async def snap(page, sel, **k):
        if page.url.endswith("/saml-metadata"):
            return {"url": page.url, "title": "Metadata Reference",
                    "elements": [], "text": "Public metadata reference content."}
        return {"url": page.url, "title": "Service Portal",
                "elements": [
                    {"tag": "a", "role": "link", "label": "Login", "input_type": ""},
                    {"href": "/saml-metadata", "label": "Docs", "input_type": ""},
                ],
                "text": "Service catalog release notes and incident dashboard."}

    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap)
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST, max_route_pages=2), _ctx(tmp_path)))
    assert p["auth"]["wall_detected"] is False
    assert p["auth"]["auth_state"] == "open"
    assert p["pages"][0]["auth_state"] == "open"
    assert p["pages"][0]["is_authed_view"] is True
    saml_page = next(pg for pg in p["pages"] if pg["url"].endswith("/saml-metadata"))
    assert saml_page["auth_state"] == "open"
    assert saml_page["is_authed_view"] is True


# ---------------------------------------------------------------- route cap

def test_route_cap_records_not_inspected(tmp_path, monkeypatch):
    links = [{"href": f"/p{i}", "input_type": ""} for i in range(40)]
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "t", "elements": links, "text": "x"}
    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap)
    tool = WebSiteSweepTool()
    res = _run(tool, tool.input_model(domain=HOST, max_route_pages=8), _ctx(tmp_path))
    p = _payload(res)
    cov = p["coverage"]
    assert cov["cap_reached"] is True
    assert cov["routes_discovered"] >= 40
    assert cov["not_inspected_count"] >= 30
    # evidence 에 전체 not_inspected
    ev = json.loads(Path(p["evidence_ref"]).read_text(encoding="utf-8"))
    assert len(ev["not_inspected_full"]) == cov["not_inspected_count"]


# ---------------------------------------------------------------- retry / timeout

def test_context_destroyed_retry(tmp_path, monkeypatch):
    state = {"n": 0}
    async def snap(page, sel, **k):
        state["n"] += 1
        if state["n"] <= 2:
            raise RuntimeError("Page.evaluate: Execution context was destroyed")
        return {"url": page.url, "title": "ok", "elements": [], "text": "recovered"}
    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap)
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST), _ctx(tmp_path)))
    assert p["pages"][0]["title"] == "ok"  # 재시도 후 복구


def test_navigate_timeout_records_gap(tmp_path, monkeypatch):
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "t",
                "elements": [{"href": "/good", "input_type": ""},
                             {"href": "/bad", "input_type": ""}], "text": "x"}
    page = FakePage(fail_urls={ROOT + "/bad"})
    _install(monkeypatch, page, snap_fn=snap)
    tool = WebSiteSweepTool()
    # 예외 없이 완료되어야 함
    p = _payload(_run(tool, tool.input_model(domain=HOST, max_route_pages=5), _ctx(tmp_path)))
    bad = [pg for pg in p["pages"] if pg["url"] == ROOT + "/bad"]
    assert bad and "error" in bad[0]


# ---------------------------------------------------------------- scan hits / persist

def test_scan_hits_preserved(tmp_path, monkeypatch):
    # v3.70 placeholder 필터가 '...EXAMPLE' 키를 오탐으로 제외하므로, 비-placeholder
    # 형태의 AWS 키로 교체(스캔 hit 보존 자체를 검증하는 테스트라 값만 교정).
    secret_text = "config AWS key AKIA3MJ7QK2PLZ9WD4XR in page"
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "t", "elements": [], "text": secret_text}
    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap)
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST), _ctx(tmp_path)))
    hits = p["pages"][0]["scan_hits"]
    assert hits and any(h["category"] == "secret" for h in hits)
    ev = json.loads(Path(p["evidence_ref"]).read_text(encoding="utf-8"))
    assert ev["pages"][0]["scan_hits"] == hits  # inline == evidence 보존
    assert p["scan_hit_summary"]["total"] >= 1


def test_dynamic_response_hits_are_included_in_sweep_coverage(tmp_path, monkeypatch):
    secret = "AKIA3MJ7QK2PLZ9WD4XR"
    password = "passw0rd"
    api_key = "key12345"
    url_token = "url-token-value-12345"
    url_sig = "url-signature-value-67890"
    name = "Jane Doe"
    phone = "010-1234-5678"
    address = "129 Samsung-ro, Yeongtong-gu, Suwon-si, Gyeonggi-do"
    body = json.dumps({
        "token": secret,
        "password": password,
        "api_key": api_key,
        "name": name,
        "phone": phone,
        "address": address,
        "callback": f"https://user:pass@host.example/p?token={url_token}&sig={url_sig}",
    }).encode()

    class _Request:
        url = ROOT + "/api/session"
        method = "GET"
        resource_type = "fetch"

    class _Response:
        url = ROOT + "/api/session"
        status = 200
        request = _Request()

        def __init__(self):
            self.headers = {"content-type": "application/json", "content-length": str(len(body))}
            self.body_called = False

        async def body(self):
            self.body_called = True
            return body

    class DynamicPage(FakePage):
        def __init__(self):
            super().__init__()
            self.emitted = False
            self.response = None

        async def wait_for_load_state(self, *a, **k):
            if not self.emitted and self.url == ROOT:
                self.emitted = True
                self.response = _Response()
                await bt._capture_dynamic_response_body(self, self.response)
            return None

    async def snap(page, sel, **k):
        return {"url": page.url, "title": "t", "elements": [], "text": "plain shell"}

    bt._BROWSER_DYNAMIC_RESPONSE_EVENTS.clear()
    page = DynamicPage()
    _install(monkeypatch, page, snap_fn=snap)
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST), _ctx(tmp_path)))

    assert page.response is not None
    assert page.response.body_called is True
    serialized = json.dumps(p, ensure_ascii=False)
    assert secret not in serialized
    assert password not in serialized
    assert api_key not in serialized
    assert "user:pass@" not in serialized
    assert url_token not in serialized
    assert url_sig not in serialized
    assert name not in serialized
    assert phone not in serialized
    assert address not in serialized
    assert p["coverage"]["dynamic_responses_captured"] == 1
    assert p["dynamic_responses"][0]["url"].endswith("/api/session")
    assert any(
        h["kind"] == "aws_access_key_id"
        for h in p["dynamic_responses"][0]["scan_hits"]
    )
    assert p["scan_hit_summary"]["total"] >= 1
    ev = json.loads(Path(p["evidence_ref"]).read_text(encoding="utf-8"))
    assert ev["dynamic_responses"][0]["body_sample_masked"]
    assert secret not in json.dumps(ev, ensure_ascii=False)
    assert password not in json.dumps(ev, ensure_ascii=False)
    assert api_key not in json.dumps(ev, ensure_ascii=False)
    assert "user:pass@" not in json.dumps(ev, ensure_ascii=False)
    assert url_token not in json.dumps(ev, ensure_ascii=False)
    assert url_sig not in json.dumps(ev, ensure_ascii=False)
    assert name not in json.dumps(ev, ensure_ascii=False)
    assert phone not in json.dumps(ev, ensure_ascii=False)
    assert address not in json.dumps(ev, ensure_ascii=False)


def test_no_auto_persist(tmp_path, monkeypatch):
    from secu_agent import state
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "t", "elements": [], "text": "x"}
    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap)

    def _boom(*a, **k):
        raise AssertionError("web_target_set_status 호출되면 안 됨")
    monkeypatch.setattr(state, "web_target_set_status", _boom, raising=False)
    tool = WebSiteSweepTool()
    _run(tool, tool.input_model(domain=HOST), _ctx(tmp_path))  # 예외 없어야


# ---------------------------------------------------------------- target_id

def test_target_id_resolution_and_mismatch(tmp_path, monkeypatch):
    # de-domain: web_target_get 은 state_domain 로컬 함수 — 툴이 그걸 호출하므로 여기 patch.
    from service import state_domain as state
    monkeypatch.setattr(state, "web_target_get",
                        lambda tid: {"id": tid, "domain": HOST}, raising=False)
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "t", "elements": [], "text": "x"}
    page = FakePage()
    _install(monkeypatch, page, snap_fn=snap)
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(target_id=42), _ctx(tmp_path)))
    assert p["domain"] == HOST and p["target_id"] == 42
    # 불일치
    res = _run(tool, tool.input_model(target_id=42, domain="other.samsungds.net"),
               _ctx(tmp_path))
    from secu_agent.agent.tools.base import ToolError
    assert isinstance(res, ToolError)


def test_api_sampling_deepdive(tmp_path, monkeypatch):
    # js 에서 발견된 API URL + confirmed openapi → 코드가 GET 샘플
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "t", "elements": [
            {"href": "/api/users", "input_type": ""}], "text": "spa"}
    page = FakePage(html_by_url={ROOT: 'fetch("/api/orders")'})
    calls = {"probe_args": []}

    def _probe(urls, **k):
        calls["probe_args"].append(list(urls))
        # 표준 probe(첫 호출)엔 confirmed openapi 포함, api 샘플(둘째)엔 데이터
        if any("openapi" in u or "/api" in u for u in urls) and len(calls["probe_args"]) >= 2:
            return [{"url": urls[0], "semantic_status": "confirmed",
                     "semantic_type": "api_response", "sensitive_signals": ["email"],
                     "body_sample_masked": "user@samsung.com"}]
        return [{"url": ROOT + "/openapi.json", "semantic_status": "confirmed",
                 "semantic_type": "openapi_spec", "sensitive_signals": []}]
    _install(monkeypatch, page, snap_fn=snap)
    monkeypatch.setattr(wt, "_probe_web_resources", _probe)
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST, max_api_samples=5), _ctx(tmp_path)))
    # api_samples 가 별도 GET 으로 채워짐 (probe 가 2회 이상 호출됨)
    assert len(calls["probe_args"]) >= 2
    assert "api_samples" in p


def test_api_sampling_disabled(tmp_path, monkeypatch):
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "t", "elements": [], "text": "x"}
    page = FakePage()
    calls = {"n": 0}
    def _probe(urls, **k):
        calls["n"] += 1
        return []
    _install(monkeypatch, page, snap_fn=snap)
    monkeypatch.setattr(wt, "_probe_web_resources", _probe)
    tool = WebSiteSweepTool()
    _run(tool, tool.input_model(domain=HOST, max_api_samples=0), _ctx(tmp_path))
    assert calls["n"] == 1  # 표준 probe 만, api 샘플 안 함


def test_unreachable_root(tmp_path, monkeypatch):
    async def snap(page, sel, **k):
        return {"url": page.url, "title": "", "elements": [], "text": ""}
    page = FakePage(fail_urls={ROOT})
    _install(monkeypatch, page, snap_fn=snap)
    tool = WebSiteSweepTool()
    p = _payload(_run(tool, tool.input_model(domain=HOST), _ctx(tmp_path)))
    assert p["reachable"] is False
