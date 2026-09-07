from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_dev_web_task_contract_requires_browser_menu_deep_dive() -> None:
    worker = (ROOT / "domains/dev_web/skills/dev_web_task/worker.md").read_text()
    skill = (ROOT / "domains/dev_web/skills/dev_web_task/SKILL.md").read_text()

    assert "top/left menus" in worker
    assert "list\n  and detail screens" in worker
    assert "API/token" in worker
    assert "export or\n  download views" in worker
    assert "keyword,\n  filename, or entropy hits are only leads" in worker
    assert "browser tools" in skill
    assert "agent-verified" in skill


def test_dev_web_task_agent_unlocks_browser_deep_dive_tools() -> None:
    from service.agents import dev_web_task_agent

    names = {tool.name for tool in dev_web_task_agent._tool_classes()}
    user_text = dev_web_task_agent._build_user_text(
        {"id": 3, "domain": "prod.cdep.samsungds.net", "url": "https://prod.cdep.samsungds.net"},
        charter_ref="SECOPS-2026-001",
    )

    # 무인 워커(runtime.run_agent, approval_resolver 없음)는 destructive raw
    # browser_session/browser_action 을 노출하지 않는다(승인거부 → error:permission).
    # confluence_browser_search 와 동일 패턴으로 non-destructive dev_web_browse 래퍼가 세션
    # 자동확보+read-only navigate+snapshot 을 대신하고, read-only browser_query 로 스냅샷/
    # 스크린샷을 본다. 둘 다 _DEEP_DIVE_TOOLS 라 sweep 후 계약(deep-dive) 을 충족한다.
    assert "dev_web_browse" in names
    assert "browser_query" in names
    assert "browser_session" not in names
    assert "browser_action" not in names
    assert {"dev_web_browse", "browser_query"} <= dev_web_task_agent._DEEP_DIVE_TOOLS
    assert "dev_web_browse" in user_text
    assert "raw browser_session/browser_action은 이 워커에서 쓰지 않는다" in user_text
    assert "상단/좌측 메뉴" in user_text
    assert "키워드/엔트로피/파일명만으로 제출하지 말고" in user_text


def test_dev_web_unlock_map_includes_browser_tools() -> None:
    from engine_extracts.skill_default_unlock_tools import DEFAULT_UNLOCK_TOOLS_BY_SKILL

    for skill_name in ("dev_web_tasking", "dev_web_task"):
        tools = set(DEFAULT_UNLOCK_TOOLS_BY_SKILL[skill_name])
        assert {"browser_session", "browser_action", "browser_query"} <= tools


def test_dev_web_task_requires_browser_call_after_sweep() -> None:
    from service.agents import dev_web_task_agent

    assert dev_web_task_agent._has_post_sweep_browser_deep_dive({
        "tool_calls": [
            {"name": "web_site_sweep", "success": True},
            {"name": "browser_query", "success": True},
        ],
    })
    assert not dev_web_task_agent._has_post_sweep_browser_deep_dive({
        "tool_calls": [
            {"name": "browser_query", "success": True},
            {"name": "web_site_sweep", "success": True},
        ],
    })


def test_github_scan_worker_contract_keeps_api_search_fail_closed() -> None:
    text = (ROOT / "domains/services/github/skills/github_scan/worker.md").read_text()

    assert "GitHub API candidate search" in text
    assert "Fetch detailed file or patch content only for the API-selected candidates" in text
    assert "API search is\n   explicitly disabled, returns no candidates" in text
    assert "outage classified as unavailable" in text
    assert "code search, candidate parsing, or candidate detail fetch fails" in text
    assert "do not\n   silently clone or broad-scan" in text
    assert "every file detail refetch is missing" in text
    assert "recommended_target_status" in text
    assert "status_reason" in text
    assert "github_repo_set_status" in text
    assert "`error` or `skipped`" in text
    assert "metadata is not found" in text
    assert "classified target `error` is a completed target outcome" in text
    assert "mistakenly requests another terminal status" in text


