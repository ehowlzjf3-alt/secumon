"""SMB host report API."""
from __future__ import annotations

# 도메인 DB 함수는 service.state_domain, finding_upsert 는 코어 state (v3.82 U3d).
from service import state_domain


def _seed_report_host(seed) -> int:
    sid = seed.share(
        host="10.0.0.5",
        share="Public",
        guest=True,
        auth=False,
        read=True,
        write=False,
        status="walked",
        access_modes={
            "null": {"read": False, "write": False},
            "guest": {"read": True, "write": False},
            "auth": {"read": False, "write": False},
        },
    )
    state_domain.upsert_smb_directory(sid, "docs", depth=1, listable=True, readable=True)
    state_domain.upsert_smb_directory(sid, "secrets", depth=1, listable=True, readable=True)
    seed.file(sid, path="docs/readme.txt", suspicious=False, hits=0)
    hit_file = seed.file(sid, path="secrets/app.env", suspicious=True, hits=1)
    seed.hit(
        hit_file,
        category="secret",
        kind="aws_access_key_id",
        masked="AKIA****",
        line_no=3,
        line_preview="AWS_ACCESS_KEY_ID=AKIA****",
        verdict="confirmed",
        validation={
            "kind": "credential_reachability",
            "policy": "GET only; POST/PUT/PATCH/DELETE not sent",
            "attempted": True,
            "post_possible": False,
            "post_status": "not_sent_policy",
            "targets": [{
                "method": "GET",
                "url": "https://api.example.com/",
                "result": "reachable",
                "status_code": 200,
            }],
        },
    )
    state_domain.file_set_review(
        hit_file,
        severity="high",
        summary="AI 파일 검토: AWS 키가 포함된 설정 파일로 확인",
    )
    state_domain.share_set_listing_review(sid, {
        "severity": "high",
        "summary": "AI 작성 요약: Engineering 공유 폴더에 공정 레시피 문서가 노출됨",
        "follow_up_actions": [
            "AI 작성 조치: Engineering 공유 폴더 권한을 공정 담당 그룹으로 제한",
            "AI 작성 조치: 노출 문서 소유자를 확인하고 반출 이력을 점검",
        ],
        "top_findings": [{"file_id": hit_file, "reason": "AI가 설정 파일 내 AWS 키를 확정"}],
        "confidence": 0.9,
        "reviewer": "smb_share_master",
    })
    return sid


def test_smb_host_report_default_hides_clean_rows_but_counts_all(client, seed):
    _seed_report_host(seed)
    state_domain.asset_owner_upsert(
        "10.0.0.5",
        user_id="owner.one",
        user_name="Owner One",
        user_dept="Infra Ops",
        source="splunk:test",
    )

    r = client.get("/api/smb/reports/10.0.0.5")
    assert r.status_code == 200
    body = r.json()

    assert body["filters"]["findings_only"] is True
    assert body["summary"]["share_total"] == 1
    assert body["summary"]["share_shown"] == 1
    assert body["summary"]["share_finding_total"] == 1
    assert body["summary"]["directory_total"] == 2
    assert body["summary"]["directory_shown"] == 1
    assert body["summary"]["directory_finding_total"] == 1
    assert body["summary"]["file_total"] == 2
    assert body["summary"]["file_shown"] == 1
    assert body["summary"]["file_finding_total"] == 1
    assert body["summary"]["hidden_clean_directories"] == 1
    assert body["summary"]["hidden_clean_files"] == 1
    assert body["summary"]["hit_total"] == 1
    assert body["summary"]["confirmed_hit_total"] == 1
    assert body["summary"]["null_exposure_total"] == 0
    assert body["summary"]["guest_exposure_total"] == 1
    assert body["summary"]["public_exposure_total"] == 1
    assert body["summary"]["writable_share_total"] == 0
    assert body["summary"]["writable_file_total"] == 0
    assert body["asset_owner"]["known"] is True
    assert body["asset_owner"]["user_id"] == "owner.one"
    assert body["asset_owner"]["user_name"] == "Owner One"
    assert body["asset_owner"]["user_dept"] == "Infra Ops"
    assert body["asset_owner"]["email"] == "owner.one@samsung.com"

    share = body["shares"][0]
    assert share["share"] == "Public"
    assert share["listing_review"]["summary"].startswith("AI 작성 요약")
    assert share["listing_review"]["follow_up_actions"][0].startswith("AI 작성 조치")
    assert share["access"]["principals"]["read"] == ["GUEST"]
    assert share["access"]["principals"]["write"] == []
    assert [d["path"] for d in share["directories"]] == ["secrets"]
    assert [f["path"] for f in share["files"]] == ["secrets/app.env"]
    assert share["files"][0]["evidence_verdict"] == "true_positive"
    assert share["files"][0]["evidence_label"] == "진성"
    assert share["files"][0]["evidence_counts"]["true_positive"] == 1
    assert share["files"][0]["hits"][0]["category"] == "secret"
    assert share["files"][0]["hits"][0]["evidence_verdict"] == "true_positive"
    assert share["files"][0]["hits"][0]["validation"]["targets"][0]["method"] == "GET"


