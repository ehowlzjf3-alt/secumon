"""github 전역 코드검색 발견 경로 — 커버리지 원천 교체의 계약 고정.

배경: github 타깃은 Splunk 프록시 로그로만 채워졌다. 프록시는 GitHub API 를 안 부르므로
visibility 를 알 수 없어 접근 불가 private repo 가 큐의 64% 를 차지한 채 무한 재순환했다.
전역 `/search/code` 는 **토큰이 읽을 수 있는 repo 만** 인덱스에서 돌려주므로 그 문제가 없다.

여기서 고정하는 계약:
  ① 전역 쿼리다(`repo:` 스코프가 붙지 않는다) — 이게 깨지면 프록시 의존으로 되돌아간다
  ② rate-limit(429/secondary 403) 은 백오프 재시도, 진짜 권한 실패(403)는 즉시 raise
  ③ 발견된 repo 는 기존 `github_repo_target` 큐로 들어간다(워커 수정 불필요)
"""
from __future__ import annotations

import httpx
import pytest

from domains.services.github.plugin.agent_types import github as gh


def _resp(status: int, *, body: str = "", headers: dict[str, str] | None = None,
          json_body: dict | None = None) -> httpx.Response:
    req = httpx.Request("GET", "https://gh.example/search/code")
    if json_body is not None:
        return httpx.Response(status, json=json_body, headers=headers or {}, request=req)
    return httpx.Response(status, text=body, headers=headers or {}, request=req)


# ── ② rate-limit 판별 ────────────────────────────────────────────────────
def test_retry_after_header_wins():
    assert gh._search_rate_limit_wait(_resp(403, headers={"retry-after": "7"}), 0) == 7.0


def test_secondary_rate_limit_body_is_retryable():
    r = _resp(403, body='{"message":"You have exceeded a secondary rate limit"}')
    assert gh._search_rate_limit_wait(r, 0) == 60.0
    assert gh._search_rate_limit_wait(r, 2) == 90.0   # 60 · 75 · 90


def test_secondary_wait_is_not_exponential_backoff():
    """★ 2026-08-22 실측이 뒤집은 것 — 구 동작은 1·2·4초(총 7초)였다.

    `per_page=100` 연타로 403 을 재현하고 5초 간격으로 폴링한 결과 **회복까지 46.4초**.
    지수 백오프로는 원천적으로 못 넘긴다. 실제로 그날 발견 런에서 21키워드 중 4개(19%)가
    0건으로 죽었고, 그 4개는 따로 3초 간격으로 치면 전부 200 이라 쿼리 문제가 아니었다.

    이 제한은 시간창 기반이라 "조금씩 늘려가며 두드리기" 자체가 안 통한다.
    """
    r = _resp(403, body="secondary rate limit")
    waits = [gh._search_rate_limit_wait(r, i) for i in range(3)]
    assert min(waits) >= 46.4, f"실측 회복시간보다 짧게 기다린다: {waits}"
    assert waits == sorted(waits), "재시도마다 줄어들면 안 된다"


def test_gh_limited_by_header_marks_secondary(monkeypatch):
    """GHES 는 `Retry-After` 를 안 주고 `gh-limited-by` 를 준다(2026-08-22 실측).

    본문 문구 매칭만 두면 문구가 바뀌는 날 조용히 안 맞게 된다 — 헤더를 먼저 본다.
    실측값: `gh-limited-by: search-elapsed-time-shared-grouped`(누적 검색 소요시간 기반).
    """
    r = _resp(403, headers={"gh-limited-by": "search-elapsed-time-shared-grouped",
                            "x-ratelimit-remaining": "80"})
    assert gh._search_rate_limit_wait(r, 0) == 60.0


def test_secondary_wait_fits_inside_the_default_budget(monkeypatch):
    """★ 함정: 대기를 늘리면 예산에 막혀 **재시도가 줄어든다.**

    `code_search` 는 `wait <= wait_budget` 일 때만 기다린다. 그래서 `_secondary_wait` 를
    60초로 올리면서 `SA_GH_SEARCH_MAX_WAIT_SEC` 기본값(60)을 그대로 뒀으면 재시도가
    3회 → 1회로 **줄었을** 것이다. 둘은 같이 움직여야 한다.
    """
    ok = _resp(200, json_body={"items": []})
    fake = _patch_client(monkeypatch, [
        _resp(403, body="secondary rate limit"),
        _resp(403, body="secondary rate limit"),
        _resp(403, body="secondary rate limit"),
        ok,
    ])
    assert gh.code_search("AKIA") == []
    assert len(fake.queries) == 4, (
        f"기본 예산으로 3회 재시도가 안 된다({len(fake.queries)-1}회) — "
        "_secondary_wait 와 SA_GH_SEARCH_MAX_WAIT_SEC 가 어긋났다"
    )


