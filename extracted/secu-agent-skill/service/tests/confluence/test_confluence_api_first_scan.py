from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx

from secu_agent.agent.tools.base import ToolContext, ToolSuccess


def _run(payload: dict[str, Any], tmp_path: Path, metadata: dict[str, Any] | None = None):
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    md = {} if metadata is None else metadata
    return asyncio.run(ConfluenceTaskScanTool().execute(
        ConfluenceTaskScanTool.input_model(**payload),
        ToolContext(evidence_dir=tmp_path, metadata=md),
    ))


def test_confluence_space_scan_uses_cql_before_single_page_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("A" * 36)
    queries: list[str] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append(cql)
        return [CfPage(id="42", title="Runbook", space_key="OPS", version=7, url="/display/OPS/R")]

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("list_pages fallback must not run")),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: fetch_calls.append(page_id) or f"GITHUB_TOKEN={token}\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password", "token"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata={"charter_ref": "SECOPS-CONFLUENCE-SCAN"})

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["charter_ref"] == "SECOPS-CONFLUENCE-SCAN"
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert fetch_calls == ["42"]
    assert 'space = "OPS" AND type = page AND text ~ "password"' in queries
    assert payload["api_search"]["candidate_count"] == 1
    scan_summary = payload["api_search"]["scan_summary"]
    assert scan_summary["artifact_count"] == 1
    assert scan_summary["artifact_source_counts"] == {"space_cql": 1}
    assert scan_summary["hit_artifact_count"] == 1
    assert scan_summary["hit_source_counts"] == {"space_cql": 1}
    assert scan_summary["hit_category_counts"]["secret"] >= 1
    assert scan_summary["reportable_artifact_count"] == 1
    assert scan_summary["reportable_source_counts"] == {"space_cql": 1}
    assert scan_summary["low_value_only_artifact_count"] == 0

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:OPS:42"
    assert row["extra"]["metadata"]["candidate_source"] == "space_cql"
    assert row["extra"]["metadata"]["scan_method"] == "api_cql_search_detail_scan"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["charter_ref"] == "SECOPS-CONFLUENCE-SCAN"
    assert evidence["api_search"]["scan_summary"] == scan_summary