def test_github_sso_task_worker_contract_uses_repo_scan_api_first() -> None:
    worker = (ROOT / "domains/services/github/skills/github_task/worker.md").read_text()
    skill = (ROOT / "domains/services/github/skills/github_task/SKILL.md").read_text()
    root = (ROOT / "domains/services/github/SKILL.md").read_text()

    assert "Call `web_site_sweep(domain=<target.url>)` once first" in worker
    assert "github_task_scan(repos=[<owner/repo>])" in worker
    assert "blob/raw/blame URL exposes ref/path" in worker
    assert "preserve\n  that full visible ref instead of truncating it to `refs`" in worker
    assert "tree URL exposes ref/path" in worker
    assert "`directory_paths=[<path>]`" in worker
    assert 'root tree such\n  as `/tree/<ref>`, pass `directory_paths=["."]`' in worker
    assert "archive URL exposes `/archive/<ref>.zip`" in worker
    assert "`/archive/refs/heads/<branch>.zip`" in worker
    assert "`directory_paths=[\".\"]`" in worker
    assert "commit URL exposes `/commit/<sha>`" in worker
    assert "commits listing URL exposes `/commits`" in worker
    assert "`include_commit_list=True`" in worker
    assert "pull request URL exposes `/pull/<number>`" in worker
    assert "pull requests listing URL exposes `/pulls`" in worker
    assert "`include_pull_requests=True`" in worker
    assert "issue URL exposes `/issues/<number>`" in worker
    assert "issues listing URL exposes `/issues`" in worker
    assert "`include_issues=True`" in worker
    assert "compare URL exposes `/compare/<base>...<head>`" in worker
    assert "release URL exposes `/releases/tag/<tag>`" in worker
    assert "`/releases/download/<tag>/<asset>`" in worker
    assert "releases listing URL exposes `/releases`" in worker
    assert "`include_releases=True`" in worker
    assert "branches listing URL exposes `/branches`" in worker
    assert "`include_branches=True`" in worker
    assert "tags listing URL exposes `/tags`" in worker
    assert "`include_tags=True`" in worker
    assert "GitHub code search URL exposes `q=` terms" in worker
    assert "A path repo\n  always wins over any query owner qualifier" in worker
    assert "single `org:<ORG>` or `user:<OWNER>` qualifier" in worker
    assert 'github_task_scan(org="<ORG>"' in worker
    # 2026-08-22: 전역 code_search 지시가 worker.md 에서 빠졌다(은퇴). 대신 그 사실이
    # 프롬프트에 **남아 있는지**를 고정한다 — 없으면 모델이 다시 켠다.
    # 2026-08-22: 워커의 검색 경로가 **API → 브라우저**로 바뀌었다(confluence 와 같은 패턴).
    # code search API 는 secondary rate limit 이 키워드당 ~30초를 요구해 워커 idle 예산을
    # 넘긴다. 프롬프트가 그 사실과 **대안**을 둘 다 말해야 모델이 다시 API 로 안 간다.
    # ★ 2026-08-27: "브라우저로 검색하라" 를 뒤집었다.
    #   그 규칙은 회피책이었다 — code_search 백오프(최대 225s)가 검토원 idle 예산 300s 를
    #   넘겨 런을 죽였기 때문이다. 예산이 900s 가 되어 전제가 사라졌다.
    #   실측 2026-08-27: 검토원이 도구 10회 중 8회를 브라우저 탐색에 썼고, 왕복 하나가
    #   300s 를 넘은 적도 있다. 찾기는 코드가, 판단은 LLM 이 한다.
    assert "Let the scanner search. You judge." in worker
    assert "Search with the browser, not the API" not in worker, "옛 회피책이 되살아났다"
    assert "Use `github_browse` **after** the scanner" in worker, "브라우저 금지가 아니라 순서다"
    assert "Do **not** pass `api_search_first`" in worker
    assert 'github_browse(url="https://github.samsungds.net/search?q=' in worker
    assert "Do not enumerate unrelated organizations, repositories, or URLs" in worker
    assert "status tool preserves that scan recommendation" in worker
    assert "mistakenly requests another terminal status" in worker
    assert 'github_task_scan(repos=["<owner>/<repo>"])' in skill
    assert "blob/raw/blame URL에서 ref/path" in skill
    assert "보이는 전체 ref를 보존한다" in skill
    assert "tree URL에서 ref/path" in skill
    assert "`directory_paths=[...]`" in skill
    assert 'root tree URL(`/tree/<ref>`)은 `directory_paths=["."]`' in skill
    assert "archive URL(`/archive/<ref>.zip`" in skill
    assert "`directory_paths=[\".\"]`" in skill
    assert "commit URL(`/commit/<sha>`)" in skill
    assert "commits 목록 URL(`/commits`)" in skill
    assert "`include_commit_list=True`" in skill
    assert "pull request URL(`/pull/<number>`" in skill
    assert "pull requests 목록 URL(`/pulls`)" in skill
    assert "`include_pull_requests=True`" in skill
    assert "issue URL(`/issues/<number>`)" in skill
    assert "issues 목록 URL(`/issues`)" in skill
    assert "`include_issues=True`" in skill
    assert "compare URL(`/compare/<base>...<head>`)" in skill
    assert "release URL(`/releases/tag/<tag>`, `/releases/download/<tag>/<asset>`)" in skill
    assert "releases 목록 URL(`/releases`)" in skill
    assert "`include_releases=True`" in skill
    assert "branches 목록 URL(`/branches`)" in skill
    assert "`include_branches=True`" in skill
    assert "tags 목록 URL(`/tags`)" in skill
    assert "`include_tags=True`" in skill
    assert "GitHub code search URL이면 `q=`" in skill
    assert 'github_task_scan(org="<ORG>"' in skill
    assert "`/search` URL에서 단일 `org:<ORG>` 또는 `user:<OWNER>`" in skill
    assert "query 안의 다른 owner qualifier보다 항상 우선" in skill
    assert "hot-path·명시 후보를 열거한 뒤 상세 파일/커밋" in skill
    assert "전수 clone/history walk로 바로 넘어가지 않는다" in skill
    assert "preserve visible\n   `/refs/heads/<branch>` and `/refs/tags/<tag>` refs" in root
    assert "visible archive ref plus `directory_paths=[\".\"]`" in root
    assert "`/releases/download/<tag>/<asset>` tag as `release_tags=[...]`" in root


def test_github_sso_worker_prompt_no_longer_pins_api_search_first() -> None:
    """★ 2026-08-22 은퇴 — 워커에서 전역 code_search 를 켜지 않는다.

    rate-limit 백오프(간격 30초·총 240초)가 하네스 idle 상한 300초를 넘겨 런을 죽였다.
    전역 검색은 discovery 배치(`--search-sync`)의 것이다.
    ⚠️ confluence 의 `api_search_first`(CQL)는 **그대로다** — 전역 검색이 아니다.
    """
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 7,
            "url": "https://github.samsungds.net/org/repo",
        },
    })

    assert "web_site_sweep(domain=url)을 먼저 실행" in text
    assert "github_task_scan(repos=['org/repo'])" in text
    assert "API 검색 후보를 먼저" in text
    assert "파일/커밋 상세조회로 실제 증거를 보강" in text


