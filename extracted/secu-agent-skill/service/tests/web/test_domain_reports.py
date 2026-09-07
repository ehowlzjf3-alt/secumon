"""Domain report API."""
from __future__ import annotations


def _set_token(monkeypatch, tok: str = "tok-123"):
    monkeypatch.setenv("SA_CHAT_TOKEN", tok)


def test_domain_report_requires_token(client, monkeypatch):
    _set_token(monkeypatch, "good")
    r = client.get("/api/domain-reports/smb?token=bad")
    assert r.status_code == 401


def test_domain_report_projects_common_finding_schema(tmp_db, client, monkeypatch):
    from secu_agent import state

    _set_token(monkeypatch)
    fid, _ = state.finding_upsert(
        task_type="web",
        asset="https://app.internal/.env",
        asset_kind="url",
        severity="high",
        summary="exposed env",
        evidence_ref="web/finding.json",
        extra={
            "confidence": 0.82,
            "recommended_actions": ["restrict access", "rotate exposed secrets"],
            "hits": [{"kind": "secret"}],
        },
    )

    r = client.get("/api/domain-reports/web?token=tok-123")
    assert r.status_code == 200
    body = r.json()
    assert body["metadata"]["kind"] == "domain_finding_report"
    assert body["metadata"]["domain"] == "web"
    assert body["stats"]["total"] == 1
    assert body["stats"]["open"] == 1
    assert body["stats"]["highest_severity"] == "high"
    assert "next_action" in body["required"]

    item = body["items"][0]
    assert item["id"] == fid
    assert item["domain"] == "web"
    assert item["source_task_type"] == "web"
    assert item["asset"] == "https://app.internal/.env"
    assert item["confidence"] == 0.82
    assert item["next_action"] == "restrict access"
    assert item["context"]["hit_count"] == 1


def test_github_report_groups_github_jenkins_devops(tmp_db, client, monkeypatch):
    """v3.73: devops 통합 도메인 분리 — github 탭이 github+jenkins+(고아)devops 를 묶고,
    confluence 는 별도 탭으로 분리됨."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="github",
        asset="repo/app",
        asset_kind="repo",
        severity="medium",
        summary="secret in repo",
    )
    state.finding_upsert(
        task_type="jenkins",
        asset="job/build",
        asset_kind="job",
        severity="critical",
        summary="credential in console",
    )
    # github 자산이지만 task_type 이 'devops' 로 잘못 태깅된 고아 finding — github 탭이 회수.
    state.finding_upsert(
        task_type="devops",
        asset="https://github.samsungds.net/org/repo/raw/main/.mcp.json",
        asset_kind="repo",
        severity="high",
        summary="internal endpoint in public repo",
    )
    # confluence 는 별도 탭 — github 에 섞이면 안 됨.
    state.finding_upsert(
        task_type="confluence",
        asset="space/PAGE",
        asset_kind="page",
        severity="low",
        summary="page exposure",
    )

    r = client.get("/api/domain-reports/github?token=tok-123")
    assert r.status_code == 200
    body = r.json()
    # v3.74: github 네이티브 task_types = github+jenkins. 레거시 devops(github 자산)는
    # 읽기 라우터가 자산기준으로 회수해 여전히 github 탭에 표시(source_task_type='devops').
    assert body["metadata"]["task_types"] == ["github", "jenkins"]
    assert body["stats"]["total"] == 3
    assert body["stats"]["highest_severity"] == "critical"
    assert {item["source_task_type"] for item in body["items"]} == {
        "github", "jenkins", "devops",
    }

    rc = client.get("/api/domain-reports/confluence?token=tok-123")
    assert rc.status_code == 200
    cbody = rc.json()
    assert cbody["metadata"]["task_types"] == ["confluence"]
    assert cbody["stats"]["total"] == 1
    assert {item["source_task_type"] for item in cbody["items"]} == {"confluence"}


def test_item_has_classification_and_discovered_at(tmp_db, client, monkeypatch):
    """v3.74: hit category → 한국어 분류 라벨 + 발견일자(first_seen) 투영."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="web", asset="https://app.internal/.env", asset_kind="url",
        severity="high", summary="exposed env",
        extra={"hits": [{"category": "secret", "masked": "DB=****"}]},
    )
    body = client.get("/api/domain-reports/web?token=tok-123").json()
    item = body["items"][0]
    assert item["classification"]["key"] == "secret"
    assert item["classification"]["label"] == "시크릿 노출"
    assert item["discovered_at"]  # 비어있지 않음 (YYYY-MM-DD HH:MM)