def test_smb_host_report_full_view_returns_clean_rows(client, seed):
    _seed_report_host(seed)

    r = client.get("/api/smb/reports/10.0.0.5?findings_only=false")
    assert r.status_code == 200
    body = r.json()

    assert body["filters"]["findings_only"] is False
    assert body["summary"]["share_finding_total"] == 1
    assert body["summary"]["directory_finding_total"] == 1
    assert body["summary"]["file_finding_total"] == 1
    share = body["shares"][0]
    assert {d["path"] for d in share["directories"]} == {"docs", "secrets"}
    assert {f["path"] for f in share["files"]} == {
        "docs/readme.txt",
        "secrets/app.env",
    }
    assert body["summary"]["hidden_clean_directories"] == 0
    assert body["summary"]["hidden_clean_files"] == 0


def test_smb_host_report_default_uses_ai_confirmed_findings_only(client, seed):
    sid = seed.share(host="10.0.0.6", share="Raw", status="walked")
    fid = seed.file(sid, path="raw/secret.env", suspicious=True, hits=1)
    seed.hit(
        fid,
        category="secret",
        kind="aws_access_key_id",
        masked="AKIA****",
        line_no=3,
        line_preview="AWS_ACCESS_KEY_ID=AKIA****",
        verdict="confirmed",
    )

    r = client.get("/api/smb/reports/10.0.0.6")
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["share_total"] == 1
    assert body["summary"]["share_finding_total"] == 0
    assert body["summary"]["file_finding_total"] == 0
    assert body["shares"] == []

    full = client.get("/api/smb/reports/10.0.0.6?findings_only=false").json()
    share = full["shares"][0]
    assert share["files"][0]["has_candidate"] is True
    assert share["files"][0]["has_finding"] is False
    assert share["files"][0]["review"]["status"] is None
    assert share["files"][0]["evidence_verdict"] == "unverified"
    assert share["files"][0]["hits"][0]["evidence_verdict"] == "unverified"


def test_smb_host_report_ignores_false_positive_hits_for_default_issues(client, seed):
    sid = seed.share(
        host="10.0.0.16",
        share="print$",
        null=False,
        guest=False,
        auth=False,
        read=True,
        write=False,
        status="triaged_completed",
    )
    fid = seed.file(
        sid,
        path="x64/BuAiniNT.ini",
        suspicious=True,
        hits=1,
        fetch_status="text",
        scanned=True,
    )
    seed.hit(
        fid,
        category="credential",
        kind="printer_fax_config_password_fields",
        masked="SMTP Password=<masked,len=12>",
        line_no=2254,
        line_preview="SMTP Password(value_present=True,len=12)",
        verdict="false_positive",
        confidence=1.0,
        note="empty printer driver option",
    )

    r = client.get("/api/smb/reports/10.0.0.16")
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["share_shown"] == 0
    assert body["summary"]["hit_total"] == 0
    assert body["shares"] == []

    full = client.get("/api/smb/reports/10.0.0.16?findings_only=false").json()
    file_row = full["shares"][0]["files"][0]
    assert file_row["hits_count"] == 0
    assert file_row["raw_hits_count"] == 1
    assert file_row["has_candidate"] is False
    assert file_row["evidence_verdict"] == "false_positive"
    assert file_row["evidence_label"] == "가성"
    assert file_row["evidence_counts"]["false_positive"] == 1
    assert file_row["hits"][0]["agent_verdict"] == "false_positive"
    assert file_row["hits"][0]["evidence_verdict"] == "false_positive"