def test_github_sso_worker_prompt_extracts_repo_from_deep_url() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 8,
            "url": "https://github.samsungds.net/org/repo/blob/main/app/config.py",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], ref='main', "
        "file_paths=['app/config.py'], code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "보이는 파일 content detail을 API로 정확히 조회" in text
    assert "브라우저/웹 도구를 사용한다" in text


def test_github_sso_worker_prompt_uses_raw_file_hints_api_first() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 10,
            "url": "https://github.samsungds.net/org/repo/raw/develop/.npmrc",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], ref='develop', "
        "file_paths=['.npmrc'], code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "보이는 파일 content detail을 API로 정확히 조회" in text


def test_github_sso_worker_prompt_preserves_explicit_refs_path_api_first() -> None:
    from service.agents import github_task_worker

    cases = (
        (
            "https://github.samsungds.net/org/repo/raw/refs/heads/main/.npmrc",
            "ref='refs/heads/main'",
            "file_paths=['.npmrc']",
        ),
        (
            "https://github.samsungds.net/org/repo/blob/refs/tags/v1.2.3/config/prod.env",
            "ref='refs/tags/v1.2.3'",
            "file_paths=['config/prod.env']",
        ),
        (
            "https://github.samsungds.net/org/repo/tree/refs/heads/main",
            "ref='refs/heads/main'",
            "directory_paths=['.']",
        ),
    )
    for target_id, (url, ref_text, scope_text) in enumerate(cases, start=33):
        text = github_task_worker._build_user_text({
            "charter_ref": "SECOPS-2026-001",
            "target": {"kind": "sso_url", "target_id": target_id, "url": url},
        })

        assert "github_task_scan(repos=['org/repo']" in text
        assert ref_text in text
        assert scope_text in text
        assert "code_search_terms=[], hot_paths=[], include_commits=False" in text
        assert "ref='refs'," not in text


def test_github_sso_worker_prompt_uses_blame_file_hints_api_first() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 21,
            "url": "https://github.samsungds.net/org/repo/blame/main/config/prod.env",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], ref='main', "
        "file_paths=['config/prod.env'], code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "보이는 파일 content detail을 API로 정확히 조회" in text


def test_github_sso_worker_prompt_uses_tree_path_as_exact_directory_hint() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 11,
            "url": "https://github.samsungds.net/org/repo/tree/main/config",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], ref='main', "
        "directory_paths=['config'], code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "보이는 디렉터리 tree 후보를 API로 정확히 조회" in text


def test_github_sso_worker_prompt_uses_tree_root_as_exact_directory_hint() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 24,
            "url": "https://github.samsungds.net/org/repo/tree/main",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], ref='main', "
        "directory_paths=['.'], code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "보이는 디렉터리 tree 후보를 API로 정확히 조회" in text
    assert "파일/커밋 상세조회로 실제 증거를 보강" not in text


def test_github_sso_worker_prompt_uses_archive_ref_as_exact_root_tree_hint() -> None:
    from service.agents import github_task_worker

    cases = (
        (
            "https://github.samsungds.net/org/repo/archive/refs/heads/main.zip",
            "ref='refs/heads/main'",
        ),
        (
            "https://github.samsungds.net/org/repo/archive/refs/tags/release/2026.tar.gz",
            "ref='refs/tags/release/2026'",
        ),
        (
            "https://github.samsungds.net/org/repo/archive/abcdef1234567890.zip",
            "ref='abcdef1234567890'",
        ),
    )
    for target_id, (url, ref_text) in enumerate(cases, start=36):
        text = github_task_worker._build_user_text({
            "charter_ref": "SECOPS-2026-001",
            "target": {"kind": "sso_url", "target_id": target_id, "url": url},
        })

        assert "github_task_scan(repos=['org/repo']" in text
        assert ref_text in text
        assert "directory_paths=['.']" in text
        assert "code_search_terms=[], hot_paths=[], include_commits=False" in text
        assert "보이는 디렉터리 tree 후보를 API로 정확히 조회" in text
        assert "파일/커밋 상세조회로 실제 증거를 보강" not in text


def test_github_sso_worker_prompt_uses_commit_sha_as_exact_api_candidate() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 12,
            "url": "https://github.samsungds.net/org/repo/commit/abcdef1234567890",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "commit_shas=['abcdef1234567890'], code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "API 검색 후보를 먼저" in text


def test_github_sso_worker_prompt_uses_commits_list_as_api_candidate_list() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 28,
            "url": "https://github.samsungds.net/org/repo/commits",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "include_commit_list=True, code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "URL에서 owner/repo commits 목록 후보가 보이면" in text
    assert "commit 목록을 API로 먼저 열거" in text
    assert "파일/커밋 상세조회로 실제 증거를 보강" not in text


def test_github_sso_worker_prompt_uses_pull_request_files_as_exact_api_candidate() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 16,
            "url": "https://github.samsungds.net/org/repo/pull/42/files",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "pull_numbers=[42], code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "API 검색 후보를 먼저" in text


def test_github_sso_worker_prompt_uses_pull_request_list_as_api_candidate_list() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 29,
            "url": "https://github.samsungds.net/org/repo/pulls",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "include_pull_requests=True, code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "URL에서 owner/repo pull requests 목록 후보가 보이면" in text
    assert "PR 목록을 API로 먼저 열거" in text
    assert "파일/커밋 상세조회로 실제 증거를 보강" not in text


def test_github_sso_worker_prompt_uses_issue_as_exact_api_candidate() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 22,
            "url": "https://github.samsungds.net/org/repo/issues/77",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "issue_numbers=[77], code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "API 검색 후보를 먼저" in text


