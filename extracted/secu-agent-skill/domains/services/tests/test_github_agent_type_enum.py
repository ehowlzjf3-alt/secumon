"""v3.70 S2: agent_types/github.py 전사 enum + code_search + repo_meta TDD.

httpx MockTransport 로 GHES API 모킹. 토큰/네트워크 불필요."""
from __future__ import annotations

import json

import httpx
import pytest

from domains.services.github.plugin.agent_types import github


def _patch_client(monkeypatch, handler):
    def _factory():
        return httpx.Client(
            transport=httpx.MockTransport(handler),
            base_url="https://gh.test/api/v3",
        )
    monkeypatch.setattr(github, "_client", _factory)


# ---------------------------------------------------------------------------
# iter_all_repos — 전사 /repositories 커서 enum + visibility 필터
# ---------------------------------------------------------------------------

def test_iter_all_repos_paginates_and_filters_visibility(monkeypatch):
    pages = {
        0: [
            {"id": 1, "full_name": "a/pub", "private": False, "visibility": "public"},
            {"id": 2, "full_name": "b/priv", "private": True, "visibility": "private"},
            {"id": 3, "full_name": "c/internal", "private": False, "visibility": "internal"},
        ],
        3: [],  # since=3 → 끝
    }

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/v3/repositories"
        since = int(req.url.params.get("since", "0"))
        return httpx.Response(200, json=pages.get(since, []))

    _patch_client(monkeypatch, handler)
    repos = list(github.iter_all_repos(visibilities=("public", "internal")))
    names = [r.full_name for r in repos]
    assert names == ["a/pub", "c/internal"]  # private 제외
    assert all(r.visibility in ("public", "internal") for r in repos)


def test_iter_all_repos_respects_max_repos(monkeypatch):
    big = [{"id": i, "full_name": f"o/r{i}", "private": False, "visibility": "public"}
           for i in range(1, 11)]

    def handler(req):
        since = int(req.url.params.get("since", "0"))
        return httpx.Response(200, json=[r for r in big if r["id"] > since][:5])

    _patch_client(monkeypatch, handler)
    repos = list(github.iter_all_repos(max_repos=3))
    assert len(repos) == 3


def test_iter_all_repos_visibility_absent_treats_nonprivate_as_candidate(monkeypatch):
    # 구 GHES: visibility 필드 없음 → private 아니면 후보(공개/내부 구분 불가)
    page = [
        {"id": 1, "full_name": "a/x", "private": False},
        {"id": 2, "full_name": "b/y", "private": True},
    ]

    def handler(req):
        since = int(req.url.params.get("since", "0"))
        return httpx.Response(200, json=[r for r in page if r["id"] > since])

    _patch_client(monkeypatch, handler)
    names = [r.full_name for r in github.iter_all_repos()]
    assert names == ["a/x"]


# ---------------------------------------------------------------------------
# code_search — Phase1 빠른 선별
# ---------------------------------------------------------------------------

def test_code_search_returns_candidates(monkeypatch):
    def handler(req):
        assert req.url.path == "/api/v3/search/code"
        assert req.url.params.get("q") == "AKIA"
        return httpx.Response(200, json={
            "total_count": 2,
            "items": [
                {"path": "config.py", "repository": {"full_name": "a/x"}},
                {"path": ".env", "repository": {"full_name": "b/y"}},
            ],
        })

    _patch_client(monkeypatch, handler)
    hits = github.code_search("AKIA")
    assert {(h.repo, h.path) for h in hits} == {("a/x", "config.py"), ("b/y", ".env")}


def test_code_search_422_returns_empty(monkeypatch):
    # 코드서치 인덱싱 미활성/쿼리거부 → 422. raise 안 하고 빈 결과.
    def handler(req):
        return httpx.Response(422, json={"message": "Validation Failed"})

    _patch_client(monkeypatch, handler)
    assert github.code_search("AKIA") == []