def test_dedup_collapses_same_host_and_classification(tmp_db, client, monkeypatch):
    """v3.74: 도메인 내 (분류, host) 동일 finding 은 1개로 접고 duplicate_count 표기."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="web", asset="https://dup.internal/.env", asset_kind="url",
        severity="high", summary="env 1", extra={"hits": [{"category": "secret"}]},
    )
    state.finding_upsert(
        task_type="web", asset="https://dup.internal/config.yaml", asset_kind="url",
        severity="medium", summary="env 2", extra={"hits": [{"category": "secret"}]},
    )
    body = client.get("/api/domain-reports/web?token=tok-123").json()
    assert body["stats"]["total"] == 1
    assert body["items"][0]["duplicate_count"] == 2
    # 대표 = 높은 severity
    assert body["items"][0]["severity"] == "high"


def test_pivot_block_projected(tmp_db, client, monkeypatch):
    """v3.74: finding.extra['pivot'] 가 item['pivot'] 로 투영(candidates/probes)."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="web", asset="https://pv.internal/.env", asset_kind="url",
        severity="high", summary="x",
        extra={"hits": [{"category": "secret"}], "pivot": {
            "version": 1, "candidates": ["https://pv.internal/api"],
            "probes": [{"url": "https://pv.internal/api", "status": "200",
                        "exposed": True, "evidence_masked": "k=****"}],
            "exposed_count": 1}},
    )
    body = client.get("/api/domain-reports/web?token=tok-123").json()
    pivot = body["items"][0]["pivot"]
    assert pivot is not None
    assert pivot["exposed_count"] == 1
    assert pivot["candidates"] == ["https://pv.internal/api"]


def test_legacy_devops_routes_by_asset(tmp_db, client, monkeypatch):
    """v3.74: 레거시 task_type='devops' row 는 자산기준으로 github/confluence 에 분배."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="devops",
        asset="https://github.samsungds.net/org/repo/raw/main/.mcp.json",
        asset_kind="url", severity="high", summary="gh devops",
    )
    state.finding_upsert(
        task_type="devops",
        asset="https://confluence.samsungds.net/display/X/Page",
        asset_kind="url", severity="medium", summary="cf devops",
    )
    gh = client.get("/api/domain-reports/github?token=tok-123").json()
    cf = client.get("/api/domain-reports/confluence?token=tok-123").json()
    gh_assets = " ".join(i["asset"] for i in gh["items"])
    cf_assets = " ".join(i["asset"] for i in cf["items"])
    assert "github.samsungds.net" in gh_assets
    assert "confluence.samsungds.net" not in gh_assets
    assert "confluence.samsungds.net" in cf_assets


def test_github_cross_confirm_merges_api_and_sso(tmp_db, client, monkeypatch):
    """v3.75: 같은 repo 자산을 API(github:)·SSO(https raw) 둘 다 잡으면 1행 병합 + 교차확인."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="github", asset="github:RSIP/recipe_encoder/config/config.yaml",
        asset_kind="repository_file", severity="high", summary="api secret",
        extra={"hits": [{"category": "secret"}]})
    state.finding_upsert(
        task_type="github",
        asset="https://github.samsungds.net/raw/RSIP/recipe_encoder/main/config/config.yaml",
        asset_kind="url", severity="critical", summary="sso secret",
        extra={"hits": [{"category": "secret"}]})

    body = client.get("/api/domain-reports/github?token=tok-123").json()
    assert body["stats"]["total"] == 1
    item = body["items"][0]
    assert item["duplicate_count"] == 2
    assert item["discovery_method"] == "api+sso"
    assert item["cross_confirmed"] is True
    assert item["severity"] == "critical"  # 대표 = 높은 severity


def test_github_same_repo_merges_repo_level(tmp_db, client, monkeypatch):
    """v3.77: github finding 은 **repo 단위** 병합 — 같은 repo 면 파일/commit sha 달라도 1행.
    (commit_patch 자산이 sha 때문에 식별자가 매번 유일 → '중첩 안됨' 이던 버그 수정.
    파일/commit 디테일은 members[] 로 보존.)"""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="github", asset="github:O/r/a.yaml", asset_kind="repository_file",
        severity="high", summary="x", extra={"hits": [{"category": "secret"}]})
    state.finding_upsert(
        task_type="github", asset="github:O/r/b.yaml", asset_kind="repository_file",
        severity="medium", summary="y", extra={"hits": [{"category": "secret"}]})
    state.finding_upsert(
        task_type="github", asset="github:O/r/commit/deadbeefcafe", asset_kind="commit_patch",
        severity="high", summary="z", extra={"hits": [{"category": "secret"}]})
    body = client.get("/api/domain-reports/github?token=tok-123").json()
    assert body["stats"]["total"] == 1          # 한 repo = 1행
    item = body["items"][0]
    assert item["duplicate_count"] == 3
    assert item["severity"] == "high"           # 그룹 max
    assert len(item["members"]) == 3            # 파일·commit 디테일 보존


