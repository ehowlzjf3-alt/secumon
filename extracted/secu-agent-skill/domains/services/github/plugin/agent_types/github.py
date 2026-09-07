"""사내 GitHub Enterprise 에이전트.

REST v3 API 직접 호출 (GraphQL은 권한/스코프 복잡). 읽기 전용.

흐름:
  1. list_repos(org) — 최근 push 순 N개
  2. list_paths(repo, refs=['HEAD'], hot_paths=['.env','Jenkinsfile',...])
     → repo tree에서 hot_path 매칭 파일 list
  3. fetch_blob(repo, ref, path) — 텍스트
  4. (옵션) recent_commits scan — 마지막 커밋 patch 본문에 시크릿 노출 흔히 있음

agent는 위 4개 모두 도구로 노출.
"""
from __future__ import annotations

import base64
import logging
import os
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)


def _int_env(name: str, default: int, *, allow_zero: bool = False) -> int:
    """정수 env override. 미설정/파싱실패/하한미만 → default.

    `allow_zero` 는 "0 = 기능 끄기"가 의미 있는 값(재시도 횟수 등)에 쓴다.
    그게 아니면 0 은 오설정으로 보고 default 로 되돌린다.
    """
    try:
        value = int((os.environ.get(name) or "").strip())
    except ValueError:
        return default
    return value if value >= (0 if allow_zero else 1) else default


def _client() -> httpx.Client:
    base = os.environ.get("GITHUB_BASE_URL", "").rstrip("/")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not base or not token:
        raise RuntimeError("GITHUB_BASE_URL / GITHUB_TOKEN 미설정")
    return httpx.Client(
        base_url=base,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "secu-agent/0.1",
        },
        timeout=20.0,
        verify=False,      # 사내 self-signed 가능성
        trust_env=False,   # v3.70: MWG 프록시 우회 — 사내 github 직결 (v3.45 정책)
    )


@dataclass(slots=True)
class GhRepo:
    full_name: str
    default_branch: str
    private: bool
    archived: bool
    pushed_at: str | None
    visibility: str | None = None   # v3.70: public/internal/private (GHES). None=구버전 미제공
    size_kb: int = 0                # v3.70: repo size (KB) — size캡/우선순위용


@dataclass(slots=True)
class GhCodeHit:
    repo: str   # owner/name
    path: str


@dataclass(slots=True)
class GhBlobRef:
    repo: str            # owner/name
    ref: str             # branch or sha
    path: str
    sha: str
    size: int


@dataclass(slots=True)
class GhCommitPatch:
    repo: str
    sha: str
    author: str | None
    message: str
    files: list[dict[str, str]] = field(default_factory=list)  # [{filename, patch}]
    author_email: str | None = None  # v3.78: commit author 이메일 (노이즈 억제용)
    total_file_count: int | None = None
    limit_skipped: int = 0
    skipped_files: list[str] = field(default_factory=list)


@dataclass(slots=True)
class GhPullRequest:
    repo: str
    number: int
    title: str
    state: str | None
    author: str | None
    head_sha: str | None = None
    base_ref: str | None = None


@dataclass(slots=True)
class GhIssue:
    repo: str
    number: int
    title: str
    state: str | None
    author: str | None


@dataclass(slots=True)
class GhIssueDetail:
    repo: str
    number: int
    title: str
    body: str
    state: str | None
    author: str | None
    comments: list[dict[str, str]] = field(default_factory=list)  # [{author, body}]


@dataclass(slots=True)
class GhReleaseDetail:
    repo: str
    tag_name: str
    name: str
    body: str
    author: str | None
    draft: bool
    prerelease: bool
    assets: list[dict[str, str]] = field(default_factory=list)


@dataclass(slots=True)
class GhBranch:
    repo: str
    name: str
    commit_sha: str


@dataclass(slots=True)
class GhTag:
    repo: str
    name: str
    commit_sha: str


def list_repos(org: str, *, limit: int = 200, include_archived: bool = False) -> list[GhRepo]:
    out: list[GhRepo] = []
    with _client() as c:
        page = 1
        while len(out) < limit:
            r = c.get(f"/orgs/{org}/repos", params={
                "per_page": 100, "page": page, "sort": "pushed", "direction": "desc",
            })
            r.raise_for_status()
            batch = r.json()
            if not batch:
                break
            for repo in batch:
                if not include_archived and repo.get("archived"):
                    continue
                out.append(GhRepo(
                    full_name=repo["full_name"],
                    default_branch=repo.get("default_branch") or "main",
                    private=repo.get("private", True),
                    archived=repo.get("archived", False),
                    pushed_at=repo.get("pushed_at"),
                ))
                if len(out) >= limit:
                    break
            page += 1
    return out