def test_github_sso_worker_prompt_uses_issue_list_as_api_candidate_list() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 30,
            "url": "https://github.samsungds.net/org/repo/issues",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "include_issues=True, code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "URL에서 owner/repo issues 목록 후보가 보이면" in text
    assert "issue 목록을 API로 먼저 열거" in text
    assert "파일/커밋 상세조회로 실제 증거를 보강" not in text


def test_github_sso_worker_prompt_uses_compare_files_as_exact_api_candidate() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 17,
            "url": "https://github.samsungds.net/org/repo/compare/main...feature",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "compare_refs=['main...feature'], code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "API 검색 후보를 먼저" in text


def test_github_sso_worker_prompt_uses_release_tag_as_exact_api_candidate() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 23,
            "url": "https://github.samsungds.net/org/repo/releases/tag/v1.2.3",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "release_tags=['v1.2.3'], code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "보이는 release note와 asset metadata detail을 API로 정확히 조회" in text


def test_github_sso_worker_prompt_uses_release_download_as_exact_api_candidate() -> None:
    from service.agents import github_task_worker

    cases = (
        ("https://github.samsungds.net/org/repo/releases/download/v1.2.3/deploy.env", "v1.2.3"),
        ("https://github.samsungds.net/org/repo/releases/download/release/2026/deploy.env", "release/2026"),
    )
    for target_id, (url, tag) in enumerate(cases, start=32):
        text = github_task_worker._build_user_text({
            "charter_ref": "SECOPS-2026-001",
            "target": {"kind": "sso_url", "target_id": target_id, "url": url},
        })

        assert (
            "github_task_scan(repos=['org/repo'], "
            f"release_tags=['{tag}'], code_search_terms=[], hot_paths=[], "
            "include_commits=False)"
        ) in text
        assert "보이는 release note와 asset metadata detail을 API로 정확히 조회" in text
        assert "파일/커밋 상세조회로 실제 증거를 보강" not in text


def test_github_sso_worker_prompt_uses_releases_list_as_api_candidate_list() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 25,
            "url": "https://github.samsungds.net/org/repo/releases",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "include_releases=True, code_search_terms=[], hot_paths=[], "
        "include_commits=False)"
    ) in text
    assert "URL에서 owner/repo releases 목록 후보가 보이면" in text
    assert "release 목록을 API로 먼저 열거" in text
    assert "파일/커밋 상세조회로 실제 증거를 보강" not in text


def test_github_sso_worker_prompt_uses_branches_list_as_api_candidate_list() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 26,
            "url": "https://github.samsungds.net/org/repo/branches",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "include_branches=True, code_search_terms=[], include_commits=False)"
    ) in text
    assert "URL에서 owner/repo branches 목록 후보가 보이면" in text
    assert "branch 목록을 API로 먼저 열거" in text
    assert "파일/커밋 상세조회로 실제 증거를 보강" not in text


def test_github_sso_worker_prompt_uses_tags_list_as_api_candidate_list() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 27,
            "url": "https://github.samsungds.net/org/repo/tags",
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "include_tags=True, code_search_terms=[], include_commits=False)"
    ) in text
    assert "URL에서 owner/repo tags 목록 후보가 보이면" in text
    assert "tag 목록을 API로 먼저 열거" in text
    assert "파일/커밋 상세조회로 실제 증거를 보강" not in text


def test_github_sso_worker_prompt_uses_repo_search_query_terms_api_first() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 13,
            "url": (
                "https://github.samsungds.net/org/repo/search"
                "?q=filename%3A.env+password&type=code"
            ),
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "code_search_terms=['filename:.env', 'password'], hot_paths=['.env'])"
    ) in text
    assert "API 검색 후보를 먼저" in text


def test_github_sso_worker_prompt_extracts_repo_from_global_code_search() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 14,
            "url": (
                "https://github.samsungds.net/search"
                "?q=repo%3Aorg%2Frepo+path%3Aconfig%2Fprod+DB_PASSWORD&type=code"
            ),
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "code_search_terms=['path:config/prod', 'DB_PASSWORD'], "
        "hot_paths=['config/prod'])"
    ) in text
    assert "web_site_sweep digest에서" not in text


def test_github_sso_worker_prompt_extracts_org_from_global_code_search() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 18,
            "url": (
                "https://github.samsungds.net/search"
                "?q=org%3Aplatform+filename%3A.env+DB_PASSWORD&type=code"
            ),
        },
    })

    assert (
        "github_task_scan(org='platform', "
        "code_search_terms=['filename:.env', 'DB_PASSWORD'], hot_paths=['.env'])"
    ) in text
    assert "URL에서 단일 owner code search 후보가 보이면" in text
    assert "web_site_sweep digest에서" not in text


def test_github_sso_worker_prompt_extracts_user_owner_from_global_code_search() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 22,
            "url": (
                "https://github.samsungds.net/search"
                "?q=user%3Aplatform+path%3Aconfig%2Fprod+DB_PASSWORD&type=code"
            ),
        },
    })

    assert (
        "github_task_scan(org='platform', "
        "code_search_terms=['path:config/prod', 'DB_PASSWORD'], "
        "hot_paths=['config/prod'])"
    ) in text
    assert "URL에서 단일 owner code search 후보가 보이면" in text
    assert "web_site_sweep digest에서" not in text