def test_confluence_space_batch_records_per_space_statuses(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht

    class SecCqlFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    token = "ghp_" + ("M" * 36)
    metadata: dict[str, Any] = {"charter_ref": "SECOPS-CONFLUENCE-BATCH"}
    queries: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append(cql)
        if 'space = "SEC"' in cql:
            raise SecCqlFailure("Confluence CQL HTTP 503")
        if 'space = "OPS"' in cql and 'text ~ "password"' in cql:
            return [CfPage(id="42", title="Runbook", space_key="OPS", version=7, url="/display/OPS/R")]
        return []

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("per-space CQL failure must not broaden to page-list fallback"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: f"GITHUB_TOKEN={token}\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS", "SEC"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata=metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert len([q for q in queries if 'space = "SEC"' in q]) == 2
    assert payload["api_search"]["space_target_statuses"]["OPS"] == {
        "status": "tasked",
        "finding_count": 1,
        "reason": "space scan completed; findings=1",
    }
    sec_status = payload["api_search"]["space_target_statuses"]["SEC"]
    assert sec_status["status"] == "error"
    assert sec_status["finding_count"] == 0
    assert "Confluence CQL HTTP 503" in sec_status["reason"]
    assert metadata["_confluence_task_scan_space_statuses"] == (
        payload["api_search"]["space_target_statuses"]
    )
    assert payload["api_search"]["errors"][0]["space_key"] == "SEC"
    assert payload["api_search"]["target_status_by_source"]["space_cql"]["error"] == 2


def test_confluence_blogpost_cql_seeds_detail_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("B" * 36)
    queries: list[str] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append(cql)
        return [
            CfPage(
                id="77",
                title="Deploy Secrets",
                space_key="OPS",
                version=3,
                url="/display/OPS/2026/07/01/Deploy+Secrets",
            ),
        ]

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blogpost cql must not use list_pages fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda page_id: fetch_calls.append(page_id) or f"GITHUB_TOKEN={token}\n",
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    query = 'space = "OPS" AND type = blogpost AND title ~ "Deploy Secrets"'
    res = _run({
        "cql": query,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert queries == [query]
    assert fetch_calls == ["77"]
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["pages"] == ["77"]
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["candidate_sources"] == {"explicit_cql": 1}
    assert payload["api_search"]["fallback_list_pages"] == 0

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"][0]["candidate_source"] == "explicit_cql"
    assert evidence["page_details"][0]["candidate_query"] == query
    assert evidence["page_details"][0]["scan_method"] == "api_cql_search_detail_scan"

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:OPS:77"
    assert row["extra"]["metadata"]["candidate_source"] == "explicit_cql"
    assert row["extra"]["metadata"]["candidate_query"] == query
    assert row["extra"]["metadata"]["scan_method"] == "api_cql_search_detail_scan"


def test_confluence_blogpost_cql_detail_error_is_audited_without_broadening(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class BlogpostBodyFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    query = 'space = "OPS" AND type = blogpost AND title ~ "Deploy Secrets"'
    queries: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append((cql, limit))
        return [
            CfPage(
                id="77",
                title="Deploy Secrets",
                space_key="OPS",
                version=3,
                url="/display/OPS/2026/07/01/Deploy+Secrets",
            ),
        ]

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blogpost CQL detail failure must not use page-list fallback"),
        ),
    )

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        raise BlogpostBodyFailure("Confluence blogpost body HTTP 503")

    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blogpost CQL page-body failure must not list comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blogpost CQL page-body failure must not list history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blogpost CQL page-body failure must not list attachments"),
        ),
    )

    res = _run({
        "cql": query,
        "fetch_attachments": True,
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert queries == [(query, 25)]
    assert fetch_calls == ["77"]
    assert payload["finding_count"] == 0
    assert payload["target_count"] == 1
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["candidate_sources"] == {"explicit_cql": 1}
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_page_body"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_page_body": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_cql": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        query: 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {
        "503": 1,
    }
    assert payload["errors"][0]["phase"] == "fetch_page_body"
    assert payload["errors"][0]["status_code"] == 503

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert evidence["page_details"] == [{
        "page_id": "77",
        "space_key": "OPS",
        "title": "Deploy Secrets",
        "url": "/display/OPS/2026/07/01/Deploy+Secrets",
        "version": 3,
        "candidate_source": "explicit_cql",
        "candidate_query": query,
        "scan_method": "api_cql_search_detail_scan",
        "status": "error",
        "status_code": 503,
        "error": "BlogpostBodyFailure('Confluence blogpost body HTTP 503')",
    }]
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_label_cql_seeds_detail_fetch_without_list_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("L" * 36)
    queries: list[str] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append(cql)
        return [
            CfPage(
                id="88",
                title="Production Secrets",
                space_key="OPS",
                version=5,
                url="/label/OPS/prod-secrets",
            ),
        ]

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("label cql must not use list_pages fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda page_id: fetch_calls.append(page_id) or f"GITHUB_TOKEN={token}\n",
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    query = 'space = "OPS" AND label = "prod-secrets"'
    res = _run({
        "cql": query,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert queries == [query]
    assert fetch_calls == ["88"]
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["api_search"]["candidate_sources"] == {"explicit_cql": 1}
    assert payload["api_search"]["fallback_list_pages"] == 0

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"][0]["candidate_source"] == "explicit_cql"
    assert evidence["page_details"][0]["candidate_query"] == query
    assert evidence["page_details"][0]["scan_method"] == "api_cql_search_detail_scan"

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:OPS:88"
    assert row["extra"]["metadata"]["candidate_source"] == "explicit_cql"
    assert row["extra"]["metadata"]["candidate_query"] == query
    assert row["extra"]["metadata"]["scan_method"] == "api_cql_search_detail_scan"


def test_confluence_label_cql_detail_error_is_audited_without_broadening(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class LabelPageBodyFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    query = 'space = "OPS" AND label = "prod-secrets"'
    queries: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append((cql, limit))
        return [
            CfPage(
                id="88",
                title="Production Secrets",
                space_key="OPS",
                version=5,
                url="/label/OPS/prod-secrets",
            ),
        ]

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("label CQL detail failure must not use page-list fallback"),
        ),
    )

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        raise LabelPageBodyFailure("Confluence label page body HTTP 503")

    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("label CQL page-body failure must not list comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("label CQL page-body failure must not list history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("label CQL page-body failure must not list attachments"),
        ),
    )

    res = _run({
        "cql": query,
        "fetch_attachments": True,
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert queries == [(query, 25)]
    assert fetch_calls == ["88"]
    assert payload["finding_count"] == 0
    assert payload["target_count"] == 1
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["candidate_sources"] == {"explicit_cql": 1}
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_page_body"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_page_body": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_cql": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        query: 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {
        "503": 1,
    }
    assert payload["errors"][0]["phase"] == "fetch_page_body"
    assert payload["errors"][0]["status_code"] == 503

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert evidence["page_details"] == [{
        "page_id": "88",
        "space_key": "OPS",
        "title": "Production Secrets",
        "url": "/label/OPS/prod-secrets",
        "version": 5,
        "candidate_source": "explicit_cql",
        "candidate_query": query,
        "scan_method": "api_cql_search_detail_scan",
        "status": "error",
        "status_code": 503,
        "error": "LabelPageBodyFailure('Confluence label page body HTTP 503')",
    }]
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_page_list_url_fetches_bounded_pages_only(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("P" * 36)
    list_calls: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    def list_pages(space_key: str, *, limit: int = 50) -> list[CfPage]:
        list_calls.append((space_key, limit))
        return [
            CfPage(
                id="101",
                title="Prod Token Inventory",
                space_key="OPS",
                version=9,
                url="/spaces/OPS/pages/101/Prod+Token+Inventory",
            ),
            CfPage(
                id="102",
                title="Ordinary Handbook",
                space_key="OPS",
                version=2,
                url="/spaces/OPS/pages/102/Ordinary+Handbook",
            ),
        ]

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        if page_id == "101":
            return f"GITHUB_TOKEN={token}\n"
        return "팀 일반 안내 문서입니다.\n"

    monkeypatch.setattr(sht.cf, "list_pages", list_pages)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page-list URL must not run default CQL search"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": True,
        "include_pages": True,
        "page_limit_per_space": 2,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata={"charter_ref": "SECOPS-CONFLUENCE-PAGE-LIST"})

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["charter_ref"] == "SECOPS-CONFLUENCE-PAGE-LIST"
    assert list_calls == [("OPS", 2)]
    assert fetch_calls == ["101", "102"]
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 2
    assert payload["pages"] == ["101", "102"]
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["page_list_count"] == 2
    assert payload["api_search"]["page_list_attempts"] == [{
        "space_key": "OPS",
        "source": "space_page_list",
        "reason": "explicit_page_list",
        "returned": 2,
        "added": 2,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"space_page_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_page_list": {"fetched": 2},
    }
    assert payload["api_search"]["target_source_counts"] == {"space_page_list": 2}

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [
        {
            "id": "101",
            "space_key": "OPS",
            "title": "Prod Token Inventory",
            "candidate_source": "space_page_list",
            "candidate_query": "",
        },
        {
            "id": "102",
            "space_key": "OPS",
            "title": "Ordinary Handbook",
            "candidate_source": "space_page_list",
            "candidate_query": "",
        },
    ]
    assert [
        {
            "page_id": row["page_id"],
            "candidate_source": row["candidate_source"],
            "status": row["status"],
            "body_present": row["body_present"],
        }
        for row in evidence["page_details"]
    ] == [
        {
            "page_id": "101",
            "candidate_source": "space_page_list",
            "status": "fetched",
            "body_present": True,
        },
        {
            "page_id": "102",
            "candidate_source": "space_page_list",
            "status": "fetched",
            "body_present": True,
        },
    ]
    assert evidence["api_search"]["page_list_attempts"] == payload["api_search"]["page_list_attempts"]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:OPS:101"
    assert row["extra"]["metadata"]["candidate_source"] == "space_page_list"
    assert row["extra"]["metadata"]["scan_method"] == "api_page_detail_scan"


def test_confluence_page_list_marks_top_level_limit_hit(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("L" * 36)
    list_calls: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    def list_pages(space_key: str, *, limit: int = 50) -> list[CfPage]:
        list_calls.append((space_key, limit))
        return [
            CfPage(
                id="101",
                title="Prod Token Inventory",
                space_key=space_key,
                version=9,
                url="/spaces/OPS/pages/101/Prod+Token+Inventory",
            ),
            CfPage(
                id="102",
                title="Skipped Handbook",
                space_key=space_key,
                version=2,
                url="/spaces/OPS/pages/102/Skipped+Handbook",
            ),
        ]

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        if page_id != "101":
            raise AssertionError("page-list rows beyond max_pages must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "list_pages", list_pages)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page-list URL must not run default CQL search"),
        ),
    )
    monkeypatch.setattr(sht.cf, "list_blogposts", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": True,
        "include_pages": True,
        "page_limit_per_space": 2,
        "max_pages": 1,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata={"charter_ref": "SECOPS-CONFLUENCE-PAGE-LIST-LIMIT"})

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["charter_ref"] == "SECOPS-CONFLUENCE-PAGE-LIST-LIMIT"
    assert list_calls == [("OPS", 2)]
    assert fetch_calls == ["101"]
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["pages"] == ["101"]
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["page_list_count"] == 1
    assert payload["api_search"]["page_list_attempts"] == [{
        "space_key": "OPS",
        "source": "space_page_list",
        "reason": "explicit_page_list",
        "returned": 2,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"space_page_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_page_list": {"skipped": 1, "fetched": 1},
    }
    assert payload["api_search"]["target_source_counts"] == {"space_page_list": 1}

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["api_search"]["page_list_attempts"] == payload["api_search"]["page_list_attempts"]
    assert evidence["target_details"] == [{
        "id": "101",
        "space_key": "OPS",
        "title": "Prod Token Inventory",
        "candidate_source": "space_page_list",
        "candidate_query": "",
    }]
    skipped_details = [
        row for row in evidence["page_details"]
        if row["status"] == "skipped"
    ]
    assert skipped_details == [{
        "page_id": "102",
        "space_key": "OPS",
        "title": "Skipped Handbook",
        "url": "/spaces/OPS/pages/102/Skipped+Handbook",
        "version": 2,
        "candidate_source": "space_page_list",
        "candidate_query": "",
        "scan_method": "api_page_detail_scan",
        "status": "skipped",
        "error": "Confluence page-list candidate beyond max_pages",
    }]

    rows = core_state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "confluence:OPS:101"


def test_confluence_page_list_empty_details_are_error_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page-list URL must not run default CQL search"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda space_key, *, limit=50: [
            CfPage(
                id="103",
                title="Empty Inventory",
                space_key=space_key,
                version=1,
                url="/spaces/OPS/pages/103/Empty+Inventory",
            ),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "list_blogposts",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page-list URL must not list blogposts"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "   \n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": True,
        "include_pages": True,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "page_lists=1" in payload["status_reason"]
    assert payload["api_search"]["page_list_count"] == 1
    assert payload["api_search"]["page_list_attempts"] == [{
        "space_key": "OPS",
        "source": "space_page_list",
        "reason": "explicit_page_list",
        "returned": 1,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_page_list": {"empty": 1},
    }
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_page_list_detail_error_is_audited_without_broadening(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class PageListBodyFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    list_calls: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page-list URL must not run default CQL search"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_blogposts",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page-list detail failure must not list blogposts"),
        ),
    )

    def list_pages(space_key: str, *, limit: int = 50) -> list[CfPage]:
        list_calls.append((space_key, limit))
        return [
            CfPage(
                id="104",
                title="Denied Inventory",
                space_key=space_key,
                version=4,
                url="/spaces/OPS/pages/104/Denied+Inventory",
            ),
        ]

    monkeypatch.setattr(sht.cf, "list_pages", list_pages)

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        raise PageListBodyFailure("Confluence page-list body HTTP 503")

    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page-list page-body failure must not list comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page-list page-body failure must not list history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page-list page-body failure must not list attachments"),
        ),
    )

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": True,
        "include_pages": True,
        "page_limit_per_space": 5,
        "fetch_attachments": True,
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert list_calls == [("OPS", 5)]
    assert fetch_calls == ["104"]
    assert payload["finding_count"] == 0
    assert payload["target_count"] == 1
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["page_list_count"] == 1
    assert payload["api_search"]["page_list_attempts"] == [{
        "space_key": "OPS",
        "source": "space_page_list",
        "reason": "explicit_page_list",
        "returned": 1,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_page_body"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_page_body": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "space_page_list": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        "(no query)": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {
        "503": 1,
    }
    assert payload["errors"][0]["phase"] == "fetch_page_body"
    assert payload["errors"][0]["status_code"] == 503

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert evidence["page_details"] == [{
        "page_id": "104",
        "space_key": "OPS",
        "title": "Denied Inventory",
        "url": "/spaces/OPS/pages/104/Denied+Inventory",
        "version": 4,
        "candidate_source": "space_page_list",
        "candidate_query": "",
        "scan_method": "api_page_detail_scan",
        "status": "error",
        "status_code": 503,
        "error": "PageListBodyFailure('Confluence page-list body HTTP 503')",
    }]
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_page_list_api_failure_records_attempt(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class ListPagesFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page-list failure must not run default CQL search"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_blogposts",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page-list failure must not list blogposts"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ListPagesFailure("Confluence list pages HTTP 503"),
        ),
    )

    def forbidden_detail(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("page-list failure must not fetch detail surfaces")

    monkeypatch.setattr(sht.cf, "fetch_page_body", forbidden_detail)
    monkeypatch.setattr(sht.cf, "list_comments", forbidden_detail)
    monkeypatch.setattr(sht.cf, "list_page_versions", forbidden_detail)
    monkeypatch.setattr(sht.cf, "list_attachments", forbidden_detail)

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": True,
        "include_pages": True,
        "fetch_attachments": True,
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["page_list_count"] == 0
    assert payload["api_search"]["page_list_attempts"] == [{
        "space_key": "OPS",
        "source": "space_page_list",
        "reason": "explicit_page_list",
        "returned": 0,
        "added": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
        "phase": "list_pages",
        "error": "ListPagesFailure('Confluence list pages HTTP 503')",
        "status_code": 503,
    }]
    assert payload["api_search"]["errors"] == [{
        "target": "OPS",
        "phase": "list_pages",
        "error": "ListPagesFailure('Confluence list pages HTTP 503')",
        "status_code": 503,
    }]
    assert payload["errors"][0]["phase"] == "list_pages"
    assert payload["errors"][0]["status_code"] == 503
    assert payload["api_search"]["target_status_counts"] == {"error": 1}
    assert payload["api_search"]["target_source_counts"] == {"space_page_list": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "space_page_list": {"error": 1},
    }
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["page_list_attempts"] == payload["api_search"]["page_list_attempts"]
    assert evidence["target_details"] == [{
        "space_key": "OPS",
        "source": "space_page_list",
        "fallback_reason": "",
        "status": "error",
        "phase": "list_pages",
        "status_code": 503,
        "error": "ListPagesFailure('Confluence list pages HTTP 503')",
    }]
    assert evidence["page_details"] == []


def test_confluence_blogpost_list_empty_details_are_error_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blog-list URL must not run default CQL search"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blog-list URL must not list normal pages"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_blogposts",
        lambda space_key, *, limit=50: [
            CfPage(
                id="104",
                title="Empty Blog",
                space_key=space_key,
                version=1,
                url="/spaces/OPS/blog/2026/7/2/Empty+Blog",
            ),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": True,
        "include_blogposts": True,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "blogposts=1" in payload["status_reason"]
    assert payload["api_search"]["blogpost_list_count"] == 1
    assert payload["api_search"]["blogpost_list_attempts"] == [{
        "space_key": "OPS",
        "source": "space_blogpost_list",
        "reason": "explicit_blogpost_list",
        "returned": 1,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_blogpost_list": {"empty": 1},
    }
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_blogpost_list_marks_top_level_limit_hit(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("B" * 36)
    list_calls: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blog-list URL must not run default CQL search"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blog-list URL must not list normal pages"),
        ),
    )

    def list_blogposts(space_key: str, *, limit: int = 50) -> list[CfPage]:
        list_calls.append((space_key, limit))
        return [
            CfPage(
                id="201",
                title="Prod Token Blog",
                space_key=space_key,
                version=9,
                url="/spaces/OPS/blog/2026/7/2/Prod+Token+Blog",
            ),
            CfPage(
                id="202",
                title="Skipped Blog",
                space_key=space_key,
                version=2,
                url="/spaces/OPS/blog/2026/7/1/Skipped+Blog",
            ),
        ]

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        if page_id != "201":
            raise AssertionError("blog-list rows beyond max_pages must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "list_blogposts", list_blogposts)
    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": True,
        "include_blogposts": True,
        "page_limit_per_space": 2,
        "max_pages": 1,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata={"charter_ref": "SECOPS-CONFLUENCE-BLOG-LIST-LIMIT"})

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["charter_ref"] == "SECOPS-CONFLUENCE-BLOG-LIST-LIMIT"
    assert list_calls == [("OPS", 2)]
    assert fetch_calls == ["201"]
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["pages"] == ["201"]
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["blogpost_list_count"] == 1
    assert payload["api_search"]["blogpost_list_attempts"] == [{
        "space_key": "OPS",
        "source": "space_blogpost_list",
        "reason": "explicit_blogpost_list",
        "returned": 2,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"space_blogpost_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_blogpost_list": {"skipped": 1, "fetched": 1},
    }
    assert payload["api_search"]["target_source_counts"] == {"space_blogpost_list": 1}

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["api_search"]["blogpost_list_attempts"] == payload["api_search"]["blogpost_list_attempts"]
    assert evidence["target_details"] == [{
        "id": "201",
        "space_key": "OPS",
        "title": "Prod Token Blog",
        "candidate_source": "space_blogpost_list",
        "candidate_query": "",
    }]
    skipped_details = [
        row for row in evidence["page_details"]
        if row["status"] == "skipped"
    ]
    assert skipped_details == [{
        "page_id": "202",
        "space_key": "OPS",
        "title": "Skipped Blog",
        "url": "/spaces/OPS/blog/2026/7/1/Skipped+Blog",
        "version": 2,
        "candidate_source": "space_blogpost_list",
        "candidate_query": "",
        "scan_method": "api_blogpost_list_detail_scan",
        "status": "skipped",
        "error": "Confluence blogpost-list candidate beyond max_pages",
    }]

    rows = core_state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "confluence:OPS:201"
    assert rows[0]["extra"]["metadata"]["candidate_source"] == "space_blogpost_list"


def test_confluence_blogpost_list_api_failure_records_attempt(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class ListBlogpostsFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blog-list failure must not run default CQL search"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("blog-list failure must not list normal pages"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_blogposts",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ListBlogpostsFailure("Confluence list blogposts HTTP 503"),
        ),
    )

    def forbidden_detail(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("blog-list failure must not fetch detail surfaces")

    monkeypatch.setattr(sht.cf, "fetch_page_body", forbidden_detail)
    monkeypatch.setattr(sht.cf, "list_comments", forbidden_detail)
    monkeypatch.setattr(sht.cf, "list_page_versions", forbidden_detail)
    monkeypatch.setattr(sht.cf, "list_attachments", forbidden_detail)

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": True,
        "include_blogposts": True,
        "fetch_attachments": True,
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["blogpost_list_count"] == 0
    assert payload["api_search"]["blogpost_list_attempts"] == [{
        "space_key": "OPS",
        "source": "space_blogpost_list",
        "reason": "explicit_blogpost_list",
        "returned": 0,
        "added": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
        "phase": "list_blogposts",
        "error": "ListBlogpostsFailure('Confluence list blogposts HTTP 503')",
        "status_code": 503,
    }]
    assert payload["api_search"]["errors"] == [{
        "target": "OPS",
        "phase": "list_blogposts",
        "error": "ListBlogpostsFailure('Confluence list blogposts HTTP 503')",
        "status_code": 503,
    }]
    assert payload["errors"][0]["phase"] == "list_blogposts"
    assert payload["errors"][0]["status_code"] == 503
    assert payload["api_search"]["target_status_counts"] == {"error": 1}
    assert payload["api_search"]["target_source_counts"] == {"space_blogpost_list": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "space_blogpost_list": {"error": 1},
    }
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["blogpost_list_attempts"] == (
        payload["api_search"]["blogpost_list_attempts"]
    )
    assert evidence["target_details"] == [{
        "space_key": "OPS",
        "source": "space_blogpost_list",
        "fallback_reason": "",
        "status": "error",
        "phase": "list_blogposts",
        "status_code": 503,
        "error": "ListBlogpostsFailure('Confluence list blogposts HTTP 503')",
    }]
    assert evidence["page_details"] == []


def test_confluence_space_cql_filters_out_of_scope_candidates_before_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("O" * 36)
    queries: list[str] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append(cql)
        wrong_space = CfPage(
            id="99",
            title="Other Space Runbook",
            space_key="OTHER",
            version=1,
            url="/display/OTHER/R",
        )
        if "text ~" in cql:
            return [
                wrong_space,
                CfPage(
                    id="42",
                    title="OPS Runbook",
                    space_key="OPS",
                    version=7,
                    url="/display/OPS/R",
                ),
            ]
        return [wrong_space]

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        if page_id == "99":
            raise AssertionError("out-of-scope CQL candidate must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["pages"] == ["42"]
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 2
    assert [q["returned"] for q in payload["api_search"]["query_details"]] == [2, 1]
    assert [q["added"] for q in payload["api_search"]["query_details"]] == [1, 0]
    assert [q["out_of_scope"] for q in payload["api_search"]["query_details"]] == [1, 1]
    assert [q["skipped"] for q in payload["api_search"]["query_details"]] == [1, 1]
    assert payload["api_search"]["query_status_counts"] == {"searched": 2}
    assert payload["api_search"]["query_candidate_totals"] == {
        "returned": 3,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 2,
        "duplicate": 0,
        "skipped": 2,
    }
    assert payload["api_search"]["detail_source_counts"] == {"space_cql": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_cql": {"skipped": 2, "fetched": 1},
    }
    assert fetch_calls == ["42"]
    assert len(queries) == 2

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    skipped = [detail for detail in evidence["page_details"] if detail["status"] == "skipped"]
    assert skipped == [
        {
            "page_id": "99",
            "space_key": "OTHER",
            "target_space_key": "OPS",
            "title": "Other Space Runbook",
            "url": "/display/OTHER/R",
            "version": 1,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "OPS" AND type = page AND text ~ "password"',
            "scan_method": "api_cql_search_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "99",
            "space_key": "OTHER",
            "target_space_key": "OPS",
            "title": "Other Space Runbook",
            "url": "/display/OTHER/R",
            "version": 1,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "OPS" AND type = page AND title ~ "password"',
            "scan_method": "api_cql_search_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
    ]
    fetched = [detail for detail in evidence["page_details"] if detail["status"] == "fetched"]
    assert fetched[0]["page_id"] == "42"
    assert fetched[0]["candidate_source"] == "space_cql"

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:OPS:42"
    assert row["extra"]["metadata"]["space_key"] == "OPS"


def test_confluence_space_cql_missing_space_key_is_error(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="42", title="Broken Runbook", space_key="", version=1, url="/display/OPS/B"),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must not run for CQL candidates without a space_key"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda space_key, limit=50: [],
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["out_of_scope_count"] == 2
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["errors"] == []
    assert payload["errors"] == []
    assert [q["returned"] for q in payload["api_search"]["query_details"]] == [1, 1]
    assert [q["out_of_scope"] for q in payload["api_search"]["query_details"]] == [1, 1]
    assert [q["invalid"] for q in payload["api_search"]["query_details"]] == [0, 0]
    assert [q["skipped"] for q in payload["api_search"]["query_details"]] == [1, 1]
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == [
        {
            "page_id": "42",
            "space_key": "",
            "target_space_key": "OPS",
            "title": "Broken Runbook",
            "url": "/display/OPS/B",
            "version": 1,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "OPS" AND type = page AND text ~ "password"',
            "scan_method": "api_cql_search_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "42",
            "space_key": "",
            "target_space_key": "OPS",
            "title": "Broken Runbook",
            "url": "/display/OPS/B",
            "version": 1,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "OPS" AND type = page AND title ~ "password"',
            "scan_method": "api_cql_search_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
    ]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_scan_reopens_remediated_reobserved_finding(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("R" * 36)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:42",
        asset_kind="page",
        severity="high",
        summary="previously remediated Confluence finding",
        extra={"metadata": {"space_key": "OPS", "page_id": "42"}},
    )
    core_state.finding_set_status(finding_id, "remediated", reason="unit closed")

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="42", title="Runbook", space_key="OPS", version=7, url="/display/OPS/R"),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("list_pages fallback must not run"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: f"GITHUB_TOKEN={token}\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["findings"][0]["id"] == finding_id
    assert payload["findings"][0]["status"] == "open"
    assert core_state.finding_get(finding_id)["status"] == "open"


def test_confluence_scan_suppresses_human_terminal_finding_followup_signal(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from service import state_domain as sd
    from secu_agent import state as core_state

    token = "ghp_" + ("F" * 36)
    finding_id, _ = core_state.finding_upsert(
        task_type="confluence",
        asset="confluence:OPS:42",
        asset_kind="page",
        severity="high",
        summary="false positive Confluence finding",
        extra={"metadata": {"space_key": "OPS", "page_id": "42"}},
    )
    core_state.finding_set_status(finding_id, "false_positive", reason="unit suppressed")

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="42", title="Runbook", space_key="OPS", version=7, url="/display/OPS/R"),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("list_pages fallback must not run"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: f"GITHUB_TOKEN={token}\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    metadata: dict[str, object] = {}
    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata=metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["findings"][0]["id"] == finding_id
    assert payload["findings"][0]["status"] == "false_positive"
    assert payload["findings"][0]["candidate_source"] == "space_cql"
    assert payload["findings"][0]["report_updated"] is False
    assert payload["findings"][0]["followup_signal_emitted"] is False
    assert payload["findings"][0]["report_skip_reason"] == "lifecycle status false_positive"
    assert payload["api_search"]["finding_summary"] == {
        "total": 1,
        "created_count": 0,
        "existing_count": 1,
        "status_counts": {"false_positive": 1},
        "source_counts": {"space_cql": 1},
        "status_by_source": {"space_cql": {"false_positive": 1}},
        "report_updated_counts": {"false": 1},
        "report_updated_by_source": {"space_cql": {"false": 1}},
        "followup_signal_counts": {"false": 1},
    }
    row = core_state.finding_get(finding_id)
    assert row["status"] == "false_positive"
    assert row["extra"]["report_updated"] is False
    assert row["extra"]["report_skip_reason"] == "lifecycle status false_positive"
    assert sd.confluence_report_threads_overview(space_key="OPS") == []
    assert "finding_signals" not in metadata
    assert metadata.get("finding_followup_pending") is None
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["finding_summary"] == payload["api_search"]["finding_summary"]


def test_confluence_cql_duplicate_candidates_fetch_detail_once(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("D" * 36)
    queries: list[str] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append(cql)
        return [CfPage(id="42", title="Runbook", space_key="OPS", version=7, url="/display/OPS/R")]

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("list_pages fallback must not run")),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda page_id: fetch_calls.append(page_id) or f"GITHUB_TOKEN={token}\n",
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password", "token"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["query_count"] == 4
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 3
    assert payload["api_search"]["detail_source_counts"] == {"space_cql": 4}
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_cql": {"skipped": 3, "fetched": 1},
    }
    assert fetch_calls == ["42"]
    assert len(core_state.finding_list(task_type="confluence", limit=10)) == 1

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    skipped = [detail for detail in evidence["page_details"] if detail["status"] == "skipped"]
    assert len(skipped) == 3
    assert all(
        detail.get("page_id") == "42"
        and detail.get("candidate_source") == "space_cql"
        and detail.get("scan_method") == "api_cql_search_detail_scan"
        and detail.get("error") == "duplicate page candidate"
        for detail in skipped
    )


def test_confluence_cql_limits_candidate_detail_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    tokens = {
        "41": "ghp_" + ("A" * 36),
        "42": "ghp_" + ("B" * 36),
        "43": "ghp_" + ("C" * 36),
    }
    queries: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append((cql, limit))
        return [
            CfPage(id="41", title="One", space_key="OPS", version=1, url="/display/OPS/1"),
            CfPage(id="42", title="Two", space_key="OPS", version=1, url="/display/OPS/2"),
            CfPage(id="43", title="Three", space_key="OPS", version=1, url="/display/OPS/3"),
        ]

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        return f"GITHUB_TOKEN={tokens[page_id]}\n"

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("list_pages fallback must not run"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "max_pages": 2,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 2
    assert payload["target_count"] == 2
    assert payload["pages"] == ["41", "42"]
    assert fetch_calls == ["41", "42"]
    assert queries == [('space = "OPS" AND type = page AND text ~ "password"', 2)]
    assert payload["api_search"]["candidate_count"] == 2
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["query_details"] == [{
        "query": 'space = "OPS" AND type = page AND text ~ "password"',
        "source": "space_cql",
        "space_key": "OPS",
        "status": "searched",
        "returned": 3,
        "added": 2,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_fetched"] == 2
    assert payload["api_search"]["detail_source_counts"] == {"space_cql": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_cql": {"fetched": 2, "skipped": 1},
    }
    assert payload["api_search"]["fallback_list_pages"] == 0

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    skipped = [detail for detail in evidence["page_details"] if detail["status"] == "skipped"]
    assert skipped == [{
        "page_id": "43",
        "space_key": "OPS",
        "title": "Three",
        "url": "/display/OPS/3",
        "version": 1,
        "candidate_source": "space_cql",
        "candidate_query": 'space = "OPS" AND type = page AND text ~ "password"',
        "scan_method": "api_cql_search_detail_scan",
        "status": "skipped",
        "error": "Confluence CQL candidate beyond max_pages",
    }]
    assert len(core_state.finding_list(task_type="confluence", limit=10)) == 2


def test_confluence_cql_false_positive_does_not_persist_finding(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="7", title="Public Runbook", space_key="OPS", version=1, url="/display/OPS/P"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "일반 운영 절차만 있습니다.\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 1
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_cql_empty_page_id_is_error(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="", title="Broken", space_key="OPS", version=1, url="/display/OPS/B"),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("list_pages fallback must not run after malformed CQL candidate"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda *args, **kwargs: "secret")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "cql_candidate"
    assert payload["errors"][0]["phase"] == "cql_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == [
        {
            "page_id": "",
            "space_key": "OPS",
            "title": "Broken",
            "url": "/display/OPS/B",
            "version": 1,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "OPS" AND type = page AND text ~ "password"',
            "scan_method": "api_cql_search_detail_scan",
            "status": "error",
            "error": "Confluence page candidate missing id",
        },
        {
            "page_id": "",
            "space_key": "OPS",
            "title": "Broken",
            "url": "/display/OPS/B",
            "version": 1,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "OPS" AND type = page AND title ~ "password"',
            "scan_method": "api_cql_search_detail_scan",
            "status": "error",
            "error": "Confluence page candidate missing id",
        },
    ]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_cql_invalid_page_id_is_error_before_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="../42", title="Broken", space_key="OPS", version=1, url="/display/OPS/B"),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("list_pages fallback must not run after malformed CQL candidate"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must not run for invalid CQL page ids"),
        ),
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "cql_candidate"
    assert payload["api_search"]["errors"][0]["page_id"] == "../42"
    assert "invalid id" in payload["api_search"]["errors"][0]["error"]
    assert payload["errors"][0]["phase"] == "cql_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == [
        {
            "page_id": "../42",
            "space_key": "OPS",
            "title": "Broken",
            "url": "/display/OPS/B",
            "version": 1,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "OPS" AND type = page AND text ~ "password"',
            "scan_method": "api_cql_search_detail_scan",
            "status": "error",
            "error": "Confluence page candidate invalid id",
        },
        {
            "page_id": "../42",
            "space_key": "OPS",
            "title": "Broken",
            "url": "/display/OPS/B",
            "version": 1,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "OPS" AND type = page AND title ~ "password"',
            "scan_method": "api_cql_search_detail_scan",
            "status": "error",
            "error": "Confluence page candidate invalid id",
        },
    ]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_cql_candidate_identifiers_are_normalized_before_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("N" * 36)
    fetch_calls: list[str] = []

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(
                id=" 42 ",
                title=" Runbook ",
                space_key=" OPS ",
                version=7,
                url="/display/OPS/R",
            ),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("list_pages fallback must not run when CQL detail succeeds"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda page_id: fetch_calls.append(page_id) or f"GITHUB_TOKEN={token}\n",
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["pages"] == ["42"]
    assert fetch_calls == ["42"]
    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:OPS:42"
    assert row["extra"]["metadata"]["page_id"] == "42"
    assert row["extra"]["metadata"]["space_key"] == "OPS"
    assert row["extra"]["metadata"]["title"] == "Runbook"


def test_confluence_blank_space_key_is_error_and_not_scanned(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL search must not run for a blank space target"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page listing must not run for a blank space target"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must not run for a blank space target"),
        ),
    )

    res = _run({
        "space_keys": ["   "],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata={"charter_ref": "SECOPS-CONFLUENCE-SCAN-INVALID"})

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["charter_ref"] == "SECOPS-CONFLUENCE-SCAN-INVALID"
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["status_reason"] == "Confluence space candidate missing space_key"
    assert payload["errors"][0]["phase"] == "space_candidate"
    assert payload["api_search"]["errors"][0]["phase"] == "space_candidate"
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["detail_fetched"] == 0
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["charter_ref"] == "SECOPS-CONFLUENCE-SCAN-INVALID"
    assert evidence["errors"][0]["phase"] == "space_candidate"
    assert evidence["target_details"] == [{
        "space_key": "",
        "source": "space_keys[0]",
        "status": "error",
        "error": "Confluence space candidate missing space_key",
    }]


def test_confluence_duplicate_space_keys_are_deduped_before_cql_search(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("S" * 36)
    queries: list[str] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append(cql)
        return [CfPage(id="42", title="Runbook", space_key="OPS", version=7, url="/display/OPS/R")]

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("list_pages fallback must not run when CQL detail succeeds"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS", " ops "],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 1
    assert payload["spaces"] == ["OPS"]
    assert payload["api_search"]["space_duplicate_count"] == 1
    assert payload["api_search"]["query_count"] == 2
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    assert fetch_calls == ["42"]
    assert len(queries) == 2
    assert all('space = "OPS"' in query for query in queries)
    assert len(core_state.finding_list(task_type="confluence", limit=10)) == 1


def test_confluence_all_spaces_enum_dedupes_before_cql_search(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage, CfSpace
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("T" * 36)
    queries: list[str] = []
    fetch_calls: list[str] = []

    monkeypatch.setattr(
        sht.cf,
        "list_spaces",
        lambda: [
            CfSpace(key="OPS", name="Ops", type="global", url="/display/OPS"),
            CfSpace(key=" ops ", name="Ops duplicate", type="global", url="/display/OPS"),
        ],
    )

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append(cql)
        return [CfPage(id="42", title="Runbook", space_key="OPS", version=7, url="/display/OPS/R")]

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("list_pages fallback must not run when CQL detail succeeds"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "all_spaces": True,
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 1
    assert payload["spaces"] == ["OPS"]
    assert payload["api_search"]["space_duplicate_count"] == 1
    assert payload["api_search"]["query_count"] == 2
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    assert fetch_calls == ["42"]
    assert len(queries) == 2
    assert all('space = "OPS"' in query for query in queries)
    assert len(core_state.finding_list(task_type="confluence", limit=10)) == 1


def test_confluence_empty_comment_body_counts_missing_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="78", title="Deploy", space_key="SEC", version=3, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "clean page\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: ["", "   "])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "fetch_attachments": False,
        "scan_comments": True,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_missing"] == 2
    assert payload["api_search"]["detail_status_counts"] == {
        "skipped": 1,
        "fetched": 1,
        "empty": 2,
    }
    assert payload["api_search"]["detail_status_by_kind"] == {
        "page": {"skipped": 1, "fetched": 1},
        "comment": {"empty": 2},
    }
    assert payload["api_search"]["detail_source_counts"] == {"space_cql": 4}
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_cql": {"skipped": 1, "fetched": 1, "empty": 2},
    }
    query = 'space = "SEC" AND type = page AND text ~ "deploy"'
    title_query = 'space = "SEC" AND type = page AND title ~ "deploy"'
    assert payload["api_search"]["detail_query_counts"] == {title_query: 1, query: 3}
    assert payload["api_search"]["detail_status_by_query"] == {
        title_query: {"skipped": 1},
        query: {"fetched": 1, "empty": 2},
    }
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_status_by_kind"] == payload["api_search"]["detail_status_by_kind"]
    assert evidence["api_search"]["detail_status_by_source"] == payload["api_search"]["detail_status_by_source"]
    assert evidence["api_search"]["detail_query_counts"] == payload["api_search"]["detail_query_counts"]
    assert evidence["api_search"]["detail_status_by_query"] == payload["api_search"]["detail_status_by_query"]
    assert evidence["comment_details"] == [
        {
            "page_id": "78",
            "space_key": "SEC",
            "page_title": "Deploy",
            "comment_index": 0,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "empty",
            "content_present": False,
        },
        {
            "page_id": "78",
            "space_key": "SEC",
            "page_title": "Deploy",
            "comment_index": 1,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "empty",
            "content_present": False,
        },
    ]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_comment_detail_targets_are_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("M" * 36)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="79", title="Deploy", space_key="SEC", version=3, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "clean page\n")
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: ["", f"please rotate GITHUB_TOKEN={token}\n"],
    )
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "fetch_attachments": False,
        "scan_comments": True,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["comment_details"] == [
        {
            "page_id": "79",
            "space_key": "SEC",
            "page_title": "Deploy",
            "comment_index": 0,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "empty",
            "content_present": False,
        },
        {
            "page_id": "79",
            "space_key": "SEC",
            "page_title": "Deploy",
            "comment_index": 1,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "fetched",
            "content_present": True,
        },
    ]
    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:SEC:79/comment/1"
    assert row["asset_kind"] == "comment"


def test_confluence_explicit_comment_fetches_exact_comment_only(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfComment
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("Q" * 36)
    calls: list[str] = []

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit comment URLs must not require CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit comment URLs must not require page listing"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit comment URLs must not fetch page body"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit comment URLs must not list every page comment"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit comment URLs must not scan page history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit comment URLs must not list attachments"),
        ),
    )

    def fetch_comment_detail(comment_id: str) -> CfComment:
        calls.append(comment_id)
        return CfComment(
            id=comment_id,
            parent_page_id="77",
            body=f"please rotate GITHUB_TOKEN={token}\n",
        )

    monkeypatch.setattr(sht.cf, "fetch_comment_detail", fetch_comment_detail)

    res = _run({
        "comment_ids": [{"page_id": "77", "comment_id": "9001"}],
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert calls == ["9001"]
    assert payload["api_search"]["candidate_sources"] == {"explicit_comment": 1}
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_status_by_kind"] == {"comment": {"fetched": 1}}
    assert payload["api_search"]["detail_source_counts"] == {"explicit_comment": 1}

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["comment_details"] == [{
        "page_id": "77",
        "space_key": "",
        "page_title": "77",
        "comment_id": "9001",
        "candidate_source": "explicit_comment",
        "candidate_query": "",
        "status": "fetched",
        "content_present": True,
    }]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:77/comment/9001"
    assert row["asset_kind"] == "comment"
    assert row["extra"]["metadata"]["candidate_source"] == "explicit_comment"
    assert row["extra"]["metadata"]["scan_method"] == "api_comment_detail_scan"
    assert row["extra"]["metadata"]["comment_id"] == "9001"


def test_confluence_explicit_comment_skips_out_of_scope_parent(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfComment
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    calls: list[str] = []
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope explicit comment must not require CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope explicit comment must not list pages"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope explicit comment must not fetch page body"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope explicit comment must not list comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope explicit comment must not scan history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope explicit comment must not list attachments"),
        ),
    )

    def fetch_comment_detail(comment_id: str) -> CfComment:
        calls.append(comment_id)
        return CfComment(
            id=comment_id,
            parent_page_id="other-page",
            body="GITHUB_TOKEN=" + ("R" * 36),
        )

    monkeypatch.setattr(sht.cf, "fetch_comment_detail", fetch_comment_detail)

    res = _run({
        "comment_ids": [{"page_id": "77", "comment_id": "9001"}],
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["target_count"] == 1
    assert payload["api_search"]["candidate_sources"] == {"explicit_comment": 1}
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_errors"] == []
    assert payload["errors"] == []
    assert payload["api_search"]["detail_source_counts"] == {"explicit_comment": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {"comment": {"skipped": 1}}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_comment": {"skipped": 1},
    }
    assert calls == ["9001"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["comment_details"] == [{
        "page_id": "77",
        "space_key": "",
        "page_title": "77",
        "comment_id": "9001",
        "candidate_source": "explicit_comment",
        "candidate_query": "",
        "status": "skipped",
        "fetched_page_id": "other-page",
        "error": "Confluence comment candidate out of requested page scope",
    }]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_explicit_comment_missing_is_audited_without_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(sht.cf, "fetch_comment_detail", lambda comment_id: None)
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("missing explicit comment must not list page comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("missing explicit comment must not fetch page body"),
        ),
    )

    res = _run({
        "comment_ids": [{"page_id": "77", "comment_id": "9001"}],
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["detail_missing"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["comment_details"] == [{
        "page_id": "77",
        "space_key": "",
        "page_title": "77",
        "comment_id": "9001",
        "candidate_source": "explicit_comment",
        "candidate_query": "",
        "status": "missing",
        "content_present": False,
    }]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_explicit_comment_fetch_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    def fail_comment(comment_id: str) -> None:
        request = httpx.Request("GET", f"https://conf.test/rest/api/content/{comment_id}")
        response = httpx.Response(503, request=request, json={"message": "unavailable"})
        raise httpx.HTTPStatusError("503 Service Unavailable", request=request, response=response)

    monkeypatch.setattr(sht.cf, "fetch_comment_detail", fail_comment)
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("errored explicit comment must not list page comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("errored explicit comment must not fetch page body"),
        ),
    )

    res = _run({
        "comment_ids": [{"page_id": "77", "comment_id": "9001"}],
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_comment_detail"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["comment_details"] == [{
        "page_id": "77",
        "space_key": "",
        "page_title": "77",
        "comment_id": "9001",
        "candidate_source": "explicit_comment",
        "candidate_query": "",
        "status": "error",
        "status_code": 503,
        "error": "HTTPStatusError('503 Service Unavailable')",
    }]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_invalid_explicit_comment_is_audited_without_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "fetch_comment_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid explicit comment must fail before API fetch"),
        ),
    )

    res = _run({
        "comment_ids": [
            {"page_id": "77", "comment_id": ""},
            {"page_id": "../77", "comment_id": "9001"},
        ],
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["comment_details"] == [
        {
            "page_id": "77",
            "space_key": "",
            "page_title": "77",
            "comment_id": "",
            "candidate_source": "comment_ids[0]",
            "candidate_query": "",
            "status": "error",
            "error": "Confluence comment candidate missing comment_id",
        },
        {
            "page_id": "../77",
            "space_key": "",
            "page_title": "../77",
            "comment_id": "9001",
            "candidate_source": "comment_ids[1]",
            "candidate_query": "",
            "status": "error",
            "error": "Confluence page candidate invalid id",
        },
    ]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_cql_detail_missing_does_not_create_finding(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.confluence.plugin.tools.confluence_space_discovery_tool import (
        ConfluenceSpaceSetStatusTool,
    )
    from domains.services.plugin.tools import service_task_tools as sht
    import service.state_domain as sd
    from secu_agent import state as core_state

    metadata: dict[str, Any] = {}

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="404", title="Gone", space_key="OPS", version=1, url="/display/OPS/Gone"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: None)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    target_id = sd.confluence_space_target_upsert("OPS")
    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
    }, tmp_path, metadata=metadata)

    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert metadata["_confluence_task_scan_recommended_status"] == "error"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    missing = [detail for detail in evidence["page_details"] if detail["status"] == "missing"]
    skipped = [detail for detail in evidence["page_details"] if detail["status"] == "skipped"]
    assert missing == [{
        "page_id": "404",
        "space_key": "OPS",
        "title": "Gone",
        "url": "/display/OPS/Gone",
        "version": 1,
        "candidate_source": "space_cql",
        "candidate_query": 'space = "OPS" AND type = page AND text ~ "password"',
        "scan_method": "api_cql_search_detail_scan",
        "status": "missing",
        "body_present": False,
    }]
    assert skipped == [{
        "page_id": "404",
        "space_key": "OPS",
        "title": "Gone",
        "url": "/display/OPS/Gone",
        "version": 1,
        "candidate_source": "space_cql",
        "candidate_query": 'space = "OPS" AND type = page AND title ~ "password"',
        "scan_method": "api_cql_search_detail_scan",
        "status": "skipped",
        "error": "duplicate page candidate",
    }]
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    status_res = asyncio.run(ConfluenceSpaceSetStatusTool().execute(
        ConfluenceSpaceSetStatusTool.input_model(
            target_ids=[target_id],
            status="tasked",
            finding_count=0,
        ),
        ToolContext(evidence_dir=tmp_path, metadata=metadata),
    ))
    assert isinstance(status_res, ToolSuccess)
    row = sd.confluence_space_target_get(target_id)
    assert row is not None
    assert row["status"] == "error"
    assert "detail fetch returned no content" in row["last_reason"]


def test_confluence_explicit_page_not_found_recommends_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.tools.confluence_space_discovery_tool import (
        ConfluenceSpaceSetStatusTool,
    )
    from domains.services.plugin.tools import service_task_tools as sht
    import service.state_domain as sd
    from secu_agent import state as core_state

    metadata: dict[str, Any] = {}

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit page scan must not run CQL search"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: None)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    target_id = sd.confluence_space_target_upsert("OPS")
    res = _run({
        "page_ids": ["404"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata=metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["target_count"] == 1
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "explicit Confluence page target not found" in payload["status_reason"]
    assert payload["api_search"]["candidate_sources"] == {"explicit_page": 1}
    assert payload["api_search"]["page_body_none_missing"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    assert metadata["_confluence_task_scan_recommended_status"] == "skipped"
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    status_res = asyncio.run(ConfluenceSpaceSetStatusTool().execute(
        ConfluenceSpaceSetStatusTool.input_model(
            target_ids=[target_id],
            status="tasked",
            finding_count=0,
        ),
        ToolContext(evidence_dir=tmp_path, metadata=metadata),
    ))
    assert isinstance(status_res, ToolSuccess)
    assert "scan recommended skipped" in status_res.content
    row = sd.confluence_space_target_get(target_id)
    assert row is not None
    assert row["status"] == "skipped"
    assert "explicit Confluence page target not found" in row["last_reason"]


def test_confluence_explicit_page_404_detail_recommends_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.tools.confluence_space_discovery_tool import (
        ConfluenceSpaceSetStatusTool,
    )
    from domains.services.plugin.tools import service_task_tools as sht
    import service.state_domain as sd
    from secu_agent import state as core_state

    metadata: dict[str, Any] = {}

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit page scan must not run CQL search"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda page_id: (_ for _ in ()).throw(
            RuntimeError("Confluence fetch_page_body HTTP 404: page not found"),
        ),
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    target_id = sd.confluence_space_target_upsert("OPS")
    res = _run({
        "page_ids": ["404"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata=metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["target_count"] == 1
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "HTTP 404" in payload["status_reason"]
    assert payload["api_search"]["candidate_sources"] == {"explicit_page": 1}
    assert payload["errors"][0]["phase"] == "fetch_page_body"
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_page_body"
    assert metadata["_confluence_task_scan_recommended_status"] == "skipped"
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    status_res = asyncio.run(ConfluenceSpaceSetStatusTool().execute(
        ConfluenceSpaceSetStatusTool.input_model(
            target_ids=[target_id],
            status="tasked",
            finding_count=0,
        ),
        ToolContext(evidence_dir=tmp_path, metadata=metadata),
    ))
    assert isinstance(status_res, ToolSuccess)
    assert "scan recommended skipped" in status_res.content
    row = sd.confluence_space_target_get(target_id)
    assert row is not None
    assert row["status"] == "skipped"
    assert "HTTP 404" in row["last_reason"]


def test_confluence_explicit_page_403_http_status_recommends_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.tools.confluence_space_discovery_tool import (
        ConfluenceSpaceSetStatusTool,
    )
    from domains.services.plugin.tools import service_task_tools as sht
    import service.state_domain as sd
    from secu_agent import state as core_state

    metadata: dict[str, Any] = {}

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit page scan must not run CQL search"),
        ),
    )

    def deny_page(page_id: str):
        request = httpx.Request("GET", f"https://cf.test/rest/api/content/{page_id}")
        response = httpx.Response(403, request=request, json={"message": "Forbidden"})
        raise httpx.HTTPStatusError("403 Forbidden", request=request, response=response)

    monkeypatch.setattr(sht.cf, "fetch_page_body", deny_page)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    target_id = sd.confluence_space_target_upsert("OPS")
    res = _run({
        "page_ids": ["403"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata=metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["target_count"] == 1
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["api_search"]["candidate_sources"] == {"explicit_page": 1}
    assert payload["errors"][0]["phase"] == "fetch_page_body"
    assert payload["errors"][0]["status_code"] == 403
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 403
    assert metadata["_confluence_task_scan_recommended_status"] == "skipped"
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    status_res = asyncio.run(ConfluenceSpaceSetStatusTool().execute(
        ConfluenceSpaceSetStatusTool.input_model(
            target_ids=[target_id],
            status="tasked",
            finding_count=0,
        ),
        ToolContext(evidence_dir=tmp_path, metadata=metadata),
    ))
    assert isinstance(status_res, ToolSuccess)
    assert "scan recommended skipped" in status_res.content
    row = sd.confluence_space_target_get(target_id)
    assert row is not None
    assert row["status"] == "skipped"
    assert "403" in row["last_reason"]


def test_confluence_explicit_page_candidates_beyond_max_pages_are_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("L" * 36)
    fetch_calls: list[str] = []

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit page scan must not run CQL search"),
        ),
    )

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        if page_id != "100":
            raise AssertionError("explicit page beyond max_pages must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "page_ids": ["100", "101"],
        "max_pages": 1,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["pages"] == ["100"]
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["candidate_sources"] == {"explicit_page": 1}
    assert payload["api_search"]["detail_source_counts"] == {"explicit_page": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_page": {"skipped": 1, "fetched": 1},
    }
    assert fetch_calls == ["100"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == [
        {
            "page_id": "101",
            "space_key": "",
            "title": "101",
            "url": "",
            "version": 0,
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "scan_method": "api_page_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate beyond max_pages",
        },
        {
            "page_id": "100",
            "space_key": "",
            "title": "100",
            "url": "",
            "version": 0,
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "scan_method": "api_page_detail_scan",
            "status": "fetched",
            "body_present": True,
        },
    ]
    assert len(core_state.finding_list(task_type="confluence", limit=10)) == 1


def test_confluence_explicit_subresource_candidates_beyond_max_pages_are_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("S" * 36)
    fetch_calls: list[str] = []

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit subresource scan must not run CQL search"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit subresource scan must not list pages"),
        ),
    )

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        if page_id != "100":
            raise AssertionError("subresource beyond max_pages must not fetch page body")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(
        sht.cf,
        "fetch_comment_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("comment beyond max_pages must not be fetched"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body_version",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page version beyond max_pages must not be fetched"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment beyond max_pages must not list attachments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_attachment_text",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment beyond max_pages must not be fetched"),
        ),
    )

    res = _run({
        "page_ids": ["100"],
        "comment_ids": [{"page_id": "101", "comment_id": "9001"}],
        "page_versions": [{"page_id": "102", "version": 7}],
        "attachment_downloads": [
            {
                "page_id": "103",
                "download_url": "/download/attachments/103/secret.env",
            },
        ],
        "max_pages": 1,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["pages"] == ["100"]
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["candidate_sources"] == {"explicit_page": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {
        "page": {"fetched": 1},
        "comment": {"skipped": 1},
        "version": {"skipped": 1},
        "attachment": {"skipped": 1},
    }
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_page": {"fetched": 1},
        "explicit_comment": {"skipped": 1},
        "explicit_page_version": {"skipped": 1},
        "explicit_attachment": {"skipped": 1},
    }
    assert fetch_calls == ["100"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["comment_details"] == [{
        "page_id": "101",
        "space_key": "",
        "page_title": "101",
        "comment_id": "9001",
        "candidate_source": "explicit_comment",
        "candidate_query": "",
        "status": "skipped",
        "error": "Confluence comment candidate beyond max_pages",
    }]
    assert evidence["version_details"] == [{
        "page_id": "102",
        "space_key": "",
        "page_title": "102",
        "version": 7,
        "candidate_source": "explicit_page_version",
        "candidate_query": "",
        "status": "skipped",
        "error": "Confluence page version candidate beyond max_pages",
    }]
    assert evidence["attachment_details"] == [{
        "page_id": "103",
        "space_key": "",
        "page_title": "103",
        "download_url": "/download/attachments/103/secret.env",
        "candidate_source": "explicit_attachment",
        "candidate_query": "",
        "status": "skipped",
        "error": "Confluence attachment candidate beyond max_pages",
    }]
    assert len(core_state.finding_list(task_type="confluence", limit=10)) == 1


def test_confluence_cql_blank_page_body_counts_missing_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="405", title="Blank", space_key="OPS", version=1, url="/display/OPS/Blank"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: " \n\t")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 1
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_list_page_fallback_detail_missing_is_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda space_key, limit=50: [
            CfPage(
                id="88",
                title="Legacy Password Runbook",
                space_key=space_key,
                version=1,
                url="/display/OPS/Legacy",
            ),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL search must not run when api_search_first is false"),
        ),
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: None)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": False,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["target_count"] == 1
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert payload["api_search"]["fallback_list_pages"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_status_counts"] == {"missing": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {"page": {"missing": 1}}
    assert payload["api_search"]["detail_status_total"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_status_counts"] == payload["api_search"]["detail_status_counts"]
    assert evidence["api_search"]["detail_status_by_kind"] == payload["api_search"]["detail_status_by_kind"]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_list_page_fallback_missing_space_key_is_error(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda space_key, limit=50: [
            CfPage(
                id="88",
                title="Legacy Password Runbook",
                space_key="",
                version=1,
                url="/display/OPS/Legacy",
            ),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL search must not run when api_search_first is false"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must not run for malformed fallback pages"),
        ),
    )

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": False,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["target_count"] == 0
    assert payload["scan_status"] == "ok"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["errors"] == []
    assert payload["errors"] == []
    assert payload["api_search"]["detail_status_counts"] == {"skipped": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {"page": {"skipped": 1}}
    assert payload["api_search"]["detail_status_by_source"] == {"space_list": {"skipped": 1}}
    assert payload["api_search"]["detail_status_total"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_status_counts"] == payload["api_search"]["detail_status_counts"]
    assert evidence["api_search"]["detail_status_by_kind"] == payload["api_search"]["detail_status_by_kind"]
    assert evidence["page_details"] == [{
        "page_id": "88",
        "space_key": "",
        "target_space_key": "OPS",
        "title": "Legacy Password Runbook",
        "url": "/display/OPS/Legacy",
        "version": 1,
        "candidate_source": "space_list",
        "candidate_query": "",
        "scan_method": "api_page_detail_scan",
        "status": "skipped",
        "error": "Confluence page candidate out of requested space scope",
    }]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_list_page_fallback_detail_success_counts_fetched(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("L" * 36)
    fetch_calls: list[str] = []
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda space_key, limit=50: [
            CfPage(
                id="89",
                title="Legacy Password Runbook",
                space_key=space_key,
                version=1,
                url="/display/OPS/Legacy",
            ),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL search must not run when api_search_first is false"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda page_id: fetch_calls.append(page_id) or f"GITHUB_TOKEN={token}\n",
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": False,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["fallback_list_pages"] == 1
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_missing"] == 0
    assert payload["api_search"]["detail_status_counts"] == {"fetched": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {"page": {"fetched": 1}}
    assert payload["api_search"]["detail_status_total"] == 1
    assert fetch_calls == ["89"]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:OPS:89"
    assert row["extra"]["metadata"]["candidate_source"] == "space_list"
    assert row["extra"]["metadata"]["scan_method"] == "api_page_detail_scan"


def test_confluence_list_page_fallback_filters_out_of_scope_pages_before_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("M" * 36)
    fetch_calls: list[str] = []
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda space_key, limit=50: [
            CfPage(
                id="90",
                title="Wrong Space Runbook",
                space_key="OTHER",
                version=1,
                url="/display/OTHER/Legacy",
            ),
            CfPage(
                id="91",
                title="Scoped Runbook",
                space_key=space_key,
                version=1,
                url="/display/OPS/Scoped",
            ),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL search must not run when api_search_first is false"),
        ),
    )

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        if page_id == "90":
            raise AssertionError("out-of-scope fallback page must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": False,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["pages"] == ["91"]
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["fallback_list_pages"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_list": {"skipped": 1, "fetched": 1},
    }
    assert fetch_calls == ["91"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"][0] == {
        "page_id": "90",
        "space_key": "OTHER",
        "target_space_key": "OPS",
        "title": "Wrong Space Runbook",
        "url": "/display/OTHER/Legacy",
        "version": 1,
        "candidate_source": "space_list",
        "candidate_query": "",
        "scan_method": "api_page_detail_scan",
        "status": "skipped",
        "error": "Confluence page candidate out of requested space scope",
    }
    assert evidence["page_details"][1]["page_id"] == "91"
    assert evidence["page_details"][1]["status"] == "fetched"

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:OPS:91"
    assert row["extra"]["metadata"]["candidate_source"] == "space_list"


def test_confluence_cql_fallback_records_out_of_scope_page_skip(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("N" * 36)
    fetch_calls: list[str] = []
    monkeypatch.setattr(sht.cf, "cql_search", lambda cql, limit=100: [])
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda space_key, limit=50: [
            CfPage(
                id="90",
                title="Wrong Space Runbook",
                space_key="OTHER",
                version=1,
                url="/display/OTHER/Legacy",
            ),
            CfPage(
                id="91",
                title="Scoped Runbook",
                space_key=space_key,
                version=1,
                url="/display/OPS/Scoped",
            ),
        ],
    )

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        if page_id == "90":
            raise AssertionError("out-of-scope fallback page must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["out_of_scope_count"] == 1
    fallback_attempt = payload["api_search"]["fallback_attempts"][0]
    assert fallback_attempt["returned"] == 2
    assert fallback_attempt["added"] == 1
    assert fallback_attempt["out_of_scope"] == 1
    assert fallback_attempt["invalid"] == 0
    assert fallback_attempt["duplicate"] == 0
    assert fallback_attempt["skipped"] == 1
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_list": {"skipped": 1, "fetched": 1},
    }
    assert fetch_calls == ["91"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"][0] == {
        "page_id": "90",
        "space_key": "OTHER",
        "target_space_key": "OPS",
        "title": "Wrong Space Runbook",
        "url": "/display/OTHER/Legacy",
        "version": 1,
        "candidate_source": "space_list",
        "candidate_query": "no_api_candidates",
        "scan_method": "api_page_detail_scan",
        "status": "skipped",
        "error": "Confluence page candidate out of requested space scope",
    }
    assert evidence["page_details"][1]["page_id"] == "91"
    assert evidence["page_details"][1]["status"] == "fetched"

    rows = core_state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "confluence:OPS:91"


def test_confluence_cql_detail_error_is_not_treated_as_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class PageBodyFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    cql_calls: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        cql_calls.append((cql, limit))
        return [
            CfPage(id="403", title="Denied", space_key="OPS", version=1, url="/display/OPS/Denied"),
        ]

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL detail fetch failure must not use page-list fallback"),
        ),
    )

    def denied_fetch(page_id: str) -> str:
        fetch_calls.append(page_id)
        raise PageBodyFailure("Confluence page body HTTP 503")

    monkeypatch.setattr(sht.cf, "fetch_page_body", denied_fetch)
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL page-body failure must not list comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL page-body failure must not list history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL page-body failure must not list attachments"),
        ),
    )

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": True,
        "scan_comments": True,
        "scan_history": True,
    }, tmp_path)

    payload = json.loads(res.content)
    query = 'space = "OPS" AND type = page AND text ~ "password"'
    assert cql_calls == [
        (query, 25),
        ('space = "OPS" AND type = page AND title ~ "password"', 25),
    ]
    assert fetch_calls == ["403"]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "HTTP 503" in payload["status_reason"]
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 0
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_page_body"
    assert payload["api_search"]["detail_errors"][0]["target"] == "403"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_page_body": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "space_cql": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        query: 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {
        "503": 1,
    }
    assert payload["errors"][0]["phase"] == "fetch_page_body"
    assert payload["errors"][0]["status_code"] == 503

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    errored = [detail for detail in evidence["page_details"] if detail["status"] == "error"]
    skipped = [detail for detail in evidence["page_details"] if detail["status"] == "skipped"]
    assert errored == [{
        "page_id": "403",
        "space_key": "OPS",
        "title": "Denied",
        "url": "/display/OPS/Denied",
        "version": 1,
        "candidate_source": "space_cql",
        "candidate_query": query,
        "scan_method": "api_cql_search_detail_scan",
        "status": "error",
        "status_code": 503,
        "error": "PageBodyFailure('Confluence page body HTTP 503')",
    }]
    assert skipped == [{
        "page_id": "403",
        "space_key": "OPS",
        "title": "Denied",
        "url": "/display/OPS/Denied",
        "version": 1,
        "candidate_source": "space_cql",
        "candidate_query": 'space = "OPS" AND type = page AND title ~ "password"',
        "scan_method": "api_cql_search_detail_scan",
        "status": "skipped",
        "error": "duplicate page candidate",
    }]
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_cql_failure_does_not_fallback_to_full_page_listing(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.plugin.tools.confluence_space_discovery_tool import (
        ConfluenceSpaceSetStatusTool,
    )
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    metadata: dict[str, Any] = {}

    def fail_cql(cql: str, *, limit: int = 100):
        raise RuntimeError("cql unavailable")

    monkeypatch.setattr(sht.cf, "cql_search", fail_cql)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("full page listing fallback must not run"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must wait for CQL candidates"),
        ),
    )

    target_id = sd.confluence_space_target_upsert("OPS")
    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata=metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "cql unavailable" in payload["status_reason"]
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["errors"][0]["target"].startswith("cql:")
    assert payload["errors"][0]["phase"] == "cql_search"
    assert payload["api_search"]["errors"][0]["phase"] == "cql_search"
    assert metadata["_confluence_task_scan_status"] == "error"
    assert metadata["_confluence_task_scan_recommended_status"] == "error"
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    status_res = asyncio.run(ConfluenceSpaceSetStatusTool().execute(
        ConfluenceSpaceSetStatusTool.input_model(
            target_ids=[target_id],
            status="tasked",
            finding_count=0,
        ),
        ToolContext(evidence_dir=tmp_path, metadata=metadata),
    ))
    assert isinstance(status_res, ToolSuccess)
    assert "scan recommended error" in status_res.content
    row = sd.confluence_space_target_get(target_id)
    assert row is not None
    assert row["status"] == "error"
    assert "cql unavailable" in row["last_reason"]


def test_confluence_space_cql_auth_failure_does_not_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import service.state_domain as sd
    from domains.services.confluence.plugin.tools.confluence_space_discovery_tool import (
        ConfluenceSpaceSetStatusTool,
    )
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    metadata: dict[str, Any] = {}

    def fail_cql(cql: str, *, limit: int = 100):
        request = httpx.Request("GET", "https://cf.test/rest/api/content/search")
        response = httpx.Response(401, request=request, json={"message": "Unauthorized"})
        raise httpx.HTTPStatusError("401 Unauthorized", request=request, response=response)

    monkeypatch.setattr(sht.cf, "cql_search", fail_cql)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("auth failure must not use full page listing fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("auth failure must not continue to detail fetch"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("auth failure must not continue to comment detail"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("auth failure must not continue to history detail"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("auth failure must not continue to attachment detail"),
        ),
    )

    target_id = sd.confluence_space_target_upsert("OPS")
    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": True,
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path, metadata=metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "401 Unauthorized" in payload["status_reason"]
    assert payload["api_search"]["auth_failed"] is True
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["errors"][0]["phase"] == "cql_search"
    assert payload["errors"][0]["status_code"] == 401
    assert payload["api_search"]["errors"][0]["status_code"] == 401
    assert metadata["_confluence_task_scan_status"] == "error"
    assert metadata["_confluence_task_scan_recommended_status"] == "error"
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    status_res = asyncio.run(ConfluenceSpaceSetStatusTool().execute(
        ConfluenceSpaceSetStatusTool.input_model(
            target_ids=[target_id],
            status="tasked",
            finding_count=0,
        ),
        ToolContext(evidence_dir=tmp_path, metadata=metadata),
    ))
    assert isinstance(status_res, ToolSuccess)
    assert "scan recommended error" in status_res.content
    row = sd.confluence_space_target_get(target_id)
    assert row is not None
    assert row["status"] == "error"
    assert "401 Unauthorized" in row["last_reason"]


def test_confluence_page_body_auth_failure_stops_subresource_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="42", title="Runbook", space_key="OPS", version=7, url="/display/OPS/R"),
        ],
    )

    def fetch_page_body(page_id: str):
        request = httpx.Request("GET", f"https://cf.test/rest/api/content/{page_id}")
        response = httpx.Response(401, request=request, json={"message": "Unauthorized"})
        raise httpx.HTTPStatusError("401 Unauthorized", request=request, response=response)

    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("auth failure must not continue to comment detail"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("auth failure must not continue to history detail"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("auth failure must not continue to attachment detail"),
        ),
    )

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": True,
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "401 Unauthorized" in payload["status_reason"]
    assert payload["api_search"]["auth_failed"] is True
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 0
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_page_body"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 401
    assert payload["errors"][0]["phase"] == "fetch_page_body"
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_space_cql_no_candidates_uses_bounded_page_listing_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("N" * 36)
    queries: list[str] = []
    list_calls: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append(cql)
        return []

    def list_pages(space_key: str, *, limit: int = 50) -> list[CfPage]:
        list_calls.append((space_key, limit))
        return [
            CfPage(
                id="88",
                title="Password Runbook",
                space_key=space_key,
                version=3,
                url="/display/OPS/Password",
            ),
            CfPage(
                id="89",
                title="Plain Notes",
                space_key=space_key,
                version=4,
                url="/display/OPS/Plain",
            ),
        ]

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(sht.cf, "list_pages", list_pages)
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda page_id: fetch_calls.append(page_id) or f"GITHUB_TOKEN={token}\n",
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "page_limit_per_space": 2,
        "max_pages": 1,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert len(queries) == 2
    assert list_calls == [("OPS", 2)]
    assert fetch_calls == ["88"]
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_list_pages"] == 1
    assert len(payload["api_search"]["fallback_attempts"]) == 1
    fallback_attempt = payload["api_search"]["fallback_attempts"][0]
    assert fallback_attempt["space_key"] == "OPS"
    assert fallback_attempt["reason"] == "no_api_candidates"
    assert fallback_attempt["returned"] == 2
    assert fallback_attempt["added"] == 1
    assert fallback_attempt["candidate_limit_hit"] is True
    assert fallback_attempt["limit_skipped"] == 1
    assert fallback_attempt["skipped"] == 1
    assert payload["api_search"]["fallback_status_counts"] == {"searched": 1}
    assert payload["api_search"]["fallback_reason_counts"] == {"no_api_candidates": 1}
    assert payload["api_search"]["fallback_candidate_totals"] == {
        "returned": 2,
        "selected": 0,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "limit_skipped": 1,
        "skipped": 1,
    }
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"space_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_list": {"skipped": 1, "fetched": 1},
    }
    assert payload["api_search"]["detail_query_counts"] == {
        "no_api_candidates": 1,
        "(no query)": 1,
    }
    assert payload["api_search"]["detail_status_by_query"] == {
        "no_api_candidates": {"skipped": 1},
        "(no query)": {"fetched": 1},
    }
    assert payload["api_search"]["target_status_counts"] == {"selected": 1}
    assert payload["api_search"]["target_source_counts"] == {"space_list": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "space_list": {"selected": 1},
    }
    scan_summary = payload["api_search"]["scan_summary"]
    assert scan_summary["artifact_count"] == 1
    assert scan_summary["artifact_source_counts"] == {"space_list": 1}
    assert scan_summary["hit_artifact_count"] == 1
    assert scan_summary["hit_source_counts"] == {"space_list": 1}
    assert scan_summary["reportable_artifact_count"] == 1
    assert scan_summary["reportable_source_counts"] == {"space_list": 1}
    assert scan_summary["low_value_only_artifact_count"] == 0
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_count"] == payload["target_count"]
    assert evidence["targets"] == payload["pages"]
    assert evidence["target_details"] == [{
        "id": "88",
        "space_key": "OPS",
        "title": "Password Runbook",
        "candidate_source": "space_list",
        "candidate_query": "",
    }]
    assert evidence["page_details"] == [
        {
            "page_id": "89",
            "space_key": "OPS",
            "title": "Plain Notes",
            "url": "/display/OPS/Plain",
            "version": 4,
            "candidate_source": "space_list",
            "candidate_query": "no_api_candidates",
            "scan_method": "api_page_detail_scan",
            "status": "skipped",
            "error": "Confluence page-list candidate beyond max_pages",
        },
        {
            "page_id": "88",
            "space_key": "OPS",
            "title": "Password Runbook",
            "url": "/display/OPS/Password",
            "version": 3,
            "candidate_source": "space_list",
            "candidate_query": "",
            "scan_method": "api_page_detail_scan",
            "status": "fetched",
            "body_present": True,
        },
    ]
    assert evidence["api_search"]["fallback_attempts"] == payload["api_search"]["fallback_attempts"]
    assert evidence["api_search"]["fallback_reason"] == "no_api_candidates"
    assert evidence["api_search"]["fallback_list_pages"] == 1
    assert evidence["api_search"]["fallback_status_counts"] == payload["api_search"]["fallback_status_counts"]
    assert evidence["api_search"]["fallback_reason_counts"] == payload["api_search"]["fallback_reason_counts"]
    assert evidence["api_search"]["fallback_candidate_totals"] == payload["api_search"]["fallback_candidate_totals"]
    assert evidence["api_search"]["detail_source_counts"] == payload["api_search"]["detail_source_counts"]
    assert evidence["api_search"]["detail_status_by_source"] == payload["api_search"]["detail_status_by_source"]
    assert evidence["api_search"]["detail_query_counts"] == payload["api_search"]["detail_query_counts"]
    assert evidence["api_search"]["detail_status_by_query"] == payload["api_search"]["detail_status_by_query"]
    assert evidence["api_search"]["target_status_counts"] == payload["api_search"]["target_status_counts"]
    assert evidence["api_search"]["target_source_counts"] == payload["api_search"]["target_source_counts"]
    assert evidence["api_search"]["target_status_by_source"] == payload["api_search"]["target_status_by_source"]
    assert evidence["api_search"]["scan_summary"] == payload["api_search"]["scan_summary"]
    assert evidence["scan_status"] == payload["scan_status"]
    assert evidence["recommended_target_status"] == payload["recommended_target_status"]
    assert evidence["status_reason"] == payload["status_reason"]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:OPS:88"
    assert row["extra"]["metadata"]["candidate_source"] == "space_list"
    assert row["extra"]["metadata"]["scan_method"] == "api_page_detail_scan"


def test_confluence_space_cql_out_of_scope_only_uses_scoped_listing_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("S" * 36)
    queries: list[str] = []
    list_calls: list[tuple[str, int]] = []
    fetch_calls: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
        queries.append(cql)
        return [
            CfPage(
                id="99",
                title="Other Space Password Runbook",
                space_key="OTHER",
                version=1,
                url="/display/OTHER/Password",
            ),
        ]

    def list_pages(space_key: str, *, limit: int = 50) -> list[CfPage]:
        list_calls.append((space_key, limit))
        return [
            CfPage(
                id="42",
                title="Password Runbook",
                space_key=space_key,
                version=7,
                url="/display/OPS/Password",
            ),
            CfPage(
                id="43",
                title="Plain Notes",
                space_key=space_key,
                version=8,
                url="/display/OPS/Plain",
            ),
        ]

    def fetch_page_body(page_id: str) -> str:
        fetch_calls.append(page_id)
        if page_id == "99":
            raise AssertionError("out-of-scope CQL candidate must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(sht.cf, "list_pages", list_pages)
    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "page_limit_per_space": 2,
        "max_pages": 1,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["pages"] == ["42"]
    assert len(queries) == 2
    assert list_calls == [("OPS", 2)]
    assert fetch_calls == ["42"]
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 2
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_list_pages"] == 1
    assert len(payload["api_search"]["fallback_attempts"]) == 1
    fallback_attempt = payload["api_search"]["fallback_attempts"][0]
    assert fallback_attempt["space_key"] == "OPS"
    assert fallback_attempt["reason"] == "no_api_candidates"
    assert fallback_attempt["returned"] == 2
    assert fallback_attempt["added"] == 1
    assert fallback_attempt["candidate_limit_hit"] is True
    assert fallback_attempt["limit_skipped"] == 1
    assert fallback_attempt["skipped"] == 1
    assert payload["api_search"]["detail_fetched"] == 1

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:OPS:42"
    assert row["extra"]["metadata"]["candidate_source"] == "space_list"
    assert row["extra"]["metadata"]["scan_method"] == "api_page_detail_scan"


def test_confluence_space_cql_no_candidates_fallback_listing_error_keeps_reason(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    queries: list[str] = []

    def cql_search(cql: str, *, limit: int = 100) -> list[object]:
        queries.append(cql)
        return []

    def fail_list_pages(space_key: str, *, limit: int = 50):
        raise RuntimeError("page listing timeout after empty CQL")

    monkeypatch.setattr(sht.cf, "cql_search", cql_search)
    monkeypatch.setattr(sht.cf, "list_pages", fail_list_pages)
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must wait for page candidates"),
        ),
    )

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "page listing timeout after empty CQL" in payload["status_reason"]
    assert len(queries) == 2
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert len(payload["api_search"]["fallback_attempts"]) == 1
    fallback_attempt = payload["api_search"]["fallback_attempts"][0]
    assert fallback_attempt["space_key"] == "OPS"
    assert fallback_attempt["reason"] == "no_api_candidates"
    assert fallback_attempt["returned"] == 0
    assert fallback_attempt["added"] == 0
    assert fallback_attempt["phase"] == "list_pages"
    assert "page listing timeout after empty CQL" in fallback_attempt["error"]
    assert payload["api_search"]["fallback_status_counts"] == {"error": 1}
    assert payload["api_search"]["fallback_reason_counts"] == {"no_api_candidates": 1}
    assert payload["api_search"]["fallback_candidate_totals"] == {
        "returned": 0,
        "selected": 0,
        "added": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "limit_skipped": 0,
        "skipped": 0,
    }
    assert payload["errors"][0]["phase"] == "list_pages"
    assert payload["api_search"]["errors"][0]["phase"] == "list_pages"
    assert core_state.finding_list(task_type="confluence", limit=10) == []
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["fallback_status_counts"] == payload["api_search"]["fallback_status_counts"]
    assert evidence["api_search"]["fallback_reason_counts"] == payload["api_search"]["fallback_reason_counts"]
    assert evidence["api_search"]["fallback_candidate_totals"] == payload["api_search"]["fallback_candidate_totals"]
    assert evidence["target_details"] == [{
        "space_key": "OPS",
        "source": "list_pages",
        "fallback_reason": "no_api_candidates",
        "status": "error",
        "phase": "list_pages",
        "status_code": None,
        "error": "RuntimeError('page listing timeout after empty CQL')",
    }]


def test_confluence_cql_http_error_is_not_treated_as_no_candidates(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    def client_factory():
        def handler(req: httpx.Request) -> httpx.Response:
            assert req.url.path == "/rest/api/content/search"
            return httpx.Response(500, json={"message": "search backend down"})

        return httpx.Client(
            transport=httpx.MockTransport(handler),
            base_url="https://cf.test",
        )

    monkeypatch.setattr(sht.cf, "_client", client_factory)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("full page listing fallback must not run"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must wait for CQL candidates"),
        ),
    )

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "HTTP 500" in payload["status_reason"]
    assert payload["errors"][0]["phase"] == "cql_search"
    assert payload["api_search"]["errors"][0]["phase"] == "cql_search"
    assert payload["api_search"]["query_details"][0]["query"] == (
        'space = "OPS" AND type = page AND text ~ "password"'
    )
    assert payload["api_search"]["query_details"][0]["source"] == "space_cql"
    assert payload["api_search"]["query_details"][0]["space_key"] == "OPS"
    assert payload["api_search"]["query_details"][0]["status"] == "error"
    assert payload["api_search"]["query_details"][0]["phase"] == "cql_search"
    assert payload["api_search"]["query_details"][0]["status_code"] == 500
    assert "HTTP 500" in payload["api_search"]["query_details"][0]["error"]
    assert payload["api_search"]["query_status_counts"] == {"error": 2}
    assert payload["api_search"]["query_candidate_totals"] == {
        "returned": 0,
        "added": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_space_cql_404_recommends_skipped_without_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.tools.confluence_space_discovery_tool import (
        ConfluenceSpaceSetStatusTool,
    )
    from domains.services.plugin.tools import service_task_tools as sht
    import service.state_domain as sd
    from secu_agent import state as core_state

    metadata: dict[str, Any] = {}

    def client_factory():
        def handler(req: httpx.Request) -> httpx.Response:
            assert req.url.path == "/rest/api/content/search"
            return httpx.Response(404, json={"message": "space not found"})

        return httpx.Client(
            transport=httpx.MockTransport(handler),
            base_url="https://cf.test",
        )

    monkeypatch.setattr(sht.cf, "_client", client_factory)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("full page listing fallback must not run"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must wait for CQL candidates"),
        ),
    )

    target_id = sd.confluence_space_target_upsert("OPS")
    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata=metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "HTTP 404" in payload["status_reason"]
    assert payload["errors"][0]["phase"] == "cql_search"
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert metadata["_confluence_task_scan_recommended_status"] == "skipped"
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    status_res = asyncio.run(ConfluenceSpaceSetStatusTool().execute(
        ConfluenceSpaceSetStatusTool.input_model(
            target_ids=[target_id],
            status="tasked",
            finding_count=0,
        ),
        ToolContext(evidence_dir=tmp_path, metadata=metadata),
    ))
    assert isinstance(status_res, ToolSuccess)
    assert "scan recommended skipped" in status_res.content
    row = sd.confluence_space_target_get(target_id)
    assert row is not None
    assert row["status"] == "skipped"
    assert "HTTP 404" in row["last_reason"]


def test_confluence_space_cql_403_http_status_recommends_skipped_without_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.tools.confluence_space_discovery_tool import (
        ConfluenceSpaceSetStatusTool,
    )
    from domains.services.plugin.tools import service_task_tools as sht
    import service.state_domain as sd
    from secu_agent import state as core_state

    metadata: dict[str, Any] = {}

    def deny_cql(cql: str, *, limit: int = 100):
        request = httpx.Request("GET", "https://cf.test/rest/api/content/search")
        response = httpx.Response(403, request=request, json={"message": "Forbidden"})
        raise httpx.HTTPStatusError("403 Forbidden", request=request, response=response)

    monkeypatch.setattr(sht.cf, "cql_search", deny_cql)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("full page listing fallback must not run"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must wait for CQL candidates"),
        ),
    )

    target_id = sd.confluence_space_target_upsert("OPS")
    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata=metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["errors"][0]["phase"] == "cql_search"
    assert payload["errors"][0]["status_code"] == 403
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["errors"][0]["status_code"] == 403
    assert metadata["_confluence_task_scan_recommended_status"] == "skipped"
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    status_res = asyncio.run(ConfluenceSpaceSetStatusTool().execute(
        ConfluenceSpaceSetStatusTool.input_model(
            target_ids=[target_id],
            status="tasked",
            finding_count=0,
        ),
        ToolContext(evidence_dir=tmp_path, metadata=metadata),
    ))
    assert isinstance(status_res, ToolSuccess)
    assert "scan recommended skipped" in status_res.content
    row = sd.confluence_space_target_get(target_id)
    assert row is not None
    assert row["status"] == "skipped"
    assert "403" in row["last_reason"]


def test_confluence_all_spaces_enum_http_error_is_not_treated_as_empty(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    def client_factory():
        def handler(req: httpx.Request) -> httpx.Response:
            assert req.url.path == "/rest/api/space"
            return httpx.Response(503, json={"message": "space enum unavailable"})

        return httpx.Client(
            transport=httpx.MockTransport(handler),
            base_url="https://cf.test",
        )

    monkeypatch.setattr(sht.cf, "_client", client_factory)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL search must wait for all_spaces enum"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("page listing must wait for all_spaces enum"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must wait for all_spaces enum"),
        ),
    )

    res = _run({
        "all_spaces": True,
        "api_search_first": True,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "HTTP 503" in payload["status_reason"]
    assert payload["errors"][0]["phase"] == "list_spaces"
    assert payload["errors"][0]["target"] == "all_spaces"
    assert payload["api_search"]["errors"][0]["phase"] == "list_spaces"
    assert payload["api_search"]["target_status_counts"] == {"error": 1}
    assert payload["api_search"]["target_source_counts"] == {"list_spaces": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "list_spaces": {"error": 1},
    }
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert core_state.finding_list(task_type="confluence", limit=10) == []
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["target_status_counts"] == payload["api_search"]["target_status_counts"]
    assert evidence["api_search"]["target_source_counts"] == payload["api_search"]["target_source_counts"]
    assert evidence["api_search"]["target_status_by_source"] == payload["api_search"]["target_status_by_source"]
    assert len(evidence["target_details"]) == 1
    target_detail = evidence["target_details"][0]
    assert target_detail["space_key"] == ""
    assert target_detail["target"] == "all_spaces"
    assert target_detail["source"] == "list_spaces"
    assert target_detail["status"] == "error"
    assert target_detail["phase"] == "list_spaces"
    assert target_detail["status_code"] == 503
    assert "HTTP 503" in target_detail["error"]


def test_confluence_list_page_fallback_error_is_structured(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    def fail_list_pages(space_key: str, *, limit: int = 50):
        raise RuntimeError("page listing timeout")

    monkeypatch.setattr(sht.cf, "list_pages", fail_list_pages)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL search must not run when api_search_first is false"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must wait for page candidates"),
        ),
    )

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": False,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "page listing timeout" in payload["status_reason"]
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["errors"][0]["phase"] == "list_pages"
    assert payload["errors"][0]["target"] == "OPS"
    assert payload["api_search"]["errors"][0]["phase"] == "list_pages"
    assert core_state.finding_list(task_type="confluence", limit=10) == []
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "space_key": "OPS",
        "source": "list_pages",
        "fallback_reason": "",
        "status": "error",
        "phase": "list_pages",
        "status_code": None,
        "error": "RuntimeError('page listing timeout')",
    }]


def test_confluence_list_page_fallback_404_recommends_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.tools.confluence_space_discovery_tool import (
        ConfluenceSpaceSetStatusTool,
    )
    from domains.services.plugin.tools import service_task_tools as sht
    import service.state_domain as sd
    from secu_agent import state as core_state

    metadata: dict[str, Any] = {}

    def fail_list_pages(space_key: str, *, limit: int = 50):
        raise RuntimeError("Confluence list_pages HTTP 404: space not found")

    monkeypatch.setattr(sht.cf, "list_pages", fail_list_pages)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL search must not run when api_search_first is false"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must wait for page candidates"),
        ),
    )

    target_id = sd.confluence_space_target_upsert("OPS")
    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": False,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata=metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "HTTP 404" in payload["status_reason"]
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["errors"][0]["phase"] == "list_pages"
    assert payload["errors"][0]["target"] == "OPS"
    assert payload["api_search"]["errors"][0]["phase"] == "list_pages"
    assert metadata["_confluence_task_scan_recommended_status"] == "skipped"
    assert core_state.finding_list(task_type="confluence", limit=10) == []
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "space_key": "OPS",
        "source": "list_pages",
        "fallback_reason": "",
        "status": "error",
        "phase": "list_pages",
        "status_code": 404,
        "error": "RuntimeError('Confluence list_pages HTTP 404: space not found')",
    }]

    status_res = asyncio.run(ConfluenceSpaceSetStatusTool().execute(
        ConfluenceSpaceSetStatusTool.input_model(
            target_ids=[target_id],
            status="tasked",
            finding_count=0,
        ),
        ToolContext(evidence_dir=tmp_path, metadata=metadata),
    ))
    assert isinstance(status_res, ToolSuccess)
    assert "scan recommended skipped" in status_res.content
    row = sd.confluence_space_target_get(target_id)
    assert row is not None
    assert row["status"] == "skipped"
    assert "HTTP 404" in row["last_reason"]


