"""v3.72: Confluence 고도화 — CQL/전사 enum/버전 히스토리/코멘트 + 고엔트로피 패리티.

httpx MockTransport 로 Confluence REST 를 모킹 (토큰/네트워크 불필요). github
agent_type enum 테스트(test_github_agent_type_enum.py)와 동일 패턴.
"""
from __future__ import annotations

import asyncio
import json
import os

import httpx
import pytest

from domains.services.confluence.plugin.agent_types import confluence as cf


@pytest.fixture
def tmp_db():
    from service.tests.db_setup import _ensure_test_db, _resolve_test_dsn, _truncate_all_managed
    from service import state_domain
    from secu_agent import state as core_state

    dsn = _resolve_test_dsn()
    _ensure_test_db(dsn)
    os.environ["SECU_AGENT_PG_DSN"] = dsn
    core_state._reset_pg_pool()
    state_domain._SCHEMA_READY = False
    with state_domain.connect() as c:
        _truncate_all_managed(c)
    yield


def _run_tool(tool, payload):
    from pathlib import Path

    from secu_agent.agent.tools.base import ToolContext
    return asyncio.run(tool.execute(
        tool.input_model(**payload), ToolContext(evidence_dir=Path(".")),
    ))


def _patch_client(monkeypatch, handler):
    def _factory():
        return httpx.Client(
            transport=httpx.MockTransport(handler),
            base_url="https://cf.test",
        )
    monkeypatch.setattr(cf, "_client", _factory)


# ---------------------------------------------------------------------------
# list_spaces — 전사 enum + 페이지네이션
# ---------------------------------------------------------------------------

def test_list_spaces_paginates(monkeypatch):
    pages = {
        0: [{"key": f"S{i}", "name": f"Space {i}", "type": "global",
             "_links": {"webui": f"/spaces/S{i}"}} for i in range(100)],
        100: [{"key": "LAST", "name": "Last", "type": "personal",
               "_links": {"webui": "/spaces/LAST"}}],
    }

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/rest/api/space"
        start = int(req.url.params.get("start", "0"))
        return httpx.Response(200, json={"results": pages.get(start, [])})

    _patch_client(monkeypatch, handler)
    spaces = cf.list_spaces(limit=500)
    assert len(spaces) == 101
    assert spaces[0].key == "S0"
    assert spaces[-1].key == "LAST"
    assert spaces[-1].type == "personal"


def test_list_spaces_passes_type_filter(monkeypatch):
    seen: dict = {}

    def handler(req):
        seen["type"] = req.url.params.get("type")
        return httpx.Response(200, json={"results": []})

    _patch_client(monkeypatch, handler)
    cf.list_spaces(space_type="global")
    assert seen["type"] == "global"