def test_github_sso_worker_prompt_does_not_broaden_org_only_search() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 19,
            "url": "https://github.samsungds.net/search?q=org%3Aplatform&type=code",
        },
    })

    assert "github_task_scan(org=" not in text
    assert "web_site_sweep digest에서" in text
    assert "repo 식별자가 없으면 현재 URL 1건의 sweep/browser 증거 안에서만 판단" in text


def test_github_sso_worker_prompt_does_not_broaden_multiple_user_owner_search() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 23,
            "url": (
                "https://github.samsungds.net/search"
                "?q=user%3Aplatform+user%3Aother+filename%3A.env&type=code"
            ),
        },
    })

    assert "github_task_scan(org=" not in text
    assert "web_site_sweep digest에서" in text
    assert "repo 식별자가 없으면 현재 URL 1건의 sweep/browser 증거 안에서만 판단" in text


def test_github_sso_worker_prompt_keeps_path_repo_over_search_repo_qualifier() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 15,
            "url": (
                "https://github.samsungds.net/org/repo/search"
                "?q=repo%3Aother%2Fsecret+filename%3A.env&type=code"
            ),
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "code_search_terms=['filename:.env'], hot_paths=['.env'])"
    ) in text
    assert "other/secret" not in text


def test_github_sso_worker_prompt_keeps_path_repo_over_search_org_qualifier() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 20,
            "url": (
                "https://github.samsungds.net/org/repo/search"
                "?q=org%3Aplatform+filename%3A.env&type=code"
            ),
        },
    })

    assert (
        "github_task_scan(repos=['org/repo'], "
        "code_search_terms=['filename:.env'], hot_paths=['.env'])"
    ) in text
    assert "github_task_scan(org=" not in text
    assert "org='platform'" not in text


def test_github_sso_worker_prompt_handles_non_repo_url_without_broad_enum() -> None:
    from service.agents import github_task_worker

    text = github_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 9,
            "url": "https://github.samsungds.net/orgs/platform/teams/secops",
        },
    })

    assert "web_site_sweep digest에서" in text
    assert "github_task_scan(...)" in text
    assert "repo 식별자가 없으면 현재 URL 1건의 sweep/browser 증거 안에서만 판단" in text


def test_github_sso_worker_prompt_rejects_malformed_repo_segments_without_api_target() -> None:
    from service.agents import github_task_worker

    for target_id, url in enumerate(
        (
            "https://github.samsungds.net/org!/repo/blob/main/.env",
            "https://github.samsungds.net/org/repo$/tree/main/config",
        ),
        start=31,
    ):
        text = github_task_worker._build_user_text({
            "charter_ref": "SECOPS-2026-001",
            "target": {
                "kind": "sso_url",
                "target_id": target_id,
                "url": url,
            },
        })

        assert "github_task_scan(repos=" not in text
        assert "file_paths=" not in text
        assert "directory_paths=" not in text
        assert "web_site_sweep digest에서" in text
        assert "repo 식별자가 없으면 현재 URL 1건의 sweep/browser 증거 안에서만 판단" in text


def test_github_report_worker_contract_pins_mail_safety() -> None:
    text = (ROOT / "domains/services/github/skills/github_report/worker.md").read_text()

    assert "Load all lifecycle findings referenced by the thread" in text
    assert "Keep report evidence masked and path/commit-oriented" in text
    assert "Do not fetch live GitHub content, clone repositories, poll POP3" in text
    assert "Default recipient policy is DSSOC-only" in text
    assert "explicitly set to owner/production" in text
    assert "recipients, cc, subject, and\n   body prepared by the report runtime" in text
    assert "do not add owners or fallback\n   recipients manually" in text
    assert "delivery returns `sent`, transition the thread to `awaiting_owner`" in text
    assert "`dry_run` or fails, keep the thread `report_ready`" in text


def test_github_recheck_worker_contract_mentions_bounded_attempts() -> None:
    text = (ROOT / "domains/services/github/skills/github_recheck/worker.md").read_text()

    assert "Retry attempts are bounded by runtime `attempt_count`" in text
    assert "cap-exceeded threads\n   are escalated without another recheck or delivery" in text
    assert "guidance deliveries count toward the same bounded\n   attempt cap" in text
    assert "Original Message` separator" in text
    assert "new human reply text before that separator" in text
    assert "In-Reply-To`, `References`, and\n   root message metadata" in text
    assert "Do not invent recipients or mail-client prefixes\n   yourself" in text


def test_github_root_skill_contract_mentions_bounded_recheck_attempts() -> None:
    text = (ROOT / "domains/services/github/SKILL.md").read_text()

    assert "Unknown technical recheck results stay `recheck_requested`" in text
    assert "default 8 hours" in text
    assert "How-to guidance dry-runs or delivery failures keep the thread" in text
    assert "runtime\n  `attempt_count` cap" in text
    assert "cap-exceeded threads are escalated instead of rechecked\n  or mailed again" in text


def test_confluence_root_skill_doc_does_not_instruct_rest() -> None:
    """루트 SKILL.md 는 스킬로 로드되진 않지만 사람이 읽는 문서다.

    코드와 반대를 말하는 문서를 남기면, 다음 사람이 그걸 근거로 REST 를 되살린다 —
    이번 사고가 정확히 그렇게 시작했다(진단은 주석에 있었고 배선만 안 따라왔다).
    """
    text = (ROOT / "domains/services/confluence/SKILL.md").read_text()

    for tool in ("confluence_task_scan(", "confluence_list_pages(",
                 "confluence_fetch_page(", "confluence_fetch_attachment("):
        assert tool not in text, f"루트 문서가 없는 도구를 지시한다: {tool}"
    assert "confluence_browser_search" in text