def test_github_distinct_repos_not_merged(tmp_db, client, monkeypatch):
    """다른 repo 는 안 합쳐짐 (repo 단위 식별자)."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="github", asset="github:O/r1/commit/aaa111", asset_kind="commit_patch",
        severity="high", summary="x", extra={"hits": [{"category": "secret"}]})
    state.finding_upsert(
        task_type="github", asset="github:O/r2/commit/bbb222", asset_kind="commit_patch",
        severity="high", summary="y", extra={"hits": [{"category": "secret"}]})
    body = client.get("/api/domain-reports/github?token=tok-123").json()
    assert body["stats"]["total"] == 2


def test_dedup_merges_different_classifications_same_asset(tmp_db, client, monkeypatch):
    """v3.76 (D2): 키=식별자만 — 같은 host 면 분류가 달라도 1행으로 병합, 분류는 전부 모은다."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="web", asset="https://merge.internal/.env", asset_kind="url",
        severity="medium", summary="secret", extra={"hits": [{"category": "secret"}]},
    )
    state.finding_upsert(
        task_type="web", asset="https://merge.internal/users", asset_kind="url",
        severity="critical", summary="pii", extra={"hits": [{"category": "pii"}]},
    )
    body = client.get("/api/domain-reports/web?token=tok-123").json()
    assert body["stats"]["total"] == 1
    item = body["items"][0]
    assert item["duplicate_count"] == 2
    # severity = 그룹 max
    assert item["severity"] == "critical"
    # classifications = 그룹 전체 (category 우선순위 desc — credential>secret>...>pii)
    keys = [c["key"] for c in item["classifications"]]
    assert set(keys) == {"secret", "pii"}
    assert keys[0] == "secret"  # secret(rank 8) > pii(rank 5)
    # classification 단수 = classifications[0] (back-compat)
    assert item["classification"]["key"] == "secret"


def test_dedup_attaches_members(tmp_db, client, monkeypatch):
    """v3.76: 병합된 그룹은 members 에 원본 item 전체를 담는다."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="web", asset="https://m.internal/a", asset_kind="url",
        severity="high", summary="a", extra={"hits": [{"category": "secret"}]},
    )
    state.finding_upsert(
        task_type="web", asset="https://m.internal/b", asset_kind="url",
        severity="low", summary="b", extra={"hits": [{"category": "secret"}]},
    )
    body = client.get("/api/domain-reports/web?token=tok-123").json()
    item = body["items"][0]
    assert len(item["members"]) == 2
    assert {m["asset"] for m in item["members"]} == {
        "https://m.internal/a", "https://m.internal/b",
    }


def test_confluence_dedup_by_space_key(tmp_db, client, monkeypatch):
    """v3.76: confluence 는 space_key 로 병합 — 같은 space 의 다른 page 면 1행."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="confluence", asset="confluence:ENG:101", asset_kind="page",
        severity="high", summary="p1",
        extra={"hits": [{"category": "secret"}], "metadata": {"space_key": "ENG"}},
    )
    state.finding_upsert(
        task_type="confluence", asset="confluence:ENG:202", asset_kind="page",
        severity="medium", summary="p2",
        extra={"hits": [{"category": "secret"}], "metadata": {"space_key": "ENG"}},
    )
    body = client.get("/api/domain-reports/confluence?token=tok-123").json()
    assert body["stats"]["total"] == 1
    assert body["items"][0]["duplicate_count"] == 2
    assert body["items"][0]["severity"] == "high"


def test_item_projects_narrative_and_evidence_notes(tmp_db, client, monkeypatch):
    """v3.76: risk_narrative(빈 strip) + evidence_notes 가 per-evidence 로 join 된다."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="web", asset="https://nv.internal/.env", asset_kind="url",
        severity="high", summary="x",
        extra={
            "hits": [{"category": "secret", "masked": "DB=****",
                      "location": "https://nv.internal/.env"}],
            "risk_narrative": {
                "what_is_data": "DB 연결 문자열",
                "how_discovered": "",  # 빈 — strip 돼야 함
                "exploitation_path": "내부 비인가자가 DB 직접 접근",
                "verification_method": "",
            },
            "evidence_notes": {
                "https://nv.internal/.env": {
                    "what_this_is": "환경설정 파일",
                    "sensitive_fields": ["db_password"],
                    "context_note": "평문 노출",
                },
            },
            "pivot_interpretation": "DB 게이트웨이 도달 가능",
        },
    )
    item = client.get("/api/domain-reports/web?token=tok-123").json()["items"][0]
    rn = item["risk_narrative"]
    assert rn["what_is_data"] == "DB 연결 문자열"
    assert "how_discovered" not in rn  # 빈 subfield strip
    assert item["pivot_interpretation"] == "DB 게이트웨이 도달 가능"
    ev = item["context"]["evidence"][0]
    assert ev["what_this_is"] == "환경설정 파일"
    assert ev["context_note"] == "평문 노출"


def test_item_omits_narrative_when_absent(tmp_db, client, monkeypatch):
    """v3.76: narrative 가 없으면 risk_narrative/pivot_interpretation 키 자체를 생략."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="web", asset="https://plain.internal/.env", asset_kind="url",
        severity="high", summary="x", extra={"hits": [{"category": "secret"}]},
    )
    item = client.get("/api/domain-reports/web?token=tok-123").json()["items"][0]
    assert "risk_narrative" not in item
    assert "pivot_interpretation" not in item


def test_domain_reports_lists_five_groups(client, monkeypatch):
    _set_token(monkeypatch)
    r = client.get("/api/domain-reports?token=tok-123")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 5
    assert [item["metadata"]["domain"] for item in body["items"]] == [
        "smb",
        "web",
        "dev_web",
        "github",
        "confluence",
    ]
