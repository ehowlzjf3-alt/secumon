from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolSuccess


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


def _scanned(res, *, limit: int = 10) -> list[dict]:
    """스캔이 돌려준 **후보** 목록.

    ## 왜 DB 를 안 읽나 (2026-08-27)

    예전엔 `state.finding_list(task_type="github")` 로 셌다. 스캔 도구가 찾은 것을
    그대로 `finding_upsert` 했기 때문이다. 그 경로가 오늘까지 github finding
    27,414건을 만들었고 그중 LLM 판정을 거친 것은 7건뿐이었다.

    사용자 결정: **모든 finding 은 등록 전에 LLM 판정을 타야 한다.** 그래서 스캔은
    후보만 돌려주고, 등록은 에이전트가 `github_submit_finding` 을 부를 때 일어난다.

    ★ 이 헬퍼는 후보를 돌려주면서 **DB 가 그대로인지도 함께 검증한다.** 그래야
      "등록하지 않는다" 가 매 테스트에서 실제로 재어진다 — 단순히 읽는 곳만 바꾸면
      그 불변식은 아무 데서도 안 지켜진다.
    """
    from secu_agent import state as _state

    assert _state.finding_list(task_type="github", limit=limit) == [], (
        "스캔이 finding 을 등록했다 — 후보만 돌려줘야 한다")
    return json.loads(res.content)["findings"][:limit]


def _run(tool, payload, tmp_path: Path, metadata: dict | None = None):
    return asyncio.run(tool.execute(
        tool.input_model(**payload),
        ToolContext(
            evidence_dir=tmp_path,
            metadata=metadata if metadata is not None else {},
        ),
    ))


def test_github_task_scan_does_not_enrich_candidates(tmp_db, tmp_path, monkeypatch):
    """★ 스캔 단계에서 enrichment(구 pivot)를 돌리지 않는다 (2026-08-27).

    예전엔 finding upsert 직후 artifact 당 pivot 을 1회 돌려 `extra['pivot']` 을 붙였다.
    이제 스캔은 등록하지 않으므로 붙일 finding 이 없다 — enrichment 는 에이전트가
    `github_submit_finding` 으로 제출한 **확정 finding** 에 대해 일어난다.

    ⚠️ 후보 단계에서 돌리면 안 되는 이유는 비용이 아니라 **의미**다. enrichment 는
      라이브 표면을 실제로 찔러 본다(구 pivot = 내부 표면 GET probe). 아직 finding 인지
      아닌지도 모르는 후보 전부에 대해 그걸 하면, 오탐 하나가 실제 네트워크 행위가 된다.
      오늘 후보는 하루 수천 건 규모였다.
    """
    from secu_agent import state
    from secu_agent.agent.finding_enrichment import (
        register_finding_enricher,
        unregister_all_finding_enrichers,
    )
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhRepo

    token = "ghp_" + ("B" * 36)
    monkeypatch.setattr(service_task_tools.gh, "list_repos", lambda org, limit=20: [
        GhRepo(full_name="platform/api", default_branch="main", private=True,
               archived=False, pushed_at="2026-05-24T00:00:00Z"),
    ])
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching",
                        lambda repo, ref, hot_paths: [
                            GhBlobRef(repo=repo, ref=ref, path=".env", sha="abc", size=80)])
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text",
                        lambda repo, sha: f"GITHUB_TOKEN={token}\n")
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches",
                        lambda repo, limit=3, since_sha=None: [])

    calls = []

    def fake_pivot(*, asset, summary, hits):
        calls.append(asset)
        return {"version": 1, "candidates": [], "probes": [], "exposed_count": 0}

    unregister_all_finding_enrichers()
    register_finding_enricher(fake_pivot)
    try:
        res = _run(GithubTaskScanTool(), {"org": "platform", "api_search_first": False}, tmp_path, {})
        assert isinstance(res, ToolSuccess)
        assert calls == [], f"후보 단계에서 enrichment 를 돌렸다: {calls}"
        assert state.finding_list() == [], "스캔이 finding 을 등록했다"
        # 후보 자체는 나와야 한다 — 안 나오면 이 테스트는 아무것도 안 재는 셈이다.
        assert json.loads(res.content)["findings"], "후보가 하나도 없다"
    finally:
        unregister_all_finding_enrichers()


def test_github_task_scan_persists_report_and_signal(tmp_db, tmp_path, monkeypatch):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhRepo

    token = "ghp_" + ("A" * 36)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_repos",
        lambda org, limit=20: [
            GhRepo(
                full_name="platform/api",
                default_branch="main",
                private=True,
                archived=False,
                pushed_at="2026-05-24T00:00:00Z",
            ),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, hot_paths: [
            GhBlobRef(repo=repo, ref=ref, path=".env", sha="abc123", size=80),
        ],
    )
    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_blob_text",
        lambda repo, sha: f"GITHUB_TOKEN={token}\n",
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda repo, limit=3, since_sha=None: [])

    metadata: dict = {
        "session_id": 30,
        "agent_type": "agent",
        "llm_profile": "codex",
        "llm_client": "codex",
        "llm_model": "gpt-5",
    }
    res = _run(GithubTaskScanTool(), {"org": "platform"}, tmp_path, metadata)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "github_task_scan"
    assert payload["finding_count"] == 1
    assert payload["findings"][0]["task_type"] == "github"
    assert payload["findings"][0]["severity"] == "high"
    assert payload["findings"][0]["candidate_source"] == "hot_path_tree"
    # ★ 스캔 시점에는 **아무것도 확정되지 않는다** (2026-08-27).
    #   리포트 갱신·follow-up 신호·provenance 도장은 전부 "이건 finding 이다" 라는
    #   판정을 전제한다. 그 판정은 에이전트가 `github_submit_finding` 을 부를 때 한다.
    #   여기서 미리 찍으면 후보가 스스로를 확정 사실로 만든다.
    assert "report_updated" not in payload["findings"][0]
    assert "followup_signal_emitted" not in payload["findings"][0]

    rows = _scanned(res, limit=10)     # DB 가 그대로인지도 함께 검증한다
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/.env"
    assert rows[0]["registered"] is False
    assert rows[0]["status"] == "candidate"
    assert rows[0]["id"] is None, "후보에 finding_id 가 붙었다"

    # follow-up 신호도 안 나간다 — 엔진의 finding 후속 계약은 **확정 finding** 을 전제한다.
    assert not metadata.get("finding_signals"), "후보 단계에서 신호를 냈다"

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    assert "ghp_" in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["api_search"]["finding_summary"] == payload["api_search"]["finding_summary"]


def test_github_task_scan_uses_api_search_before_hot_path_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("S" * 36)
    fetch_calls: list[tuple[str, str, str]] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda query, per_page=50, max_results=50: [
            service_task_tools.gh.GhCodeHit(repo="platform/api", path=".env"),
            service_task_tools.gh.GhCodeHit(repo="platform/api", path=".env"),
        ],
    )

    def fetch(repo: str, path: str, *, ref: str = "HEAD", max_bytes: int = 512 * 1024):
        fetch_calls.append((repo, path, ref))
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", fetch)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run when API detail succeeds"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["AKIA"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["findings"][0]["candidate_source"] == "code_search"
    assert "report_updated" not in payload["findings"][0]  # 후보는 확정이 아니다
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_status_counts"] == {"skipped": 1, "fetched": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {
        "file": {"skipped": 1, "fetched": 1},
    }
    assert payload["api_search"]["detail_source_counts"] == {"code_search": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "code_search": {"skipped": 1, "fetched": 1},
    }
    assert payload["api_search"]["detail_query_counts"] == {"repo:platform/api AKIA": 2}
    assert payload["api_search"]["detail_status_by_query"] == {
        "repo:platform/api AKIA": {"skipped": 1, "fetched": 1},
    }
    assert payload["api_search"]["detail_status_total"] == 2
    assert payload["api_search"]["target_status_counts"] == {"selected": 1}
    assert payload["api_search"]["target_source_counts"] == {"explicit_repo": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "explicit_repo": {"selected": 1},
    }
    scan_summary = payload["api_search"]["scan_summary"]
    assert scan_summary["artifact_count"] == 1
    assert scan_summary["artifact_source_counts"] == {"code_search": 1}
    assert scan_summary["hit_artifact_count"] == 1
    assert scan_summary["hit_source_counts"] == {"code_search": 1}
    assert scan_summary["hit_count_by_source"]["code_search"] >= 1
    assert scan_summary["hit_category_counts"]["secret"] >= 1
    assert scan_summary["reportable_artifact_count"] == 1
    assert scan_summary["reportable_source_counts"] == {"code_search": 1}
    assert scan_summary["low_value_only_artifact_count"] == 0
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert ("platform/api", ".env", "main") in fetch_calls
    assert ("platform/api", ".env", "HEAD") in fetch_calls
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_status_counts"] == payload["api_search"]["detail_status_counts"]
    assert evidence["api_search"]["detail_status_by_kind"] == payload["api_search"]["detail_status_by_kind"]
    assert evidence["api_search"]["detail_source_counts"] == payload["api_search"]["detail_source_counts"]
    assert evidence["api_search"]["detail_status_by_source"] == payload["api_search"]["detail_status_by_source"]
    assert evidence["api_search"]["detail_query_counts"] == payload["api_search"]["detail_query_counts"]
    assert evidence["api_search"]["detail_status_by_query"] == payload["api_search"]["detail_status_by_query"]
    assert evidence["api_search"]["detail_status_total"] == payload["api_search"]["detail_status_total"]
    assert evidence["api_search"]["target_status_counts"] == payload["api_search"]["target_status_counts"]
    assert evidence["api_search"]["target_source_counts"] == payload["api_search"]["target_source_counts"]
    assert evidence["api_search"]["target_status_by_source"] == payload["api_search"]["target_status_by_source"]
    assert evidence["api_search"]["scan_summary"] == payload["api_search"]["scan_summary"]
    assert evidence["api_search"]["finding_summary"] == payload["api_search"]["finding_summary"]
    assert evidence["file_details"] == [
        {
            "repo": "platform/api",
            "path": ".env",
            "candidate_source": "code_search",
            "candidate_query": "repo:platform/api AKIA",
            "status": "skipped",
            "error": "duplicate code search candidate",
        },
        {
            "repo": "platform/api",
            "path": ".env",
            "ref": "main",
            "candidate_source": "code_search",
            "candidate_query": "repo:platform/api AKIA",
            "status": "fetched",
            "content_present": True,
        },
    ]

    row = _scanned(res, limit=10)[0]
    metadata = row["metadata"]
    assert metadata["scan_method"] == "api_code_search_detail_scan"
    assert metadata["candidate_source"] == "code_search"
    assert row["verification"]["status"] == "live_in_HEAD"