def test_confluence_list_page_fallback_403_http_status_recommends_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.tools.confluence_space_discovery_tool import (
        ConfluenceSpaceSetStatusTool,
    )
    from domains.services.plugin.tools import service_task_tools as sht
    import service.state_domain as sd
    from secu_agent import state as core_state

    metadata: dict[str, Any] = {}

    def deny_list_pages(space_key: str, *, limit: int = 50):
        request = httpx.Request("GET", f"https://cf.test/rest/api/space/{space_key}/content/page")
        response = httpx.Response(403, request=request, json={"message": "Forbidden"})
        raise httpx.HTTPStatusError("403 Forbidden", request=request, response=response)

    monkeypatch.setattr(sht.cf, "list_pages", deny_list_pages)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL search must not run when api_search_first is false"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must wait for page candidates"),
        ),
    )

    target_id = sd.confluence_space_target_upsert("OPS")
    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": False,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata=metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["errors"][0]["phase"] == "list_pages"
    assert payload["errors"][0]["target"] == "OPS"
    assert payload["errors"][0]["status_code"] == 403
    assert payload["api_search"]["errors"][0]["status_code"] == 403
    assert metadata["_confluence_task_scan_recommended_status"] == "skipped"
    assert core_state.finding_list(task_type="confluence", limit=10) == []
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "space_key": "OPS",
        "source": "list_pages",
        "fallback_reason": "",
        "status": "error",
        "phase": "list_pages",
        "status_code": 403,
        "error": "HTTPStatusError('403 Forbidden')",
    }]

    status_res = asyncio.run(ConfluenceSpaceSetStatusTool().execute(
        ConfluenceSpaceSetStatusTool.input_model(
            target_ids=[target_id],
            status="tasked",
            finding_count=0,
        ),
        ToolContext(evidence_dir=tmp_path, metadata=metadata),
    ))
    assert isinstance(status_res, ToolSuccess)
    assert "scan recommended skipped" in status_res.content
    row = sd.confluence_space_target_get(target_id)
    assert row is not None
    assert row["status"] == "skipped"
    assert "403" in row["last_reason"]