def test_code_search_403_raises(monkeypatch):
    # rate-limit/권한 실패는 후보 없음이 아니라 API 검색 실패로 fail-closed.
    def handler(req):
        return httpx.Response(403, json={"message": "rate limited"})

    _patch_client(monkeypatch, handler)
    with pytest.raises(httpx.HTTPStatusError):
        github.code_search("AKIA")


# ---------------------------------------------------------------------------
# repo_meta — size/pushed/archived/visibility
# ---------------------------------------------------------------------------

def test_repo_meta_returns_fields(monkeypatch):
    def handler(req):
        assert req.url.path == "/api/v3/repos/a/x"
        return httpx.Response(200, json={
            "full_name": "a/x", "default_branch": "develop",
            "private": False, "visibility": "internal",
            "archived": False, "size": 1234, "pushed_at": "2026-05-01T00:00:00Z",
        })

    _patch_client(monkeypatch, handler)
    m = github.repo_meta("a/x")
    assert m.full_name == "a/x"
    assert m.default_branch == "develop"
    assert m.visibility == "internal"
    assert m.size_kb == 1234


def test_repo_meta_404_returns_none(monkeypatch):
    def handler(req):
        return httpx.Response(404, json={"message": "Not Found"})

    _patch_client(monkeypatch, handler)
    assert github.repo_meta("a/missing") is None


def test_repo_head_sha_uses_default_branch_for_head(monkeypatch):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.path)
        if req.url.path == "/api/v3/repos/a/x":
            return httpx.Response(200, json={
                "full_name": "a/x",
                "default_branch": "develop",
                "private": False,
                "archived": False,
                "size": 1,
            })
        assert req.url.path == "/api/v3/repos/a/x/git/ref/heads/develop"
        return httpx.Response(200, json={"object": {"sha": "abc123"}})

    _patch_client(monkeypatch, handler)
    assert github.repo_head_sha("a/x", "HEAD") == "abc123"
    assert calls == [
        "/api/v3/repos/a/x",
        "/api/v3/repos/a/x/git/ref/heads/develop",
    ]