def test_jenkins_root_skill_contract_supports_exact_build_targets() -> None:
    text = (ROOT / "domains/services/jenkins/SKILL.md").read_text()

    assert 'jenkins_task_scan(build_targets=[{"job_full_name":"...","build_number":N}]' in text
    assert "해당 console log만 API detail 조회" in text
    assert "recent-build 목록으로 넓히지 않는다" in text
    assert "exact build console 을 찾지 못하면 0건 정상으로 넘기지 않고 errors에 남긴다" in text
    assert "해당 phase를\n   errors에 남기고 가능한 나머지 detail 조회는 계속한다" in text
    assert "scan_status/recommended_target_status" in text




def test_confluence_sso_worker_prompt_keeps_url_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 7,
            "url": "https://confluence.samsungds.net/display/SECOPS/Runbook",
        },
    })

    assert "web_site_sweep(domain=url)을 먼저 실행" in text
    assert "Confluence space/page 후보는 반드시 API 검색/상세조회로 먼저 정밀 확인" in text
    assert "confluence_task_scan(space_keys=['SECOPS'], api_search_first=True" in text
    assert "scan_comments=True, scan_history=True" in text
    assert "브라우저/웹 도구를 사용한다" in text
    assert "status='tasked' 또는 'skipped' 또는 'error'" in text


def test_confluence_sso_worker_prompt_uses_page_id_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 8,
            "url": "https://confluence.samsungds.net/pages/viewpage.action?pageId=123456",
        },
    })

    assert "confluence_task_scan(page_ids=['123456'], api_search_first=True" in text
    assert "API 검색 후보가 page/comment/version/첨부 상세조회로 실제 증거를 보강" in text


def test_confluence_sso_worker_prompt_uses_comment_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 18,
            "url": (
                "https://confluence.samsungds.net/pages/viewpage.action"
                "?pageId=123456&focusedCommentId=98765"
            ),
        },
    })

    assert (
        "confluence_task_scan(comment_ids=[{'page_id': '123456', "
        "'comment_id': '98765'}]"
    ) in text
    assert "URL에서 direct comment 후보가 보이면" in text
    assert "confluence_task_scan(page_ids=['123456'], api_search_first=True" not in text
    assert "API 검색 후보가 page/comment/version/첨부 상세조회로 실제 증거를 보강" in text


def test_confluence_sso_worker_prompt_uses_attachment_page_id_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 11,
            "url": (
                "https://confluence.samsungds.net/download/attachments/"
                "5555/secrets.env?version=1&modificationDate=1782880000000"
            ),
        },
    })

    assert (
        "confluence_task_scan(attachment_downloads=[{'page_id': '5555', "
        "'download_url': '/download/attachments/5555/secrets.env'}]"
    ) in text
    assert "confluence_task_scan(page_ids=['5555'], api_search_first=True" not in text
    assert "page_versions=" not in text
    assert "API 검색 후보가 page/comment/version/첨부 상세조회로 실제 증거를 보강" in text


def test_confluence_sso_worker_prompt_preserves_encoded_attachment_path() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 31,
            "url": (
                "https://confluence.samsungds.net/download/attachments/"
                "5555/prod%20secrets.env?version=1"
            ),
        },
    })

    assert (
        "confluence_task_scan(attachment_downloads=[{'page_id': '5555', "
        "'download_url': '/download/attachments/5555/prod%20secrets.env'}], "
        ""
    ) in text
    assert "/download/attachments/5555/prod secrets.env" not in text


def test_confluence_sso_worker_prompt_uses_diff_version_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 17,
            "url": (
                "https://confluence.samsungds.net/pages/diffpagesbyversion.action"
                "?pageId=123456&selectedPageVersions=4&selectedPageVersions=7"
            ),
        },
    })

    assert (
        "confluence_task_scan(page_versions=[{'page_id': '123456', 'version': 4}, "
        "{'page_id': '123456', 'version': 7}]"
    ) in text
    assert "URL에서 특정 page version 후보가 보이면" in text
    assert "confluence_task_scan(page_ids=['123456'], api_search_first=True" not in text


def test_confluence_sso_worker_prompt_uses_query_space_key_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 9,
            "url": (
                "https://confluence.samsungds.net/pages/viewpage.action"
                "?spaceKey=SECOPS&title=Runbook"
            ),
        },
    })

    assert "confluence_task_scan(space_keys=['SECOPS'], api_search_first=True" in text
    assert "URL에서 space key 후보가 보이면" in text
    assert (
        'confluence_task_scan(cql=\'space = "SECOPS" AND type = page AND title ~ "Runbook"\', '
        ""
    ) in text
    assert "URL에서 page title 후보가 보이면" in text


def test_confluence_sso_worker_prompt_uses_display_title_cql_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 10,
            "url": "https://confluence.samsungds.net/display/SECOPS/Runbook+Guide",
        },
    })

    assert "confluence_task_scan(space_keys=['SECOPS'], api_search_first=True" in text
    assert (
        'confluence_task_scan(cql=\'space = "SECOPS" AND type = page AND title ~ "Runbook Guide"\', '
        ""
    ) in text


def test_confluence_sso_worker_prompt_uses_page_list_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 24,
            "url": "https://confluence.samsungds.net/spaces/SECOPS/pages",
        },
    })

    assert (
        "confluence_task_scan(space_keys=['SECOPS'], api_search_first=True, "
        "include_pages=True, scan_comments=True, scan_history=True)"
    ) in text
    assert "URL에서 Confluence page list 후보가 보이면" in text
    assert "bounded page 목록만 API로 열거" in text
    assert "URL에서 space key 후보가 보이면" not in text