def _is_candidate_visibility(repo: dict, allowed: set[str]) -> bool:
    """v3.70: 과노출(공개/내부) 후보인가. visibility 필드 없으면 private 아닌 것 = 후보."""
    vis = repo.get("visibility")
    if vis:
        return vis in allowed
    return not repo.get("private", True)


def iter_all_repos(
    *,
    visibilities: Iterable[str] = ("public", "internal"),
    since: int = 0,
    per_page: int = 100,
    max_repos: int | None = None,
    include_archived: bool = True,
):
    """v3.70: 전사 `/repositories` 커서 enum (org 무관). 토큰이 보는 모든 repo 를
    id 커서로 페이징하며 과노출(public/internal) 후보만 yield. 수천~수만 대비 generator."""
    allowed = set(visibilities)
    cursor = since
    yielded = 0
    with _client() as c:
        while True:
            r = c.get("/repositories", params={"since": cursor, "per_page": per_page})
            r.raise_for_status()
            batch = r.json()
            if not batch:
                break
            advanced = cursor
            for repo in batch:
                advanced = max(advanced, int(repo.get("id", advanced)))
                if not include_archived and repo.get("archived"):
                    continue
                if not _is_candidate_visibility(repo, allowed):
                    continue
                yield GhRepo(
                    full_name=repo["full_name"],
                    default_branch=repo.get("default_branch") or "main",
                    private=repo.get("private", True),
                    archived=repo.get("archived", False),
                    pushed_at=repo.get("pushed_at"),
                    visibility=repo.get("visibility"),
                    size_kb=int(repo.get("size", 0)),
                )
                yielded += 1
                if max_repos and yielded >= max_repos:
                    return
            if advanced == cursor:  # id 안 늘면 무한루프 방지
                break
            cursor = advanced


def _secondary_wait(attempt: int) -> float:
    """secondary rate limit 회복 대기(초). **지수 백오프가 아니다.**

    이 제한은 시간창 기반이라 "조금씩 늘려가며 두드리기" 가 안 통한다 — 창이 열릴 때까지는
    몇 번을 쳐도 403 이다. 실측 회복 46.4초(2026-08-22)라 기본 60초를 고정으로 기다린다.
    재시도마다 조금씩 키우는 건(60·75·90) 창이 예상보다 길 때의 여유일 뿐이다.
    """
    base = float(_int_env("SA_GH_SEARCH_SECONDARY_WAIT_SEC", 60))
    return base * (1.0 + 0.25 * attempt)