def test_list_paths_matching_ref_404_raises(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/v3/repos/o/r/git/ref/heads/main"
        return httpx.Response(404, json={"message": "Not Found"})

    _patch_client(monkeypatch, handler)
    with pytest.raises(httpx.HTTPStatusError):
        github.list_paths_matching("o/r", "main", hot_paths=[".env"])


def test_list_paths_matching_quotes_slash_branch_names(monkeypatch):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        raw_path = req.url.raw_path.decode("ascii").split("?", 1)[0]
        calls.append(raw_path)
        if raw_path == "/api/v3/repos/o/r/git/ref/heads/feature%2Fsecrets":
            return httpx.Response(200, json={"object": {"sha": "abc123"}})
        assert raw_path == "/api/v3/repos/o/r/git/trees/abc123"
        return httpx.Response(
            200,
            json={"tree": [{"type": "blob", "path": "config/prod.env", "sha": "sha-env", "size": 10}]},
        )

    _patch_client(monkeypatch, handler)
    out = github.list_paths_matching("o/r", "feature/secrets", hot_paths=["prod.env"])
    assert calls == [
        "/api/v3/repos/o/r/git/ref/heads/feature%2Fsecrets",
        "/api/v3/repos/o/r/git/trees/abc123",
    ]
    assert [(b.path, b.sha, b.ref) for b in out] == [
        ("config/prod.env", "sha-env", "abc123"),
    ]


def test_list_branches_returns_bounded_branch_heads(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/v3/repos/o/r/branches"
        assert req.url.params["per_page"] == "2"
        return httpx.Response(
            200,
            json=[
                {"name": "main", "commit": {"sha": "sha-main"}},
                {"name": "feature/secrets", "commit": {"sha": "sha-feature"}},
                {"name": "ignored", "commit": {"sha": "sha-ignored"}},
            ],
        )

    _patch_client(monkeypatch, handler)
    out = github.list_branches("o/r", limit=2)
    assert [(b.repo, b.name, b.commit_sha) for b in out] == [
        ("o/r", "main", "sha-main"),
        ("o/r", "feature/secrets", "sha-feature"),
    ]


def test_list_tags_returns_bounded_tag_commits(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/v3/repos/o/r/tags"
        assert req.url.params["per_page"] == "2"
        return httpx.Response(
            200,
            json=[
                {"name": "v1.0.0", "commit": {"sha": "sha-v1"}},
                {"name": "release/2026.07", "commit": {"sha": "sha-release"}},
                {"name": "ignored", "commit": {"sha": "sha-ignored"}},
            ],
        )

    _patch_client(monkeypatch, handler)
    out = github.list_tags("o/r", limit=2)
    assert [(t.repo, t.name, t.commit_sha) for t in out] == [
        ("o/r", "v1.0.0", "sha-v1"),
        ("o/r", "release/2026.07", "sha-release"),
    ]


def test_list_commit_paths_matching_uses_commit_tree_directly(monkeypatch):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        raw_path = req.url.raw_path.decode("ascii").split("?", 1)[0]
        calls.append(raw_path)
        assert raw_path == "/api/v3/repos/o/r/git/trees/abc123"
        return httpx.Response(
            200,
            json={
                "tree": [
                    {"type": "blob", "path": "config/prod.env", "sha": "sha-env", "size": 10},
                    {"type": "blob", "path": "README.md", "sha": "sha-readme", "size": 20},
                ],
            },
        )

    _patch_client(monkeypatch, handler)
    out = github.list_commit_paths_matching("o/r", "abc123", hot_paths=["prod.env"])
    assert calls == ["/api/v3/repos/o/r/git/trees/abc123"]
    assert [(b.path, b.sha, b.ref) for b in out] == [
        ("config/prod.env", "sha-env", "abc123"),
    ]


def test_list_directory_blobs_dot_lists_root_tree(monkeypatch):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url.path))
        if req.url.path == "/api/v3/repos/o/r/git/ref/heads/main":
            return httpx.Response(200, json={"object": {"sha": "abc123"}})
        assert req.url.path == "/api/v3/repos/o/r/git/trees/abc123"
        return httpx.Response(
            200,
            json={
                "tree": [
                    {"type": "blob", "path": "app.env", "sha": "sha-env", "size": 10},
                    {"type": "blob", "path": "docs/readme.md", "sha": "sha-doc", "size": 20},
                    {"type": "tree", "path": "docs", "sha": "sha-tree"},
                ],
            },
        )

    _patch_client(monkeypatch, handler)
    out = github.list_directory_blobs("o/r", "main", ".")
    assert calls == [
        "/api/v3/repos/o/r/git/ref/heads/main",
        "/api/v3/repos/o/r/git/trees/abc123",
    ]
    assert [(b.path, b.sha) for b in out] == [
        ("app.env", "sha-env"),
        ("docs/readme.md", "sha-doc"),
    ]


def test_list_directory_blobs_keeps_subdirectory_scope(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/v3/repos/o/r/git/ref/heads/main":
            return httpx.Response(200, json={"object": {"sha": "abc123"}})
        assert req.url.path == "/api/v3/repos/o/r/git/trees/abc123"
        return httpx.Response(
            200,
            json={
                "tree": [
                    {"type": "blob", "path": "app.env", "sha": "sha-env", "size": 10},
                    {"type": "blob", "path": "docs/readme.md", "sha": "sha-doc", "size": 20},
                    {"type": "blob", "path": "docs/runbook/prod.env", "sha": "sha-prod", "size": 30},
                ],
            },
        )

    _patch_client(monkeypatch, handler)
    out = github.list_directory_blobs("o/r", "main", "docs")
    assert [(b.path, b.sha) for b in out] == [
        ("docs/readme.md", "sha-doc"),
        ("docs/runbook/prod.env", "sha-prod"),
    ]


def test_list_directory_blobs_resolves_full_tag_ref(monkeypatch):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url.path))
        if req.url.path == "/api/v3/repos/o/r/git/ref/tags/v1.2.3":
            return httpx.Response(200, json={"object": {"type": "commit", "sha": "abc123"}})
        assert req.url.path == "/api/v3/repos/o/r/git/trees/abc123"
        return httpx.Response(
            200,
            json={
                "tree": [
                    {"type": "blob", "path": "app.env", "sha": "sha-env", "size": 10},
                    {"type": "blob", "path": "docs/readme.md", "sha": "sha-doc", "size": 20},
                ],
            },
        )

    _patch_client(monkeypatch, handler)
    out = github.list_directory_blobs("o/r", "refs/tags/v1.2.3", ".")
    assert calls == [
        "/api/v3/repos/o/r/git/ref/tags/v1.2.3",
        "/api/v3/repos/o/r/git/trees/abc123",
    ]
    assert [(b.path, b.sha, b.ref) for b in out] == [
        ("app.env", "sha-env", "abc123"),
        ("docs/readme.md", "sha-doc", "abc123"),
    ]