def test_confluence_cql_candidate_scans_text_attachment_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment, CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("B" * 36)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="55", title="Deploy", space_key="SEC", version=3, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "첨부 참고\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="a1",
                filename="deploy.env",
                media_type="text/plain",
                size=80,
                download_url="/download/a1",
                parent_page_id=page_id,
            ),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_attachment_text", lambda path: f"GITHUB_TOKEN={token}\n")

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["attachment_details"] == [{
        "page_id": "55",
        "space_key": "SEC",
        "page_title": "Deploy",
        "attachment_id": "a1",
        "filename": "deploy.env",
        "download_url": "/download/a1",
        "candidate_source": "space_cql",
        "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
        "status": "fetched",
        "content_present": True,
    }]
    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:SEC:55/attachment/deploy.env"
    assert row["asset_kind"] == "attachment"
    assert row["extra"]["metadata"]["candidate_source"] == "space_cql"


def test_confluence_attachment_detail_error_continues_remaining_attachments(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment, CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("F" * 36)
    fetch_calls: list[str] = []
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="55", title="Deploy", space_key="SEC", version=3, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "첨부 참고\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="a-broken",
                filename="broken.env",
                media_type="text/plain",
                size=80,
                download_url="/download/broken",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="a-live",
                filename="live.env",
                media_type="text/plain",
                size=80,
                download_url="/download/live",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(path: str) -> str:
        fetch_calls.append(path)
        if path == "/download/broken":
            raise RuntimeError("attachment download timeout")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_attachment_text"
    assert payload["api_search"]["detail_errors"][0]["filename"] == "broken.env"
    query = 'space = "SEC" AND type = page AND text ~ "deploy"'
    assert payload["api_search"]["detail_error_summary"] == {
        "total": 1,
        "by_phase": {"fetch_attachment_text": 1},
        "by_source": {"space_cql": 1},
        "by_query": {query: 1},
        "by_status_code": {},
    }
    assert payload["errors"][0]["phase"] == "fetch_attachment_text"
    assert payload["api_search"]["detail_status_by_kind"] == {
        "page": {"skipped": 1, "fetched": 1},
        "attachment": {"error": 1, "fetched": 1},
    }
    assert payload["api_search"]["detail_source_counts"] == {"space_cql": 4}
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_cql": {"skipped": 1, "fetched": 2, "error": 1},
    }
    assert fetch_calls == ["/download/broken", "/download/live"]
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_error_summary"] == payload["api_search"]["detail_error_summary"]
    assert evidence["api_search"]["detail_status_by_kind"] == payload["api_search"]["detail_status_by_kind"]
    assert evidence["api_search"]["detail_status_by_source"] == payload["api_search"]["detail_status_by_source"]
    assert evidence["attachment_details"] == [
        {
            "page_id": "55",
            "space_key": "SEC",
            "page_title": "Deploy",
            "attachment_id": "a-broken",
            "filename": "broken.env",
            "download_url": "/download/broken",
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "error",
            "status_code": None,
            "error": "RuntimeError('attachment download timeout')",
        },
        {
            "page_id": "55",
            "space_key": "SEC",
            "page_title": "Deploy",
            "attachment_id": "a-live",
            "filename": "live.env",
            "download_url": "/download/live",
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "fetched",
            "content_present": True,
        },
    ]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:SEC:55/attachment/live.env"
    assert row["asset_kind"] == "attachment"


