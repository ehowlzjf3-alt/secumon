"""v3.76: GET /api/findings/aggregate — 통합 Findings (4분야 dedup + facets)."""
from __future__ import annotations


def _set_token(monkeypatch, tok: str = "tok-123"):
    monkeypatch.setenv("SA_CHAT_TOKEN", tok)


def test_aggregate_requires_token(client, monkeypatch):
    _set_token(monkeypatch, "good")
    r = client.get("/api/findings/aggregate?token=bad")
    assert r.status_code == 401


def test_aggregate_flat_list_with_field_label(tmp_db, client, monkeypatch):
    """flat item 리스트 + 각 item 에 field/field_label 부착."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="smb", asset="//host/share/secret.env", asset_kind="smb_path",
        severity="high", summary="smb secret", extra={"hits": [{"category": "secret"}]},
    )
    state.finding_upsert(
        task_type="github", asset="github:O/r/cfg.yaml", asset_kind="repository_file",
        severity="critical", summary="gh secret", extra={"hits": [{"category": "secret"}]},
    )
    body = client.get("/api/findings/aggregate?token=tok-123").json()
    assert body["metadata"]["kind"] == "all_findings"
    assert len(body["items"]) == 2
    by_field = {it["field"]: it for it in body["items"]}
    assert by_field["smb"]["field_label"] == "SMB"
    assert by_field["github"]["field_label"] == "GitHub"


def test_aggregate_smb_finding_includes_access_mode_tags(tmp_db, client, monkeypatch):
    # 도메인 DB 함수는 service.state_domain, finding_upsert 는 코어 state (v3.82 U3d).
    from secu_agent import state

    from service import state_domain

    _set_token(monkeypatch)
    state_domain.asset_owner_upsert(
        "10.0.0.5",
        user_id="owner.one",
        user_name="Owner One",
        user_dept="Infra",
    )
    sid = state_domain.scan_start("smb", ["10.0.0.0/24"])
    state_domain.upsert_smb_share(
        sid,
        "10.0.0.0/24",
        "10.0.0.5",
        "Public",
        null_login_ok=True,
        guest_login_ok=True,
        auth_login_ok=True,
        share_read=True,
        share_write=False,
        access_modes={
            "null": {"read": True, "write": False},
            "guest": {"read": True, "write": False},
            "auth": {"read": True, "write": False},
        },
    )
    state.finding_upsert(
        task_type="smb",
        asset="smb://10.0.0.5/Public/secrets.env",
        asset_kind="smb_path",
        severity="high",
        summary="smb secret",
        extra={"hits": [{"category": "secret"}]},
    )

    body = client.get("/api/findings/aggregate?token=tok-123").json()
    item = next(i for i in body["items"] if i["field"] == "smb")

    assert item["status"] == "open"
    assert item["smb_access"]["open_modes"] == ["null", "guest", "auth"]
    assert item["smb_access"]["modes"] == {
        "null": True,
        "guest": True,
        "auth": True,
    }
    assert item["asset_owner"]["user_id"] == "owner.one"
    assert item["asset_owner"]["email"] == "owner.one@samsung.com"


def test_aggregate_facets(tmp_db, client, monkeypatch):
    """facets = field/severity/classification/status/discovery_method/cross_confirmed counts."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="web", asset="https://a.internal/.env", asset_kind="url",
        severity="high", summary="x", extra={"hits": [{"category": "secret"}]},
    )
    state.finding_upsert(
        task_type="web", asset="https://b.internal/users", asset_kind="url",
        severity="medium", summary="y", extra={"hits": [{"category": "pii"}]},
    )
    body = client.get("/api/findings/aggregate?token=tok-123").json()
    facets = body["facets"]
    assert {"field", "severity", "classification", "status",
            "discovery_method", "cross_confirmed"} <= set(facets)
    field_keys = {f["key"]: f["count"] for f in facets["field"]}
    assert field_keys.get("web") == 2
    cls_keys = {c["key"] for c in facets["classification"]}
    assert {"secret", "pii"} <= cls_keys


def test_aggregate_no_cross_field_merge(tmp_db, client, monkeypatch):
    """교차-field 병합 금지 — 같은 host 라도 다른 분야면 별개 행."""
    from secu_agent import state

    _set_token(monkeypatch)
    # 동일 host 문자열이지만 한 쪽은 web, 한 쪽은 confluence asset.
    state.finding_upsert(
        task_type="web", asset="https://shared.internal/x", asset_kind="url",
        severity="high", summary="web", extra={"hits": [{"category": "secret"}]},
    )
    state.finding_upsert(
        task_type="confluence", asset="https://shared.internal/wiki", asset_kind="url",
        severity="high", summary="cf", extra={"hits": [{"category": "secret"}]},
    )
    body = client.get("/api/findings/aggregate?token=tok-123").json()
    fields = sorted(it["field"] for it in body["items"])
    # 두 분야로 분리 — 병합되지 않음
    assert fields == ["confluence", "web"]


def test_bare_findings_endpoint_not_served_here(tmp_db, client):
    """v3.82 U3d: generic finding CRUD(bare GET /api/findings)는 엔진 코어(8765)
    소유 — 도메인 서비스는 aggregate + owner-mail 4종만 서빙한다."""
    r = client.get("/api/findings")
    assert r.status_code == 404


