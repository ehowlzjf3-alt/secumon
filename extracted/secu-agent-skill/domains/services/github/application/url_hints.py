"""GitHub URL/검색어 → 워커 프롬프트용 API 힌트 도출.

`github_task_worker` 진입점 안에 542줄로 들어앉아 있던 블록을 도메인 계층으로 옮겼다.
진입점의 일이 아니다 — URL 을 읽고 어떤 GitHub API 를 때려야 하는지 정하는 건 도메인
지식이고, 워커는 그 결과 문자열을 프롬프트에 실을 뿐이다.

외부 인터페이스는 `github_url_api_hint_text(url)` **하나**다(추출 전에도 워커가 쓰던
심볼은 이것뿐이었다). 나머지 25개 심볼은 이 모듈 내부 구현이다.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


_REPO_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
_NON_REPO_FIRST_SEGMENTS = {
    "about",
    "apps",
    "dashboard",
    "enterprise",
    "explore",
    "features",
    "issues",
    "login",
    "marketplace",
    "notifications",
    "orgs",
    "pricing",
    "pulls",
    "search",
    "settings",
    "topics",
    "users",
}
_NON_REPO_SECOND_SEGMENTS = {
    "followers",
    "following",
    "repositories",
    "settings",
    "teams",
}
_DEEP_FILE_KINDS = {"blob", "raw", "blame"}
_DEEP_PATH_KINDS = _DEEP_FILE_KINDS | {"tree"}
_COMMIT_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,64}$")
_ARCHIVE_SUFFIXES = (".tar.gz", ".zip", ".tgz", ".tar")
_SEARCH_QUALIFIER_RE = re.compile(r"^(?P<key>[A-Za-z][A-Za-z0-9_-]*):(?P<value>.+)$")
_SEARCH_TOKEN_RE = re.compile(r'"[^"]+"|\'[^\']+\'|\S+')
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
_SEARCH_QUERY_TERM_LIMIT = 8
_SEARCH_SKIP_QUALIFIERS = {
    "archived",
    "fork",
    "is",
    "language",
    "mirror",
    "org",
    "pushed",
    "size",
    "sort",
    "stars",
    "type",
    "user",
}


def _path_search_terms(path: str, *, include_filename: bool = True) -> list[str]:
    clean = str(path or "").strip().strip("/")
    if not clean:
        return []
    name = clean.rsplit("/", 1)[-1]
    terms: list[str] = []
    if include_filename and name:
        terms.append(f"filename:{name}")
    if clean and (clean != name or not include_filename):
        terms.append(f"path:{clean}")
    return terms


def _strip_archive_suffix(value: str) -> str:
    text = str(value or "").strip().strip("/")
    lowered = text.lower()
    for suffix in _ARCHIVE_SUFFIXES:
        if lowered.endswith(suffix):
            return text[: -len(suffix)].strip().strip("/")
    return text


def _github_search_path(parts: list[str]) -> bool:
    return (
        (len(parts) >= 1 and parts[0].lower() == "search")
        or (len(parts) >= 3 and parts[2].lower() == "search")
    )


def _first_query_value(params: dict[str, list[str]], name: str) -> str:
    values = params.get(name) or []
    return str(values[0] or "").strip() if values else ""


def _github_code_search_url(params: dict[str, list[str]], parts: list[str]) -> bool:
    if not _github_search_path(parts):
        return False
    if not _first_query_value(params, "q"):
        return False
    types = {
        str(v or "").strip().lower()
        for v in (params.get("type") or [])
        if str(v or "").strip()
    }
    return not types or "code" in types


def _clean_search_token(token: str) -> str:
    value = str(token or "").strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1].strip()
    return value


def _safe_search_value(value: str, *, path_like: bool = False) -> str | None:
    text = _clean_search_token(value)
    if not text or len(text) > 180 or _CONTROL_CHAR_RE.search(text):
        return None
    if path_like:
        if (
            "\\" in text
            or text.startswith("/")
            or any(part in {"", ".", ".."} for part in text.split("/"))
        ):
            return None
    return text


def _repo_qualifier_value(value: str) -> str | None:
    raw = _clean_search_token(value).strip("/")
    parts = [p.strip() for p in raw.split("/") if p.strip()]
    if len(parts) != 2:
        return None
    owner, repo = parts
    if repo.endswith(".git"):
        repo = repo[:-4]
    if not (_REPO_SEGMENT_RE.fullmatch(owner) and _REPO_SEGMENT_RE.fullmatch(repo)):
        return None
    if (
        owner.lower() in _NON_REPO_FIRST_SEGMENTS
        or repo.lower() in _NON_REPO_SECOND_SEGMENTS
    ):
        return None
    return f"{owner}/{repo}" if repo else None


def _org_qualifier_value(value: str) -> str | None:
    raw = _clean_search_token(value).strip("/")
    if "/" in raw or not _REPO_SEGMENT_RE.fullmatch(raw):
        return None
    if raw.lower() in _NON_REPO_FIRST_SEGMENTS:
        return None
    return raw


def _append_unique(values: list[str], value: str) -> None:
    if value and value not in values:
        values.append(value)


def _github_search_query_hints(query: str) -> dict[str, Any]:
    repos: list[str] = []
    orgs: list[str] = []
    terms: list[str] = []
    hot_paths: list[str] = []
    for raw_token in _SEARCH_TOKEN_RE.findall(str(query or "")):
        token = _clean_search_token(raw_token)
        if not token or token.upper() in {"AND", "OR", "NOT"} or token.startswith("-"):
            continue
        match = _SEARCH_QUALIFIER_RE.match(token)
        if match:
            key = str(match.group("key") or "").strip().lower()
            value = str(match.group("value") or "").strip()
            if key == "repo":
                repo = _repo_qualifier_value(value)
                if repo:
                    _append_unique(repos, repo)
                continue
            if key in {"org", "user"}:
                org = _org_qualifier_value(value)
                if org:
                    _append_unique(orgs, org)
                continue
            if key in _SEARCH_SKIP_QUALIFIERS:
                continue
            if key in {"filename", "path"}:
                cleaned = _safe_search_value(value, path_like=(key == "path"))
                if cleaned:
                    _append_unique(terms, f"{key}:{cleaned}")
                    _append_unique(hot_paths, cleaned)
                continue
            if key == "extension":
                cleaned = _safe_search_value(value)
                if cleaned:
                    _append_unique(terms, f"{key}:{cleaned}")
                continue
            continue
        cleaned = _safe_search_value(token)
        if cleaned:
            _append_unique(terms, cleaned)
        if len(terms) >= _SEARCH_QUERY_TERM_LIMIT:
            break
    return {
        "repo": repos[0] if len(repos) == 1 else None,
        "org": orgs[0] if len(orgs) == 1 else None,
        "code_search_terms": terms[:_SEARCH_QUERY_TERM_LIMIT],
        "hot_paths": hot_paths[:_SEARCH_QUERY_TERM_LIMIT],
    }


def _github_url_api_hints(url: str) -> dict[str, Any]:
    parsed = urlparse(str(url or ""))
    params = parse_qs(parsed.query, keep_blank_values=False)
    parts = [
        unquote(part).strip()
        for part in parsed.path.split("/")
        if unquote(part).strip()
    ]
    out: dict[str, Any] = {
        "org": None,
        "repo": None,
        "ref": None,
        "path": None,
        "code_search_terms": [],
        "hot_paths": [],
        "file_paths": [],
        "directory_paths": [],
        "commit_shas": [],
        "include_commit_list": False,
        "pull_numbers": [],
        "include_pull_requests": False,
        "issue_numbers": [],
        "include_issues": False,
        "compare_refs": [],
        "release_tags": [],
        "include_releases": False,
        "include_branches": False,
        "include_tags": False,
        "search_query_terms": False,
    }
    search_hints: dict[str, Any] = {}
    if _github_code_search_url(params, parts):
        search_hints = _github_search_query_hints(_first_query_value(params, "q"))
    if len(parts) < 2:
        if search_hints.get("repo"):
            out["repo"] = search_hints["repo"]
            out["code_search_terms"] = list(search_hints.get("code_search_terms") or [])
            out["hot_paths"] = list(search_hints.get("hot_paths") or [])
            out["search_query_terms"] = bool(out["code_search_terms"])
        elif search_hints.get("org") and search_hints.get("code_search_terms"):
            out["org"] = search_hints["org"]
            out["code_search_terms"] = list(search_hints.get("code_search_terms") or [])
            out["hot_paths"] = list(search_hints.get("hot_paths") or [])
            out["search_query_terms"] = True
        return out
    owner = parts[0].strip()
    repo = parts[1].strip()
    if owner.lower() in _NON_REPO_FIRST_SEGMENTS:
        if search_hints.get("repo"):
            out["repo"] = search_hints["repo"]
            out["code_search_terms"] = list(search_hints.get("code_search_terms") or [])
            out["hot_paths"] = list(search_hints.get("hot_paths") or [])
            out["search_query_terms"] = bool(out["code_search_terms"])
        elif search_hints.get("org") and search_hints.get("code_search_terms"):
            out["org"] = search_hints["org"]
            out["code_search_terms"] = list(search_hints.get("code_search_terms") or [])
            out["hot_paths"] = list(search_hints.get("hot_paths") or [])
            out["search_query_terms"] = True
        return out
    if repo.lower() in _NON_REPO_SECOND_SEGMENTS:
        return out
    if not (_REPO_SEGMENT_RE.fullmatch(owner) and _REPO_SEGMENT_RE.fullmatch(repo)):
        return out
    if repo.endswith(".git"):
        repo = repo[:-4]
    if not repo:
        return out
    out["repo"] = f"{owner}/{repo}"
    if search_hints.get("code_search_terms"):
        out["code_search_terms"] = list(search_hints.get("code_search_terms") or [])
        out["hot_paths"] = list(search_hints.get("hot_paths") or [])
        out["search_query_terms"] = True
    if len(parts) >= 5 and parts[2].lower() in _DEEP_PATH_KINDS:
        if (
            len(parts) >= 6
            and parts[3].lower() == "refs"
            and parts[4].lower() in {"heads", "tags"}
        ):
            ref = "/".join(part.strip("/") for part in parts[3:6] if part.strip("/")).strip("/")
            path = "." if len(parts) == 6 and parts[2].lower() == "tree" else (
                "/".join(part.strip("/") for part in parts[6:] if part.strip("/")).strip("/")
            )
        else:
            ref = parts[3].strip()
            path = "/".join(part.strip("/") for part in parts[4:] if part.strip("/")).strip("/")
        if ref and path:
            out["ref"] = ref
            out["path"] = path
            if parts[2].lower() in _DEEP_FILE_KINDS:
                out["file_paths"] = [path]
            elif parts[2].lower() == "tree":
                out["directory_paths"] = [path]
    elif len(parts) == 4 and parts[2].lower() == "tree":
        ref = parts[3].strip()
        if ref:
            out["ref"] = ref
            out["path"] = "."
            out["directory_paths"] = ["."]
    elif len(parts) >= 4 and parts[2].lower() == "archive":
        archive_ref = _strip_archive_suffix(
            "/".join(part.strip("/") for part in parts[3:] if part.strip("/"))
        )
        if (
            len(parts) >= 6
            and parts[3].lower() == "refs"
            and parts[4].lower() in {"heads", "tags"}
        ):
            ref_tail = _strip_archive_suffix(
                "/".join(part.strip("/") for part in parts[5:] if part.strip("/"))
            )
            archive_ref = f"refs/{parts[4].lower()}/{ref_tail}" if ref_tail else ""
        if archive_ref:
            out["ref"] = archive_ref
            out["path"] = "."
            out["directory_paths"] = ["."]
    elif len(parts) >= 4 and parts[2].lower() in {"commit", "commits"}:
        sha = parts[3].strip()
        if _COMMIT_SHA_RE.fullmatch(sha):
            out["commit_shas"] = [sha]
    elif len(parts) == 3 and parts[2].lower() == "commits":
        out["include_commit_list"] = True
    elif len(parts) >= 4 and parts[2].lower() in {"pull", "pulls"}:
        number = parts[3].strip()
        if number.isdigit() and int(number) > 0:
            out["pull_numbers"] = [int(number)]
    elif len(parts) == 3 and parts[2].lower() == "pulls":
        out["include_pull_requests"] = True
    elif len(parts) >= 4 and parts[2].lower() in {"issue", "issues"}:
        number = parts[3].strip()
        if number.isdigit() and int(number) > 0:
            out["issue_numbers"] = [int(number)]
    elif len(parts) == 3 and parts[2].lower() == "issues":
        out["include_issues"] = True
    elif len(parts) >= 4 and parts[2].lower() == "compare":
        compare_ref = "/".join(part.strip("/") for part in parts[3:] if part.strip("/")).strip("/")
        if compare_ref and compare_ref.count("...") == 1:
            out["compare_refs"] = [compare_ref]
    elif len(parts) >= 5 and parts[2].lower() == "releases" and parts[3].lower() == "tag":
        tag_name = "/".join(part.strip("/") for part in parts[4:] if part.strip("/")).strip("/")
        if tag_name:
            out["release_tags"] = [tag_name]
    elif len(parts) >= 5 and parts[2].lower() == "releases" and parts[3].lower() == "download":
        tag_parts = parts[4:-1] if len(parts) >= 6 else parts[4:]
        tag_name = "/".join(part.strip("/") for part in tag_parts if part.strip("/")).strip("/")
        if tag_name:
            out["release_tags"] = [tag_name]
    elif len(parts) == 3 and parts[2].lower() == "releases":
        out["include_releases"] = True
    elif len(parts) == 3 and parts[2].lower() == "branches":
        out["include_branches"] = True
    elif len(parts) == 3 and parts[2].lower() == "tags":
        out["include_tags"] = True
    return out


def _github_url_repo_hint(url: str) -> str | None:
    repo = _github_url_api_hints(url).get("repo")
    return str(repo) if repo else None


def github_url_api_hint_text(url: str) -> str:
    hints = _github_url_api_hints(url)
    repo = hints.get("repo")
    if repo:
        # api_search_first 는 은퇴했다(워커에서 전역 code_search 금지).
        args = [f"repos={[repo]!r}"]
        if hints.get("ref"):
            args.append(f"ref={str(hints['ref'])!r}")
        exact_scope = bool(
            hints.get("file_paths")
            or hints.get("directory_paths")
            or hints.get("include_commit_list")
            or hints.get("include_pull_requests")
            or hints.get("include_issues")
            or hints.get("release_tags")
            or hints.get("include_releases")
            or hints.get("include_branches")
            or hints.get("include_tags")
        )
        if hints.get("code_search_terms") and not exact_scope:
            args.append(f"code_search_terms={hints['code_search_terms']!r}")
        if (
            not exact_scope
            and (
                hints.get("hot_paths")
                or (hints.get("search_query_terms") and hints.get("code_search_terms"))
            )
        ):
            args.append(f"hot_paths={hints['hot_paths']!r}")
        if hints.get("file_paths"):
            args.append(f"file_paths={hints['file_paths']!r}")
            args.append("code_search_terms=[]")
            args.append("hot_paths=[]")
            args.append("include_commits=False")
        if hints.get("directory_paths"):
            args.append(f"directory_paths={hints['directory_paths']!r}")
            args.append("code_search_terms=[]")
            args.append("hot_paths=[]")
            args.append("include_commits=False")
        if hints.get("commit_shas"):
            args.append(f"commit_shas={hints['commit_shas']!r}")
            args.append("code_search_terms=[]")
            args.append("hot_paths=[]")
            args.append("include_commits=False")
        if hints.get("include_commit_list"):
            args.append("include_commit_list=True")
            args.append("code_search_terms=[]")
            args.append("hot_paths=[]")
            args.append("include_commits=False")
        if hints.get("pull_numbers"):
            args.append(f"pull_numbers={hints['pull_numbers']!r}")
            args.append("code_search_terms=[]")
            args.append("hot_paths=[]")
            args.append("include_commits=False")
        if hints.get("include_pull_requests"):
            args.append("include_pull_requests=True")
            args.append("code_search_terms=[]")
            args.append("hot_paths=[]")
            args.append("include_commits=False")
        if hints.get("issue_numbers"):
            args.append(f"issue_numbers={hints['issue_numbers']!r}")
            args.append("code_search_terms=[]")
            args.append("hot_paths=[]")
            args.append("include_commits=False")
        if hints.get("include_issues"):
            args.append("include_issues=True")
            args.append("code_search_terms=[]")
            args.append("hot_paths=[]")
            args.append("include_commits=False")
        if hints.get("compare_refs"):
            args.append(f"compare_refs={hints['compare_refs']!r}")
            args.append("code_search_terms=[]")
            args.append("hot_paths=[]")
            args.append("include_commits=False")
        if hints.get("release_tags"):
            args.append(f"release_tags={hints['release_tags']!r}")
            args.append("code_search_terms=[]")
            args.append("hot_paths=[]")
            args.append("include_commits=False")
        if hints.get("include_releases"):
            args.append("include_releases=True")
            args.append("code_search_terms=[]")
            args.append("hot_paths=[]")
            args.append("include_commits=False")
        if hints.get("include_branches"):
            args.append("include_branches=True")
            args.append("code_search_terms=[]")
            args.append("include_commits=False")
        if hints.get("include_tags"):
            args.append("include_tags=True")
            args.append("code_search_terms=[]")
            args.append("include_commits=False")
        if hints.get("file_paths"):
            return (
                "URL에서 owner/repo/ref/path 후보가 보이면 "
                f"github_task_scan({', '.join(args)})를 먼저 호출한다. "
                "보이는 파일 content detail을 API로 정확히 조회해 실제 증거를 보강하고, 그 뒤에만 "
                "브라우저/웹 도구를 사용한다."
            )
        if hints.get("directory_paths"):
            return (
                "URL에서 owner/repo/ref/tree path 후보가 보이면 "
                f"github_task_scan({', '.join(args)})를 먼저 호출한다. "
                "보이는 디렉터리 tree 후보를 API로 정확히 조회해 해당 경로 아래 파일 detail만 보강하고, "
                "그 뒤에만 브라우저/웹 도구를 사용한다."
            )
        if hints.get("release_tags"):
            return (
                "URL에서 owner/repo release tag 후보가 보이면 "
                f"github_task_scan({', '.join(args)})를 먼저 호출한다. "
                "보이는 release note와 asset metadata detail을 API로 정확히 조회해 실제 증거를 보강하고, "
                "그 뒤에만 브라우저/웹 도구를 사용한다."
            )
        if hints.get("include_commit_list"):
            return (
                "URL에서 owner/repo commits 목록 후보가 보이면 "
                f"github_task_scan({', '.join(args)})를 먼저 호출한다. "
                "보이는 commit 목록을 API로 먼저 열거한 뒤 commit patch detail만 보강하고, "
                "그 뒤에만 브라우저/웹 도구를 사용한다."
            )
        if hints.get("include_pull_requests"):
            return (
                "URL에서 owner/repo pull requests 목록 후보가 보이면 "
                f"github_task_scan({', '.join(args)})를 먼저 호출한다. "
                "보이는 PR 목록을 API로 먼저 열거한 뒤 PR files patch detail만 보강하고, "
                "그 뒤에만 브라우저/웹 도구를 사용한다."
            )
        if hints.get("include_issues"):
            return (
                "URL에서 owner/repo issues 목록 후보가 보이면 "
                f"github_task_scan({', '.join(args)})를 먼저 호출한다. "
                "보이는 issue 목록을 API로 먼저 열거한 뒤 issue body/comment detail만 보강하고, "
                "그 뒤에만 브라우저/웹 도구를 사용한다."
            )
        if hints.get("include_releases"):
            return (
                "URL에서 owner/repo releases 목록 후보가 보이면 "
                f"github_task_scan({', '.join(args)})를 먼저 호출한다. "
                "보이는 release 목록을 API로 먼저 열거한 뒤 release note와 asset metadata detail만 보강하고, "
                "그 뒤에만 브라우저/웹 도구를 사용한다."
            )
        if hints.get("include_branches"):
            return (
                "URL에서 owner/repo branches 목록 후보가 보이면 "
                f"github_task_scan({', '.join(args)})를 먼저 호출한다. "
                "보이는 branch 목록을 API로 먼저 열거한 뒤 branch별 bounded hot-path blob detail만 보강하고, "
                "그 뒤에만 브라우저/웹 도구를 사용한다."
            )
        if hints.get("include_tags"):
            return (
                "URL에서 owner/repo tags 목록 후보가 보이면 "
                f"github_task_scan({', '.join(args)})를 먼저 호출한다. "
                "보이는 tag 목록을 API로 먼저 열거한 뒤 tag별 bounded hot-path blob detail만 보강하고, "
                "그 뒤에만 브라우저/웹 도구를 사용한다."
            )
        return (
            "URL에서 owner/repo 후보가 보이면 "
            f"github_task_scan({', '.join(args)})를 먼저 호출한다. "
            "API 검색 후보를 먼저 고른 뒤 파일/커밋 상세조회로 실제 증거를 보강하고, 그 뒤에만 "
            "브라우저/웹 도구를 사용한다."
        )
    org = hints.get("org")
    if org and hints.get("code_search_terms"):
        args = [
            f"org={str(org)!r}",
            f"code_search_terms={hints['code_search_terms']!r}",
        ]
        if hints.get("hot_paths") or hints.get("search_query_terms"):
            args.append(f"hot_paths={hints['hot_paths']!r}")
        return (
            "URL에서 단일 owner code search 후보가 보이면 "
            f"github_task_scan({', '.join(args)})를 먼저 호출한다. "
            "보이는 검색어로 API 검색 후보를 먼저 고른 뒤 파일 상세조회로 실제 증거를 보강하고, "
            "그 뒤에만 브라우저/웹 도구를 사용한다."
        )
    return (
        "URL에서 owner/repo를 바로 알 수 없으면 web_site_sweep digest에서 "
        "GitHub canonical repo URL을 확인한 뒤 "
        "github_task_scan(...)을 호출한다. "
        "repo 식별자가 없으면 현재 URL 1건의 sweep/browser 증거 안에서만 판단한다."
    )