def test_smb_host_report_filters_false_positive_hits_inside_true_file(client, seed):
    sid = seed.share(
        host="10.0.0.19",
        share="Dept",
        guest=True,
        auth=True,
        read=True,
        write=False,
        status="triaged_completed",
    )
    fid = seed.file(
        sid,
        path="finance/export.env",
        suspicious=True,
        hits=2,
        fetch_status="text",
        scanned=True,
    )
    seed.hit(
        fid,
        category="secret",
        kind="aws_access_key_id",
        masked="AKIA****",
        line_no=4,
        line_preview="AWS_ACCESS_KEY_ID=AKIA****",
        verdict="confirmed",
    )
    seed.hit(
        fid,
        category="credential",
        kind="printer_fax_config_password_fields",
        masked="SMTP Password=<masked,len=0>",
        line_no=22,
        line_preview="SMTP Password(value_present=False,len=0)",
        verdict="false_positive",
        note="empty config field",
    )
    state_domain.file_set_review(
        fid,
        severity="high",
        summary="AI 파일 검토: 운영 키가 포함된 설정 파일로 확정",
    )

    r = client.get("/api/smb/reports/10.0.0.19")
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["share_shown"] == 1
    assert body["summary"]["file_shown"] == 1
    assert body["summary"]["true_positive_evidence_total"] == 1
    assert body["summary"]["false_positive_evidence_total"] == 1
    file_row = body["shares"][0]["files"][0]
    assert file_row["evidence_verdict"] == "true_positive"
    assert file_row["evidence_counts"] == {
        "true_positive": 1,
        "false_positive": 1,
        "unverified": 0,
    }
    assert [h["kind"] for h in file_row["hits"]] == ["aws_access_key_id"]
    assert file_row["hits"][0]["evidence_verdict"] == "true_positive"

    full = client.get("/api/smb/reports/10.0.0.19?findings_only=false").json()
    full_file = full["shares"][0]["files"][0]
    assert {h["evidence_verdict"] for h in full_file["hits"]} == {
        "true_positive",
        "false_positive",
    }


def test_smb_host_report_marks_auth_read_as_accessible(client, seed):
    seed.share(
        host="10.0.0.7",
        share="Dept",
        null=False,
        guest=False,
        auth=True,
        read=True,
        write=False,
        status="walked",
        access_modes={
            "null": {"read": False, "write": False},
            "guest": {"read": False, "write": False},
            "auth": {"read": True, "write": False},
        },
    )

    r = client.get("/api/smb/reports/10.0.0.7?findings_only=false")
    assert r.status_code == 200
    body = r.json()
    share = body["shares"][0]

    assert body["summary"]["public_exposure_total"] == 0
    assert body["summary"]["null_exposure_total"] == 0
    assert body["summary"]["guest_exposure_total"] == 0
    assert body["summary"]["auth_broad_exposure_total"] == 1
    assert "auth_broad_readable" in body["summary"]["risk_flags"]
    assert "auth_broad_readable" in share["risk_flags"]
    assert share["access"]["scope"]["auth_readable"] is True
    assert share["access"]["scope"]["auth_broad_readable"] is True
    assert "personal_owner" not in share["access"]["scope"]
    assert "personal_owner_explicit" not in share["access"]["scope"]
    assert "DS보안관제 검증 계정" in share["access"]["scope"]["interpretation"]


