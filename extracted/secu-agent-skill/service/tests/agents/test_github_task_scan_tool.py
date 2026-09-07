from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from secu_agent.agent.tools.base import ToolContext, ToolSuccess


def _scanned(res, *, limit: int = 10) -> list[dict]:
    """스캔이 돌려준 **후보** — DB 가 아니라 도구 반환값에서 읽는다 (2026-08-27).

    github 스캔은 더 이상 finding 을 등록하지 않는다. 등록은 에이전트가
    `github_submit_finding` 을 부를 때 일어난다(사용자 결정: 모든 finding 은 등록 전에
    LLM 판정을 타야 한다). 예전 경로는 오늘까지 27,414건을 판정 없이 넣었다.

    ★ 후보를 돌려주면서 **DB 가 그대로인지도 함께 검증한다** — 읽는 곳만 바꾸면
      "등록하지 않는다" 는 불변식이 아무 데서도 안 지켜진다.
    """
    from secu_agent import state as _core_state

    assert _core_state.finding_list(task_type="github", limit=limit) == [], (
        "스캔이 finding 을 등록했다 — 후보만 돌려줘야 한다")
    return json.loads(res.content)["findings"][:limit]


def _run(payload: dict[str, Any], tmp_path: Path, metadata: dict[str, Any] | None = None):
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    return asyncio.run(GithubTaskScanTool().execute(
        GithubTaskScanTool.input_model(**payload),
        ToolContext(evidence_dir=tmp_path, metadata=metadata or {}),
    ))


def test_github_task_scan_explicit_release_fetches_exact_release_only(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("R" * 36)
    calls: list[tuple[str, str]] = []

    def fetch_release_by_tag(repo: str, tag_name: str):
        calls.append((repo, tag_name))
        return sht.gh.GhReleaseDetail(
            repo=repo,
            tag_name=tag_name,
            name="internal release",
            body=f"temporary GITHUB_TOKEN={token}\n",
            author="octo",
            draft=False,
            prerelease=False,
            assets=[
                {
                    "name": "deploy.env",
                    "label": "deployment config",
                    "browser_download_url": "https://gh.test/org/repo/releases/download/v1.2.3/deploy.env",
                    "content_type": "text/plain",
                },
            ],
        )

    monkeypatch.setattr(sht.gh, "fetch_release_by_tag", fetch_release_by_tag)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact release URL must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact release URL must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact release URL must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "release_tags": ["v1.2.3"],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-RELEASE-TASK"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", "v1.2.3")]
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["release_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_status_by_kind"]["release"] == {"fetched": 1}
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "release_tags": ["v1.2.3"],
    }]
    assert evidence["release_details"][0]["status"] == "fetched"
    assert evidence["release_details"][0]["asset_count"] == 1
    assert evidence["release_details"][0]["content_present"] is True

    row = _scanned(res, limit=10)[0]
    assert row["asset"] == "github:org/repo/release/v1.2.3"
    assert row["asset_kind"] == "release"
    assert row["metadata"]["scan_method"] == "api_release_detail_scan"
    assert row["metadata"]["candidate_source"] == "explicit_release"