def test_list_directory_blobs_dereferences_annotated_tag(monkeypatch):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url.path))
        if req.url.path == "/api/v3/repos/o/r/git/ref/tags/v2.0.0":
            return httpx.Response(200, json={"object": {"type": "tag", "sha": "tagobj123"}})
        if req.url.path == "/api/v3/repos/o/r/git/tags/tagobj123":
            return httpx.Response(200, json={"object": {"type": "commit", "sha": "commit456"}})
        assert req.url.path == "/api/v3/repos/o/r/git/trees/commit456"
        return httpx.Response(
            200,
            json={"tree": [{"type": "blob", "path": "prod.env", "sha": "sha-prod", "size": 8}]},
        )

    _patch_client(monkeypatch, handler)
    out = github.list_directory_blobs("o/r", "refs/tags/v2.0.0", ".")
    assert calls == [
        "/api/v3/repos/o/r/git/ref/tags/v2.0.0",
        "/api/v3/repos/o/r/git/tags/tagobj123",
        "/api/v3/repos/o/r/git/trees/commit456",
    ]
    assert [(b.path, b.sha, b.ref) for b in out] == [
        ("prod.env", "sha-prod", "commit456"),
    ]


# ---------------------------------------------------------------------------
# v3.78 F1/G2: recent_commit_patches 가 commit author email 캡처 (노이즈 억제용)
# ---------------------------------------------------------------------------

def test_recent_commit_patches_captures_author_email(monkeypatch):
    commits = [{"sha": "s1"}]
    detail = {
        "author": {"login": "octo"},
        "commit": {"message": "fix typo", "author": {"email": "octo@samsung.com"}},
        "files": [{"filename": "a.txt", "patch": "+hello"}],
    }

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/commits"):
            return httpx.Response(200, json=commits)
        return httpx.Response(200, json=detail)

    _patch_client(monkeypatch, handler)
    out = github.recent_commit_patches("o/r", limit=1)
    assert len(out) == 1
    assert out[0].author == "octo"
    assert out[0].author_email == "octo@samsung.com"


def test_recent_commit_patches_preserves_no_patch_file_candidates(monkeypatch):
    commits = [{"sha": "s1"}]
    detail = {
        "author": {"login": "octo"},
        "commit": {"message": "fix binary", "author": {"email": "octo@samsung.com"}},
        "files": [
            {"filename": "app/.env", "patch": "+GITHUB_TOKEN=ghp_xxx"},
            {"filename": "README.md"},
            {"patch": "+orphan"},
        ],
    }

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/commits"):
            return httpx.Response(200, json=commits)
        assert req.url.path.endswith("/commits/s1")
        return httpx.Response(200, json=detail)

    _patch_client(monkeypatch, handler)
    out = github.recent_commit_patches("o/r", limit=1)
    assert len(out) == 1
    assert out[0].files == [
        {"filename": "app/.env", "patch": "+GITHUB_TOKEN=ghp_xxx"},
        {"filename": "README.md", "patch": ""},
    ]
    assert out[0].total_file_count == 2