def test_github_task_scan_explicit_file_dedupes_with_skipped_evidence(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("F" * 36)
    fetch_calls: list[tuple[str, str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact file scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def fetch_file_at_ref(
        repo: str,
        path: str,
        *,
        ref: str = "HEAD",
        max_bytes: int = 512 * 1024,
    ) -> str:
        fetch_calls.append((repo, path, ref))
        if path != "config/prod.env":
            raise AssertionError("duplicate explicit file candidate must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", fetch_file_at_ref)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "file_paths": ["config/prod.env", "CONFIG/prod.env"],
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-FILE-DEDUP"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["file_path_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_file": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_file": {"fetched": 1, "skipped": 1},
    }
    assert ("platform/api", "config/prod.env", "main") in fetch_calls
    assert all(path != "CONFIG/prod.env" for _, path, _ in fetch_calls)

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [
        {
            "repo": "platform/api",
            "path": "config/prod.env",
            "ref": "main",
            "candidate_source": "explicit_file",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "path": "CONFIG/prod.env",
            "ref": "main",
            "candidate_source": "explicit_file",
            "candidate_query": "",
            "status": "skipped",
            "error": "duplicate explicit file candidate",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/config/prod.env"
    assert rows[0]["metadata"]["scan_method"] == "api_exact_file_scan"


def test_github_task_scan_explicit_file_missing_detail_is_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    fetch_calls: list[tuple[str, str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("missing exact file scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def fetch_file_at_ref(
        repo: str,
        path: str,
        *,
        ref: str = "HEAD",
        max_bytes: int = 512 * 1024,
    ) -> None:
        fetch_calls.append((repo, path, ref))
        return None

    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", fetch_file_at_ref)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "file_paths": ["config/missing.env"],
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-FILE-MISSING"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert fetch_calls == [("platform/api", "config/missing.env", "main")]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert payload["api_search"]["file_path_count"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_file": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_file": {"missing": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "path": "config/missing.env",
        "ref": "main",
        "candidate_source": "explicit_file",
        "candidate_query": "",
        "status": "missing",
        "content_present": False,
        "error": "GitHub explicit file detail returned no content",
    }]
    assert evidence["artifacts"] == []


def test_github_task_scan_explicit_files_audit_candidates_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    token = "ghp_" + ("X" * 36)
    fetch_calls: list[tuple[str, str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded exact file scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def fetch_file_at_ref(
        repo: str,
        path: str,
        *,
        ref: str = "HEAD",
        max_bytes: int = 512 * 1024,
    ) -> str:
        fetch_calls.append((repo, path, ref))
        if path == "secret/overflow.env":
            return f"GITHUB_TOKEN={token}\n"
        return "clean configuration\n"

    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", fetch_file_at_ref)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "file_paths": ["config/first.env", "config/second.env", "secret/overflow.env"],
            "max_candidate_files": 2,
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-FILE-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert fetch_calls == [
        ("platform/api", "config/first.env", "main"),
        ("platform/api", "config/second.env", "main"),
    ]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["file_path_count"] == 2
    assert payload["api_search"]["detail_source_counts"] == {"explicit_file": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_file": {"fetched": 2, "skipped": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["file_details"] == [
        {
            "repo": "platform/api",
            "path": "config/first.env",
            "ref": "main",
            "candidate_source": "explicit_file",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "path": "config/second.env",
            "ref": "main",
            "candidate_source": "explicit_file",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "path": "secret/overflow.env",
            "ref": "main",
            "candidate_source": "explicit_file",
            "candidate_query": "",
            "status": "skipped",
            "error": "GitHub explicit file candidate beyond max_candidate_files",
        },
    ]


def test_github_task_scan_explicit_directory_dedupes_with_skipped_evidence(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBlobRef
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("D" * 36)
    directory_calls: list[tuple[str, str, str]] = []
    blob_fetch_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact directory scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def list_directory_blobs(repo: str, ref: str, directory: str):
        directory_calls.append((repo, ref, directory))
        if directory != "config":
            raise AssertionError("duplicate explicit directory candidate must not be listed")
        return [
            GhBlobRef(
                repo=repo,
                ref=ref,
                path="config/prod.env",
                sha="sha-prod",
                size=80,
            ),
        ]

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append((repo, sha))
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "list_directory_blobs", list_directory_blobs)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "directory_paths": ["config", "CONFIG"],
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-DIRECTORY-DEDUP"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["directory_path_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_directory": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_directory": {"fetched": 1, "skipped": 1},
    }
    assert directory_calls == [("platform/api", "main", "config")]
    assert blob_fetch_calls == [("platform/api", "sha-prod")]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [
        {
            "repo": "platform/api",
            "path": "config/prod.env",
            "ref": "main",
            "sha": "sha-prod",
            "size": 80,
            "candidate_source": "explicit_directory",
            "candidate_query": "config",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "path": "CONFIG",
            "ref": "main",
            "candidate_source": "explicit_directory",
            "candidate_query": "CONFIG",
            "status": "skipped",
            "error": "duplicate explicit directory candidate",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/config/prod.env"
    assert rows[0]["metadata"]["scan_method"] == "api_directory_tree_scan"


def test_github_task_scan_explicit_directory_requires_blob_repo_scope(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBlobRef
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    list_calls: list[tuple[str, str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("unscoped directory blob must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def list_directory_blobs(repo: str, ref: str, directory: str):
        list_calls.append((repo, ref, directory))
        return [
            GhBlobRef(
                repo="",
                ref=ref,
                path="config/prod.env",
                sha="sha-unscoped",
                size=80,
            ),
        ]

    monkeypatch.setattr(service_task_tools.gh, "list_directory_blobs", list_directory_blobs)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "directory_paths": ["config"],
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-DIRECTORY-BLOB-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert list_calls == [("platform/api", "main", "config")]
    assert payload["finding_count"] == 0
    assert payload["errors"] == []
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["directory_path_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 0
    assert payload["api_search"]["detail_source_counts"] == {"explicit_directory": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_directory": {"skipped": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "",
        "target_repo": "platform/api",
        "path": "config/prod.env",
        "ref": "main",
        "sha": "sha-unscoped",
        "candidate_source": "explicit_directory",
        "candidate_query": "config",
        "status": "skipped",
        "error": "GitHub directory blob candidate out of requested repo scope",
    }]
    assert evidence["artifacts"] == []
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_directory_empty_blob_list_is_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    list_calls: list[tuple[str, str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("empty explicit directory scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def list_directory_blobs(repo: str, ref: str, directory: str):
        list_calls.append((repo, ref, directory))
        return []

    monkeypatch.setattr(service_task_tools.gh, "list_directory_blobs", list_directory_blobs)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "directory_paths": ["config"],
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-DIRECTORY-NO-BLOBS"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert list_calls == [("platform/api", "main", "config")]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert payload["api_search"]["directory_path_count"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_directory": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_directory": {"missing": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "path": "config",
        "ref": "main",
        "candidate_source": "explicit_directory",
        "candidate_query": "config",
        "status": "missing",
        "content_present": False,
        "error": "GitHub explicit directory returned no blob candidates",
    }]
    assert evidence["artifacts"] == []


def test_github_task_scan_explicit_directories_audit_candidates_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    token = "ghp_" + ("D" * 36)
    list_calls: list[tuple[str, str, str]] = []
    fetch_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded exact directory scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def list_directory_blobs(repo: str, ref: str, directory: str):
        list_calls.append((repo, ref, directory))
        if directory == "secret/overflow":
            return [
                GhBlobRef(
                    repo=repo,
                    ref="sha-main",
                    path="secret/overflow.env",
                    sha="sha-overflow",
                    size=40,
                ),
            ]
        return [
            GhBlobRef(
                repo=repo,
                ref="sha-main",
                path=f"{directory}/clean.txt",
                sha=f"sha-{directory.replace('/', '-')}",
                size=12,
            ),
        ]

    def fetch_blob_text(repo: str, sha: str):
        fetch_calls.append((repo, sha))
        if sha == "sha-overflow":
            return f"GITHUB_TOKEN={token}\n"
        return "clean directory blob\n"

    monkeypatch.setattr(service_task_tools.gh, "list_directory_blobs", list_directory_blobs)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "directory_paths": ["config/one", "config/two", "secret/overflow"],
            "max_candidate_files": 2,
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-DIRECTORY-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert list_calls == [
        ("platform/api", "main", "config/one"),
        ("platform/api", "main", "config/two"),
    ]
    assert fetch_calls == [
        ("platform/api", "sha-config-one"),
        ("platform/api", "sha-config-two"),
    ]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["directory_path_count"] == 2
    assert payload["api_search"]["detail_source_counts"] == {"explicit_directory": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_directory": {"fetched": 2, "skipped": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["file_details"] == [
        {
            "repo": "platform/api",
            "path": "config/one/clean.txt",
            "ref": "sha-main",
            "sha": "sha-config-one",
            "size": 12,
            "candidate_source": "explicit_directory",
            "candidate_query": "config/one",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "path": "config/two/clean.txt",
            "ref": "sha-main",
            "sha": "sha-config-two",
            "size": 12,
            "candidate_source": "explicit_directory",
            "candidate_query": "config/two",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "path": "secret/overflow",
            "ref": "main",
            "candidate_source": "explicit_directory",
            "candidate_query": "secret/overflow",
            "status": "skipped",
            "error": "GitHub explicit directory candidate beyond max_candidate_files",
        },
    ]


def test_github_task_scan_explicit_commit_dedupes_with_skipped_evidence(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("C" * 36)
    commit_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact commit scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def fetch_commit_patch(repo: str, sha: str):
        commit_calls.append((repo, sha))
        if sha != "abc1234":
            raise AssertionError("duplicate explicit commit candidate must not be fetched")
        return GhCommitPatch(
            repo=repo,
            sha=sha,
            author="octocat",
            author_email="octocat@samsung.com",
            message="commit exact secret",
            files=[{"filename": "config/prod.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_commit_patch", fetch_commit_patch)
    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_file_at_ref",
        lambda repo, path, *, ref="HEAD", max_bytes=512 * 1024: f"GITHUB_TOKEN={token}\n",
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "commit_shas": ["abc1234", "ABC1234"],
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-COMMIT-DEDUP"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["commit_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_commit": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_commit": {"fetched": 1, "skipped": 1},
    }
    assert commit_calls == [("platform/api", "abc1234")]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["commit_details"] == [
        {
            "repo": "platform/api",
            "sha": "abc1234",
            "candidate_source": "explicit_commit",
            "files": ["config/prod.env"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "sha": "ABC1234",
            "candidate_source": "explicit_commit",
            "status": "skipped",
            "error": "duplicate explicit commit candidate",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/commit/abc1234"
    assert rows[0]["asset_kind"] == "commit_patch"


def test_github_task_scan_explicit_commit_requires_repo_scope(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("S" * 36)
    commit_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact commit scope test must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)

    def fetch_commit_patch(repo: str, sha: str):
        commit_calls.append((repo, sha))
        return GhCommitPatch(
            repo="",
            sha=sha,
            author="octocat",
            author_email="octocat@samsung.com",
            message="commit exact secret",
            files=[{"filename": "config/prod.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_commit_patch", fetch_commit_patch)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "commit_shas": ["abc1234"],
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-COMMIT-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert commit_calls == [("platform/api", "abc1234")]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_commit": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_commit": {"skipped": 1},
    }

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["commit_details"] == [{
        "repo": "",
        "target_repo": "platform/api",
        "sha": "abc1234",
        "candidate_source": "explicit_commit",
        "status": "skipped",
        "error": "GitHub commit candidate out of requested repo scope",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_commits_audit_candidates_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhCommitPatch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    token = "ghp_" + ("L" * 36)
    commit_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded exact commit scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def fetch_commit_patch(repo: str, sha: str):
        commit_calls.append((repo, sha))
        if sha == "ccc3333":
            return GhCommitPatch(
                repo=repo,
                sha=sha,
                author="octocat",
                author_email="octocat@samsung.com",
                message="overflow token",
                files=[{"filename": "secret.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
            )
        return GhCommitPatch(
            repo=repo,
            sha=sha,
            author="octocat",
            author_email="octocat@samsung.com",
            message="clean commit",
            files=[{"filename": "README.md", "patch": "+clean docs\n"}],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_commit_patch", fetch_commit_patch)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "commit_shas": ["aaa1111", "bbb2222", "ccc3333"],
            "commit_limit": 2,
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-COMMIT-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert commit_calls == [
        ("platform/api", "aaa1111"),
        ("platform/api", "bbb2222"),
    ]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["commit_count"] == 2
    assert payload["api_search"]["detail_source_counts"] == {"explicit_commit": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_commit": {"fetched": 2, "skipped": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["commit_details"] == [
        {
            "repo": "platform/api",
            "sha": "aaa1111",
            "candidate_source": "explicit_commit",
            "files": ["README.md"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "sha": "bbb2222",
            "candidate_source": "explicit_commit",
            "files": ["README.md"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "sha": "ccc3333",
            "candidate_source": "explicit_commit",
            "status": "skipped",
            "error": "GitHub explicit commit candidate beyond commit_limit",
        },
    ]


def test_github_task_scan_email_only_detail_is_summarized_low_value(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda query, per_page=50, max_results=50: [
            service_task_tools.gh.GhCodeHit(repo="platform/api", path="README.md"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_file_at_ref",
        lambda repo, path, *, ref="HEAD", max_bytes=512 * 1024: "Contact owner.one@samsung.com\n",
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback listing must not run when API detail succeeds"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["owner"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert _scanned(res, limit=10) == []
    scan_summary = payload["api_search"]["scan_summary"]
    assert scan_summary["artifact_count"] == 1
    assert scan_summary["artifact_source_counts"] == {"code_search": 1}
    assert scan_summary["hit_artifact_count"] == 1
    assert scan_summary["hit_source_counts"] == {"code_search": 1}
    assert scan_summary["hit_category_counts"] == {"pii": 1}
    assert scan_summary["reportable_artifact_count"] == 0
    assert scan_summary["reportable_source_counts"] == {}
    assert scan_summary["low_value_only_artifact_count"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["scan_summary"] == scan_summary


def test_github_task_scan_explicit_repo_uses_default_branch_from_meta(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from domains.services.github.plugin.agent_types.github import GhRepo

    token = "ghp_" + ("D" * 36)
    fetch_calls: list[tuple[str, str, str]] = []
    meta_calls: list[str] = []

    def repo_meta(repo: str):
        meta_calls.append(repo)
        return GhRepo(
            full_name=repo,
            default_branch="develop",
            private=True,
            archived=False,
            pushed_at="2026-06-01T00:00:00Z",
        )

    monkeypatch.setattr(service_task_tools.gh, "repo_meta", repo_meta)
    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda query, per_page=50, max_results=50: [
            service_task_tools.gh.GhCodeHit(repo="platform/api", path=".env"),
        ],
    )

    def fetch(repo: str, path: str, *, ref: str = "HEAD", max_bytes: int = 512 * 1024):
        fetch_calls.append((repo, path, ref))
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", fetch)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run when API detail succeeds"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        # api_search_first: 2026-08-22 기본 OFF — 이 테스트는 그 경로를 보므로 명시적으로 켠다.
        {"repos": ["platform/api"], "include_commits": False,
         "code_search_terms": ["AKIA"], "api_search_first": True},
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert meta_calls == ["platform/api"]
    assert ("platform/api", ".env", "develop") in fetch_calls
    assert ("platform/api", ".env", "main") not in fetch_calls

    row = _scanned(res, limit=10)[0]
    assert row["metadata"]["ref"] == "develop"


def test_github_task_scan_explicit_blank_repo_is_error_and_not_scanned(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("repo metadata must not run for a blank explicit repo"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("code search must wait for a valid repo target"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback listing must wait for a valid repo target"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit scan must wait for a valid repo target"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {"repos": ["   "], "include_commits": False},
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["errors"][0]["phase"] == "repo_candidate"
    assert payload["api_search"]["errors"][0]["phase"] == "repo_candidate"
    assert payload["api_search"]["target_status_counts"] == {"error": 1}
    assert payload["api_search"]["target_source_counts"] == {"explicit_repo": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "explicit_repo": {"error": 1},
    }
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert _scanned(res, limit=10) == []
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["target_status_counts"] == payload["api_search"]["target_status_counts"]
    assert evidence["api_search"]["target_source_counts"] == payload["api_search"]["target_source_counts"]
    assert evidence["api_search"]["target_status_by_source"] == payload["api_search"]["target_status_by_source"]
    assert evidence["target_details"] == [{
        "repo": "",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "status": "error",
        "error": "GitHub repo candidate missing full_name",
    }]


def test_github_task_scan_dedupes_explicit_repos_before_api_search(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("E" * 36)
    meta_calls: list[str] = []
    search_queries: list[str] = []
    fetch_calls: list[tuple[str, str, str]] = []

    def repo_meta(repo: str):
        meta_calls.append(repo)
        return GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-06-01T00:00:00Z",
        )

    def code_search(query: str, per_page: int = 50, max_results: int = 50):
        search_queries.append(query)
        return [service_task_tools.gh.GhCodeHit(repo="platform/api", path=".env")]

    def fetch(repo: str, path: str, *, ref: str = "HEAD", max_bytes: int = 512 * 1024):
        fetch_calls.append((repo, path, ref))
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "repo_meta", repo_meta)
    monkeypatch.setattr(service_task_tools.gh, "code_search", code_search)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", fetch)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run when API detail succeeds"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api", " Platform/API "],
            "include_commits": False,
            "code_search_terms": ["password"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["repositories"] == ["platform/api"]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["repo_duplicate_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["target_status_counts"] == {"skipped": 1, "selected": 1}
    assert payload["api_search"]["target_source_counts"] == {"explicit_repo": 2}
    assert payload["api_search"]["target_status_by_source"] == {
        "explicit_repo": {"skipped": 1, "selected": 1},
    }
    assert meta_calls == ["platform/api"]
    assert len(search_queries) == 1
    assert ("platform/api", ".env", "main") in fetch_calls
    assert len(_scanned(res, limit=10)) == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [
        {
            "repo": "Platform/API",
            "ref": "main",
            "default_branch": "main",
            "source": "explicit_repo",
            "status": "skipped",
            "error": "duplicate repo candidate",
        },
        {
            "repo": "platform/api",
            "ref": "main",
            "default_branch": "main",
            "source": "explicit_repo",
            "private": True,
            "archived": False,
            "pushed_at": "2026-06-01T00:00:00Z",
            "size_kb": 0,
        },
    ]


def test_github_task_scan_explicit_repo_limit_skips_overflow_without_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("P" * 36)
    meta_calls: list[str] = []
    search_queries: list[str] = []
    fetch_calls: list[tuple[str, str, str]] = []

    def repo_meta(repo: str):
        meta_calls.append(repo)
        if repo == "platform/overflow":
            raise AssertionError("repo beyond repo_limit must not fetch metadata")
        return GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-06-01T00:00:00Z",
        )

    def code_search(query: str, per_page: int = 50, max_results: int = 50):
        search_queries.append(query)
        assert "platform/overflow" not in query
        return [service_task_tools.gh.GhCodeHit(repo="platform/api", path=".env")]

    def fetch(repo: str, path: str, *, ref: str = "HEAD", max_bytes: int = 512 * 1024):
        fetch_calls.append((repo, path, ref))
        if repo == "platform/overflow":
            raise AssertionError("repo beyond repo_limit must not fetch details")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "repo_meta", repo_meta)
    monkeypatch.setattr(service_task_tools.gh, "code_search", code_search)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", fetch)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run when API detail succeeds"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api", "platform/overflow"],
            "repo_limit": 1,
            "include_commits": False,
            "code_search_terms": ["password"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "github_task_scan"
    assert payload["target_count"] == 1
    assert payload["repositories"] == ["platform/api"]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["repo_limit_skipped"] == 1
    assert payload["api_search"]["target_status_counts"] == {"skipped": 1, "selected": 1}
    assert payload["api_search"]["target_source_counts"] == {"explicit_repo": 2}
    assert payload["api_search"]["target_status_by_source"] == {
        "explicit_repo": {"skipped": 1, "selected": 1},
    }
    assert meta_calls == ["platform/api"]
    assert len(search_queries) == 1
    assert all("platform/api" in query for query in search_queries)
    assert ("platform/api", ".env", "main") in fetch_calls
    assert ("platform/api", ".env", "HEAD") in fetch_calls
    assert all(call[0] == "platform/api" for call in fetch_calls)

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [
        {
            "repo": "platform/overflow",
            "ref": "main",
            "default_branch": "main",
            "source": "explicit_repo",
            "status": "skipped",
            "error": "GitHub repo candidate beyond repo_limit",
        },
        {
            "repo": "platform/api",
            "ref": "main",
            "default_branch": "main",
            "source": "explicit_repo",
            "private": True,
            "archived": False,
            "pushed_at": "2026-06-01T00:00:00Z",
            "size_kb": 0,
        },
    ]
    assert evidence["api_search"]["repo_limit_skipped"] == 1
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/.env"


def test_github_task_scan_dedupes_org_repo_enum_before_api_search(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("F" * 36)
    search_queries: list[str] = []
    fetch_calls: list[tuple[str, str, str]] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "list_repos",
        lambda org, limit=20: [
            GhRepo(
                full_name="platform/api",
                default_branch="main",
                private=True,
                archived=False,
                pushed_at="2026-06-01T00:00:00Z",
            ),
            GhRepo(
                full_name=" Platform/API ",
                default_branch="main",
                private=True,
                archived=False,
                pushed_at="2026-06-01T00:00:00Z",
            ),
        ],
    )

    def code_search(query: str, per_page: int = 50, max_results: int = 50):
        search_queries.append(query)
        return [service_task_tools.gh.GhCodeHit(repo="platform/api", path=".env")]

    def fetch(repo: str, path: str, *, ref: str = "HEAD", max_bytes: int = 512 * 1024):
        fetch_calls.append((repo, path, ref))
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "code_search", code_search)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", fetch)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run when API detail succeeds"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "org": "platform",
            "include_commits": False,
            "code_search_terms": ["password"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["repositories"] == ["platform/api"]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["repo_duplicate_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["target_status_counts"] == {"skipped": 1, "selected": 1}
    assert payload["api_search"]["target_source_counts"] == {"list_repos": 2}
    assert payload["api_search"]["target_status_by_source"] == {
        "list_repos": {"skipped": 1, "selected": 1},
    }
    assert len(search_queries) == 1
    assert ("platform/api", ".env", "main") in fetch_calls
    assert ("platform/api", ".env", "HEAD") in fetch_calls
    assert len(_scanned(res, limit=10)) == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [
        {
            "repo": "Platform/API",
            "ref": "main",
            "default_branch": "main",
            "source": "list_repos",
            "status": "skipped",
            "error": "duplicate repo candidate",
        },
        {
            "repo": "platform/api",
            "ref": "main",
            "default_branch": "main",
            "source": "list_repos",
            "private": True,
            "archived": False,
            "pushed_at": "2026-06-01T00:00:00Z",
            "size_kb": 0,
        },
    ]


def test_github_task_scan_org_repo_list_audits_overreturned_repos(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("O" * 36)
    search_queries: list[str] = []
    fetch_calls: list[tuple[str, str, str]] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "list_repos",
        lambda org, limit=20: [
            GhRepo(
                full_name="platform/api",
                default_branch="main",
                private=True,
                archived=False,
                pushed_at="2026-06-01T00:00:00Z",
            ),
            GhRepo(
                full_name="platform/overflow",
                default_branch="main",
                private=True,
                archived=False,
                pushed_at="2026-06-01T00:00:00Z",
            ),
        ],
    )

    def code_search(query: str, per_page: int = 50, max_results: int = 50):
        search_queries.append(query)
        assert "platform/overflow" not in query
        return [service_task_tools.gh.GhCodeHit(repo="platform/api", path=".env")]

    def fetch(repo: str, path: str, *, ref: str = "HEAD", max_bytes: int = 512 * 1024):
        fetch_calls.append((repo, path, ref))
        if repo == "platform/overflow":
            raise AssertionError("repo beyond repo_limit must not fetch details")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "code_search", code_search)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", fetch)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run when API detail succeeds"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "org": "platform",
            "repo_limit": 1,
            "include_commits": False,
            "code_search_terms": ["password"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "github_task_scan"
    assert payload["target_count"] == 1
    assert payload["repositories"] == ["platform/api"]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["repo_list_attempts"] == [{
        "org": "platform",
        "source": "list_repos",
        "limit": 1,
        "returned": 2,
        "selected": 1,
        "duplicate": 0,
        "invalid": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["target_status_counts"] == {"skipped": 1, "selected": 1}
    assert payload["api_search"]["target_source_counts"] == {"list_repos": 2}
    assert payload["api_search"]["target_status_by_source"] == {
        "list_repos": {"skipped": 1, "selected": 1},
    }
    assert len(search_queries) == 1
    assert all("platform/api" in query for query in search_queries)
    assert ("platform/api", ".env", "main") in fetch_calls
    assert ("platform/api", ".env", "HEAD") in fetch_calls
    assert all(call[0] == "platform/api" for call in fetch_calls)

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [
        {
            "repo": "platform/overflow",
            "ref": "main",
            "default_branch": "main",
            "source": "list_repos",
            "status": "skipped",
            "error": "GitHub repo candidate beyond repo_limit",
        },
        {
            "repo": "platform/api",
            "ref": "main",
            "default_branch": "main",
            "source": "list_repos",
            "private": True,
            "archived": False,
            "pushed_at": "2026-06-01T00:00:00Z",
            "size_kb": 0,
        },
    ]
    assert evidence["api_search"]["repo_list_attempts"] == (
        payload["api_search"]["repo_list_attempts"]
    )
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/.env"


def test_github_task_scan_explicit_repo_meta_error_is_structured(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    def fail_meta(repo: str):
        raise RuntimeError("repo metadata API returned HTTP 503")

    monkeypatch.setattr(service_task_tools.gh, "repo_meta", fail_meta)
    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("code search must wait for repo metadata"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback listing must wait for repo metadata"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit scan must wait for repo metadata"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {"repos": ["platform/api"], "include_commits": False},
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert "HTTP 503" in payload["status_reason"]
    assert payload["errors"][0]["phase"] == "repo_meta"
    assert payload["errors"][0]["target"] == "platform/api"
    assert payload["api_search"]["errors"][0]["phase"] == "repo_meta"
    assert _scanned(res, limit=10) == []


def test_github_task_scan_missing_repo_meta_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    metadata: dict = {}
    monkeypatch.setattr(service_task_tools.gh, "repo_meta", lambda repo: None)
    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("code search must wait for repo metadata"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback listing must wait for repo metadata"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit scan must wait for repo metadata"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {"repos": ["platform/missing"], "include_commits": False},
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["status_reason"] == "repo metadata not found"
    assert payload["errors"][0]["phase"] == "repo_meta"
    assert metadata["_github_task_scan_recommended_status"] == "skipped"
    assert metadata["_github_task_scan_status_reason"] == "repo metadata not found"
    assert _scanned(res, limit=10) == []
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "platform/missing",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "status": "error",
        "phase": "repo_meta",
        "error": "repo metadata not found",
    }]


def test_github_task_scan_repo_meta_404_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    import httpx

    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    metadata: dict = {}

    def raise_404(repo: str):
        request = httpx.Request("GET", f"https://gh.test/api/v3/repos/{repo}")
        response = httpx.Response(404, request=request, json={"message": "Not Found"})
        raise httpx.HTTPStatusError("404 Not Found", request=request, response=response)

    monkeypatch.setattr(service_task_tools.gh, "repo_meta", raise_404)
    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("code search must wait for repo metadata"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback listing must wait for repo metadata"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit scan must wait for repo metadata"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {"repos": ["platform/missing"], "include_commits": False},
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["status_reason"] == "repo metadata not found"
    assert payload["errors"][0]["phase"] == "repo_meta"
    assert payload["api_search"]["errors"][0]["phase"] == "repo_meta"
    assert metadata["_github_task_scan_recommended_status"] == "skipped"
    assert metadata["_github_task_scan_status_reason"] == "repo metadata not found"
    assert _scanned(res, limit=10) == []
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "platform/missing",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "status": "error",
        "phase": "repo_meta",
        "error": "repo metadata not found",
        "status_code": 404,
    }]


def test_github_task_scan_repo_meta_403_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    import httpx

    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    metadata: dict = {}

    def raise_403(repo: str):
        request = httpx.Request("GET", f"https://gh.test/api/v3/repos/{repo}")
        response = httpx.Response(403, request=request, json={"message": "Forbidden"})
        raise httpx.HTTPStatusError("403 Forbidden", request=request, response=response)

    monkeypatch.setattr(service_task_tools.gh, "repo_meta", raise_403)
    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("code search must wait for repo metadata"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback listing must wait for repo metadata"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit scan must wait for repo metadata"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {"repos": ["platform/private"], "include_commits": False},
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["status_reason"] == "repo metadata not found"
    assert payload["errors"][0]["phase"] == "repo_meta"
    assert payload["api_search"]["errors"][0]["phase"] == "repo_meta"
    assert metadata["_github_task_scan_recommended_status"] == "skipped"
    assert metadata["_github_task_scan_status_reason"] == "repo metadata not found"
    assert _scanned(res, limit=10) == []
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "platform/private",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "status": "error",
        "phase": "repo_meta",
        "error": "repo metadata not found",
        "status_code": 403,
    }]


def test_github_task_scan_refed_missing_repo_search_404_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    import httpx

    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    metadata: dict = {}
    meta_calls: list[str] = []

    def missing_repo_meta(repo: str):
        meta_calls.append(repo)
        return None

    def raise_404(query: str, per_page: int = 50, max_results: int = 50):
        request = httpx.Request("GET", "https://gh.test/api/v3/search/code")
        response = httpx.Response(404, request=request, json={"message": "Not Found"})
        raise httpx.HTTPStatusError("404 Not Found", request=request, response=response)

    monkeypatch.setattr(service_task_tools.gh, "repo_meta", missing_repo_meta)
    monkeypatch.setattr(service_task_tools.gh, "code_search", raise_404)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run for a missing repo"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit scan must not run after missing repo is proven"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/missing"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
        },
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["status_reason"] == "repo metadata not found"
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["errors"][0]["phase"] == "repo_meta"
    assert payload["api_search"]["errors"][0]["phase"] == "repo_meta"
    assert metadata["_github_task_scan_recommended_status"] == "skipped"
    assert metadata["_github_task_scan_status_reason"] == "repo metadata not found"
    assert meta_calls == ["platform/missing"]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_refed_inaccessible_repo_search_403_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    import httpx

    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    metadata: dict = {}
    meta_calls: list[str] = []

    def inaccessible_repo_meta(repo: str):
        meta_calls.append(repo)
        request = httpx.Request("GET", f"https://gh.test/api/v3/repos/{repo}")
        response = httpx.Response(403, request=request, json={"message": "Forbidden"})
        raise httpx.HTTPStatusError("403 Forbidden", request=request, response=response)

    def raise_403(query: str, per_page: int = 50, max_results: int = 50):
        request = httpx.Request("GET", "https://gh.test/api/v3/search/code")
        response = httpx.Response(403, request=request, json={"message": "Forbidden"})
        raise httpx.HTTPStatusError("403 Forbidden", request=request, response=response)

    monkeypatch.setattr(service_task_tools.gh, "repo_meta", inaccessible_repo_meta)
    monkeypatch.setattr(service_task_tools.gh, "code_search", raise_403)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run after inaccessible repo is proven"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit scan must not run after inaccessible repo is proven"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/private"],
            "ref": "main",
            "code_search_terms": ["password"],
        },
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["status_reason"] == "repo metadata not found"
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["commit_count"] == 0
    assert payload["errors"][0]["phase"] == "repo_meta"
    assert payload["api_search"]["errors"][0]["phase"] == "repo_meta"
    assert metadata["_github_task_scan_recommended_status"] == "skipped"
    assert metadata["_github_task_scan_status_reason"] == "repo metadata not found"
    assert meta_calls == ["platform/private"]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_missing_repo_fallback_404_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    import httpx

    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    metadata: dict = {}
    meta_calls: list[str] = []

    def missing_repo_meta(repo: str):
        meta_calls.append(repo)
        return None

    def raise_404(repo: str, ref: str, *, hot_paths):
        request = httpx.Request("GET", f"https://gh.test/api/v3/repos/{repo}/git/ref/heads/{ref}")
        response = httpx.Response(404, request=request, json={"message": "Not Found"})
        raise httpx.HTTPStatusError("404 Not Found", request=request, response=response)

    monkeypatch.setattr(service_task_tools.gh, "repo_meta", missing_repo_meta)
    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", raise_404)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/missing"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
        },
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["errors"][0]["phase"] == "repo_meta"
    assert payload["api_search"]["errors"][0]["phase"] == "repo_meta"
    assert meta_calls == ["platform/missing"]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_inaccessible_repo_fallback_403_skips_commits(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    import httpx

    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    metadata: dict = {}
    meta_calls: list[str] = []

    def inaccessible_repo_meta(repo: str):
        meta_calls.append(repo)
        request = httpx.Request("GET", f"https://gh.test/api/v3/repos/{repo}")
        response = httpx.Response(403, request=request, json={"message": "Forbidden"})
        raise httpx.HTTPStatusError("403 Forbidden", request=request, response=response)

    def raise_403(repo: str, ref: str, *, hot_paths):
        request = httpx.Request("GET", f"https://gh.test/api/v3/repos/{repo}/git/ref/heads/{ref}")
        response = httpx.Response(403, request=request, json={"message": "Forbidden"})
        raise httpx.HTTPStatusError("403 Forbidden", request=request, response=response)

    monkeypatch.setattr(service_task_tools.gh, "repo_meta", inaccessible_repo_meta)
    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", raise_403)
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit scan must not run after inaccessible repo is proven"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/private"],
            "ref": "main",
            "code_search_terms": ["password"],
        },
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["commit_count"] == 0
    assert payload["errors"][0]["phase"] == "repo_meta"
    assert payload["api_search"]["errors"][0]["phase"] == "repo_meta"
    assert metadata["_github_task_scan_recommended_status"] == "skipped"
    assert metadata["_github_task_scan_status_reason"] == "repo metadata not found"
    assert meta_calls == ["platform/private"]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_missing_repo_commit_patch_404_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    import httpx

    from secu_agent import state
    from service import state_domain
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    metadata: dict = {}
    meta_calls: list[str] = []

    def missing_repo_meta(repo: str):
        meta_calls.append(repo)
        return None

    def raise_404(repo: str, *, limit: int = 3, since_sha=None):
        assert since_sha == "old-sha"
        request = httpx.Request("GET", f"https://gh.test/api/v3/repos/{repo}/commits")
        response = httpx.Response(404, request=request, json={"message": "Not Found"})
        raise httpx.HTTPStatusError("404 Not Found", request=request, response=response)

    state_domain.github_repo_set_scanned_sha("platform/missing", "old-sha")
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_repos",
        lambda org, limit=20: [
            GhRepo(
                full_name="platform/missing",
                default_branch="main",
                private=True,
                archived=False,
                pushed_at="2026-06-01T00:00:00Z",
            ),
        ],
    )
    monkeypatch.setattr(service_task_tools.gh, "repo_meta", missing_repo_meta)
    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", raise_404)

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "org": "platform",
            "ref": "main",
            "include_commits": True,
            "code_search_terms": ["password"],
        },
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["commit_count"] == 0
    assert payload["errors"][0]["phase"] == "repo_meta"
    assert payload["api_search"]["errors"][0]["phase"] == "repo_meta"
    assert metadata["_github_task_scan_recommended_status"] == "skipped"
    assert metadata["_github_task_scan_status_reason"] == "repo metadata not found"
    assert meta_calls == ["platform/missing"]
    assert state_domain.github_repo_get_scanned_sha("platform/missing") == "old-sha"
    assert _scanned(res, limit=10) == []


def test_github_task_scan_org_repo_enum_error_is_structured(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    def fail_list_repos(org: str, *, limit: int = 20):
        raise RuntimeError("repo enum API returned HTTP 503")

    monkeypatch.setattr(service_task_tools.gh, "list_repos", fail_list_repos)
    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("code search must wait for repo enum"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback listing must wait for repo enum"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit scan must wait for repo enum"),
        ),
    )

    res = _run(GithubTaskScanTool(), {"org": "platform"}, tmp_path, {})

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "HTTP 503" in payload["status_reason"]
    assert payload["errors"][0]["phase"] == "list_repos"
    assert payload["errors"][0]["target"] == "platform"
    assert payload["api_search"]["errors"][0]["phase"] == "list_repos"
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert _scanned(res, limit=10) == []
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "",
        "org": "platform",
        "ref": "main",
        "default_branch": "main",
        "source": "list_repos",
        "status": "error",
        "phase": "list_repos",
        "error": "RuntimeError('repo enum API returned HTTP 503')",
        "status_code": 503,
    }]


def test_github_task_scan_empty_org_repo_list_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    list_calls: list[tuple[str, int]] = []

    def list_repos(org: str, *, limit: int = 20):
        list_calls.append((org, limit))
        return []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("empty GitHub repo list must not fetch details")

    monkeypatch.setattr(service_task_tools.gh, "list_repos", list_repos)
    monkeypatch.setattr(service_task_tools.gh, "repo_meta", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    metadata: dict = {}
    res = _run(
        GithubTaskScanTool(),
        {"org": "platform", "repo_limit": 3},
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "github_task_scan"
    assert payload["target_count"] == 0
    assert payload["repositories"] == []
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "no selected targets" in payload["status_reason"]
    assert payload["errors"] == []
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["list_no_candidates"] == 1
    assert payload["api_search"]["repo_list_attempts"] == [{
        "org": "platform",
        "source": "list_repos",
        "limit": 3,
        "returned": 0,
        "selected": 0,
        "duplicate": 0,
        "invalid": 0,
        "skipped": 0,
        "no_candidates": 1,
    }]
    assert payload["api_search"]["target_status_counts"] == {"skipped": 1}
    assert payload["api_search"]["target_source_counts"] == {"list_repos": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "list_repos": {"skipped": 1},
    }
    assert list_calls == [("platform", 3)]
    assert metadata["_github_task_scan_status"] == "skipped"
    assert metadata["_github_task_scan_recommended_status"] == "skipped"
    assert "no selected targets" in metadata["_github_task_scan_status_reason"]
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["targets"] == []
    assert evidence["target_details"] == [{
        "repo": "",
        "org": "platform",
        "ref": "main",
        "default_branch": "main",
        "source": "list_repos",
        "status": "skipped",
        "phase": "list_repos",
        "error": "GitHub repo list returned no candidates",
    }]
    assert evidence["api_search"]["list_no_candidates"] == 1
    assert evidence["api_search"]["repo_list_attempts"] == (
        payload["api_search"]["repo_list_attempts"]
    )
    assert evidence["scan_status"] == payload["scan_status"]
    assert evidence["recommended_target_status"] == payload["recommended_target_status"]
    assert evidence["status_reason"] == payload["status_reason"]


def test_github_task_scan_org_repo_missing_full_name_is_error_and_not_scanned(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "list_repos",
        lambda org, limit=20: [
            GhRepo(
                full_name="  ",
                default_branch="main",
                private=True,
                archived=False,
                pushed_at="2026-06-01T00:00:00Z",
            ),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("code search must wait for a valid repo target"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback listing must wait for a valid repo target"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit scan must wait for a valid repo target"),
        ),
    )

    res = _run(GithubTaskScanTool(), {"org": "platform"}, tmp_path, {})

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["errors"][0]["phase"] == "repo_candidate"
    assert payload["api_search"]["errors"][0]["phase"] == "repo_candidate"
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["repo_list_attempts"] == [{
        "org": "platform",
        "source": "list_repos",
        "limit": 20,
        "returned": 1,
        "selected": 0,
        "duplicate": 0,
        "invalid": 1,
        "skipped": 1,
    }]
    assert _scanned(res, limit=10) == []
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "",
        "ref": "main",
        "default_branch": "main",
        "source": "list_repos",
        "status": "error",
        "error": "GitHub repo candidate missing full_name",
    }]
    assert evidence["api_search"]["repo_list_attempts"] == (
        payload["api_search"]["repo_list_attempts"]
    )


def test_github_task_scan_limits_candidate_detail_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    tokens = {
        "one.env": "ghp_" + ("L" * 36),
        "two.env": "ghp_" + ("M" * 36),
        "three.env": "ghp_" + ("N" * 36),
    }
    fetch_calls: list[tuple[str, str, str]] = []
    search_queries: list[str] = []

    def code_search(query: str, per_page: int = 50, max_results: int = 50):
        search_queries.append(query)
        return [
            service_task_tools.gh.GhCodeHit(repo="platform/api", path="one.env"),
            service_task_tools.gh.GhCodeHit(repo="platform/api", path="two.env"),
            service_task_tools.gh.GhCodeHit(repo="platform/api", path="three.env"),
        ]

    def fetch(repo: str, path: str, *, ref: str = "HEAD", max_bytes: int = 512 * 1024):
        fetch_calls.append((repo, path, ref))
        return f"GITHUB_TOKEN={tokens[path]}\n"

    monkeypatch.setattr(service_task_tools.gh, "code_search", code_search)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", fetch)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run when API detail succeeds"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
            "max_candidate_files": 2,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 2
    assert payload["api_search"]["candidate_count"] == 2
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["query_details"] == [{
        "repo": "platform/api",
        "query": "repo:platform/api password",
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
    assert payload["api_search"]["detail_source_counts"] == {"code_search": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "code_search": {"fetched": 2, "skipped": 1},
    }
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert len(search_queries) == 1
    assert [path for _, path, ref in fetch_calls if ref == "main"] == ["one.env", "two.env"]
    assert "three.env" not in {path for _, path, _ in fetch_calls}
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    skipped_details = [
        detail for detail in evidence["file_details"]
        if detail.get("candidate_source") == "code_search"
        and detail.get("status") == "skipped"
    ]
    assert skipped_details == [{
        "repo": "platform/api",
        "target_repo": "platform/api",
        "path": "three.env",
        "candidate_source": "code_search",
        "candidate_query": "repo:platform/api password",
        "status": "skipped",
        "error": "GitHub code-search candidate beyond max_candidate_files",
    }]
    assert len(_scanned(res, limit=10)) == 2


def test_github_task_scan_no_api_candidates_uses_bounded_hot_path_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBlobRef
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    tokens = {
        "sha1": "ghp_" + ("P" * 36),
        "sha2": "ghp_" + ("Q" * 36),
        "sha3": "ghp_" + ("R" * 36),
    }
    blob_fetch_calls: list[str] = []

    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, hot_paths: [
            GhBlobRef(repo=repo, ref=ref, path="one.env", sha="sha1", size=80),
            GhBlobRef(repo=repo, ref=ref, path="two.env", sha="sha2", size=80),
            GhBlobRef(repo=repo, ref=ref, path="three.env", sha="sha3", size=80),
        ],
    )

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append(sha)
        return f"GITHUB_TOKEN={tokens[sha]}\n"

    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", lambda *args, **kwargs: None)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
            "max_files_per_repo": 2,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 2
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_hot_path_tree"] == 2
    assert len(payload["api_search"]["fallback_attempts"]) == 1
    fallback_attempt = payload["api_search"]["fallback_attempts"][0]
    assert fallback_attempt["repo"] == "platform/api"
    assert fallback_attempt["ref"] == "main"
    assert fallback_attempt["reason"] == "no_api_candidates"
    assert fallback_attempt["returned"] == 3
    assert fallback_attempt["selected"] == 2
    assert fallback_attempt["candidate_limit_hit"] is True
    assert fallback_attempt["limit_skipped"] == 1
    assert fallback_attempt["skipped"] == 1
    assert payload["api_search"]["fallback_status_counts"] == {"searched": 1}
    assert payload["api_search"]["fallback_reason_counts"] == {"no_api_candidates": 1}
    assert payload["api_search"]["fallback_candidate_totals"] == {
        "returned": 3,
        "selected": 2,
        "added": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "limit_skipped": 1,
        "skipped": 1,
    }
    assert payload["api_search"]["detail_fetched"] == 2
    assert payload["api_search"]["detail_status_counts"] == {"fetched": 2, "skipped": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {
        "file": {"fetched": 2, "skipped": 1},
    }
    assert payload["api_search"]["detail_source_counts"] == {"hot_path_tree": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "hot_path_tree": {"fetched": 2, "skipped": 1},
    }
    assert payload["api_search"]["detail_query_counts"] == {"(no query)": 3}
    assert payload["api_search"]["detail_status_by_query"] == {
        "(no query)": {"fetched": 2, "skipped": 1},
    }
    assert payload["api_search"]["detail_status_total"] == 3
    assert payload["api_search"]["target_status_counts"] == {"selected": 1}
    assert payload["api_search"]["target_source_counts"] == {"explicit_repo": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "explicit_repo": {"selected": 1},
    }
    scan_summary = payload["api_search"]["scan_summary"]
    assert scan_summary["artifact_count"] == 2
    assert scan_summary["artifact_source_counts"] == {"hot_path_tree": 2}
    assert scan_summary["hit_artifact_count"] == 2
    assert scan_summary["hit_source_counts"] == {"hot_path_tree": 2}
    assert scan_summary["reportable_artifact_count"] == 2
    assert scan_summary["reportable_source_counts"] == {"hot_path_tree": 2}
    assert scan_summary["low_value_only_artifact_count"] == 0
    assert blob_fetch_calls == ["sha1", "sha2"]
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_count"] == payload["target_count"]
    assert evidence["targets"] == payload["repositories"]
    assert evidence["target_details"] == [{
        "repo": "platform/api",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
    }]
    assert evidence["file_details"] == [
        {
            "repo": "platform/api",
            "path": "one.env",
            "ref": "main",
            "sha": "sha1",
            "size": 80,
            "candidate_source": "hot_path_tree",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "path": "two.env",
            "ref": "main",
            "sha": "sha2",
            "size": 80,
            "candidate_source": "hot_path_tree",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "path": "three.env",
            "ref": "main",
            "sha": "sha3",
            "size": 80,
            "candidate_source": "hot_path_tree",
            "candidate_query": "",
            "status": "skipped",
            "error": "GitHub hot-path blob candidate beyond max_files_per_repo",
        },
    ]
    assert evidence["api_search"]["fallback_attempts"] == payload["api_search"]["fallback_attempts"]
    assert evidence["api_search"]["fallback_reason"] == "no_api_candidates"
    assert evidence["api_search"]["fallback_hot_path_tree"] == 2
    assert evidence["api_search"]["fallback_status_counts"] == payload["api_search"]["fallback_status_counts"]
    assert evidence["api_search"]["fallback_reason_counts"] == payload["api_search"]["fallback_reason_counts"]
    assert evidence["api_search"]["fallback_candidate_totals"] == payload["api_search"]["fallback_candidate_totals"]
    assert evidence["api_search"]["detail_status_counts"] == payload["api_search"]["detail_status_counts"]
    assert evidence["api_search"]["detail_status_by_kind"] == payload["api_search"]["detail_status_by_kind"]
    assert evidence["api_search"]["detail_source_counts"] == payload["api_search"]["detail_source_counts"]
    assert evidence["api_search"]["detail_status_by_source"] == payload["api_search"]["detail_status_by_source"]
    assert evidence["api_search"]["detail_query_counts"] == payload["api_search"]["detail_query_counts"]
    assert evidence["api_search"]["detail_status_by_query"] == payload["api_search"]["detail_status_by_query"]
    assert evidence["api_search"]["detail_status_total"] == payload["api_search"]["detail_status_total"]
    assert evidence["api_search"]["target_status_counts"] == payload["api_search"]["target_status_counts"]
    assert evidence["api_search"]["target_source_counts"] == payload["api_search"]["target_source_counts"]
    assert evidence["api_search"]["target_status_by_source"] == payload["api_search"]["target_status_by_source"]
    assert evidence["api_search"]["scan_summary"] == payload["api_search"]["scan_summary"]
    assert evidence["scan_status"] == payload["scan_status"]
    assert evidence["recommended_target_status"] == payload["recommended_target_status"]
    assert evidence["status_reason"] == payload["status_reason"]
    assert len(_scanned(res, limit=10)) == 2


def test_github_task_scan_empty_hot_path_fallback_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    list_path_calls: list[tuple[str, str, tuple[str, ...]]] = []

    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])

    def list_paths_matching(repo: str, ref: str, *, hot_paths):
        list_path_calls.append((repo, ref, tuple(hot_paths)))
        return []

    def forbidden_detail_fetch(*args, **kwargs):
        raise AssertionError("empty hot-path fallback must not fetch details")

    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", list_paths_matching)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_detail_fetch)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_detail_fetch)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_detail_fetch)

    metadata: dict = {}
    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 2,
        },
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "only skipped targets" in payload["status_reason"]
    assert metadata["_github_task_scan_status"] == "skipped"
    assert metadata["_github_task_scan_recommended_status"] == "skipped"
    assert "only skipped targets" in metadata["_github_task_scan_status_reason"]
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["list_no_candidates"] == 1
    assert payload["api_search"]["errors"] == []
    assert payload["api_search"]["fallback_attempts"] == [{
        "repo": "platform/api",
        "ref": "main",
        "reason": "no_api_candidates",
        "returned": 0,
        "selected": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 0,
        "no_candidates": 1,
    }]
    assert payload["api_search"]["fallback_status_counts"] == {"searched": 1}
    assert payload["api_search"]["fallback_reason_counts"] == {"no_api_candidates": 1}
    assert payload["api_search"]["detail_status_counts"] == {"skipped": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {"file": {"skipped": 1}}
    assert payload["api_search"]["detail_source_counts"] == {"hot_path_tree": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "hot_path_tree": {"skipped": 1},
    }
    assert payload["api_search"]["detail_query_counts"] == {"(no query)": 1}
    assert payload["api_search"]["detail_status_by_query"] == {
        "(no query)": {"skipped": 1},
    }
    assert payload["api_search"]["detail_status_total"] == 1
    assert list_path_calls == [("platform/api", "main", ("prod.env",))]
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "candidate_source": "hot_path_tree",
        "candidate_query": "",
        "status": "skipped",
        "content_present": False,
        "error": "GitHub hot-path fallback returned no candidates",
        "ref": "main",
        "fallback_reason": "no_api_candidates",
    }]
    assert evidence["api_search"]["list_no_candidates"] == 1
    assert evidence["api_search"]["fallback_attempts"] == payload["api_search"]["fallback_attempts"]
    assert evidence["scan_status"] == payload["scan_status"]
    assert evidence["recommended_target_status"] == payload["recommended_target_status"]
    assert evidence["status_reason"] == payload["status_reason"]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_branch_list_uses_bounded_branch_blob_details(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhBranch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("S" * 36)
    list_path_calls: list[tuple[str, str, tuple[str, ...]]] = []
    blob_fetch_calls: list[str] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("branch-list scan must not run broad API search or commit fallback")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_branches",
        lambda repo, limit=20: [
            GhBranch(repo=repo, name="main", commit_sha="sha-main"),
            GhBranch(repo=repo, name="feature/secrets", commit_sha="sha-feature"),
        ],
    )

    def list_paths_matching(repo: str, ref: str, *, hot_paths):
        list_path_calls.append((repo, ref, tuple(hot_paths)))
        if ref == "feature/secrets":
            return [
                GhBlobRef(
                    repo=repo,
                    ref="sha-feature",
                    path="config/prod.env",
                    sha="blob-feature",
                    size=80,
                ),
                GhBlobRef(
                    repo=repo,
                    ref="sha-feature",
                    path="config/overflow.env",
                    sha="blob-overflow",
                    size=90,
                ),
            ]
        return []

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append(sha)
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", list_paths_matching)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_branches": True,
            "branch_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 1,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-BRANCH-LIST"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["branch_count"] == 2
    assert payload["api_search"]["branch_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 2,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 2,
        "no_candidates": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"branch_list": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "branch_list": {"skipped": 2, "fetched": 1},
    }
    scan_summary = payload["api_search"]["scan_summary"]
    assert scan_summary["artifact_source_counts"] == {"branch_list": 1}
    assert scan_summary["reportable_source_counts"] == {"branch_list": 1}
    assert list_path_calls == [
        ("platform/api", "main", ("prod.env",)),
        ("platform/api", "feature/secrets", ("prod.env",)),
    ]
    assert blob_fetch_calls == ["blob-feature"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "platform/api",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "include_branches": True,
        "branch_limit": 3,
        "private": True,
        "archived": False,
        "pushed_at": "2026-05-24T00:00:00Z",
        "size_kb": 0,
    }]
    assert evidence["branch_details"] == [
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "name": "main",
            "commit_sha": "sha-main",
            "candidate_source": "branch_list",
            "candidate_query": "branches",
            "status": "skipped",
            "returned": 0,
            "selected": 0,
            "content_present": False,
            "error": "GitHub branch-list blob search returned no candidates",
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "name": "feature/secrets",
            "commit_sha": "sha-feature",
            "candidate_source": "branch_list",
            "candidate_query": "branches",
            "status": "listed",
            "returned": 2,
            "selected": 1,
            "candidate_limit_hit": True,
            "limit_skipped": 1,
        },
    ]
    assert evidence["file_details"] == [
        {
            "repo": "platform/api",
            "path": "config/prod.env",
            "ref": "sha-feature",
            "sha": "blob-feature",
            "size": 80,
            "branch": "feature/secrets",
            "branch_commit_sha": "sha-feature",
            "candidate_source": "branch_list",
            "candidate_query": "feature/secrets",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "path": "config/overflow.env",
            "ref": "sha-feature",
            "sha": "blob-overflow",
            "size": 90,
            "branch": "feature/secrets",
            "branch_commit_sha": "sha-feature",
            "candidate_source": "branch_list",
            "candidate_query": "feature/secrets",
            "status": "skipped",
            "error": "GitHub branch-list blob candidate beyond max_files_per_repo",
        },
    ]
    assert evidence["artifacts"][0]["metadata"]["scan_method"] == "api_branch_hot_path_tree_scan"
    assert evidence["artifacts"][0]["metadata"]["candidate_source"] == "branch_list"
    assert evidence["artifacts"][0]["metadata"]["branch"] == "feature/secrets"


def test_github_task_scan_branch_list_skips_out_of_scope_blobs_before_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhBranch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("Y" * 36)
    blob_fetch_calls: list[tuple[str, str]] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("branch-list scope gate must not broaden to search or fallback")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_branches",
        lambda repo, limit=20: [
            GhBranch(repo=repo, name="feature/secrets", commit_sha="sha-feature"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, *, hot_paths: [
            GhBlobRef(
                repo="other/repo",
                ref="sha-feature",
                path="config/stolen.env",
                sha="blob-foreign",
                size=80,
            ),
            GhBlobRef(
                repo="",
                ref="sha-feature",
                path="config/unscoped.env",
                sha="blob-unscoped",
                size=80,
            ),
            GhBlobRef(
                repo=repo,
                ref="sha-feature",
                path="config/prod.env",
                sha="blob-live",
                size=80,
            ),
        ],
    )

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append((repo, sha))
        if repo != "platform/api" or sha != "blob-live":
            raise AssertionError("out-of-scope branch-list blob must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_branches": True,
            "branch_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["*.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-BRANCH-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["errors"] == []
    assert payload["api_search"]["out_of_scope_count"] == 2
    assert payload["api_search"]["branch_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 1,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 2,
        "duplicate": 0,
        "skipped": 2,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"branch_list": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "branch_list": {"skipped": 2, "fetched": 1},
    }
    assert payload["api_search"]["scan_summary"]["artifact_source_counts"] == {"branch_list": 1}
    assert blob_fetch_calls == [("platform/api", "blob-live")]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [
        {
            "repo": "other/repo",
            "target_repo": "platform/api",
            "path": "config/stolen.env",
            "ref": "sha-feature",
            "sha": "blob-foreign",
            "branch": "feature/secrets",
            "candidate_source": "branch_list",
            "candidate_query": "feature/secrets",
            "status": "skipped",
            "error": "GitHub branch-list blob candidate out of requested repo scope",
        },
        {
            "repo": "",
            "target_repo": "platform/api",
            "path": "config/unscoped.env",
            "ref": "sha-feature",
            "sha": "blob-unscoped",
            "branch": "feature/secrets",
            "candidate_source": "branch_list",
            "candidate_query": "feature/secrets",
            "status": "skipped",
            "error": "GitHub branch-list blob candidate out of requested repo scope",
        },
        {
            "repo": "platform/api",
            "path": "config/prod.env",
            "ref": "sha-feature",
            "sha": "blob-live",
            "size": 80,
            "branch": "feature/secrets",
            "branch_commit_sha": "sha-feature",
            "candidate_source": "branch_list",
            "candidate_query": "feature/secrets",
            "status": "fetched",
            "content_present": True,
        },
    ]
    assert evidence["artifacts"][0]["asset"] == "github:platform/api/config/prod.env"


def test_github_task_scan_branch_list_skips_out_of_scope_branch_before_listing(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBranch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("out-of-scope branch candidate must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_branches",
        lambda repo, limit=20: [
            GhBranch(repo="other/repo", name="feature/secrets", commit_sha="sha-feature"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope branch candidate must not list branch blobs"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_branches": True,
            "branch_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["*.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-BRANCH-CANDIDATE-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["errors"] == []
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["branch_count"] == 0
    assert payload["api_search"]["branch_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 1,
        "selected": 0,
        "invalid": 0,
        "out_of_scope": 1,
        "duplicate": 0,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"branch_list": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "branch_list": {"skipped": 1},
    }
    assert payload["api_search"]["fallback_hot_path_tree"] == 0

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["branch_details"] == [{
        "repo": "other/repo",
        "target_repo": "platform/api",
        "name": "feature/secrets",
        "commit_sha": "sha-feature",
        "candidate_source": "branch_list",
        "candidate_query": "branches",
        "status": "skipped",
        "error": "GitHub branch candidate out of requested repo scope",
    }]
    assert evidence["file_details"] == []
    assert _scanned(res, limit=10) == []


def test_github_task_scan_branch_list_requires_repo_scope_before_listing(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBranch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("unscoped branch candidate must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_branches",
        lambda repo, limit=20: [
            GhBranch(repo="", name="feature/secrets", commit_sha="sha-feature"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("unscoped branch candidate must not list branch blobs"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_branches": True,
            "branch_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["*.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-BRANCH-REPO-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["errors"] == []
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["branch_count"] == 0
    assert payload["api_search"]["branch_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 1,
        "selected": 0,
        "invalid": 0,
        "out_of_scope": 1,
        "duplicate": 0,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"branch_list": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "branch_list": {"skipped": 1},
    }
    assert payload["api_search"]["fallback_hot_path_tree"] == 0

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["branch_details"] == [{
        "repo": "",
        "target_repo": "platform/api",
        "name": "feature/secrets",
        "commit_sha": "sha-feature",
        "candidate_source": "branch_list",
        "candidate_query": "branches",
        "status": "skipped",
        "error": "GitHub branch candidate out of requested repo scope",
    }]
    assert evidence["file_details"] == []
    assert _scanned(res, limit=10) == []


def test_github_task_scan_branch_list_marks_limit_hit_for_overreturned_branches(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhBranch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("W" * 36)
    list_path_calls: list[tuple[str, str, tuple[str, ...]]] = []
    blob_fetch_calls: list[str] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("branch-list over-return must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_branches",
        lambda repo, limit=20: [
            GhBranch(repo=repo, name="main", commit_sha="sha-main"),
            GhBranch(repo=repo, name="feature/overflow", commit_sha="sha-overflow"),
        ],
    )

    def list_paths_matching(repo: str, ref: str, *, hot_paths):
        list_path_calls.append((repo, ref, tuple(hot_paths)))
        if ref == "main":
            return [
                GhBlobRef(
                    repo=repo,
                    ref="sha-main",
                    path="config/prod.env",
                    sha="blob-main",
                    size=80,
                ),
            ]
        raise AssertionError("branch beyond branch_limit must not list blobs")

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append(sha)
        if sha != "blob-main":
            raise AssertionError("branch beyond branch_limit must not fetch blobs")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", list_paths_matching)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_branches": True,
            "branch_limit": 1,
            "code_search_terms": ["password"],
            "hot_paths": ["*.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-BRANCH-LIST-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["branch_count"] == 1
    assert payload["api_search"]["branch_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 1,
        "returned": 2,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"branch_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "branch_list": {"skipped": 1, "fetched": 1},
    }
    assert list_path_calls == [("platform/api", "main", ("*.env",))]
    assert blob_fetch_calls == ["blob-main"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["api_search"]["branch_list_attempts"] == (
        payload["api_search"]["branch_list_attempts"]
    )
    assert evidence["branch_details"] == [
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "name": "main",
            "commit_sha": "sha-main",
            "candidate_source": "branch_list",
            "candidate_query": "branches",
            "status": "listed",
            "returned": 1,
            "selected": 1,
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "name": "feature/overflow",
            "commit_sha": "sha-overflow",
            "candidate_source": "branch_list",
            "candidate_query": "branches",
            "status": "skipped",
            "error": "GitHub branch-list candidate beyond branch_limit",
        },
    ]
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "path": "config/prod.env",
        "ref": "sha-main",
        "sha": "blob-main",
        "size": 80,
        "branch": "main",
        "branch_commit_sha": "sha-main",
        "candidate_source": "branch_list",
        "candidate_query": "main",
        "status": "fetched",
        "content_present": True,
    }]
    assert [row["asset"] for row in _scanned(res, limit=10)] == [
        "github:platform/api/config/prod.env",
    ]


def test_github_task_scan_branch_list_marks_limit_hit_and_skips_excess_blobs(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhBranch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    token_one = "ghp_" + ("U" * 36)
    token_two = "ghp_" + ("V" * 36)
    list_path_calls: list[tuple[str, str, tuple[str, ...]]] = []
    blob_fetch_calls: list[str] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("branch-list limit hit must not broaden to search or commit fallback")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_branches",
        lambda repo, limit=20: [
            GhBranch(repo=repo, name="feature/secrets", commit_sha="sha-feature"),
        ],
    )

    def list_paths_matching(repo: str, ref: str, *, hot_paths):
        list_path_calls.append((repo, ref, tuple(hot_paths)))
        return [
            GhBlobRef(
                repo=repo,
                ref="sha-feature",
                path="config/first.env",
                sha="blob-one",
                size=80,
            ),
            GhBlobRef(
                repo=repo,
                ref="sha-feature",
                path="config/second.env",
                sha="blob-two",
                size=80,
            ),
            GhBlobRef(
                repo=repo,
                ref="sha-feature",
                path="config/third.env",
                sha="blob-three",
                size=80,
            ),
        ]

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append(sha)
        if sha == "blob-one":
            return f"GITHUB_TOKEN={token_one}\n"
        if sha == "blob-two":
            return f"GITHUB_TOKEN={token_two}\n"
        raise AssertionError("branch-list blobs beyond max_files_per_repo must not be fetched")

    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", list_paths_matching)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_branches": True,
            "branch_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["*.env"],
            "max_files_per_repo": 2,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-BRANCH-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 2
    assert payload["artifacts_scanned"] == 2
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["branch_count"] == 1
    assert payload["api_search"]["branch_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 1,
        "selected": 2,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"branch_list": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "branch_list": {"fetched": 2, "skipped": 1},
    }
    assert list_path_calls == [("platform/api", "feature/secrets", ("*.env",))]
    assert blob_fetch_calls == ["blob-one", "blob-two"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["api_search"]["branch_list_attempts"] == (
        payload["api_search"]["branch_list_attempts"]
    )
    assert evidence["branch_details"] == [{
        "repo": "platform/api",
        "target_repo": "platform/api",
        "name": "feature/secrets",
        "commit_sha": "sha-feature",
        "candidate_source": "branch_list",
        "candidate_query": "branches",
        "status": "listed",
        "returned": 3,
        "selected": 2,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert evidence["file_details"] == [
        {
            "repo": "platform/api",
            "path": "config/first.env",
            "ref": "sha-feature",
            "sha": "blob-one",
            "size": 80,
            "branch": "feature/secrets",
            "branch_commit_sha": "sha-feature",
            "candidate_source": "branch_list",
            "candidate_query": "feature/secrets",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "path": "config/second.env",
            "ref": "sha-feature",
            "sha": "blob-two",
            "size": 80,
            "branch": "feature/secrets",
            "branch_commit_sha": "sha-feature",
            "candidate_source": "branch_list",
            "candidate_query": "feature/secrets",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "path": "config/third.env",
            "ref": "sha-feature",
            "sha": "blob-three",
            "size": 80,
            "branch": "feature/secrets",
            "branch_commit_sha": "sha-feature",
            "candidate_source": "branch_list",
            "candidate_query": "feature/secrets",
            "status": "skipped",
            "error": "GitHub branch-list blob candidate beyond max_files_per_repo",
        },
    ]
    assert [artifact["asset"] for artifact in evidence["artifacts"]] == [
        "github:platform/api/config/first.env",
        "github:platform/api/config/second.env",
    ]

    assets = {row["asset"] for row in _scanned(res, limit=10)}
    assert assets == {
        "github:platform/api/config/first.env",
        "github:platform/api/config/second.env",
    }


def test_github_task_scan_branch_list_empty_blob_candidates_are_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBranch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    list_path_calls: list[tuple[str, str, tuple[str, ...]]] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("empty branch-list blob candidate scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_branches",
        lambda repo, limit=20: [
            GhBranch(repo=repo, name="feature/secrets", commit_sha="sha-feature"),
        ],
    )

    def list_paths_matching(repo: str, ref: str, *, hot_paths):
        list_path_calls.append((repo, ref, tuple(hot_paths)))
        return []

    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", list_paths_matching)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_branches": True,
            "branch_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["*.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-BRANCH-LIST-NO-BLOBS"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "only skipped targets" in payload["status_reason"]
    assert payload["api_search"]["branch_count"] == 1
    assert payload["api_search"]["branch_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 1,
        "selected": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 1,
        "no_candidates": 1,
    }]
    assert payload["api_search"]["detail_missing"] == 0
    assert payload["api_search"]["detail_source_counts"] == {"branch_list": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "branch_list": {"skipped": 1},
    }
    assert list_path_calls == [("platform/api", "feature/secrets", ("*.env",))]
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["branch_details"] == [{
        "repo": "platform/api",
        "target_repo": "platform/api",
        "name": "feature/secrets",
        "commit_sha": "sha-feature",
        "candidate_source": "branch_list",
        "candidate_query": "branches",
        "status": "skipped",
        "returned": 0,
        "selected": 0,
        "content_present": False,
        "error": "GitHub branch-list blob search returned no candidates",
    }]
    assert evidence["file_details"] == []


def test_github_task_scan_branch_list_empty_blob_is_error_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhBranch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("branch-list empty-detail test must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_branches",
        lambda repo, limit=20: [
            GhBranch(repo=repo, name="feature/secrets", commit_sha="sha-feature"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, *, hot_paths: [
            GhBlobRef(
                repo=repo,
                ref="sha-feature",
                path="config/prod.env",
                sha="blob-feature",
                size=80,
            ),
        ],
    )
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", lambda repo, sha: "   \n")

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_branches": True,
            "branch_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-BRANCH-LIST-EMPTY"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "branches=1" in payload["status_reason"]
    assert payload["api_search"]["branch_count"] == 1
    assert payload["api_search"]["branch_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 1,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_status_by_source"] == {
        "branch_list": {"empty": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "path": "config/prod.env",
        "ref": "sha-feature",
        "sha": "blob-feature",
        "size": 80,
        "branch": "feature/secrets",
        "branch_commit_sha": "sha-feature",
        "candidate_source": "branch_list",
        "candidate_query": "feature/secrets",
        "status": "empty",
        "content_present": False,
    }]


def test_github_task_scan_branch_list_blob_detail_failure_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhBranch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    class BranchBlobFetchFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("branch-list blob detail failure must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_branches",
        lambda repo, limit=20: [
            GhBranch(repo=repo, name="feature/secrets", commit_sha="sha-feature"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, *, hot_paths: [
            GhBlobRef(
                repo=repo,
                ref="sha-feature",
                path="config/prod.env",
                sha="blob-feature",
                size=80,
            ),
        ],
    )

    fetch_calls: list[tuple[str, str]] = []

    def fetch_blob_text(repo: str, sha: str) -> str:
        fetch_calls.append((repo, sha))
        raise BranchBlobFetchFailure("GitHub branch blob detail HTTP 503")

    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_branches": True,
            "branch_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-BRANCH-LIST-BLOB-DETAIL-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert fetch_calls == [("platform/api", "blob-feature")]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["branch_count"] == 1
    assert payload["api_search"]["branch_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 1,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_blob_text": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "branch_list": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        "feature/secrets": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "fetch_blob_text"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert evidence["branch_details"] == [{
        "repo": "platform/api",
        "target_repo": "platform/api",
        "name": "feature/secrets",
        "commit_sha": "sha-feature",
        "candidate_source": "branch_list",
        "candidate_query": "branches",
        "status": "listed",
        "returned": 1,
        "selected": 1,
    }]
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "path": "config/prod.env",
        "ref": "sha-feature",
        "sha": "blob-feature",
        "size": 80,
        "branch": "feature/secrets",
        "branch_commit_sha": "sha-feature",
        "candidate_source": "branch_list",
        "candidate_query": "feature/secrets",
        "status": "error",
        "status_code": 503,
        "error": "BranchBlobFetchFailure('GitHub branch blob detail HTTP 503')",
    }]
    assert evidence["artifacts"] == []


def test_github_task_scan_branch_list_blob_listing_failure_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBranch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    class BranchBlobListFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("branch-list blob listing failure must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_branches",
        lambda repo, limit=20: [
            GhBranch(repo=repo, name="feature/secrets", commit_sha="sha-feature"),
        ],
    )

    calls: list[tuple[str, str, tuple[str, ...]]] = []

    def fail_branch_blob_listing(repo: str, ref: str, *, hot_paths):
        calls.append((repo, ref, tuple(hot_paths)))
        raise BranchBlobListFailure("GitHub branch blob listing HTTP 503")

    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", fail_branch_blob_listing)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_branches": True,
            "branch_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-BRANCH-LIST-BLOB-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("platform/api", "feature/secrets", ("prod.env",))]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["branch_count"] == 1
    assert payload["api_search"]["branch_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 1,
        "selected": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "branch_list_paths_matching": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "branch_list": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        "feature/secrets": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "branch_list_paths_matching"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["branch_list_attempts"] == payload["api_search"]["branch_list_attempts"]
    assert evidence["branch_details"] == [{
        "repo": "platform/api",
        "target_repo": "platform/api",
        "name": "feature/secrets",
        "commit_sha": "sha-feature",
        "candidate_source": "branch_list",
        "candidate_query": "branches",
        "status": "error",
        "status_code": 503,
        "error": "BranchBlobListFailure('GitHub branch blob listing HTTP 503')",
    }]
    assert evidence["file_details"] == []


def test_github_task_scan_branch_list_api_failure_records_attempt(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    class ListBranchesFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("branch-list failure must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_branches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ListBranchesFailure("GitHub list branches HTTP 503"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_branches": True,
            "branch_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-BRANCH-LIST-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["branch_count"] == 0
    assert payload["api_search"]["branch_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 0,
        "selected": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
        "phase": "list_branches",
        "error": "ListBranchesFailure('GitHub list branches HTTP 503')",
        "status_code": 503,
    }]
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {"list_branches": 1}
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "list_branches"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["branch_list_attempts"] == payload["api_search"]["branch_list_attempts"]
    assert evidence["branch_details"] == [{
        "repo": "platform/api",
        "candidate_source": "branch_list",
        "candidate_query": "branches",
        "status": "error",
        "status_code": 503,
        "error": "ListBranchesFailure('GitHub list branches HTTP 503')",
    }]


def test_github_task_scan_tag_list_uses_bounded_tag_blob_details(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhRepo, GhTag
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("T" * 36)
    list_path_calls: list[tuple[str, str, tuple[str, ...]]] = []
    blob_fetch_calls: list[str] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("tag-list scan must not run broad API search or commit fallback")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_tags",
        lambda repo, limit=20: [
            GhTag(repo=repo, name="v1.0.0", commit_sha="sha-v1"),
            GhTag(repo=repo, name="release/2026.07", commit_sha="sha-release"),
        ],
    )

    def list_commit_paths_matching(repo: str, commit_sha: str, *, hot_paths):
        list_path_calls.append((repo, commit_sha, tuple(hot_paths)))
        if commit_sha == "sha-release":
            return [
                GhBlobRef(
                    repo=repo,
                    ref="sha-release",
                    path="config/prod.env",
                    sha="blob-tag",
                    size=80,
                ),
                GhBlobRef(
                    repo=repo,
                    ref="sha-release",
                    path="config/overflow.env",
                    sha="blob-overflow",
                    size=90,
                ),
            ]
        return []

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append(sha)
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "list_commit_paths_matching", list_commit_paths_matching)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_tags": True,
            "tag_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 1,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-TAG-LIST"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["tag_count"] == 2
    assert payload["api_search"]["tag_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 2,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 2,
        "no_candidates": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"tag_list": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "tag_list": {"skipped": 2, "fetched": 1},
    }
    scan_summary = payload["api_search"]["scan_summary"]
    assert scan_summary["artifact_source_counts"] == {"tag_list": 1}
    assert scan_summary["reportable_source_counts"] == {"tag_list": 1}
    assert list_path_calls == [
        ("platform/api", "sha-v1", ("prod.env",)),
        ("platform/api", "sha-release", ("prod.env",)),
    ]
    assert blob_fetch_calls == ["blob-tag"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "platform/api",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "include_tags": True,
        "tag_limit": 3,
        "private": True,
        "archived": False,
        "pushed_at": "2026-05-24T00:00:00Z",
        "size_kb": 0,
    }]
    assert evidence["tag_details"] == [
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "name": "v1.0.0",
            "commit_sha": "sha-v1",
            "candidate_source": "tag_list",
            "candidate_query": "tags",
            "status": "skipped",
            "returned": 0,
            "selected": 0,
            "content_present": False,
            "error": "GitHub tag-list blob search returned no candidates",
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "name": "release/2026.07",
            "commit_sha": "sha-release",
            "candidate_source": "tag_list",
            "candidate_query": "tags",
            "status": "listed",
            "returned": 2,
            "selected": 1,
            "candidate_limit_hit": True,
            "limit_skipped": 1,
        },
    ]
    assert evidence["file_details"] == [
        {
            "repo": "platform/api",
            "path": "config/prod.env",
            "ref": "sha-release",
            "sha": "blob-tag",
            "size": 80,
            "tag": "release/2026.07",
            "tag_commit_sha": "sha-release",
            "candidate_source": "tag_list",
            "candidate_query": "release/2026.07",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "path": "config/overflow.env",
            "ref": "sha-release",
            "sha": "blob-overflow",
            "size": 90,
            "tag": "release/2026.07",
            "tag_commit_sha": "sha-release",
            "candidate_source": "tag_list",
            "candidate_query": "release/2026.07",
            "status": "skipped",
            "error": "GitHub tag-list blob candidate beyond max_files_per_repo",
        },
    ]
    assert evidence["artifacts"][0]["metadata"]["scan_method"] == "api_tag_hot_path_tree_scan"
    assert evidence["artifacts"][0]["metadata"]["candidate_source"] == "tag_list"
    assert evidence["artifacts"][0]["metadata"]["tag"] == "release/2026.07"


def test_github_task_scan_tag_list_skips_out_of_scope_blobs_before_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhRepo, GhTag
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("Z" * 36)
    blob_fetch_calls: list[tuple[str, str]] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("tag-list scope gate must not broaden to search or fallback")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_tags",
        lambda repo, limit=20: [
            GhTag(repo=repo, name="release/2026.07", commit_sha="sha-release"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_commit_paths_matching",
        lambda repo, commit_sha, *, hot_paths: [
            GhBlobRef(
                repo="other/repo",
                ref="sha-release",
                path="config/stolen.env",
                sha="blob-foreign",
                size=80,
            ),
            GhBlobRef(
                repo="",
                ref="sha-release",
                path="config/unscoped.env",
                sha="blob-unscoped",
                size=80,
            ),
            GhBlobRef(
                repo=repo,
                ref="sha-release",
                path="config/prod.env",
                sha="blob-live",
                size=80,
            ),
        ],
    )

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append((repo, sha))
        if repo != "platform/api" or sha != "blob-live":
            raise AssertionError("out-of-scope tag-list blob must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_tags": True,
            "tag_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["*.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-TAG-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["errors"] == []
    assert payload["api_search"]["out_of_scope_count"] == 2
    assert payload["api_search"]["tag_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 1,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 2,
        "duplicate": 0,
        "skipped": 2,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"tag_list": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "tag_list": {"skipped": 2, "fetched": 1},
    }
    assert payload["api_search"]["scan_summary"]["artifact_source_counts"] == {"tag_list": 1}
    assert blob_fetch_calls == [("platform/api", "blob-live")]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [
        {
            "repo": "other/repo",
            "target_repo": "platform/api",
            "path": "config/stolen.env",
            "ref": "sha-release",
            "sha": "blob-foreign",
            "tag": "release/2026.07",
            "candidate_source": "tag_list",
            "candidate_query": "release/2026.07",
            "status": "skipped",
            "error": "GitHub tag-list blob candidate out of requested repo scope",
        },
        {
            "repo": "",
            "target_repo": "platform/api",
            "path": "config/unscoped.env",
            "ref": "sha-release",
            "sha": "blob-unscoped",
            "tag": "release/2026.07",
            "candidate_source": "tag_list",
            "candidate_query": "release/2026.07",
            "status": "skipped",
            "error": "GitHub tag-list blob candidate out of requested repo scope",
        },
        {
            "repo": "platform/api",
            "path": "config/prod.env",
            "ref": "sha-release",
            "sha": "blob-live",
            "size": 80,
            "tag": "release/2026.07",
            "tag_commit_sha": "sha-release",
            "candidate_source": "tag_list",
            "candidate_query": "release/2026.07",
            "status": "fetched",
            "content_present": True,
        },
    ]
    assert evidence["artifacts"][0]["asset"] == "github:platform/api/config/prod.env"


def test_github_task_scan_tag_list_skips_out_of_scope_tag_before_listing(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhRepo, GhTag
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("out-of-scope tag candidate must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_tags",
        lambda repo, limit=20: [
            GhTag(repo="other/repo", name="release/2026.07", commit_sha="sha-release"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_commit_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope tag candidate must not list tag blobs"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_tags": True,
            "tag_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["*.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-TAG-CANDIDATE-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["errors"] == []
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["tag_count"] == 0
    assert payload["api_search"]["tag_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 1,
        "selected": 0,
        "invalid": 0,
        "out_of_scope": 1,
        "duplicate": 0,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"tag_list": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "tag_list": {"skipped": 1},
    }
    assert payload["api_search"]["fallback_hot_path_tree"] == 0

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["tag_details"] == [{
        "repo": "other/repo",
        "target_repo": "platform/api",
        "name": "release/2026.07",
        "commit_sha": "sha-release",
        "candidate_source": "tag_list",
        "candidate_query": "tags",
        "status": "skipped",
        "error": "GitHub tag candidate out of requested repo scope",
    }]
    assert evidence["file_details"] == []
    assert _scanned(res, limit=10) == []


def test_github_task_scan_tag_list_requires_repo_scope_before_listing(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhRepo, GhTag
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("unscoped tag candidate must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_tags",
        lambda repo, limit=20: [
            GhTag(repo="", name="release/2026.07", commit_sha="sha-release"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_commit_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("unscoped tag candidate must not list tag blobs"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_tags": True,
            "tag_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["*.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-TAG-REPO-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["errors"] == []
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["tag_count"] == 0
    assert payload["api_search"]["tag_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 1,
        "selected": 0,
        "invalid": 0,
        "out_of_scope": 1,
        "duplicate": 0,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"tag_list": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "tag_list": {"skipped": 1},
    }
    assert payload["api_search"]["fallback_hot_path_tree"] == 0

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["tag_details"] == [{
        "repo": "",
        "target_repo": "platform/api",
        "name": "release/2026.07",
        "commit_sha": "sha-release",
        "candidate_source": "tag_list",
        "candidate_query": "tags",
        "status": "skipped",
        "error": "GitHub tag candidate out of requested repo scope",
    }]
    assert evidence["file_details"] == []
    assert _scanned(res, limit=10) == []


def test_github_task_scan_tag_list_marks_limit_hit_for_overreturned_tags(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhRepo, GhTag
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("T" * 36)
    list_path_calls: list[tuple[str, str, tuple[str, ...]]] = []
    blob_fetch_calls: list[str] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("tag-list over-return must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_tags",
        lambda repo, limit=20: [
            GhTag(repo=repo, name="release/2026.07", commit_sha="sha-release"),
            GhTag(repo=repo, name="release/overflow", commit_sha="sha-overflow"),
        ],
    )

    def list_commit_paths_matching(repo: str, commit_sha: str, *, hot_paths):
        list_path_calls.append((repo, commit_sha, tuple(hot_paths)))
        if commit_sha == "sha-release":
            return [
                GhBlobRef(
                    repo=repo,
                    ref="sha-release",
                    path="config/prod.env",
                    sha="blob-tag",
                    size=80,
                ),
            ]
        raise AssertionError("tag beyond tag_limit must not list blobs")

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append(sha)
        if sha != "blob-tag":
            raise AssertionError("tag beyond tag_limit must not fetch blobs")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "list_commit_paths_matching", list_commit_paths_matching)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_tags": True,
            "tag_limit": 1,
            "code_search_terms": ["password"],
            "hot_paths": ["*.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-TAG-LIST-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["tag_count"] == 1
    assert payload["api_search"]["tag_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 1,
        "returned": 2,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"tag_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "tag_list": {"skipped": 1, "fetched": 1},
    }
    assert list_path_calls == [("platform/api", "sha-release", ("*.env",))]
    assert blob_fetch_calls == ["blob-tag"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["api_search"]["tag_list_attempts"] == (
        payload["api_search"]["tag_list_attempts"]
    )
    assert evidence["tag_details"] == [
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "name": "release/2026.07",
            "commit_sha": "sha-release",
            "candidate_source": "tag_list",
            "candidate_query": "tags",
            "status": "listed",
            "returned": 1,
            "selected": 1,
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "name": "release/overflow",
            "commit_sha": "sha-overflow",
            "candidate_source": "tag_list",
            "candidate_query": "tags",
            "status": "skipped",
            "error": "GitHub tag-list candidate beyond tag_limit",
        },
    ]
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "path": "config/prod.env",
        "ref": "sha-release",
        "sha": "blob-tag",
        "size": 80,
        "tag": "release/2026.07",
        "tag_commit_sha": "sha-release",
        "candidate_source": "tag_list",
        "candidate_query": "release/2026.07",
        "status": "fetched",
        "content_present": True,
    }]
    assert [row["asset"] for row in _scanned(res, limit=10)] == [
        "github:platform/api/config/prod.env",
    ]


def test_github_task_scan_tag_list_marks_limit_hit_and_skips_excess_blobs(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhRepo, GhTag
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    token_one = "ghp_" + ("W" * 36)
    token_two = "ghp_" + ("X" * 36)
    list_path_calls: list[tuple[str, str, tuple[str, ...]]] = []
    blob_fetch_calls: list[str] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("tag-list limit hit must not broaden to search or commit fallback")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_tags",
        lambda repo, limit=20: [
            GhTag(repo=repo, name="release/2026.07", commit_sha="sha-release"),
        ],
    )

    def list_commit_paths_matching(repo: str, commit_sha: str, *, hot_paths):
        list_path_calls.append((repo, commit_sha, tuple(hot_paths)))
        return [
            GhBlobRef(
                repo=repo,
                ref="sha-release",
                path="config/first.env",
                sha="blob-one",
                size=80,
            ),
            GhBlobRef(
                repo=repo,
                ref="sha-release",
                path="config/second.env",
                sha="blob-two",
                size=80,
            ),
            GhBlobRef(
                repo=repo,
                ref="sha-release",
                path="config/third.env",
                sha="blob-three",
                size=80,
            ),
        ]

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append(sha)
        if sha == "blob-one":
            return f"GITHUB_TOKEN={token_one}\n"
        if sha == "blob-two":
            return f"GITHUB_TOKEN={token_two}\n"
        raise AssertionError("tag-list blobs beyond max_files_per_repo must not be fetched")

    monkeypatch.setattr(service_task_tools.gh, "list_commit_paths_matching", list_commit_paths_matching)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_tags": True,
            "tag_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["*.env"],
            "max_files_per_repo": 2,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-TAG-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] >= 1
    assert payload["artifacts_scanned"] == 2
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["tag_count"] == 1
    assert payload["api_search"]["tag_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 1,
        "selected": 2,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"tag_list": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "tag_list": {"fetched": 2, "skipped": 1},
    }
    assert list_path_calls == [("platform/api", "sha-release", ("*.env",))]
    assert blob_fetch_calls == ["blob-one", "blob-two"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["api_search"]["tag_list_attempts"] == payload["api_search"]["tag_list_attempts"]
    assert evidence["tag_details"] == [{
        "repo": "platform/api",
        "target_repo": "platform/api",
        "name": "release/2026.07",
        "commit_sha": "sha-release",
        "candidate_source": "tag_list",
        "candidate_query": "tags",
        "status": "listed",
        "returned": 3,
        "selected": 2,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert evidence["file_details"] == [
        {
            "repo": "platform/api",
            "path": "config/first.env",
            "ref": "sha-release",
            "sha": "blob-one",
            "size": 80,
            "tag": "release/2026.07",
            "tag_commit_sha": "sha-release",
            "candidate_source": "tag_list",
            "candidate_query": "release/2026.07",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "path": "config/second.env",
            "ref": "sha-release",
            "sha": "blob-two",
            "size": 80,
            "tag": "release/2026.07",
            "tag_commit_sha": "sha-release",
            "candidate_source": "tag_list",
            "candidate_query": "release/2026.07",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "path": "config/third.env",
            "ref": "sha-release",
            "sha": "blob-three",
            "size": 80,
            "tag": "release/2026.07",
            "tag_commit_sha": "sha-release",
            "candidate_source": "tag_list",
            "candidate_query": "release/2026.07",
            "status": "skipped",
            "error": "GitHub tag-list blob candidate beyond max_files_per_repo",
        },
    ]
    artifact_assets = {artifact["asset"] for artifact in evidence["artifacts"]}
    assert artifact_assets
    assert artifact_assets <= {
        "github:platform/api/config/first.env",
        "github:platform/api/config/second.env",
    }

    assets = {row["asset"] for row in _scanned(res, limit=10)}
    assert assets
    assert assets <= {
        "github:platform/api/config/first.env",
        "github:platform/api/config/second.env",
    }


def test_github_task_scan_tag_list_empty_blob_candidates_are_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhRepo, GhTag
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    list_path_calls: list[tuple[str, str, tuple[str, ...]]] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("empty tag-list blob candidate scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_tags",
        lambda repo, limit=20: [
            GhTag(repo=repo, name="release/2026.07", commit_sha="sha-release"),
        ],
    )

    def list_commit_paths_matching(repo: str, commit_sha: str, *, hot_paths):
        list_path_calls.append((repo, commit_sha, tuple(hot_paths)))
        return []

    monkeypatch.setattr(
        service_task_tools.gh,
        "list_commit_paths_matching",
        list_commit_paths_matching,
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_tags": True,
            "tag_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["*.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-TAG-LIST-NO-BLOBS"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "only skipped targets" in payload["status_reason"]
    assert payload["api_search"]["tag_count"] == 1
    assert payload["api_search"]["tag_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 1,
        "selected": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 1,
        "no_candidates": 1,
    }]
    assert payload["api_search"]["detail_missing"] == 0
    assert payload["api_search"]["detail_source_counts"] == {"tag_list": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "tag_list": {"skipped": 1},
    }
    assert list_path_calls == [("platform/api", "sha-release", ("*.env",))]
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["tag_details"] == [{
        "repo": "platform/api",
        "target_repo": "platform/api",
        "name": "release/2026.07",
        "commit_sha": "sha-release",
        "candidate_source": "tag_list",
        "candidate_query": "tags",
        "status": "skipped",
        "returned": 0,
        "selected": 0,
        "content_present": False,
        "error": "GitHub tag-list blob search returned no candidates",
    }]
    assert evidence["file_details"] == []


def test_github_task_scan_tag_list_empty_blob_is_error_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhRepo, GhTag
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("tag-list empty-detail test must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_tags",
        lambda repo, limit=20: [
            GhTag(repo=repo, name="release/2026.07", commit_sha="sha-release"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_commit_paths_matching",
        lambda repo, commit_sha, *, hot_paths: [
            GhBlobRef(
                repo=repo,
                ref="sha-release",
                path="config/prod.env",
                sha="blob-tag",
                size=80,
            ),
        ],
    )
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", lambda repo, sha: "")

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_tags": True,
            "tag_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-TAG-LIST-EMPTY"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "tags=1" in payload["status_reason"]
    assert payload["api_search"]["tag_count"] == 1
    assert payload["api_search"]["tag_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 1,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_status_by_source"] == {
        "tag_list": {"empty": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "path": "config/prod.env",
        "ref": "sha-release",
        "sha": "blob-tag",
        "size": 80,
        "tag": "release/2026.07",
        "tag_commit_sha": "sha-release",
        "candidate_source": "tag_list",
        "candidate_query": "release/2026.07",
        "status": "empty",
        "content_present": False,
    }]


def test_github_task_scan_tag_list_blob_detail_failure_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhRepo, GhTag
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    class TagBlobFetchFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("tag-list blob detail failure must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_tags",
        lambda repo, limit=20: [
            GhTag(repo=repo, name="release/2026.07", commit_sha="sha-release"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_commit_paths_matching",
        lambda repo, commit_sha, *, hot_paths: [
            GhBlobRef(
                repo=repo,
                ref="sha-release",
                path="config/prod.env",
                sha="blob-tag",
                size=80,
            ),
        ],
    )

    fetch_calls: list[tuple[str, str]] = []

    def fetch_blob_text(repo: str, sha: str) -> str:
        fetch_calls.append((repo, sha))
        raise TagBlobFetchFailure("GitHub tag blob detail HTTP 503")

    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_tags": True,
            "tag_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-TAG-LIST-BLOB-DETAIL-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert fetch_calls == [("platform/api", "blob-tag")]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["tag_count"] == 1
    assert payload["api_search"]["tag_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 1,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_blob_text": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "tag_list": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        "release/2026.07": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "fetch_blob_text"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert evidence["tag_details"] == [{
        "repo": "platform/api",
        "target_repo": "platform/api",
        "name": "release/2026.07",
        "commit_sha": "sha-release",
        "candidate_source": "tag_list",
        "candidate_query": "tags",
        "status": "listed",
        "returned": 1,
        "selected": 1,
    }]
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "path": "config/prod.env",
        "ref": "sha-release",
        "sha": "blob-tag",
        "size": 80,
        "tag": "release/2026.07",
        "tag_commit_sha": "sha-release",
        "candidate_source": "tag_list",
        "candidate_query": "release/2026.07",
        "status": "error",
        "status_code": 503,
        "error": "TagBlobFetchFailure('GitHub tag blob detail HTTP 503')",
    }]
    assert evidence["artifacts"] == []


def test_github_task_scan_tag_list_blob_listing_failure_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhRepo, GhTag
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    class TagBlobListFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("tag-list blob listing failure must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_tags",
        lambda repo, limit=20: [
            GhTag(repo=repo, name="release/2026.07", commit_sha="sha-release"),
        ],
    )

    calls: list[tuple[str, str, tuple[str, ...]]] = []

    def fail_tag_blob_listing(repo: str, commit_sha: str, *, hot_paths):
        calls.append((repo, commit_sha, tuple(hot_paths)))
        raise TagBlobListFailure("GitHub tag blob listing HTTP 503")

    monkeypatch.setattr(service_task_tools.gh, "list_commit_paths_matching", fail_tag_blob_listing)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_tags": True,
            "tag_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-TAG-LIST-BLOB-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("platform/api", "sha-release", ("prod.env",))]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["tag_count"] == 1
    assert payload["api_search"]["tag_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 1,
        "selected": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "tag_list_commit_paths_matching": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "tag_list": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        "release/2026.07": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "tag_list_commit_paths_matching"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["tag_list_attempts"] == payload["api_search"]["tag_list_attempts"]
    assert evidence["tag_details"] == [{
        "repo": "platform/api",
        "target_repo": "platform/api",
        "name": "release/2026.07",
        "commit_sha": "sha-release",
        "candidate_source": "tag_list",
        "candidate_query": "tags",
        "status": "error",
        "status_code": 503,
        "error": "TagBlobListFailure('GitHub tag blob listing HTTP 503')",
    }]
    assert evidence["file_details"] == []


def test_github_task_scan_tag_list_api_failure_records_attempt(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    class ListTagsFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("tag-list failure must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_commit_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_tags",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ListTagsFailure("GitHub list tags HTTP 503"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_tags": True,
            "tag_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-TAG-LIST-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["tag_count"] == 0
    assert payload["api_search"]["tag_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 0,
        "selected": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
        "phase": "list_tags",
        "error": "ListTagsFailure('GitHub list tags HTTP 503')",
        "status_code": 503,
    }]
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {"list_tags": 1}
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "list_tags"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["tag_list_attempts"] == payload["api_search"]["tag_list_attempts"]
    assert evidence["tag_details"] == [{
        "repo": "platform/api",
        "candidate_source": "tag_list",
        "candidate_query": "tags",
        "status": "error",
        "status_code": 503,
        "error": "ListTagsFailure('GitHub list tags HTTP 503')",
    }]


def test_github_task_scan_commit_list_uses_bounded_commit_patch_details(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from service import state_domain
    from domains.services.github.plugin.agent_types.github import GhCommitPatch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("C" * 36)
    commit_calls: list[tuple[str, int, str | None]] = []

    state_domain.github_repo_set_scanned_sha("platform/api", "old-head")
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("commit-list scan must not run broad search, tree fallback, or exact file fetch")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_commit_patch", forbidden_call)

    def recent_commit_patches(repo: str, *, limit: int = 3, since_sha=None):
        commit_calls.append((repo, limit, since_sha))
        return [
            GhCommitPatch(
                repo=repo,
                sha="sha-new",
                author="octocat",
                author_email="octocat@samsung.com",
                message="add leaked token",
                files=[{"filename": "config/prod.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
            ),
            GhCommitPatch(
                repo=repo,
                sha="sha-doc",
                author="octocat",
                author_email="octocat@samsung.com",
                message="docs only",
                files=[],
            ),
        ]

    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", recent_commit_patches)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_commit_list": True,
            "include_commits": False,
            "commit_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-COMMIT-LIST"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["commit_count"] == 2
    assert payload["api_search"]["commit_list_count"] == 2
    assert payload["api_search"]["commit_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 2,
        "selected": 2,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"commit_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "commit_list": {"fetched": 1, "missing": 1},
    }
    scan_summary = payload["api_search"]["scan_summary"]
    assert scan_summary["artifact_source_counts"] == {"commit_list": 1}
    assert scan_summary["reportable_source_counts"] == {"commit_list": 1}
    assert commit_calls == [("platform/api", 2, None)]
    assert state_domain.github_repo_get_scanned_sha("platform/api") == "old-head"

    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/commit/sha-new"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "platform/api",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "include_commit_list": True,
        "commit_limit": 2,
        "private": True,
        "archived": False,
        "pushed_at": "2026-05-24T00:00:00Z",
        "size_kb": 0,
    }]
    assert evidence["commit_details"] == [
        {
            "repo": "platform/api",
            "sha": "sha-new",
            "candidate_source": "commit_list",
            "files": ["config/prod.env"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "sha": "sha-doc",
            "candidate_source": "commit_list",
            "files": [],
            "file_count": 0,
            "scannable_file_count": 0,
            "status": "missing",
            "content_present": False,
            "error": "GitHub commit patch returned no files",
        },
    ]
    assert evidence["artifacts"][0]["metadata"]["scan_method"] == "api_recent_commit_patch_scan"
    assert evidence["artifacts"][0]["metadata"]["candidate_source"] == "commit_list"

    # ★ 담당자 채널. 이 경로가 author_email 을 빠뜨려 라이브 신경로 finding 2,177건의
    #   author_email 이 0건이 됐었다(구 경로는 17,544건 중 9,237건 보유). 리포터의 담당자
    #   키 목록이 이 키를 보므로, 빠지면 스레드가 담당자 없이 만들어지고 통보가 막힌다.
    meta = evidence["artifacts"][0]["metadata"]
    assert meta["author_email"] == "octocat@samsung.com"
    # author 는 GitHub 로그인명이라 담당자 대체재가 아니다 — 둘은 다른 축이다.
    assert meta["author"] == "octocat"
    # suppress_emails 는 담당자가 아니라 **탐지 억제** 목록이다. 값이 같아도 뜻이 다르므로
    # 둘 다 있어야 한다(하나로 합치면 억제를 끄면 담당자가 사라진다).
    assert meta["suppress_emails"] == ["octocat@samsung.com"]


def test_github_task_scan_commit_list_marks_limit_hit_for_overreturned_commits(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    kept_token = "ghp_" + ("L" * 36)
    overflow_token = "ghp_" + ("M" * 36)
    commit_calls: list[tuple[str, int, str | None]] = []
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("commit-list over-return must not broaden or fetch overflow")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_commit_patch", forbidden_call)

    def recent_commit_patches(repo: str, *, limit: int = 3, since_sha=None):
        commit_calls.append((repo, limit, since_sha))
        return [
            GhCommitPatch(
                repo=repo,
                sha="sha-kept",
                author="octocat",
                author_email="octocat@samsung.com",
                message="kept secret",
                files=[{"filename": "config/kept.env", "patch": f"+GITHUB_TOKEN={kept_token}\n"}],
            ),
            GhCommitPatch(
                repo=repo,
                sha="sha-overflow",
                author="hubot",
                author_email="hubot@samsung.com",
                message="overflow secret",
                files=[{"filename": "config/overflow.env", "patch": f"+GITHUB_TOKEN={overflow_token}\n"}],
            ),
        ]

    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", recent_commit_patches)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_commit_list": True,
            "include_commits": False,
            "commit_limit": 1,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-COMMIT-LIST-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["commit_count"] == 1
    assert payload["api_search"]["commit_list_count"] == 1
    assert payload["api_search"]["commit_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 1,
        "returned": 2,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"commit_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "commit_list": {"fetched": 1, "skipped": 1},
    }
    assert commit_calls == [("platform/api", 1, None)]

    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/commit/sha-kept"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["api_search"]["commit_list_attempts"] == payload["api_search"]["commit_list_attempts"]
    assert evidence["commit_details"] == [
        {
            "repo": "platform/api",
            "sha": "sha-kept",
            "candidate_source": "commit_list",
            "files": ["config/kept.env"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "sha": "sha-overflow",
            "candidate_source": "commit_list",
            "candidate_query": "commits",
            "status": "skipped",
            "error": "GitHub commit-list candidate beyond commit_limit",
        },
    ]
    assert [artifact["asset"] for artifact in evidence["artifacts"]] == [
        "github:platform/api/commit/sha-kept",
    ]


def test_github_task_scan_commit_list_skips_out_of_scope_before_scan(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("C" * 36)
    commit_calls: list[tuple[str, int, str | None]] = []
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("commit-list scope filtering must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_commit_patch", forbidden_call)

    def recent_commit_patches(repo: str, *, limit: int = 3, since_sha=None):
        commit_calls.append((repo, limit, since_sha))
        return [
            GhCommitPatch(
                repo="other/repo",
                sha="sha-other",
                author="octocat",
                author_email="octocat@samsung.com",
                message="wrong repo secret",
                files=[{"filename": "config/prod.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
            ),
            GhCommitPatch(
                repo="",
                sha="sha-missing-repo",
                author="octocat",
                author_email="octocat@samsung.com",
                message="missing repo secret",
                files=[{"filename": "config/prod.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
            ),
            GhCommitPatch(
                repo=repo,
                sha="sha-live",
                author="hubot",
                author_email="hubot@samsung.com",
                message="live secret",
                files=[{"filename": "config/prod.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
            ),
        ]

    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", recent_commit_patches)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_commit_list": True,
            "include_commits": False,
            "commit_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-COMMIT-LIST-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["commit_count"] == 1
    assert payload["api_search"]["commit_list_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 2
    assert payload["api_search"]["commit_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 3,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 2,
        "duplicate": 0,
        "skipped": 2,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"commit_list": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "commit_list": {"skipped": 2, "fetched": 1},
    }
    assert commit_calls == [("platform/api", 3, None)]
    assert payload["errors"] == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert [
        {
            "repo": row["repo"],
            "target_repo": row.get("target_repo"),
            "sha": row["sha"],
            "status": row["status"],
        }
        for row in evidence["commit_details"]
    ] == [
        {
            "repo": "other/repo",
            "target_repo": "platform/api",
            "sha": "sha-other",
            "status": "skipped",
        },
        {
            "repo": "",
            "target_repo": "platform/api",
            "sha": "sha-missing-repo",
            "status": "skipped",
        },
        {
            "repo": "platform/api",
            "target_repo": None,
            "sha": "sha-live",
            "status": "fetched",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/commit/sha-live"


def test_github_task_scan_commit_list_dedupes_duplicate_commits(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token_one = "ghp_" + ("D" * 36)
    token_two = "ghp_" + ("E" * 36)
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("commit-list duplicate handling must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_commit_patch", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda repo, *, limit=3, since_sha=None: [
            GhCommitPatch(
                repo=repo,
                sha="sha-dup",
                author="octocat",
                author_email="octocat@samsung.com",
                message="first duplicate",
                files=[{"filename": "config/one.env", "patch": f"+GITHUB_TOKEN={token_one}\n"}],
            ),
            GhCommitPatch(
                repo=repo,
                sha="sha-dup",
                author="octocat",
                author_email="octocat@samsung.com",
                message="second duplicate should be skipped",
                files=[{"filename": "config/dup.env", "patch": f"+GITHUB_TOKEN={token_two}\n"}],
            ),
            GhCommitPatch(
                repo=repo,
                sha="sha-live",
                author="hubot",
                author_email="hubot@samsung.com",
                message="unique live token",
                files=[{"filename": "config/two.env", "patch": f"+GITHUB_TOKEN={token_two}\n"}],
            ),
        ],
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_commit_list": True,
            "include_commits": False,
            "commit_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-COMMIT-LIST-DEDUP"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 2
    assert payload["api_search"]["duplicate_count"] == 1
    assert payload["api_search"]["commit_count"] == 2
    assert payload["api_search"]["commit_list_count"] == 2
    assert payload["api_search"]["commit_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 3,
        "selected": 2,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 1,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"commit_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "commit_list": {"fetched": 2},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["commit_list_attempts"] == payload["api_search"]["commit_list_attempts"]
    assert evidence["commit_details"] == [
        {
            "repo": "platform/api",
            "sha": "sha-dup",
            "candidate_source": "commit_list",
            "files": ["config/one.env"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "sha": "sha-live",
            "candidate_source": "commit_list",
            "files": ["config/two.env"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
    ]
    assert [artifact["asset"] for artifact in evidence["artifacts"]] == [
        "github:platform/api/commit/sha-dup",
        "github:platform/api/commit/sha-live",
    ]
    assets = {row["asset"] for row in _scanned(res, limit=10)}
    assert assets == {
        "github:platform/api/commit/sha-dup",
        "github:platform/api/commit/sha-live",
    }


def test_github_task_scan_commit_list_empty_patch_is_error_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    commit_calls: list[tuple[str, int, str | None]] = []
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("commit-list scan must not broaden after empty patch details")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_commit_patch", forbidden_call)

    def recent_commit_patches(repo: str, *, limit: int = 3, since_sha=None):
        commit_calls.append((repo, limit, since_sha))
        return [
            GhCommitPatch(
                repo=repo,
                sha="sha-doc",
                author="hubot",
                author_email="hubot@samsung.com",
                message="docs only",
                files=[],
            ),
        ]

    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", recent_commit_patches)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_commit_list": True,
            "include_commits": False,
            "commit_limit": 1,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-COMMIT-LIST-EMPTY"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "commit_lists=1" in payload["status_reason"]
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["commit_count"] == 1
    assert payload["api_search"]["commit_list_count"] == 1
    assert payload["api_search"]["commit_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 1,
        "returned": 1,
        "selected": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"commit_list": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "commit_list": {"missing": 1},
    }
    assert commit_calls == [("platform/api", 1, None)]
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["artifacts"] == []
    assert evidence["commit_details"] == [{
        "repo": "platform/api",
        "sha": "sha-doc",
        "candidate_source": "commit_list",
        "files": [],
        "file_count": 0,
        "scannable_file_count": 0,
        "status": "missing",
        "content_present": False,
        "error": "GitHub commit patch returned no files",
    }]


@pytest.mark.parametrize(
    "case",
    [
        pytest.param(
            {
                "flag": "include_commit_list",
                "limit_field": "commit_limit",
                "list_func": "recent_commit_patches",
                "attempts_key": "commit_list_attempts",
                "details_key": "commit_details",
                "count_key": "commit_list_count",
                "source": "commit_list",
                "query": "commits",
                "error": "GitHub commit list returned no candidates",
                "expected_kwargs": {"limit": 3, "since_sha": None},
            },
            id="commit-list",
        ),
        pytest.param(
            {
                "flag": "include_pull_requests",
                "limit_field": "pull_request_limit",
                "list_func": "list_pull_requests",
                "attempts_key": "pull_request_list_attempts",
                "details_key": "pull_request_details",
                "count_key": "pull_request_count",
                "source": "pull_request_list",
                "query": "pulls",
                "error": "GitHub pull request list returned no candidates",
                "expected_kwargs": {"limit": 3},
            },
            id="pull-request-list",
        ),
        pytest.param(
            {
                "flag": "include_issues",
                "limit_field": "issue_limit",
                "list_func": "list_issues",
                "attempts_key": "issue_list_attempts",
                "details_key": "issue_details",
                "count_key": "issue_count",
                "source": "issue_list",
                "query": "issues",
                "error": "GitHub issue list returned no candidates",
                "expected_kwargs": {"limit": 3},
            },
            id="issue-list",
        ),
        pytest.param(
            {
                "flag": "include_releases",
                "limit_field": "release_limit",
                "list_func": "list_releases",
                "attempts_key": "release_list_attempts",
                "details_key": "release_details",
                "count_key": "release_count",
                "source": "release_list",
                "query": "releases",
                "error": "GitHub release list returned no candidates",
                "expected_kwargs": {"limit": 3},
            },
            id="release-list",
        ),
        pytest.param(
            {
                "flag": "include_branches",
                "limit_field": "branch_limit",
                "list_func": "list_branches",
                "attempts_key": "branch_list_attempts",
                "details_key": "branch_details",
                "count_key": "branch_count",
                "source": "branch_list",
                "query": "branches",
                "error": "GitHub branch list returned no candidates",
                "expected_kwargs": {"limit": 3},
            },
            id="branch-list",
        ),
        pytest.param(
            {
                "flag": "include_tags",
                "limit_field": "tag_limit",
                "list_func": "list_tags",
                "attempts_key": "tag_list_attempts",
                "details_key": "tag_details",
                "count_key": "tag_count",
                "source": "tag_list",
                "query": "tags",
                "error": "GitHub tag list returned no candidates",
                "expected_kwargs": {"limit": 3},
            },
            id="tag-list",
        ),
    ],
)
def test_github_task_scan_api_list_empty_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
    case,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    list_calls: list[tuple[tuple, dict]] = []

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("empty GitHub API list scan must not broaden")

    for name in (
        "code_search",
        "list_paths_matching",
        "fetch_file_at_ref",
        "fetch_commit_patch",
        "fetch_pull_request_files",
        "fetch_issue_detail",
        "fetch_release_by_tag",
        "list_commit_paths_matching",
        "fetch_blob_text",
        "recent_commit_patches",
        "list_pull_requests",
        "list_issues",
        "list_releases",
        "list_branches",
        "list_tags",
    ):
        monkeypatch.setattr(service_task_tools.gh, name, forbidden_call)

    def empty_list(*args, **kwargs):  # noqa: ANN002, ANN003
        list_calls.append((args, kwargs))
        return []

    monkeypatch.setattr(service_task_tools.gh, case["list_func"], empty_list)
    payload_input = {
        "repos": ["platform/api"],
        "include_commits": False,
        case["flag"]: True,
        case["limit_field"]: 3,
    }

    res = _run(
        GithubTaskScanTool(),
        payload_input,
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-LIST-EMPTY"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "github_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "only skipped targets" in payload["status_reason"]
    assert payload["errors"] == []
    assert list_calls == [(("platform/api",), case["expected_kwargs"])]
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["list_no_candidates"] == 1
    assert payload["api_search"][case["count_key"]] == 0
    assert payload["api_search"][case["attempts_key"]] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 0,
        "selected": 0,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 0,
        "no_candidates": 1,
    }]
    assert payload["api_search"]["detail_status_counts"] == {"skipped": 1}
    assert payload["api_search"]["detail_source_counts"] == {case["source"]: 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        case["source"]: {"skipped": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"][case["attempts_key"]] == (
        payload["api_search"][case["attempts_key"]]
    )
    assert evidence[case["details_key"]] == [{
        "repo": "platform/api",
        "candidate_source": case["source"],
        "candidate_query": case["query"],
        "status": "skipped",
        "content_present": False,
        "error": case["error"],
    }]


def test_github_task_scan_commit_list_api_failure_records_attempt(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    class ListCommitsFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("commit-list failure must not broaden to search or fallback")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ListCommitsFailure("GitHub list commits HTTP 503"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_commit_list": True,
            "include_commits": False,
            "commit_limit": 1,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-COMMIT-LIST-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["commit_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 1,
        "returned": 0,
        "selected": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
        "phase": "list_commits",
        "error": "ListCommitsFailure('GitHub list commits HTTP 503')",
        "status_code": 503,
    }]
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {"list_commits": 1}
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "list_commits"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["commit_list_attempts"] == payload["api_search"]["commit_list_attempts"]
    assert evidence["commit_details"] == [{
        "repo": "platform/api",
        "sha": "",
        "candidate_source": "commit_list",
        "candidate_query": "commits",
        "status": "error",
        "status_code": 503,
        "error": "ListCommitsFailure('GitHub list commits HTTP 503')",
    }]


def test_github_task_scan_compare_ref_fetches_exact_patch_only(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("C" * 36)
    compare_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact compare scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def fetch_compare_files(repo: str, compare_ref: str):
        compare_calls.append((repo, compare_ref))
        return GhCommitPatch(
            repo=repo,
            sha=f"compare-{compare_ref}",
            author=None,
            author_email=None,
            message=f"compare {compare_ref}",
            files=[
                {
                    "filename": "config/prod.env",
                    "patch": f"+GITHUB_TOKEN={token}\n",
                },
            ],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_compare_files", fetch_compare_files)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "compare_refs": ["main...feature-secrets"],
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-COMPARE-EXACT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert compare_calls == [("platform/api", "main...feature-secrets")]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["compare_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_missing"] == 0
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_status_by_kind"] == {
        "compare": {"fetched": 1},
    }
    assert payload["api_search"]["detail_source_counts"] == {"explicit_compare": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_compare": {"fetched": 1},
    }
    assert payload["api_search"]["detail_query_counts"] == {"(no query)": 1}
    assert payload["api_search"]["detail_status_by_query"] == {
        "(no query)": {"fetched": 1},
    }

    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/compare/main...feature-secrets"
    assert rows[0]["metadata"]["scan_method"] == "api_compare_files_scan"
    assert rows[0]["metadata"]["candidate_source"] == "explicit_compare"

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    assert "ghp_" in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["compare_details"] == [{
        "repo": "platform/api",
        "compare_ref": "main...feature-secrets",
        "candidate_source": "explicit_compare",
        "files": ["config/prod.env"],
        "file_count": 1,
        "scannable_file_count": 1,
        "status": "fetched",
        "content_present": True,
    }]
    assert evidence["artifacts"][0]["asset"] == (
        "github:platform/api/compare/main...feature-secrets"
    )
    assert evidence["artifacts"][0]["metadata"]["scan_method"] == (
        "api_compare_files_scan"
    )


def test_github_task_scan_compare_ref_empty_patch_is_error_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    compare_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("empty exact compare scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def fetch_compare_files(repo: str, compare_ref: str):
        compare_calls.append((repo, compare_ref))
        return GhCommitPatch(
            repo=repo,
            sha=f"compare-{compare_ref}",
            author=None,
            author_email=None,
            message=f"compare {compare_ref}",
            files=[],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_compare_files", fetch_compare_files)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "compare_refs": ["main...docs-only"],
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-COMPARE-EMPTY"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert compare_calls == [("platform/api", "main...docs-only")]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert payload["api_search"]["compare_count"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_compare": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_compare": {"missing": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["compare_details"] == [{
        "repo": "platform/api",
        "compare_ref": "main...docs-only",
        "candidate_source": "explicit_compare",
        "files": [],
        "file_count": 0,
        "scannable_file_count": 0,
        "status": "missing",
        "content_present": False,
        "error": "GitHub compare detail returned no files",
    }]
    assert evidence["artifacts"] == []


def test_github_task_scan_explicit_compare_dedupes_with_skipped_evidence(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("F" * 36)
    compare_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact compare scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def fetch_compare_files(repo: str, compare_ref: str):
        compare_calls.append((repo, compare_ref))
        if compare_ref != "main...feature-secrets":
            raise AssertionError("duplicate explicit compare candidate must not be fetched")
        return GhCommitPatch(
            repo=repo,
            sha=f"compare-{compare_ref}",
            author=None,
            author_email=None,
            message=f"compare {compare_ref}",
            files=[{
                "filename": "config/prod.env",
                "patch": f"+GITHUB_TOKEN={token}\n",
            }],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_compare_files", fetch_compare_files)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "compare_refs": ["main...feature-secrets", "main...feature-secrets"],
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-COMPARE-DEDUP"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["compare_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_compare": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_compare": {"fetched": 1, "skipped": 1},
    }
    assert compare_calls == [("platform/api", "main...feature-secrets")]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["compare_details"] == [
        {
            "repo": "platform/api",
            "compare_ref": "main...feature-secrets",
            "candidate_source": "explicit_compare",
            "files": ["config/prod.env"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "compare_ref": "main...feature-secrets",
            "candidate_source": "explicit_compare",
            "status": "skipped",
            "error": "duplicate compare candidate",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/compare/main...feature-secrets"


def test_github_task_scan_explicit_compare_requires_repo_scope(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("X" * 36)
    compare_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("unscoped compare detail must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def fetch_compare_files(repo: str, compare_ref: str):
        compare_calls.append((repo, compare_ref))
        return GhCommitPatch(
            repo="",
            sha=f"compare-{compare_ref}",
            author=None,
            author_email=None,
            message=f"compare {compare_ref}",
            files=[{
                "filename": "config/prod.env",
                "patch": f"+GITHUB_TOKEN={token}\n",
            }],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_compare_files", fetch_compare_files)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "compare_refs": ["main...feature-secrets"],
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-COMPARE-REPO-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert compare_calls == [("platform/api", "main...feature-secrets")]
    assert payload["finding_count"] == 0
    assert payload["errors"] == []
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["compare_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 0
    assert payload["api_search"]["detail_status_by_kind"] == {
        "compare": {"skipped": 1},
    }
    assert payload["api_search"]["detail_source_counts"] == {"explicit_compare": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_compare": {"skipped": 1},
    }

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["compare_details"] == [{
        "repo": "",
        "target_repo": "platform/api",
        "compare_ref": "main...feature-secrets",
        "candidate_source": "explicit_compare",
        "status": "skipped",
        "error": "GitHub compare candidate out of requested repo scope",
    }]
    assert evidence["artifacts"] == []
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_compares_audit_candidates_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhCommitPatch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    token = "ghp_" + ("M" * 36)
    compare_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded exact compare scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def fetch_compare_files(repo: str, compare_ref: str):
        compare_calls.append((repo, compare_ref))
        if compare_ref == "main...overflow":
            return GhCommitPatch(
                repo=repo,
                sha=f"compare-{compare_ref}",
                author=None,
                author_email=None,
                message=f"compare {compare_ref}",
                files=[{
                    "filename": "secret/overflow.env",
                    "patch": f"+GITHUB_TOKEN={token}\n",
                }],
            )
        return GhCommitPatch(
            repo=repo,
            sha=f"compare-{compare_ref}",
            author=None,
            author_email=None,
            message=f"compare {compare_ref}",
            files=[{
                "filename": f"docs/{compare_ref.split('...')[-1]}.md",
                "patch": "+clean docs\n",
            }],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_compare_files", fetch_compare_files)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "compare_refs": ["main...feature-a", "main...feature-b", "main...overflow"],
            "compare_limit": 2,
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-COMPARE-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert compare_calls == [
        ("platform/api", "main...feature-a"),
        ("platform/api", "main...feature-b"),
    ]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["compare_count"] == 2
    assert payload["api_search"]["detail_source_counts"] == {"explicit_compare": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_compare": {"fetched": 2, "skipped": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["compare_details"] == [
        {
            "repo": "platform/api",
            "compare_ref": "main...feature-a",
            "candidate_source": "explicit_compare",
            "files": ["docs/feature-a.md"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "compare_ref": "main...feature-b",
            "candidate_source": "explicit_compare",
            "files": ["docs/feature-b.md"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "compare_ref": "main...overflow",
            "candidate_source": "explicit_compare",
            "status": "skipped",
            "error": "GitHub explicit compare candidate beyond compare_limit",
        },
    ]


def test_github_task_scan_compare_ref_records_truncated_files(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("T" * 36)
    compare_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("truncated exact compare scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def fetch_compare_files(repo: str, compare_ref: str):
        compare_calls.append((repo, compare_ref))
        return GhCommitPatch(
            repo=repo,
            sha=f"compare-{compare_ref}",
            author=None,
            author_email=None,
            message=f"compare {compare_ref}",
            files=[{
                "filename": "config/kept.env",
                "patch": f"+GITHUB_TOKEN={token}\n",
            }],
            total_file_count=3,
            limit_skipped=2,
            skipped_files=["config/skipped-one.env", "config/skipped-two.env"],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_compare_files", fetch_compare_files)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "compare_refs": ["main...feature-secrets"],
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-COMPARE-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert compare_calls == [("platform/api", "main...feature-secrets")]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["compare_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_source_counts"] == {"explicit_compare": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_compare": {"fetched": 1, "skipped": 2},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["compare_details"] == [
        {
            "repo": "platform/api",
            "compare_ref": "main...feature-secrets",
            "candidate_source": "explicit_compare",
            "files": ["config/kept.env"],
            "file_count": 3,
            "scannable_file_count": 1,
            "status": "fetched",
            "candidate_limit_hit": True,
            "limit_skipped": 2,
            "skipped_files": ["config/skipped-one.env", "config/skipped-two.env"],
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "compare_ref": "main...feature-secrets",
            "candidate_source": "explicit_compare",
            "path": "config/skipped-one.env",
            "status": "skipped",
            "error": "GitHub compare file candidate beyond max_files",
        },
        {
            "repo": "platform/api",
            "compare_ref": "main...feature-secrets",
            "candidate_source": "explicit_compare",
            "path": "config/skipped-two.env",
            "status": "skipped",
            "error": "GitHub compare file candidate beyond max_files",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/compare/main...feature-secrets"


def test_github_task_scan_compare_ref_detail_failure_is_audited_without_broadening(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    class CompareFilesFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    compare_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("compare detail failure must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def fetch_compare_files(repo: str, compare_ref: str):
        compare_calls.append((repo, compare_ref))
        raise CompareFilesFailure("GitHub compare files HTTP 503")

    monkeypatch.setattr(service_task_tools.gh, "fetch_compare_files", fetch_compare_files)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "compare_refs": ["main...feature-secrets"],
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-COMPARE-DETAIL-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert compare_calls == [("platform/api", "main...feature-secrets")]
    assert payload["finding_count"] == 0
    assert payload["target_count"] == 1
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["compare_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_compare_files"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["detail_errors"][0]["candidate_source"] == "explicit_compare"
    assert payload["api_search"]["detail_errors"][0]["candidate_query"] == ""
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_compare_files": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_compare": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        "(no query)": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {
        "503": 1,
    }
    assert payload["errors"][0]["phase"] == "fetch_compare_files"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert evidence["compare_details"] == [{
        "repo": "platform/api",
        "compare_ref": "main...feature-secrets",
        "candidate_source": "explicit_compare",
        "status": "error",
        "status_code": 503,
        "error": "CompareFilesFailure('GitHub compare files HTTP 503')",
    }]
    assert evidence["artifacts"] == []


def test_github_task_scan_pull_request_detail_records_truncated_files(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("U" * 36)
    detail_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("truncated exact PR scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_pull_requests", forbidden_call)

    def fetch_pull_request_files(repo: str, number: int):
        detail_calls.append((repo, number))
        return GhCommitPatch(
            repo=repo,
            sha=f"pull-{number}",
            author=None,
            author_email=None,
            message=f"pull request #{number}",
            files=[{
                "filename": "config/kept.env",
                "patch": f"+GITHUB_TOKEN={token}\n",
            }],
            total_file_count=3,
            limit_skipped=2,
            skipped_files=["config/skipped-one.env", "config/skipped-two.env"],
        )

    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_pull_request_files",
        fetch_pull_request_files,
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "pull_numbers": [17],
            "include_pull_requests": False,
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-PR-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert detail_calls == [("platform/api", 17)]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["pull_request_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_source_counts"] == {"explicit_pull_request": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_pull_request": {"fetched": 1, "skipped": 2},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["pull_request_details"] == [
        {
            "repo": "platform/api",
            "pull_number": 17,
            "candidate_source": "explicit_pull_request",
            "files": ["config/kept.env"],
            "file_count": 3,
            "scannable_file_count": 1,
            "status": "fetched",
            "candidate_limit_hit": True,
            "limit_skipped": 2,
            "skipped_files": ["config/skipped-one.env", "config/skipped-two.env"],
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "pull_number": 17,
            "candidate_source": "explicit_pull_request",
            "path": "config/skipped-one.env",
            "status": "skipped",
            "error": "GitHub pull-request file candidate beyond max_files",
        },
        {
            "repo": "platform/api",
            "pull_number": 17,
            "candidate_source": "explicit_pull_request",
            "path": "config/skipped-two.env",
            "status": "skipped",
            "error": "GitHub pull-request file candidate beyond max_files",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/pull/17"


def test_github_task_scan_explicit_pull_request_dedupes_with_skipped_evidence(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("P" * 36)
    detail_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact PR scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_pull_requests", forbidden_call)

    def fetch_pull_request_files(repo: str, number: int):
        detail_calls.append((repo, number))
        if number != 17:
            raise AssertionError("duplicate explicit PR candidate must not be fetched")
        return GhCommitPatch(
            repo=repo,
            sha=f"pull-{number}",
            author=None,
            author_email=None,
            message=f"pull request #{number}",
            files=[{
                "filename": "config/prod.env",
                "patch": f"+GITHUB_TOKEN={token}\n",
            }],
        )

    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_pull_request_files",
        fetch_pull_request_files,
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "pull_numbers": [17, 17],
            "include_pull_requests": False,
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-PR-DEDUP"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["pull_request_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_pull_request": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_pull_request": {"fetched": 1, "skipped": 1},
    }
    assert detail_calls == [("platform/api", 17)]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["pull_request_details"] == [
        {
            "repo": "platform/api",
            "pull_number": 17,
            "candidate_source": "explicit_pull_request",
            "files": ["config/prod.env"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "pull_number": 17,
            "candidate_source": "explicit_pull_request",
            "status": "skipped",
            "error": "duplicate pull request candidate",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/pull/17"


def test_github_task_scan_explicit_pull_request_requires_repo_scope(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("S" * 36)
    detail_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact PR scope test must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_pull_requests", forbidden_call)

    def fetch_pull_request_files(repo: str, number: int):
        detail_calls.append((repo, number))
        return GhCommitPatch(
            repo="",
            sha=f"pull-{number}",
            author=None,
            author_email=None,
            message=f"pull request #{number}",
            files=[{
                "filename": "config/prod.env",
                "patch": f"+GITHUB_TOKEN={token}\n",
            }],
        )

    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_pull_request_files",
        fetch_pull_request_files,
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "pull_numbers": [17],
            "include_pull_requests": False,
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-PR-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert detail_calls == [("platform/api", 17)]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_pull_request": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_pull_request": {"skipped": 1},
    }

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["pull_request_details"] == [{
        "repo": "",
        "target_repo": "platform/api",
        "pull_number": 17,
        "candidate_source": "explicit_pull_request",
        "status": "skipped",
        "error": "GitHub pull request candidate out of requested repo scope",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_pull_requests_audit_candidates_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhCommitPatch, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    token = "ghp_" + ("R" * 36)
    detail_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded exact PR scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_pull_requests", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def fetch_pull_request_files(repo: str, number: int):
        detail_calls.append((repo, number))
        if number == 19:
            return GhCommitPatch(
                repo=repo,
                sha=f"pull-{number}",
                author=None,
                author_email=None,
                message=f"pull request #{number}",
                files=[{
                    "filename": "secret/overflow.env",
                    "patch": f"+GITHUB_TOKEN={token}\n",
                }],
            )
        return GhCommitPatch(
            repo=repo,
            sha=f"pull-{number}",
            author=None,
            author_email=None,
            message=f"pull request #{number}",
            files=[{
                "filename": f"docs/pr-{number}.md",
                "patch": "+clean docs\n",
            }],
        )

    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_pull_request_files",
        fetch_pull_request_files,
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "pull_numbers": [17, 18, 19],
            "pull_request_limit": 2,
            "include_pull_requests": False,
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-PR-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert detail_calls == [("platform/api", 17), ("platform/api", 18)]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["pull_request_count"] == 2
    assert payload["api_search"]["detail_source_counts"] == {"explicit_pull_request": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_pull_request": {"fetched": 2, "skipped": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["pull_request_details"] == [
        {
            "repo": "platform/api",
            "pull_number": 17,
            "candidate_source": "explicit_pull_request",
            "files": ["docs/pr-17.md"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "pull_number": 18,
            "candidate_source": "explicit_pull_request",
            "files": ["docs/pr-18.md"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "pull_number": 19,
            "candidate_source": "explicit_pull_request",
            "status": "skipped",
            "error": "GitHub explicit pull request candidate beyond pull_request_limit",
        },
    ]


def test_github_task_scan_pull_request_list_uses_bounded_pr_file_details(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch, GhPullRequest, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("P" * 36)
    list_calls: list[tuple[str, int]] = []
    detail_calls: list[tuple[str, int]] = []
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("PR-list scan must not run broad search, tree fallback, or recent commits")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def list_pull_requests(repo: str, *, limit: int = 20):
        list_calls.append((repo, limit))
        return [
            GhPullRequest(
                repo=repo,
                number=17,
                title="deploy secret cleanup",
                state="open",
                author="octocat",
                head_sha="sha-pr",
                base_ref="main",
            ),
            GhPullRequest(
                repo=repo,
                number=18,
                title="docs only",
                state="open",
                author="hubot",
                head_sha="sha-doc",
                base_ref="main",
            ),
        ]

    def fetch_pull_request_files(repo: str, number: int):
        detail_calls.append((repo, number))
        if number == 17:
            return GhCommitPatch(
                repo=repo,
                sha="pull-17",
                author=None,
                author_email=None,
                message="pull request #17",
                files=[{"filename": "config/prod.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
            )
        return GhCommitPatch(
            repo=repo,
            sha=f"pull-{number}",
            author=None,
            author_email=None,
            message=f"pull request #{number}",
            files=[],
        )

    monkeypatch.setattr(service_task_tools.gh, "list_pull_requests", list_pull_requests)
    monkeypatch.setattr(service_task_tools.gh, "fetch_pull_request_files", fetch_pull_request_files)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_pull_requests": True,
            "include_commits": False,
            "pull_request_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-PR-LIST"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["pull_request_count"] == 2
    assert payload["api_search"]["pull_request_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 2,
        "selected": 2,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"pull_request_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "pull_request_list": {"fetched": 1, "missing": 1},
    }
    scan_summary = payload["api_search"]["scan_summary"]
    assert scan_summary["artifact_source_counts"] == {"pull_request_list": 1}
    assert scan_summary["reportable_source_counts"] == {"pull_request_list": 1}
    assert list_calls == [("platform/api", 2)]
    assert detail_calls == [("platform/api", 17), ("platform/api", 18)]

    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/pull/17"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "platform/api",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "include_pull_requests": True,
        "pull_request_limit": 2,
        "private": True,
        "archived": False,
        "pushed_at": "2026-05-24T00:00:00Z",
        "size_kb": 0,
    }]
    assert evidence["pull_request_details"] == [
        {
            "repo": "platform/api",
            "pull_number": 17,
            "candidate_source": "pull_request_list",
            "candidate_query": "pulls",
            "title": "deploy secret cleanup",
            "state": "open",
            "author": "octocat",
            "head_sha": "sha-pr",
            "base_ref": "main",
            "files": ["config/prod.env"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "pull_number": 18,
            "candidate_source": "pull_request_list",
            "candidate_query": "pulls",
            "title": "docs only",
            "state": "open",
            "author": "hubot",
            "head_sha": "sha-doc",
            "base_ref": "main",
            "files": [],
            "file_count": 0,
            "scannable_file_count": 0,
            "status": "missing",
            "content_present": False,
            "error": "GitHub pull request detail returned no files",
        },
    ]
    assert evidence["artifacts"][0]["metadata"]["scan_method"] == "api_pull_request_files_scan"
    assert evidence["artifacts"][0]["metadata"]["candidate_source"] == "pull_request_list"
    assert evidence["artifacts"][0]["metadata"]["candidate_query"] == "pulls"


def test_github_task_scan_pull_request_list_marks_limit_hit_for_overreturned_prs(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch, GhPullRequest, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    kept_token = "ghp_" + ("R" * 36)
    overflow_token = "ghp_" + ("S" * 36)
    list_calls: list[tuple[str, int]] = []
    detail_calls: list[tuple[str, int]] = []
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("PR-list over-return must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def list_pull_requests(repo: str, *, limit: int = 20):
        list_calls.append((repo, limit))
        return [
            GhPullRequest(
                repo=repo,
                number=17,
                title="kept secret",
                state="open",
                author="octocat",
                head_sha="sha-kept",
                base_ref="main",
            ),
            GhPullRequest(
                repo=repo,
                number=18,
                title=f"overflow secret GITHUB_TOKEN={overflow_token}",
                state="open",
                author="hubot",
                head_sha="sha-overflow",
                base_ref="main",
            ),
        ]

    def fetch_pull_request_files(repo: str, number: int):
        detail_calls.append((repo, number))
        if number != 17:
            raise AssertionError("PR beyond pull_request_limit must not fetch files")
        return GhCommitPatch(
            repo=repo,
            sha="pull-17",
            author=None,
            author_email=None,
            message="pull request #17",
            files=[{"filename": "config/kept.env", "patch": f"+GITHUB_TOKEN={kept_token}\n"}],
        )

    monkeypatch.setattr(service_task_tools.gh, "list_pull_requests", list_pull_requests)
    monkeypatch.setattr(service_task_tools.gh, "fetch_pull_request_files", fetch_pull_request_files)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_pull_requests": True,
            "include_commits": False,
            "pull_request_limit": 1,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-PR-LIST-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["pull_request_count"] == 1
    assert payload["api_search"]["pull_request_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 1,
        "returned": 2,
        "selected": 1,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"pull_request_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "pull_request_list": {"fetched": 1, "skipped": 1},
    }
    assert list_calls == [("platform/api", 1)]
    assert detail_calls == [("platform/api", 17)]

    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/pull/17"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["api_search"]["pull_request_list_attempts"] == (
        payload["api_search"]["pull_request_list_attempts"]
    )
    assert evidence["pull_request_details"] == [
        {
            "repo": "platform/api",
            "pull_number": 17,
            "candidate_source": "pull_request_list",
            "candidate_query": "pulls",
            "title": "kept secret",
            "state": "open",
            "author": "octocat",
            "head_sha": "sha-kept",
            "base_ref": "main",
            "files": ["config/kept.env"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "pull_number": 18,
            "candidate_source": "pull_request_list",
            "candidate_query": "pulls",
            "status": "skipped",
            "error": "GitHub pull-request-list candidate beyond pull_request_limit",
        },
    ]
    assert [artifact["asset"] for artifact in evidence["artifacts"]] == [
        "github:platform/api/pull/17",
    ]


def test_github_task_scan_pull_request_list_skips_out_of_scope_before_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch, GhPullRequest, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("P" * 36)
    detail_calls: list[tuple[str, int]] = []
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("PR-list scope filtering must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_pull_requests",
        lambda repo, *, limit=20: [
            GhPullRequest(
                repo="other/repo",
                number=99,
                title=f"wrong repo leak GITHUB_TOKEN={token}",
                state="open",
                author="octocat",
            ),
            GhPullRequest(
                repo="",
                number=98,
                title=f"missing repo leak GITHUB_TOKEN={token}",
                state="open",
                author="octocat",
            ),
            GhPullRequest(
                repo=repo,
                number=17,
                title="deploy secret cleanup",
                state="open",
                author="octocat",
                head_sha="sha-pr",
                base_ref="main",
            ),
        ],
    )

    def fetch_pull_request_files(repo: str, number: int):
        detail_calls.append((repo, number))
        if number == 99:
            raise AssertionError("out-of-scope PR must not be fetched")
        if number == 98:
            raise AssertionError("missing-repo PR must not be fetched")
        return GhCommitPatch(
            repo=repo,
            sha="pull-17",
            author=None,
            author_email=None,
            message="pull request #17",
            files=[{"filename": "config/prod.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_pull_request_files", fetch_pull_request_files)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_pull_requests": True,
            "include_commits": False,
            "pull_request_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-PR-LIST-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert detail_calls == [("platform/api", 17)]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["pull_request_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 2
    assert payload["api_search"]["pull_request_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 3,
        "selected": 1,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 2,
        "skipped": 2,
    }]
    assert payload["api_search"]["detail_status_by_source"] == {
        "pull_request_list": {"skipped": 2, "fetched": 1},
    }
    assert payload["errors"] == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert [
        {
            "repo": row["repo"],
            "target_repo": row.get("target_repo"),
            "pull_number": row["pull_number"],
            "status": row["status"],
        }
        for row in evidence["pull_request_details"]
    ] == [
        {
            "repo": "other/repo",
            "target_repo": "platform/api",
            "pull_number": 99,
            "status": "skipped",
        },
        {
            "repo": "",
            "target_repo": "platform/api",
            "pull_number": 98,
            "status": "skipped",
        },
        {
            "repo": "platform/api",
            "target_repo": None,
            "pull_number": 17,
            "status": "fetched",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/pull/17"


def test_github_task_scan_pull_request_list_empty_patch_is_error_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch, GhPullRequest, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    list_calls: list[tuple[str, int]] = []
    detail_calls: list[tuple[str, int]] = []
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("PR-list scan must not broaden after empty patch details")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def list_pull_requests(repo: str, *, limit: int = 20):
        list_calls.append((repo, limit))
        return [
            GhPullRequest(
                repo=repo,
                number=19,
                title="docs only",
                state="open",
                author="hubot",
                head_sha="sha-doc",
                base_ref="main",
            ),
        ]

    def fetch_pull_request_files(repo: str, number: int):
        detail_calls.append((repo, number))
        return GhCommitPatch(
            repo=repo,
            sha=f"pull-{number}",
            author=None,
            author_email=None,
            message=f"pull request #{number}",
            files=[],
        )

    monkeypatch.setattr(service_task_tools.gh, "list_pull_requests", list_pull_requests)
    monkeypatch.setattr(service_task_tools.gh, "fetch_pull_request_files", fetch_pull_request_files)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_pull_requests": True,
            "include_commits": False,
            "pull_request_limit": 1,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-PR-LIST-EMPTY"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "prs=1" in payload["status_reason"]
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["pull_request_count"] == 1
    assert payload["api_search"]["pull_request_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 1,
        "returned": 1,
        "selected": 1,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"pull_request_list": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "pull_request_list": {"missing": 1},
    }
    assert list_calls == [("platform/api", 1)]
    assert detail_calls == [("platform/api", 19)]
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["artifacts"] == []
    assert evidence["pull_request_details"] == [{
        "repo": "platform/api",
        "pull_number": 19,
        "candidate_source": "pull_request_list",
        "candidate_query": "pulls",
        "title": "docs only",
        "state": "open",
        "author": "hubot",
        "head_sha": "sha-doc",
        "base_ref": "main",
        "files": [],
        "file_count": 0,
        "scannable_file_count": 0,
        "status": "missing",
        "content_present": False,
        "error": "GitHub pull request detail returned no files",
    }]


def test_github_task_scan_pull_request_list_detail_failure_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhPullRequest, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    class PullRequestFilesFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("PR-list detail failure must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_pull_requests",
        lambda repo, *, limit=20: [
            GhPullRequest(
                repo=repo,
                number=17,
                title="deploy secret cleanup",
                state="open",
                author="octocat",
                head_sha="sha-pr",
                base_ref="main",
            ),
        ],
    )

    detail_calls: list[tuple[str, int]] = []

    def fail_pull_request_files(repo: str, number: int):
        detail_calls.append((repo, number))
        raise PullRequestFilesFailure("GitHub pull request files HTTP 503")

    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_pull_request_files",
        fail_pull_request_files,
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_pull_requests": True,
            "include_commits": False,
            "pull_request_limit": 1,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-PR-LIST-DETAIL-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert detail_calls == [("platform/api", 17)]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["pull_request_count"] == 1
    assert payload["api_search"]["pull_request_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 1,
        "returned": 1,
        "selected": 0,
        "duplicate": 0,
        "invalid": 1,
        "out_of_scope": 0,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_pull_request_files": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "pull_request_list": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {"pulls": 1}
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "fetch_pull_request_files"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["pull_request_list_attempts"] == (
        payload["api_search"]["pull_request_list_attempts"]
    )
    assert evidence["pull_request_details"] == [{
        "repo": "platform/api",
        "pull_number": 17,
        "candidate_source": "pull_request_list",
        "candidate_query": "pulls",
        "status": "error",
        "status_code": 503,
        "error": "PullRequestFilesFailure('GitHub pull request files HTTP 503')",
    }]


def test_github_task_scan_pull_request_list_api_failure_records_attempt(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    class ListPullRequestsFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("PR-list failure must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_pull_request_files", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_pull_requests",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ListPullRequestsFailure("GitHub list pull requests HTTP 503"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_pull_requests": True,
            "include_commits": False,
            "pull_request_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-PR-LIST-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["pull_request_count"] == 0
    assert payload["api_search"]["pull_request_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 0,
        "selected": 0,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 0,
        "phase": "list_pull_requests",
        "error": "ListPullRequestsFailure('GitHub list pull requests HTTP 503')",
        "status_code": 503,
    }]
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "list_pull_requests": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "list_pull_requests"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["pull_request_list_attempts"] == (
        payload["api_search"]["pull_request_list_attempts"]
    )
    assert evidence["pull_request_details"] == [{
        "repo": "platform/api",
        "candidate_source": "pull_request_list",
        "candidate_query": "pulls",
        "status": "error",
        "status_code": 503,
        "error": "ListPullRequestsFailure('GitHub list pull requests HTTP 503')",
    }]


def test_github_task_scan_issue_list_uses_bounded_issue_body_details(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhIssue, GhIssueDetail, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("I" * 36)
    list_calls: list[tuple[str, int]] = []
    detail_calls: list[tuple[str, int]] = []
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("issue-list scan must not run broad search, tree fallback, or recent commits")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def list_issues(repo: str, *, limit: int = 20):
        list_calls.append((repo, limit))
        return [
            GhIssue(
                repo=repo,
                number=30,
                title="prod token cleanup",
                state="open",
                author="octocat",
            ),
            GhIssue(
                repo=repo,
                number=31,
                title="empty discussion",
                state="open",
                author="hubot",
            ),
        ]

    def fetch_issue_detail(repo: str, number: int):
        detail_calls.append((repo, number))
        if number == 30:
            return GhIssueDetail(
                repo=repo,
                number=number,
                title="prod token cleanup",
                body=f"please rotate GITHUB_TOKEN={token}",
                state="open",
                author="octocat",
                comments=[{"author": "security", "body": "tracked in prod"}],
            )
        return GhIssueDetail(
            repo=repo,
            number=number,
            title="",
            body="",
            state="open",
            author="hubot",
            comments=[],
        )

    monkeypatch.setattr(service_task_tools.gh, "list_issues", list_issues)
    monkeypatch.setattr(service_task_tools.gh, "fetch_issue_detail", fetch_issue_detail)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_issues": True,
            "include_commits": False,
            "issue_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-ISSUE-LIST"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["issue_count"] == 2
    assert payload["api_search"]["issue_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 2,
        "selected": 2,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"issue_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "issue_list": {"fetched": 1, "empty": 1},
    }
    scan_summary = payload["api_search"]["scan_summary"]
    assert scan_summary["artifact_source_counts"] == {"issue_list": 1}
    assert scan_summary["reportable_source_counts"] == {"issue_list": 1}
    assert list_calls == [("platform/api", 2)]
    assert detail_calls == [("platform/api", 30), ("platform/api", 31)]

    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/issue/30"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "platform/api",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "include_issues": True,
        "issue_limit": 2,
        "private": True,
        "archived": False,
        "pushed_at": "2026-05-24T00:00:00Z",
        "size_kb": 0,
    }]
    assert evidence["issue_details"] == [
        {
            "repo": "platform/api",
            "issue_number": 30,
            "candidate_source": "issue_list",
            "candidate_query": "issues",
            "title": "prod token cleanup",
            "state": "open",
            "author": "octocat",
            "comment_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "issue_number": 31,
            "candidate_source": "issue_list",
            "candidate_query": "issues",
            "title": "",
            "state": "open",
            "author": "hubot",
            "comment_count": 0,
            "status": "empty",
            "content_present": False,
        },
    ]
    assert evidence["artifacts"][0]["metadata"]["scan_method"] == "api_issue_detail_scan"
    assert evidence["artifacts"][0]["metadata"]["candidate_source"] == "issue_list"
    assert evidence["artifacts"][0]["metadata"]["candidate_query"] == "issues"


def test_github_task_scan_issue_comments_audit_candidates_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhIssueDetail, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("C" * 36)
    detail_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded issue-comment scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_issues", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def fetch_issue_detail(repo: str, number: int):
        detail_calls.append((repo, number))
        return GhIssueDetail(
            repo=repo,
            number=number,
            title="clean issue title",
            body="clean issue body",
            state="open",
            author="octocat",
            comments=[
                {"author": "a", "body": "first clean comment"},
                {"author": "b", "body": "second clean comment"},
                {"author": "c", "body": f"GITHUB_TOKEN={token}"},
            ],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_issue_detail", fetch_issue_detail)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "issue_numbers": [30],
            "include_commits": False,
            "max_issue_comments_per_issue": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-ISSUE-COMMENT-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert detail_calls == [("platform/api", 30)]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["issue_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_issue": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_issue": {"fetched": 1, "skipped": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["issue_details"] == [
        {
            "repo": "platform/api",
            "issue_number": 30,
            "candidate_source": "explicit_issue",
            "title": "clean issue title",
            "state": "open",
            "author": "octocat",
            "comment_count": 3,
            "status": "fetched",
            "candidate_limit_hit": True,
            "limit_skipped": 1,
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "issue_number": 30,
            "candidate_source": "explicit_issue",
            "comment_index": 2,
            "status": "skipped",
            "error": (
                "GitHub issue comment candidate beyond "
                "max_issue_comments_per_issue"
            ),
        },
    ]
    assert evidence["artifacts"] == []
    assert token not in json.dumps(evidence)


def test_github_task_scan_issue_list_marks_limit_hit_for_overreturned_issues(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhIssue, GhIssueDetail, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    kept_token = "ghp_" + ("U" * 36)
    overflow_token = "ghp_" + ("V" * 36)
    list_calls: list[tuple[str, int]] = []
    detail_calls: list[tuple[str, int]] = []
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("issue-list over-return must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def list_issues(repo: str, *, limit: int = 20):
        list_calls.append((repo, limit))
        return [
            GhIssue(
                repo=repo,
                number=30,
                title="kept issue",
                state="open",
                author="octocat",
            ),
            GhIssue(
                repo=repo,
                number=31,
                title=f"overflow issue GITHUB_TOKEN={overflow_token}",
                state="open",
                author="hubot",
            ),
        ]

    def fetch_issue_detail(repo: str, number: int):
        detail_calls.append((repo, number))
        if number != 30:
            raise AssertionError("issue beyond issue_limit must not fetch detail")
        return GhIssueDetail(
            repo=repo,
            number=number,
            title="kept issue",
            body=f"please rotate GITHUB_TOKEN={kept_token}",
            state="open",
            author="octocat",
            comments=[{"author": "security", "body": "tracked in prod"}],
        )

    monkeypatch.setattr(service_task_tools.gh, "list_issues", list_issues)
    monkeypatch.setattr(service_task_tools.gh, "fetch_issue_detail", fetch_issue_detail)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_issues": True,
            "include_commits": False,
            "issue_limit": 1,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-ISSUE-LIST-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["issue_count"] == 1
    assert payload["api_search"]["issue_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 1,
        "returned": 2,
        "selected": 1,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"issue_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "issue_list": {"fetched": 1, "skipped": 1},
    }
    assert list_calls == [("platform/api", 1)]
    assert detail_calls == [("platform/api", 30)]

    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/issue/30"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["api_search"]["issue_list_attempts"] == payload["api_search"]["issue_list_attempts"]
    assert evidence["issue_details"] == [
        {
            "repo": "platform/api",
            "issue_number": 30,
            "candidate_source": "issue_list",
            "candidate_query": "issues",
            "title": "kept issue",
            "state": "open",
            "author": "octocat",
            "comment_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "issue_number": 31,
            "candidate_source": "issue_list",
            "candidate_query": "issues",
            "status": "skipped",
            "error": "GitHub issue-list candidate beyond issue_limit",
        },
    ]
    assert [artifact["asset"] for artifact in evidence["artifacts"]] == [
        "github:platform/api/issue/30",
    ]


def test_github_task_scan_explicit_issue_dedupes_with_skipped_evidence(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhIssueDetail
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("E" * 36)
    detail_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact issue scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_issues", forbidden_call)

    def fetch_issue_detail(repo: str, number: int):
        detail_calls.append((repo, number))
        if number != 30:
            raise AssertionError("duplicate explicit issue candidate must not be fetched")
        return GhIssueDetail(
            repo=repo,
            number=number,
            title="prod token cleanup",
            body=f"please rotate GITHUB_TOKEN={token}",
            state="open",
            author="octocat",
            comments=[{"author": "security", "body": "tracked in prod"}],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_issue_detail", fetch_issue_detail)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "issue_numbers": [30, 30],
            "include_issues": False,
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-ISSUE-DEDUP"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["issue_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_issue": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_issue": {"fetched": 1, "skipped": 1},
    }
    assert detail_calls == [("platform/api", 30)]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["issue_details"] == [
        {
            "repo": "platform/api",
            "issue_number": 30,
            "candidate_source": "explicit_issue",
            "title": "prod token cleanup",
            "state": "open",
            "author": "octocat",
            "comment_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "issue_number": 30,
            "candidate_source": "explicit_issue",
            "status": "skipped",
            "error": "duplicate issue candidate",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/issue/30"


def test_github_task_scan_explicit_issue_requires_repo_scope(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhIssueDetail
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("S" * 36)
    detail_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact issue scope test must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_issues", forbidden_call)

    def fetch_issue_detail(repo: str, number: int):
        detail_calls.append((repo, number))
        return GhIssueDetail(
            repo="",
            number=number,
            title="prod token cleanup",
            body=f"please rotate GITHUB_TOKEN={token}",
            state="open",
            author="octocat",
            comments=[],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_issue_detail", fetch_issue_detail)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "issue_numbers": [30],
            "include_issues": False,
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-ISSUE-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert detail_calls == [("platform/api", 30)]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_issue": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_issue": {"skipped": 1},
    }

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["issue_details"] == [{
        "repo": "",
        "target_repo": "platform/api",
        "issue_number": 30,
        "candidate_source": "explicit_issue",
        "status": "skipped",
        "error": "GitHub issue candidate out of requested repo scope",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_issues_audit_candidates_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhIssueDetail, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    token = "ghp_" + ("I" * 36)
    detail_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded exact issue scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_issues", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def fetch_issue_detail(repo: str, number: int):
        detail_calls.append((repo, number))
        if number == 32:
            return GhIssueDetail(
                repo=repo,
                number=number,
                title="overflow issue",
                body=f"please rotate GITHUB_TOKEN={token}",
                state="open",
                author="octocat",
                comments=[{"author": "security", "body": "overflow comment"}],
            )
        return GhIssueDetail(
            repo=repo,
            number=number,
            title=f"clean issue {number}",
            body="clean issue body",
            state="open",
            author="octocat",
            comments=[{"author": "security", "body": "clean comment"}],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_issue_detail", fetch_issue_detail)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "issue_numbers": [30, 31, 32],
            "issue_limit": 2,
            "include_issues": False,
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-ISSUE-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert detail_calls == [("platform/api", 30), ("platform/api", 31)]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["issue_count"] == 2
    assert payload["api_search"]["detail_source_counts"] == {"explicit_issue": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_issue": {"fetched": 2, "skipped": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["issue_details"] == [
        {
            "repo": "platform/api",
            "issue_number": 30,
            "candidate_source": "explicit_issue",
            "title": "clean issue 30",
            "state": "open",
            "author": "octocat",
            "comment_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "issue_number": 31,
            "candidate_source": "explicit_issue",
            "title": "clean issue 31",
            "state": "open",
            "author": "octocat",
            "comment_count": 1,
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "issue_number": 32,
            "candidate_source": "explicit_issue",
            "status": "skipped",
            "error": "GitHub explicit issue candidate beyond issue_limit",
        },
    ]


def test_github_task_scan_issue_list_skips_out_of_scope_before_detail(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhIssue, GhIssueDetail, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("I" * 36)
    detail_calls: list[tuple[str, int]] = []
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("issue-list scope filtering must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_issues",
        lambda repo, *, limit=20: [
            GhIssue(
                repo="other/repo",
                number=88,
                title=f"wrong repo leak GITHUB_TOKEN={token}",
                state="open",
                author="octocat",
            ),
            GhIssue(
                repo="",
                number=77,
                title=f"missing repo leak GITHUB_TOKEN={token}",
                state="open",
                author="octocat",
            ),
            GhIssue(
                repo=repo,
                number=30,
                title="prod token cleanup",
                state="open",
                author="octocat",
            ),
        ],
    )

    def fetch_issue_detail(repo: str, number: int):
        detail_calls.append((repo, number))
        if number == 88:
            raise AssertionError("out-of-scope issue must not be fetched")
        if number == 77:
            raise AssertionError("missing-repo issue must not be fetched")
        return GhIssueDetail(
            repo=repo,
            number=number,
            title="prod token cleanup",
            body=f"please rotate GITHUB_TOKEN={token}",
            state="open",
            author="octocat",
            comments=[],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_issue_detail", fetch_issue_detail)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_issues": True,
            "include_commits": False,
            "issue_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-ISSUE-LIST-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert detail_calls == [("platform/api", 30)]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["issue_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 2
    assert payload["api_search"]["issue_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 3,
        "selected": 1,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 2,
        "skipped": 2,
    }]
    assert payload["api_search"]["detail_status_by_source"] == {
        "issue_list": {"skipped": 2, "fetched": 1},
    }
    assert payload["errors"] == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert [
        {
            "repo": row["repo"],
            "target_repo": row.get("target_repo"),
            "issue_number": row["issue_number"],
            "status": row["status"],
        }
        for row in evidence["issue_details"]
    ] == [
        {
            "repo": "other/repo",
            "target_repo": "platform/api",
            "issue_number": 88,
            "status": "skipped",
        },
        {
            "repo": "",
            "target_repo": "platform/api",
            "issue_number": 77,
            "status": "skipped",
        },
        {
            "repo": "platform/api",
            "target_repo": None,
            "issue_number": 30,
            "status": "fetched",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/issue/30"


def test_github_task_scan_issue_list_empty_detail_is_error_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhIssue, GhIssueDetail, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    list_calls: list[tuple[str, int]] = []
    detail_calls: list[tuple[str, int]] = []
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("issue-list scan must not broaden after empty details")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)

    def list_issues(repo: str, *, limit: int = 20):
        list_calls.append((repo, limit))
        return [
            GhIssue(
                repo=repo,
                number=32,
                title="empty discussion",
                state="open",
                author="hubot",
            ),
        ]

    def fetch_issue_detail(repo: str, number: int):
        detail_calls.append((repo, number))
        return GhIssueDetail(
            repo=repo,
            number=number,
            title="",
            body="",
            state="open",
            author="hubot",
            comments=[],
        )

    monkeypatch.setattr(service_task_tools.gh, "list_issues", list_issues)
    monkeypatch.setattr(service_task_tools.gh, "fetch_issue_detail", fetch_issue_detail)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_issues": True,
            "include_commits": False,
            "issue_limit": 1,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-ISSUE-LIST-EMPTY"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "issues=1" in payload["status_reason"]
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_attempts"] == []
    assert payload["api_search"]["issue_count"] == 1
    assert payload["api_search"]["issue_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 1,
        "returned": 1,
        "selected": 1,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"issue_list": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "issue_list": {"empty": 1},
    }
    assert list_calls == [("platform/api", 1)]
    assert detail_calls == [("platform/api", 32)]
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["artifacts"] == []
    assert evidence["issue_details"] == [{
        "repo": "platform/api",
        "issue_number": 32,
        "candidate_source": "issue_list",
        "candidate_query": "issues",
        "title": "",
        "state": "open",
        "author": "hubot",
        "comment_count": 0,
        "status": "empty",
        "content_present": False,
    }]


def test_github_task_scan_issue_list_detail_failure_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhIssue, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    class IssueDetailFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    detail_calls: list[tuple[str, int]] = []
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("issue-list detail failure must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_issues",
        lambda repo, *, limit=20: [
            GhIssue(
                repo=repo,
                number=30,
                title="prod token cleanup",
                state="open",
                author="octocat",
            ),
        ],
    )

    def fetch_issue_detail(repo: str, number: int):
        detail_calls.append((repo, number))
        raise IssueDetailFailure("GitHub issue detail HTTP 503")

    monkeypatch.setattr(service_task_tools.gh, "fetch_issue_detail", fetch_issue_detail)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_issues": True,
            "include_commits": False,
            "issue_limit": 1,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-ISSUE-LIST-DETAIL-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert detail_calls == [("platform/api", 30)]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["query_count"] == 0
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["issue_count"] == 1
    assert payload["api_search"]["issue_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 1,
        "returned": 1,
        "selected": 0,
        "duplicate": 0,
        "invalid": 1,
        "out_of_scope": 0,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_issue_detail": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "issue_list": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {"issues": 1}
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "fetch_issue_detail"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["issue_list_attempts"] == (
        payload["api_search"]["issue_list_attempts"]
    )
    assert evidence["issue_details"] == [{
        "repo": "platform/api",
        "issue_number": 30,
        "candidate_source": "issue_list",
        "candidate_query": "issues",
        "status": "error",
        "status_code": 503,
        "error": "IssueDetailFailure('GitHub issue detail HTTP 503')",
    }]


def test_github_task_scan_issue_list_api_failure_records_attempt(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    class ListIssuesFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("issue-list failure must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_issue_detail", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_issues",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ListIssuesFailure("GitHub list issues HTTP 503"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_issues": True,
            "include_commits": False,
            "issue_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-ISSUE-LIST-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["issue_count"] == 0
    assert payload["api_search"]["issue_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 0,
        "selected": 0,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 0,
        "phase": "list_issues",
        "error": "ListIssuesFailure('GitHub list issues HTTP 503')",
        "status_code": 503,
    }]
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {"list_issues": 1}
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "list_issues"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["issue_list_attempts"] == payload["api_search"]["issue_list_attempts"]
    assert evidence["issue_details"] == [{
        "repo": "platform/api",
        "candidate_source": "issue_list",
        "candidate_query": "issues",
        "status": "error",
        "status_code": 503,
        "error": "ListIssuesFailure('GitHub list issues HTTP 503')",
    }]


def test_github_task_scan_release_list_api_failure_records_attempt(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    class ListReleasesFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("release-list failure must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_release_by_tag", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_releases",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ListReleasesFailure("GitHub list releases HTTP 503"),
        ),
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "include_releases": True,
            "include_commits": False,
            "release_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-RELEASE-LIST-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["release_count"] == 0
    assert payload["api_search"]["release_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 0,
        "selected": 0,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 0,
        "phase": "list_releases",
        "error": "ListReleasesFailure('GitHub list releases HTTP 503')",
        "status_code": 503,
    }]
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {"list_releases": 1}
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "list_releases"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["release_list_attempts"] == payload["api_search"]["release_list_attempts"]
    assert evidence["release_details"] == [{
        "repo": "platform/api",
        "candidate_source": "release_list",
        "candidate_query": "releases",
        "status": "error",
        "status_code": 503,
        "error": "ListReleasesFailure('GitHub list releases HTTP 503')",
    }]


def test_github_task_scan_release_list_dedupes_with_skipped_evidence(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhReleaseDetail
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    token = "ghp_" + ("L" * 36)
    release_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("release-list scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_release_by_tag", forbidden_call)

    def list_releases(repo: str, *, limit: int = 20):
        release_calls.append((repo, limit))
        return [
            GhReleaseDetail(
                repo=repo,
                tag_name="v1.2.3",
                name="v1.2.3",
                body=f"rotate GITHUB_TOKEN={token}",
                author="octocat",
                draft=False,
                prerelease=False,
                assets=[],
            ),
            GhReleaseDetail(
                repo=repo,
                tag_name="v1.2.3",
                name="v1.2.3 duplicate",
                body="same release returned twice",
                author="octocat",
                draft=False,
                prerelease=False,
                assets=[],
            ),
        ]

    monkeypatch.setattr(service_task_tools.gh, "list_releases", list_releases)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "include_releases": True,
            "include_commits": False,
            "release_limit": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-RELEASE-LIST-DEDUP"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["release_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    assert payload["api_search"]["release_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 2,
        "returned": 2,
        "selected": 1,
        "duplicate": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"release_list": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "release_list": {"fetched": 1, "skipped": 1},
    }
    assert release_calls == [("platform/api", 2)]

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["release_details"] == [
        {
            "repo": "platform/api",
            "tag_name": "v1.2.3",
            "fetched_tag_name": "v1.2.3",
            "candidate_source": "release_list",
            "candidate_query": "releases",
            "name": "v1.2.3",
            "author": "octocat",
            "draft": False,
            "prerelease": False,
            "asset_count": 0,
            "assets": [],
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "tag_name": "v1.2.3",
            "candidate_source": "release_list",
            "candidate_query": "releases",
            "status": "skipped",
            "error": "duplicate release candidate",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/release/v1.2.3"


def test_github_task_scan_release_list_skips_unscoped_before_scan(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhReleaseDetail
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    token = "ghp_" + ("L" * 36)
    release_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("release-list scope test must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_release_by_tag", forbidden_call)

    def list_releases(repo: str, *, limit: int = 20):
        release_calls.append((repo, limit))
        return [
            GhReleaseDetail(
                repo="other/repo",
                tag_name="v9.9.9",
                name="other release",
                body=f"wrong repo GITHUB_TOKEN={token}",
                author="octocat",
                draft=False,
                prerelease=False,
                assets=[],
            ),
            GhReleaseDetail(
                repo="",
                tag_name="v8.8.8",
                name="missing repo release",
                body=f"missing repo GITHUB_TOKEN={token}",
                author="octocat",
                draft=False,
                prerelease=False,
                assets=[],
            ),
            GhReleaseDetail(
                repo=repo,
                tag_name="v1.2.3",
                name="v1.2.3",
                body=f"rotate GITHUB_TOKEN={token}",
                author="octocat",
                draft=False,
                prerelease=False,
                assets=[],
            ),
        ]

    monkeypatch.setattr(service_task_tools.gh, "list_releases", list_releases)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "include_releases": True,
            "include_commits": False,
            "release_limit": 3,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
            "max_files_per_repo": 5,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-RELEASE-LIST-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["release_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 2
    assert payload["api_search"]["release_list_attempts"] == [{
        "repo": "platform/api",
        "limit": 3,
        "returned": 3,
        "selected": 1,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 2,
        "skipped": 2,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"release_list": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "release_list": {"skipped": 2, "fetched": 1},
    }
    assert release_calls == [("platform/api", 3)]

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert "wrong repo GITHUB_TOKEN" not in evidence_text
    assert "missing repo GITHUB_TOKEN" not in evidence_text
    evidence = json.loads(evidence_text)
    assert [
        {
            "repo": row["repo"],
            "target_repo": row.get("target_repo"),
            "tag_name": row["tag_name"],
            "status": row["status"],
        }
        for row in evidence["release_details"]
    ] == [
        {
            "repo": "other/repo",
            "target_repo": "platform/api",
            "tag_name": "v9.9.9",
            "status": "skipped",
        },
        {
            "repo": "",
            "target_repo": "platform/api",
            "tag_name": "v8.8.8",
            "status": "skipped",
        },
        {
            "repo": "platform/api",
            "target_repo": None,
            "tag_name": "v1.2.3",
            "status": "fetched",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/release/v1.2.3"


def test_github_task_scan_explicit_release_dedupes_with_skipped_evidence(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhReleaseDetail
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("R" * 36)
    release_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact release scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_releases", forbidden_call)

    def fetch_release_by_tag(repo: str, tag_name: str):
        release_calls.append((repo, tag_name))
        if tag_name != "v1.2.3":
            raise AssertionError("duplicate explicit release candidate must not be fetched")
        return GhReleaseDetail(
            repo=repo,
            tag_name=tag_name,
            name="v1.2.3",
            body=f"rotate GITHUB_TOKEN={token}",
            author="octocat",
            draft=False,
            prerelease=False,
            assets=[],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_release_by_tag", fetch_release_by_tag)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "release_tags": ["v1.2.3", "v1.2.3"],
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-RELEASE-DEDUP"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["release_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_release": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_release": {"fetched": 1, "skipped": 1},
    }
    assert release_calls == [("platform/api", "v1.2.3")]

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["release_details"] == [
        {
            "repo": "platform/api",
            "tag_name": "v1.2.3",
            "fetched_tag_name": "v1.2.3",
            "candidate_source": "explicit_release",
            "name": "v1.2.3",
            "author": "octocat",
            "draft": False,
            "prerelease": False,
            "asset_count": 0,
            "assets": [],
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "tag_name": "v1.2.3",
            "candidate_source": "explicit_release",
            "status": "skipped",
            "error": "duplicate release candidate",
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/release/v1.2.3"


def test_github_task_scan_explicit_release_requires_repo_scope(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhReleaseDetail
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("S" * 36)
    release_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact release scope test must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_releases", forbidden_call)

    def fetch_release_by_tag(repo: str, tag_name: str):
        release_calls.append((repo, tag_name))
        return GhReleaseDetail(
            repo="",
            tag_name=tag_name,
            name="v1.2.3",
            body=f"rotate GITHUB_TOKEN={token}",
            author="octocat",
            draft=False,
            prerelease=False,
            assets=[],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_release_by_tag", fetch_release_by_tag)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "release_tags": ["v1.2.3"],
            "include_commits": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-RELEASE-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert release_calls == [("platform/api", "v1.2.3")]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_release": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_release": {"skipped": 1},
    }

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["release_details"] == [{
        "repo": "",
        "target_repo": "platform/api",
        "tag_name": "v1.2.3",
        "candidate_source": "explicit_release",
        "status": "skipped",
        "error": "GitHub release candidate out of requested repo scope",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_releases_audit_candidates_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhReleaseDetail, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    token = "ghp_" + ("T" * 36)
    release_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded exact release scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_releases", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def fetch_release_by_tag(repo: str, tag_name: str):
        release_calls.append((repo, tag_name))
        if tag_name == "v1.2.5":
            return GhReleaseDetail(
                repo=repo,
                tag_name=tag_name,
                name="overflow release",
                body=f"rotate GITHUB_TOKEN={token}",
                author="octocat",
                draft=False,
                prerelease=False,
                assets=[],
            )
        return GhReleaseDetail(
            repo=repo,
            tag_name=tag_name,
            name=tag_name,
            body="clean release notes",
            author="octocat",
            draft=False,
            prerelease=False,
            assets=[],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_release_by_tag", fetch_release_by_tag)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "release_tags": ["v1.2.3", "v1.2.4", "v1.2.5"],
            "release_limit": 2,
            "include_releases": False,
            "include_commits": False,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-EXACT-RELEASE-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert release_calls == [
        ("platform/api", "v1.2.3"),
        ("platform/api", "v1.2.4"),
    ]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["release_count"] == 2
    assert payload["api_search"]["detail_source_counts"] == {"explicit_release": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_release": {"fetched": 2, "skipped": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["release_details"] == [
        {
            "repo": "platform/api",
            "tag_name": "v1.2.3",
            "fetched_tag_name": "v1.2.3",
            "candidate_source": "explicit_release",
            "name": "v1.2.3",
            "author": "octocat",
            "draft": False,
            "prerelease": False,
            "asset_count": 0,
            "assets": [],
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "tag_name": "v1.2.4",
            "fetched_tag_name": "v1.2.4",
            "candidate_source": "explicit_release",
            "name": "v1.2.4",
            "author": "octocat",
            "draft": False,
            "prerelease": False,
            "asset_count": 0,
            "assets": [],
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "tag_name": "v1.2.5",
            "candidate_source": "explicit_release",
            "status": "skipped",
            "error": "GitHub explicit release candidate beyond release_limit",
        },
    ]


def test_github_task_scan_release_assets_audit_candidates_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.github.plugin.agent_types.github import GhReleaseDetail, GhRepo
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from secu_agent import state

    token = "ghp_" + ("A" * 36)
    release_calls: list[tuple[str, str]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded release-asset scan must not broaden")

    monkeypatch.setattr(service_task_tools.gh, "code_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", forbidden_call)
    monkeypatch.setattr(service_task_tools.gh, "list_releases", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.gh,
        "repo_meta",
        lambda repo: GhRepo(
            full_name=repo,
            default_branch="main",
            private=True,
            archived=False,
            pushed_at="2026-05-24T00:00:00Z",
        ),
    )

    def fetch_release_by_tag(repo: str, tag_name: str):
        release_calls.append((repo, tag_name))
        return GhReleaseDetail(
            repo=repo,
            tag_name=tag_name,
            name="clean release",
            body="clean release notes",
            author="octocat",
            draft=False,
            prerelease=False,
            assets=[
                {
                    "name": "first.txt",
                    "label": "first clean asset",
                    "browser_download_url": (
                        "https://gh.test/platform/api/releases/download/v1.2.3/first.txt"
                    ),
                    "content_type": "text/plain",
                },
                {
                    "name": "second.txt",
                    "label": "second clean asset",
                    "browser_download_url": (
                        "https://gh.test/platform/api/releases/download/v1.2.3/second.txt"
                    ),
                    "content_type": "text/plain",
                },
                {
                    "name": f"GITHUB_TOKEN={token}",
                    "label": "overflow token asset",
                    "browser_download_url": (
                        "https://gh.test/platform/api/releases/download/v1.2.3/"
                        f"GITHUB_TOKEN={token}"
                    ),
                    "content_type": "text/plain",
                },
            ],
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_release_by_tag", fetch_release_by_tag)

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "release_tags": ["v1.2.3"],
            "include_commits": False,
            "max_release_assets_per_release": 2,
            "code_search_terms": ["password"],
            "hot_paths": ["prod.env"],
        },
        tmp_path,
        {"charter_ref": "SECOPS-GITHUB-RELEASE-ASSET-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert release_calls == [("platform/api", "v1.2.3")]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["release_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_release": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_release": {"fetched": 1, "skipped": 1},
    }
    assert _scanned(res, limit=10) == []

    evidence_text = Path(payload["evidence_ref"]).read_text(encoding="utf-8")
    assert token not in evidence_text
    evidence = json.loads(evidence_text)
    assert evidence["release_details"] == [
        {
            "repo": "platform/api",
            "tag_name": "v1.2.3",
            "fetched_tag_name": "v1.2.3",
            "candidate_source": "explicit_release",
            "name": "clean release",
            "author": "octocat",
            "draft": False,
            "prerelease": False,
            "asset_count": 3,
            "assets": [
                {
                    "name": "first.txt",
                    "label": "first clean asset",
                    "browser_download_url": (
                        "https://gh.test/platform/api/releases/download/v1.2.3/first.txt"
                    ),
                    "content_type": "text/plain",
                },
                {
                    "name": "second.txt",
                    "label": "second clean asset",
                    "browser_download_url": (
                        "https://gh.test/platform/api/releases/download/v1.2.3/second.txt"
                    ),
                    "content_type": "text/plain",
                },
            ],
            "status": "fetched",
            "candidate_limit_hit": True,
            "limit_skipped": 1,
            "content_present": True,
        },
        {
            "repo": "platform/api",
            "tag_name": "v1.2.3",
            "fetched_tag_name": "v1.2.3",
            "candidate_source": "explicit_release",
            "asset_index": 2,
            "status": "skipped",
            "error": (
                "GitHub release asset candidate beyond "
                "max_release_assets_per_release"
            ),
        },
    ]


def test_github_task_scan_out_of_scope_code_search_only_uses_hot_path_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBlobRef
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("S" * 36)
    search_queries: list[str] = []
    blob_fetch_calls: list[tuple[str, str]] = []

    def code_search(query: str, per_page: int = 50, max_results: int = 50):
        search_queries.append(query)
        return [
            service_task_tools.gh.GhCodeHit(repo="other/repo", path=".env"),
        ]

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append((repo, sha))
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "code_search", code_search)
    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_file_at_ref",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope code search hit must not be fetched"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, hot_paths: [
            GhBlobRef(repo=repo, ref=ref, path=".env", sha="fallback-sha", size=80),
            GhBlobRef(repo=repo, ref=ref, path="settings.env", sha="later-sha", size=80),
        ],
    )
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
            "max_files_per_repo": 1,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["query_details"][0]["returned"] == 1
    assert payload["api_search"]["query_details"][0]["added"] == 0
    assert payload["api_search"]["query_details"][0]["out_of_scope"] == 1
    assert payload["api_search"]["query_details"][0]["skipped"] == 1
    assert payload["api_search"]["query_status_counts"] == {"searched": 1}
    assert payload["api_search"]["query_candidate_totals"] == {
        "returned": 1,
        "added": 0,
        "invalid": 0,
        "out_of_scope": 1,
        "duplicate": 0,
        "skipped": 1,
    }
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_hot_path_tree"] == 1
    assert len(payload["api_search"]["fallback_attempts"]) == 1
    fallback_attempt = payload["api_search"]["fallback_attempts"][0]
    assert fallback_attempt["repo"] == "platform/api"
    assert fallback_attempt["reason"] == "no_api_candidates"
    assert fallback_attempt["returned"] == 2
    assert fallback_attempt["selected"] == 1
    assert fallback_attempt["candidate_limit_hit"] is True
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_source_counts"]["code_search"] == 1
    assert payload["api_search"]["detail_status_by_source"]["code_search"] == {"skipped": 1}
    assert len(search_queries) == 1
    assert blob_fetch_calls == [("platform/api", "fallback-sha")]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    code_search_details = [
        detail for detail in evidence["file_details"]
        if detail.get("candidate_source") == "code_search"
    ]
    assert code_search_details == [{
        "repo": "other/repo",
        "target_repo": "platform/api",
        "path": ".env",
        "candidate_source": "code_search",
        "candidate_query": "repo:platform/api password",
        "status": "skipped",
        "error": "GitHub code-search candidate out of requested repo scope",
    }]

    row = _scanned(res, limit=10)[0]
    assert row["asset"] == "github:platform/api/.env"
    assert row["metadata"]["candidate_source"] == "hot_path_tree"
    assert row["metadata"]["scan_method"] == "fallback_hot_path_tree_scan"


def test_github_task_scan_api_unavailable_uses_bounded_hot_path_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBlobRef
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    tokens = {
        "sha1": "ghp_" + ("U" * 36),
        "sha2": "ghp_" + ("V" * 36),
        "sha3": "ghp_" + ("W" * 36),
    }
    blob_fetch_calls: list[str] = []

    def fail_code_search(*args, **kwargs):
        raise RuntimeError("GITHUB_TOKEN missing")

    monkeypatch.setattr(service_task_tools.gh, "code_search", fail_code_search)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, hot_paths: [
            GhBlobRef(repo=repo, ref=ref, path="one.env", sha="sha1", size=80),
            GhBlobRef(repo=repo, ref=ref, path="two.env", sha="sha2", size=80),
            GhBlobRef(repo=repo, ref=ref, path="three.env", sha="sha3", size=80),
        ],
    )

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append(sha)
        return f"GITHUB_TOKEN={tokens[sha]}\n"

    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", lambda *args, **kwargs: None)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
            "max_files_per_repo": 2,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 2
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["api_search"]["unavailable"] is True
    assert payload["api_search"]["errors"][0]["phase"] == "code_search"
    assert payload["errors"][0]["phase"] == "code_search"
    assert payload["api_search"]["fallback_reason"] == "api_unavailable"
    assert payload["api_search"]["fallback_hot_path_tree"] == 2
    assert len(payload["api_search"]["fallback_attempts"]) == 1
    fallback_attempt = payload["api_search"]["fallback_attempts"][0]
    assert fallback_attempt["repo"] == "platform/api"
    assert fallback_attempt["ref"] == "main"
    assert fallback_attempt["reason"] == "api_unavailable"
    assert fallback_attempt["returned"] == 3
    assert fallback_attempt["selected"] == 2
    assert fallback_attempt["candidate_limit_hit"] is True
    assert fallback_attempt["limit_skipped"] == 1
    assert fallback_attempt["skipped"] == 1
    assert payload["api_search"]["detail_fetched"] == 2
    assert blob_fetch_calls == ["sha1", "sha2"]
    assert len(_scanned(res, limit=10)) == 2


def test_github_task_scan_code_search_403_rate_limit_fails_closed_without_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    import httpx

    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    def client_factory():
        def handler(req: httpx.Request) -> httpx.Response:
            if req.url.path.endswith("/search/code"):
                return httpx.Response(403, json={"message": "rate limited"})
            raise AssertionError(f"unexpected request: {req.url}")

        return httpx.Client(
            transport=httpx.MockTransport(handler),
            base_url="https://gh.test/api/v3",
        )

    monkeypatch.setattr(service_task_tools.gh, "_client", client_factory)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("rate limit must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_blob_text",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("rate limit must not fetch fallback blobs"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["artifacts_scanned"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["limit_failed"] is True
    assert payload["api_search"]["unavailable"] is False
    assert payload["api_search"]["errors"][0]["phase"] == "code_search"
    assert payload["api_search"]["errors"][0]["status_code"] == 403
    assert "403" in payload["api_search"]["errors"][0]["error"]
    assert payload["errors"][0]["phase"] == "code_search"
    assert payload["errors"][0]["status_code"] == 403
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["fallback_reason"] is None
    assert payload["api_search"]["fallback_attempts"] == []


def test_github_task_scan_fallback_detail_missing_is_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBlobRef
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    blob_fetch_calls: list[str] = []

    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, hot_paths: [
            GhBlobRef(repo=repo, ref=ref, path="one.env", sha="sha1", size=80),
            GhBlobRef(repo=repo, ref=ref, path="two.env", sha="sha2", size=80),
        ],
    )

    def missing_blob_text(repo: str, sha: str) -> None:
        blob_fetch_calls.append(sha)
        return None

    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", missing_blob_text)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    metadata: dict = {}
    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
            "max_files_per_repo": 2,
        },
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert metadata["_github_task_scan_status"] == "error"
    assert metadata["_github_task_scan_recommended_status"] == "error"
    assert "detail fetch returned no content" in metadata["_github_task_scan_status_reason"]
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_hot_path_tree"] == 2
    assert payload["api_search"]["detail_missing"] == 2
    assert payload["api_search"]["detail_status_counts"] == {"missing": 2}
    assert payload["api_search"]["detail_status_by_kind"] == {"file": {"missing": 2}}
    assert payload["api_search"]["detail_status_total"] == 2
    assert blob_fetch_calls == ["sha1", "sha2"]
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_status_counts"] == payload["api_search"]["detail_status_counts"]
    assert evidence["api_search"]["detail_status_by_kind"] == payload["api_search"]["detail_status_by_kind"]
    assert evidence["file_details"] == [
        {
            "repo": "platform/api",
            "path": "one.env",
            "ref": "main",
            "sha": "sha1",
            "size": 80,
            "candidate_source": "hot_path_tree",
            "candidate_query": "",
            "status": "missing",
            "content_present": False,
        },
        {
            "repo": "platform/api",
            "path": "two.env",
            "ref": "main",
            "sha": "sha2",
            "size": 80,
            "candidate_source": "hot_path_tree",
            "candidate_query": "",
            "status": "missing",
            "content_present": False,
        },
    ]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_fallback_filters_out_of_scope_blob_before_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBlobRef
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("Q" * 36)
    blob_fetch_calls: list[tuple[str, str]] = []

    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, hot_paths: [
            GhBlobRef(repo="other/repo", ref=ref, path=".env", sha="other-sha", size=80),
            GhBlobRef(repo=repo, ref=ref, path=".env", sha="in-scope-sha", size=80),
        ],
    )

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append((repo, sha))
        if repo == "other/repo":
            raise AssertionError("out-of-scope fallback blob must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
            "max_files_per_repo": 2,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 2
    assert payload["api_search"]["out_of_scope_count"] == 1
    fallback_attempt = payload["api_search"]["fallback_attempts"][0]
    assert fallback_attempt["returned"] == 2
    assert fallback_attempt["selected"] == 2
    assert fallback_attempt["out_of_scope"] == 1
    assert fallback_attempt["invalid"] == 0
    assert fallback_attempt["skipped"] == 1
    assert payload["api_search"]["detail_status_counts"] == {"skipped": 1, "fetched": 1}
    assert payload["api_search"]["detail_status_by_source"]["hot_path_tree"] == {
        "skipped": 1,
        "fetched": 1,
    }
    assert blob_fetch_calls == [("platform/api", "in-scope-sha")]
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [
        {
            "repo": "other/repo",
            "target_repo": "platform/api",
            "path": ".env",
            "ref": "main",
            "sha": "other-sha",
            "size": 80,
            "candidate_source": "hot_path_tree",
            "candidate_query": "",
            "status": "skipped",
            "error": "GitHub hot-path blob candidate out of requested repo scope",
        },
        {
            "repo": "platform/api",
            "path": ".env",
            "ref": "main",
            "sha": "in-scope-sha",
            "size": 80,
            "candidate_source": "hot_path_tree",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/.env"


def test_github_task_scan_fallback_blank_detail_counts_missing(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBlobRef
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, hot_paths: [
            GhBlobRef(repo=repo, ref=ref, path="blank.env", sha="sha-blank", size=12),
            GhBlobRef(repo=repo, ref=ref, path="empty.env", sha="sha-empty", size=0),
        ],
    )
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", lambda *args, **kwargs: "   \n")
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
            "max_files_per_repo": 2,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert payload["api_search"]["fallback_hot_path_tree"] == 2
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 2
    assert _scanned(res, limit=10) == []


def test_github_task_scan_fallback_unscoped_and_malformed_blob_candidates_are_not_fetched(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBlobRef
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, hot_paths: [
            GhBlobRef(repo="", ref=ref, path="missing-repo.env", sha="sha1", size=80),
            GhBlobRef(repo=repo, ref=ref, path="", sha="sha2", size=80),
            GhBlobRef(repo=repo, ref=ref, path="missing-sha.env", sha="", size=80),
        ],
    )

    def fetch_blob_text(repo: str, sha: str) -> str:
        raise AssertionError("malformed hot-path blob candidates must not be fetched")

    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
            "max_files_per_repo": 3,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_hot_path_tree"] == 3
    assert payload["api_search"]["detail_errors"][0]["phase"] == "blob_candidate"
    assert payload["errors"][0]["phase"] == "blob_candidate"
    fallback_attempt = payload["api_search"]["fallback_attempts"][0]
    assert fallback_attempt["returned"] == 3
    assert fallback_attempt["selected"] == 3
    assert fallback_attempt["out_of_scope"] == 1
    assert fallback_attempt["invalid"] == 2
    assert fallback_attempt["skipped"] == 3
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_status_counts"] == {"skipped": 1, "error": 2}
    assert payload["api_search"]["detail_status_by_kind"] == {
        "file": {"skipped": 1, "error": 2},
    }
    assert payload["api_search"]["detail_status_total"] == 3
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_status_counts"] == payload["api_search"]["detail_status_counts"]
    assert evidence["api_search"]["detail_status_by_kind"] == payload["api_search"]["detail_status_by_kind"]
    assert evidence["file_details"] == [
        {
            "repo": "",
            "target_repo": "platform/api",
            "path": "missing-repo.env",
            "ref": "main",
            "sha": "sha1",
            "size": 80,
            "candidate_source": "hot_path_tree",
            "candidate_query": "",
            "status": "skipped",
            "error": "GitHub hot-path blob candidate out of requested repo scope",
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "path": "",
            "ref": "main",
            "sha": "sha2",
            "candidate_source": "hot_path_tree",
            "candidate_query": "",
            "status": "error",
            "error": "GitHub hot-path blob candidate missing path",
        },
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "path": "missing-sha.env",
            "ref": "main",
            "sha": "",
            "candidate_source": "hot_path_tree",
            "candidate_query": "",
            "status": "error",
            "error": "GitHub hot-path blob candidate missing repo, path, sha, or ref",
        },
    ]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_fallback_detail_error_continues_remaining_blobs(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhBlobRef
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("E" * 36)
    blob_fetch_calls: list[str] = []

    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, hot_paths: [
            GhBlobRef(repo=repo, ref=ref, path="broken.env", sha="sha-broken", size=80),
            GhBlobRef(repo=repo, ref=ref, path="live.env", sha="sha-live", size=80),
        ],
    )

    def fetch_blob_text(repo: str, sha: str) -> str:
        blob_fetch_calls.append(sha)
        if sha == "sha-broken":
            raise RuntimeError("blob detail endpoint timeout")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text", fetch_blob_text)
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["password"],
            "max_files_per_repo": 2,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_hot_path_tree"] == 2
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_blob_text"
    assert payload["api_search"]["detail_errors"][0]["path"] == "broken.env"
    assert payload["api_search"]["detail_errors"][0]["candidate_source"] == "hot_path_tree"
    assert payload["api_search"]["detail_errors"][0]["candidate_query"] == ""
    assert payload["api_search"]["detail_error_summary"] == {
        "total": 1,
        "by_phase": {"fetch_blob_text": 1},
        "by_source": {"hot_path_tree": 1},
        "by_query": {"(no query)": 1},
        "by_status_code": {},
    }
    assert payload["errors"][0]["phase"] == "fetch_blob_text"
    assert blob_fetch_calls == ["sha-broken", "sha-live"]
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_error_summary"] == payload["api_search"]["detail_error_summary"]
    assert evidence["file_details"] == [
        {
            "repo": "platform/api",
            "path": "broken.env",
            "ref": "main",
            "sha": "sha-broken",
            "size": 80,
            "candidate_source": "hot_path_tree",
            "candidate_query": "",
            "status": "error",
            "status_code": None,
            "error": "RuntimeError('blob detail endpoint timeout')",
        },
        {
            "repo": "platform/api",
            "path": "live.env",
            "ref": "main",
            "sha": "sha-live",
            "size": 80,
            "candidate_source": "hot_path_tree",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
    ]

    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/live.env"


def test_github_task_scan_fallback_listing_error_still_scans_commits(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("L" * 36)

    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])

    def fail_list_paths_matching(repo: str, ref: str, hot_paths):
        raise RuntimeError("tree API timeout")

    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", fail_list_paths_matching)
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda repo, limit=3, since_sha=None: [
            GhCommitPatch(
                repo=repo,
                sha="c1",
                author="octocat",
                author_email="octocat@samsung.com",
                message="add env token",
                files=[{"filename": "app.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
            ),
        ],
    )

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "code_search_terms": ["password"],
            "max_files_per_repo": 2,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert len(payload["api_search"]["fallback_attempts"]) == 1
    fallback_attempt = payload["api_search"]["fallback_attempts"][0]
    assert fallback_attempt["repo"] == "platform/api"
    assert fallback_attempt["reason"] == "no_api_candidates"
    assert fallback_attempt["returned"] == 0
    assert fallback_attempt["selected"] == 0
    assert fallback_attempt["phase"] == "list_paths_matching"
    assert "tree API timeout" in fallback_attempt["error"]
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
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["errors"][0]["phase"] == "list_paths_matching"
    assert payload["errors"][0]["phase"] == "list_paths_matching"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["fallback_status_counts"] == payload["api_search"]["fallback_status_counts"]
    assert evidence["api_search"]["fallback_reason_counts"] == payload["api_search"]["fallback_reason_counts"]
    assert evidence["api_search"]["fallback_candidate_totals"] == payload["api_search"]["fallback_candidate_totals"]
    assert evidence["commit_details"] == [{
        "repo": "platform/api",
        "sha": "c1",
        "candidate_source": "recent_commit_patches",
        "files": ["app.env"],
        "file_count": 1,
        "scannable_file_count": 1,
        "status": "fetched",
        "content_present": True,
    }]

    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/commit/c1"
    assert rows[0]["asset_kind"] == "commit_patch"


def test_github_task_scan_empty_commit_patch_counts_missing(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda repo, limit=3, since_sha=None: [
            GhCommitPatch(
                repo=repo,
                sha="empty",
                author="octocat",
                author_email="octocat@samsung.com",
                message="metadata only",
                files=[{"filename": "README.md", "patch": ""}],
            ),
        ],
    )

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "code_search_terms": ["password"],
            "max_files_per_repo": 2,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert payload["api_search"]["commit_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_status_counts"] == {"empty": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {"commit": {"empty": 1}}
    assert payload["api_search"]["detail_source_counts"] == {"recent_commit_patches": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "recent_commit_patches": {"empty": 1},
    }
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_status_by_kind"] == payload["api_search"]["detail_status_by_kind"]
    assert evidence["api_search"]["detail_status_by_source"] == payload["api_search"]["detail_status_by_source"]
    assert evidence["commit_details"] == [{
        "repo": "platform/api",
        "sha": "empty",
        "candidate_source": "recent_commit_patches",
        "files": ["README.md"],
        "file_count": 1,
        "scannable_file_count": 0,
        "status": "empty",
        "content_present": False,
        "error": "GitHub commit patch returned no scannable patch content",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_filters_out_of_scope_commit_patch_before_scan(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("R" * 36)
    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda repo, limit=3, since_sha=None: [
            GhCommitPatch(
                repo="other/repo",
                sha="other",
                author="octocat",
                author_email="octocat@samsung.com",
                message="other repo secret",
                files=[{"filename": "app.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
            ),
            GhCommitPatch(
                repo=repo,
                sha="in-scope",
                author="octocat",
                author_email="octocat@samsung.com",
                message="in scope secret",
                files=[{"filename": "app.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
            ),
        ],
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "code_search_terms": ["password"],
            "include_commits": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["commit_count"] == 2
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"recent_commit_patches": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "recent_commit_patches": {"skipped": 1, "fetched": 1},
    }
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["commit_details"] == [
        {
            "repo": "other/repo",
            "target_repo": "platform/api",
            "sha": "other",
            "candidate_source": "recent_commit_patches",
            "status": "skipped",
            "error": "GitHub commit patch candidate out of requested repo scope",
        },
        {
            "repo": "platform/api",
            "sha": "in-scope",
            "candidate_source": "recent_commit_patches",
            "files": ["app.env"],
            "file_count": 1,
            "scannable_file_count": 1,
            "status": "fetched",
            "content_present": True,
        },
    ]
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/commit/in-scope"
    assert rows[0]["asset_kind"] == "commit_patch"


def test_github_task_scan_empty_commit_sha_is_error_and_does_not_advance_cursor(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from service import state_domain
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("M" * 36)
    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda repo, limit=3, since_sha=None: [
            GhCommitPatch(
                repo=repo,
                sha="",
                author="octocat",
                author_email="octocat@samsung.com",
                message="missing sha",
                files=[{"filename": "app.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
            ),
            GhCommitPatch(
                repo="",
                sha="missingrepo",
                author="octocat",
                author_email="octocat@samsung.com",
                message="missing repo",
                files=[{"filename": "app.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
            ),
        ],
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "code_search_terms": ["GITHUB_TOKEN"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "recent_commit_patch_candidate"
    assert payload["errors"][0]["phase"] == "recent_commit_patch_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["commit_details"] == [
        {
            "repo": "platform/api",
            "target_repo": "platform/api",
            "sha": "",
            "candidate_source": "recent_commit_patches",
            "status": "error",
            "error": "commit patch candidate missing sha",
        },
        {
            "repo": "",
            "target_repo": "platform/api",
            "sha": "missingrepo",
            "candidate_source": "recent_commit_patches",
            "status": "skipped",
            "error": "GitHub commit patch candidate out of requested repo scope",
        },
    ]
    assert state_domain.github_repo_get_scanned_sha("platform/api") is None
    assert _scanned(res, limit=10) == []


def test_github_task_scan_invalid_commit_file_path_is_error_and_does_not_advance_cursor(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from service import state_domain
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("P" * 36)
    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda repo, limit=3, since_sha=None: [
            GhCommitPatch(
                repo=repo,
                sha="badpath",
                author="octocat",
                author_email="octocat@samsung.com",
                message="bad path",
                files=[{"filename": "../app.env", "patch": f"+GITHUB_TOKEN={token}\n"}],
            ),
        ],
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "code_search_terms": ["GITHUB_TOKEN"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "recent_commit_patch_candidate"
    assert payload["api_search"]["errors"][0]["path"] == "../app.env"
    assert "invalid path" in payload["api_search"]["errors"][0]["error"]
    assert payload["errors"][0]["phase"] == "recent_commit_patch_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["commit_details"] == [{
        "repo": "platform/api",
        "sha": "badpath",
        "candidate_source": "recent_commit_patches",
        "files": ["../app.env"],
        "file_count": 1,
        "scannable_file_count": 0,
        "status": "error",
        "file_error_count": 1,
        "content_present": False,
        "error": "one or more commit patch file candidates invalid",
    }]
    assert state_domain.github_repo_get_scanned_sha("platform/api") is None
    assert _scanned(res, limit=10) == []


def test_github_task_scan_api_detail_missing_is_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda query, per_page=50, max_results=50: [
            service_task_tools.gh.GhCodeHit(repo="platform/api", path="gone.env"),
        ],
    )
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run for missing API detail"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["filename:.env"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "path": "gone.env",
        "ref": "main",
        "candidate_source": "code_search",
        "candidate_query": "repo:platform/api filename:.env",
        "status": "missing",
        "content_present": False,
        "error": "GitHub code-search file detail returned no content",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_api_blank_detail_counts_missing(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda query, per_page=50, max_results=50: [
            service_task_tools.gh.GhCodeHit(repo="platform/api", path="blank.env"),
        ],
    )
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", lambda *args, **kwargs: "\n\t ")
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run for blank API detail"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["filename:.env"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert _scanned(res, limit=10) == []


def test_github_task_scan_api_search_error_does_not_fallback_or_mark_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    class SearchFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    def fail_search(query: str, per_page: int = 50, max_results: int = 50):
        raise SearchFailure("search backend returned malformed response")

    monkeypatch.setattr(service_task_tools.gh, "code_search", fail_search)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run after code search error"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["AKIA"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["errors"][0]["phase"] == "code_search"
    assert payload["errors"][0]["status_code"] == 503
    assert payload["api_search"]["errors"][0]["phase"] == "code_search"
    assert payload["api_search"]["errors"][0]["status_code"] == 503
    assert payload["api_search"]["query_details"][0]["repo"] == "platform/api"
    assert payload["api_search"]["query_details"][0]["query"] == "repo:platform/api AKIA"
    assert payload["api_search"]["query_details"][0]["status"] == "error"
    assert payload["api_search"]["query_details"][0]["phase"] == "code_search"
    assert payload["api_search"]["query_details"][0]["status_code"] == 503
    assert "malformed response" in payload["api_search"]["query_details"][0]["error"]
    assert payload["api_search"]["query_status_counts"] == {"error": 1}
    assert payload["api_search"]["query_candidate_totals"] == {
        "returned": 0,
        "added": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }
    assert _scanned(res, limit=10) == []


def test_github_task_scan_empty_code_search_path_is_error(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda query, per_page=50, max_results=50: [
            service_task_tools.gh.GhCodeHit(repo="platform/api", path=""),
        ],
    )
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["filename:.env"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "code_search_candidate"
    assert payload["errors"][0]["phase"] == "code_search_candidate"
    assert payload["api_search"]["query_details"][0]["returned"] == 1
    assert payload["api_search"]["query_details"][0]["added"] == 0
    assert payload["api_search"]["query_details"][0]["invalid"] == 1
    assert payload["api_search"]["query_details"][0]["skipped"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "path": "",
        "candidate_source": "code_search",
        "candidate_query": "repo:platform/api filename:.env",
        "status": "error",
        "error": "code search candidate missing path",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_invalid_code_search_path_is_error(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda query, per_page=50, max_results=50: [
            service_task_tools.gh.GhCodeHit(repo="platform/api", path="../.env"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_file_at_ref",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must not run for invalid code-search paths"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["filename:.env"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "code_search_candidate"
    assert payload["api_search"]["errors"][0]["path"] == "../.env"
    assert "invalid path" in payload["api_search"]["errors"][0]["error"]
    assert payload["errors"][0]["phase"] == "code_search_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "path": "../.env",
        "candidate_source": "code_search",
        "candidate_query": "repo:platform/api filename:.env",
        "status": "error",
        "error": "code search candidate invalid path",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_empty_code_search_repo_is_error(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda query, per_page=50, max_results=50: [
            service_task_tools.gh.GhCodeHit(repo="", path=".env"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_file_at_ref",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("detail fetch must not run for malformed code-search candidates"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["filename:.env"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "code_search_candidate"
    assert "missing repo" in payload["api_search"]["errors"][0]["error"]
    assert payload["errors"][0]["phase"] == "code_search_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "",
        "target_repo": "platform/api",
        "path": ".env",
        "candidate_source": "code_search",
        "candidate_query": "repo:platform/api filename:.env",
        "status": "error",
        "error": "code search candidate missing repo",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_api_detail_error_does_not_fallback_or_mark_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    import httpx

    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda query, per_page=50, max_results=50: [
            service_task_tools.gh.GhCodeHit(repo="platform/api", path=".env"),
        ],
    )

    def fail_fetch(repo: str, path: str, *, ref: str = "HEAD", max_bytes: int = 512 * 1024):
        request = httpx.Request("GET", f"https://gh.test/api/v3/repos/{repo}/contents/{path}")
        response = httpx.Response(503, request=request, json={"message": "Unavailable"})
        raise httpx.HTTPStatusError(
            "503 Service Unavailable",
            request=request,
            response=response,
        )

    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref", fail_fetch)
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run after API detail error"),
        ),
    )
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "include_commits": False,
            "code_search_terms": ["AKIA"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["candidate_count"] == 1
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_file_at_ref"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["detail_errors"][0]["candidate_source"] == "code_search"
    assert payload["api_search"]["detail_errors"][0]["candidate_query"] == "repo:platform/api AKIA"
    assert payload["api_search"]["detail_error_summary"] == {
        "total": 1,
        "by_phase": {"fetch_file_at_ref": 1},
        "by_source": {"code_search": 1},
        "by_query": {"repo:platform/api AKIA": 1},
        "by_status_code": {"503": 1},
    }
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["errors"][0]["phase"] == "fetch_file_at_ref"
    assert payload["errors"][0]["status_code"] == 503
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["detail_error_summary"] == payload["api_search"]["detail_error_summary"]
    assert evidence["file_details"] == [{
        "repo": "platform/api",
        "path": ".env",
        "ref": "main",
        "candidate_source": "code_search",
        "candidate_query": "repo:platform/api AKIA",
        "status": "error",
        "status_code": 503,
        "error": "HTTPStatusError('503 Service Unavailable')",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_repo_detail_processing_error_is_structured(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("Q" * 36)

    class BrokenBlob:
        repo = "platform/api"
        ref = "main"
        path = ".env"
        sha = "abc"

        @property
        def size(self):
            raise RuntimeError("blob size metadata corrupt")

    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda repo, ref, hot_paths: [BrokenBlob()],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_blob_text",
        lambda repo, sha: f"GITHUB_TOKEN={token}\n",
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: [],
    )

    res = _run(
        GithubTaskScanTool(),
        {
            "repos": ["platform/api"],
            "ref": "main",
            "api_search_first": False,
            "include_commits": False,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["detail_errors"][0]["phase"] == "repo_detail"
    assert payload["api_search"]["detail_errors"][0]["target"] == "platform/api"
    assert payload["api_search"]["detail_errors"][0]["ref"] == "main"
    assert payload["errors"][0]["phase"] == "repo_detail"
    assert _scanned(res, limit=10) == []


def test_github_task_scan_commit_patch_error_is_structured_partial(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    import httpx

    from secu_agent import state
    from service import state_domain
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("K" * 36)
    monkeypatch.setattr(
        service_task_tools.gh,
        "code_search",
        lambda query, per_page=50, max_results=50: [
            service_task_tools.gh.GhCodeHit(repo="platform/api", path=".env"),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_file_at_ref",
        lambda repo, path, *, ref="HEAD", max_bytes=512 * 1024: f"GITHUB_TOKEN={token}\n",
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("hot-path fallback must not run when API detail succeeds"),
        ),
    )

    def fail_recent_commit_patches(repo: str, *, limit: int = 3, since_sha=None):
        request = httpx.Request("GET", f"https://gh.test/api/v3/repos/{repo}/commits")
        response = httpx.Response(503, request=request, json={"message": "Unavailable"})
        raise httpx.HTTPStatusError(
            "503 Service Unavailable",
            request=request,
            response=response,
        )

    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", fail_recent_commit_patches)

    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "code_search_terms": ["AKIA"],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "partial"
    assert payload["recommended_target_status"] == "tasked"
    assert payload["errors"][0]["phase"] == "recent_commit_patches"
    assert payload["errors"][0]["since_sha"] is None
    assert payload["errors"][0]["status_code"] == 503
    assert payload["api_search"]["detail_errors"][0]["phase"] == "recent_commit_patches"
    assert payload["api_search"]["detail_errors"][0]["since_sha"] is None
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["commit_details"] == [{
        "repo": "platform/api",
        "sha": "",
        "candidate_source": "recent_commit_patches",
        "since_sha": None,
        "status": "error",
        "status_code": 503,
        "error": "HTTPStatusError('503 Service Unavailable')",
    }]
    assert state_domain.github_repo_get_scanned_sha("platform/api") is None
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/.env"


def test_github_task_scan_commit_patch_secret_gone_in_head_is_historical(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from service import state_domain
    from domains.services.github.plugin.agent_types.github import GhCommitPatch
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    token = "ghp_" + ("S" * 36)
    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.gh,
        "recent_commit_patches",
        lambda repo, limit=3, since_sha=None: [
            GhCommitPatch(
                repo=repo,
                sha="stale-secret",
                author="octocat",
                author_email="octocat@samsung.com",
                message="remove secret from head",
                files=[{
                    "filename": "settings.env",
                    "patch": f"+GITHUB_TOKEN={token}\n-cleaned later\n",
                }],
            ),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.gh,
        "fetch_file_at_ref",
        lambda repo, path, ref="HEAD": "GITHUB_TOKEN removed from current head\n",
    )

    metadata: dict = {}
    res = _run(
        GithubTaskScanTool(),
        {
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
            "repos": ["platform/api"],
            "ref": "main",
            "code_search_terms": ["GITHUB_TOKEN"],
        },
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["scan_status"] == "ok"
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["detail_fetched"] == 1
    # ★ 커서는 **여기서 전진하지 않는다** (2026-08-27). 이 도구는 후보만 돌려주고
    #   등록은 에이전트가 하므로, 스캔 시점 전진은 "제출이 거부돼도 그 커밋을 다시
    #   안 본다" 를 뜻했다 — 실제로 진짜 시크릿 하나가 그렇게 사라질 뻔했다.
    #   종료 도구(`github_repo_set_status`)가 target 을 닫을 때 전진시킨다.
    assert state_domain.github_repo_get_scanned_sha("platform/api") is None
    assert metadata["_github_pending_scanned_sha"] == {"platform/api": "stale-secret"}
    rows = _scanned(res, limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "github:platform/api/commit/stale-secret"
    assert rows[0]["verification"]["status"] == "historical_only"
    assert rows[0]["verification"]["files"] == [
        {"path": "settings.env", "status": "historical_only"},
    ]


def test_github_task_scan_drops_email_only_finding(tmp_db, tmp_path, monkeypatch):
    """v3.78 F1: 이메일-only(식별자 PII) 노이즈는 finding 생성 안 됨."""
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhRepo

    monkeypatch.setattr(service_task_tools.gh, "list_repos", lambda org, limit=20: [
        GhRepo(full_name="platform/docs", default_branch="main", private=True,
               archived=False, pushed_at="2026-05-24T00:00:00Z"),
    ])
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching",
                        lambda repo, ref, hot_paths: [
                            GhBlobRef(repo=repo, ref=ref, path="AUTHORS", sha="e1", size=60)])
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text",
                        lambda repo, sha: "Maintainer: hong.gildong@samsung.com\n"
                                          "Contact: jane.doe@samsung.com\n")
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches", lambda repo, limit=3, since_sha=None: [])

    res = _run(GithubTaskScanTool(), {"org": "platform"}, tmp_path, {})
    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert _scanned(res, limit=10) == []


def test_github_task_scan_attaches_head_verification(tmp_db, tmp_path, monkeypatch):
    """v3.78 G2: github secret finding 에 HEAD 재확인 verification(live_in_HEAD) 부착."""
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from domains.services.github.plugin.agent_types.github import GhBlobRef, GhRepo

    token = "ghp_" + ("C" * 36)
    monkeypatch.setattr(service_task_tools.gh, "list_repos", lambda org, limit=20: [
        GhRepo(full_name="platform/api", default_branch="main", private=True,
               archived=False, pushed_at="2026-05-24T00:00:00Z"),
    ])
    monkeypatch.setattr(service_task_tools.gh, "list_paths_matching",
                        lambda repo, ref, hot_paths: [
                            GhBlobRef(repo=repo, ref=ref, path=".env", sha="abc", size=80)])
    monkeypatch.setattr(service_task_tools.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.gh, "fetch_blob_text",
                        lambda repo, sha: f"GITHUB_TOKEN={token}\n")
    monkeypatch.setattr(service_task_tools.gh, "recent_commit_patches",
                        lambda repo, limit=3, since_sha=None: [])
    # HEAD 에도 같은 토큰 → live_in_HEAD
    monkeypatch.setattr(service_task_tools.gh, "fetch_file_at_ref",
                        lambda repo, path, ref="HEAD": f"GITHUB_TOKEN={token}\n")

    res = _run(GithubTaskScanTool(), {"org": "platform"}, tmp_path, {})
    assert isinstance(res, ToolSuccess)
    # ★ 스캔은 이제 **등록하지 않는다** — 후보만 돌려준다(2026-08-27, LLM 판정 필수).
    #   그래도 verification 은 후보에 실려야 한다: "지금도 HEAD 에 살아 있나" 는
    #   에이전트가 제출/기각을 가르는 바로 그 신호라, 빼면 판단 재료를 뺏는 꼴이다.
    assert state.finding_list(task_type="github", limit=10) == [], "스캔이 등록했다"
    row = json.loads(res.content)["findings"][0]
    assert row["verification"]["status"] == "live_in_HEAD"
    assert row["verification"]["method"] == "api_head_recheck"
    # ⚠️ 후보에는 `agent_verification: verified` 를 붙이지 않는다. 아직 아무도 확인하지
    #    않았는데 "검증됨" 이라고 적으면 그 자체가 거짓이고, 제출 판단의 재료를 오염시킨다.
    #    그 도장은 에이전트가 `github_submit_finding` 을 부를 때 찍힌다.
    assert "agent_verification" not in row, "후보가 스스로를 검증됐다고 말한다"
    assert row["registered"] is False and row["status"] == "candidate"


def test_scan_artifacts_suppresses_author_email_keeps_secret(tmp_path):
    """v3.78 F1: metadata.suppress_emails 의 이메일 hit 은 드랍, secret 은 유지."""
    from domains.services.plugin.tools.service_task_tools import _Artifact, _scan_artifacts

    art = _Artifact(
        task_type="github",
        asset="github:o/r/commit/s1",
        asset_kind="commit_patch",
        label="gh://o/r/commit/s1",
        text='+ author: octo@samsung.com\n+ password = "Tr0ub4dor3xKpzQ"\n',
        metadata={"suppress_emails": ["octo@samsung.com"]},
    )
    scanned = _scan_artifacts([art])
    assert scanned, "secret 동반이므로 artifact 는 남아야"
    pairs = {(h["category"], h["kind"]) for h in scanned[0].hits}
    assert ("pii", "email") not in pairs        # author email 억제
    assert any(cat == "secret" for cat, _ in pairs)  # secret 유지


def test_confluence_task_scan_scans_pages_and_text_attachments(tmp_db, tmp_path, monkeypatch):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment, CfPage

    api_key = "AIza" + ("A" * 35)
    monkeypatch.setattr(
        service_task_tools.cf,
        "cql_search",
        lambda cql, limit=100: [
            CfPage(
                id="123",
                title="Legacy VPN Access",
                space_key="SEC",
                version=7,
                url="/display/SEC/Legacy+VPN+Access",
            ),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CQL candidate path should avoid full page listing"),
        ),
    )
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", lambda page_id: "no secret here")
    monkeypatch.setattr(service_task_tools.cf, "list_comments", lambda *args, **kwargs: [])
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="att-1",
                filename="vpn.env",
                media_type="text/plain",
                size=100,
                download_url="/download/att-1",
                parent_page_id=page_id,
            ),
        ],
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_attachment_text",
        lambda download_path: f"GOOGLE_API_KEY={api_key}\n",
    )

    metadata: dict = {}
    res = _run(
        ConfluenceTaskScanTool(),
        {"space_keys": ["SEC"]},
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["finding_count"] == 1
    assert payload["findings"][0]["asset_kind"] == "attachment"

    rows = state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    # v3.76: space_key 있으면 asset 에 SPACE prefix (교차확인 식별자=space).
    assert rows[0]["asset"] == "confluence:SEC:123/attachment/vpn.env"
    assert rows[0]["extra"]["hits"][0]["kind"] == "google_api_key"
    assert metadata["finding_signals"][0]["report_updated"] is True


def test_confluence_task_scan_comments_audit_candidates_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    api_key = "AIza" + ("C" * 35)

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded comment scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body",
        lambda page_id: "clean page\n",
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_comments",
        lambda page_id: [
            "first clean comment",
            "second clean comment",
            f"GOOGLE_API_KEY={api_key}",
        ],
    )

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "page_ids": ["5555"],
            "scan_comments": True,
            "max_comments_per_page": 2,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["detail_fetched"] == 3
    assert payload["api_search"]["detail_source_counts"] == {"explicit_page": 4}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_page": {"fetched": 3, "skipped": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == [{
        "page_id": "5555",
        "space_key": "",
        "title": "5555",
        "url": "",
        "version": 0,
        "candidate_source": "explicit_page",
        "candidate_query": "",
        "scan_method": "api_page_detail_scan",
        "status": "fetched",
        "body_present": True,
    }]
    assert evidence["comment_details"] == [
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "comment_index": 0,
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "comment_index": 1,
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "comment_index": 2,
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "status": "skipped",
            "error": (
                "Confluence comment candidate beyond "
                "max_comments_per_page"
            ),
        },
    ]


def test_confluence_task_scan_dedupes_space_targets_with_skipped_evidence(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    api_key = "AIza" + ("S" * 35)
    list_page_calls: list[tuple[str, int]] = []
    page_body_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("space-list duplicate scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def list_pages(space_key: str, limit: int = 50):
        list_page_calls.append((space_key, limit))
        return [
            CfPage(
                id="123",
                title="Legacy VPN Access",
                space_key="SEC",
                version=7,
                url="/display/SEC/Legacy+VPN+Access",
            ),
        ]

    monkeypatch.setattr(service_task_tools.cf, "list_pages", list_pages)

    def fetch_page_body(page_id: str) -> str:
        page_body_calls.append(page_id)
        return f"GOOGLE_API_KEY={api_key}\n"

    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", fetch_page_body)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "space_keys": ["SEC", " sec "],
            "include_pages": True,
            "page_limit_per_space": 2,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["space_duplicate_count"] == 1
    assert payload["api_search"]["page_list_count"] == 1
    assert payload["api_search"]["page_list_attempts"] == [{
        "space_key": "SEC",
        "source": "space_page_list",
        "reason": "explicit_page_list",
        "returned": 1,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["target_status_counts"] == {"skipped": 1, "selected": 1}
    assert payload["api_search"]["target_source_counts"] == {
        "space_keys[1]": 1,
        "space_page_list": 1,
    }
    assert payload["api_search"]["target_status_by_source"] == {
        "space_keys[1]": {"skipped": 1},
        "space_page_list": {"selected": 1},
    }
    assert list_page_calls == [("SEC", 2)]
    assert page_body_calls == ["123"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [
        {
            "space_key": "sec",
            "source": "space_keys[1]",
            "status": "skipped",
            "error": "duplicate space candidate",
        },
        {
            "id": "123",
            "space_key": "SEC",
            "title": "Legacy VPN Access",
            "candidate_source": "space_page_list",
            "candidate_query": "",
        },
    ]
    rows = state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "confluence:SEC:123"


def test_confluence_task_scan_explicit_page_list_empty_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    list_page_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("empty page-list scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def list_pages(space_key: str, limit: int = 50):
        list_page_calls.append((space_key, limit))
        return []

    monkeypatch.setattr(service_task_tools.cf, "list_pages", list_pages)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "space_keys": ["SEC"],
            "include_pages": True,
            "page_limit_per_space": 2,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 0
    assert payload["pages"] == []
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "no selected targets" in payload["status_reason"]
    assert payload["errors"] == []
    assert payload["api_search"]["list_no_candidates"] == 1
    assert payload["api_search"]["page_list_count"] == 0
    assert payload["api_search"]["page_list_attempts"] == [{
        "space_key": "SEC",
        "source": "space_page_list",
        "reason": "explicit_page_list",
        "returned": 0,
        "added": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
        "no_candidates": 1,
    }]
    assert payload["api_search"]["target_status_counts"] == {"skipped": 1}
    assert payload["api_search"]["target_source_counts"] == {"space_page_list": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "space_page_list": {"skipped": 1},
    }
    assert list_page_calls == [("SEC", 2)]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "space_key": "SEC",
        "source": "space_page_list",
        "fallback_reason": "",
        "status": "skipped",
        "phase": "list_pages",
        "error": "Confluence page list returned no candidates",
    }]
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["api_search"]["list_no_candidates"] == 1
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_explicit_blogpost_list_empty_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    list_blogpost_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("empty blogpost-list scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def list_blogposts(space_key: str, limit: int = 50):
        list_blogpost_calls.append((space_key, limit))
        return []

    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", list_blogposts)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "space_keys": ["SEC"],
            "include_blogposts": True,
            "page_limit_per_space": 2,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 0
    assert payload["pages"] == []
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "no selected targets" in payload["status_reason"]
    assert payload["errors"] == []
    assert payload["api_search"]["list_no_candidates"] == 1
    assert payload["api_search"]["blogpost_list_count"] == 0
    assert payload["api_search"]["blogpost_list_attempts"] == [{
        "space_key": "SEC",
        "source": "space_blogpost_list",
        "reason": "explicit_blogpost_list",
        "returned": 0,
        "added": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
        "no_candidates": 1,
    }]
    assert payload["api_search"]["target_status_counts"] == {"skipped": 1}
    assert payload["api_search"]["target_source_counts"] == {"space_blogpost_list": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "space_blogpost_list": {"skipped": 1},
    }
    assert list_blogpost_calls == [("SEC", 2)]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "space_key": "SEC",
        "source": "space_blogpost_list",
        "fallback_reason": "",
        "status": "skipped",
        "phase": "list_blogposts",
        "error": "Confluence blogpost list returned no candidates",
    }]
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["api_search"]["list_no_candidates"] == 1
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_blank_explicit_page_is_error_without_broadening(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("blank explicit Confluence page must not call APIs")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    metadata: dict = {}
    res = _run(
        ConfluenceTaskScanTool(),
        {"page_ids": ["   "]},
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 0
    assert payload["pages"] == []
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["status_reason"] == "Confluence page candidate missing id"
    assert payload["errors"] == [{
        "target": "explicit_page",
        "phase": "page_candidate",
        "source": "explicit_page",
        "candidate_source": "explicit_page",
        "candidate_query": "",
        "query": "",
        "page_id": "",
        "error": "Confluence page candidate missing id",
    }]
    assert payload["api_search"]["detail_error_summary"] == {
        "total": 1,
        "by_phase": {"page_candidate": 1},
        "by_source": {"explicit_page": 1},
        "by_query": {"(no query)": 1},
        "by_status_code": {},
    }
    assert payload["api_search"]["target_status_counts"] == {"error": 1}
    assert payload["api_search"]["target_source_counts"] == {"explicit_page": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "explicit_page": {"error": 1},
    }
    assert metadata["_confluence_task_scan_status"] == "error"
    assert metadata["_confluence_task_scan_recommended_status"] == "error"
    assert not metadata.get("finding_signals")

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "page_id": "",
        "space_key": "",
        "title": "explicit_page",
        "candidate_source": "explicit_page",
        "candidate_query": "",
        "status": "error",
        "error": "Confluence page candidate missing id",
    }]
    assert evidence["page_details"] == [{
        "page_id": "",
        "space_key": "",
        "title": "explicit_page",
        "url": "",
        "version": 0,
        "candidate_source": "explicit_page",
        "candidate_query": "",
        "scan_method": "api_page_detail_scan",
        "status": "error",
        "error": "Confluence page candidate missing id",
    }]
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_cql_empty_result_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    cql = 'text ~ "rotated-secret"'
    cql_calls: list[tuple[str, int]] = []

    def cql_search(query: str, limit: int = 100):
        cql_calls.append((query, limit))
        return []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("empty CQL scan must not fetch details")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", cql_search)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    metadata: dict = {}
    res = _run(
        ConfluenceTaskScanTool(),
        {"cql": cql},
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert cql_calls == [(cql, 25)]
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 0
    assert payload["pages"] == []
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "no selected targets" in payload["status_reason"]
    assert payload["errors"] == []
    assert payload["api_search"]["query_count"] == 1
    assert payload["api_search"]["queries"] == [cql]
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["list_no_candidates"] == 1
    assert payload["api_search"]["query_details"] == [{
        "query": cql,
        "source": "explicit_cql",
        "space_key": "",
        "status": "searched",
        "returned": 0,
        "added": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 0,
        "no_candidates": 1,
    }]
    assert payload["api_search"]["target_status_counts"] == {"skipped": 1}
    assert payload["api_search"]["target_source_counts"] == {"explicit_cql": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "explicit_cql": {"skipped": 1},
    }
    assert payload["api_search"]["query_status_counts"] == {"searched": 1}
    assert metadata["_confluence_task_scan_status"] == "skipped"
    assert metadata["_confluence_task_scan_recommended_status"] == "skipped"
    assert "no selected targets" in metadata["_confluence_task_scan_status_reason"]
    assert not metadata.get("finding_signals")

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["targets"] == []
    assert evidence["target_details"] == [{
        "target": f"cql:{cql}",
        "source": "explicit_cql",
        "candidate_query": cql,
        "status": "skipped",
        "phase": "cql_search",
        "error": "Confluence CQL search returned no candidates",
    }]
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["api_search"]["list_no_candidates"] == 1
    assert evidence["api_search"]["query_details"] == payload["api_search"]["query_details"]
    assert evidence["scan_status"] == payload["scan_status"]
    assert evidence["recommended_target_status"] == payload["recommended_target_status"]
    assert evidence["status_reason"] == payload["status_reason"]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_cql_malformed_page_is_error_without_detail_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    cql = 'text ~ "secret"'
    cql_calls: list[tuple[str, int]] = []

    def cql_search(query: str, limit: int = 100):
        cql_calls.append((query, limit))
        return [
            CfPage(
                id="",
                title="Broken Result",
                space_key="SEC",
                version=7,
                url="/display/SEC/Broken",
            ),
        ]

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("malformed CQL page candidate must not detail-fetch")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", cql_search)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    metadata: dict = {}
    res = _run(
        ConfluenceTaskScanTool(),
        {"cql": cql},
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert cql_calls == [(cql, 25)]
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 0
    assert payload["pages"] == []
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["status_reason"] == "Confluence page candidate missing id"
    assert payload["errors"] == [{
        "target": "Broken Result",
        "phase": "cql_candidate",
        "source": "explicit_cql",
        "candidate_source": "explicit_cql",
        "candidate_query": cql,
        "query": cql,
        "page_id": "",
        "error": "Confluence page candidate missing id",
    }]
    assert payload["api_search"]["query_details"] == [{
        "query": cql,
        "source": "explicit_cql",
        "space_key": "",
        "status": "searched",
        "returned": 1,
        "added": 0,
        "invalid": 1,
        "out_of_scope": 0,
        "duplicate": 0,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_error_summary"] == {
        "total": 1,
        "by_phase": {"cql_candidate": 1},
        "by_source": {"explicit_cql": 1},
        "by_query": {cql: 1},
        "by_status_code": {},
    }
    assert payload["api_search"]["target_status_counts"] == {"error": 1}
    assert payload["api_search"]["target_source_counts"] == {"explicit_cql": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "explicit_cql": {"error": 1},
    }
    assert metadata["_confluence_task_scan_status"] == "error"
    assert metadata["_confluence_task_scan_recommended_status"] == "error"
    assert not metadata.get("finding_signals")

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "page_id": "",
        "space_key": "SEC",
        "title": "Broken Result",
        "candidate_source": "explicit_cql",
        "candidate_query": cql,
        "status": "error",
        "error": "Confluence page candidate missing id",
    }]
    assert evidence["page_details"] == [{
        "page_id": "",
        "space_key": "SEC",
        "title": "Broken Result",
        "url": "/display/SEC/Broken",
        "version": 7,
        "candidate_source": "explicit_cql",
        "candidate_query": cql,
        "scan_method": "api_cql_search_detail_scan",
        "status": "error",
        "error": "Confluence page candidate missing id",
    }]
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_all_spaces_dedupes_with_skipped_evidence(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.confluence.plugin.agent_types.confluence import CfPage, CfSpace
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    api_key = "AIza" + ("A" * 35)
    list_space_calls: list[dict] = []
    list_page_calls: list[tuple[str, int]] = []
    page_body_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("all-spaces duplicate scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def list_spaces(**kwargs):
        list_space_calls.append(dict(kwargs))
        return [
            CfSpace(key="SEC", name="Security", type="global", url="/s"),
            CfSpace(key=" sec ", name="Security duplicate", type="global", url="/s2"),
        ]

    monkeypatch.setattr(service_task_tools.cf, "list_spaces", list_spaces)

    def list_pages(space_key: str, limit: int = 50):
        list_page_calls.append((space_key, limit))
        return [
            CfPage(
                id="123",
                title="Legacy VPN Access",
                space_key="SEC",
                version=7,
                url="/display/SEC/Legacy+VPN+Access",
            ),
        ]

    monkeypatch.setattr(service_task_tools.cf, "list_pages", list_pages)

    def fetch_page_body(page_id: str) -> str:
        page_body_calls.append(page_id)
        return f"GOOGLE_API_KEY={api_key}\n"

    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", fetch_page_body)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "all_spaces": True,
            "include_pages": True,
            "page_limit_per_space": 2,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["space_duplicate_count"] == 1
    assert payload["api_search"]["page_list_count"] == 1
    assert payload["api_search"]["target_status_counts"] == {"skipped": 1, "selected": 1}
    assert payload["api_search"]["target_source_counts"] == {
        "list_spaces": 1,
        "space_page_list": 1,
    }
    assert payload["api_search"]["target_status_by_source"] == {
        "list_spaces": {"skipped": 1},
        "space_page_list": {"selected": 1},
    }
    assert list_space_calls == [{}]
    assert list_page_calls == [("SEC", 2)]
    assert page_body_calls == ["123"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [
        {
            "space_key": "sec",
            "source": "list_spaces",
            "status": "skipped",
            "error": "duplicate space candidate",
        },
        {
            "id": "123",
            "space_key": "SEC",
            "title": "Legacy VPN Access",
            "candidate_source": "space_page_list",
            "candidate_query": "",
        },
    ]
    rows = state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "confluence:SEC:123"


def test_confluence_task_scan_empty_all_spaces_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    list_space_calls: list[dict] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("empty all-spaces scan must not fetch details")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def list_spaces(**kwargs):
        list_space_calls.append(dict(kwargs))
        return []

    monkeypatch.setattr(service_task_tools.cf, "list_spaces", list_spaces)

    metadata: dict = {}
    res = _run(
        ConfluenceTaskScanTool(),
        {
            "all_spaces": True,
            "include_pages": True,
            "page_limit_per_space": 2,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 0
    assert payload["spaces"] == []
    assert payload["pages"] == []
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "no selected targets" in payload["status_reason"]
    assert payload["errors"] == []
    assert payload["api_search"]["list_no_candidates"] == 1
    assert payload["api_search"]["space_list_attempts"] == [{
        "source": "list_spaces",
        "returned": 0,
        "selected": 0,
        "duplicate": 0,
        "skipped": 0,
        "no_candidates": 1,
    }]
    assert payload["api_search"]["target_status_counts"] == {"skipped": 1}
    assert payload["api_search"]["target_source_counts"] == {"list_spaces": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "list_spaces": {"skipped": 1},
    }
    assert list_space_calls == [{}]
    assert metadata["_confluence_task_scan_status"] == "skipped"
    assert metadata["_confluence_task_scan_recommended_status"] == "skipped"
    assert "no selected targets" in metadata["_confluence_task_scan_status_reason"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["targets"] == []
    assert evidence["target_details"] == [{
        "space_key": "",
        "target": "all_spaces",
        "source": "list_spaces",
        "status": "skipped",
        "phase": "list_spaces",
        "error": "Confluence space list returned no candidates",
    }]
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["api_search"]["list_no_candidates"] == 1
    assert evidence["api_search"]["space_list_attempts"] == (
        payload["api_search"]["space_list_attempts"]
    )
    assert evidence["scan_status"] == payload["scan_status"]
    assert evidence["recommended_target_status"] == payload["recommended_target_status"]
    assert evidence["status_reason"] == payload["status_reason"]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_all_spaces_malformed_space_is_error(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.confluence.plugin.agent_types.confluence import CfSpace
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    list_space_calls: list[dict] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("malformed all-spaces candidate must not fetch details")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def list_spaces(**kwargs):
        list_space_calls.append(dict(kwargs))
        return [CfSpace(key="", name="Broken", type="global", url="/spaces/broken")]

    monkeypatch.setattr(service_task_tools.cf, "list_spaces", list_spaces)

    metadata: dict = {}
    res = _run(
        ConfluenceTaskScanTool(),
        {
            "all_spaces": True,
            "include_pages": True,
            "page_limit_per_space": 2,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        metadata,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 0
    assert payload["spaces"] == []
    assert payload["pages"] == []
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["status_reason"] == "Confluence space candidate missing space_key"
    assert payload["errors"] == [{
        "target": "list_spaces",
        "phase": "space_candidate",
        "source": "list_spaces",
        "error": "Confluence space candidate missing space_key",
    }]
    assert payload["api_search"]["space_list_attempts"] == [{
        "source": "list_spaces",
        "returned": 1,
        "selected": 0,
        "duplicate": 0,
        "skipped": 1,
        "invalid": 1,
    }]
    assert payload["api_search"]["target_status_counts"] == {"error": 1}
    assert payload["api_search"]["target_source_counts"] == {"list_spaces": 1}
    assert payload["api_search"]["target_status_by_source"] == {
        "list_spaces": {"error": 1},
    }
    assert payload["api_search"]["detail_error_summary"] == {
        "total": 0,
        "by_phase": {},
        "by_source": {},
        "by_query": {},
        "by_status_code": {},
    }
    assert list_space_calls == [{}]
    assert metadata["_confluence_task_scan_status"] == "error"
    assert metadata["_confluence_task_scan_recommended_status"] == "error"
    assert not metadata.get("finding_signals")

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["errors"] == payload["errors"]
    assert evidence["targets"] == []
    assert evidence["target_details"] == [{
        "space_key": "",
        "source": "list_spaces",
        "status": "error",
        "phase": "space_candidate",
        "error": "Confluence space candidate missing space_key",
    }]
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["api_search"]["space_list_attempts"] == (
        payload["api_search"]["space_list_attempts"]
    )
    assert evidence["scan_status"] == payload["scan_status"]
    assert evidence["recommended_target_status"] == payload["recommended_target_status"]
    assert evidence["status_reason"] == payload["status_reason"]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_cql_duplicate_page_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    cql = 'text ~ "secret"'
    api_key = "AIza" + ("D" * 35)
    cql_calls: list[tuple[str, int]] = []
    page_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("CQL duplicate page scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def cql_search(query: str, limit: int = 100):
        cql_calls.append((query, limit))
        return [
            CfPage(
                id="123",
                title="Legacy VPN Access",
                space_key="SEC",
                version=7,
                url="/display/SEC/Legacy+VPN+Access",
            ),
            CfPage(
                id="123",
                title="Legacy VPN Access",
                space_key="SEC",
                version=7,
                url="/display/SEC/Legacy+VPN+Access",
            ),
        ]

    monkeypatch.setattr(service_task_tools.cf, "cql_search", cql_search)

    def fetch_page_body(page_id: str) -> str:
        page_calls.append(page_id)
        return f"GOOGLE_API_KEY={api_key}\n"

    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", fetch_page_body)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "cql": cql,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    assert payload["api_search"]["candidate_sources"] == {"explicit_cql": 1}
    assert payload["api_search"]["query_details"] == [{
        "query": cql,
        "source": "explicit_cql",
        "space_key": "",
        "status": "searched",
        "returned": 2,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 0,
        "duplicate": 1,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"explicit_cql": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_cql": {"skipped": 1, "fetched": 1},
    }
    assert payload["api_search"]["target_status_counts"] == {
        "skipped": 1,
        "selected": 1,
    }
    assert payload["api_search"]["target_source_counts"] == {"explicit_cql": 2}
    assert payload["api_search"]["target_status_by_source"] == {
        "explicit_cql": {"skipped": 1, "selected": 1},
    }
    assert cql_calls == [(cql, 25)]
    assert page_calls == ["123"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [
        {
            "page_id": "123",
            "space_key": "SEC",
            "title": "Legacy VPN Access",
            "candidate_source": "explicit_cql",
            "candidate_query": cql,
            "status": "skipped",
            "error": "duplicate page candidate",
        },
        {
            "id": "123",
            "space_key": "SEC",
            "title": "Legacy VPN Access",
            "candidate_source": "explicit_cql",
            "candidate_query": cql,
        },
    ]
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["page_details"] == [
        {
            "page_id": "123",
            "space_key": "SEC",
            "title": "Legacy VPN Access",
            "url": "/display/SEC/Legacy+VPN+Access",
            "version": 7,
            "candidate_source": "explicit_cql",
            "candidate_query": cql,
            "scan_method": "api_cql_search_detail_scan",
            "status": "skipped",
            "error": "duplicate page candidate",
        },
        {
            "page_id": "123",
            "space_key": "SEC",
            "title": "Legacy VPN Access",
            "url": "/display/SEC/Legacy+VPN+Access",
            "version": 7,
            "candidate_source": "explicit_cql",
            "candidate_query": cql,
            "scan_method": "api_cql_search_detail_scan",
            "status": "fetched",
            "body_present": True,
        },
    ]

    rows = state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "confluence:SEC:123"
    assert rows[0]["asset_kind"] == "page"


def test_confluence_task_scan_space_cql_audits_out_of_scope_before_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    token = "AKIA" + ("S" * 16)
    cql_calls: list[tuple[str, int]] = []
    list_page_calls: list[tuple[str, int]] = []
    page_calls: list[str] = []

    def cql_search(query: str, limit: int = 100):
        cql_calls.append((query, limit))
        return [
            CfPage(
                id="998",
                title="Missing Space Secret",
                space_key="",
                version=4,
                url="/display/UNKNOWN/Missing+Space+Secret",
            ),
            CfPage(
                id="999",
                title="Other Space Secret",
                space_key="OPS",
                version=3,
                url="/display/OPS/Other+Space+Secret",
            ),
        ]

    monkeypatch.setattr(service_task_tools.cf, "cql_search", cql_search)

    def list_pages(space_key: str, limit: int = 50):
        list_page_calls.append((space_key, limit))
        return [
            CfPage(
                id="123",
                title="Security Secret",
                space_key="SEC",
                version=7,
                url="/display/SEC/Security+Secret",
            ),
        ]

    monkeypatch.setattr(service_task_tools.cf, "list_pages", list_pages)
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_blogposts",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("space CQL fallback must not list blogposts"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("space CQL scope test must not list comments"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_comment_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("space CQL scope test must not fetch comments"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("space CQL scope test must not list history"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body_version",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("space CQL scope test must not fetch history"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("space CQL scope test must not list attachments"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_attachment_text",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("space CQL scope test must not fetch attachments"),
        ),
    )

    def fetch_page_body(page_id: str) -> str:
        page_calls.append(page_id)
        if page_id == "999":
            raise AssertionError("out-of-scope CQL page must not be fetched")
        return f"aws_access_key_id={token}\n"

    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", fetch_page_body)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "space_keys": ["SEC"],
            "cql_terms": ["secret"],
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    expected_queries = [
        'space = "SEC" AND type = page AND text ~ "secret"',
        'space = "SEC" AND type = page AND title ~ "secret"',
    ]
    assert cql_calls == [(query, 25) for query in expected_queries]
    assert list_page_calls == [("SEC", 50)]
    assert page_calls == ["123"]
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 4
    assert payload["api_search"]["fallback_list_pages"] == 1
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["target_status_counts"] == {
        "skipped": 4,
        "selected": 1,
    }
    assert payload["api_search"]["target_source_counts"] == {
        "space_cql": 4,
        "space_list": 1,
    }
    assert payload["api_search"]["target_status_by_source"] == {
        "space_cql": {"skipped": 4},
        "space_list": {"selected": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [
        {
            "page_id": "998",
            "space_key": "",
            "target_space_key": "SEC",
            "title": "Missing Space Secret",
            "candidate_source": "space_cql",
            "candidate_query": expected_queries[0],
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "999",
            "space_key": "OPS",
            "target_space_key": "SEC",
            "title": "Other Space Secret",
            "candidate_source": "space_cql",
            "candidate_query": expected_queries[0],
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "998",
            "space_key": "",
            "target_space_key": "SEC",
            "title": "Missing Space Secret",
            "candidate_source": "space_cql",
            "candidate_query": expected_queries[1],
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "999",
            "space_key": "OPS",
            "target_space_key": "SEC",
            "title": "Other Space Secret",
            "candidate_source": "space_cql",
            "candidate_query": expected_queries[1],
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "id": "123",
            "space_key": "SEC",
            "title": "Security Secret",
            "candidate_source": "space_list",
            "candidate_query": "",
        },
    ]
    assert evidence["page_details"] == [
        {
            "page_id": "998",
            "space_key": "",
            "target_space_key": "SEC",
            "title": "Missing Space Secret",
            "url": "/display/UNKNOWN/Missing+Space+Secret",
            "version": 4,
            "candidate_source": "space_cql",
            "candidate_query": expected_queries[0],
            "scan_method": "api_cql_search_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "999",
            "space_key": "OPS",
            "target_space_key": "SEC",
            "title": "Other Space Secret",
            "url": "/display/OPS/Other+Space+Secret",
            "version": 3,
            "candidate_source": "space_cql",
            "candidate_query": expected_queries[0],
            "scan_method": "api_cql_search_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "998",
            "space_key": "",
            "target_space_key": "SEC",
            "title": "Missing Space Secret",
            "url": "/display/UNKNOWN/Missing+Space+Secret",
            "version": 4,
            "candidate_source": "space_cql",
            "candidate_query": expected_queries[1],
            "scan_method": "api_cql_search_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "999",
            "space_key": "OPS",
            "target_space_key": "SEC",
            "title": "Other Space Secret",
            "url": "/display/OPS/Other+Space+Secret",
            "version": 3,
            "candidate_source": "space_cql",
            "candidate_query": expected_queries[1],
            "scan_method": "api_cql_search_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "123",
            "space_key": "SEC",
            "title": "Security Secret",
            "url": "/display/SEC/Security+Secret",
            "version": 7,
            "candidate_source": "space_list",
            "candidate_query": "",
            "scan_method": "api_page_detail_scan",
            "status": "fetched",
            "body_present": True,
        },
    ]
    rows = state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "confluence:SEC:123"


def test_confluence_task_scan_fallback_list_skips_out_of_scope_before_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.confluence.plugin.agent_types.confluence import CfPage
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    token = "AKIA" + ("F" * 16)
    cql_calls: list[tuple[str, int]] = []
    list_page_calls: list[tuple[str, int]] = []
    page_calls: list[str] = []

    def cql_search(query: str, limit: int = 100):
        cql_calls.append((query, limit))
        return []

    monkeypatch.setattr(service_task_tools.cf, "cql_search", cql_search)

    def list_pages(space_key: str, limit: int = 50):
        list_page_calls.append((space_key, limit))
        return [
            CfPage(
                id="998",
                title="Missing Space Secret",
                space_key="",
                version=11,
                url="/display/UNKNOWN/Missing+Space+Secret",
            ),
            CfPage(
                id="999",
                title="Other Space Secret",
                space_key="OPS",
                version=10,
                url="/display/OPS/Other+Space+Secret",
            ),
            CfPage(
                id="123",
                title="Security Secret",
                space_key="SEC",
                version=7,
                url="/display/SEC/Security+Secret",
            ),
        ]

    monkeypatch.setattr(service_task_tools.cf, "list_pages", list_pages)
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_blogposts",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback list scope test must not list blogposts"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback list scope test must not list comments"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_comment_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback list scope test must not fetch comments"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback list scope test must not list history"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body_version",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback list scope test must not fetch history"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback list scope test must not list attachments"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_attachment_text",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fallback list scope test must not fetch attachments"),
        ),
    )

    def fetch_page_body(page_id: str) -> str:
        page_calls.append(page_id)
        if page_id == "999":
            raise AssertionError("out-of-scope fallback page must not be fetched")
        return f"aws_secret_access_key={token}\n"

    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", fetch_page_body)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "space_keys": ["SEC"],
            "cql_terms": ["secret"],
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        {"charter_ref": "SECOPS-CONFLUENCE-FALLBACK-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    expected_queries = [
        'space = "SEC" AND type = page AND text ~ "secret"',
        'space = "SEC" AND type = page AND title ~ "secret"',
    ]
    assert cql_calls == [(query, 25) for query in expected_queries]
    assert list_page_calls == [("SEC", 50)]
    assert page_calls == ["123"]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 2
    assert payload["api_search"]["fallback_list_pages"] == 1
    assert payload["api_search"]["fallback_reason"] == "no_api_candidates"
    assert payload["api_search"]["fallback_attempts"] == [{
        "space_key": "SEC",
        "reason": "no_api_candidates",
        "returned": 3,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 2,
        "duplicate": 0,
        "skipped": 2,
    }]
    assert payload["api_search"]["fallback_status_counts"] == {"searched": 1}
    assert payload["api_search"]["fallback_candidate_totals"] == {
        "returned": 3,
        "selected": 0,
        "added": 1,
        "invalid": 0,
        "out_of_scope": 2,
        "duplicate": 0,
        "limit_skipped": 0,
        "skipped": 2,
    }
    assert payload["api_search"]["detail_status_counts"] == {
        "skipped": 2,
        "fetched": 1,
    }
    assert payload["api_search"]["detail_status_by_source"] == {
        "space_list": {"skipped": 2, "fetched": 1},
    }
    assert payload["api_search"]["target_status_counts"] == {
        "skipped": 2,
        "selected": 1,
    }
    assert payload["api_search"]["target_status_by_source"] == {
        "space_list": {"skipped": 2, "selected": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [
        {
            "page_id": "998",
            "space_key": "",
            "target_space_key": "SEC",
            "title": "Missing Space Secret",
            "candidate_source": "space_list",
            "candidate_query": "no_api_candidates",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "999",
            "space_key": "OPS",
            "target_space_key": "SEC",
            "title": "Other Space Secret",
            "candidate_source": "space_list",
            "candidate_query": "no_api_candidates",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "id": "123",
            "space_key": "SEC",
            "title": "Security Secret",
            "candidate_source": "space_list",
            "candidate_query": "",
        },
    ]
    assert evidence["page_details"] == [
        {
            "page_id": "998",
            "space_key": "",
            "target_space_key": "SEC",
            "title": "Missing Space Secret",
            "url": "/display/UNKNOWN/Missing+Space+Secret",
            "version": 11,
            "candidate_source": "space_list",
            "candidate_query": "no_api_candidates",
            "scan_method": "api_page_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "999",
            "space_key": "OPS",
            "target_space_key": "SEC",
            "title": "Other Space Secret",
            "url": "/display/OPS/Other+Space+Secret",
            "version": 10,
            "candidate_source": "space_list",
            "candidate_query": "no_api_candidates",
            "scan_method": "api_page_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate out of requested space scope",
        },
        {
            "page_id": "123",
            "space_key": "SEC",
            "title": "Security Secret",
            "url": "/display/SEC/Security+Secret",
            "version": 7,
            "candidate_source": "space_list",
            "candidate_query": "",
            "scan_method": "api_page_detail_scan",
            "status": "fetched",
            "body_present": True,
        },
    ]
    rows = state.finding_list(task_type="confluence", limit=10)
    assert len(rows) == 1
    assert rows[0]["asset"] == "confluence:SEC:123"


def test_confluence_task_scan_explicit_page_body_fetch_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    class PageBodyFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact page body fetch error must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    page_calls: list[str] = []

    def fail_page_body(page_id: str):
        page_calls.append(page_id)
        raise PageBodyFailure("Confluence page body HTTP 503")

    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", fail_page_body)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "page_ids": ["123456"],
            "scan_comments": True,
            "scan_history": True,
            "fetch_attachments": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert page_calls == ["123456"]
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_sources"] == {"explicit_page": 1}
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_page_body": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_page": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "fetch_page_body"
    assert payload["errors"][0]["status_code"] == 503
    assert state.finding_list(task_type="confluence", limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["page_details"] == [{
        "page_id": "123456",
        "space_key": "",
        "title": "123456",
        "url": "",
        "version": 0,
        "candidate_source": "explicit_page",
        "candidate_query": "",
        "scan_method": "api_page_detail_scan",
        "status": "error",
        "status_code": 503,
        "error": "PageBodyFailure('Confluence page body HTTP 503')",
    }]


def test_confluence_task_scan_explicit_page_ids_audit_candidates_beyond_max_pages(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    page_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("explicit page max_pages scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def fetch_page_body(page_id: str) -> str:
        page_calls.append(page_id)
        if page_id == "333333":
            raise AssertionError("page beyond max_pages must not be fetched")
        return "clean page body\n"

    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", fetch_page_body)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "page_ids": ["111111", "222222", "333333"],
            "max_pages": 2,
            "scan_comments": False,
            "scan_history": False,
            "fetch_attachments": False,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 2
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["candidate_sources"] == {"explicit_page": 2}
    assert payload["api_search"]["detail_source_counts"] == {"explicit_page": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_page": {"skipped": 1, "fetched": 2},
    }
    assert page_calls == ["111111", "222222"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == [
        {
            "page_id": "333333",
            "space_key": "",
            "title": "333333",
            "url": "",
            "version": 0,
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "scan_method": "api_page_detail_scan",
            "status": "skipped",
            "error": "Confluence page candidate beyond max_pages",
        },
        {
            "page_id": "111111",
            "space_key": "",
            "title": "111111",
            "url": "",
            "version": 0,
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "scan_method": "api_page_detail_scan",
            "status": "fetched",
            "body_present": True,
        },
        {
            "page_id": "222222",
            "space_key": "",
            "title": "222222",
            "url": "",
            "version": 0,
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "scan_method": "api_page_detail_scan",
            "status": "fetched",
            "body_present": True,
        },
    ]
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_explicit_comments_audit_candidates_beyond_max_pages(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.confluence.plugin.agent_types.confluence import CfComment
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    comment_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("explicit comment max_pages scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def fetch_comment_detail(comment_id: str) -> CfComment:
        comment_calls.append(comment_id)
        if comment_id == "2222":
            raise AssertionError("comment beyond max_pages must not be fetched")
        return CfComment(
            id=comment_id,
            body="clean comment body\n",
            parent_page_id="101010",
        )

    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", fetch_comment_detail)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "comment_ids": [
                {"page_id": "101010", "comment_id": "1111"},
                {"page_id": "202020", "comment_id": "2222"},
            ],
            "max_pages": 1,
            "scan_comments": True,
            "scan_history": True,
            "fetch_attachments": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["candidate_sources"] == {"explicit_comment": 1}
    assert payload["api_search"]["detail_source_counts"] == {"explicit_comment": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_comment": {"skipped": 1, "fetched": 1},
    }
    assert comment_calls == ["1111"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["comment_details"] == [
        {
            "page_id": "202020",
            "space_key": "",
            "page_title": "202020",
            "comment_id": "2222",
            "candidate_source": "explicit_comment",
            "candidate_query": "",
            "status": "skipped",
            "error": "Confluence comment candidate beyond max_pages",
        },
        {
            "page_id": "101010",
            "space_key": "",
            "page_title": "101010",
            "comment_id": "1111",
            "candidate_source": "explicit_comment",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
    ]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_explicit_comment_fetches_exact_comment_only(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool
    from domains.services.confluence.plugin.agent_types.confluence import CfComment

    api_key = "AIza" + ("C" * 35)
    comment_calls: list[str] = []

    monkeypatch.setattr(
        service_task_tools.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact comment URL must not run CQL search"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact comment URL must not list pages"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact comment URL must not fetch page body"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact comment URL must not list every comment"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact comment URL must not list page history"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact comment URL must not list attachments"),
        ),
    )

    def fetch_comment_detail(comment_id: str) -> CfComment:
        comment_calls.append(comment_id)
        return CfComment(
            id=comment_id,
            body=f"GOOGLE_API_KEY={api_key}\n",
            parent_page_id="123456",
        )

    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", fetch_comment_detail)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "comment_ids": [{"page_id": "123456", "comment_id": "98765"}],
            "scan_comments": True,
            "scan_history": True,
            "fetch_attachments": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["finding_count"] == 1
    assert comment_calls == ["98765"]
    assert payload["api_search"]["candidate_sources"] == {"explicit_comment": 1}
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_comment": 1}

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["comment_details"] == [{
        "page_id": "123456",
        "space_key": "",
        "page_title": "123456",
        "comment_id": "98765",
        "candidate_source": "explicit_comment",
        "candidate_query": "",
        "status": "fetched",
        "content_present": True,
    }]

    row = state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:123456/comment/98765"
    assert row["asset_kind"] == "comment"
    assert row["extra"]["metadata"]["candidate_source"] == "explicit_comment"
    assert row["extra"]["metadata"]["scan_method"] == "api_comment_detail_scan"


def test_confluence_task_scan_explicit_comment_requires_parent_scope(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool
    from domains.services.confluence.plugin.agent_types.confluence import CfComment

    api_key = "AIza" + ("P" * 35)
    comment_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact comment scope test must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def fetch_comment_detail(comment_id: str) -> CfComment:
        comment_calls.append(comment_id)
        return CfComment(
            id=comment_id,
            body=f"GOOGLE_API_KEY={api_key}\n",
            parent_page_id="",
        )

    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", fetch_comment_detail)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "comment_ids": [{"page_id": "123456", "comment_id": "98765"}],
            "scan_comments": True,
            "scan_history": True,
            "fetch_attachments": True,
        },
        tmp_path,
        {"charter_ref": "SECOPS-CONFLUENCE-COMMENT-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert comment_calls == ["98765"]
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["status_reason"] == (
        "Candidate search/fallback/file/directory/commit/PR/issue/compare scan returned "
        "only out-of-scope targets (out_of_scope=1)"
    )
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_comment": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_comment": {"skipped": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["comment_details"] == [{
        "page_id": "123456",
        "space_key": "",
        "page_title": "123456",
        "comment_id": "98765",
        "candidate_source": "explicit_comment",
        "candidate_query": "",
        "status": "skipped",
        "fetched_page_id": "",
        "error": "Confluence comment candidate out of requested page scope",
    }]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_explicit_comment_fetch_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    class CommentDetailFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact comment fetch error must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    comment_calls: list[str] = []

    def fail_comment_detail(comment_id: str):
        comment_calls.append(comment_id)
        raise CommentDetailFailure("Confluence comment detail HTTP 503")

    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", fail_comment_detail)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "comment_ids": [{"page_id": "123456", "comment_id": "98765"}],
            "scan_comments": True,
            "scan_history": True,
            "fetch_attachments": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert comment_calls == ["98765"]
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_sources"] == {"explicit_comment": 1}
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_comment_detail": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_comment": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "fetch_comment_detail"
    assert payload["errors"][0]["status_code"] == 503
    assert state.finding_list(task_type="confluence", limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["comment_details"] == [{
        "page_id": "123456",
        "space_key": "",
        "page_title": "123456",
        "comment_id": "98765",
        "candidate_source": "explicit_comment",
        "candidate_query": "",
        "status": "error",
        "status_code": 503,
        "error": "CommentDetailFailure('Confluence comment detail HTTP 503')",
    }]


def test_confluence_task_scan_explicit_page_version_fetches_exact_version_only(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    token = "AKIA" + ("D" * 16)
    version_calls: list[tuple[str, int]] = []

    monkeypatch.setattr(
        service_task_tools.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact page-version URL must not run CQL search"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact page-version URL must not list pages"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact page-version URL must not fetch current page body"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact page-version URL must not list comments"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact page-version URL must not enumerate history"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_attachments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact page-version URL must not list attachments"),
        ),
    )

    def fetch_page_body_version(page_id: str, version: int) -> str:
        version_calls.append((page_id, version))
        return f"aws_access_key_id={token}\n"

    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body_version",
        fetch_page_body_version,
    )

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "page_versions": [{"page_id": "123456", "version": 4}],
            "scan_comments": True,
            "scan_history": True,
            "fetch_attachments": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["finding_count"] == 1
    assert version_calls == [("123456", 4)]
    assert payload["api_search"]["candidate_sources"] == {"explicit_page_version": 1}
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_page_version": 1}

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["version_details"] == [{
        "page_id": "123456",
        "space_key": "",
        "page_title": "123456",
        "version": 4,
        "candidate_source": "explicit_page_version",
        "candidate_query": "",
        "status": "fetched",
        "content_present": True,
    }]

    row = state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:123456/version/4"
    assert row["asset_kind"] == "page_version"
    assert row["extra"]["metadata"]["candidate_source"] == "explicit_page_version"
    assert row["extra"]["metadata"]["scan_method"] == "api_page_version_detail_scan"


def test_confluence_task_scan_explicit_page_version_fetch_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    class PageVersionDetailFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact page-version fetch error must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    version_calls: list[tuple[str, int]] = []

    def fail_page_version(page_id: str, version: int):
        version_calls.append((page_id, version))
        raise PageVersionDetailFailure("Confluence page version HTTP 503")

    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body_version",
        fail_page_version,
    )

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "page_versions": [{"page_id": "123456", "version": 4}],
            "scan_comments": True,
            "scan_history": True,
            "fetch_attachments": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert version_calls == [("123456", 4)]
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_sources"] == {"explicit_page_version": 1}
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_page_body_version": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_page_version": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "fetch_page_body_version"
    assert payload["errors"][0]["status_code"] == 503
    assert state.finding_list(task_type="confluence", limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["version_details"] == [{
        "page_id": "123456",
        "space_key": "",
        "page_title": "123456",
        "version": 4,
        "candidate_source": "explicit_page_version",
        "candidate_query": "",
        "status": "error",
        "status_code": 503,
        "error": "PageVersionDetailFailure('Confluence page version HTTP 503')",
    }]


def test_confluence_task_scan_explicit_page_versions_audit_candidates_beyond_max_pages(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    version_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("explicit page-version max_pages scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def fetch_page_body_version(page_id: str, version: int) -> str:
        version_calls.append((page_id, version))
        if page_id == "404040":
            raise AssertionError("page version beyond max_pages must not be fetched")
        return "clean historical page body\n"

    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body_version",
        fetch_page_body_version,
    )

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "page_versions": [
                {"page_id": "303030", "version": 2},
                {"page_id": "404040", "version": 3},
            ],
            "max_pages": 1,
            "scan_comments": True,
            "scan_history": True,
            "fetch_attachments": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["candidate_sources"] == {"explicit_page_version": 1}
    assert payload["api_search"]["detail_source_counts"] == {
        "explicit_page_version": 2,
    }
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_page_version": {"skipped": 1, "fetched": 1},
    }
    assert version_calls == [("303030", 2)]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["attachment_details"] == []
    assert evidence["version_details"] == [
        {
            "page_id": "404040",
            "space_key": "",
            "page_title": "404040",
            "version": 3,
            "candidate_source": "explicit_page_version",
            "candidate_query": "",
            "status": "skipped",
            "error": "Confluence page version candidate beyond max_pages",
        },
        {
            "page_id": "303030",
            "space_key": "",
            "page_title": "303030",
            "version": 2,
            "candidate_source": "explicit_page_version",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
    ]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_history_versions_audit_candidates_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    version_calls: list[tuple[str, int]] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded history scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_attachments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body",
        lambda page_id: "clean now\n",
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_page_versions",
        lambda page_id: [3, 2, 1],
    )

    def fetch_page_body_version(page_id: str, version: int) -> str:
        version_calls.append((page_id, version))
        if version == 1:
            raise AssertionError(
                "history version beyond history_versions must not be fetched",
            )
        return "old clean body\n"

    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body_version",
        fetch_page_body_version,
    )

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "page_ids": ["5555"],
            "scan_history": True,
            "history_versions": 1,
            "scan_comments": False,
            "fetch_attachments": False,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["detail_fetched"] == 2
    assert payload["api_search"]["detail_source_counts"] == {"explicit_page": 4}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_page": {"fetched": 2, "skipped": 2},
    }
    assert version_calls == [("5555", 3)]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == [{
        "page_id": "5555",
        "space_key": "",
        "title": "5555",
        "url": "",
        "version": 0,
        "candidate_source": "explicit_page",
        "candidate_query": "",
        "scan_method": "api_page_detail_scan",
        "status": "fetched",
        "body_present": True,
    }]
    assert evidence["version_details"] == [
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "version": 3,
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "version": 2,
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "status": "skipped",
            "error": "Confluence page version candidate beyond history_versions",
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "version": 1,
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "status": "skipped",
            "error": "Confluence page version candidate beyond history_versions",
        },
    ]


def test_confluence_task_scan_explicit_attachment_fetches_exact_attachment_only(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment

    api_key = "AIza" + ("B" * 35)
    attachment_calls: list[str] = []

    monkeypatch.setattr(
        service_task_tools.cf,
        "cql_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact attachment URL must not run CQL search"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_pages",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact attachment URL must not list full pages"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact attachment URL must not fetch page body"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact attachment URL must not list comments"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact attachment URL must not list page history"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="att-1",
                filename="secrets.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/5555/secrets.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="att-2",
                filename="other.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/5555/other.env",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(download_url: str) -> str:
        attachment_calls.append(download_url)
        return f"GOOGLE_API_KEY={api_key}\n"

    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "attachment_downloads": [{
                "page_id": "5555",
                "download_url": "/download/attachments/5555/secrets.env",
            }],
            "fetch_attachments": False,
            "scan_comments": True,
            "scan_history": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["finding_count"] == 1
    assert attachment_calls == ["/download/attachments/5555/secrets.env"]
    assert payload["api_search"]["candidate_sources"] == {"explicit_attachment": 1}
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_attachment": 1}
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["version_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["attachment_details"] == [{
        "page_id": "5555",
        "space_key": "",
        "page_title": "5555",
        "attachment_id": "att-1",
        "filename": "secrets.env",
        "download_url": "/download/attachments/5555/secrets.env",
        "candidate_source": "explicit_attachment",
        "candidate_query": "",
        "status": "fetched",
        "content_present": True,
    }]

    row = state.finding_list(task_type="confluence", limit=10)[0]
    assert row["asset"] == "confluence:5555/attachment/secrets.env"
    assert row["asset_kind"] == "attachment"
    assert row["extra"]["metadata"]["candidate_source"] == "explicit_attachment"
    assert row["extra"]["metadata"]["scan_method"] == "api_attachment_detail_scan"


def test_confluence_task_scan_explicit_attachment_requires_parent_scope(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    list_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact attachment parent scope test must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_attachment_text",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope attachment must not be fetched"),
        ),
    )

    def list_attachments(page_id: str):
        list_calls.append(page_id)
        return [
            CfAttachment(
                id="att-1",
                filename="secrets.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/5555/secrets.env",
                parent_page_id="9999",
            ),
        ]

    monkeypatch.setattr(service_task_tools.cf, "list_attachments", list_attachments)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "attachment_downloads": [{
                "page_id": "5555",
                "download_url": "/download/attachments/5555/secrets.env",
            }],
            "fetch_attachments": False,
            "scan_comments": True,
            "scan_history": True,
        },
        tmp_path,
        {"charter_ref": "SECOPS-CONFLUENCE-ATTACHMENT-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert list_calls == ["5555"]
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert payload["status_reason"] == (
        "Candidate search/fallback/file/directory/commit/PR/issue/compare scan returned "
        "only out-of-scope targets (out_of_scope=1)"
    )
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_attachment": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_attachment": {"skipped": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == [{
        "page_id": "5555",
        "space_key": "",
        "page_title": "5555",
        "attachment_id": "att-1",
        "filename": "secrets.env",
        "download_url": "/download/attachments/5555/secrets.env",
        "candidate_source": "explicit_attachment",
        "candidate_query": "",
        "status": "skipped",
        "fetched_page_id": "9999",
        "error": "Confluence attachment candidate out of requested page scope",
    }]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_explicit_attachments_audit_candidates_beyond_max_pages(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    list_calls: list[str] = []
    fetch_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("explicit attachment max_pages scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)

    def list_attachments(page_id: str):
        list_calls.append(page_id)
        if page_id == "606060":
            raise AssertionError("attachment page beyond max_pages must not list")
        return [
            CfAttachment(
                id="att-1",
                filename="first.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/505050/first.env",
                parent_page_id=page_id,
            ),
        ]

    monkeypatch.setattr(service_task_tools.cf, "list_attachments", list_attachments)

    def fetch_attachment_text(download_url: str) -> str:
        fetch_calls.append(download_url)
        if "second.env" in download_url:
            raise AssertionError("attachment beyond max_pages must not be fetched")
        return "clean attachment body\n"

    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "attachment_downloads": [
                {
                    "page_id": "505050",
                    "download_url": "/download/attachments/505050/first.env",
                },
                {
                    "page_id": "606060",
                    "download_url": "/download/attachments/606060/second.env",
                },
            ],
            "max_pages": 1,
            "scan_comments": True,
            "scan_history": True,
            "fetch_attachments": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["candidate_sources"] == {"explicit_attachment": 1}
    assert payload["api_search"]["detail_source_counts"] == {"explicit_attachment": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_attachment": {"skipped": 1, "fetched": 1},
    }
    assert list_calls == ["505050"]
    assert fetch_calls == ["/download/attachments/505050/first.env"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == [
        {
            "page_id": "606060",
            "space_key": "",
            "page_title": "606060",
            "download_url": "/download/attachments/606060/second.env",
            "candidate_source": "explicit_attachment",
            "candidate_query": "",
            "status": "skipped",
            "error": "Confluence attachment candidate beyond max_pages",
        },
        {
            "page_id": "505050",
            "space_key": "",
            "page_title": "505050",
            "attachment_id": "att-1",
            "filename": "first.env",
            "download_url": "/download/attachments/505050/first.env",
            "candidate_source": "explicit_attachment",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
    ]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_explicit_detail_duplicates_are_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment, CfComment
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    comment_key = "AIza" + ("C" * 35)
    version_key = "AKIA" + ("V" * 16)
    attachment_key = "AIza" + ("A" * 35)
    comment_calls: list[str] = []
    version_calls: list[tuple[str, int]] = []
    list_attachment_calls: list[str] = []
    attachment_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact Confluence duplicate scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)

    def fetch_comment_detail(comment_id: str) -> CfComment:
        comment_calls.append(comment_id)
        if comment_id != "98765":
            raise AssertionError("duplicate explicit comment candidate must not be fetched")
        return CfComment(
            id=comment_id,
            body=f"GOOGLE_API_KEY={comment_key}\n",
            parent_page_id="123456",
        )

    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", fetch_comment_detail)

    def fetch_page_body_version(page_id: str, version: int) -> str:
        version_calls.append((page_id, version))
        if (page_id, version) != ("222222", 3):
            raise AssertionError("duplicate explicit page version must not be fetched")
        return f"aws_access_key_id={version_key}\n"

    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body_version",
        fetch_page_body_version,
    )

    def list_attachments(page_id: str):
        list_attachment_calls.append(page_id)
        if page_id != "5555":
            raise AssertionError("only the exact attachment page should list attachments")
        return [
            CfAttachment(
                id="att-1",
                filename="secrets.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/5555/secrets.env",
                parent_page_id=page_id,
            ),
        ]

    monkeypatch.setattr(service_task_tools.cf, "list_attachments", list_attachments)

    def fetch_attachment_text(download_url: str) -> str:
        attachment_calls.append(download_url)
        if download_url != "/download/attachments/5555/secrets.env":
            raise AssertionError("duplicate explicit attachment must not be fetched")
        return f"GOOGLE_API_KEY={attachment_key}\n"

    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "comment_ids": [
                {"page_id": "123456", "comment_id": "98765"},
                {"page_id": "123456", "comment_id": "98765"},
            ],
            "page_versions": [
                {"page_id": "222222", "version": 3},
                {"page_id": "222222", "version": 3},
            ],
            "attachment_downloads": [
                {
                    "page_id": "5555",
                    "download_url": "/download/attachments/5555/secrets.env",
                },
                {
                    "page_id": "5555",
                    "download_url": "/download/attachments/5555/secrets.env",
                },
            ],
            "scan_comments": True,
            "scan_history": True,
            "fetch_attachments": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 3
    assert payload["artifacts_scanned"] == 3
    assert payload["finding_count"] == 3
    assert payload["api_search"]["duplicate_count"] == 3
    assert payload["api_search"]["candidate_sources"] == {
        "explicit_comment": 1,
        "explicit_page_version": 1,
        "explicit_attachment": 1,
    }
    assert payload["api_search"]["detail_source_counts"] == {
        "explicit_comment": 2,
        "explicit_page_version": 2,
        "explicit_attachment": 2,
    }
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_comment": {"skipped": 1, "fetched": 1},
        "explicit_page_version": {"skipped": 1, "fetched": 1},
        "explicit_attachment": {"skipped": 1, "fetched": 1},
    }
    assert comment_calls == ["98765"]
    assert version_calls == [("222222", 3)]
    assert list_attachment_calls == ["5555"]
    assert attachment_calls == ["/download/attachments/5555/secrets.env"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == [
        {
            "page_id": "123456",
            "space_key": "",
            "page_title": "123456",
            "comment_id": "98765",
            "candidate_source": "explicit_comment",
            "candidate_query": "",
            "status": "skipped",
            "error": "duplicate comment candidate",
        },
        {
            "page_id": "123456",
            "space_key": "",
            "page_title": "123456",
            "comment_id": "98765",
            "candidate_source": "explicit_comment",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
    ]
    assert evidence["version_details"] == [
        {
            "page_id": "222222",
            "space_key": "",
            "page_title": "222222",
            "version": 3,
            "candidate_source": "explicit_page_version",
            "candidate_query": "",
            "status": "skipped",
            "error": "duplicate page version candidate",
        },
        {
            "page_id": "222222",
            "space_key": "",
            "page_title": "222222",
            "version": 3,
            "candidate_source": "explicit_page_version",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
    ]
    assert evidence["attachment_details"] == [
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "download_url": "/download/attachments/5555/secrets.env",
            "candidate_source": "explicit_attachment",
            "candidate_query": "",
            "status": "skipped",
            "error": "duplicate attachment candidate",
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "att-1",
            "filename": "secrets.env",
            "download_url": "/download/attachments/5555/secrets.env",
            "candidate_source": "explicit_attachment",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
    ]
    rows = state.finding_list(task_type="confluence", limit=10)
    assert {row["asset"] for row in rows} == {
        "confluence:123456/comment/98765",
        "confluence:222222/version/3",
        "confluence:5555/attachment/secrets.env",
    }


def test_confluence_task_scan_page_attachments_audit_candidates_beyond_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    fetch_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded page attachment scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body",
        lambda page_id: "clean page\n",
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="att-1",
                filename="first.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/5555/first.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="att-2",
                filename="second.env",
                media_type="text/plain",
                size=90,
                download_url="/download/attachments/5555/second.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="att-3",
                filename="third.env",
                media_type="text/plain",
                size=100,
                download_url="/download/attachments/5555/third.env",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(download_url: str) -> str:
        fetch_calls.append(download_url)
        if download_url.endswith("third.env"):
            raise AssertionError(
                "attachment beyond max_attachments_per_page must not be fetched",
            )
        return "no sensitive data\n"

    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "page_ids": ["5555"],
            "max_attachments_per_page": 2,
            "fetch_attachments": True,
            "scan_comments": False,
            "scan_history": False,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["detail_source_counts"] == {"explicit_page": 4}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_page": {"fetched": 3, "skipped": 1},
    }
    assert fetch_calls == [
        "/download/attachments/5555/first.env",
        "/download/attachments/5555/second.env",
    ]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == [{
        "page_id": "5555",
        "space_key": "",
        "title": "5555",
        "url": "",
        "version": 0,
        "candidate_source": "explicit_page",
        "candidate_query": "",
        "scan_method": "api_page_detail_scan",
        "status": "fetched",
        "body_present": True,
    }]
    assert evidence["attachment_details"] == [
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "att-1",
            "filename": "first.env",
            "download_url": "/download/attachments/5555/first.env",
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "att-2",
            "filename": "second.env",
            "download_url": "/download/attachments/5555/second.env",
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "att-3",
            "filename": "third.env",
            "download_url": "/download/attachments/5555/third.env",
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "status": "skipped",
            "error": (
                "Confluence attachment candidate beyond "
                "max_attachments_per_page"
            ),
        },
    ]


def test_confluence_task_scan_page_attachments_audit_non_text_candidates(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    api_key = "AIza" + ("N" * 35)
    fetch_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("bounded page attachment scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_blogposts", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body",
        lambda page_id: "clean page\n",
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="att-img",
                filename="diagram.png",
                media_type="image/png",
                size=120,
                download_url="/download/attachments/5555/diagram.png",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="att-env",
                filename="secret.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/5555/secret.env",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(download_url: str) -> str:
        fetch_calls.append(download_url)
        if download_url.endswith("diagram.png"):
            raise AssertionError("non-text attachment must not be fetched")
        return f"GOOGLE_API_KEY={api_key}\n"

    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "page_ids": ["5555"],
            "fetch_attachments": True,
            "scan_comments": False,
            "scan_history": False,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 2
    assert payload["finding_count"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_page": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_page": {"skipped": 1, "fetched": 2},
    }
    assert fetch_calls == ["/download/attachments/5555/secret.env"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["attachment_details"] == [
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "att-img",
            "filename": "diagram.png",
            "download_url": "/download/attachments/5555/diagram.png",
            "media_type": "image/png",
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "status": "skipped",
            "content_present": False,
            "error": "Confluence attachment candidate is not text",
        },
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "att-env",
            "filename": "secret.env",
            "download_url": "/download/attachments/5555/secret.env",
            "candidate_source": "explicit_page",
            "candidate_query": "",
            "status": "fetched",
            "content_present": True,
        },
    ]
    rows = state.finding_list(task_type="confluence", limit=10)
    assert [row["asset"] for row in rows] == ["confluence:5555/attachment/secret.env"]


def test_confluence_task_scan_explicit_attachment_list_limits_text_candidates(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment

    token_one = "AKIA" + ("A" * 16)
    token_two = "AKIA" + ("B" * 16)
    fetch_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("attachment-list limit scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="att-1",
                filename="first.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/5555/first.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="att-2",
                filename="second.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/5555/second.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="att-3",
                filename="third.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/5555/third.env",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="att-bin",
                filename="diagram.png",
                media_type="image/png",
                size=120,
                download_url="/download/attachments/5555/diagram.png",
                parent_page_id=page_id,
            ),
        ],
    )

    def fetch_attachment_text(download_url: str) -> str:
        fetch_calls.append(download_url)
        if download_url.endswith("first.env"):
            return f"aws_access_key_id={token_one}\n"
        if download_url.endswith("second.env"):
            return f"aws_access_key_id={token_two}\n"
        raise AssertionError("attachment beyond max_attachments_per_page must not be fetched")

    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", fetch_attachment_text)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "page_ids": ["5555"],
            "include_attachments": True,
            "max_attachments_per_page": 2,
            "fetch_attachments": True,
            "scan_comments": True,
            "scan_history": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 2
    assert payload["finding_count"] == 2
    assert fetch_calls == [
        "/download/attachments/5555/first.env",
        "/download/attachments/5555/second.env",
    ]
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
    assert payload["api_search"]["detail_source_counts"] == {
        "explicit_attachment_list": 4,
    }
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_attachment_list": {"skipped": 2, "fetched": 2},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == [
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "att-bin",
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
            "attachment_id": "att-1",
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
            "attachment_id": "att-2",
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
            "attachment_id": "att-3",
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
    rows = state.finding_list(task_type="confluence", limit=10)
    assert {row["asset"] for row in rows} == {
        "confluence:5555/attachment/first.env",
        "confluence:5555/attachment/second.env",
    }


def test_confluence_task_scan_explicit_attachment_list_empty_is_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    list_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("empty attachment-list scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def list_attachments(page_id: str):
        list_calls.append(page_id)
        return []

    monkeypatch.setattr(service_task_tools.cf, "list_attachments", list_attachments)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "page_ids": ["5555"],
            "include_attachments": True,
            "fetch_attachments": True,
            "scan_comments": True,
            "scan_history": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "detail fetch returned no content" in payload["status_reason"]
    assert payload["errors"] == []
    assert payload["api_search"]["candidate_sources"] == {"explicit_attachment_list": 1}
    assert payload["api_search"]["detail_missing"] == 1
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
        "missing": 1,
    }]
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_attachment_list": {"missing": 1},
    }
    assert list_calls == ["5555"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == [{
        "page_id": "5555",
        "space_key": "",
        "page_title": "5555",
        "candidate_source": "explicit_attachment_list",
        "candidate_query": "",
        "status": "missing",
        "content_present": False,
        "error": "Confluence attachment list returned no candidates",
    }]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_explicit_attachment_list_non_text_only_is_skipped(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment

    list_calls: list[str] = []

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("non-text attachment-list scan must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    def list_attachments(page_id: str):
        list_calls.append(page_id)
        return [
            CfAttachment(
                id="att-img",
                filename="diagram.png",
                media_type="image/png",
                size=120,
                download_url="/download/attachments/5555/diagram.png",
                parent_page_id=page_id,
            ),
            CfAttachment(
                id="att-pdf",
                filename="manual.pdf",
                media_type="application/pdf",
                size=1024,
                download_url="/download/attachments/5555/manual.pdf",
                parent_page_id=page_id,
            ),
        ]

    monkeypatch.setattr(service_task_tools.cf, "list_attachments", list_attachments)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "page_ids": ["5555"],
            "include_attachments": True,
            "fetch_attachments": True,
            "scan_comments": True,
            "scan_history": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "skipped"
    assert payload["recommended_target_status"] == "skipped"
    assert "only skipped targets" in payload["status_reason"]
    assert payload["errors"] == []
    assert payload["api_search"]["candidate_sources"] == {"explicit_attachment_list": 1}
    assert payload["api_search"]["detail_missing"] == 0
    assert payload["api_search"]["attachment_list_count"] == 0
    assert payload["api_search"]["attachment_list_attempts"] == [{
        "page_id": "5555",
        "space_key": "",
        "source": "explicit_attachment_list",
        "returned": 2,
        "text_candidates": 0,
        "selected": 0,
        "skipped_non_text": 2,
        "candidate_limit_hit": False,
        "skipped": 2,
    }]
    assert payload["api_search"]["detail_status_counts"] == {"skipped": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_attachment_list": {"skipped": 2},
    }
    assert list_calls == ["5555"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == [
        {
            "page_id": "5555",
            "space_key": "",
            "page_title": "5555",
            "attachment_id": "att-img",
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
            "attachment_id": "att-pdf",
            "filename": "manual.pdf",
            "download_url": "/download/attachments/5555/manual.pdf",
            "media_type": "application/pdf",
            "candidate_source": "explicit_attachment_list",
            "candidate_query": "",
            "status": "skipped",
            "content_present": False,
            "error": "Confluence attachment-list candidate is not text",
        },
    ]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_explicit_attachment_list_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool

    class AttachmentListFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact attachment list error must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_comments", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_comment_detail", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_page_versions", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_page_body_version", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", forbidden_call)

    list_calls: list[str] = []

    def fail_list_attachments(page_id: str):
        list_calls.append(page_id)
        raise AttachmentListFailure("Confluence attachment list HTTP 503")

    monkeypatch.setattr(service_task_tools.cf, "list_attachments", fail_list_attachments)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "attachment_downloads": [{
                "page_id": "5555",
                "download_url": "/download/attachments/5555/secrets.env",
            }],
            "fetch_attachments": False,
            "scan_comments": True,
            "scan_history": True,
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert list_calls == ["5555"]
    assert payload["kind"] == "confluence_task_scan"
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_sources"] == {"explicit_attachment": 1}
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "list_attachments": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_attachment": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "list_attachments"
    assert payload["errors"][0]["status_code"] == 503
    assert state.finding_list(task_type="confluence", limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["version_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["attachment_details"] == [{
        "page_id": "5555",
        "space_key": "",
        "page_title": "5555",
        "candidate_source": "explicit_attachment",
        "candidate_query": "",
        "status": "error",
        "status_code": 503,
        "error": "AttachmentListFailure('Confluence attachment list HTTP 503')",
    }]


def test_confluence_task_scan_explicit_attachment_missing_is_error_without_broadening(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment

    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("missing exact attachment must not fall back to page body"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_comments",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("missing exact attachment must not list comments"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_page_versions",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("missing exact attachment must not list page history"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_attachment_text",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("missing exact attachment must not fetch a different attachment"),
        ),
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_attachments",
        lambda page_id: [
            CfAttachment(
                id="att-2",
                filename="other.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/5555/other.env",
                parent_page_id=page_id,
            ),
        ],
    )

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "attachment_downloads": [{
                "page_id": "5555",
                "download_url": "/download/attachments/5555/secrets.env",
            }],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["artifacts_scanned"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_fetched"] == 0
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["attachment_details"] == [{
        "page_id": "5555",
        "space_key": "",
        "page_title": "5555",
        "download_url": "/download/attachments/5555/secrets.env",
        "candidate_source": "explicit_attachment",
        "candidate_query": "",
        "status": "missing",
        "content_present": False,
        "error": "explicit attachment URL not found in page attachment list",
    }]
    assert state.finding_list(task_type="confluence", limit=10) == []


def test_confluence_task_scan_explicit_attachment_fetch_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
):
    from secu_agent import state
    from domains.services.plugin.tools import service_task_tools
    from domains.services.plugin.tools.service_task_tools import ConfluenceTaskScanTool
    from domains.services.confluence.plugin.agent_types.confluence import CfAttachment

    class AttachmentFetchFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    def forbidden_call(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("exact attachment fetch error must not broaden")

    monkeypatch.setattr(service_task_tools.cf, "cql_search", forbidden_call)
    monkeypatch.setattr(service_task_tools.cf, "list_pages", forbidden_call)
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body",
        forbidden_call,
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_comments",
        forbidden_call,
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_comment_detail",
        forbidden_call,
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "list_page_versions",
        forbidden_call,
    )
    monkeypatch.setattr(
        service_task_tools.cf,
        "fetch_page_body_version",
        forbidden_call,
    )

    list_calls: list[str] = []
    fetch_calls: list[str] = []

    def list_attachments(page_id: str):
        list_calls.append(page_id)
        return [
            CfAttachment(
                id="att-1",
                filename="secrets.env",
                media_type="text/plain",
                size=80,
                download_url="/download/attachments/5555/secrets.env",
                parent_page_id=page_id,
            ),
        ]

    monkeypatch.setattr(
        service_task_tools.cf,
        "list_attachments",
        list_attachments,
    )

    def fail_fetch(download_url: str) -> str:
        fetch_calls.append(download_url)
        raise AttachmentFetchFailure("Confluence attachment HTTP 503")

    monkeypatch.setattr(service_task_tools.cf, "fetch_attachment_text", fail_fetch)

    res = _run(
        ConfluenceTaskScanTool(),
        {
            "attachment_downloads": [{
                "page_id": "5555",
                "download_url": "/download/attachments/5555/secrets.env",
            }],
        },
        tmp_path,
        {},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert list_calls == ["5555"]
    assert fetch_calls == ["/download/attachments/5555/secrets.env"]
    assert payload["finding_count"] == 0
    assert payload["artifacts_scanned"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["candidate_sources"] == {"explicit_attachment": 1}
    assert payload["api_search"]["fallback_list_pages"] == 0
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_attachment_text"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_attachment_text": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_attachment": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "fetch_attachment_text"
    assert payload["errors"][0]["status_code"] == 503
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["page_details"] == []
    assert evidence["comment_details"] == []
    assert evidence["version_details"] == []
    assert evidence["attachment_details"] == [{
        "page_id": "5555",
        "space_key": "",
        "page_title": "5555",
        "attachment_id": "att-1",
        "filename": "secrets.env",
        "download_url": "/download/attachments/5555/secrets.env",
        "candidate_source": "explicit_attachment",
        "candidate_query": "",
        "status": "error",
        "status_code": 503,
        "error": "AttachmentFetchFailure('Confluence attachment HTTP 503')",
    }]
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert state.finding_list(task_type="confluence", limit=10) == []


# ── v3.92 워커 repo 내부 검색어: 일반 어휘 금지 계약 ──────────────────────
def test_default_code_search_terms_have_no_bare_generic_vocabulary():
    """`token`/`secret`/`password` 단독 어휘는 오탐의 원천이다.

    GHES 검색 토크나이저가 구두점을 무시해서 `totalTokens`·`max_tokens` 같은 **식별자**가
    전부 걸리고, 그렇게 뽑힌 파일을 detector 가 훑으면 `Math.max(1` 까지 시크릿이 된다.
    실측: 최근 finding 의 98%가 이 세 어휘에서 나왔고, itdevsec/SecuLens 27건은 워커
    자신이 "27건 모두 기각"으로 닫았는데도 finding 으로 남았다.
    """
    from domains.services.plugin.tools.service_task_tools import (
        _DEFAULT_GITHUB_CODE_SEARCH_TERMS as terms,
    )

    bare = {t.strip().lower() for t in terms if not t.startswith("filename:")}
    for word in ("token", "secret", "password", "key", "credential", "apikey"):
        assert word not in bare, f"일반 어휘 {word!r} 가 기본 검색어로 돌아왔다"


def test_default_code_search_terms_still_cover_the_confirmed_real_findings():
    """회수(recall) 검산 — 사람이 KEEP 판정한 진짜 4건의 값 형상을 여전히 잡는가.

    #18333 private_key_block · #18393/#18562 github_pat(ghp_) ·
    #18343 database_url_with_password(postgres://). 일반 어휘를 빼도 이들은
    값 접두로 재발견된다 — 즉 일반 어휘가 단독으로 건진 진짜는 없었다.
    """
    from domains.services.plugin.tools.service_task_tools import (
        _DEFAULT_GITHUB_CODE_SEARCH_TERMS as terms,
    )

    joined = " | ".join(terms)
    assert "ghp_" in terms                      # github_pat 값 접두
    assert "postgres://" in terms               # database_url_with_password
    assert "PRIVATE KEY" in joined              # private_key_block
    # 하드코딩 비밀번호는 어휘가 아니라 파일 표적이 맡는다(걸리면 파일 전체 detector 스캔).
    assert "filename:.env" in terms


def test_default_code_search_terms_stay_bounded():
    """term 1개 = repo 당 검색 API 1회. 무한정 늘리면 secondary rate limit 에 걸린다."""
    from domains.services.plugin.tools.service_task_tools import (
        _DEFAULT_GITHUB_CODE_SEARCH_TERMS as terms,
    )

    assert len(terms) <= 30, f"기본 검색어가 {len(terms)}개 — repo 당 검색 호출이 그만큼 는다"
    assert len(terms) == len(set(terms)), "중복 term 은 검색 호출만 낭비한다"