def test_confluence_sso_worker_prompt_uses_attachment_list_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 25,
            "url": (
                "https://confluence.samsungds.net/pages/viewpageattachments.action"
                "?pageId=5555"
            ),
        },
    })

    assert (
        "confluence_task_scan(page_ids=['5555'], api_search_first=True, "
        "include_attachments=True, fetch_attachments=True, scan_comments=False, "
        "scan_history=False)"
    ) in text
    assert "URL에서 Confluence attachment list 후보가 보이면" in text
    assert "bounded text attachment 목록만 API로 열거" in text
    assert "confluence_task_scan(page_ids=['5555'], api_search_first=True, scan_comments=True" not in text


def test_confluence_sso_worker_prompt_uses_blogpost_list_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 26,
            "url": "https://confluence.samsungds.net/spaces/SECOPS/blog",
        },
    })

    assert (
        "confluence_task_scan(space_keys=['SECOPS'], api_search_first=True, "
        "include_blogposts=True, scan_comments=True, scan_history=True)"
    ) in text
    assert "URL에서 Confluence blog list 후보가 보이면" in text
    assert "bounded blogpost 목록만 API로 열거" in text
    assert "URL에서 space key 후보가 보이면" not in text
    assert "URL에서 blogpost title 후보가 보이면" not in text


def test_confluence_sso_worker_prompt_uses_display_blogpost_cql_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 19,
            "url": "https://confluence.samsungds.net/display/SECOPS/2026/07/01/Deploy+Secrets",
        },
    })

    assert "confluence_task_scan(space_keys=['SECOPS'], api_search_first=True" in text
    assert (
        'confluence_task_scan(cql=\'space = "SECOPS" AND type = blogpost AND title ~ "Deploy Secrets"\', '
        ""
    ) in text
    assert "URL에서 blogpost title 후보가 보이면" in text
    assert 'type = page AND title ~ "2026"' not in text


def test_confluence_sso_worker_prompt_uses_spaces_blogpost_cql_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 20,
            "url": "https://confluence.samsungds.net/spaces/SECOPS/blog/2026/7/1/Vault+Rotation",
        },
    })

    assert "confluence_task_scan(space_keys=['SECOPS'], api_search_first=True" in text
    assert (
        'confluence_task_scan(cql=\'space = "SECOPS" AND type = blogpost AND title ~ "Vault Rotation"\', '
        ""
    ) in text
    assert "URL에서 blogpost title 후보가 보이면" in text
    assert 'type = page AND title ~ "2026"' not in text


def test_confluence_sso_worker_prompt_uses_label_path_cql_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 21,
            "url": "https://confluence.samsungds.net/label/SECOPS/prod-secrets",
        },
    })

    assert "confluence_task_scan(space_keys=['SECOPS'], api_search_first=True" in text
    assert (
        'confluence_task_scan(cql=\'space = "SECOPS" AND label = "prod-secrets"\', '
        ""
    ) in text
    assert "URL에서 Confluence label 후보가 보이면" in text
    assert "web_site_sweep digest에서" not in text


def test_confluence_sso_worker_prompt_uses_label_query_cql_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 22,
            "url": (
                "https://confluence.samsungds.net/labels/viewlabel.action"
                "?key=SECOPS&label=vault-token"
            ),
        },
    })

    assert "confluence_task_scan(space_keys=['SECOPS'], api_search_first=True" in text
    assert (
        'confluence_task_scan(cql=\'space = "SECOPS" AND label = "vault-token"\', '
        ""
    ) in text
    assert "URL에서 Confluence label 후보가 보이면" in text
    assert "web_site_sweep digest에서" not in text


def test_confluence_sso_worker_prompt_rejects_malformed_space_without_global_cql() -> None:
    from service.agents import confluence_task_worker

    urls = (
        "https://confluence.samsungds.net/display/OPS!/Runbook",
        "https://confluence.samsungds.net/spaces/SEC-/pages",
        "https://confluence.samsungds.net/label/BAD!/prod-secrets",
    )
    for idx, url in enumerate(urls, start=30):
        text = confluence_task_worker._build_user_text({
            "charter_ref": "SECOPS-2026-001",
            "target": {"kind": "sso_url", "target_id": idx, "url": url},
        })

        assert "confluence_task_scan(space_keys=" not in text
        assert "confluence_task_scan(cql=" not in text
        assert "URL에서 page title 후보" not in text
        assert "URL에서 Confluence label 후보" not in text
        assert "URL에서 Confluence page list 후보" not in text
        assert "web_site_sweep digest에서" in text


def test_confluence_sso_worker_prompt_uses_search_query_cql_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 12,
            "url": (
                "https://confluence.samsungds.net/dosearchsite.action"
                "?queryString=DB_PASSWORD&spaceKey=SECOPS"
            ),
        },
    })

    assert "confluence_task_scan(space_keys=['SECOPS'], api_search_first=True" in text
    assert (
        'confluence_task_scan(cql=\'space = "SECOPS" AND type = page AND text ~ "DB_PASSWORD"\', '
        ""
    ) in text
    assert (
        'confluence_task_scan(cql=\'space = "SECOPS" AND type = page AND title ~ "DB_PASSWORD"\', '
        ""
    ) in text
    assert "URL에서 Confluence search query 후보가 보이면" in text


def test_confluence_sso_worker_prompt_uses_global_search_query_cql_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 13,
            "url": "https://confluence.samsungds.net/search?text=admin+password",
        },
    })

    assert (
        "confluence_task_scan(cql='type = page AND text ~ \"admin password\"', "
        ""
    ) in text
    assert (
        "confluence_task_scan(cql='type = page AND title ~ \"admin password\"', "
        ""
    ) in text
    assert "web_site_sweep digest에서" not in text