def test_github_task_scan_explicit_release_skips_out_of_scope_repo(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    calls: list[tuple[str, str]] = []

    def fetch_release_by_tag(repo: str, tag_name: str):
        calls.append((repo, tag_name))
        return sht.gh.GhReleaseDetail(
            repo="other/repo",
            tag_name=tag_name,
            name="internal release",
            body="temporary GITHUB_TOKEN=" + ("R" * 36),
            author="octo",
            draft=False,
            prerelease=False,
            assets=[{
                "name": "deploy.env",
                "label": "deployment config",
                "browser_download_url": "https://gh.test/other/repo/releases/download/v1.2.3/deploy.env",
                "content_type": "text/plain",
            }],
        )

    monkeypatch.setattr(sht.gh, "fetch_release_by_tag", fetch_release_by_tag)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact release must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact release must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact release must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_releases",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact release must not list releases"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact release must not fetch unrelated commit detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_pull_request_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact release must not fetch unrelated PR detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_issue_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact release must not fetch unrelated issue detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_compare_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact release must not fetch unrelated compare detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "release_tags": ["v1.2.3"],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", "v1.2.3")]
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["artifacts_scanned"] == 0
    assert payload["api_search"]["release_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_errors"] == []
    assert payload["errors"] == []
    assert payload["api_search"]["detail_source_counts"] == {"explicit_release": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {"release": {"skipped": 1}}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_release": {"skipped": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["release_details"] == [{
        "repo": "other/repo",
        "target_repo": "org/repo",
        "tag_name": "v1.2.3",
        "candidate_source": "explicit_release",
        "status": "skipped",
        "error": "GitHub release candidate out of requested repo scope",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_release_list_fetches_bounded_releases_only(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("L" * 36)
    calls: list[tuple[str, int]] = []

    def list_releases(repo: str, *, limit: int = 20):
        calls.append((repo, limit))
        return [
            sht.gh.GhReleaseDetail(
                repo=repo,
                tag_name="v2.0.0",
                name="production bundle",
                body=f"temporary GITHUB_TOKEN={token}\n",
                author="octo",
                draft=False,
                prerelease=False,
                assets=[
                    {
                        "name": "deploy.env",
                        "label": "deployment config",
                        "browser_download_url": "https://gh.test/org/repo/releases/download/v2.0.0/deploy.env",
                        "content_type": "text/plain",
                    },
                ],
            ),
            sht.gh.GhReleaseDetail(
                repo=repo,
                tag_name="v1.9.0",
                name="older bundle",
                body="ordinary notes\n",
                author="octo",
                draft=False,
                prerelease=False,
                assets=[],
            ),
        ]

    monkeypatch.setattr(sht.gh, "list_releases", list_releases)
    monkeypatch.setattr(
        sht.gh,
        "fetch_release_by_tag",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not fetch one explicit tag"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "include_releases": True,
            "release_limit": 2,
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-RELEASE-LIST-TASK"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", 2)]
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 2
    assert payload["finding_count"] == 1
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["release_count"] == 2
    assert payload["api_search"]["release_list_attempts"] == [{
        "repo": "org/repo",
        "limit": 2,
        "returned": 2,
        "selected": 2,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_fetched"] == 2
    assert payload["api_search"]["detail_source_counts"] == {"release_list": 2}
    assert payload["api_search"]["detail_status_by_kind"]["release"] == {"fetched": 2}
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "include_releases": True,
        "release_limit": 2,
    }]
    assert [
        {
            "tag_name": row["tag_name"],
            "candidate_source": row["candidate_source"],
            "candidate_query": row["candidate_query"],
            "status": row["status"],
            "content_present": row["content_present"],
        }
        for row in evidence["release_details"]
    ] == [
        {
            "tag_name": "v2.0.0",
            "candidate_source": "release_list",
            "candidate_query": "releases",
            "status": "fetched",
            "content_present": True,
        },
        {
            "tag_name": "v1.9.0",
            "candidate_source": "release_list",
            "candidate_query": "releases",
            "status": "fetched",
            "content_present": True,
        },
    ]

    row = _scanned(res, limit=10)[0]
    assert row["asset"] == "github:org/repo/release/v2.0.0"
    assert row["asset_kind"] == "release"
    assert row["metadata"]["scan_method"] == "api_release_detail_scan"
    assert row["metadata"]["candidate_source"] == "release_list"
    assert row["metadata"]["candidate_query"] == "releases"


def test_github_task_scan_release_list_marks_limit_hit_for_overreturned_candidates(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    selected_token = "ghp_" + ("L" * 36)
    skipped_token = "ghp_" + ("S" * 36)
    calls: list[tuple[str, int]] = []

    def list_releases(repo: str, *, limit: int = 20):
        calls.append((repo, limit))
        return [
            sht.gh.GhReleaseDetail(
                repo=repo,
                tag_name="v2.0.0",
                name="production bundle",
                body=f"temporary GITHUB_TOKEN={selected_token}\n",
                author="octo",
                draft=False,
                prerelease=False,
                assets=[],
            ),
            sht.gh.GhReleaseDetail(
                repo=repo,
                tag_name="v1.9.0",
                name="older bundle",
                body="ordinary notes\n",
                author="octo",
                draft=False,
                prerelease=False,
                assets=[],
            ),
            sht.gh.GhReleaseDetail(
                repo=repo,
                tag_name="v1.8.0",
                name="overreturned bundle",
                body=f"must not scan GITHUB_TOKEN={skipped_token}\n",
                author="octo",
                draft=False,
                prerelease=False,
                assets=[],
            ),
        ]

    monkeypatch.setattr(sht.gh, "list_releases", list_releases)
    monkeypatch.setattr(
        sht.gh,
        "fetch_release_by_tag",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not fetch one explicit tag"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "include_releases": True,
            "release_limit": 2,
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-RELEASE-LIST-LIMIT"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", 2)]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["release_count"] == 2
    assert payload["api_search"]["release_list_attempts"] == [{
        "repo": "org/repo",
        "limit": 2,
        "returned": 3,
        "selected": 2,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 1,
        "candidate_limit_hit": True,
        "limit_skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"release_list": 3}
    assert payload["api_search"]["detail_status_by_kind"]["release"] == {
        "fetched": 2,
        "skipped": 1,
    }
    assert payload["api_search"]["detail_status_by_source"] == {
        "release_list": {"fetched": 2, "skipped": 1},
    }

    rows = _scanned(res, limit=10)
    assert [row["asset"] for row in rows] == ["github:org/repo/release/v2.0.0"]

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["candidate_limit_hit"] is True
    assert evidence["api_search"]["release_list_attempts"] == (
        payload["api_search"]["release_list_attempts"]
    )
    assert [
        {
            "tag_name": row["tag_name"],
            "candidate_source": row["candidate_source"],
            "status": row["status"],
            "content_present": row.get("content_present"),
            "error": row.get("error"),
        }
        for row in evidence["release_details"]
    ] == [
        {
            "tag_name": "v2.0.0",
            "candidate_source": "release_list",
            "status": "fetched",
            "content_present": True,
            "error": None,
        },
        {
            "tag_name": "v1.9.0",
            "candidate_source": "release_list",
            "status": "fetched",
            "content_present": True,
            "error": None,
        },
        {
            "tag_name": "v1.8.0",
            "candidate_source": "release_list",
            "status": "skipped",
            "content_present": None,
            "error": "GitHub release-list candidate beyond release_limit",
        },
    ]


def test_github_task_scan_release_list_skips_out_of_scope_releases(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("O" * 36)

    def list_releases(repo: str, *, limit: int = 20):
        assert repo == "org/repo"
        assert limit == 2
        return [
            sht.gh.GhReleaseDetail(
                repo="other/repo",
                tag_name="v9.9.9",
                name="wrong repo bundle",
                body=f"wrong repo token {token}\n",
                author="octo",
                draft=False,
                prerelease=False,
                assets=[],
            ),
            sht.gh.GhReleaseDetail(
                repo=repo,
                tag_name="v2.0.0",
                name="production bundle",
                body=f"temporary GITHUB_TOKEN={token}\n",
                author="octo",
                draft=False,
                prerelease=False,
                assets=[],
            ),
        ]

    monkeypatch.setattr(sht.gh, "list_releases", list_releases)
    monkeypatch.setattr(
        sht.gh,
        "fetch_release_by_tag",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not fetch one explicit tag"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "include_releases": True,
            "release_limit": 2,
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-RELEASE-LIST-SCOPE"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 1
    assert payload["api_search"]["release_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["release_list_attempts"] == [{
        "repo": "org/repo",
        "limit": 2,
        "returned": 2,
        "selected": 1,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 1,
        "skipped": 1,
    }]
    assert payload["api_search"]["detail_source_counts"] == {"release_list": 2}
    assert payload["api_search"]["detail_status_by_kind"]["release"] == {
        "skipped": 1,
        "fetched": 1,
    }
    assert payload["errors"] == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert [
        {
            "repo": row["repo"],
            "target_repo": row.get("target_repo"),
            "tag_name": row["tag_name"],
            "status": row["status"],
            "candidate_source": row["candidate_source"],
        }
        for row in evidence["release_details"]
    ] == [
        {
            "repo": "other/repo",
            "target_repo": "org/repo",
            "tag_name": "v9.9.9",
            "status": "skipped",
            "candidate_source": "release_list",
        },
        {
            "repo": "org/repo",
            "target_repo": None,
            "tag_name": "v2.0.0",
            "status": "fetched",
            "candidate_source": "release_list",
        },
    ]
    row = _scanned(res, limit=10)[0]
    assert row["asset"] == "github:org/repo/release/v2.0.0"
    assert row["metadata"]["candidate_source"] == "release_list"


def test_github_task_scan_release_list_empty_release_is_error_not_clean(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.gh,
        "list_releases",
        lambda repo, *, limit=20: [
            sht.gh.GhReleaseDetail(
                repo=repo,
                tag_name="v2.0.0",
                name="",
                body="",
                author="octo",
                draft=False,
                prerelease=False,
                assets=[],
            ),
        ],
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_release_by_tag",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not fetch one explicit tag"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list URL must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "include_releases": True,
            "release_limit": 2,
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-RELEASE-LIST-EMPTY"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "releases=1" in payload["status_reason"]
    assert payload["api_search"]["release_count"] == 1
    assert payload["api_search"]["release_list_attempts"] == [{
        "repo": "org/repo",
        "limit": 2,
        "returned": 1,
        "selected": 1,
        "duplicate": 0,
        "invalid": 0,
        "out_of_scope": 0,
        "skipped": 0,
    }]
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_status_by_kind"]["release"] == {"empty": 1}
    assert payload["api_search"]["detail_status_by_source"] == {
        "release_list": {"empty": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["release_details"] == [{
        "repo": "org/repo",
        "tag_name": "v2.0.0",
        "fetched_tag_name": "v2.0.0",
        "candidate_source": "release_list",
        "candidate_query": "releases",
        "name": "",
        "author": "octo",
        "draft": False,
        "prerelease": False,
        "asset_count": 0,
        "assets": [],
        "status": "empty",
        "content_present": False,
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_release_list_api_failure_records_attempt(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class ListReleasesFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    monkeypatch.setattr(
        sht.gh,
        "list_releases",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ListReleasesFailure("GitHub list releases HTTP 503"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_release_by_tag",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list failure must not fetch one explicit tag"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list failure must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list failure must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("release list failure must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "include_releases": True,
            "release_limit": 2,
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-RELEASE-LIST-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["release_list_attempts"] == [{
        "repo": "org/repo",
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
        "repo": "org/repo",
        "candidate_source": "release_list",
        "candidate_query": "releases",
        "status": "error",
        "status_code": 503,
        "error": "ListReleasesFailure('GitHub list releases HTTP 503')",
    }]


def test_github_task_scan_explicit_release_missing_is_audited_without_broadening(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(sht.gh, "fetch_release_by_tag", lambda repo, tag_name: None)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("missing exact release must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("missing exact release must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("missing exact release must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "release_tags": ["v1.2.3"],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["release_count"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["release_details"] == [{
        "repo": "org/repo",
        "tag_name": "v1.2.3",
        "candidate_source": "explicit_release",
        "status": "missing",
        "content_present": False,
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_release_rejects_malformed_tag(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.gh,
        "fetch_release_by_tag",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid exact release tag must not be fetched"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid exact release tag must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid exact release tag must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid exact release tag must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "release_tags": ["bad//tag"],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["release_count"] == 0
    assert payload["errors"][0]["phase"] == "release_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["release_details"] == [{
        "repo": "org/repo",
        "tag_name": "bad//tag",
        "candidate_source": "explicit_release",
        "status": "error",
        "error": "GitHub release candidate invalid tag",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_release_fetch_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class ReleaseFetchFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    calls: list[tuple[str, str]] = []

    def fetch_release_by_tag(repo: str, tag_name: str):
        calls.append((repo, tag_name))
        raise ReleaseFetchFailure("GitHub release detail HTTP 503")

    monkeypatch.setattr(sht.gh, "fetch_release_by_tag", fetch_release_by_tag)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact release fetch error must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact release fetch error must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact release fetch error must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_releases",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact release fetch error must not list releases"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_file_at_ref",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact release fetch error must not fetch unrelated exact file"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact release fetch error must not fetch unrelated commit detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_pull_request_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact release fetch error must not fetch unrelated PR detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_issue_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact release fetch error must not fetch unrelated issue detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_compare_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact release fetch error must not fetch unrelated compare detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "release_tags": ["v1.2.3"],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-RELEASE-DETAIL-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", "v1.2.3")]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["release_count"] == 1
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_release_by_tag"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_release_by_tag": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_release": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        "(no query)": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {
        "503": 1,
    }
    assert payload["errors"][0]["phase"] == "fetch_release_by_tag"
    assert payload["errors"][0]["status_code"] == 503
    assert payload["charter_ref"] == "SECOPS-GITHUB-RELEASE-DETAIL-FAIL"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["charter_ref"] == "SECOPS-GITHUB-RELEASE-DETAIL-FAIL"
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "release_tags": ["v1.2.3"],
    }]
    assert evidence["release_details"] == [{
        "repo": "org/repo",
        "tag_name": "v1.2.3",
        "candidate_source": "explicit_release",
        "status": "error",
        "status_code": 503,
        "error": "ReleaseFetchFailure('GitHub release detail HTTP 503')",
    }]
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_file_path_fetches_exact_file_only(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("F" * 36)
    calls: list[tuple[str, str, str]] = []

    def fetch_file_at_ref(repo: str, path: str, *, ref: str = "HEAD"):
        calls.append((repo, path, ref))
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.gh, "fetch_file_at_ref", fetch_file_at_ref)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file URL must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file URL must not fall back to hot-path tree scan"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file URL must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "file_paths": ["app/config.py"],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-FILE-TASK"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls[0] == ("org/repo", "app/config.py", "main")
    assert {call[:2] for call in calls} == {("org/repo", "app/config.py")}
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["file_path_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_fetched"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "file_paths": ["app/config.py"],
    }]
    assert evidence["file_details"] == [{
        "repo": "org/repo",
        "path": "app/config.py",
        "ref": "main",
        "candidate_source": "explicit_file",
        "candidate_query": "",
        "status": "fetched",
        "content_present": True,
    }]

    row = _scanned(res, limit=10)[0]
    assert row["asset"] == "github:org/repo/app/config.py"
    assert row["asset_kind"] == "repository_file"
    assert row["metadata"]["scan_method"] == "api_exact_file_scan"
    assert row["metadata"]["candidate_source"] == "explicit_file"


def test_github_task_scan_explicit_file_path_rejects_malformed_path(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.gh,
        "fetch_file_at_ref",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid explicit file path must not be fetched"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("empty exact directory must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("empty exact directory must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("empty exact directory must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "file_paths": ["../secrets.env"],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["file_path_count"] == 0
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["errors"][0]["phase"] == "file_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "org/repo",
        "path": "../secrets.env",
        "ref": "main",
        "candidate_source": "explicit_file",
        "candidate_query": "",
        "status": "error",
        "error": "GitHub file candidate invalid path",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_file_path_missing_detail_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(sht.gh, "fetch_file_at_ref", lambda repo, path, *, ref="HEAD": None)
    monkeypatch.setattr(sht.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory list failure must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "file_paths": ["missing.env"],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["file_path_count"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "org/repo",
        "path": "missing.env",
        "ref": "main",
        "candidate_source": "explicit_file",
        "candidate_query": "",
        "status": "missing",
        "content_present": False,
        "error": "GitHub explicit file detail returned no content",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_file_path_fetch_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class FileFetchFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    calls: list[tuple[str, str, str]] = []

    def fail_fetch(repo: str, path: str, *, ref: str = "HEAD"):
        calls.append((repo, path, ref))
        raise FileFetchFailure("GitHub file detail HTTP 503")

    monkeypatch.setattr(sht.gh, "fetch_file_at_ref", fail_fetch)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file detail error must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file detail error must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_directory_blobs",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file detail error must not list exact directories"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_blob_text",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file detail error must not fetch unrelated blobs"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file detail error must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file detail error must not fetch unrelated commit detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_pull_request_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file detail error must not fetch unrelated PR detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_issue_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file detail error must not fetch unrelated issue detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_compare_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file detail error must not fetch unrelated compare detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_release_by_tag",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact file detail error must not fetch unrelated release detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "file_paths": ["config/prod.env"],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", "config/prod.env", "main")]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["file_path_count"] == 1
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_file_at_ref"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_file_at_ref": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_file": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        "(no query)": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {
        "503": 1,
    }
    assert payload["errors"][0]["phase"] == "fetch_file_at_ref"
    assert payload["errors"][0]["status_code"] == 503
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "file_paths": ["config/prod.env"],
    }]
    assert evidence["file_details"] == [{
        "repo": "org/repo",
        "path": "config/prod.env",
        "ref": "main",
        "candidate_source": "explicit_file",
        "candidate_query": "",
        "status": "error",
        "status_code": 503,
        "error": "FileFetchFailure('GitHub file detail HTTP 503')",
    }]
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_file_path_dedups_duplicate_paths(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht

    calls: list[tuple[str, str, str]] = []

    def fetch_file_at_ref(repo: str, path: str, *, ref: str = "HEAD"):
        calls.append((repo, path, ref))
        return "no sensitive data\n"

    monkeypatch.setattr(sht.gh, "fetch_file_at_ref", fetch_file_at_ref)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid exact directory must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid exact directory must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid exact directory must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "file_paths": ["app/config.py", "app/config.py"],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", "app/config.py", "main")]
    assert payload["api_search"]["file_path_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"][0]["file_paths"] == ["app/config.py"]
    assert [
        {
            "path": row["path"],
            "candidate_source": row["candidate_source"],
            "status": row["status"],
            **({"error": row["error"]} if row.get("error") else {}),
        }
        for row in evidence["file_details"]
    ] == [
        {
            "path": "app/config.py",
            "candidate_source": "explicit_file",
            "status": "fetched",
        },
        {
            "path": "app/config.py",
            "candidate_source": "explicit_file",
            "status": "skipped",
            "error": "duplicate explicit file candidate",
        },
    ]


def test_github_task_scan_explicit_directory_fetches_scoped_blobs_only(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("D" * 36)
    listed: list[tuple[str, str, str]] = []
    fetched: list[tuple[str, str]] = []

    def list_directory_blobs(repo: str, ref: str, directory: str):
        listed.append((repo, ref, directory))
        return [
            sht.gh.GhBlobRef(repo=repo, ref="sha-main", path="config/prod.env", sha="sha-prod", size=20),
            sht.gh.GhBlobRef(repo=repo, ref="sha-main", path="config/readme.txt", sha="sha-readme", size=10),
        ]

    def fetch_blob_text(repo: str, sha: str):
        fetched.append((repo, sha))
        if sha == "sha-prod":
            return f"GITHUB_TOKEN={token}\n"
        return "no sensitive data\n"

    monkeypatch.setattr(sht.gh, "list_directory_blobs", list_directory_blobs)
    monkeypatch.setattr(sht.gh, "fetch_blob_text", fetch_blob_text)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact tree URL must not run broad code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact tree URL must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact tree URL must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "directory_paths": ["config"],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert listed == [("org/repo", "main", "config")]
    assert fetched == [("org/repo", "sha-prod"), ("org/repo", "sha-readme")]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["directory_path_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_fetched"] == 2
    assert payload["api_search"]["detail_source_counts"] == {"explicit_directory": 2}
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "directory_paths": ["config"],
    }]
    assert [
        {
            "path": row["path"],
            "candidate_source": row["candidate_source"],
            "candidate_query": row["candidate_query"],
            "status": row["status"],
            "content_present": row["content_present"],
        }
        for row in evidence["file_details"]
    ] == [
        {
            "path": "config/prod.env",
            "candidate_source": "explicit_directory",
            "candidate_query": "config",
            "status": "fetched",
            "content_present": True,
        },
        {
            "path": "config/readme.txt",
            "candidate_source": "explicit_directory",
            "candidate_query": "config",
            "status": "fetched",
            "content_present": True,
        },
    ]
    row = _scanned(res, limit=10)[0]
    assert row["asset"] == "github:org/repo/config/prod.env"
    assert row["metadata"]["scan_method"] == "api_directory_tree_scan"
    assert row["metadata"]["candidate_source"] == "explicit_directory"


def test_github_task_scan_explicit_directory_audits_blobs_beyond_file_limit(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht

    listed: list[tuple[str, str, str]] = []
    fetched: list[tuple[str, str]] = []

    def list_directory_blobs(repo: str, ref: str, directory: str):
        listed.append((repo, ref, directory))
        return [
            sht.gh.GhBlobRef(
                repo=repo,
                ref="sha-main",
                path="config/one.env",
                sha="sha-one",
                size=20,
            ),
            sht.gh.GhBlobRef(
                repo=repo,
                ref="sha-main",
                path="config/two.env",
                sha="sha-two",
                size=30,
            ),
            sht.gh.GhBlobRef(
                repo=repo,
                ref="sha-main",
                path="config/three.env",
                sha="sha-three",
                size=40,
            ),
        ]

    def fetch_blob_text(repo: str, sha: str):
        fetched.append((repo, sha))
        return "no sensitive data\n"

    monkeypatch.setattr(sht.gh, "list_directory_blobs", list_directory_blobs)
    monkeypatch.setattr(sht.gh, "fetch_blob_text", fetch_blob_text)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("bounded exact directory must not run broad code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("bounded exact directory must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("bounded exact directory must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "directory_paths": ["config"],
            "code_search_terms": [],
            "hot_paths": [],
            "max_files_per_repo": 2,
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert listed == [("org/repo", "main", "config")]
    assert fetched == [("org/repo", "sha-one"), ("org/repo", "sha-two")]
    assert payload["finding_count"] == 0
    assert payload["api_search"]["candidate_limit_hit"] is True
    assert payload["api_search"]["directory_path_count"] == 1
    assert payload["api_search"]["detail_fetched"] == 2
    assert payload["api_search"]["detail_source_counts"] == {"explicit_directory": 3}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_directory": {"fetched": 2, "skipped": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [
        {
            "repo": "org/repo",
            "path": "config/one.env",
            "ref": "sha-main",
            "sha": "sha-one",
            "size": 20,
            "candidate_source": "explicit_directory",
            "candidate_query": "config",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "org/repo",
            "path": "config/two.env",
            "ref": "sha-main",
            "sha": "sha-two",
            "size": 30,
            "candidate_source": "explicit_directory",
            "candidate_query": "config",
            "status": "fetched",
            "content_present": True,
        },
        {
            "repo": "org/repo",
            "target_repo": "org/repo",
            "path": "config/three.env",
            "ref": "sha-main",
            "sha": "sha-three",
            "size": 40,
            "candidate_source": "explicit_directory",
            "candidate_query": "config",
            "status": "skipped",
            "error": "GitHub directory blob candidate beyond max_files_per_repo",
        },
    ]


def test_github_task_scan_explicit_directory_skips_out_of_scope_blobs_before_fetch(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("O" * 36)
    listed: list[tuple[str, str, str]] = []
    fetched: list[tuple[str, str]] = []

    def list_directory_blobs(repo: str, ref: str, directory: str):
        listed.append((repo, ref, directory))
        return [
            sht.gh.GhBlobRef(
                repo="other/repo",
                ref="sha-other",
                path="config/stolen.env",
                sha="sha-foreign",
                size=20,
            ),
            sht.gh.GhBlobRef(
                repo=repo,
                ref="sha-main",
                path="config/prod.env",
                sha="sha-prod",
                size=20,
            ),
        ]

    def fetch_blob_text(repo: str, sha: str):
        fetched.append((repo, sha))
        if repo != "org/repo" or sha != "sha-prod":
            raise AssertionError("out-of-scope exact directory blob must not be fetched")
        return f"GITHUB_TOKEN={token}\n"

    monkeypatch.setattr(sht.gh, "list_directory_blobs", list_directory_blobs)
    monkeypatch.setattr(sht.gh, "fetch_blob_text", fetch_blob_text)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact directory must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact directory must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact directory must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_file_at_ref",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact directory must not fetch exact file detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "directory_paths": ["config"],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert listed == [("org/repo", "main", "config")]
    assert fetched == [("org/repo", "sha-prod")]
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["directory_path_count"] == 1
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_directory": 2}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_directory": {"skipped": 1, "fetched": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [
        {
            "repo": "other/repo",
            "target_repo": "org/repo",
            "path": "config/stolen.env",
            "ref": "sha-other",
            "sha": "sha-foreign",
            "candidate_source": "explicit_directory",
            "candidate_query": "config",
            "status": "skipped",
            "error": "GitHub directory blob candidate out of requested repo scope",
        },
        {
            "repo": "org/repo",
            "path": "config/prod.env",
            "ref": "sha-main",
            "sha": "sha-prod",
            "size": 20,
            "candidate_source": "explicit_directory",
            "candidate_query": "config",
            "status": "fetched",
            "content_present": True,
        },
    ]
    row = _scanned(res, limit=10)[0]
    assert row["asset"] == "github:org/repo/config/prod.env"
    assert row["metadata"]["candidate_source"] == "explicit_directory"


def test_github_task_scan_explicit_root_tree_fetches_bounded_blobs_only(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("R" * 36)
    listed: list[tuple[str, str, str]] = []
    fetched: list[tuple[str, str]] = []

    def list_directory_blobs(repo: str, ref: str, directory: str):
        listed.append((repo, ref, directory))
        return [
            sht.gh.GhBlobRef(repo=repo, ref="sha-main", path="app.env", sha="sha-env", size=20),
            sht.gh.GhBlobRef(repo=repo, ref="sha-main", path="docs/readme.md", sha="sha-doc", size=10),
        ]

    def fetch_blob_text(repo: str, sha: str):
        fetched.append((repo, sha))
        if sha == "sha-env":
            return f"GITHUB_TOKEN={token}\n"
        return "no sensitive data\n"

    monkeypatch.setattr(sht.gh, "list_directory_blobs", list_directory_blobs)
    monkeypatch.setattr(sht.gh, "fetch_blob_text", fetch_blob_text)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact root tree URL must not run broad code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact root tree URL must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact root tree URL must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "directory_paths": ["."],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert listed == [("org/repo", "main", ".")]
    assert fetched == [("org/repo", "sha-env"), ("org/repo", "sha-doc")]
    assert payload["finding_count"] == 1
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["directory_path_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_fetched"] == 2
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "directory_paths": ["."],
    }]
    assert [
        {
            "path": row["path"],
            "candidate_source": row["candidate_source"],
            "candidate_query": row["candidate_query"],
            "status": row["status"],
        }
        for row in evidence["file_details"]
    ] == [
        {
            "path": "app.env",
            "candidate_source": "explicit_directory",
            "candidate_query": ".",
            "status": "fetched",
        },
        {
            "path": "docs/readme.md",
            "candidate_source": "explicit_directory",
            "candidate_query": ".",
            "status": "fetched",
        },
    ]
    row = _scanned(res, limit=10)[0]
    assert row["asset"] == "github:org/repo/app.env"
    assert row["metadata"]["scan_method"] == "api_directory_tree_scan"
    assert row["metadata"]["candidate_source"] == "explicit_directory"
    assert row["metadata"]["candidate_query"] == "."


def test_github_task_scan_explicit_directory_missing_is_error_without_broadening(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(sht.gh, "list_directory_blobs", lambda repo, ref, directory: [])
    monkeypatch.setattr(
        sht.gh,
        "fetch_blob_text",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("empty exact directory must not fetch blob detail"),
        ),
    )
    monkeypatch.setattr(sht.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "directory_paths": ["empty/config"],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["directory_path_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_missing"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "org/repo",
        "path": "empty/config",
        "ref": "main",
        "candidate_source": "explicit_directory",
        "candidate_query": "empty/config",
        "status": "missing",
        "content_present": False,
        "error": "GitHub explicit directory returned no blob candidates",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_directory_rejects_malformed_path(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.gh,
        "list_directory_blobs",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid exact directory must not list blobs"),
        ),
    )
    monkeypatch.setattr(sht.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "directory_paths": ["../secrets"],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["directory_path_count"] == 0
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["errors"][0]["phase"] == "directory_candidate"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["file_details"] == [{
        "repo": "org/repo",
        "path": "../secrets",
        "ref": "main",
        "candidate_source": "explicit_directory",
        "candidate_query": "../secrets",
        "status": "error",
        "error": "GitHub directory candidate invalid path",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_directory_list_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class DirectoryListFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    calls: list[tuple[str, str, str]] = []

    def fail_list(repo: str, ref: str, directory: str):
        calls.append((repo, ref, directory))
        raise DirectoryListFailure("GitHub directory listing HTTP 503")

    monkeypatch.setattr(sht.gh, "list_directory_blobs", fail_list)
    monkeypatch.setattr(
        sht.gh,
        "fetch_file_at_ref",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory list failure must not fetch exact files"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_blob_text",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory list failure must not fetch blob detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory list failure must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory list failure must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory list failure must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory list failure must not fetch unrelated commit detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_pull_request_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory list failure must not fetch unrelated PR detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_issue_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory list failure must not fetch unrelated issue detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_compare_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory list failure must not fetch unrelated compare detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_release_by_tag",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory list failure must not fetch unrelated release detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "directory_paths": ["config"],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", "main", "config")]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["directory_path_count"] == 1
    assert payload["api_search"]["detail_errors"][0]["phase"] == "list_directory_blobs"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "list_directory_blobs": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_directory": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        "config": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {
        "503": 1,
    }
    assert payload["errors"][0]["phase"] == "list_directory_blobs"
    assert payload["errors"][0]["status_code"] == 503
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "directory_paths": ["config"],
    }]
    assert evidence["file_details"] == [{
        "repo": "org/repo",
        "path": "config",
        "ref": "main",
        "candidate_source": "explicit_directory",
        "candidate_query": "config",
        "status": "error",
        "status_code": 503,
        "error": "DirectoryListFailure('GitHub directory listing HTTP 503')",
    }]
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_directory_blob_fetch_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class BlobFetchFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    listed: list[tuple[str, str, str]] = []
    fetched: list[tuple[str, str]] = []

    def list_directory_blobs(repo: str, ref: str, directory: str):
        listed.append((repo, ref, directory))
        return [
            sht.gh.GhBlobRef(
                repo=repo,
                ref="sha-main",
                path="config/prod.env",
                sha="sha-prod",
                size=80,
            ),
        ]

    def fetch_blob_text(repo: str, sha: str):
        fetched.append((repo, sha))
        raise BlobFetchFailure("GitHub blob detail HTTP 503")

    monkeypatch.setattr(sht.gh, "list_directory_blobs", list_directory_blobs)
    monkeypatch.setattr(sht.gh, "fetch_blob_text", fetch_blob_text)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory blob fetch error must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory blob fetch error must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_file_at_ref",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory blob fetch error must not fetch unrelated exact file"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory blob fetch error must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact directory blob fetch error must not fetch unrelated commit detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "directory_paths": ["config"],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-DIRECTORY-BLOB-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert listed == [("org/repo", "main", "config")]
    assert fetched == [("org/repo", "sha-prod")]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["directory_path_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_blob_text": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_directory": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {"config": 1}
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "fetch_blob_text"
    assert payload["errors"][0]["status_code"] == 503
    assert payload["charter_ref"] == "SECOPS-GITHUB-DIRECTORY-BLOB-FAIL"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["charter_ref"] == "SECOPS-GITHUB-DIRECTORY-BLOB-FAIL"
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "directory_paths": ["config"],
    }]
    assert evidence["file_details"] == [{
        "repo": "org/repo",
        "path": "config/prod.env",
        "ref": "sha-main",
        "sha": "sha-prod",
        "size": 80,
        "candidate_source": "explicit_directory",
        "candidate_query": "config",
        "status": "error",
        "status_code": 503,
        "error": "BlobFetchFailure('GitHub blob detail HTTP 503')",
    }]
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_commit_sha_fetches_exact_patch_only(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("C" * 36)
    calls: list[tuple[str, str]] = []

    def fetch_commit_patch(repo: str, sha: str):
        calls.append((repo, sha))
        return sht.gh.GhCommitPatch(
            repo=repo,
            sha=sha,
            author="octo",
            author_email="octo@samsung.com",
            message="remove leaked token",
            files=[{"filename": "old.env", "patch": f"@@\n+GITHUB_TOKEN={token}\n-context"}],
        )

    monkeypatch.setattr(sht.gh, "fetch_commit_patch", fetch_commit_patch)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit URL must not run code search when terms are empty"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit URL must not fall back to hot-path tree scan"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit URL must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "commit_shas": ["abcdef1234567890"],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-TASK-SCAN"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", "abcdef1234567890")]
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["commit_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["charter_ref"] == "SECOPS-GITHUB-TASK-SCAN"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["charter_ref"] == "SECOPS-GITHUB-TASK-SCAN"
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "commit_shas": ["abcdef1234567890"],
    }]
    assert evidence["commit_details"] == [{
        "repo": "org/repo",
        "sha": "abcdef1234567890",
        "candidate_source": "explicit_commit",
        "files": ["old.env"],
        "file_count": 1,
        "scannable_file_count": 1,
        "status": "fetched",
        "content_present": True,
    }]

    row = _scanned(res, limit=10)[0]
    assert row["asset"] == "github:org/repo/commit/abcdef1234567890"
    assert row["asset_kind"] == "commit_patch"
    assert row["metadata"]["candidate_source"] == "explicit_commit"
    assert row["metadata"]["files"] == ["old.env"]


def test_github_task_scan_explicit_commit_skips_out_of_scope_repo(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    calls: list[tuple[str, str]] = []

    def fetch_commit_patch(repo: str, sha: str):
        calls.append((repo, sha))
        return sht.gh.GhCommitPatch(
            repo="other/repo",
            sha=sha,
            author="octo",
            author_email="octo@samsung.com",
            message="out of requested repo",
            files=[{"filename": "old.env", "patch": "@@\n+GITHUB_TOKEN=" + ("D" * 36)}],
        )

    monkeypatch.setattr(sht.gh, "fetch_commit_patch", fetch_commit_patch)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact commit must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact commit must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact commit must not scan broad recent commits"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "commit_shas": ["abcdef1234567890"],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", "abcdef1234567890")]
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["artifacts_scanned"] == 0
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_errors"] == []
    assert payload["errors"] == []
    assert payload["api_search"]["detail_source_counts"] == {"explicit_commit": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {"commit": {"skipped": 1}}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_commit": {"skipped": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["commit_details"] == [{
        "repo": "other/repo",
        "target_repo": "org/repo",
        "sha": "abcdef1234567890",
        "candidate_source": "explicit_commit",
        "status": "skipped",
        "error": "GitHub commit candidate out of requested repo scope",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_commit_list_api_failure_records_attempt(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class ListCommitsFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    calls: list[tuple[str, int, str | None]] = []

    def list_commits(repo: str, *, limit: int = 3, since_sha: str | None = None):
        calls.append((repo, limit, since_sha))
        raise ListCommitsFailure("GitHub list commits HTTP 503")

    monkeypatch.setattr(sht.gh, "recent_commit_patches", list_commits)
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit list failure must not fetch explicit commit detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit list failure must not run broad code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("commit list failure must not use hot-path fallback"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "include_commit_list": True,
            "commit_limit": 2,
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-COMMIT-LIST-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", 2, None)]
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["commit_count"] == 0
    assert payload["api_search"]["commit_list_count"] == 0
    assert payload["api_search"]["commit_list_attempts"] == [{
        "repo": "org/repo",
        "limit": 2,
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
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {"list_commits": 1}
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {"503": 1}
    assert payload["errors"][0]["phase"] == "list_commits"
    assert payload["errors"][0]["status_code"] == 503
    assert _scanned(res, limit=10) == []

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["api_search"]["commit_list_attempts"] == payload["api_search"]["commit_list_attempts"]
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "include_commit_list": True,
        "commit_limit": 2,
    }]
    assert evidence["commit_details"] == [{
        "repo": "org/repo",
        "sha": "",
        "candidate_source": "commit_list",
        "candidate_query": "commits",
        "status": "error",
        "status_code": 503,
        "error": "ListCommitsFailure('GitHub list commits HTTP 503')",
    }]


def test_github_task_scan_explicit_pull_request_fetches_pr_files_only(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("P" * 36)
    calls: list[tuple[str, int]] = []

    def fetch_pull_request_files(repo: str, number: int):
        calls.append((repo, number))
        return sht.gh.GhCommitPatch(
            repo=repo,
            sha=f"pull-{number}",
            author=None,
            author_email=None,
            message=f"pull request #{number}",
            files=[{"filename": "config/prod.env", "patch": f"@@\n+GITHUB_TOKEN={token}\n"}],
        )

    monkeypatch.setattr(sht.gh, "fetch_pull_request_files", fetch_pull_request_files)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact PR URL must not run code search when terms are empty"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact PR URL must not fall back to hot-path tree scan"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact PR URL must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact PR URL must not fetch unrelated commit detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "pull_numbers": [42],
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-PR-TASK"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", 42)]
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["pull_request_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_pull_request": 1}
    assert payload["charter_ref"] == "SECOPS-GITHUB-PR-TASK"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "pull_numbers": [42],
    }]
    assert evidence["pull_request_details"] == [{
        "repo": "org/repo",
        "pull_number": 42,
        "candidate_source": "explicit_pull_request",
        "files": ["config/prod.env"],
        "file_count": 1,
        "scannable_file_count": 1,
        "status": "fetched",
        "content_present": True,
    }]

    row = _scanned(res, limit=10)[0]
    assert row["asset"] == "github:org/repo/pull/42"
    assert row["asset_kind"] == "commit_patch"
    assert row["metadata"]["candidate_source"] == "explicit_pull_request"
    assert row["metadata"]["scan_method"] == "api_pull_request_files_scan"
    assert row["metadata"]["pull_number"] == 42
    assert row["metadata"]["files"] == ["config/prod.env"]


def test_github_task_scan_explicit_pull_request_skips_out_of_scope_repo(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    calls: list[tuple[str, int]] = []

    def fetch_pull_request_files(repo: str, number: int):
        calls.append((repo, number))
        return sht.gh.GhCommitPatch(
            repo="other/repo",
            sha=f"pull-{number}",
            author=None,
            author_email=None,
            message=f"pull request #{number}",
            files=[{"filename": "config/prod.env", "patch": "@@\n+GITHUB_TOKEN=" + ("E" * 36)}],
        )

    monkeypatch.setattr(sht.gh, "fetch_pull_request_files", fetch_pull_request_files)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact PR must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact PR must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact PR must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact PR must not fetch unrelated commit detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "pull_numbers": [42],
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", 42)]
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["artifacts_scanned"] == 0
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_errors"] == []
    assert payload["errors"] == []
    assert payload["api_search"]["detail_source_counts"] == {"explicit_pull_request": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {
        "pull_request": {"skipped": 1},
    }
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_pull_request": {"skipped": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["pull_request_details"] == [{
        "repo": "other/repo",
        "target_repo": "org/repo",
        "pull_number": 42,
        "candidate_source": "explicit_pull_request",
        "status": "skipped",
        "error": "GitHub pull request candidate out of requested repo scope",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_pull_request_fetch_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class PullRequestFetchFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    calls: list[tuple[str, int]] = []

    def fetch_pull_request_files(repo: str, number: int):
        calls.append((repo, number))
        raise PullRequestFetchFailure("GitHub pull request files HTTP 503")

    monkeypatch.setattr(sht.gh, "fetch_pull_request_files", fetch_pull_request_files)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact PR detail error must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact PR detail error must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact PR detail error must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact PR detail error must not fetch unrelated commit detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_issue_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact PR detail error must not fetch unrelated issue detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_compare_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact PR detail error must not fetch unrelated compare detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "pull_numbers": [42],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-PR-DETAIL-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", 42)]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["pull_request_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_pull_request_files": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_pull_request": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        "(no query)": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {
        "503": 1,
    }
    assert payload["errors"][0]["phase"] == "fetch_pull_request_files"
    assert payload["errors"][0]["status_code"] == 503
    assert payload["charter_ref"] == "SECOPS-GITHUB-PR-DETAIL-FAIL"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["charter_ref"] == "SECOPS-GITHUB-PR-DETAIL-FAIL"
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "pull_numbers": [42],
    }]
    assert evidence["pull_request_details"] == [{
        "repo": "org/repo",
        "pull_number": 42,
        "candidate_source": "explicit_pull_request",
        "status": "error",
        "status_code": 503,
        "error": "PullRequestFetchFailure('GitHub pull request files HTTP 503')",
    }]
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_issue_fetches_issue_body_and_comments_only(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("I" * 36)
    calls: list[tuple[str, int]] = []

    def fetch_issue_detail(repo: str, number: int):
        calls.append((repo, number))
        return sht.gh.GhIssueDetail(
            repo=repo,
            number=number,
            title="prod deploy access",
            body="본문은 깨끗합니다.",
            state="open",
            author="octo",
            comments=[
                {"author": "alice", "body": f"old token GITHUB_TOKEN={token}"},
            ],
        )

    monkeypatch.setattr(sht.gh, "fetch_issue_detail", fetch_issue_detail)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact issue URL must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact issue URL must not fall back to hot-path tree scan"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact issue URL must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact issue URL must not fetch unrelated commit detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_pull_request_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact issue URL must not fetch unrelated PR detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_compare_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact issue URL must not fetch unrelated compare detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "issue_numbers": [77],
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-ISSUE-TASK"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", 77)]
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["issue_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_issue": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {"issue": {"fetched": 1}}
    assert payload["charter_ref"] == "SECOPS-GITHUB-ISSUE-TASK"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "issue_numbers": [77],
    }]
    assert evidence["issue_details"] == [{
        "repo": "org/repo",
        "issue_number": 77,
        "candidate_source": "explicit_issue",
        "title": "prod deploy access",
        "state": "open",
        "author": "octo",
        "comment_count": 1,
        "status": "fetched",
        "content_present": True,
    }]

    row = _scanned(res, limit=10)[0]
    assert row["asset"] == "github:org/repo/issue/77"
    assert row["asset_kind"] == "issue"
    assert row["metadata"]["candidate_source"] == "explicit_issue"
    assert row["metadata"]["scan_method"] == "api_issue_detail_scan"
    assert row["metadata"]["issue_number"] == 77
    assert row["metadata"]["comment_count"] == 1


def test_github_task_scan_explicit_issue_skips_out_of_scope_repo(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    calls: list[tuple[str, int]] = []

    def fetch_issue_detail(repo: str, number: int):
        calls.append((repo, number))
        return sht.gh.GhIssueDetail(
            repo="other/repo",
            number=number,
            title="prod deploy access",
            body="GITHUB_TOKEN=" + ("F" * 36),
            state="open",
            author="octo",
            comments=[],
        )

    monkeypatch.setattr(sht.gh, "fetch_issue_detail", fetch_issue_detail)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact issue must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact issue must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact issue must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact issue must not fetch unrelated commit detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_pull_request_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact issue must not fetch unrelated PR detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_compare_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact issue must not fetch unrelated compare detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "issue_numbers": [77],
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", 77)]
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["artifacts_scanned"] == 0
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_errors"] == []
    assert payload["errors"] == []
    assert payload["api_search"]["detail_source_counts"] == {"explicit_issue": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {"issue": {"skipped": 1}}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_issue": {"skipped": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["issue_details"] == [{
        "repo": "other/repo",
        "target_repo": "org/repo",
        "issue_number": 77,
        "candidate_source": "explicit_issue",
        "status": "skipped",
        "error": "GitHub issue candidate out of requested repo scope",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_compare_fetches_compare_files_only(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    token = "ghp_" + ("M" * 36)
    calls: list[tuple[str, str]] = []

    def fetch_compare_files(repo: str, compare_ref: str):
        calls.append((repo, compare_ref))
        return sht.gh.GhCommitPatch(
            repo=repo,
            sha=f"compare-{compare_ref}",
            author=None,
            author_email=None,
            message=f"compare {compare_ref}",
            files=[{"filename": "deploy/prod.env", "patch": f"@@\n+GITHUB_TOKEN={token}\n"}],
        )

    monkeypatch.setattr(sht.gh, "fetch_compare_files", fetch_compare_files)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact compare URL must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact compare URL must not fall back to hot-path tree scan"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact compare URL must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact compare URL must not fetch unrelated commit detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_pull_request_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact compare URL must not fetch unrelated PR detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "compare_refs": ["main...feature"],
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-COMPARE-TASK"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", "main...feature")]
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 1
    assert payload["finding_count"] == 1
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["compare_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_fetched"] == 1
    assert payload["api_search"]["detail_source_counts"] == {"explicit_compare": 1}
    assert payload["charter_ref"] == "SECOPS-GITHUB-COMPARE-TASK"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "compare_refs": ["main...feature"],
    }]
    assert evidence["compare_details"] == [{
        "repo": "org/repo",
        "compare_ref": "main...feature",
        "candidate_source": "explicit_compare",
        "files": ["deploy/prod.env"],
        "file_count": 1,
        "scannable_file_count": 1,
        "status": "fetched",
        "content_present": True,
    }]

    row = _scanned(res, limit=10)[0]
    assert row["asset"] == "github:org/repo/compare/main...feature"
    assert row["asset_kind"] == "commit_patch"
    assert row["metadata"]["candidate_source"] == "explicit_compare"
    assert row["metadata"]["scan_method"] == "api_compare_files_scan"
    assert row["metadata"]["compare_ref"] == "main...feature"
    assert row["metadata"]["files"] == ["deploy/prod.env"]


def test_github_task_scan_explicit_compare_skips_out_of_scope_repo(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    calls: list[tuple[str, str]] = []

    def fetch_compare_files(repo: str, compare_ref: str):
        calls.append((repo, compare_ref))
        return sht.gh.GhCommitPatch(
            repo="other/repo",
            sha=f"compare-{compare_ref}",
            author=None,
            author_email=None,
            message=f"compare {compare_ref}",
            files=[{
                "filename": "deploy/prod.env",
                "patch": "@@\n+GITHUB_TOKEN=" + ("M" * 36) + "\n",
            }],
        )

    monkeypatch.setattr(sht.gh, "fetch_compare_files", fetch_compare_files)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact compare must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact compare must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact compare must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact compare must not fetch unrelated commit detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_pull_request_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact compare must not fetch unrelated PR detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_issue_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("out-of-scope exact compare must not fetch unrelated issue detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "compare_refs": ["main...feature"],
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", "main...feature")]
    assert payload["target_count"] == 1
    assert payload["finding_count"] == 0
    assert payload["artifacts_scanned"] == 0
    assert payload["api_search"]["out_of_scope_count"] == 1
    assert payload["api_search"]["detail_errors"] == []
    assert payload["errors"] == []
    assert payload["api_search"]["detail_source_counts"] == {"explicit_compare": 1}
    assert payload["api_search"]["detail_status_by_kind"] == {"compare": {"skipped": 1}}
    assert payload["api_search"]["detail_status_by_source"] == {
        "explicit_compare": {"skipped": 1},
    }

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["compare_details"] == [{
        "repo": "other/repo",
        "target_repo": "org/repo",
        "compare_ref": "main...feature",
        "candidate_source": "explicit_compare",
        "status": "skipped",
        "error": "GitHub compare candidate out of requested repo scope",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_compare_fetch_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class CompareFetchFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    calls: list[tuple[str, str]] = []

    def fetch_compare_files(repo: str, compare_ref: str):
        calls.append((repo, compare_ref))
        raise CompareFetchFailure("GitHub compare files HTTP 503")

    monkeypatch.setattr(sht.gh, "fetch_compare_files", fetch_compare_files)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact compare detail error must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact compare detail error must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact compare detail error must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact compare detail error must not fetch unrelated commit detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_pull_request_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact compare detail error must not fetch unrelated PR detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "compare_refs": ["main...feature"],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-COMPARE-DETAIL-FAIL"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", "main...feature")]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["compare_count"] == 1
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
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
    assert payload["charter_ref"] == "SECOPS-GITHUB-COMPARE-DETAIL-FAIL"

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["charter_ref"] == "SECOPS-GITHUB-COMPARE-DETAIL-FAIL"
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "compare_refs": ["main...feature"],
    }]
    assert evidence["compare_details"] == [{
        "repo": "org/repo",
        "compare_ref": "main...feature",
        "candidate_source": "explicit_compare",
        "status": "error",
        "status_code": 503,
        "error": "CompareFetchFailure('GitHub compare files HTTP 503')",
    }]
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert _scanned(res, limit=10) == []


def test_github_task_scan_rejects_malformed_explicit_commit_sha_without_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.gh,
        "fetch_commit_patch",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("malformed commit SHA must fail before API detail fetch"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("malformed exact commit scope must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(sht.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "commit_shas": ["../bad"],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-TASK-INVALID"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["errors"][0]["phase"] == "commit_candidate"
    assert "invalid sha" in payload["api_search"]["errors"][0]["error"]
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["charter_ref"] == "SECOPS-GITHUB-TASK-INVALID"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["charter_ref"] == "SECOPS-GITHUB-TASK-INVALID"
    assert "commit_shas" not in evidence["target_details"][0]
    assert evidence["commit_details"] == [{
        "repo": "org/repo",
        "sha": "../bad",
        "candidate_source": "explicit_commit",
        "status": "error",
        "error": "GitHub commit candidate invalid sha",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_rejects_malformed_pull_request_number_without_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.gh,
        "fetch_pull_request_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("malformed PR number must fail before API detail fetch"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("malformed exact PR scope must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(sht.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "pull_numbers": [0],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-PR-INVALID"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["errors"][0]["phase"] == "pull_request_candidate"
    assert "invalid number" in payload["api_search"]["errors"][0]["error"]
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["charter_ref"] == "SECOPS-GITHUB-PR-INVALID"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["pull_request_details"] == [{
        "repo": "org/repo",
        "pull_number": 0,
        "candidate_source": "explicit_pull_request",
        "status": "error",
        "error": "GitHub pull request candidate invalid number",
    }]
    assert "pull_numbers" not in evidence["target_details"][0]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_rejects_malformed_issue_number_without_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.gh,
        "fetch_issue_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("malformed issue number must fail before API detail fetch"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("malformed exact issue scope must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(sht.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "issue_numbers": [0],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-ISSUE-INVALID"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["errors"][0]["phase"] == "issue_candidate"
    assert "invalid number" in payload["api_search"]["errors"][0]["error"]
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["charter_ref"] == "SECOPS-GITHUB-ISSUE-INVALID"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["issue_details"] == [{
        "repo": "org/repo",
        "issue_number": 0,
        "candidate_source": "explicit_issue",
        "status": "error",
        "error": "GitHub issue candidate invalid number",
    }]
    assert "issue_numbers" not in evidence["target_details"][0]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_rejects_malformed_compare_ref_without_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.gh,
        "fetch_compare_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("malformed compare ref must fail before API detail fetch"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("malformed exact compare scope must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(sht.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "compare_refs": ["main..feature"],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
        metadata={"charter_ref": "SECOPS-GITHUB-COMPARE-INVALID"},
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["errors"][0]["phase"] == "compare_candidate"
    assert "invalid ref" in payload["api_search"]["errors"][0]["error"]
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["charter_ref"] == "SECOPS-GITHUB-COMPARE-INVALID"
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["compare_details"] == [{
        "repo": "org/repo",
        "compare_ref": "main..feature",
        "candidate_source": "explicit_compare",
        "status": "error",
        "error": "GitHub compare candidate invalid ref",
    }]
    assert "compare_refs" not in evidence["target_details"][0]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_commit_missing_detail_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(sht.gh, "fetch_commit_patch", lambda repo, sha: None)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit detail miss must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit detail miss must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(sht.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "commit_shas": ["abc123def456"],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["commit_count"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["commit_details"] == [{
        "repo": "org/repo",
        "sha": "abc123def456",
        "candidate_source": "explicit_commit",
        "status": "missing",
        "content_present": False,
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_issue_missing_detail_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(sht.gh, "fetch_issue_detail", lambda repo, number: None)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact issue detail miss must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact issue detail miss must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(sht.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "issue_numbers": [77],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["issue_count"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["issue_details"] == [{
        "repo": "org/repo",
        "issue_number": 77,
        "candidate_source": "explicit_issue",
        "status": "missing",
        "content_present": False,
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_issue_empty_detail_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    monkeypatch.setattr(
        sht.gh,
        "fetch_issue_detail",
        lambda repo, number: sht.gh.GhIssueDetail(
            repo=repo,
            number=number,
            title="",
            body="",
            state="open",
            author="octo",
            comments=[{"author": "alice", "body": ""}],
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("empty exact issue detail must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("empty exact issue detail must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(sht.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "issue_numbers": [77],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["issue_count"] == 1
    assert payload["api_search"]["detail_missing"] == 1
    assert payload["api_search"]["detail_status_by_kind"] == {"issue": {"empty": 1}}
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["issue_details"] == [{
        "repo": "org/repo",
        "issue_number": 77,
        "candidate_source": "explicit_issue",
        "title": "",
        "state": "open",
        "author": "octo",
        "comment_count": 1,
        "status": "empty",
        "content_present": False,
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_issue_fetch_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import httpx

    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    def fail_fetch(repo: str, number: int):
        request = httpx.Request("GET", f"https://gh.test/api/v3/repos/{repo}/issues/{number}")
        response = httpx.Response(502, request=request, json={"message": "Bad gateway"})
        raise httpx.HTTPStatusError("502 Bad Gateway", request=request, response=response)

    monkeypatch.setattr(sht.gh, "fetch_issue_detail", fail_fetch)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact issue detail error must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact issue detail error must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(sht.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "issue_numbers": [77],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["api_search"]["issue_count"] == 1
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_issue_detail"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 502
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["issue_details"] == [{
        "repo": "org/repo",
        "issue_number": 77,
        "candidate_source": "explicit_issue",
        "status": "error",
        "status_code": 502,
        "error": "HTTPStatusError('502 Bad Gateway')",
    }]
    assert _scanned(res, limit=10) == []


def test_github_task_scan_explicit_issue_dedups_duplicate_numbers(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht

    calls: list[tuple[str, int]] = []

    def fetch_issue_detail(repo: str, number: int):
        calls.append((repo, number))
        return sht.gh.GhIssueDetail(
            repo=repo,
            number=number,
            title="no sensitive data",
            body="nothing actionable",
            state="open",
            author="octo",
            comments=[],
        )

    monkeypatch.setattr(sht.gh, "fetch_issue_detail", fetch_issue_detail)
    monkeypatch.setattr(sht.gh, "code_search", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.gh, "list_paths_matching", lambda *args, **kwargs: [])
    monkeypatch.setattr(sht.gh, "recent_commit_patches", lambda *args, **kwargs: [])

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "issue_numbers": [77, 77],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", 77)]
    assert payload["api_search"]["issue_count"] == 1
    assert payload["api_search"]["duplicate_count"] == 1
    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"][0]["issue_numbers"] == [77]
    assert [
        {
            "issue_number": row["issue_number"],
            "candidate_source": row["candidate_source"],
            "status": row["status"],
            **({"error": row["error"]} if row.get("error") else {}),
        }
        for row in evidence["issue_details"]
    ] == [
        {
            "issue_number": 77,
            "candidate_source": "explicit_issue",
            "status": "fetched",
        },
        {
            "issue_number": 77,
            "candidate_source": "explicit_issue",
            "status": "skipped",
            "error": "duplicate issue candidate",
        },
    ]


def test_github_task_scan_explicit_commit_fetch_error_is_audited(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    class CommitFetchFailure(RuntimeError):
        response = type("Response", (), {"status_code": 503})()

    calls: list[tuple[str, str]] = []

    def fail_fetch(repo: str, sha: str):
        calls.append((repo, sha))
        raise CommitFetchFailure("GitHub commit detail HTTP 503")

    monkeypatch.setattr(sht.gh, "fetch_commit_patch", fail_fetch)
    monkeypatch.setattr(
        sht.gh,
        "code_search",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit detail error must not run code search"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit detail error must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit detail error must not scan broad recent commits"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_file_at_ref",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit detail error must not fetch unrelated exact file"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_pull_request_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit detail error must not fetch unrelated PR detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_issue_detail",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit detail error must not fetch unrelated issue detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_compare_files",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit detail error must not fetch unrelated compare detail"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_release_by_tag",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("exact commit detail error must not fetch unrelated release detail"),
        ),
    )

    res = _run(
        {
            "repos": ["org/repo"],
            "ref": "main",
            "commit_shas": ["abc123def456"],
            "code_search_terms": [],
            "hot_paths": [],
            "include_commits": False,
        },
        tmp_path,
    )

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert calls == [("org/repo", "abc123def456")]
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert payload["api_search"]["queries"] == []
    assert payload["api_search"]["commit_count"] == 1
    assert payload["api_search"]["detail_errors"][0]["phase"] == "fetch_commit_patch"
    assert payload["api_search"]["detail_errors"][0]["status_code"] == 503
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["detail_error_summary"]["by_phase"] == {
        "fetch_commit_patch": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_source"] == {
        "explicit_commit": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_query"] == {
        "(no query)": 1,
    }
    assert payload["api_search"]["detail_error_summary"]["by_status_code"] == {
        "503": 1,
    }
    assert payload["errors"][0]["phase"] == "fetch_commit_patch"
    assert payload["errors"][0]["status_code"] == 503

    evidence = json.loads(Path(payload["evidence_ref"]).read_text(encoding="utf-8"))
    assert evidence["target_details"] == [{
        "repo": "org/repo",
        "ref": "main",
        "default_branch": "main",
        "source": "explicit_repo",
        "commit_shas": ["abc123def456"],
    }]
    assert evidence["commit_details"] == [{
        "repo": "org/repo",
        "sha": "abc123def456",
        "candidate_source": "explicit_commit",
        "status": "error",
        "status_code": 503,
        "error": "CommitFetchFailure('GitHub commit detail HTTP 503')",
    }]
    assert evidence["api_search"]["detail_error_summary"] == (
        payload["api_search"]["detail_error_summary"]
    )
    assert _scanned(res, limit=10) == []


def test_github_task_scan_api_auth_failure_does_not_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import httpx

    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    def fail_code_search(query: str, per_page: int = 50, max_results: int = 100):
        request = httpx.Request("GET", "https://gh.test/api/v3/search/code")
        response = httpx.Response(401, request=request, json={"message": "Unauthorized"})
        raise httpx.HTTPStatusError("401 Unauthorized", request=request, response=response)

    monkeypatch.setattr(sht.gh, "code_search", fail_code_search)
    monkeypatch.setattr(
        sht.gh,
        "fetch_file_at_ref",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("auth failure must not continue to detail fetch"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("auth failure must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("auth failure must not continue to commit scan"),
        ),
    )

    res = _run({
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
        "repos": ["org/repo"],
        "ref": "main",
        "code_search_terms": ["secret"],
        "include_commits": True,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "401 Unauthorized" in payload["status_reason"]
    assert payload["api_search"]["auth_failed"] is True
    assert payload["api_search"]["unavailable"] is False
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["commit_count"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "code_search"
    assert payload["api_search"]["errors"][0]["status_code"] == 401
    assert payload["errors"][0]["phase"] == "code_search"
    assert _scanned(res, limit=10) == []


def test_github_task_scan_api_rate_limit_does_not_fallback(
    tmp_db,
    tmp_path,
    monkeypatch,
) -> None:
    import httpx

    from domains.services.plugin.tools import service_task_tools as sht
    from secu_agent import state as core_state

    def fail_code_search(query: str, per_page: int = 50, max_results: int = 100):
        request = httpx.Request("GET", "https://gh.test/api/v3/search/code")
        response = httpx.Response(
            403,
            request=request,
            headers={"X-RateLimit-Remaining": "0"},
            json={"message": "API rate limit exceeded"},
        )
        raise httpx.HTTPStatusError("403 Forbidden", request=request, response=response)

    monkeypatch.setattr(sht.gh, "code_search", fail_code_search)
    monkeypatch.setattr(
        sht.gh,
        "repo_meta",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("rate limit must not be retried as repo metadata lookup"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "fetch_file_at_ref",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("rate limit must not continue to detail fetch"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "list_paths_matching",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("rate limit must not use hot-path fallback"),
        ),
    )
    monkeypatch.setattr(
        sht.gh,
        "recent_commit_patches",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("rate limit must not continue to commit scan"),
        ),
    )

    res = _run({
            # api_search_first 는 2026-08-22 에 기본 OFF 가 됐다(워커에서 전역
            # code_search 금지 — rate-limit 백오프가 idle 상한을 넘긴다).
            # 이 테스트는 그 경로 자체를 검증하므로 **명시적으로** 켠다.
            "api_search_first": True,
        "repos": ["org/repo"],
        "ref": "main",
        "code_search_terms": ["secret"],
        "include_commits": True,
    }, tmp_path)

    assert isinstance(res, ToolSuccess)
    payload = json.loads(res.content)
    assert payload["target_count"] == 1
    assert payload["artifacts_scanned"] == 0
    assert payload["finding_count"] == 0
    assert payload["scan_status"] == "error"
    assert payload["recommended_target_status"] == "error"
    assert "403 Forbidden" in payload["status_reason"]
    assert payload["api_search"]["limit_failed"] is True
    assert payload["api_search"]["auth_failed"] is False
    assert payload["api_search"]["unavailable"] is False
    assert payload["api_search"]["candidate_count"] == 0
    assert payload["api_search"]["detail_fetched"] == 0
    assert payload["api_search"]["fallback_hot_path_tree"] == 0
    assert payload["api_search"]["commit_count"] == 0
    assert payload["api_search"]["errors"][0]["phase"] == "code_search"
    assert payload["api_search"]["errors"][0]["status_code"] == 403
    assert payload["errors"][0]["phase"] == "code_search"
    assert _scanned(res, limit=10) == []