def test_aggregate_excludes_false_positive(tmp_db, client, monkeypatch):
    """v3.78 F2: false_positive 는 통합 뷰/통계에서 제외(삭제 아님, status 만)."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="github", asset="github:O/r/.env", asset_kind="repository_file",
        severity="high", summary="real secret",
        extra={"hits": [{"category": "secret"}]},
    )
    drop, _ = state.finding_upsert(
        task_type="github", asset="github:O/r/AUTHORS", asset_kind="repository_file",
        severity="medium", summary="email noise",
        extra={"hits": [{"category": "pii", "kind": "email"}]},
    )
    state.finding_set_status(drop, "false_positive", reason="noise")

    body = client.get("/api/findings/aggregate?token=tok-123").json()
    assets = {it["asset"] for it in body["items"]}
    assert "github:O/r/.env" in assets
    assert "github:O/r/AUTHORS" not in assets       # fp 제외
    assert body["stats"]["total"] == 1


def test_aggregate_surfaces_verification(tmp_db, client, monkeypatch):
    """v3.78 G2: extra.verification(HEAD 재확인) 가 item 에 투영."""
    from secu_agent import state

    _set_token(monkeypatch)
    state.finding_upsert(
        task_type="github", asset="github:O/r/.env", asset_kind="repository_file",
        severity="high", summary="secret",
        extra={
            "hits": [{"category": "secret", "kind": "aws_access_key_id"}],
            "verification": {"method": "api_head_recheck", "status": "live_in_HEAD",
                             "ref": "HEAD", "files": [{"path": ".env", "status": "live_in_HEAD"}]},
        },
    )
    body = client.get("/api/findings/aggregate?token=tok-123").json()
    it = next(i for i in body["items"] if i["asset"] == "github:O/r/.env")
    assert it["verification"]["status"] == "live_in_HEAD"


def test_aggregate_can_include_clean_completed_targets(tmp_db, client, monkeypatch):
    """include_clean=true 이면 finding_count=0 완료 대상도 전체 보기용 row 로 내려준다."""
    from service import state_domain

    _set_token(monkeypatch)
    tid = state_domain.web_target_upsert(
        "clean.internal",
        source="splunk",
        day_bucket="2026-06-11",
        event_count=7,
    )
    state_domain.web_target_set_status(
        tid,
        "tasked",
        finding_count=0,
        last_reason="no exposure",
    )

    default_body = client.get("/api/findings/aggregate?token=tok-123").json()
    assert default_body["items"] == []

    body = client.get(
        "/api/findings/aggregate?token=tok-123&include_clean=true",
    ).json()
    assert body["stats"]["finding_total"] == 0
    assert body["stats"]["clean_total"] == 1
    assert body["metadata"]["include_clean"] is True
    item = body["items"][0]
    assert item["item_type"] == "clean_report"
    assert item["is_finding"] is False
    assert item["field"] == "web"
    assert item["target"] == "clean.internal"
    assert item["clean_report"]["metadata"]["event_count"] == 7


def test_aggregate_clean_targets_do_not_duplicate_existing_findings(tmp_db, client, monkeypatch):
    """같은 도메인에 finding 이 있으면 전체 보기에서도 clean baseline row 는 중복 생성하지 않는다."""
    from secu_agent import state

    from service import state_domain

    _set_token(monkeypatch)
    tid = state_domain.web_target_upsert(
        "dup.internal",
        source="splunk",
        day_bucket="2026-06-11",
        event_count=3,
    )
    state_domain.web_target_set_status(tid, "tasked", finding_count=0)
    state.finding_upsert(
        task_type="web",
        asset="https://dup.internal/.env",
        asset_kind="url",
        severity="high",
        summary="secret",
        extra={"hits": [{"category": "secret"}]},
    )

    body = client.get(
        "/api/findings/aggregate?token=tok-123&include_clean=true",
    ).json()
    assert len(body["items"]) == 1
    assert body["items"][0]["item_type"] != "clean_report"
    assert body["stats"]["finding_total"] == 1
    assert body["stats"]["clean_total"] == 0


def test_aggregate_clean_smb_shares_on_same_host_are_separate(tmp_db, client, monkeypatch):
    """SMB는 host가 아니라 공유 폴더 asset 단위로 전체 보기 row를 유지한다."""
    from service import state_domain

    _set_token(monkeypatch)
    state_domain.asset_owner_upsert(
        "10.0.0.5",
        user_id="clean.owner",
        user_name="Clean Owner",
        user_dept="Ops",
    )
    sid = state_domain.scan_start("smb", ["10.0.0.0/24"])
    _, users = state_domain.upsert_smb_share(
        sid, "10.0.0.0/24", "10.0.0.5", "Users",
        null_login_ok=True, guest_login_ok=False, auth_login_ok=True,
        share_read=True,
        access_modes={
            "null": {"read": True, "write": False},
            "guest": {"read": False, "write": False},
            "auth": {"read": True, "write": False},
        },
    )
    _, photos = state_domain.upsert_smb_share(
        sid, "10.0.0.0/24", "10.0.0.5", "교육일정사진", share_read=True,
    )
    state_domain.share_set_status(
        users, "triaged_completed", hits_count=0, processed_at=1000.0,
    )
    state_domain.share_set_status(
        photos, "triaged_completed", hits_count=0, processed_at=1001.0,
    )

    body = client.get(
        "/api/findings/aggregate?token=tok-123&include_clean=true",
    ).json()
    smb_items = [i for i in body["items"] if i["field"] == "smb"]
    assert {i["asset"] for i in smb_items} == {
        "smb://10.0.0.5/Users",
        "smb://10.0.0.5/교육일정사진",
    }
    by_asset = {i["asset"]: i for i in smb_items}
    assert by_asset["smb://10.0.0.5/Users"]["smb_access"]["open_modes"] == [
        "null", "auth",
    ]
    assert by_asset["smb://10.0.0.5/Users"]["asset_owner"]["email"] == (
        "clean.owner@samsung.com"
    )
    assert body["stats"]["clean_total"] == 2