def _search_rate_limit_wait(resp: httpx.Response, attempt: int) -> float | None:
    """`/search/code` 429/403 이 재시도로 풀리는 건가. 풀리면 대기(초), 아니면 None.

    GitHub 은 검색에 **두 종류**의 제한을 건다.
      - primary  : 분당 쿼터(기본 30, 사내 GHES 는 90). `x-ratelimit-remaining: 0` +
                   `x-ratelimit-reset`(epoch) 로 알려준다.
      - secondary: 연속 호출 속도 제한. 쿼터가 남아 있어도 **403** 으로 막는다.
    실측(2026-07-27): 전역 검색을 붙여 쏘면 쿼터 84/90 이 남았는데도 403 이 났다.
    즉 403 을 권한 실패로 오인하면 안 된다 — 여기서 재시도 가능 여부를 판별한다.

    ## 2026-08-22 실측 — secondary 대기를 지수 백오프로 잡으면 안 된다

    `per_page=100` 연타 10회째에 403 을 재현하고 회복까지 5초 간격으로 폴링했다:

        gh-limited-by: search-elapsed-time-shared-grouped   ← 횟수가 아니라 **누적 검색 소요시간**
        x-ratelimit-remaining: 80                           ← primary 는 멀쩡 (분기 ①을 안 탄다)
        Retry-After: 없음                                    ← GHES 는 이 헤더를 안 준다
        회복까지 46.4초

    구 동작은 `2**attempt` = 1·2·4초(총 7초)라 **원천적으로 못 넘겼다.** 그 결과 2026-08-22
    발견 런에서 21키워드 중 4개(19%)가 0건으로 죽었다(BEGIN OPENSSH/DSA/EC/PGP PRIVATE KEY).
    그 4개는 3초 간격으로 따로 치면 전부 200 이라 **쿼리 문제가 아니었다.**
    → secondary 는 실측 회복시간 이상을 기다린다(`SA_GH_SEARCH_SECONDARY_WAIT_SEC`, 기본 60).
      ⚠️ 이 값을 올리면 `SA_GH_SEARCH_MAX_WAIT_SEC` 예산도 같이 올려야 한다. 안 그러면
      `wait <= wait_budget` 에서 걸러져 **재시도가 아예 안 된다**(대기가 길수록 덜 기다리는 역설).
    """
    if resp.status_code not in (403, 429):
        return None
    retry_after = (resp.headers.get("retry-after") or "").strip()
    if retry_after:
        try:
            return max(0.0, float(retry_after))
        except ValueError:
            pass
    if (resp.headers.get("x-ratelimit-remaining") or "").strip() == "0":
        reset = (resp.headers.get("x-ratelimit-reset") or "").strip()
        try:
            return max(0.0, float(reset) - time.time())
        except ValueError:
            return float(2 ** attempt)
    if resp.status_code == 429:
        return float(2 ** attempt)  # 429 는 정의상 rate-limit — 본문 볼 것 없이 재시도
    # 403 만 애매하다: secondary limit 과 권한 실패가 같은 코드를 쓴다.
    # 헤더가 있으면 헤더로, 없으면 본문 문구로 가른다. `gh-limited-by` 는 GHES 가 실제로
    # 보내는 값이고(2026-08-22 실측: `search-elapsed-time-shared-grouped`) 본문 문구보다
    # 확실하다 — 본문은 문구가 바뀌면 조용히 안 맞게 된다.
    if (resp.headers.get("gh-limited-by") or "").strip():
        return _secondary_wait(attempt)
    body = ""
    try:
        body = resp.text.lower()
    except Exception:  # noqa: BLE001
        pass
    if "secondary rate limit" in body or "abuse detection" in body:
        return _secondary_wait(attempt)
    return None  # 진짜 권한 실패 — 재시도해도 소용없다


def code_search(query: str, *, per_page: int = 50, max_results: int = 100) -> list[GhCodeHit]:
    """v3.70 Phase1: `/search/code` 로 시크릿 패턴 후보 repo/파일 빠른 선별.

    인덱싱 미활성/쿼리거부(422) 는 raise 없이 빈 결과(graceful).
    v3.91: rate-limit(429/secondary 403) 백오프 재시도. 전역 키워드 검색은 연속 호출이라
    이게 없으면 첫 몇 건 뒤 전부 403 으로 죽는다(실측). 대기 총량은 상한을 둬서
    워커가 무한정 매달리지 않게 한다.
    """
    out: list[GhCodeHit] = []
    max_retries = _int_env("SA_GH_SEARCH_MAX_RETRIES", 3, allow_zero=True)
    # ⚠️ 이 예산은 `_secondary_wait` 와 **함께** 움직여야 한다. 60 이면 60초 대기가
    # `wait <= wait_budget` 을 딱 한 번만 통과해 재시도가 1회로 줄고, 조금만 더 올리면
    # 아예 0회가 된다(대기가 길수록 덜 기다리는 역설). 기본 3회 재시도 × 60·75·90 = 225.
    wait_budget = float(_int_env("SA_GH_SEARCH_MAX_WAIT_SEC", 225))
    with _client() as c:
        for attempt in range(max_retries + 1):
            r = c.get("/search/code", params={"q": query, "per_page": per_page})
            if r.status_code == 422:
                logger.info("code_search graceful skip: HTTP %s (%s)", r.status_code, query)
                return out
            if r.status_code in (403, 429) and attempt < max_retries:
                wait = _search_rate_limit_wait(r, attempt)
                if wait is not None and wait <= wait_budget:
                    logger.info(
                        "code_search rate-limited (HTTP %s), %.1fs 후 재시도 %d/%d: %s",
                        r.status_code, wait, attempt + 1, max_retries, query,
                    )
                    time.sleep(wait)
                    wait_budget -= wait
                    continue
            r.raise_for_status()
            for item in r.json().get("items", [])[:max_results]:
                repo = (item.get("repository") or {}).get("full_name")
                path = item.get("path")
                if repo and path:
                    out.append(GhCodeHit(repo=repo, path=path))
            return out
    return out