def test_primary_quota_exhausted_uses_reset(monkeypatch):
    monkeypatch.setattr(gh.time, "time", lambda: 1000.0)
    r = _resp(403, headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1030"})
    assert gh._search_rate_limit_wait(r, 0) == 30.0


def test_429_is_always_retryable_without_body_hints():
    """429 는 정의상 rate-limit 이다. 403 용 본문 휴리스틱에만 걸어두면 429 가 새 나간다
    (실제로 초안이 그랬고 재시도 테스트가 잡았다)."""
    assert gh._search_rate_limit_wait(_resp(429), 0) == 1.0
    assert gh._search_rate_limit_wait(_resp(429, body="slow down"), 3) == 8.0


def test_real_permission_failure_is_not_retryable():
    """쿼터가 남은 403 + secondary 문구 없음 = 진짜 권한 실패. 재시도하면 안 된다."""
    r = _resp(403, body='{"message":"Must have push access"}',
              headers={"x-ratelimit-remaining": "42"})
    assert gh._search_rate_limit_wait(r, 0) is None


def test_non_rate_limit_status_is_not_retryable():
    assert gh._search_rate_limit_wait(_resp(404), 0) is None
    assert gh._search_rate_limit_wait(_resp(200), 0) is None


# ── code_search 동작 ─────────────────────────────────────────────────────
class _FakeClient:
    def __init__(self, responses):
        self._responses = list(responses)
        self.queries: list[str] = []

    def get(self, _path, params=None):
        self.queries.append((params or {}).get("q"))
        return self._responses.pop(0)

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


def _patch_client(monkeypatch, responses):
    fake = _FakeClient(responses)
    monkeypatch.setattr(gh, "_client", lambda: fake)
    monkeypatch.setattr(gh.time, "sleep", lambda _s: None)
    return fake


def test_code_search_retries_then_succeeds(monkeypatch):
    ok = _resp(200, json_body={"items": [
        {"repository": {"full_name": "org/repo"}, "path": "a/b.yml"},
    ]})
    fake = _patch_client(monkeypatch, [
        _resp(403, body="secondary rate limit"),
        _resp(429, body="slow down"),
        ok,
    ])
    hits = gh.code_search("AKIA")
    assert [(h.repo, h.path) for h in hits] == [("org/repo", "a/b.yml")]
    assert fake.queries == ["AKIA", "AKIA", "AKIA"]


def test_code_search_gives_up_after_max_retries(monkeypatch):
    monkeypatch.setenv("SA_GH_SEARCH_MAX_RETRIES", "1")
    _patch_client(monkeypatch, [
        _resp(403, body="secondary rate limit"),
        _resp(403, body="secondary rate limit"),
    ])
    with pytest.raises(httpx.HTTPStatusError):
        gh.code_search("AKIA")


def test_code_search_does_not_retry_permission_failure(monkeypatch):
    fake = _patch_client(monkeypatch, [
        _resp(403, body='{"message":"Bad credentials"}',
              headers={"x-ratelimit-remaining": "88"}),
    ])
    with pytest.raises(httpx.HTTPStatusError):
        gh.code_search("AKIA")
    assert len(fake.queries) == 1, "권한 실패인데 재시도했다"


def test_code_search_422_stays_graceful(monkeypatch):
    _patch_client(monkeypatch, [_resp(422, body="unprocessable")])
    assert gh.code_search("bad:query") == []


def test_retry_budget_is_bounded(monkeypatch):
    """대기 상한을 넘는 요구는 재시도하지 않는다 — 워커가 무한정 매달리면 안 된다."""
    monkeypatch.setenv("SA_GH_SEARCH_MAX_WAIT_SEC", "5")
    fake = _patch_client(monkeypatch, [_resp(403, headers={"retry-after": "3600"})])
    with pytest.raises(httpx.HTTPStatusError):
        gh.code_search("AKIA")
    assert len(fake.queries) == 1


# ── ①③ 발견 경로 ────────────────────────────────────────────────────────
def test_search_discovery_is_global_not_repo_scoped(monkeypatch, tmp_db):
    """⚠️ 핵심 계약: 쿼리에 `repo:` 가 붙으면 안 된다.

    붙는 순간 "프록시가 물어온 repo 안에서만" 검색하게 되고, 지금 고치려는 문제로 되돌아간다.
    """
    from secu_agent import state  # noqa: F401
    from domains.services.github.application import scanner

    seen: list[str] = []

    def _fake_search(query, **_kw):
        seen.append(query)
        return [gh.GhCodeHit(repo="org/found", path="x.yml")]

    monkeypatch.setattr(scanner.gh, "code_search", _fake_search)
    res = scanner.discover_repositories_by_search(
        [{"keyword": "AKIA"}, {"keyword": "ghp_"}], spacing_seconds=0,
    )
    assert seen == ["AKIA", "ghp_"]
    assert not any("repo:" in q for q in seen)
    assert res["repos_seen"] == 1  # 같은 repo 는 한 번만
    assert res["new"] == 1


def test_search_discovery_applies_qualifiers(monkeypatch, tmp_db):
    from secu_agent import state  # noqa: F401
    from domains.services.github.application import scanner

    seen: list[str] = []
    monkeypatch.setattr(scanner.gh, "code_search",
                        lambda q, **_kw: seen.append(q) or [])
    scanner.discover_repositories_by_search(
        [{"keyword": "password", "qualifiers": ["org:myorg", "language:yaml"]}],
        spacing_seconds=0,
    )
    assert seen == ["org:myorg language:yaml password"]


def test_search_discovery_lands_in_the_ACTIVE_worker_queue(monkeypatch, tmp_db):
    """⚠️ 핵심 계약: `devops_target(service='github')` 에 들어가야 한다.

    `github_repo_target` 에 넣으면 안 된다 — 그쪽 소비자(`github.scan`/`github.collector`)는
    라이브에서 **enabled=0** 이라 넣어봐야 finding 이 안 나온다. 실제로 도는 건
    `github.sso_hunt` 경로이고 그게 `devops_target` 을 claim 한다.
    (초안이 이걸 틀려서 조용히 아무 일도 안 일어날 뻔했다)
    """
    from secu_agent import state  # noqa: F401
    import service.state_domain as sd
    from domains.services.github.application import scanner

    monkeypatch.setattr(scanner.gh, "code_search", lambda q, **_kw: [
        gh.GhCodeHit(repo="org/alpha", path="a.yml"),
        gh.GhCodeHit(repo="org/beta", path="b.yml"),
    ])
    scanner.discover_repositories_by_search([{"keyword": "AKIA"}], spacing_seconds=0)

    claimed = []
    while (row := sd.devops_target_claim_next(session_id=1, service="github")) is not None:
        claimed.append(row["url"])
        sd.devops_target_set_status(row["id"], "tasked")
    assert set(claimed) == {
        "https://github.samsungds.net/org/alpha",
        "https://github.samsungds.net/org/beta",
    }
    # 꺼진 큐는 건드리지 않는다
    assert sd.github_repo_targets_summary()["total"] == 0


def test_search_discovery_shares_key_space_with_proxy_discovery(monkeypatch, tmp_db):
    """같은 repo 를 프록시와 검색이 각각 발견해도 행이 둘로 갈리면 안 된다."""
    from secu_agent import state  # noqa: F401
    import service.state_domain as sd
    from domains.services.application.devops_discovery import (
        DevopsDiscoveryConfig, ingest_devops_discovery_rows,
    )
    from domains.services.github.application import scanner

    bucket = "2026-07-28"
    ingest_devops_discovery_rows(
        [{"full_url": "https://github.samsungds.net/org/alpha", "count": 9}],
        config=DevopsDiscoveryConfig(earliest="-1d", latest="now",
                                     day_bucket=bucket, max_urls=10),
        store=sd, service_filter="github",
    )
    monkeypatch.setattr(scanner.gh, "code_search", lambda q, **_kw: [
        gh.GhCodeHit(repo="org/alpha", path="a.yml"),
    ])
    scanner.discover_repositories_by_search(
        [{"keyword": "AKIA"}], spacing_seconds=0, day_bucket=bucket,
    )
    assert sd.devops_targets_summary(service="github")["total"] == 1
    # 프록시가 쌓아둔 트래픽 신호(access_count)를 검색 발견이 덮어쓰면 안 된다
    with sd.connect() as c:
        row = c.execute("SELECT access_count FROM devops_target").fetchone()
    assert row["access_count"] == 9


def test_search_discovery_rejects_malformed_repo_names(monkeypatch, tmp_db):
    from secu_agent import state  # noqa: F401
    import service.state_domain as sd
    from domains.services.github.application import scanner

    monkeypatch.setattr(scanner.gh, "code_search", lambda q, **_kw: [
        gh.GhCodeHit(repo="onlyorg", path="a"),
        gh.GhCodeHit(repo="a/b/c", path="a"),
        gh.GhCodeHit(repo="org/good", path="a"),
    ])
    res = scanner.discover_repositories_by_search([{"keyword": "AKIA"}], spacing_seconds=0)
    assert res["repos_seen"] == 1
    assert res["per_keyword"][0]["invalid"] == 2
    assert sd.devops_targets_summary(service="github")["total"] == 1


def test_search_discovery_survives_one_bad_keyword(monkeypatch, tmp_db):
    """키워드 하나가 죽어도 나머지는 계속 — 커버리지 전체를 잃지 않는다."""
    from secu_agent import state  # noqa: F401
    from domains.services.github.application import scanner

    def _flaky(query, **_kw):
        if query == "boom":
            raise RuntimeError("HTTP 500")
        return [gh.GhCodeHit(repo="org/ok", path="x")]

    monkeypatch.setattr(scanner.gh, "code_search", _flaky)
    res = scanner.discover_repositories_by_search(
        [{"keyword": "boom"}, {"keyword": "AKIA"}], spacing_seconds=0,
    )
    assert res["repos_seen"] == 1
    assert len(res["errors"]) == 1 and res["errors"][0]["keyword"] == "boom"
    assert [k["status"] for k in res["per_keyword"]] == ["error", "ok"]


def test_search_discovery_respects_max_repos(monkeypatch, tmp_db):
    from secu_agent import state  # noqa: F401
    from domains.services.github.application import scanner

    monkeypatch.setattr(scanner.gh, "code_search", lambda q, **_kw: [
        gh.GhCodeHit(repo=f"org/r{i}", path="x") for i in range(10)
    ])
    res = scanner.discover_repositories_by_search(
        [{"keyword": "AKIA"}], max_repos=3, spacing_seconds=0,
    )
    assert res["repos_seen"] == 3
    assert res["capped"] is True


# ── 키워드 설정 ──────────────────────────────────────────────────────────
def test_packaged_keyword_config_loads_and_is_value_prefix_first():
    from service.agents import github_discovery_agent as disc

    version, entries, excludes = disc._load_search_keywords()
    kws = [e["keyword"] for e in entries]
    assert version and len(kws) >= 10
    assert "AKIA" in kws and "ghp_" in kws
    assert "BEGIN RSA PRIVATE KEY" in kws
    # 일반 어휘는 넣지 않는다 — 전역 검색에서 수만 건이 나와 큐가 무의미해진다.
    assert "password" not in kws, "일반 어휘가 들어오면 전역 검색 결과가 폭발한다"
    # 시크릿 스캐너 저장소는 값 접두 키워드에 100% 걸리므로 반드시 제외 목록에 있어야 한다.
    assert "*/gitleaks" in excludes


def test_env_inline_keywords_override(monkeypatch):
    from service.agents import github_discovery_agent as disc

    monkeypatch.setenv("GITHUB_SEARCH_KEYWORDS", "AKIA, ghp_ ,")
    version, entries, excludes = disc._load_search_keywords()
    assert version == "env-inline"
    assert [e["keyword"] for e in entries] == ["AKIA", "ghp_"]
    # v3.92: env 는 **키워드만** 갈아끼운다. 제외 목록은 안전 정책이라 항상 패키지에서 온다.
    assert excludes, "env override 가 제외 목록까지 날렸다"


# ── 제외 목록 ────────────────────────────────────────────────────────────
def test_scanner_repos_are_excluded_from_the_queue(monkeypatch, tmp_db):
    """gitleaks 류는 `ghp_` 픽스처를 정상 보유해 값 접두 키워드에 반드시 걸린다.

    실제로 드라이런에서 `aiplatform-external/gitleaks` 가 잡혔다. 오탐의 근원이라
    큐 진입 단계에서 끊는다.
    """
    from secu_agent import state  # noqa: F401
    import service.state_domain as sd
    from domains.services.github.application import scanner

    monkeypatch.setattr(scanner.gh, "code_search", lambda q, **_kw: [
        gh.GhCodeHit(repo="aiplatform-external/gitleaks", path="README.md"),
        gh.GhCodeHit(repo="someone/trufflehog", path="x"),
        gh.GhCodeHit(repo="team/real-service", path="config/prod.yml"),
    ])
    res = scanner.discover_repositories_by_search(
        [{"keyword": "ghp_"}], spacing_seconds=0,
        exclude_repos=["*/gitleaks", "*/trufflehog"],
    )
    assert res["excluded"] == 2
    assert res["excluded_repos"] == ["aiplatform-external/gitleaks", "someone/trufflehog"]
    assert res["repos_seen"] == 1, "제외분이 repos_seen 에 섞였다"
    assert sd.devops_targets_summary(service="github")["total"] == 1


def test_exclusion_does_not_consume_the_max_repos_budget(monkeypatch, tmp_db):
    """제외된 repo 가 캡을 깎으면 실제 수집량이 조용히 줄어든다."""
    from secu_agent import state  # noqa: F401
    from domains.services.github.application import scanner

    monkeypatch.setattr(scanner.gh, "code_search", lambda q, **_kw: [
        gh.GhCodeHit(repo="a/gitleaks", path="x"),
        gh.GhCodeHit(repo="b/gitleaks", path="x"),
        gh.GhCodeHit(repo="team/one", path="x"),
        gh.GhCodeHit(repo="team/two", path="x"),
    ])
    res = scanner.discover_repositories_by_search(
        [{"keyword": "ghp_"}], spacing_seconds=0, max_repos=2,
        exclude_repos=["*/gitleaks"],
    )
    assert res["repos_seen"] == 2 and res["excluded"] == 2


def test_no_exclude_list_keeps_everything(monkeypatch, tmp_db):
    from secu_agent import state  # noqa: F401
    from domains.services.github.application import scanner

    monkeypatch.setattr(scanner.gh, "code_search", lambda q, **_kw: [
        gh.GhCodeHit(repo="any/gitleaks", path="x"),
    ])
    res = scanner.discover_repositories_by_search([{"keyword": "ghp_"}], spacing_seconds=0)
    assert res["excluded"] == 0 and res["repos_seen"] == 1


# ── v3.92 이름변경 repo(301) ─────────────────────────────────────────────
class _RedirectingClient:
    """이름변경/이전된 repo 를 흉내낸다 — 리다이렉트를 안 따라가면 301 이 그대로 온다."""

    def __init__(self, new_full_name: str):
        self.new_full_name = new_full_name
        self.calls: list[tuple[str, bool]] = []

    def get(self, path, follow_redirects=False, **_kw):
        self.calls.append((path, follow_redirects))
        req = httpx.Request("GET", f"https://gh.example{path}")
        if not follow_redirects:
            return httpx.Response(
                301, headers={"location": f"/repos/{self.new_full_name}"}, request=req)
        return httpx.Response(200, json={
            "full_name": self.new_full_name, "default_branch": "develop",
            "private": True, "archived": False, "pushed_at": "2026-01-01T00:00:00Z",
            "visibility": "internal", "size": 42,
        }, request=req)

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


def test_repo_meta_follows_rename_redirect(monkeypatch):
    """301 은 '못 읽는다'가 아니라 '이름이 바뀌었다'다.

    httpx 의 raise_for_status 는 3xx 에서도 터지므로 예전엔 확인 실패로 분류돼 접근불가와
    구분되지 않았다(실측 6건이 이 이유로 판정 보류). 따라가면 새 이름이 그대로 나온다.
    """
    fake = _RedirectingClient("neworg/newname")
    monkeypatch.setattr(gh, "_client", lambda: fake)

    meta = gh.repo_meta("oldorg/oldname")
    assert meta is not None, "301 을 접근불가로 오판했다"
    assert meta.full_name == "neworg/newname"
    assert meta.visibility == "internal" and meta.default_branch == "develop"
    assert fake.calls == [("/repos/oldorg/oldname", True)]


def test_repo_meta_404_is_still_none(monkeypatch):
    class _Missing:
        def get(self, path, **_kw):
            return httpx.Response(404, request=httpx.Request("GET", f"https://x{path}"))

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

    monkeypatch.setattr(gh, "_client", lambda: _Missing())
    assert gh.repo_meta("org/gone") is None


# ── v3.92 범위 검사기(private / 제외목록) ────────────────────────────────
def _meta(visibility: str | None, *, private: bool = True) -> gh.GhRepo:
    return gh.GhRepo(full_name="org/repo", default_branch="main", private=private,
                     archived=False, pushed_at=None, visibility=visibility)


def test_private_repo_is_out_of_scope(monkeypatch):
    from service.agents import github_discovery_agent as disc

    monkeypatch.setattr(gh, "repo_meta", lambda _s: _meta("private"))
    assert disc._github_scope_screen()("org/secret") == "out_of_scope: private repo"


def test_internal_repo_stays_in_scope_despite_private_flag(monkeypatch):
    """⚠️ GHES 는 **internal repo 에도 `private=true`** 를 준다.

    그 필드로 걸렀다간 점검 대상의 본진인 internal 을 통째로 닫는다. 판정은 `visibility` 로.
    """
    from service.agents import github_discovery_agent as disc

    monkeypatch.setattr(gh, "repo_meta", lambda _s: _meta("internal", private=True))
    assert disc._github_scope_screen()("org/internal") is None


def test_public_repo_stays_in_scope(monkeypatch):
    from service.agents import github_discovery_agent as disc

    monkeypatch.setattr(gh, "repo_meta", lambda _s: _meta("public", private=False))
    assert disc._github_scope_screen()("org/open") is None


def test_missing_visibility_field_is_not_closed(monkeypatch):
    """구버전 GHES 는 visibility 를 안 준다. 모르면 살려둔다 — 닫는 쪽이 위험하다."""
    from service.agents import github_discovery_agent as disc

    monkeypatch.setattr(gh, "repo_meta", lambda _s: _meta(None, private=True))
    assert disc._github_scope_screen()("org/legacy") is None


def test_unreadable_repo_reports_no_access(monkeypatch):
    from service.agents import github_discovery_agent as disc

    monkeypatch.setattr(gh, "repo_meta", lambda _s: None)
    reason = disc._github_scope_screen()("org/hidden")
    assert reason is not None and reason.startswith("no_access")


def test_excluded_repo_is_screened_without_touching_the_api(monkeypatch):
    """제외 목록은 API 호출 전에 걸러야 한다 — 쓸데없는 rate 소모를 안 만든다."""
    from service.agents import github_discovery_agent as disc

    calls = []
    monkeypatch.setattr(gh, "repo_meta", lambda s: calls.append(s) or _meta("public"))
    screen = disc._github_scope_screen(["ai-for-security/*"])
    assert screen("AI-for-Security/secu-agent") == "out_of_scope: excluded repo"
    assert calls == []
    assert screen("team/real") is None and calls == ["team/real"]


def test_scope_screen_can_be_disabled(monkeypatch):
    from service.agents import github_discovery_agent as disc

    monkeypatch.setenv("SA_DEVOPS_VISIBILITY_CHECK", "0")
    assert disc._github_scope_screen() is None


def test_packaged_config_excludes_our_own_tooling_org():
    """자사 도구 리포는 픽스처 시크릿만 낸다. 두 발견 경로 모두에서 끊는다."""
    from service.agents import github_discovery_agent as disc

    assert "ai-for-security/*" in disc._load_search_keywords()[2]


def test_exclude_loader_survives_broken_config(monkeypatch):
    """설정이 깨져도 발견 자체는 굴러가야 한다(제외 없이 진행)."""
    from service.agents import github_discovery_agent as disc

    monkeypatch.setenv("GITHUB_SEARCH_KEYWORDS_FILE", "/nonexistent/nope.yaml")
    assert disc._search_exclude_repos() == []


# ── 검색 경로에도 범위 검사가 걸린다 ──────────────────────────────────────
def test_search_discovery_drops_out_of_scope_repos(monkeypatch, tmp_db):
    """검색 인덱스는 '읽히는' repo 를 줄 뿐 **범위**를 모른다 — 권한 있는 private 이 섞인다."""
    from secu_agent import state  # noqa: F401
    import service.state_domain as sd
    from domains.services.github.application import scanner

    monkeypatch.setattr(scanner.gh, "code_search", lambda q, **_kw: [
        gh.GhCodeHit(repo="team/keep", path="a"),
        gh.GhCodeHit(repo="team/private-one", path="b"),
    ])
    res = scanner.discover_repositories_by_search(
        [{"keyword": "ghp_"}], spacing_seconds=0,
        scope_screen=lambda r: ("out_of_scope: private repo"
                                if r.endswith("private-one") else None),
    )
    assert res["out_of_scope"] == 1
    assert res["out_of_scope_repos"] == {"team/private-one": "out_of_scope: private repo"}
    assert res["repos_seen"] == 1
    assert sd.devops_targets_summary(service="github")["total"] == 1


def test_scope_screen_failure_still_queues_the_repo(monkeypatch, tmp_db):
    """확인 실패로 범위 밖이라 단정하지 않는다 — 조용한 커버리지 손실 방지."""
    from secu_agent import state  # noqa: F401
    import service.state_domain as sd
    from domains.services.github.application import scanner

    def _boom(_repo):
        raise RuntimeError("rate limited")

    monkeypatch.setattr(scanner.gh, "code_search", lambda q, **_kw: [
        gh.GhCodeHit(repo="team/unknown", path="a"),
    ])
    res = scanner.discover_repositories_by_search(
        [{"keyword": "ghp_"}], spacing_seconds=0, scope_screen=_boom,
    )
    assert res["screen_errors"] == 1
    assert res["repos_seen"] == 1
    assert sd.devops_targets_summary(service="github")["total"] == 1


def test_out_of_scope_does_not_consume_the_max_repos_budget(monkeypatch, tmp_db):
    from secu_agent import state  # noqa: F401
    from domains.services.github.application import scanner

    monkeypatch.setattr(scanner.gh, "code_search", lambda q, **_kw: [
        gh.GhCodeHit(repo="a/private", path="x"),
        gh.GhCodeHit(repo="b/private", path="x"),
        gh.GhCodeHit(repo="team/one", path="x"),
        gh.GhCodeHit(repo="team/two", path="x"),
    ])
    res = scanner.discover_repositories_by_search(
        [{"keyword": "ghp_"}], spacing_seconds=0, max_repos=2,
        scope_screen=lambda r: "out_of_scope: private repo" if "private" in r else None,
    )
    assert res["repos_seen"] == 2 and res["out_of_scope"] == 2


def test_scope_screen_is_not_repeated_across_keywords(monkeypatch, tmp_db):
    """같은 repo 가 키워드마다 다시 걸린다 — 매번 API 를 부르면 rate 를 낭비한다."""
    from secu_agent import state  # noqa: F401
    from domains.services.github.application import scanner

    calls: list[str] = []
    monkeypatch.setattr(scanner.gh, "code_search", lambda q, **_kw: [
        gh.GhCodeHit(repo="team/private-one", path="x"),
    ])
    res = scanner.discover_repositories_by_search(
        [{"keyword": "ghp_"}, {"keyword": "AKIA"}], spacing_seconds=0,
        scope_screen=lambda r: calls.append(r) or "out_of_scope: private repo",
    )
    assert calls == ["team/private-one"], "같은 repo 를 두 번 확인했다"
    assert res["out_of_scope"] == 1


def test_env_inline_keywords_keep_the_packaged_exclusions(monkeypatch):
    """⚠️ 키워드를 env 로 바꿔도 **제외 목록은 살아 있어야 한다.**

    초안은 env-inline 에서 `[]` 를 돌려줬다. 그러면 키워드 하나 재실행하려고 env 를 켠
    순간 시크릿 스캐너·자사 repo 제외가 통째로 풀리고, 같은 로더를 쓰는
    **프록시 발견 경로(`_search_exclude_repos`)까지** 같이 풀린다.
    """
    from service.agents import github_discovery_agent as disc

    monkeypatch.setenv("GITHUB_SEARCH_KEYWORDS", "AKIA, ghp_")
    version, entries, excludes = disc._load_search_keywords()
    assert version == "env-inline"
    assert [e["keyword"] for e in entries] == ["AKIA", "ghp_"]
    assert "*/gitleaks" in excludes and "ai-for-security/*" in excludes
    # 프록시 경로도 같은 목록을 본다
    assert "*/gitleaks" in disc._search_exclude_repos()


def test_packaged_config_excludes_the_code_corpus_org():
    """`code-search/*` 는 월별 자동생성 코퍼스 덤프 185개다 — 남의 공개 코드라 담당자가 없다."""
    from service.agents import github_discovery_agent as disc

    assert "code-search/*" in disc._load_search_keywords()[2]


# ── 전역 code_search 는 워커에 없다 (2026-08-22 은퇴) ────────────────────
#
# ★ 왜: 전역 검색은 **discovery 배치**의 것이다. secondary rate limit 은 1/2/4초
# 백오프로 못 넘고 실전 간격이 키워드당 30초다(`SA_GH_SEARCH_SPACING_SEC=30`,
# `MAX_WAIT_SEC=240`). 그 백오프를 idle 상한 300초짜리 검토원 안에서 돌리면 매번 죽는다
# — 2026-08-22 실기동에서 `github_task_scan` 이 300.3초 무활동으로 런을 abort 시켰다.
# 워커는 hot-path 열거로 간다(검색 API 를 안 쓴다).

def test_worker_scan_defaults_to_no_global_code_search():
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanInput

    assert GithubTaskScanInput().api_search_first is False


def test_nothing_in_the_worker_wiring_turns_it_on():
    """★ 프로덕션에서 켜지는 경로가 **하나도** 없어야 한다.

    코드 경로 자체는 남긴다(403/404·dedup·default-branch 로직의 단위 테스트 32건이
    그걸 통과한다). 빼는 것은 **배선**이다 — 기본값·프롬프트·힌트 생성기.
    모델이 그 인자를 쓴 이유는 worker.md 가 시켰기 때문이다.
    """
    from pathlib import Path

    root = Path(__file__).resolve().parents[2] / "services" / "github"
    hints = (root / "application" / "url_hints.py").read_text(encoding="utf-8")
    emitted = [
        ln for ln in hints.splitlines()
        if "api_search_first" in ln and not ln.lstrip().startswith("#")
    ]
    assert not emitted, f"힌트 생성기가 아직 내보낸다: {emitted}"


def test_worker_prompts_do_not_teach_api_search_first():
    """프롬프트가 시키면 모델은 시킨 대로 한다 — 지시도 같이 빠져야 한다."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[2] / "services" / "github"
    for rel in ("skills/github_task/worker.md", "skills/github_task/SKILL.md", "SKILL.md"):
        text = (root / rel).read_text(encoding="utf-8")
        assert "api_search_first=True" not in text, rel


def test_discovery_still_owns_global_search():
    """★ 능력을 없앤 게 아니라 **제자리로 돌려놨다** — discovery 경로는 그대로다."""
    from service.agents import github_discovery_agent as a

    assert hasattr(a, "run_search_discovery_pass")


def test_worker_prompt_offers_browser_search_as_the_alternative():
    """★ 금지만 하면 모델은 다른 길을 못 찾는다 — **대안**을 같이 줘야 한다.

    confluence 가 REST rate-limit 때문에 `confluence_browser_search` 로 넘어간 것과
    같은 패턴이다. github 은 `github_browse` 가 same-origin URL 을 열 수 있으므로
    검색 페이지를 그대로 몰면 된다(실측: SSO 로그인 1회 → 18줄 매칭, 쿼터 없음).
    """
    from pathlib import Path as P

    worker = (P(__file__).resolve().parents[2] / "services" / "github"
              / "skills" / "github_task" / "worker.md").read_text(encoding="utf-8")
    # ★ 2026-08-27: 규칙이 뒤집혔다. "브라우저로 검색하라" 는 회피책이었다 —
    #   code_search 백오프(최대 225s)가 검토원 idle 예산 300s 를 넘겨 런을 죽였기
    #   때문이다. 예산이 900s 가 되어 전제가 사라졌고, 실측에서 검토원이 도구 10회 중
    #   8회를 브라우저 탐색에 쓰고 있었다(왕복 하나가 300s 를 넘긴 적도 있다).
    #
    #   지금 계약은 **순서**를 말한다: 스캐너가 찾고, 브라우저는 확인용이다.
    #   대안을 준다는 이 테스트의 취지는 그대로다 — 금지만 하면 모델이 길을 못 찾는다.
    assert "Let the scanner search. You judge." in worker
    assert "Search with the browser, not the API" not in worker, "옛 회피책이 되살아났다"
    assert "Use `github_browse` **after** the scanner" in worker, "브라우저를 금지한 게 아니다"
    assert "/search?q=" in worker and "type=code" in worker, "필요할 때 쓸 방법은 남아야 한다"


def test_worker_prompt_tells_it_when_to_search_not_only_how():
    """★ 한 겹 더 — 대안을 줘도 **발동 조건**이 없으면 안 쓴다.

    2026-08-22 실기동(github-sso-1084, salt-jeong/claude-skills): 워커가 브라우저 검색을
    **0회** 부르고 `github_browse` 로 `/tree/...` 를 45회 걸어다녔다(고유 URL 23개).
    프롬프트에는 "When you need to search ..." 로 검색 **방법**이 적혀 있었지만, 트리를
    걷는 흐름에서는 "지금이 검색할 때" 라는 판단 자체가 안 생긴다. 그래서 금지(트리 걷기)와
    대체 행동(repo 스코프 검색)을 **같은 줄에서** 말한다.

    repo 스코프 검색은 가르치기 전에 실측했다 — `q=repo:<owner>/<repo>+<term>&type=code` 가
    `repo/path` + 매칭 라인번호를 돌려준다.
    """
    from pathlib import Path as P

    worker = (P(__file__).resolve().parents[2] / "services" / "github"
              / "skills" / "github_task" / "worker.md").read_text(encoding="utf-8")
    assert "Do not walk the repository tree" in worker, "금지가 없다"
    assert "q=repo:<owner>/<repo>+<term>" in worker, "대체 행동이 없다"
    # 금지와 대안이 **떨어져 있으면** 안 된다 — 같은 규칙 안에 있어야 발동한다.
    i = worker.index("Do not walk the repository tree")
    j = worker.index("q=repo:<owner>/<repo>+<term>", i)
    assert j - i < 900, "금지와 대안이 너무 멀다 — 같은 규칙으로 읽히지 않는다"


# ── 커버리지 손실은 침묵하면 안 된다 ────────────────────────────────────
def _run_pass_with(monkeypatch, *, errors: list[dict]) -> list[tuple[str, str]]:
    """`run_search_discovery_pass` 를 돌리고 (status, detail) 을 잡아낸다."""
    from service.agents import github_discovery_agent as agent

    recorded: list[tuple[str, str]] = []

    monkeypatch.setattr(agent, "load_runtime_env", lambda **_k: None)
    monkeypatch.setattr(agent.state, "heartbeat_upsert", lambda *a, **k: None)
    monkeypatch.setattr(agent.state, "pipeline_run_start", lambda *a, **k: 1)
    monkeypatch.setattr(
        agent.state, "pipeline_run_finish",
        lambda _run_id, *, status, detail: recorded.append((status, detail)),
    )
    monkeypatch.setattr(agent, "_load_search_keywords",
                        lambda _p=None: ("v1", [{"keyword": "AKIA"}], []))
    monkeypatch.setattr(agent, "_github_scope_screen", lambda _e: None)
    monkeypatch.setattr(agent, "discover_repositories_by_search", lambda *a, **k: {
        "keywords": 21, "repos_seen": 367, "new": 367, "total": 1316,
        "excluded": 71, "out_of_scope": 0, "errors": errors,
    })
    agent.run_search_discovery_pass()
    return recorded


def test_clean_pass_is_ok(monkeypatch):
    (status, detail), = _run_pass_with(monkeypatch, errors=[])
    assert status == "ok"
    assert "keywords_ok=21/21" in detail


def test_partial_keyword_failure_is_not_reported_as_ok(monkeypatch):
    """★ 2026-08-22 뒤집은 규칙.

    구 동작은 "일부 키워드가 죽어도 성공 — 다음 사이클에 재시도" 였는데 **그 다음 사이클이
    오지 않는다**(이 배치를 도는 스케줄러가 없다: crontab 0건·systemd timer 0건, 실측).
    그래서 07-29 런 errors=12 도 08-22 런 errors=4 도 `ok` 로 남았고 3.5주간 아무도
    커버리지 손실을 몰랐다. detail 에만 적는 건 아무도 안 읽으면 침묵이다.

    ⚠️ 새 상태값(`partial`)을 만들면 안 된다 — 게이트웨이 health 가
    `status IN ('ok','error')` 로 거르므로 **오히려 화면에서 사라진다.**
    """
    (status, detail), = _run_pass_with(
        monkeypatch, errors=[{"keyword": "BEGIN EC PRIVATE KEY", "error": "403"}] * 4)
    assert status == "error", "커버리지 19% 손실이 성공으로 기록된다"
    assert "keywords_ok=17/21" in detail, detail
    assert "first_error=" in detail


def test_partial_failure_status_stays_inside_the_gateway_health_set(monkeypatch):
    """게이트웨이 runtime_repo 는 status IN ('ok','error') 만 health 로 읽는다."""
    (status, _), = _run_pass_with(monkeypatch, errors=[{"keyword": "k", "error": "e"}])
    assert status in {"ok", "error"}