def test_smb_host_report_marks_auth_read_accessible_even_with_acl_principals(client, seed):
    seed.share(
        host="10.0.0.8",
        share="Home",
        null=False,
        guest=False,
        auth=True,
        read=True,
        write=False,
        status="walked",
        access_modes={
            "null": {"read": False, "write": False},
            "guest": {"read": False, "write": False},
            "auth": {
                "read": True,
                "write": False,
                "acl_principals": ["dssoc"],
            },
        },
    )

    r = client.get("/api/smb/reports/10.0.0.8?findings_only=false")
    assert r.status_code == 200
    body = r.json()
    share = body["shares"][0]

    assert body["summary"]["auth_broad_exposure_total"] == 1
    assert "auth_broad_readable" in body["summary"]["risk_flags"]
    assert "auth_broad_readable" in share["risk_flags"]
    assert share["access"]["scope"]["auth_readable"] is True
    assert share["access"]["scope"]["auth_broad_readable"] is True
    assert "personal_owner_explicit" not in share["access"]["scope"]


def test_smb_report_by_asset_parses_focus(client, seed):
    _seed_report_host(seed)

    r = client.get(
        "/api/smb/report-by-asset",
        params={"asset": "smb://10.0.0.5/Public/secrets/app.env"},
    )
    assert r.status_code == 200
    body = r.json()

    assert body["host"] == "10.0.0.5"
    assert body["focus"] == {"share": "Public", "path": "secrets/app.env"}
    assert [s["share"] for s in body["shares"]] == ["Public"]


def test_smb_report_by_asset_keeps_lifecycle_finding_without_file_review(client, seed):
    from secu_agent import state

    sid = seed.share(
        host="10.0.0.9",
        share="Images",
        guest=True,
        auth=True,
        read=True,
        write=False,
        status="triaged_completed",
        severity="medium",
        summary="GUEST/AUTH 읽기 가능한 이미지 공유에서 PII finding 제출",
        access_modes={
            "null": {"read": False, "write": False},
            "guest": {"read": True, "write": False},
            "auth": {"read": True, "write": False},
        },
    )
    seed.file(
        sid,
        path="20260602/car.jpg",
        suspicious=False,
        hits=0,
        fetch_status="image_analyzed",
        scanned=False,
    )
    state.finding_upsert(
        task_type="smb",
        asset="smb://10.0.0.9/Images",
        asset_kind="smb_share",
        severity="medium",
        summary="차량번호 이미지가 포함된 SMB 공유 폴더 노출",
        extra={
            "hits": [{
                "category": "misconfig",
                "kind": "administrative_share_auth_readable",
                "location": "smb://10.0.0.9/Images",
                "preview": "AUTH read=true/write=false",
            }]
        },
    )

    r = client.get(
        "/api/smb/report-by-asset",
        params={"asset": "smb://10.0.0.9/Images", "findings_only": "true"},
    )
    assert r.status_code == 200
    body = r.json()

    assert body["summary"]["share_total"] == 1
    assert body["summary"]["share_shown"] == 1
    assert body["summary"]["share_finding_total"] == 1
    assert body["summary"]["file_finding_total"] == 0
    assert body["summary"]["file_shown"] == 0
    share = body["shares"][0]
    assert share["has_finding"] is True
    assert "submitted_finding" in share["risk_flags"]
    assert "misconfig_hit" in share["risk_flags"]
    assert "administrative_share" in share["risk_flags"]
    assert "auth_readable" in share["risk_flags"]
    assert share["lifecycle_findings"][0]["summary"] == "차량번호 이미지가 포함된 SMB 공유 폴더 노출"
    assert share["lifecycle_findings"][0]["hits"][0]["kind"] == "administrative_share_auth_readable"
    assert share["files"] == []