def repo_meta(full_name: str) -> GhRepo | None:
    """v3.70: repo 메타(size/pushed/archived/visibility/default_branch). 404 → None.

    v3.92 `follow_redirects`: repo 이름변경/이전은 **301** 로 온다. httpx 의
    `raise_for_status` 는 3xx 에서도 터지므로 예전엔 "확인 실패"로 분류돼 접근불가와
    구분이 안 됐다(실측: 큐 감사에서 6건이 이 이유로 판정 보류됐다). 따라가면 새 이름의
    메타가 그대로 나오고, 호출자는 `meta.full_name != 요청 slug` 로 이름변경을 감지한다.
    httpx 는 origin 이 바뀌면 Authorization 을 떼므로 토큰이 외부 호스트로 새지 않는다.
    """
    with _client() as c:
        r = c.get(f"/repos/{full_name}", follow_redirects=True)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        j = r.json()
        return GhRepo(
            full_name=j["full_name"],
            default_branch=j.get("default_branch") or "main",
            private=j.get("private", True),
            archived=j.get("archived", False),
            pushed_at=j.get("pushed_at"),
            visibility=j.get("visibility"),
            size_kb=int(j.get("size", 0)),
        )


def repo_head_sha(full_name: str, ref: str = "HEAD") -> str | None:
    """Return the commit sha for a branch/ref without cloning. 404 → None."""
    branch = (ref or "HEAD").strip()
    if branch.upper() == "HEAD":
        meta = repo_meta(full_name)
        if meta is None:
            return None
        branch = meta.default_branch or "main"
    with _client() as c:
        r = c.get(f"/repos/{full_name}/git/ref/heads/{quote(branch, safe='')}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        sha = ((r.json().get("object") or {}).get("sha") or "").strip()
        return sha or None


def list_branches(repo: str, *, limit: int = 20) -> list[GhBranch]:
    """Return a bounded branch list with each branch head commit sha."""
    out: list[GhBranch] = []
    with _client() as c:
        page = 1
        per_page = min(max(1, limit), 100)
        while len(out) < limit:
            r = c.get(f"/repos/{repo}/branches", params={"per_page": per_page, "page": page})
            if r.status_code == 404:
                return out
            r.raise_for_status()
            batch = r.json()
            if not batch:
                break
            for branch in batch:
                name = str(branch.get("name") or "").strip()
                sha = str(((branch.get("commit") or {}).get("sha") or "")).strip()
                if name and sha:
                    out.append(GhBranch(repo=repo, name=name, commit_sha=sha))
                    if len(out) >= limit:
                        break
            page += 1
    return out


def list_tags(repo: str, *, limit: int = 20) -> list[GhTag]:
    """Return a bounded tag list with each tag target commit sha."""
    out: list[GhTag] = []
    with _client() as c:
        page = 1
        per_page = min(max(1, limit), 100)
        while len(out) < limit:
            r = c.get(f"/repos/{repo}/tags", params={"per_page": per_page, "page": page})
            if r.status_code == 404:
                return out
            r.raise_for_status()
            batch = r.json()
            if not batch:
                break
            for tag in batch:
                name = str(tag.get("name") or "").strip()
                sha = str(((tag.get("commit") or {}).get("sha") or "")).strip()
                if name and sha:
                    out.append(GhTag(repo=repo, name=name, commit_sha=sha))
                    if len(out) >= limit:
                        break
            page += 1
    return out


def list_paths_matching(
    repo: str, ref: str, *, hot_paths: Iterable[str],
) -> list[GhBlobRef]:
    """repo tree 전체 1번에 받아서 hot_path substring 매칭."""
    hot = tuple(p.lower() for p in hot_paths)
    out: list[GhBlobRef] = []
    with _client() as c:
        # 브랜치 → tree sha
        r = c.get(f"/repos/{repo}/git/ref/heads/{quote(str(ref or '').strip(), safe='')}")
        r.raise_for_status()
        commit_sha = r.json()["object"]["sha"]
        r = c.get(f"/repos/{repo}/git/trees/{commit_sha}", params={"recursive": "1"})
        r.raise_for_status()
        body = r.json()
        for ent in body.get("tree", []):
            if ent.get("type") != "blob":
                continue
            path = ent["path"]
            pl = path.lower()
            if any(h in pl for h in hot):
                out.append(GhBlobRef(
                    repo=repo, ref=commit_sha,
                    path=path, sha=ent["sha"], size=ent.get("size", 0),
                ))
    return out


def list_commit_paths_matching(
    repo: str, commit_sha: str, *, hot_paths: Iterable[str],
) -> list[GhBlobRef]:
    """List hot-path blobs directly from a known commit sha tree."""
    commit = str(commit_sha or "").strip()
    if not commit:
        return []
    hot = tuple(p.lower() for p in hot_paths)
    out: list[GhBlobRef] = []
    with _client() as c:
        r = c.get(f"/repos/{repo}/git/trees/{quote(commit, safe='')}", params={"recursive": "1"})
        r.raise_for_status()
        body = r.json()
        for ent in body.get("tree", []):
            if ent.get("type") != "blob":
                continue
            path = ent["path"]
            pl = path.lower()
            if any(h in pl for h in hot):
                out.append(GhBlobRef(
                    repo=repo, ref=commit,
                    path=path, sha=ent["sha"], size=ent.get("size", 0),
                ))
    return out


def _ref_lookup_candidates(ref: str) -> list[tuple[str, str]]:
    value = str(ref or "").strip().strip("/")
    if not value:
        return []
    if value.startswith("refs/"):
        value = value[5:]
    if "/" in value:
        kind, name = value.split("/", 1)
        if kind in {"heads", "tags"} and name:
            return [(kind, name)]
    return [("heads", value), ("tags", value)]


def _resolve_ref_commit_sha(c: httpx.Client, repo: str, ref: str) -> str | None:
    value = str(ref or "").strip()
    if _looks_like_sha(value):
        return value
    for kind, name in _ref_lookup_candidates(value):
        r = c.get(f"/repos/{repo}/git/ref/{kind}/{quote(name, safe='')}")
        if r.status_code == 404:
            continue
        r.raise_for_status()
        obj = r.json().get("object") or {}
        sha = str(obj.get("sha") or "").strip()
        obj_type = str(obj.get("type") or "").strip()
        if obj_type == "tag" and sha:
            tag = c.get(f"/repos/{repo}/git/tags/{quote(sha, safe='')}")
            if tag.status_code == 404:
                return sha
            tag.raise_for_status()
            tag_obj = tag.json().get("object") or {}
            tag_sha = str(tag_obj.get("sha") or "").strip()
            if tag_sha:
                return tag_sha
        if sha:
            return sha
    return None


def list_directory_blobs(repo: str, ref: str, directory: str) -> list[GhBlobRef]:
    """Return blob refs scoped to one repo-relative directory prefix.

    Direct `/tree/<ref>/<path>` URLs already provide the candidate scope. This
    helper lists the repository tree once and returns only files below that
    visible directory instead of doing substring-style hot-path matching.
    """
    clean_dir = str(directory or "").strip().strip("/")
    root_scope = clean_dir in {"", "."}
    if not clean_dir:
        return []
    prefix = clean_dir + "/"
    out: list[GhBlobRef] = []
    with _client() as c:
        ref_name = str(ref or "HEAD").strip() or "HEAD"
        commit_sha = _resolve_ref_commit_sha(c, repo, ref_name)
        if not commit_sha:
            return out
        r = c.get(f"/repos/{repo}/git/trees/{quote(commit_sha, safe='')}", params={"recursive": "1"})
        if r.status_code == 404:
            return out
        r.raise_for_status()
        body = r.json()
        for ent in body.get("tree", []):
            if ent.get("type") != "blob":
                continue
            path = str(ent.get("path") or "")
            if not root_scope and path != clean_dir and not path.startswith(prefix):
                continue
            out.append(GhBlobRef(
                repo=repo,
                ref=commit_sha,
                path=path,
                sha=ent["sha"],
                size=ent.get("size", 0),
            ))
    return out


def _looks_like_sha(value: str) -> bool:
    return bool(value) and all(ch in "0123456789abcdefABCDEF" for ch in value) and 7 <= len(value) <= 64


def fetch_blob_text(repo: str, sha: str, *, max_bytes: int = 512 * 1024) -> str | None:
    with _client() as c:
        r = c.get(f"/repos/{repo}/git/blobs/{sha}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        body = r.json()
        if body.get("encoding") != "base64":
            return None
        raw = base64.b64decode(body["content"])
        if len(raw) > max_bytes:
            raw = raw[:max_bytes]
        if raw[:8192].count(b"\x00") > 4:
            return None
        return raw.decode("utf-8", errors="replace")


def fetch_file_at_ref(
    repo: str, path: str, *, ref: str = "HEAD", max_bytes: int = 512 * 1024,
) -> str | None:
    """contents API 로 path 의 ref(기본 HEAD) 시점 텍스트. v3.78 G2 HEAD 재확인용.

    404(없음)/디렉토리/비-base64/바이너리 → None. GET 전용(record-only)."""
    text, _missing_reason = fetch_file_at_ref_detail(
        repo,
        path,
        ref=ref,
        max_bytes=max_bytes,
    )
    return text


def fetch_file_at_ref_detail(
    repo: str, path: str, *, ref: str = "HEAD", max_bytes: int = 512 * 1024,
) -> tuple[str | None, str | None]:
    """Return `(text, missing_reason)` for HEAD recheck detail refetch.

    `missing_reason='not_found'` is a positive signal that the previous file path
    disappeared. Other reasons mean the API response could not be inspected and
    must not be treated as clean remediation.
    """
    with _client() as c:
        r = c.get(f"/repos/{repo}/contents/{path}", params={"ref": ref})
        if r.status_code == 404:
            return None, "not_found"
        r.raise_for_status()
        body = r.json()
        if isinstance(body, list):  # 디렉토리 리스팅
            return None, "directory"
        if body.get("encoding") != "base64":
            return None, "non_base64"
        raw = base64.b64decode(body["content"])
        if len(raw) > max_bytes:
            raw = raw[:max_bytes]
        if raw[:8192].count(b"\x00") > 4:
            return None, "binary"
        return raw.decode("utf-8", errors="replace"), None


def recent_commit_patches(
    repo: str, *, limit: int = 10, since_sha: str | None = None,
    max_commits: int = 200,
) -> list[GhCommitPatch]:
    """최근 commit patch. 시크릿이 push 된 직후 발견하기 위함. API 는 newest-first.

    since_sha=None: 최신 `limit` commit (단일 페이지).
    since_sha 설정: 그 sha(마지막 스캔 HEAD)를 만날 때까지 **페이지네이션**하며 새 commit 을
    전부 수집(v3.78.1 — gap 이 limit 보다 커도 누락 없음). 안전상 max_commits 로 상한.
    since_sha 가 끝내 안 나오면(force-push/거대 gap) max_commits 까지만 — 호출부가 커서를 그에
    맞춰 전진(persist 성공 후)."""
    out: list[GhCommitPatch] = []
    per_page = limit if since_sha is None else 100
    page = 1
    with _client() as c:
        while True:
            r = c.get(
                f"/repos/{repo}/commits",
                params={"per_page": per_page, "page": page},
            )
            if r.status_code == 404:
                return out
            r.raise_for_status()
            batch = r.json()
            if not batch:
                break
            for c_meta in batch:
                sha = c_meta["sha"]
                if since_sha and sha == since_sha:
                    return out  # 마지막 스캔 지점 도달 — gap 완전 브리지
                detail = c.get(f"/repos/{repo}/commits/{sha}")
                detail.raise_for_status()
                dj = detail.json()
                commit_meta = dj.get("commit") or {}
                files = [
                    {"filename": filename, "patch": f.get("patch", "")}
                    for f in dj.get("files", [])
                    if (filename := f.get("filename"))
                ]
                out.append(GhCommitPatch(
                    repo=repo,
                    sha=sha,
                    author=(dj.get("author") or {}).get("login"),
                    author_email=((commit_meta.get("author") or {}).get("email")) or None,
                    message=commit_meta.get("message", ""),
                    files=files,
                    total_file_count=len(files),
                ))
                if len(out) >= max_commits:
                    return out
            if since_sha is None:
                break  # 커서 없으면 최신 한 페이지로 충분
            page += 1
    return out


def fetch_commit_patch(repo: str, sha: str) -> GhCommitPatch | None:
    """Fetch one commit patch by SHA/ref using the GitHub API.

    This is used for SSO URLs that already point at `/commit/<sha>`: the URL
    itself is the candidate, so we fetch that one detail record instead of
    broad-scanning recent history.
    """
    commit_sha = str(sha or "").strip()
    if not commit_sha:
        return None
    with _client() as c:
        r = c.get(f"/repos/{repo}/commits/{commit_sha}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        dj = r.json()
        commit_meta = dj.get("commit") or {}
        files = [
            {"filename": filename, "patch": f.get("patch", "")}
            for f in dj.get("files", [])
            if (filename := f.get("filename"))
        ]
        return GhCommitPatch(
            repo=repo,
            sha=str(dj.get("sha") or commit_sha),
            author=(dj.get("author") or {}).get("login"),
            author_email=((commit_meta.get("author") or {}).get("email")) or None,
            message=commit_meta.get("message", ""),
            files=files,
            total_file_count=len(files),
        )


def fetch_pull_request_files(repo: str, number: int, *, max_files: int = 300) -> GhCommitPatch | None:
    """Fetch one pull request's changed file patches by API.

    SSO URLs often land directly on `/pull/<number>` or `/pull/<number>/files`.
    That URL is already the candidate scope, so callers should fetch this PR
    files detail instead of broad-scanning recent commits or repository trees.
    404 returns None, mirroring `fetch_commit_patch`.
    """
    try:
        pull_number = int(number)
    except (TypeError, ValueError):
        return None
    if pull_number <= 0:
        return None
    out: list[dict[str, str]] = []
    skipped_files: list[str] = []
    page = 1
    with _client() as c:
        while True:
            r = c.get(
                f"/repos/{repo}/pulls/{pull_number}/files",
                params={"per_page": 100, "page": page},
            )
            if r.status_code == 404:
                return None
            r.raise_for_status()
            batch = r.json()
            if not batch:
                break
            for f in batch:
                filename = f.get("filename")
                if not filename:
                    continue
                if len(out) < max_files:
                    out.append({"filename": filename, "patch": f.get("patch", "")})
                else:
                    skipped_files.append(str(filename))
            if len(out) >= max_files:
                break
            if len(batch) < 100:
                break
            page += 1
    return GhCommitPatch(
        repo=repo,
        sha=f"pull-{pull_number}",
        author=None,
        author_email=None,
        message=f"pull request #{pull_number}",
        files=out,
        total_file_count=len(out) + len(skipped_files),
        limit_skipped=len(skipped_files),
        skipped_files=skipped_files,
    )


def list_pull_requests(repo: str, *, limit: int = 20, state: str = "open") -> list[GhPullRequest]:
    """List bounded pull request candidates by API.

    Direct `/pulls` URLs expose a candidate list rather than one PR. Fetch only
    the visible bounded PR list here; callers fetch per-PR file detail with
    `fetch_pull_request_files`.
    """
    out: list[GhPullRequest] = []
    per_page = max(1, min(int(limit or 20), 100))
    with _client() as c:
        r = c.get(
            f"/repos/{repo}/pulls",
            params={"state": state or "open", "per_page": per_page, "page": 1},
        )
        if r.status_code == 404:
            return out
        r.raise_for_status()
        for body in r.json()[:per_page]:
            try:
                number = int(body.get("number") or 0)
            except (TypeError, ValueError):
                continue
            if number <= 0:
                continue
            out.append(GhPullRequest(
                repo=repo,
                number=number,
                title=str(body.get("title") or ""),
                state=body.get("state"),
                author=((body.get("user") or {}).get("login") or None),
                head_sha=((body.get("head") or {}).get("sha") or None),
                base_ref=((body.get("base") or {}).get("ref") or None),
            ))
    return out


def fetch_compare_files(repo: str, basehead: str, *, max_files: int = 300) -> GhCommitPatch | None:
    """Fetch one compare URL's changed file patches by API.

    `/compare/<base>...<head>` URLs are exact candidate scopes. Fetch the
    compare detail files directly instead of broad-scanning the repository.
    404 returns None, mirroring exact commit and PR detail fetches.
    """
    compare_ref = str(basehead or "").strip()
    if not compare_ref:
        return None
    with _client() as c:
        r = c.get(f"/repos/{repo}/compare/{quote(compare_ref, safe='.:')}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        body = r.json()
        file_candidates = [f for f in (body.get("files") or []) if f.get("filename")]
        selected_files = file_candidates[:max_files]
        skipped_files = file_candidates[max_files:]
        files = [
            {"filename": f.get("filename"), "patch": f.get("patch", "")}
            for f in selected_files
        ]
        return GhCommitPatch(
            repo=repo,
            sha=f"compare-{compare_ref}",
            author=None,
            author_email=None,
            message=f"compare {compare_ref}",
            files=files,
            total_file_count=len(file_candidates),
            limit_skipped=len(skipped_files),
            skipped_files=[str(f.get("filename") or "") for f in skipped_files],
        )


def fetch_issue_detail(repo: str, number: int, *, max_comments: int = 100) -> GhIssueDetail | None:
    """Fetch one issue body plus bounded comments by API.

    Direct `/issues/<number>` URLs are already exact candidate scopes. Fetch the
    visible issue and its comments directly instead of broad-scanning repository
    files or recent commits. 404 returns None, mirroring exact commit/PR detail
    fetches.
    """
    try:
        issue_number = int(number)
    except (TypeError, ValueError):
        return None
    if issue_number <= 0:
        return None
    comments: list[dict[str, str]] = []
    with _client() as c:
        r = c.get(f"/repos/{repo}/issues/{issue_number}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        issue = r.json()
        page = 1
        while len(comments) < max_comments:
            cr = c.get(
                f"/repos/{repo}/issues/{issue_number}/comments",
                params={"per_page": 100, "page": page},
            )
            if cr.status_code == 404:
                break
            cr.raise_for_status()
            batch = cr.json()
            if not batch:
                break
            for item in batch:
                comments.append({
                    "author": ((item.get("user") or {}).get("login") or ""),
                    "body": item.get("body") or "",
                })
                if len(comments) >= max_comments:
                    break
            if len(batch) < 100:
                break
            page += 1
    return GhIssueDetail(
        repo=repo,
        number=issue_number,
        title=issue.get("title") or "",
        body=issue.get("body") or "",
        state=issue.get("state"),
        author=((issue.get("user") or {}).get("login") or None),
        comments=comments,
    )


def list_issues(repo: str, *, limit: int = 20, state: str = "open") -> list[GhIssue]:
    """List bounded issue candidates by API, excluding pull requests.

    Direct `/issues` URLs expose a candidate list rather than one issue. Fetch
    only the visible bounded issue list here; callers fetch per-issue
    body/comment detail with `fetch_issue_detail`.
    """
    out: list[GhIssue] = []
    per_page = max(1, min(int(limit or 20), 100))
    with _client() as c:
        r = c.get(
            f"/repos/{repo}/issues",
            params={"state": state or "open", "per_page": per_page, "page": 1},
        )
        if r.status_code == 404:
            return out
        r.raise_for_status()
        for body in r.json()[:per_page]:
            if body.get("pull_request"):
                continue
            try:
                number = int(body.get("number") or 0)
            except (TypeError, ValueError):
                continue
            if number <= 0:
                continue
            out.append(GhIssue(
                repo=repo,
                number=number,
                title=str(body.get("title") or ""),
                state=body.get("state"),
                author=((body.get("user") or {}).get("login") or None),
            ))
    return out


def fetch_release_by_tag(repo: str, tag_name: str, *, max_assets: int = 100) -> GhReleaseDetail | None:
    """Fetch one release by tag using the REST API.

    Direct `/releases/tag/<tag>` URLs are exact candidate scopes. Fetch the
    release note and bounded asset metadata directly instead of broad-scanning
    repository files or recent commits. 404 returns None, mirroring the other
    exact detail helpers.
    """
    tag = str(tag_name or "").strip()
    if not tag:
        return None
    with _client() as c:
        r = c.get(f"/repos/{repo}/releases/tags/{quote(tag, safe='')}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        body = r.json()
        assets: list[dict[str, str]] = []
        for asset in (body.get("assets") or [])[:max_assets]:
            assets.append({
                "name": str(asset.get("name") or ""),
                "label": str(asset.get("label") or ""),
                "browser_download_url": str(asset.get("browser_download_url") or ""),
                "content_type": str(asset.get("content_type") or ""),
            })
        return GhReleaseDetail(
            repo=repo,
            tag_name=str(body.get("tag_name") or tag),
            name=str(body.get("name") or ""),
            body=str(body.get("body") or ""),
            author=((body.get("author") or {}).get("login") or None),
            draft=bool(body.get("draft")),
            prerelease=bool(body.get("prerelease")),
            assets=assets,
        )


def list_releases(repo: str, *, limit: int = 20, max_assets: int = 100) -> list[GhReleaseDetail]:
    """List bounded release details by API.

    Direct `/releases` URLs expose a candidate list rather than one tag. Fetch
    that bounded list and scan release notes/asset metadata without broad repo
    code search or recent commit fallback.
    """
    out: list[GhReleaseDetail] = []
    per_page = max(1, min(int(limit or 20), 100))
    with _client() as c:
        r = c.get(f"/repos/{repo}/releases", params={"per_page": per_page, "page": 1})
        if r.status_code == 404:
            return out
        r.raise_for_status()
        for body in r.json()[:per_page]:
            assets: list[dict[str, str]] = []
            for asset in (body.get("assets") or [])[:max_assets]:
                assets.append({
                    "name": str(asset.get("name") or ""),
                    "label": str(asset.get("label") or ""),
                    "browser_download_url": str(asset.get("browser_download_url") or ""),
                    "content_type": str(asset.get("content_type") or ""),
                })
            tag_name = str(body.get("tag_name") or "").strip()
            if not tag_name:
                continue
            out.append(GhReleaseDetail(
                repo=repo,
                tag_name=tag_name,
                name=str(body.get("name") or ""),
                body=str(body.get("body") or ""),
                author=((body.get("author") or {}).get("login") or None),
                draft=bool(body.get("draft")),
                prerelease=bool(body.get("prerelease")),
                assets=assets,
            ))
    return out