def test_fetch_commit_patch_preserves_no_patch_file_candidates(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/v3/repos/o/r/commits/s1"
        return httpx.Response(
            200,
            json={
                "sha": "s1",
                "author": {"login": "octo"},
                "commit": {"message": "fix generated file", "author": {"email": "octo@samsung.com"}},
                "files": [
                    {"filename": "app/.env", "patch": "+GITHUB_TOKEN=ghp_xxx"},
                    {"filename": "assets/logo.png"},
                    {"patch": "+orphan"},
                ],
            },
        )

    _patch_client(monkeypatch, handler)
    out = github.fetch_commit_patch("o/r", "s1")
    assert out is not None
    assert out.files == [
        {"filename": "app/.env", "patch": "+GITHUB_TOKEN=ghp_xxx"},
        {"filename": "assets/logo.png", "patch": ""},
    ]
    assert out.total_file_count == 2


def test_fetch_pull_request_files_fetches_pr_files_detail(monkeypatch):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url))
        assert req.url.path == "/api/v3/repos/o/r/pulls/7/files"
        assert req.url.params.get("per_page") == "100"
        assert req.url.params.get("page") == "1"
        return httpx.Response(
            200,
            json=[
                {"filename": "app/.env", "patch": "+GITHUB_TOKEN=ghp_xxx"},
                {"filename": "README.md"},
            ],
        )

    _patch_client(monkeypatch, handler)
    out = github.fetch_pull_request_files("o/r", 7)
    assert out is not None
    assert out.repo == "o/r"
    assert out.sha == "pull-7"
    assert out.message == "pull request #7"
    assert out.files == [
        {"filename": "app/.env", "patch": "+GITHUB_TOKEN=ghp_xxx"},
        {"filename": "README.md", "patch": ""},
    ]
    assert out.total_file_count == 2
    assert out.limit_skipped == 0
    assert out.skipped_files == []
    assert len(calls) == 1


def test_fetch_pull_request_files_preserves_limit_skipped(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/v3/repos/o/r/pulls/7/files"
        return httpx.Response(
            200,
            json=[
                {"filename": "one.env", "patch": "+GITHUB_TOKEN=ghp_one"},
                {"filename": "two.env", "patch": "+GITHUB_TOKEN=ghp_two"},
                {"filename": "three.env", "patch": "+GITHUB_TOKEN=ghp_three"},
            ],
        )

    _patch_client(monkeypatch, handler)
    out = github.fetch_pull_request_files("o/r", 7, max_files=1)
    assert out is not None
    assert out.files == [{"filename": "one.env", "patch": "+GITHUB_TOKEN=ghp_one"}]
    assert out.total_file_count == 3
    assert out.limit_skipped == 2
    assert out.skipped_files == ["two.env", "three.env"]


def test_fetch_pull_request_files_404_returns_none(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/v3/repos/o/r/pulls/404/files"
        return httpx.Response(404, json={"message": "Not Found"})

    _patch_client(monkeypatch, handler)
    assert github.fetch_pull_request_files("o/r", 404) is None


def test_list_pull_requests_fetches_bounded_pr_candidates(monkeypatch):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url))
        assert req.url.path == "/api/v3/repos/o/r/pulls"
        assert req.url.params.get("state") == "open"
        assert req.url.params.get("per_page") == "2"
        assert req.url.params.get("page") == "1"
        return httpx.Response(
            200,
            json=[
                {
                    "number": 7,
                    "title": "deploy secret cleanup",
                    "state": "open",
                    "user": {"login": "octo"},
                    "head": {"sha": "sha-head"},
                    "base": {"ref": "main"},
                },
                {
                    "number": 8,
                    "title": "docs",
                    "state": "open",
                    "user": {"login": "hubot"},
                    "head": {"sha": "sha-docs"},
                    "base": {"ref": "main"},
                },
            ],
        )

    _patch_client(monkeypatch, handler)
    out = github.list_pull_requests("o/r", limit=2)
    assert len(calls) == 1
    assert [pull.number for pull in out] == [7, 8]
    assert out[0].repo == "o/r"
    assert out[0].title == "deploy secret cleanup"
    assert out[0].author == "octo"
    assert out[0].head_sha == "sha-head"
    assert out[0].base_ref == "main"