def test_smb_report_by_asset_accepts_file_prefixed_smb_locations(client, seed):
    from secu_agent import state

    sid = seed.share(
        host="10.125.33.71",
        share="print$",
        guest=False,
        auth=True,
        read=True,
        write=False,
        status="triaged_completed",
        severity="high",
        summary="print$ credential finding 제출",
        access_modes={
            "null": {"read": False, "write": False},
            "guest": {"read": False, "write": False},
            "auth": {"read": True, "write": False},
        },
    )
    seed.file(
        sid,
        path="x64/BuAiniNT.ini",
        suspicious=True,
        hits=0,
        fetch_status="text",
        scanned=True,
    )
    state.finding_upsert(
        task_type="smb",
        asset="file:smb://10.125.33.71/print$/x64/BuAiniNT.ini:2113,2254,2299",
        asset_kind="file:smb",
        severity="high",
        summary="프린터 드라이버 설정 파일에 비밀번호 필드가 있음",
        extra={
            "hits": [{
                "category": "credential",
                "kind": "printer_fax_config_password_fields",
                "location": "file:smb://10.125.33.71/print$/x64/BuAiniNT.ini:2113,2254,2299",
                "masked": "SMTP Password=<masked>",
                "preview": "비밀번호 필드가 비어 있지 않음",
            }]
        },
    )

    r = client.get(
        "/api/smb/report-by-asset",
        params={
            "asset": "file:smb://10.125.33.71/print$/x64/BuAiniNT.ini:2113,2254,2299",
            "findings_only": "true",
        },
    )
    assert r.status_code == 200
    body = r.json()

    assert body["host"] == "10.125.33.71"
    assert body["focus"] == {"share": "print$", "path": "x64/BuAiniNT.ini"}
    share = body["shares"][0]
    assert share["share"] == "print$"
    assert share["lifecycle_findings"][0]["asset"].startswith("file:smb://")
    assert share["files"][0]["path"] == "x64/BuAiniNT.ini"
    assert share["files"][0]["lifecycle_findings"][0]["report_path"] == "x64/BuAiniNT.ini"
    assert {"submitted_finding", "credential_hit"} <= set(share["files"][0]["risk_flags"])


def test_smb_host_report_matches_unc_lifecycle_share(client, seed):
    from secu_agent import state

    seed.share(
        host="10.0.0.17",
        share="C$",
        guest=False,
        auth=True,
        read=True,
        write=False,
        status="triaged_completed",
        severity="high",
        access_modes={
            "null": {"read": False, "write": False},
            "guest": {"read": False, "write": False},
            "auth": {"read": True, "write": False},
        },
    )
    state.finding_upsert(
        task_type="smb",
        asset=r"\\10.0.0.17\C$",
        asset_kind="location",
        severity="high",
        summary="Windows 관리 공유 C$가 인증 계정으로 열람 가능",
        extra={
            "hits": [{
                "category": "misconfig",
                "kind": "administrative_share_readable",
                "location": r"\\10.0.0.17\C$",
                "preview": "AUTH read=true/write=false",
            }]
        },
    )

    r = client.get("/api/smb/reports/10.0.0.17?findings_only=true")
    assert r.status_code == 200
    body = r.json()

    assert body["summary"]["share_shown"] == 1
    assert body["summary"]["share_finding_total"] == 1
    share = body["shares"][0]
    assert share["share"] == "C$"
    assert share["has_finding"] is True
    assert share["lifecycle_findings"][0]["asset"] == r"\\10.0.0.17\C$"
    assert "submitted_finding" in share["risk_flags"]
    assert "misconfig_hit" in share["risk_flags"]
    assert "administrative_share" in share["risk_flags"]