def test_list_spaces_http_error_raises(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/rest/api/space"
        return httpx.Response(503, json={"message": "space enum unavailable"})

    _patch_client(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="list_spaces.*HTTP 503"):
        cf.list_spaces(limit=100)


# ---------------------------------------------------------------------------
# cql_search — 전역 검색 (code_search analog)
# ---------------------------------------------------------------------------

def test_cql_search_maps_pages(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/rest/api/content/search"
        assert req.url.params.get("cql") == 'text ~ "password"'
        start = int(req.url.params.get("start", "0"))
        if start:
            return httpx.Response(200, json={"results": []})
        return httpx.Response(200, json={"results": [
            {"id": 123, "title": "Onboarding", "type": "page",
             "version": {"number": 4}, "space": {"key": "SEC"},
             "_links": {"webui": "/display/SEC/Onboarding"}},
        ]})

    _patch_client(monkeypatch, handler)
    pages = cf.cql_search('text ~ "password"', limit=50)
    assert len(pages) == 1
    assert pages[0].id == "123"
    assert pages[0].space_key == "SEC"
    assert pages[0].version == 4


def test_cql_search_http_error_raises(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/rest/api/content/search"
        return httpx.Response(500, json={"message": "search backend down"})

    _patch_client(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="cql_search.*HTTP 500"):
        cf.cql_search('text ~ "password"', limit=50)


def test_list_blogposts_fetches_bounded_blogpost_candidates(monkeypatch):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url))
        assert req.url.path == "/rest/api/content"
        assert req.url.params.get("spaceKey") == "SEC"
        assert req.url.params.get("type") == "blogpost"
        assert req.url.params.get("limit") == "2"
        assert req.url.params.get("expand") == "version"
        return httpx.Response(200, json={"results": [
            {
                "id": "9001",
                "title": "Weekly deploy note",
                "version": {"number": 3},
                "_links": {"webui": "/spaces/SEC/blog/2026/07/02/Weekly+deploy+note"},
            },
        ]})

    _patch_client(monkeypatch, handler)
    pages = cf.list_blogposts("SEC", limit=2)
    assert len(calls) == 1
    assert len(pages) == 1
    assert pages[0].id == "9001"
    assert pages[0].title == "Weekly deploy note"
    assert pages[0].space_key == "SEC"
    assert pages[0].version == 3


def test_list_pages_http_error_raises(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/rest/api/content"
        return httpx.Response(403, json={"message": "denied"})

    _patch_client(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="list_pages.*HTTP 403"):
        cf.list_pages("SEC", limit=50)


# ---------------------------------------------------------------------------
# detail fetch HTTP failures — 404 is missing, 403/5xx is scan error
# ---------------------------------------------------------------------------

def test_fetch_page_body_404_returns_none(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/rest/api/content/missing"
        return httpx.Response(404, json={"message": "not found"})

    _patch_client(monkeypatch, handler)
    assert cf.fetch_page_body("missing") is None


def test_fetch_page_body_http_error_raises(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/rest/api/content/403"
        return httpx.Response(403, json={"message": "denied"})

    _patch_client(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="fetch_page_body.*HTTP 403"):
        cf.fetch_page_body("403")


def test_list_attachments_http_error_raises(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/rest/api/content/777/child/attachment"
        return httpx.Response(500, json={"message": "backend down"})

    _patch_client(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="list_attachments.*HTTP 500"):
        cf.list_attachments("777")


def test_fetch_attachment_text_http_error_raises(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/download/a1"
        return httpx.Response(502, content=b"bad gateway")

    _patch_client(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="fetch_attachment_text.*HTTP 502"):
        cf.fetch_attachment_text("/download/a1")


# ---------------------------------------------------------------------------
# list_page_versions / fetch_page_body_version — 히스토리 (git history analog)
# ---------------------------------------------------------------------------

def test_list_page_versions_sorted_desc(monkeypatch):
    def handler(req):
        assert req.url.path == "/rest/api/content/777/version"
        return httpx.Response(200, json={"results": [
            {"number": 3}, {"number": 5}, {"number": 1}, {"foo": "bar"},
        ]})

    _patch_client(monkeypatch, handler)
    assert cf.list_page_versions("777") == [5, 3, 1]


def test_list_page_versions_http_error_raises(monkeypatch):
    def handler(req):
        assert req.url.path == "/rest/api/content/777/version"
        return httpx.Response(500, json={"message": "version API down"})

    _patch_client(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="list_page_versions.*HTTP 500"):
        cf.list_page_versions("777")


def test_fetch_page_body_version_historical(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/rest/api/content/777"
        assert req.url.params.get("version") == "2"
        return httpx.Response(200, json={
            "body": {"storage": {"value": "old secret AKIAABCDEFGHIJKLMNOP"}},
        })

    _patch_client(monkeypatch, handler)
    body = cf.fetch_page_body_version("777", 2)
    assert body == "old secret AKIAABCDEFGHIJKLMNOP"


def test_fetch_page_body_version_falls_back_when_historical_404(monkeypatch):
    calls: list[str | None] = []

    def handler(req):
        status = req.url.params.get("status")
        calls.append(status)
        if status == "historical":
            return httpx.Response(404, json={})
        return httpx.Response(200, json={"body": {"storage": {"value": "fallback body"}}})

    _patch_client(monkeypatch, handler)
    assert cf.fetch_page_body_version("777", 2) == "fallback body"
    assert calls == ["historical", None]


def test_fetch_page_body_version_http_error_raises(monkeypatch):
    calls: list[str | None] = []

    def handler(req):
        status = req.url.params.get("status")
        calls.append(status)
        return httpx.Response(500, json={"message": "historical API down"})

    _patch_client(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="fetch_page_body_version.*HTTP 500"):
        cf.fetch_page_body_version("777", 2)
    assert calls == ["historical"]


# ---------------------------------------------------------------------------
# list_comments — 코멘트 유출 경로
# ---------------------------------------------------------------------------

def test_list_comments_extracts_storage_bodies(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/rest/api/content/555/child/comment"
        return httpx.Response(200, json={"results": [
            {"body": {"storage": {"value": "db pw is agent_type2agent_type2"}}},
            {"body": {"storage": {"value": ""}}},         # 빈 detail 보존
            {"body": {}},                                 # 본문 없음도 누락 detail 로 보존
        ]})

    _patch_client(monkeypatch, handler)
    comments = cf.list_comments("555")
    assert comments == ["db pw is agent_type2agent_type2", "", ""]


def test_list_comments_http_error_raises(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/rest/api/content/555/child/comment"
        return httpx.Response(403, json={"message": "denied"})

    _patch_client(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="list_comments.*HTTP 403"):
        cf.list_comments("555")


# ---------------------------------------------------------------------------
# S2: 저수준 디스커버리 도구
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# S3: confluence_task_scan 고도화 — cql / all_spaces / comments / history /
#     고엔트로피 opt-in
# ---------------------------------------------------------------------------

from pathlib import Path  # noqa: E402

from secu_agent.agent.tools.base import ToolContext, ToolSuccess  # noqa: E402

# 키워드 없는(변수명 평범) 고엔트로피 토큰 — find_secrets 는 못 잡고
# find_high_entropy 만 잡는다.
_HE_TOKEN = "Zk7Qv9XbLm3Rt8Wp2Yc6Nf1Hs4Jd0Ae5Gu"


def _scan(payload, tmp_path, monkeypatch, metadata=None):
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool
    md = {} if metadata is None else metadata
    res = asyncio.run(ConfluenceTaskScanTool().execute(
        ConfluenceTaskScanTool.input_model(**payload),
        ToolContext(evidence_dir=tmp_path, metadata=md),
    ))
    return res, md


def _http_status_error(status_code: int, path: str) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", f"https://cf.test{path}")
    response = httpx.Response(
        status_code,
        request=request,
        json={"message": "simulated"},
    )
    return httpx.HTTPStatusError(
        f"{status_code} simulated",
        request=request,
        response=response,
    )


def test_confluence_default_search_terms_cover_sensitive_document_categories() -> None:
    from domains.services.plugin.tools import service_task_tools as sht

    terms = {term.lower() for term in sht._DEFAULT_CONFLUENCE_CQL_TERMS}

    assert {"password", "token", "kubeconfig"} <= terms
    assert {"개인정보", "인사정보", "employee", "payroll"} <= terms
    assert {"경영진", "임원회의", "사업계획", "revenue forecast"} <= terms
    assert {"process recipe", "recipe", "yield", "wafer", "공정", "설비"} <= terms


def test_confluence_scan_includes_document_sensitivity_signals(tmp_db, tmp_path, monkeypatch):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from secu_agent import state as core_state

    pages = [
        CfPage(id="p1", title="Process Recipe Yield Review", space_key="FAB", version=1, url="/p1"),
        CfPage(id="p2", title="Executive Meeting Revenue Forecast", space_key="BIZ", version=1, url="/p2"),
    ]
    bodies = {
        "p1": (
            "대외비 공정 조건 자료입니다. recipe id, wafer id, lot id, "
            "yield loss, defect density, etch rate, thickness, SPC/FDC review."
        ),
        "p2": (
            "Confidential executive meeting minutes. revenue forecast, gross margin, "
            "pricing strategy, customer pipeline, contract value, budget plan."
        ),
    }

    monkeypatch.setattr(sht.cf, "list_pages", lambda space_key, limit=50: [
        page for page in pages if page.space_key == space_key
    ])
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda pid: bodies[pid])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda pid: [])
    monkeypatch.setattr(sht.cf, "list_comments", lambda pid, **k: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda pid, **k: [])

    res, _ = _scan(
        {
            "space_keys": ["FAB", "BIZ"],
            "api_search_first": False,
            "scan_comments": False,
            "scan_history": False,
            "high_entropy": False,
        },
        tmp_path,
        monkeypatch,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    categories = payload["api_search"]["scan_summary"]["hit_category_counts"]
    assert categories["semiconductor_process"] >= 1
    assert categories["business_confidential"] >= 1
    rows = core_state.finding_list(task_type="confluence", limit=10)
    assert {row["severity"] for row in rows} == {"high"}
    assert {row["extra"]["agent_verification"]["status"] for row in rows} == {"verified"}
    assert {
        row["extra"]["agent_verification"]["method"] for row in rows
    } == {"confluence_service_task_scan"}


def test_task_scan_high_entropy_opt_in(tmp_db, tmp_path, monkeypatch):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfPage

    monkeypatch.setattr(sht.cf, "list_pages", lambda space_key, limit=50: [
        CfPage(id="1", title="Plain", space_key=space_key, version=1, url="/x"),
    ])
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda pid: f"value = {_HE_TOKEN}")
    monkeypatch.setattr(sht.cf, "list_attachments", lambda pid: [])
    monkeypatch.setattr(sht.cf, "list_comments", lambda pid, **k: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda pid, **k: [])

    res, _ = _scan({"space_keys": ["SEC"], "api_search_first": False}, tmp_path, monkeypatch)
    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    # high_entropy off 면 안 잡힘
    res2, _ = _scan(
        {"space_keys": ["SEC"], "high_entropy": False, "api_search_first": False},
        tmp_path,
        monkeypatch,
    )
    assert json.loads(res2.content)["finding_count"] == 0


def test_github_task_scan_high_entropy_enabled_for_api_artifacts(tmp_db, tmp_path, monkeypatch):
    """GitHub fetched API artifacts include high-entropy-only candidates."""
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhRepo
    from secu_agent import state as core_state

    entropy_token = "N7Q9pL4xK2mV8rS5tY3uI6oP0aD1fG2hJ4kL9zX8cV7bN6mQ5wE3rT2yU1iO0pA9sD8fG7hJ6kL5zX4cV3bN2mQ1"
    monkeypatch.setattr(sht.gh, "list_repos", lambda org, limit=20: [
        GhRepo(
            full_name="fab/prod-yield-recipe",
            default_branch="main",
            private=False,
            archived=False,
            pushed_at="2026-01-01T00:00:00Z",
            visibility="internal",
            size_kb=2048,
        ),
    ])
    monkeypatch.setattr(sht.gh, "list_paths_matching", lambda repo, ref, hot_paths: [
        GhBlobRef(repo=repo, ref=ref, path="config/prod.env", sha="s", size=40),
    ])
    monkeypatch.setattr(sht.gh, "fetch_blob_text", lambda repo, sha: f"value = {entropy_token}")
    monkeypatch.setattr(sht.gh, "recent_commit_patches", lambda repo, limit=3, since_sha=None: [])

    res = asyncio.run(GithubTaskScanTool().execute(
        GithubTaskScanTool.input_model(org="o", api_search_first=False),
        ToolContext(evidence_dir=tmp_path, metadata={}),
    ))
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["scan_summary"]["hit_kind_counts"] == {
        "high_entropy_string": 1,
    }
    # ★ github 스캔은 등록하지 않는다 — 후보만 돌려준다(2026-08-27, LLM 판정 필수).
    assert core_state.finding_list(task_type="github", limit=1) == [], "스캔이 등록했다"
    row = payload["findings"][0]
    metadata = row["metadata"]
    assert metadata["repo_context"]["repo"] == "fab/prod-yield-recipe"
    assert metadata["repo_context"]["visibility"] == "internal"
    assert metadata["repo_context"]["size_kb"] == 2048
    assert metadata["system_importance"]["level"] == "high"
    assert "production" in metadata["system_importance"]["signals"]
    assert "manufacturing_process" in metadata["system_importance"]["signals"]
    # ⚠️ 후보는 스스로를 "검증됨" 이라 말하지 않는다 — 그 도장은 에이전트가
    #    github_submit_finding 을 부를 때 찍힌다.
    assert "agent_verification" not in row
    assert row["registered"] is False and row["status"] == "candidate"


def test_task_scan_cql_mode_seeds_targets(tmp_db, tmp_path, monkeypatch):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfPage

    monkeypatch.setattr(sht.cf, "cql_search", lambda cql, limit=100: [
        CfPage(id="42", title="Hit", space_key="OPS", version=2, url="/x"),
    ])
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda pid: "AKIAABCDEFGHIJKLMNOP exposed")
    monkeypatch.setattr(sht.cf, "list_attachments", lambda pid: [])
    monkeypatch.setattr(sht.cf, "list_comments", lambda pid, **k: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda pid, **k: [])

    res, _ = _scan({"cql": 'text ~ "AKIA"'}, tmp_path, monkeypatch)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    # v3.76: cql_search 가 space_key(OPS) 를 채우므로 asset 에 SPACE prefix.
    assert payload["findings"][0]["asset"] == "confluence:OPS:42"


def test_task_scan_label_cql_fetches_only_search_candidates(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from secu_agent import state

    query = 'space = "SECOPS" AND label = "prod-secrets"'
    token = "AKIA" + ("C" * 16)
    cql_calls: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100):
        cql_calls.append((cql, limit))
        return [
            CfPage(
                id="777",
                title="Prod Secrets",
                space_key="SECOPS",
                version=3,
                url="/display/SECOPS/Prod+Secrets",
            ),
        ]

    def fetch_page_body(page_id: str):
        fetch_calls.append(page_id)
        return f"aws_access_key_id={token}"

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("label CQL scan must not fall back to list_pages"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res, _ = _scan(
        {
            "cql": query,
            "api_search_first": True,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        monkeypatch,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 1
    assert payload["findings"][0]["asset"] == "confluence:SECOPS:777"
    assert payload["findings"][0]["candidate_source"] == "explicit_cql"
    assert payload["findings"][0]["scan_method"] == "api_cql_search_detail_scan"
    assert cql_calls == [(query, 25)]
    assert fetch_calls == ["777"]

    api = payload["api_search"]
    assert api["queries"] == [query]
    assert api["query_count"] == 1
    assert api["query_details"] == [{
        "query": query,
        "source": "explicit_cql",
        "space_key": "",
        "status": "searched",
        "returned": 1,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert api["fallback_list_pages"] == 0
    assert api["fallback_attempts"] == []
    assert api["page_list_attempts"] == []
    assert api["detail_source_counts"] == {"explicit_cql": 1}
    assert api["detail_query_counts"] == {query: 1}
    assert api["detail_status_by_query"] == {query: {"fetched": 1}}

    rows = state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "confluence:SECOPS:777"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == [{
        "page_id": "777",
        "space_key": "SECOPS",
        "title": "Prod Secrets",
        "url": "/display/SECOPS/Prod+Secrets",
        "version": 3,
        "candidate_source": "explicit_cql",
        "candidate_query": query,
        "scan_method": "api_cql_search_detail_scan",
        "status": "fetched",
        "body_present": True,
    }]
    assert evidence["artifacts"][0]["metadata"]["candidate_source"] == "explicit_cql"
    assert evidence["artifacts"][0]["metadata"]["candidate_query"] == query


def test_task_scan_label_cql_preserves_candidate_limit_skips(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from secu_agent import state

    query = 'space = "SECOPS" AND label = "prod-secrets"'
    token = "AKIA" + ("D" * 16)
    cql_calls: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100):
        cql_calls.append((cql, limit))
        return [
            CfPage(
                id="777",
                title="Prod Secrets",
                space_key="SECOPS",
                version=3,
                url="/display/SECOPS/Prod+Secrets",
            ),
            CfPage(
                id="778",
                title="Overflow Secrets",
                space_key="SECOPS",
                version=1,
                url="/display/SECOPS/Overflow+Secrets",
            ),
        ]

    def fetch_page_body(page_id: str):
        fetch_calls.append(page_id)
        if page_id != "777":
            raise AssertionError("CQL candidate beyond max_pages must not be fetched")
        return f"aws_access_key_id={token}"

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("label CQL limit scan must not fall back to list_pages"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res, _ = _scan(
        {
            "cql": query,
            "api_search_first": True,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
            "max_pages": 1,
        },
        tmp_path,
        monkeypatch,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["query_details"] == [{
        "query": query,
        "source": "explicit_cql",
        "space_key": "",
        "status": "searched",
        "returned": 2,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"explicit_cql": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_cql": {"skipped": 1, "fetched": 1},
    }
    assert cql_calls == [(query, 2)]
    assert fetch_calls == ["777"]

    rows = state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "confluence:SECOPS:777"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == [
        {
            "page_id": "778",
            "space_key": "SECOPS",
            "title": "Overflow Secrets",
            "url": "/display/SECOPS/Overflow+Secrets",
            "version": 1,
            "candidate_source": "explicit_cql",
            "candidate_query": query,
            "scan_method": "api_cql_search_detail_scan",
            "status": "skipped",
            "error": "Confluence CQL candidate beyond max_pages",
        },
        {
            "page_id": "777",
            "space_key": "SECOPS",
            "title": "Prod Secrets",
            "url": "/display/SECOPS/Prod+Secrets",
            "version": 3,
            "candidate_source": "explicit_cql",
            "candidate_query": query,
            "scan_method": "api_cql_search_detail_scan",
            "status": "fetched",
            "body_present": True,
        },
    ]


def test_task_scan_label_cql_search_failure_does_not_list_pages(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state

    query = 'space = "SECOPS" AND label = "prod-secrets"'
    metadata: dict = {}

    def cql_403(cql: str, *, limit: int = 100):
        assert cql == query
        assert limit == 25
        raise RuntimeError("Confluence cql_search failed: HTTP 403")

    monkeypatch.setattr(sht.cf, "cql_search", cql_403)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("label CQL search failure must not fall back to list_pages"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must wait for CQL candidates"),
        ),
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res, _ = _scan(
        {
            "cql": query,
            "api_search_first": True,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        monkeypatch,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "HTTP 403" in payload["status_reason"]
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "cql_search"
    assert payload["api_search"]["query_details"][0]["status"] == "error"
    assert payload["api_search"]["query_details"][0]["query"] == query
    assert metadata["_confluence_task_scan_recommended_status"] == "skipped"
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_task_scan_blogpost_list_uses_bounded_blogpost_details(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from secu_agent import state

    token = "AKIA" + ("B" * 16)
    list_calls: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blog-list scan must not run CQL search"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blog-list scan must not list normal pages"),
        ),
    )

    def list_blogposts(space_key: str, *, limit: int = 50):
        list_calls.append((space_key, limit))
        return [
            CfPage(
                id="91",
                title="Deploy Secrets",
                space_key=space_key,
                version=4,
                url="/spaces/SEC/blog/2026/7/2/Deploy+Secrets",
            ),
            CfPage(
                id="92",
                title="Empty Note",
                space_key=space_key,
                version=1,
                url="/spaces/SEC/blog/2026/7/2/Empty+Note",
            ),
        ]

    def fetch_page_body(page_id: str):
        fetch_calls.append(page_id)
        if page_id == "91":
            return f"aws_access_key_id={token}"
        return ""

    monkeypatch.setattr(sht.cf, "list_blogposts", list_blogposts)
    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res, _ = _scan(
        {
            "space_keys": ["SEC"],
            "api_search_first": True,
            "include_blogposts": True,
            "page_limit_per_space": 2,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        monkeypatch,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 2
    assert payload["finding_count"] == 1
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["page_list_attempts"] == []
    assert payload["api_search"]["blogpost_list_count"] == 2
    assert payload["api_search"]["blogpost_list_attempts"] == [{
        "space_key": "SEC",
        "source": "space_blogpost_list",
        "reason": "explicit_blogpost_list",
        "returned": 2,
        "added": 2,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"space_blogpost_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_blogpost_list": {"fetched": 1, "empty": 1},
    }
    assert list_calls == [("SEC", 2)]
    assert fetch_calls == ["91", "92"]

    rows = state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "confluence:SEC:91"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == [
        {
            "page_id": "91",
            "space_key": "SEC",
            "title": "Deploy Secrets",
            "url": "/spaces/SEC/blog/2026/7/2/Deploy+Secrets",
            "version": 4,
            "candidate_source": "space_blogpost_list",
            "candidate_query": "",
            "scan_method": "api_blogpost_list_detail_scan",
            "status": "fetched",
            "body_present": True,
        },
        {
            "page_id": "92",
            "space_key": "SEC",
            "title": "Empty Note",
            "url": "/spaces/SEC/blog/2026/7/2/Empty+Note",
            "version": 1,
            "candidate_source": "space_blogpost_list",
            "candidate_query": "",
            "scan_method": "api_blogpost_list_detail_scan",
            "status": "empty",
            "body_present": False,
        },
    ]
    assert evidence["artifacts"][0]["metadata"]["scan_method"] == "api_blogpost_list_detail_scan"
    assert evidence["artifacts"][0]["metadata"]["candidate_source"] == "space_blogpost_list"


def test_task_scan_blogpost_list_skips_out_of_scope_before_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from secu_agent import state

    token = "AKIA" + ("C" * 16)
    fetch_calls: list[str] = []

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blog-list scope gate must not broaden to CQL search"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blog-list scope gate must not list normal pages"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_blogposts",
        lambda space_key, *, limit=50: [
            CfPage(
                id="foreign-99",
                title="Secrets Foreign",
                space_key="OTHER",
                version=9,
                url="/spaces/OTHER/blog/2026/7/2/Secrets+Foreign",
            ),
            CfPage(
                id="91",
                title="Deploy Secrets",
                space_key=space_key,
                version=4,
                url="/spaces/SEC/blog/2026/7/2/Deploy+Secrets",
            ),
        ],
    )

    def fetch_page_body(page_id: str):
        fetch_calls.append(page_id)
        if page_id != "91":
            raise AssertionError("out-of-scope blogpost must not be fetched")
        return f"aws_access_key_id={token}"

    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res, _ = _scan(
        {
            "space_keys": ["SEC"],
            "api_search_first": True,
            "include_blogposts": True,
            "page_limit_per_space": 2,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        monkeypatch,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["blogpost_list_count"] == 1
    assert payload["api_search"]["blogpost_list_attempts"] == [{
        "space_key": "SEC",
        "source": "space_blogpost_list",
        "reason": "explicit_blogpost_list",
        "returned": 2,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 1,
        "duplicate": 0,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"space_blogpost_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_blogpost_list": {"skipped": 1, "fetched": 1},
    }
    assert fetch_calls == ["91"]

    rows = state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "confluence:SEC:91"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == [
        {
            "page_id": "foreign-99",
            "space_key": "OTHER",
            "target_space_key": "SEC",
            "title": "Secrets Foreign",
            "url": "/spaces/OTHER/blog/2026/7/2/Secrets+Foreign",
            "version": 9,
            "candidate_source": "space_blogpost_list",
            "candidate_query": "",
            "scan_method": "api_blogpost_list_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "91",
            "space_key": "SEC",
            "title": "Deploy Secrets",
            "url": "/spaces/SEC/blog/2026/7/2/Deploy+Secrets",
            "version": 4,
            "candidate_source": "space_blogpost_list",
            "candidate_query": "",
            "scan_method": "api_blogpost_list_detail_scan",
            "status": "fetched",
            "body_present": True,
        },
    ]
    assert evidence["artifacts"][0]["metadata"]["candidate_source"] == "space_blogpost_list"


def test_task_scan_space_cql_404_is_skipped_without_list_pages_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state

    metadata: dict = {}

    def cql_404(cql: str, *, limit: int = 100):
        raise RuntimeError("Confluence cql_search failed: HTTP 404")

    monkeypatch.setattr(sht.cf, "cql_search", cql_404)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("list_pages fallback must not run after CQL target 404"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must wait for CQL candidates"),
        ),
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res, _ = _scan(
        {"space_keys": ["SEC"], "api_search_first": True},
        tmp_path,
        monkeypatch,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "HTTP 404" in payload["status_reason"]
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "cql_search"
    assert metadata["_confluence_task_scan_recommended_status"] == "skipped"
    assert "HTTP 404" in metadata["_confluence_task_scan_status_reason"]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_task_scan_explicit_page_404_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state

    metadata: dict = {}

    def page_404(page_id: str):
        raise RuntimeError("Confluence fetch_page_body failed: HTTP 404")

    monkeypatch.setattr(sht.cf, "fetch_page_body", page_404)
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("comments must wait for page body readability"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("history must wait for page body readability"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachments must wait for page body readability"),
        ),
    )

    res, _ = _scan({"page_ids": ["missing-page"]}, tmp_path, monkeypatch, metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "HTTP 404" in payload["status_reason"]
    assert payload["api_search"]["errors"] == []
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_page_body"
    assert metadata["_confluence_task_scan_recommended_status"] == "skipped"
    assert "HTTP 404" in metadata["_confluence_task_scan_status_reason"]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_task_scan_cql_candidate_detail_missing_is_error(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from secu_agent import state

    metadata: dict = {}
    monkeypatch.setattr(sht.cf, "cql_search", lambda cql, limit=100: [
        CfPage(id="gone", title="Credential", space_key="SEC", version=1, url="/x"),
    ])
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: None)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res, _ = _scan(
        {
            "cql": 'space = "SEC" AND text ~ "password"',
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        monkeypatch,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 1
    assert metadata["_confluence_task_scan_recommended_status"] == "error"
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_task_scan_subresource_detail_http_errors_keep_status_codes(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment, CfPage

    monkeypatch.setattr(sht.cf, "list_pages", lambda space_key, limit=50: [
        CfPage(id="7", title="Credential", space_key=space_key, version=3, url="/x"),
    ])
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "clean page")
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda page_id: (_ for _ in ()).throw(_http_status_error(403, f"/page/{page_id}/comment")),
    )
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda page_id: [2])
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body_version",
        lambda page_id, version: (_ for _ in ()).throw(
            _http_status_error(504, f"/page/{page_id}/version/{version}"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="att-1",
                filename="creds.env",
                media_type="text/plain",
                size=80,
                download_url="/download/att-1",
                parent_page_id=page_id,
            ),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_attachment_text",
        lambda download_url: (_ for _ in ()).throw(
            _http_status_error(502, download_url),
        ),
    )

    res, _ = _scan(
        {"space_keys": ["SEC"], "api_search_first": False, "scan_history": True},
        tmp_path,
        monkeypatch,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    detail_errors = {
        err["phase"]: err for err in payload["api_search"]["detail_errors"]
    }
    assert detail_errors["list_comments"]["status_code"] == 403
    assert detail_errors["fetch_page_body_version"]["status_code"] == 504
    assert detail_errors["fetch_attachment_text"]["status_code"] == 502


def test_task_scan_subresource_listing_http_errors_keep_status_codes(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfPage

    monkeypatch.setattr(sht.cf, "list_pages", lambda space_key, limit=50: [
        CfPage(id="8", title="Credential", space_key=space_key, version=3, url="/x"),
    ])
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "clean page")
    monkeypatch.setattr(sht.cf, "list_comments", lambda page_id: [])
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda page_id: (_ for _ in ()).throw(
            _http_status_error(500, f"/page/{page_id}/version"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: (_ for _ in ()).throw(
            _http_status_error(429, f"/page/{page_id}/attachment"),
        ),
    )

    res, _ = _scan(
        {"space_keys": ["SEC"], "api_search_first": False, "scan_history": True},
        tmp_path,
        monkeypatch,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    detail_errors = {
        err["phase"]: err for err in payload["api_search"]["detail_errors"]
    }
    assert detail_errors["list_page_versions"]["status_code"] == 500
    assert detail_errors["list_attachments"]["status_code"] == 429


def test_task_scan_all_spaces_no_space_key_required(tmp_db, tmp_path, monkeypatch):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfPage, CfSpace

    monkeypatch.setattr(sht.cf, "list_spaces", lambda **k: [
        CfSpace(key="SEC", name="Security", type="global", url="/s"),
    ])
    monkeypatch.setattr(sht.cf, "list_pages", lambda space_key, limit=50: [
        CfPage(id="7", title="Creds", space_key=space_key, version=1, url="/x"),
    ])
    monkeypatch.setattr(sht.cf, "fetch_page_body",
                        lambda pid: "password = SuperSecretValue123")
    monkeypatch.setattr(sht.cf, "list_attachments", lambda pid: [])
    monkeypatch.setattr(sht.cf, "list_comments", lambda pid, **k: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda pid, **k: [])

    res, _ = _scan({"all_spaces": True, "api_search_first": False}, tmp_path, monkeypatch)
    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 1


def test_task_scan_validation_requires_a_mode(tmp_db, tmp_path, monkeypatch):
    from secu_agent.agent.tools.base import ToolError
    res, _ = _scan({}, tmp_path, monkeypatch)
    assert isinstance(res, ToolError)
    assert res.kind == "validation"


def test_task_scan_comments_scanned(tmp_db, tmp_path, monkeypatch):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfPage

    monkeypatch.setattr(sht.cf, "list_pages", lambda space_key, limit=50: [
        CfPage(id="3", title="Doc", space_key=space_key, version=1, url="/x"),
    ])
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda pid: "clean page")
    monkeypatch.setattr(sht.cf, "list_attachments", lambda pid: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda pid, **k: [])
    monkeypatch.setattr(sht.cf, "list_comments",
                        lambda pid, **k: ["db url postgres://u:p4ssw0rdLong@h/db"])

    res, _ = _scan(
        {"space_keys": ["SEC"], "high_entropy": False, "api_search_first": False},
        tmp_path,
        monkeypatch,
    )
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["findings"][0]["asset_kind"] == "comment"
    assert payload["api_search"]["detail_fetched"] == 2


def test_task_scan_history_dedups_unchanged_body(tmp_db, tmp_path, monkeypatch):
    from domains.services.plugin.tools import service_task_tools as sht
    from domains.services.confluence.plugin.agent_types.confluence import CfPage

    secret_body = "old AKIAABCDEFGHIJKLMNOP here"
    monkeypatch.setattr(sht.cf, "list_pages", lambda space_key, limit=50: [
        CfPage(id="5", title="Doc", space_key=space_key, version=3, url="/x"),
    ])
    # 현재 본문엔 시크릿 없음, 옛 버전(v2)에만 있음. v1 은 현재와 동일 → dedup.
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda pid: "clean now")
    monkeypatch.setattr(sht.cf, "list_attachments", lambda pid: [])
    monkeypatch.setattr(sht.cf, "list_comments", lambda pid, **k: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda pid, **k: [3, 2, 1])

    def _ver_body(pid, ver):
        if ver == 2:
            return secret_body
        return "clean now"  # v1 == 현재 본문 → 스캔 안 함

    monkeypatch.setattr(sht.cf, "fetch_page_body_version", _ver_body)

    res, _ = _scan(
        {
            "space_keys": ["SEC"],
            "scan_history": True,
            "high_entropy": False,
            "api_search_first": False,
        },
        tmp_path, monkeypatch,
    )
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    f = payload["findings"][0]
    assert f["asset_kind"] == "page_version"
    # v3.76: space_key(SEC) 있으므로 asset 에 SPACE prefix.
    assert f["asset"] == "confluence:SEC:5/version/2"
    assert payload["api_search"]["detail_fetched"] == 2