def test_confluence_attachment_blank_detail_counts_missing(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment, CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="56", title="Deploy", space_key="SEC", version=3, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "첨부 참고\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="a-blank",
                filename="blank.env",
                media_type="text/plain",
                size=12,
                download_url="/download/blank",
                parent_page_id=page_id,
            ),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_attachment_text", lambda path: "\n  ")

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["status_reason"] == "partial detail missing=1"
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["attachment_details"] == [{
        "page_id": "56",
        "space_key": "SEC",
        "page_title": "Deploy",
        "attachment_id": "a-blank",
        "filename": "blank.env",
        "download_url": "/download/blank",
        "candidate_source": "space_cql",
        "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
        "status": "empty",
        "content_present": False,
    }]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_attachment_missing_identity_is_error_and_not_fetched(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment, CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="57", title="Deploy", space_key="SEC", version=3, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "첨부 참고\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="",
                filename="",
                media_type="text/plain",
                size=80,
                download_url="",
                parent_page_id=page_id,
            ),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_attachment_text",
        lambda path: (_ for _ in ()).throw(
            AssertionError("malformed attachment candidates must not be fetched"),
        ),
    )

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_errors"][0]["phase"] == "attachment_candidate"
    assert payload["errors"][0]["phase"] == "attachment_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["attachment_details"] == [{
        "page_id": "57",
        "space_key": "SEC",
        "page_title": "Deploy",
        "attachment_id": "",
        "filename": "",
        "download_url": "",
        "candidate_source": "space_cql",
        "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
        "status": "error",
        "error": "Confluence attachment candidate missing id, filename, or download_url",
    }]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_attachment_filters_out_of_scope_parent_before_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment, CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("N" * 36)
    fetch_calls: list[str] = []
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="55", title="Deploy", space_key="SEC", version=3, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "첨부 참고\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="bad",
                filename="bad.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/other/bad.env",
                parent_page_id="other-page",
            ),
            CfAttachment(
                id="good",
                filename="good.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/55/good.env",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(path: str) -> str:
        fetch_calls.append(path)
        if "bad.env" in path:
            raise AssertionError("out-of-scope attachment must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_cql": {"skipped": 2, "fetched": 2},
    }
    assert fetch_calls == ["/download/attachments/55/good.env"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["attachment_details"] == [
        {
            "page_id": "55",
            "space_key": "SEC",
            "page_title": "Deploy",
            "attachment_id": "bad",
            "filename": "bad.env",
            "download_url": "/download/attachments/other/bad.env",
            "fetched_page_id": "other-page",
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "skipped",
            "error": "Confluence attachment candidate out of requested page scope",
        },
        {
            "page_id": "55",
            "space_key": "SEC",
            "page_title": "Deploy",
            "attachment_id": "good",
            "filename": "good.env",
            "download_url": "/download/attachments/55/good.env",
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "fetched",
            "content_present": True,
        },
    ]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:SEC:55/attachment/good.env"
    assert row["asset_kind"] == "attachment"


def test_confluence_attachment_invalid_download_url_is_not_fetched(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment, CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="55", title="Deploy", space_key="SEC", version=3, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "첨부 참고\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="bad-url",
                filename="bad.env",
                media_type="text/plain",
                size=80,
                download_url="https://evil.example/download/attachments/55/bad.env",
                parent_page_id=page_id,
            ),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_attachment_text",
        lambda path: (_ for _ in ()).throw(
            AssertionError("invalid attachment download_url must not be fetched"),
        ),
    )

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_errors"][0]["phase"] == "attachment_candidate"
    assert payload["api_search"]["detail_errors"][0]["download_url"].startswith("https://")
    assert "invalid download_url" in payload["api_search"]["detail_errors"][0]["error"]
    assert payload["errors"][0]["phase"] == "attachment_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["attachment_details"] == [{
        "page_id": "55",
        "space_key": "SEC",
        "page_title": "Deploy",
        "attachment_id": "bad-url",
        "filename": "bad.env",
        "download_url": "https://evil.example/download/attachments/55/bad.env",
        "candidate_source": "space_cql",
        "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
        "status": "error",
        "error": "Confluence attachment candidate invalid download_url",
    }]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_attachment_download_url_outside_page_scope_is_not_fetched(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment, CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="55", title="Deploy", space_key="SEC", version=3, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "첨부 참고\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="bad-scope",
                filename="bad.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/999/bad.env",
                parent_page_id=page_id,
            ),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_attachment_text",
        lambda path: (_ for _ in ()).throw(
            AssertionError("out-of-scope attachment download_url must not be fetched"),
        ),
    )

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_errors"][0]["phase"] == "attachment_candidate"
    assert payload["api_search"]["detail_errors"][0]["download_url"] == "/download/attachments/999/bad.env"
    assert "invalid download_url" in payload["api_search"]["detail_errors"][0]["error"]
    assert payload["errors"][0]["phase"] == "attachment_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["attachment_details"] == [{
        "page_id": "55",
        "space_key": "SEC",
        "page_title": "Deploy",
        "attachment_id": "bad-scope",
        "filename": "bad.env",
        "download_url": "/download/attachments/999/bad.env",
        "candidate_source": "space_cql",
        "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
        "status": "error",
        "error": "Confluence attachment candidate invalid download_url",
    }]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_history_detail_error_continues_remaining_versions(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("H" * 36)
    version_fetch_calls: list[int] = []
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="66", title="Deploy", space_key="SEC", version=4, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "clean now")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda page_id: [3, 2, 1])

    def fetch_page_body_version(page_id: str, version: int) -> str:
        version_fetch_calls.append(version)
        if version == 3:
            raise RuntimeError("historical body timeout")
        if version == 2:
            return f"GITHUB_TOKEN={token}\n"
        return "clean now"

    monkeypatch.setattr(sht.cf, "fetch_page_body_version", fetch_page_body_version)

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_page_body_version"
    assert payload["api_search"]["detail_errors"][0]["version"] == 3
    assert payload["errors"][0]["phase"] == "fetch_page_body_version"
    assert version_fetch_calls == [3, 2, 1]
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["version_details"] == [
        {
            "page_id": "66",
            "space_key": "SEC",
            "page_title": "Deploy",
            "version": 3,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "error",
            "status_code": None,
            "error": "RuntimeError('historical body timeout')",
        },
        {
            "page_id": "66",
            "space_key": "SEC",
            "page_title": "Deploy",
            "version": 2,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "fetched",
            "content_present": True,
        },
        {
            "page_id": "66",
            "space_key": "SEC",
            "page_title": "Deploy",
            "version": 1,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "same_as_current",
            "content_present": True,
        },
    ]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:SEC:66/version/2"
    assert row["asset_kind"] == "page_version"