def test_smb_host_report_cycle_key_filters_share_rows(client, seed, monkeypatch):
    monkeypatch.setattr(state_domain, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    seed.share(
        host="10.0.0.30",
        share="OldOnly",
        guest=True,
        auth=True,
        read=True,
        status="triaged_completed",
    )

    monkeypatch.setattr(state_domain, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    seed.share(
        host="10.0.0.30",
        share="CurrentOnly",
        guest=True,
        auth=True,
        read=True,
        status="triaged_completed",
    )

    current = client.get(
        "/api/smb/reports/10.0.0.30",
        params={"cycle_key": "2026-W28", "findings_only": "false"},
    )
    assert current.status_code == 200
    body = current.json()

    assert body["filters"]["cycle_key"] == "2026-W28"
    assert [share["share"] for share in body["shares"]] == ["CurrentOnly"]


def test_smb_host_report_thread_scope_filters_lifecycle_findings(
    client,
    seed,
    monkeypatch,
):
    from secu_agent import state

    host = "10.0.0.31"
    monkeypatch.setattr(state_domain, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    seed.share(
        host=host,
        share="Data",
        guest=True,
        auth=True,
        read=True,
        status="triaged_completed",
    )
    old_finding_id, _ = state.finding_upsert(
        task_type="smb",
        asset=f"smb://{host}/Data/old.env",
        asset_kind="location",
        severity="high",
        summary="old-cycle credential exposure",
        extra={
            "hits": [{
                "category": "credential",
                "kind": "password",
                "location": f"smb://{host}/Data/old.env",
                "masked": "OLD****",
            }]
        },
    )
    _, old_thread_id = state_domain.mail_thread_upsert(
        finding_id=old_finding_id,
        host=host,
        subject_tag=f"[보안취약점 조치요청]({host})",
        status="reported",
        cycle_key="2026-W27",
    )
    state_domain.mail_thread_set_status(old_thread_id, "closed")

    monkeypatch.setattr(state_domain, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    seed.share(
        host=host,
        share="Data",
        guest=True,
        auth=True,
        read=True,
        status="triaged_completed",
    )
    current_finding_id, _ = state.finding_upsert(
        task_type="smb",
        asset=f"smb://{host}/Data/current.env",
        asset_kind="location",
        severity="critical",
        summary="current-cycle credential exposure",
        extra={
            "hits": [{
                "category": "credential",
                "kind": "password",
                "location": f"smb://{host}/Data/current.env",
                "masked": "CURRENT****",
            }]
        },
    )
    _, current_thread_id = state_domain.mail_thread_upsert(
        finding_id=current_finding_id,
        host=host,
        subject_tag=f"[보안취약점 조치요청]({host})",
        status="reported",
        cycle_key="2026-W28",
    )

    scoped = client.get(
        f"/api/smb/reports/{host}",
        params={
            "thread_id": current_thread_id,
            "findings_only": "true",
        },
    )
    assert scoped.status_code == 200
    body = scoped.json()

    assert body["filters"]["cycle_key"] == "2026-W28"
    assert body["filters"]["finding_ids"] == [current_finding_id]
    files = body["shares"][0]["files"]
    assert [file["path"] for file in files] == ["current.env"]
    assert files[0]["lifecycle_findings"][0]["id"] == current_finding_id

    mismatch = client.get(
        f"/api/smb/reports/{host}",
        params={"thread_id": current_thread_id, "cycle_key": "2026-W27"},
    )
    assert mismatch.status_code == 404


def test_remediation_report_html_renders_markdown_and_exposure_summary(client, seed):
    from secu_agent import state
    from service.services import smb_remediation_report

    seed.share(
        host="10.0.0.18",
        share="C$",
        guest=False,
        auth=True,
        read=True,
        write=False,
        status="triaged_completed",
        severity="high",
        access_modes={
            "null": {"read": False, "write": False},
            "guest": {"read": False, "write": False},
            "auth": {"read": True, "write": False},
        },
    )
    finding_id, _ = state.finding_upsert(
        task_type="smb",
        asset=r"\\10.0.0.18\C$",
        asset_kind="location",
        severity="high",
        summary="관리 공유 `C$`에서 **내부 시스템 구성정보** 노출",
        extra={
            "risk_narrative": {
                "exploitation_path": "`C$` 열람으로 **측면이동 단서** 확보 가능",
            },
            "recommended_actions": [
                "`C$` 권한에서 **전사 그룹** 읽기 권한 제거",
            ],
        },
    )
    from service import state_domain

    state_domain.asset_owner_upsert(
        "10.0.0.18",
        user_id="owner.one",
        user_name="Owner One",
        user_dept="Infra Ops",
        source="test",
    )

    report = smb_remediation_report.build_remediation_report(finding_id=finding_id)
    html = report["html"]

    assert report["subject_tag"] == "[보안취약점 조치요청](10.0.0.18)"
    # ★ src(IP)는 **제목 맨 뒤**다(사용자 요청 2026-09-01, `_shared/mail_subject.compose_subject`).
    #   이 단언이 옛 순서를 고정하고 있어 회귀처럼 보였다 — 실제로는 의도된 변경이다.
    assert report["subject"] == "[보안취약점 조치요청] 공유폴더 접근권한 관리 (10.0.0.18)"
    assert "**" not in html
    assert "`C$`" not in html
    assert "내부 시스템 구성정보" not in html
    assert "측면이동 단서" not in html
    assert "관리 공유" not in html
    assert "<code" in html
    assert "부서/전사 열람 공유 1건" in html
    assert "<!DOCTYPE html>" in html
    assert 'class="container"' in html
    assert "Owner One / Infra Ops" in html
    assert "owner.one@samsung.com" not in html
    assert "공유 폴더 접근 권한 제한" in html
    assert "</span>내용</div>" in html
    assert "문서, 설정 파일, 로그, 임시 파일, 휴지통에 남아 있는 파일" in html
    assert "확인 안내" in html
    assert "권한 설정 확인 방법" in html
    assert "확인된 공유 폴더" in html
    assert r"\\10.0.0.18\C$" in html
    assert "AUTH 읽기" in html
    assert "Windows 공유 폴더인 경우" in html
    assert "Linux/Samba 공유 폴더인 경우" in html
    assert "문의해 주시기 바랍니다" in html
    assert "업무상 필요한" not in html
    assert "업무와 무관한" not in html
    assert "불필요한" not in html
    assert "넓게 설정" not in html
    assert "확인해라" not in html


def test_smb_report_by_asset_marks_lifecycle_file_as_finding(client, seed):
    from secu_agent import state

    sid = seed.share(
        host="10.0.0.10",
        share="Images",
        guest=True,
        auth=True,
        read=True,
        write=False,
        status="triaged_completed",
        severity="medium",
        summary="GUEST/AUTH 읽기 가능한 이미지 공유에서 PII finding 제출",
        access_modes={
            "null": {"read": False, "write": False},
            "guest": {"read": True, "write": False},
            "auth": {"read": True, "write": False},
        },
    )
    state_domain.upsert_smb_directory(sid, "20260602", depth=1, listable=True, readable=True)
    seed.file(
        sid,
        path="20260602/CH42_20260602052656_경기72아6214.jpg",
        size=224256,
        suspicious=False,
        hits=0,
        fetch_status="image_analyzed",
        scanned=False,
    )
    state.finding_upsert(
        task_type="smb",
        asset="smb://10.0.0.10/Images/20260602/CH42_20260602052656_경기72아6214.jpg",
        asset_kind="file",
        severity="medium",
        summary="차량번호가 보이는 JPG 이미지 노출",
    )

    r = client.get(
        "/api/smb/report-by-asset",
        params={
            "asset": "smb://10.0.0.10/Images/20260602/CH42_20260602052656_경기72아6214.jpg",
            "findings_only": "true",
        },
    )
    assert r.status_code == 200
    body = r.json()

    assert body["summary"]["share_shown"] == 1
    assert body["summary"]["directory_shown"] == 1
    assert body["summary"]["file_shown"] == 1
    assert body["summary"]["file_finding_total"] == 1
    share = body["shares"][0]
    assert [d["path"] for d in share["directories"]] == ["20260602"]
    assert len(share["files"]) == 1
    file_row = share["files"][0]
    assert file_row["path"] == "20260602/CH42_20260602052656_경기72아6214.jpg"
    assert file_row["size"] == 224256
    assert file_row["has_finding"] is True
    assert "submitted_finding" in file_row["risk_flags"]
    assert file_row["lifecycle_findings"][0]["summary"] == "차량번호가 보이는 JPG 이미지 노출"


def test_smb_report_by_asset_synthesizes_lifecycle_file_when_row_missing(client, seed):
    from secu_agent import state

    seed.share(
        host="10.0.0.11",
        share="Images",
        guest=True,
        auth=True,
        read=True,
        write=False,
        status="triaged_completed",
        severity="medium",
        summary="GUEST/AUTH 읽기 가능한 이미지 공유에서 PII finding 제출",
    )
    state.finding_upsert(
        task_type="smb",
        asset="smb://10.0.0.11/Images/20260602/CH42_20260602052656_경기72아6214.jpg",
        asset_kind="file",
        severity="medium",
        summary="차량번호가 보이는 JPG 이미지 노출",
    )

    r = client.get(
        "/api/smb/report-by-asset",
        params={
            "asset": "smb://10.0.0.11/Images/20260602/CH42_20260602052656_경기72아6214.jpg",
            "findings_only": "true",
        },
    )
    assert r.status_code == 200
    body = r.json()

    assert body["summary"]["file_shown"] == 1
    file_row = body["shares"][0]["files"][0]
    assert file_row["path"] == "20260602/CH42_20260602052656_경기72아6214.jpg"
    assert file_row["size"] is None
    assert file_row["synthetic"] is True
    assert file_row["has_finding"] is True
    assert file_row["lifecycle_findings"][0]["summary"] == "차량번호가 보이는 JPG 이미지 노출"


def test_smb_report_by_asset_expands_lifecycle_hit_locations(client, seed):
    from secu_agent import state

    sid = seed.share(
        host="10.0.0.12",
        share="Images",
        guest=True,
        auth=True,
        read=True,
        write=False,
        status="triaged_completed",
        severity="medium",
        summary="GUEST/AUTH 읽기 가능한 이미지 공유에서 PII finding 제출",
    )
    state_domain.upsert_smb_directory(sid, "20260602", depth=1, listable=True, readable=True)
    for path in [
        "20260602/CH42_20260602052656_경기72아6214.jpg",
        "20260602/CH42_20260602060718_경기11가2222.jpg",
    ]:
        seed.file(
            sid,
            path=path,
            size=224256,
            suspicious=False,
            hits=0,
            fetch_status="image_analyzed",
            scanned=False,
        )
    state.finding_upsert(
        task_type="smb",
        asset="smb://10.0.0.12/Images",
        asset_kind="smb_share",
        severity="medium",
        summary="차량번호 이미지 묶음 노출",
        extra={
            "hits": [
                {
                    "category": "pii",
                    "kind": "vehicle_plate_images",
                    "location": "smb://10.0.0.12/Images/20260602/CH42_20260602052656_경기72아6214.jpg",
                    "masked": "차량등록번호: 경기**아****",
                },
                {
                    "category": "pii",
                    "kind": "vehicle_plate_images",
                    "location": "smb://10.0.0.12/Images/20260602/CH42_20260602060718_경기11가2222.jpg",
                    "masked": "차량등록번호: 경기**가****",
                },
            ]
        },
    )

    r = client.get(
        "/api/smb/report-by-asset",
        params={"asset": "smb://10.0.0.12/Images", "findings_only": "true"},
    )
    assert r.status_code == 200
    body = r.json()

    assert body["summary"]["file_shown"] == 2
    assert body["summary"]["file_finding_total"] == 2
    files = body["shares"][0]["files"]
    assert {f["path"] for f in files} == {
        "20260602/CH42_20260602052656_경기72아6214.jpg",
        "20260602/CH42_20260602060718_경기11가2222.jpg",
    }
    for file_row in files:
        assert file_row["has_finding"] is True
        assert "pii_hit" in file_row["risk_flags"]
        assert "vehicle_plate" in file_row["risk_flags"]
        assert len(file_row["lifecycle_findings"]) == 1
        assert len(file_row["lifecycle_findings"][0]["lifecycle_hits"]) == 1
    summaries = {
        f["path"]: f["lifecycle_findings"][0]["summary"]
        for f in files
    }
    assert summaries["20260602/CH42_20260602052656_경기72아6214.jpg"] == "차량등록번호: 경기**아****"
    assert summaries["20260602/CH42_20260602060718_경기11가2222.jpg"] == "차량등록번호: 경기**가****"
    assert len(set(summaries.values())) == 2
    assert "차량번호 이미지 묶음 노출" not in summaries.values()


def test_smb_host_report_404_for_unknown_host(client):
    r = client.get("/api/smb/reports/10.0.0.99")
    assert r.status_code == 404