def test_list_issues_fetches_bounded_issue_candidates_and_skips_prs(monkeypatch):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url))
        assert req.url.path == "/api/v3/repos/o/r/issues"
        assert req.url.params.get("state") == "open"
        assert req.url.params.get("per_page") == "3"
        assert req.url.params.get("page") == "1"
        return httpx.Response(
            200,
            json=[
                {
                    "number": 10,
                    "title": "deploy secret follow-up",
                    "state": "open",
                    "user": {"login": "octo"},
                },
                {
                    "number": 11,
                    "title": "this is a PR and should be skipped",
                    "state": "open",
                    "pull_request": {"url": "https://gh.test/pr/11"},
                    "user": {"login": "hubot"},
                },
                {
                    "number": 12,
                    "title": "vault token rotation",
                    "state": "open",
                    "user": {"login": "security"},
                },
            ],
        )

    _patch_client(monkeypatch, handler)
    out = github.list_issues("o/r", limit=3)
    assert len(calls) == 1
    assert [issue.number for issue in out] == [10, 12]
    assert out[0].repo == "o/r"
    assert out[0].title == "deploy secret follow-up"
    assert out[0].author == "octo"


def test_list_releases_fetches_bounded_release_metadata(monkeypatch):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url))
        assert req.url.path == "/api/v3/repos/o/r/releases"
        assert req.url.params.get("per_page") == "2"
        assert req.url.params.get("page") == "1"
        return httpx.Response(
            200,
            json=[
                {
                    "tag_name": "v2.0.0",
                    "name": "production bundle",
                    "body": "temporary GITHUB_TOKEN=ghp_xxx",
                    "author": {"login": "octo"},
                    "draft": False,
                    "prerelease": False,
                    "assets": [
                        {
                            "name": "deploy.env",
                            "label": "deployment config",
                            "browser_download_url": "https://gh.test/o/r/releases/download/v2/deploy.env",
                            "content_type": "text/plain",
                        },
                    ],
                },
                {
                    "tag_name": "v1.9.0",
                    "name": "older",
                    "body": "",
                    "author": {"login": "octo"},
                    "draft": False,
                    "prerelease": False,
                    "assets": [],
                },
            ],
        )

    _patch_client(monkeypatch, handler)
    out = github.list_releases("o/r", limit=2)
    assert len(calls) == 1
    assert [rel.tag_name for rel in out] == ["v2.0.0", "v1.9.0"]
    assert out[0].repo == "o/r"
    assert out[0].name == "production bundle"
    assert out[0].assets == [{
        "name": "deploy.env",
        "label": "deployment config",
        "browser_download_url": "https://gh.test/o/r/releases/download/v2/deploy.env",
        "content_type": "text/plain",
    }]