def test_confluence_history_secret_gone_from_current_page_is_historical(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("V" * 36)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="70", title="Deploy", space_key="SEC", version=5, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "clean current page\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda page_id: [4])
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body_version",
        lambda page_id, version: f"GITHUB_TOKEN={token}\n",
    )

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "ok"
    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:SEC:70/version/4"
    assert row["asset_kind"] == "page_version"
    assert row["extra"]["verification"] == {
        "method": "confluence_current_page_signature",
        "status": "historical_version",
        "matched_current": False,
        "surface_labels": ["70"],
        "source_version": 4,
    }


def test_confluence_history_scan_is_enabled_by_default(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("D" * 36)
    history_fetches: list[tuple[str, int]] = []
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="72", title="Deploy", space_key="SEC", version=5, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "clean current page\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda page_id: [4])

    def fetch_page_body_version(page_id: str, version: int) -> str:
        history_fetches.append((page_id, version))
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "fetch_page_body_version", fetch_page_body_version)

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "fetch_attachments": False,
        "scan_comments": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "ok"
    assert payload["api_search"]["detail_fetched"] == 2
    assert history_fetches == [("72", 4)]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:SEC:72/version/4"
    assert row["asset_kind"] == "page_version"
    assert row["extra"]["verification"]["status"] == "historical_version"