def test_confluence_sso_worker_prompt_uses_search_query_namespace_api_first() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 16,
            "url": (
                "https://confluence.samsungds.net/search"
                "?searchQuery.queryString=vault+token&searchQuery.spaceKey=SECOPS"
            ),
        },
    })

    assert "confluence_task_scan(space_keys=['SECOPS'], api_search_first=True" in text
    assert (
        'confluence_task_scan(cql=\'space = "SECOPS" AND type = page AND text ~ "vault token"\', '
        ""
    ) in text
    assert (
        'confluence_task_scan(cql=\'space = "SECOPS" AND type = page AND title ~ "vault token"\', '
        ""
    ) in text
    assert "web_site_sweep digest에서" not in text


def test_confluence_sso_worker_prompt_ignores_non_search_text_param() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 14,
            "url": "https://confluence.samsungds.net/pages/viewpage.action?text=DB_PASSWORD",
        },
    })

    assert "Confluence search query 후보" not in text
    assert "web_site_sweep digest에서" in text


def test_confluence_sso_worker_prompt_ignores_non_label_query_param() -> None:
    from service.agents import confluence_task_worker

    text = confluence_task_worker._build_user_text({
        "charter_ref": "SECOPS-2026-001",
        "target": {
            "kind": "sso_url",
            "target_id": 23,
            "url": "https://confluence.samsungds.net/pages/viewpage.action?label=prod-secrets",
        },
    })

    assert "Confluence label 후보" not in text
    assert "label =" not in text
    assert "web_site_sweep digest에서" in text


def test_confluence_report_worker_contract_pins_mail_safety() -> None:
    text = (
        ROOT / "domains/services/confluence/skills/confluence_report/worker.md"
    ).read_text()

    assert "Read only the thread payload and normalized finding lifecycle rows" in text
    assert "masked hits, asset locations, verification\n  status" in text
    assert "Do not fetch Confluence page content and do not reveal raw secrets" in text
    assert "Do not poll POP3, perform remediation rechecks" in text
    assert "DSSOC-only recipients by\n  default" in text
    assert "explicitly set to\n  owner/production" in text
    assert "recipients, cc, subject, and body prepared by the\n  report runtime" in text
    assert "do not add owners or fallback recipients manually" in text
    assert "delivery returns `sent`, transition the thread to `awaiting_owner`" in text
    assert "`dry_run` or fails, keep the thread `report_ready`" in text


def test_confluence_recheck_worker_contract_mentions_bounded_attempts() -> None:
    text = (ROOT / "domains/services/confluence/skills/confluence_recheck/worker.md").read_text()

    assert "Retry attempts are bounded by runtime\n  `attempt_count`" in text
    assert "cap-exceeded threads are escalated without another refetch\n  or delivery" in text
    assert "guidance deliveries count toward the same bounded attempt cap" in text
    assert "Original Message` separator" in text
    assert "new human reply text before that separator" in text
    assert "In-Reply-To`, `References`, and root message\n  metadata" in text
    assert "Do not invent recipients or mail-client prefixes yourself" in text


def test_confluence_root_skill_contract_mentions_bounded_recheck_attempts() -> None:
    text = (ROOT / "domains/services/confluence/SKILL.md").read_text()

    assert "재검증 unknown 냉각" in text
    assert "기본 8시간 뒤로 예약" in text
    assert "방법 안내메일 재시도는 런타임 `attempt_count` cap 으로 bounded" in text
    assert "cap 초과\n   thread 는 다시 refetch/발송하지 않고 `escalated`" in text


def test_confluence_task_worker_contract_is_browser_only() -> None:
    """★ 2026-08-26: confluence REST 를 도구면에서 뺐다 — 계약도 따라가야 한다.

    옛 계약은 `confluence_task_scan(api_search_first=True)` 와 CQL 을 지시했다.
    그 도구는 이제 없다. 없는 도구를 지시하는 계약은 워커의 턴을 버리고 halt 로 보낸다.

    실측 근거(2026-08-26):
        /rest/api/search   Basic 403 "Basic Authentication has been disabled" · Bearer 429
        /rest/api/space    Basic 403 · Bearer 429
        /rest/api/content  Basic 403 · Bearer 429
    """
    text = (ROOT / "domains/services/confluence/skills/confluence_task/worker.md").read_text()

    for tool in ("confluence_task_scan(", "confluence_list_pages(", "confluence_fetch_page(",
                 "confluence_list_attachments(", "confluence_fetch_attachment("):
        assert tool not in text, f"계약이 없는 도구를 지시한다: {tool}"
    assert "browser only" in text.lower()
    assert "confluence_browser_search(" in text
    assert "scope_space_keys" in text
    # ★ 0건은 "봤는데 없음"(tasked)이지 "못 봄"(skipped)이 아니다.
    assert "Zero search results is `tasked`" in text


def test_confluence_sso_contract_sweeps_then_searches_in_the_browser() -> None:
    """sso_url 은 sweep 으로 좌표를 얻고 **브라우저 검색**으로 확인한다."""
    worker = (ROOT / "domains/services/confluence/skills/confluence_task/worker.md").read_text()

    assert "web_site_sweep(domain=<target.url>)" in worker
    # ⚠️ sweep 은 target_id 를 받으면 안 된다 — 다른 테이블이라 호출이 거부된다.
    assert "Do not pass `target_id`" in worker
    assert "confluence_browser_search(keywords=[...]," in worker
    assert "devops_target_set_status" in worker