def test_fetch_compare_files_fetches_compare_files_detail(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert str(req.url).endswith("/api/v3/repos/o/r/compare/main...feature%2Fbranch")
        return httpx.Response(
            200,
            json={
                "files": [
                    {"filename": "app/.env", "patch": "+GITHUB_TOKEN=ghp_xxx"},
                    {"filename": "README.md"},
                ],
            },
        )

    _patch_client(monkeypatch, handler)
    out = github.fetch_compare_files("o/r", "main...feature/branch")
    assert out is not None
    assert out.repo == "o/r"
    assert out.sha == "compare-main...feature/branch"
    assert out.message == "compare main...feature/branch"
    assert out.files == [
        {"filename": "app/.env", "patch": "+GITHUB_TOKEN=ghp_xxx"},
        {"filename": "README.md", "patch": ""},
    ]
    assert out.total_file_count == 2
    assert out.limit_skipped == 0
    assert out.skipped_files == []


def test_fetch_compare_files_preserves_limit_skipped(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert str(req.url).endswith("/api/v3/repos/o/r/compare/main...feature")
        return httpx.Response(
            200,
            json={
                "files": [
                    {"filename": "one.env", "patch": "+GITHUB_TOKEN=ghp_one"},
                    {"filename": "two.env", "patch": "+GITHUB_TOKEN=ghp_two"},
                    {"filename": "three.env", "patch": "+GITHUB_TOKEN=ghp_three"},
                ],
            },
        )

    _patch_client(monkeypatch, handler)
    out = github.fetch_compare_files("o/r", "main...feature", max_files=1)
    assert out is not None
    assert out.files == [{"filename": "one.env", "patch": "+GITHUB_TOKEN=ghp_one"}]
    assert out.total_file_count == 3
    assert out.limit_skipped == 2
    assert out.skipped_files == ["two.env", "three.env"]


def test_fetch_compare_files_404_returns_none(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/v3/repos/o/r/compare/main...missing"
        return httpx.Response(404, json={"message": "Not Found"})

    _patch_client(monkeypatch, handler)
    assert github.fetch_compare_files("o/r", "main...missing") is None


def test_fetch_release_by_tag_fetches_release_detail(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert str(req.url).endswith("/api/v3/repos/o/r/releases/tags/release%2F2026.07")
        return httpx.Response(
            200,
            json={
                "tag_name": "release/2026.07",
                "name": "July release",
                "body": "temporary GITHUB_TOKEN=ghp_xxx",
                "draft": False,
                "prerelease": True,
                "author": {"login": "octo"},
                "assets": [
                    {
                        "name": "deploy.env",
                        "label": "deployment config",
                        "browser_download_url": "https://gh.test/download/deploy.env",
                        "content_type": "text/plain",
                    },
                ],
            },
        )

    _patch_client(monkeypatch, handler)
    out = github.fetch_release_by_tag("o/r", "release/2026.07")
    assert out is not None
    assert out.repo == "o/r"
    assert out.tag_name == "release/2026.07"
    assert out.name == "July release"
    assert out.author == "octo"
    assert out.prerelease is True
    assert out.assets == [{
        "name": "deploy.env",
        "label": "deployment config",
        "browser_download_url": "https://gh.test/download/deploy.env",
        "content_type": "text/plain",
    }]


def test_fetch_release_by_tag_404_returns_none(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/v3/repos/o/r/releases/tags/missing"
        return httpx.Response(404, json={"message": "Not Found"})

    _patch_client(monkeypatch, handler)
    assert github.fetch_release_by_tag("o/r", "missing") is None


def test_recent_commit_patches_detail_http_error_raises(monkeypatch):
    commits = [{"sha": "s1"}]

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/commits"):
            return httpx.Response(200, json=commits)
        assert req.url.path.endswith("/commits/s1")
        return httpx.Response(500, json={"message": "commit detail timeout"})

    _patch_client(monkeypatch, handler)
    with pytest.raises(httpx.HTTPStatusError):
        github.recent_commit_patches("o/r", limit=1)


def test_recent_commit_patches_stops_at_since_sha(monkeypatch):
    """v3.78 G1: since_sha 만나면 멈춰 새 commit 만 fetch(dedup)."""
    commits = [{"sha": "new2"}, {"sha": "new1"}, {"sha": "old_head"}, {"sha": "older"}]
    details = {
        "new2": {"commit": {"message": "m", "author": {"email": "a@x"}},
                 "files": [{"filename": "f", "patch": "+x"}]},
        "new1": {"commit": {"message": "m", "author": {"email": "a@x"}},
                 "files": [{"filename": "f", "patch": "+y"}]},
    }
    fetched: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/commits"):
            return httpx.Response(200, json=commits)
        sha = req.url.path.rsplit("/", 1)[-1]
        fetched.append(sha)
        return httpx.Response(200, json=details.get(sha, {"commit": {"message": "m"}, "files": []}))

    _patch_client(monkeypatch, handler)
    out = github.recent_commit_patches("o/r", limit=10, since_sha="old_head")
    assert [p.sha for p in out] == ["new2", "new1"]   # old_head 에서 멈춤
    assert "old_head" not in fetched and "older" not in fetched  # detail 도 안 가져옴


def test_fetch_file_at_ref_decodes_base64(monkeypatch):
    """v3.78 G2: contents API base64 → text, ref 전달."""
    import base64 as _b64

    content = _b64.b64encode(b'GITHUB_TOKEN=ghp_realtoken\n').decode()

    def handler(req: httpx.Request) -> httpx.Response:
        assert "/contents/" in req.url.path
        assert req.url.params.get("ref") == "HEAD"
        return httpx.Response(200, json={"encoding": "base64", "content": content})

    _patch_client(monkeypatch, handler)
    text = github.fetch_file_at_ref("o/r", ".env", ref="HEAD")
    assert text is not None and "GITHUB_TOKEN" in text


def test_fetch_file_at_ref_404_returns_none(monkeypatch):
    def handler(req):
        return httpx.Response(404, json={"message": "Not Found"})

    _patch_client(monkeypatch, handler)
    assert github.fetch_file_at_ref("o/r", "gone.txt") is None
    assert github.fetch_file_at_ref_detail("o/r", "gone.txt") == (None, "not_found")


def test_fetch_file_at_ref_directory_returns_none(monkeypatch):
    def handler(req):
        return httpx.Response(200, json=[{"name": "a", "type": "file"}])

    _patch_client(monkeypatch, handler)
    assert github.fetch_file_at_ref("o/r", "somedir") is None
    assert github.fetch_file_at_ref_detail("o/r", "somedir") == (None, "directory")


def test_recent_commit_patches_paginates_when_gap_exceeds_page(monkeypatch):
    """v3.78.1 #G1: 새 commit 이 페이지보다 많아도 since_sha 까지 페이지네이션 — 누락 없음."""
    # 페이지당 2개. 새 commit C1..C4 (HEAD..), 그 다음 페이지에 since_sha=S.
    pages = {
        1: [{"sha": "C1"}, {"sha": "C2"}],
        2: [{"sha": "C3"}, {"sha": "C4"}],
        3: [{"sha": "S"}, {"sha": "OLD"}],
    }

    def detail(sha):
        return {"author": {"login": "u"}, "commit": {"message": "m", "author": {"email": "u@x"}},
                "files": [{"filename": f"{sha}.txt", "patch": f"+{sha}"}]}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/commits"):
            page = int(req.url.params.get("page", "1"))
            return httpx.Response(200, json=pages.get(page, []))
        sha = req.url.path.rsplit("/", 1)[-1]
        return httpx.Response(200, json=detail(sha))

    _patch_client(monkeypatch, handler)
    out = github.recent_commit_patches("o/r", limit=2, since_sha="S")
    shas = [p.sha for p in out]
    assert shas == ["C1", "C2", "C3", "C4"]  # gap 전부 수집, S 에서 멈춤, OLD 안 봄


def test_recent_commit_patches_no_cursor_single_page(monkeypatch):
    """since_sha 없으면 최신 limit 한 페이지만 (페이지네이션 안 함)."""
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/commits"):
            calls.append(int(req.url.params.get("page", "1")))
            return httpx.Response(200, json=[{"sha": "A"}, {"sha": "B"}])
        sha = req.url.path.rsplit("/", 1)[-1]
        return httpx.Response(200, json={"commit": {"message": "m"}, "files": [{"filename": "f", "patch": "+x"}]})

    _patch_client(monkeypatch, handler)
    out = github.recent_commit_patches("o/r", limit=2)
    assert [p.sha for p in out] == ["A", "B"]
    assert calls == [1]  # 한 페이지만