def test_confluence_explicit_page_version_fetches_exact_history_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("V" * 36)
    history_fetches: list[tuple[str, int]] = []
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit page_versions must not require CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit page_versions must not require page listing"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact page_versions must not fetch current page body"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact version URL must not depend on history listing"),
        ),
    )

    def fetch_page_body_version(page_id: str, version: int) -> str:
        history_fetches.append((page_id, version))
        return f"historical body GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "fetch_page_body_version", fetch_page_body_version)

    res = _run({
        "page_versions": [{"page_id": "90", "version": 7}],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["api_search"]["candidate_sources"] == {"explicit_page_version": 1}
    assert payload["api_search"]["detail_fetched"] == 1
    assert history_fetches == [("90", 7)]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["version_details"] == [{
        "page_id": "90",
        "space_key": "",
        "page_title": "90",
        "version": 7,
        "candidate_source": "explicit_page_version",
        "candidate_query": "",
        "status": "fetched",
        "content_present": True,
    }]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:90/version/7"
    assert row["asset_kind"] == "page_version"
    assert row["extra"]["metadata"]["candidate_source"] == "explicit_page_version"
    assert row["extra"]["verification"]["status"] == "historical_version"


def test_confluence_explicit_page_version_invalid_candidate_is_not_fetched(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid explicit page_versions must not fetch current body"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body_version",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid explicit page_versions must not fetch history body"),
        ),
    )

    res = _run({
        "page_versions": [
            {"page_id": "91", "version": ""},
            {"page_id": "bad/path", "version": 2},
        ],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["target_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert [err["phase"] for err in payload["api_search"]["detail_errors"]] == [
        "page_version_candidate",
        "page_version_candidate",
    ]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["version_details"] == [
        {
            "page_id": "91",
            "space_key": "",
            "page_title": "91",
            "version": "",
            "candidate_source": "page_versions[0]",
            "candidate_query": "",
            "status": "error",
            "error": "Confluence page version candidate missing version number",
        },
        {
            "page_id": "bad/path",
            "space_key": "",
            "page_title": "bad/path",
            "version": 2,
            "candidate_source": "page_versions[1]",
            "candidate_query": "",
            "status": "error",
            "error": "Confluence page candidate invalid id",
        },
    ]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_explicit_attachment_download_fetches_exact_match_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("A" * 36)
    fetch_calls: list[str] = []
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit attachment URLs must not require CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit attachment URLs must not require page listing"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda page_id: (_ for _ in ()).throw(
            AssertionError("explicit attachment URLs must not fetch page body"),
        ),
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="first",
                filename="first.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/55/first.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="target",
                filename="target.bin",
                media_type="application/octet-stream",
                size=100,
                download_url="/download/attachments/55/target.bin",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(path: str) -> str:
        fetch_calls.append(path)
        if path != "/download/attachments/55/target.bin":
            raise AssertionError("only the exact direct attachment URL should be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run({
        "attachment_downloads": [
            {"page_id": "55", "download_url": "/download/attachments/55/target.bin"},
        ],
        "max_attachments_per_page": 1,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["api_search"]["candidate_sources"] == {"explicit_attachment": 1}
    assert payload["api_search"]["detail_fetched"] == 1
    assert fetch_calls == ["/download/attachments/55/target.bin"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["attachment_details"] == [{
        "page_id": "55",
        "space_key": "",
        "page_title": "55",
        "attachment_id": "target",
        "filename": "target.bin",
        "download_url": "/download/attachments/55/target.bin",
        "candidate_source": "explicit_attachment",
        "candidate_query": "",
        "status": "fetched",
        "content_present": True,
    }]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:55/attachment/target.bin"
    assert row["asset_kind"] == "attachment"
    assert row["extra"]["metadata"]["candidate_source"] == "explicit_attachment"


def test_confluence_explicit_attachment_matches_encoded_download_url_variant(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("E" * 36)
    fetch_calls: list[str] = []

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("encoded exact attachment URL must not require CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("encoded exact attachment URL must not require page listing"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda page_id: (_ for _ in ()).throw(
            AssertionError("encoded exact attachment URL must not fetch page body"),
        ),
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="encoded",
                filename="prod secrets.env",
                media_type="text/plain",
                size=90,
                download_url="/download/attachments/55/prod%20secrets.env",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(path: str) -> str:
        fetch_calls.append(path)
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run({
        "attachment_downloads": [
            {"page_id": "55", "download_url": "/download/attachments/55/prod secrets.env"},
        ],
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["detail_missing"] == 0
    assert fetch_calls == ["/download/attachments/55/prod%20secrets.env"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["attachment_details"] == [{
        "page_id": "55",
        "space_key": "",
        "page_title": "55",
        "attachment_id": "encoded",
        "filename": "prod secrets.env",
        "download_url": "/download/attachments/55/prod%20secrets.env",
        "candidate_source": "explicit_attachment",
        "candidate_query": "",
        "status": "fetched",
        "content_present": True,
    }]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:55/attachment/prod secrets.env"
    assert row["extra"]["metadata"]["candidate_source"] == "explicit_attachment"


def test_confluence_attachment_list_url_fetches_bounded_text_attachments_only(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("L" * 36)
    fetch_calls: list[str] = []
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not require CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not require page listing"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda page_id: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not fetch page body"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not scan comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not scan page history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="a1",
                filename="prod.env",
                media_type="text/plain",
                size=64,
                download_url="/download/attachments/5555/prod.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="a2",
                filename="diagram.png",
                media_type="image/png",
                size=128,
                download_url="/download/attachments/5555/diagram.png",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(path: str) -> str:
        fetch_calls.append(path)
        if path != "/download/attachments/5555/prod.env":
            raise AssertionError("only text attachment candidates should be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run({
        "page_ids": ["5555"],
        "include_attachments": True,
        "fetch_attachments": True,
        "max_attachments_per_page": 5,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path, metadata={"charter_ref": "SECOPS-CONFLUENCE-ATTACHMENT-LIST"})

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["charter_ref"] == "SECOPS-CONFLUENCE-ATTACHMENT-LIST"
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["api_search"]["candidate_sources"] == {"explicit_attachment_list": 1}
    assert payload["api_search"]["attachment_list_count"] == 1
    assert payload["api_search"]["attachment_list_attempts"] == [{
        "page_id": "5555",
        "space_key": "",
        "source": "explicit_attachment_list",
        "returned": 2,
        "text_candidates": 1,
        "selected": 1,
        "skipped_non_text": 1,
        "candidate_limit_hit": False,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"explicit_attachment_list": 2}
    assert payload["api_search"]["detail_status_by_kind"]["attachment"] == {"skipped": 1, "fetched": 1}
    assert fetch_calls == ["/download/attachments/5555/prod.env"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == [
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "a2",
            "filename": "diagram.png",
            "download_url": "/download/attachments/5555/diagram.png",
            "media_type": "image/png",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "skipped",
            "content_present": False,
            "error": "Confluence attachment-list candidate is not text",
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "a1",
            "filename": "prod.env",
            "download_url": "/download/attachments/5555/prod.env",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
    ]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:5555/attachment/prod.env"
    assert row["asset_kind"] == "attachment"
    assert row["extra"]["metadata"]["candidate_source"] == "explicit_attachment_list"
    assert row["extra"]["metadata"]["scan_method"] == "api_attachment_detail_scan"


def test_confluence_attachment_list_skips_out_of_scope_parent_before_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("P" * 36)
    fetch_calls: list[str] = []
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not require CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not require page listing"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not fetch page body"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not scan comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not scan page history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="bad",
                filename="bad.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/other/bad.env",
                parent_page_id="other-page",
            ),
            CfAttachment(
                id="good",
                filename="good.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/5555/good.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="image",
                filename="diagram.png",
                media_type="image/png",
                size=128,
                download_url="/download/attachments/5555/diagram.png",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(path: str) -> str:
        fetch_calls.append(path)
        if "bad.env" in path:
            raise AssertionError("out-of-scope attachment must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run({
        "page_ids": ["5555"],
        "include_attachments": True,
        "fetch_attachments": True,
        "max_attachments_per_page": 5,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["attachment_list_count"] == 1
    assert payload["api_search"]["attachment_list_attempts"] == [{
        "page_id": "5555",
        "space_key": "",
        "source": "explicit_attachment_list",
        "returned": 3,
        "text_candidates": 2,
        "selected": 1,
        "skipped_non_text": 1,
        "candidate_limit_hit": False,
        "out_of_scope": 1,
        "skipped": 2,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"explicit_attachment_list": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_attachment_list": {"skipped": 2, "fetched": 1},
    }
    assert payload["api_search"]["detail_errors"] == []
    assert payload["errors"] == []
    assert fetch_calls == ["/download/attachments/5555/good.env"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["attachment_details"] == [
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "image",
            "filename": "diagram.png",
            "download_url": "/download/attachments/5555/diagram.png",
            "media_type": "image/png",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "skipped",
            "content_present": False,
            "error": "Confluence attachment-list candidate is not text",
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "bad",
            "filename": "bad.env",
            "download_url": "/download/attachments/other/bad.env",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "skipped",
            "fetched_page_id": "other-page",
            "error": "Confluence attachment candidate out of requested page scope",
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "good",
            "filename": "good.env",
            "download_url": "/download/attachments/5555/good.env",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
    ]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:5555/attachment/good.env"
    assert row["asset_kind"] == "attachment"


def test_confluence_attachment_list_url_marks_limit_hit_and_skips_excess_text_attachments(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token_one = "ghp_" + ("N" * 36)
    token_two = "ghp_" + ("O" * 36)
    fetch_calls: list[str] = []
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("bounded attachment-list URL must not require CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("bounded attachment-list URL must not list pages"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("bounded attachment-list URL must not fetch page body"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("bounded attachment-list URL must not scan comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("bounded attachment-list URL must not scan history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="a1",
                filename="first.env",
                media_type="text/plain",
                size=64,
                download_url="/download/attachments/5555/first.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="a2",
                filename="second.env",
                media_type="text/plain",
                size=64,
                download_url="/download/attachments/5555/second.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="a3",
                filename="third.env",
                media_type="text/plain",
                size=64,
                download_url="/download/attachments/5555/third.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="a4",
                filename="diagram.png",
                media_type="image/png",
                size=128,
                download_url="/download/attachments/5555/diagram.png",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(path: str) -> str:
        fetch_calls.append(path)
        if path.endswith("/first.env"):
            return f"GITHUB_TOKEN={token_one}\n"
        if path.endswith("/second.env"):
            return f"GITHUB_TOKEN={token_two}\n"
        raise AssertionError("text attachments beyond max_attachments_per_page must not be fetched")

    monkeypatch.setattr(sht.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run({
        "page_ids": ["5555"],
        "include_attachments": True,
        "fetch_attachments": True,
        "max_attachments_per_page": 2,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert fetch_calls == [
        "/download/attachments/5555/first.env",
        "/download/attachments/5555/second.env",
    ]
    assert payload["finding_count"] == 2
    assert payload["artifacts_scanned"] == 2
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["attachment_list_count"] == 2
    assert payload["api_search"]["attachment_list_attempts"] == [{
        "page_id": "5555",
        "space_key": "",
        "source": "explicit_attachment_list",
        "returned": 4,
        "text_candidates": 3,
        "selected": 2,
        "skipped_non_text": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
        "skipped": 2,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"explicit_attachment_list": 4}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_attachment_list": {"fetched": 2, "skipped": 2},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["api_search"]["attachment_list_attempts"] == (
        payload["api_search"]["attachment_list_attempts"]
    )
    assert evidence["attachment_details"] == [
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "a4",
            "filename": "diagram.png",
            "download_url": "/download/attachments/5555/diagram.png",
            "media_type": "image/png",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "skipped",
            "content_present": False,
            "error": "Confluence attachment-list candidate is not text",
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "a1",
            "filename": "first.env",
            "download_url": "/download/attachments/5555/first.env",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "a2",
            "filename": "second.env",
            "download_url": "/download/attachments/5555/second.env",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "a3",
            "filename": "third.env",
            "download_url": "/download/attachments/5555/third.env",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "skipped",
            "error": (
                "Confluence attachment-list candidate beyond "
                "max_attachments_per_page"
            ),
        },
    ]
    assert [a["asset"] for a in evidence["artifacts"]] == [
        "confluence:5555/attachment/first.env",
        "confluence:5555/attachment/second.env",
    ]

    assets = {row["asset"] for row in core_state.finding_list(task_type="confluence", limit=10)}
    assert assets == {
        "confluence:5555/attachment/first.env",
        "confluence:5555/attachment/second.env",
    }


def test_confluence_attachment_list_empty_detail_is_error_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not require CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not require page listing"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not fetch page body"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not scan comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not scan page history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="a1",
                filename="empty.env",
                media_type="text/plain",
                size=64,
                download_url="/download/attachments/5555/empty.env",
                parent_page_id=page_id,
            ),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_attachment_text", lambda path: "  \n")

    res = _run({
        "page_ids": ["5555"],
        "include_attachments": True,
        "fetch_attachments": True,
        "max_attachments_per_page": 5,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "attachments=1" in payload["status_reason"]
    assert payload["api_search"]["attachment_list_count"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_attachment_list": {"empty": 1},
    }
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == [{
        "page_id": "5555",
        "space_key": "",
        "page_title": "5555",
        "attachment_id": "a1",
        "filename": "empty.env",
        "download_url": "/download/attachments/5555/empty.env",
        "candidate_source": "explicit_attachment_list",
        "candidate_query": "",
        "status": "empty",
        "content_present": False,
    }]


def test_confluence_attachment_list_detail_error_is_audited_without_broadening(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class AttachmentListFetchFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    fetch_calls: list[str] = []
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list detail failure must not run CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list detail failure must not list pages"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list detail failure must not fetch page body"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list detail failure must not scan comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list detail failure must not scan history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="a1",
                filename="prod.env",
                media_type="text/plain",
                size=64,
                download_url="/download/attachments/5555/prod.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="a2",
                filename="diagram.png",
                media_type="image/png",
                size=128,
                download_url="/download/attachments/5555/diagram.png",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(path: str) -> str:
        fetch_calls.append(path)
        if path != "/download/attachments/5555/prod.env":
            raise AssertionError("only selected text attachment should be fetched")
        raise AttachmentListFetchFailure("Confluence attachment-list body HTTP 503")

    monkeypatch.setattr(sht.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run({
        "page_ids": ["5555"],
        "include_attachments": True,
        "fetch_attachments": True,
        "max_attachments_per_page": 5,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert fetch_calls == ["/download/attachments/5555/prod.env"]
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["artifacts_scanned"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_sources"] == {"explicit_attachment_list": 1}
    assert payload["api_search"]["attachment_list_count"] == 1
    assert payload["api_search"]["attachment_list_attempts"] == [{
        "page_id": "5555",
        "space_key": "",
        "source": "explicit_attachment_list",
        "returned": 2,
        "text_candidates": 1,
        "selected": 1,
        "skipped_non_text": 1,
        "candidate_limit_hit": False,
        "skipped": 1,
    }]
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_attachment_text"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["detail_errors"][0]["candidate_source"] == (
        "explicit_attachment_list"
    )
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_attachment_text": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_attachment_list": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        "(no query)": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {
        "503": 1,
    }
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_attachment_list": {"skipped": 1, "error": 1},
    }
    assert payload["api_search"]["detail_status_by_kind"]["attachment"] == {
        "skipped": 1,
        "error": 1,
    }
    assert payload["errors"][0]["phase"] == "fetch_attachment_text"
    assert payload["errors"][0]["status_code"] == 503
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == [
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "a2",
            "filename": "diagram.png",
            "download_url": "/download/attachments/5555/diagram.png",
            "media_type": "image/png",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "skipped",
            "content_present": False,
            "error": "Confluence attachment-list candidate is not text",
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "a1",
            "filename": "prod.env",
            "download_url": "/download/attachments/5555/prod.env",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "error",
            "status_code": 503,
            "error": "AttachmentListFetchFailure('Confluence attachment-list body HTTP 503')",
        },
    ]
    assert evidence["artifacts"] == []


def test_confluence_attachment_list_detail_error_continues_remaining_attachments(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class AttachmentListFetchFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    token = "ghp_" + ("M" * 36)
    fetch_calls: list[str] = []
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("partial attachment-list detail failure must not run CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("partial attachment-list detail failure must not list pages"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("partial attachment-list detail failure must not fetch page body"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("partial attachment-list detail failure must not scan comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("partial attachment-list detail failure must not scan history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="a-bad",
                filename="broken.env",
                media_type="text/plain",
                size=64,
                download_url="/download/attachments/5555/broken.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="a-live",
                filename="live.env",
                media_type="text/plain",
                size=64,
                download_url="/download/attachments/5555/live.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="a-img",
                filename="diagram.png",
                media_type="image/png",
                size=128,
                download_url="/download/attachments/5555/diagram.png",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(path: str) -> str:
        fetch_calls.append(path)
        if path.endswith("/broken.env"):
            raise AttachmentListFetchFailure("Confluence attachment-list body HTTP 503")
        if path.endswith("/live.env"):
            return f"GITHUB_TOKEN={token}\n"
        raise AssertionError("only selected text attachment bodies should be fetched")

    monkeypatch.setattr(sht.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run({
        "page_ids": ["5555"],
        "include_attachments": True,
        "fetch_attachments": True,
        "max_attachments_per_page": 5,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert fetch_calls == [
        "/download/attachments/5555/broken.env",
        "/download/attachments/5555/live.env",
    ]
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["api_search"]["candidate_sources"] == {"explicit_attachment_list": 1}
    assert payload["api_search"]["attachment_list_count"] == 2
    assert payload["api_search"]["attachment_list_attempts"] == [{
        "page_id": "5555",
        "space_key": "",
        "source": "explicit_attachment_list",
        "returned": 3,
        "text_candidates": 2,
        "selected": 2,
        "skipped_non_text": 1,
        "candidate_limit_hit": False,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_attachment_text"
    assert payload["api_search"]["detail_errors"][0]["filename"] == "broken.env"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["detail_errors"][0]["candidate_source"] == (
        "explicit_attachment_list"
    )
    assert payload["api_search"]["detail_error_summary"] == {
        "total": 1,
        "by_phase": {"fetch_attachment_text": 1},
        "by_source": {"explicit_attachment_list": 1},
        "by_query": {"(no query)": 1},
        "by_status_code": {"503": 1},
    }
    assert payload["api_search"]["detail_source_counts"] == {"explicit_attachment_list": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_attachment_list": {"skipped": 1, "error": 1, "fetched": 1},
    }
    assert payload["api_search"]["detail_status_by_kind"]["attachment"] == {
        "skipped": 1,
        "error": 1,
        "fetched": 1,
    }
    assert payload["errors"][0]["phase"] == "fetch_attachment_text"
    assert payload["errors"][0]["status_code"] == 503

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["attachment_list_attempts"] == (
        payload["api_search"]["attachment_list_attempts"]
    )
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == [
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "a-img",
            "filename": "diagram.png",
            "download_url": "/download/attachments/5555/diagram.png",
            "media_type": "image/png",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "skipped",
            "content_present": False,
            "error": "Confluence attachment-list candidate is not text",
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "a-bad",
            "filename": "broken.env",
            "download_url": "/download/attachments/5555/broken.env",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "error",
            "status_code": 503,
            "error": "AttachmentListFetchFailure('Confluence attachment-list body HTTP 503')",
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "a-live",
            "filename": "live.env",
            "download_url": "/download/attachments/5555/live.env",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
    ]
    assert evidence["artifacts"][0]["asset"] == "confluence:5555/attachment/live.env"
    assert evidence["artifacts"][0]["metadata"]["candidate_source"] == "explicit_attachment_list"

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:5555/attachment/live.env"
    assert row["asset_kind"] == "attachment"
    assert row["extra"]["metadata"]["candidate_source"] == "explicit_attachment_list"
    assert row["extra"]["metadata"]["scan_method"] == "api_attachment_detail_scan"


def test_confluence_attachment_list_api_failure_records_attempt(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class ListAttachmentsFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not require CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not require page listing"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not fetch page body"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not scan comments"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list URLs must not scan page history"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ListAttachmentsFailure("Confluence list attachments HTTP 503"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_attachment_text",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("attachment-list failure must not fetch attachment bodies"),
        ),
    )

    res = _run({
        "page_ids": ["5555"],
        "include_attachments": True,
        "fetch_attachments": True,
        "max_attachments_per_page": 5,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["attachment_list_count"] == 0
    assert payload["api_search"]["attachment_list_attempts"] == [{
        "page_id": "5555",
        "space_key": "",
        "source": "explicit_attachment_list",
        "returned": 0,
        "text_candidates": 0,
        "selected": 0,
        "skipped_non_text": 0,
        "candidate_limit_hit": False,
        "phase": "list_attachments",
        "error": "ListAttachmentsFailure('Confluence list attachments HTTP 503')",
        "status_code": 503,
    }]
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {"list_attachments": 1}
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "list_attachments"
    assert payload["errors"][0]["status_code"] == 503
    assert core_state.finding_list(task_type="confluence", limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["attachment_list_attempts"] == payload["api_search"]["attachment_list_attempts"]
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == [{
        "page_id": "5555",
        "space_key": "",
        "page_title": "5555",
        "candidate_source": "explicit_attachment_list",
        "candidate_query": "",
        "status": "error",
        "status_code": 503,
        "error": "ListAttachmentsFailure('Confluence list attachments HTTP 503')",
    }]


def test_confluence_explicit_attachment_download_missing_is_audited_without_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit attachment URLs must not require CQL"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("explicit attachment URLs must not require page listing"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda page_id: (_ for _ in ()).throw(
            AssertionError("explicit attachment URLs must not fetch page body"),
        ),
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="other",
                filename="other.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/55/other.env",
                parent_page_id=page_id,
            ),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_attachment_text",
        lambda path: (_ for _ in ()).throw(
            AssertionError("missing exact attachment URL must not fetch another attachment"),
        ),
    )

    res = _run({
        "attachment_downloads": [
            {"page_id": "55", "download_url": "/download/attachments/55/missing.env"},
        ],
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["status_reason"].startswith("Candidate search/fallback/file/directory")
    assert payload["api_search"]["candidate_sources"] == {"explicit_attachment": 1}
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 1

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["attachment_details"] == [{
        "page_id": "55",
        "space_key": "",
        "page_title": "55",
        "download_url": "/download/attachments/55/missing.env",
        "candidate_source": "explicit_attachment",
        "candidate_query": "",
        "status": "missing",
        "content_present": False,
        "error": "explicit attachment URL not found in page attachment list",
    }]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_history_secret_still_on_current_page_is_current(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("W" * 36)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="71", title="Deploy", space_key="SEC", version=5, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda page_id: f"current page still has GITHUB_TOKEN={token}\n",
    )
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda page_id: [4])
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body_version",
        lambda page_id, version: f"older page also had GITHUB_TOKEN={token}\n",
    )

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 2
    assert payload["scan_status"] == "ok"
    rows = core_state.finding_list(task_type="confluence", limit=10)
    by_asset = {row["asset"]: row for row in rows}
    assert by_asset["confluence:SEC:71"]["extra"]["verification"]["status"] == "current_page"
    version = by_asset["confluence:SEC:71/version/4"]
    assert version["asset_kind"] == "page_version"
    assert version["extra"]["verification"] == {
        "method": "confluence_current_page_signature",
        "status": "current_page",
        "matched_current": True,
        "surface_labels": ["71"],
        "source_version": 4,
    }


def test_confluence_history_detail_missing_counts_as_missing(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="67", title="Deploy", space_key="SEC", version=4, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "clean now")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda page_id: [3])
    monkeypatch.setattr(sht.cf, "fetch_page_body_version", lambda page_id, version: None)

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["status_reason"] == "partial detail missing=1"
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_status_by_kind"] == {
        "page": {"skipped": 1, "fetched": 1},
        "version": {"missing": 1},
    }
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_status_by_kind"] == payload["api_search"]["detail_status_by_kind"]
    assert evidence["version_details"] == [{
        "page_id": "67",
        "space_key": "SEC",
        "page_title": "Deploy",
        "version": 3,
        "candidate_source": "space_cql",
        "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
        "status": "missing",
        "content_present": False,
    }]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_history_blank_detail_counts_missing(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="68", title="Deploy", space_key="SEC", version=4, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "clean now")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda page_id: [3])
    monkeypatch.setattr(sht.cf, "fetch_page_body_version", lambda page_id, version: "  \n")

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["status_reason"] == "partial detail missing=1"
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["version_details"] == [{
        "page_id": "68",
        "space_key": "SEC",
        "page_title": "Deploy",
        "version": 3,
        "candidate_source": "space_cql",
        "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
        "status": "empty",
        "content_present": False,
    }]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_history_missing_version_identity_is_error_and_not_fetched(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="69", title="Deploy", space_key="SEC", version=4, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "clean now")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda page_id: ["", None, "  "])

    def fetch_page_body_version(page_id: str, version: int) -> str:
        raise AssertionError("malformed page version candidates must not be fetched")

    monkeypatch.setattr(sht.cf, "fetch_page_body_version", fetch_page_body_version)

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_errors"][0]["phase"] == "page_version_candidate"
    assert payload["errors"][0]["phase"] == "page_version_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["version_details"] == [
        {
            "page_id": "69",
            "space_key": "SEC",
            "page_title": "Deploy",
            "version": "",
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "error",
            "error": "Confluence page version candidate missing version number",
        },
        {
            "page_id": "69",
            "space_key": "SEC",
            "page_title": "Deploy",
            "version": None,
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "error",
            "error": "Confluence page version candidate missing version number",
        },
        {
            "page_id": "69",
            "space_key": "SEC",
            "page_title": "Deploy",
            "version": "  ",
            "candidate_source": "space_cql",
            "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
            "status": "error",
            "error": "Confluence page version candidate missing version number",
        },
    ]
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_comment_detail_error_continues_attachment_scan(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment, CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("C" * 36)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="77", title="Deploy", space_key="SEC", version=3, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "첨부 참고\n")

    def fail_comments(page_id: str):
        raise RuntimeError("comment API timeout")

    monkeypatch.setattr(sht.cf, "list_comments", fail_comments)
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="a-live",
                filename="live.env",
                media_type="text/plain",
                size=80,
                download_url="/download/live",
                parent_page_id=page_id,
            ),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_attachment_text", lambda path: f"GITHUB_TOKEN={token}\n")

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "scan_comments": True,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["api_search"]["detail_errors"][0]["phase"] == "list_comments"
    assert payload["errors"][0]["phase"] == "list_comments"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["comment_details"] == [{
        "page_id": "77",
        "space_key": "SEC",
        "page_title": "Deploy",
        "candidate_source": "space_cql",
        "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
        "status": "error",
        "status_code": None,
        "error": "RuntimeError('comment API timeout')",
    }]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:SEC:77/attachment/live.env"
    assert row["asset_kind"] == "attachment"


def test_confluence_history_list_error_is_audited_and_continues_attachments(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment, CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("Y" * 36)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="81", title="Deploy", space_key="SEC", version=3, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "첨부 참고\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])

    def fail_versions(page_id: str):
        raise RuntimeError("history list timeout")

    monkeypatch.setattr(sht.cf, "list_page_versions", fail_versions)
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="a-live",
                filename="live.env",
                media_type="text/plain",
                size=80,
                download_url="/download/live",
                parent_page_id=page_id,
            ),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_attachment_text", lambda path: f"GITHUB_TOKEN={token}\n")

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "scan_comments": False,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["api_search"]["detail_errors"][0]["phase"] == "list_page_versions"
    assert payload["errors"][0]["phase"] == "list_page_versions"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["version_details"] == [{
        "page_id": "81",
        "space_key": "SEC",
        "page_title": "Deploy",
        "candidate_source": "space_cql",
        "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
        "status": "error",
        "status_code": None,
        "error": "RuntimeError('history list timeout')",
    }]
    assert evidence["attachment_details"] == [{
        "page_id": "81",
        "space_key": "SEC",
        "page_title": "Deploy",
        "attachment_id": "a-live",
        "filename": "live.env",
        "download_url": "/download/live",
        "candidate_source": "space_cql",
        "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
        "status": "fetched",
        "content_present": True,
    }]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:SEC:81/attachment/live.env"
    assert row["asset_kind"] == "attachment"


def test_confluence_attachment_list_error_is_audited_after_history_scan(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("Z" * 36)
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="82", title="Deploy", space_key="SEC", version=4, url="/display/SEC/D"),
        ],
    )
    monkeypatch.setattr(sht.cf, "fetch_page_body", lambda page_id: "clean current\n")
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda page_id: [3])
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body_version",
        lambda page_id, version: f"GITHUB_TOKEN={token}\n",
    )

    def fail_attachments(page_id: str):
        raise RuntimeError("attachment list timeout")

    monkeypatch.setattr(sht.cf, "list_attachments", fail_attachments)
    monkeypatch.setattr(
        sht.cf,
        "fetch_attachment_text",
        lambda path: (_ for _ in ()).throw(
            AssertionError("attachment list failure must not fetch attachment bodies"),
        ),
    )

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "fetch_attachments": True,
        "scan_comments": False,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["api_search"]["detail_errors"][0]["phase"] == "list_attachments"
    assert payload["errors"][0]["phase"] == "list_attachments"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["version_details"] == [{
        "page_id": "82",
        "space_key": "SEC",
        "page_title": "Deploy",
        "version": 3,
        "candidate_source": "space_cql",
        "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
        "status": "fetched",
        "content_present": True,
    }]
    assert evidence["attachment_details"] == [{
        "page_id": "82",
        "space_key": "SEC",
        "page_title": "Deploy",
        "candidate_source": "space_cql",
        "candidate_query": 'space = "SEC" AND type = page AND text ~ "deploy"',
        "status": "error",
        "status_code": None,
        "error": "RuntimeError('attachment list timeout')",
    }]

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:SEC:82/version/3"
    assert row["asset_kind"] == "page_version"


def test_confluence_page_detail_processing_error_is_structured_and_continues(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("P" * 36)
    original_signatures = sht._hit_signatures_from_text
    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="88", title="Broken", space_key="SEC", version=3, url="/display/SEC/B"),
            CfPage(id="89", title="Live", space_key="SEC", version=3, url="/display/SEC/L"),
        ],
    )

    def fetch_page_body(page_id: str) -> str:
        if page_id == "88":
            return "broken current page"
        return f"GITHUB_TOKEN={token}\n"

    def signatures(text: str, *, high_entropy: bool = False):
        if "broken current page" in text:
            raise RuntimeError("signature extraction timeout")
        return original_signatures(text, high_entropy=high_entropy)

    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body)
    monkeypatch.setattr(sht.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.cf, "list_attachments", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht, "_hit_signatures_from_text", signatures)

    res = _run({
        "space_keys": ["SEC"],
        "cql_terms": ["deploy"],
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["api_search"]["detail_errors"][0]["phase"] == "page_detail"
    assert payload["api_search"]["detail_errors"][0]["target"] == "88"
    assert payload["api_search"]["detail_errors"][0]["candidate_source"] == "space_cql"
    assert payload["errors"][0]["phase"] == "page_detail"

    row = core_state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:SEC:89"
    assert row["asset_kind"] == "page"


def test_confluence_space_cql_rate_limit_is_error_not_skipped_or_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    def fail_cql(cql: str, *, limit: int = 100):
        request = httpx.Request("GET", "https://cf.test/rest/api/content/search")
        response = httpx.Response(
            403,
            request=request,
            headers={"Retry-After": "60"},
            json={"message": "API rate limit exceeded"},
        )
        raise httpx.HTTPStatusError("403 Forbidden", request=request, response=response)

    monkeypatch.setattr(sht.cf, "cql_search", fail_cql)
    monkeypatch.setattr(
        sht.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("rate limit must not use full page listing fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("rate limit must not continue to detail fetch"),
        ),
    )

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": True,
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "403 Forbidden" in payload["status_reason"]
    assert payload["api_search"]["limit_failed"] is True
    assert payload["api_search"]["auth_failed"] is False
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "cql_search"
    assert payload["api_search"]["errors"][0]["status_code"] == 403
    assert payload["api_search"]["errors"][0]["limit_failed"] is True
    assert payload["errors"][0]["phase"] == "cql_search"
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_space_list_pages_rate_limit_fails_closed(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    def list_pages_rate_limited(space_key: str, limit: int = 50):
        request = httpx.Request("GET", f"https://cf.test/rest/api/space/{space_key}/content/page")
        response = httpx.Response(
            429,
            request=request,
            headers={"Retry-After": "60"},
            json={"message": "too many requests"},
        )
        raise httpx.HTTPStatusError("429 Too Many Requests", request=request, response=response)

    monkeypatch.setattr(sht.cf, "list_pages", list_pages_rate_limited)
    monkeypatch.setattr(
        sht.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("rate limit must not continue to detail fetch"),
        ),
    )

    res = _run({
        "space_keys": ["OPS"],
        "api_search_first": False,
        "fetch_attachments": False,
        "scan_comments": False,
        "scan_history": False,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "429 Too Many Requests" in payload["status_reason"]
    assert payload["api_search"]["limit_failed"] is True
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "list_pages"
    assert payload["api_search"]["errors"][0]["status_code"] == 429
    assert payload["api_search"]["errors"][0]["limit_failed"] is True
    assert core_state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_page_detail_rate_limit_stops_subresource_fetches(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(id="42", title="Runbook", space_key="OPS", version=1, url="/display/OPS/R"),
        ],
    )

    def fetch_page_body_rate_limited(page_id: str):
        request = httpx.Request("GET", f"https://cf.test/rest/api/content/{page_id}")
        response = httpx.Response(
            429,
            request=request,
            headers={"Retry-After": "60"},
            json={"message": "too many requests"},
        )
        raise httpx.HTTPStatusError("429 Too Many Requests", request=request, response=response)

    monkeypatch.setattr(sht.cf, "fetch_page_body", fetch_page_body_rate_limited)
    monkeypatch.setattr(
        sht.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("rate-limited page body must stop comment fetch"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("rate-limited page body must stop history fetch"),
        ),
    )
    monkeypatch.setattr(
        sht.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("rate-limited page body must stop attachment fetch"),
        ),
    )

    res = _run({
        "space_keys": ["OPS"],
        "cql_terms": ["password"],
        "fetch_attachments": True,
        "scan_comments": True,
        "scan_history": True,
        "high_entropy": False,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "429 Too Many Requests" in payload["status_reason"]
    assert payload["api_search"]["limit_failed"] is True
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_page_body"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 429
    assert payload["api_search"]["detail_errors"][0]["limit_failed"] is True
    query = 'space = "OPS" AND type = page AND text ~ "password"'
    assert payload["api_search"]["detail_error_summary"] == {
        "total": 1,
        "by_phase": {"fetch_page_body": 1},
        "by_source": {"space_cql": 1},
        "by_query": {query: 1},
        "by_status_code": {"429": 1},
    }
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_error_summary"] == payload["api_search"]["detail_error_summary"]
    assert core_state.finding_list(task_type="confluence", limit=10) == []
