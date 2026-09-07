"""Finding lifecycle web API.

v3.82 U3b: 전 라우트 토큰 필수 (Authorization 헤더 우선, ?token= 폴백).
"""
from __future__ import annotations


_AUTH = {"Authorization": "Bearer devtoken"}


def _seed_finding(
    *,
    task_type="smb",
    asset="//host/share/secret.env",
    asset_kind="smb_path",
    severity="high",
    summary="secret exposure",
    owner=None,
    ticket_ref=None,
):
    from secu_agent import state

    fid, _created = state.finding_upsert(
        task_type=task_type,
        asset=asset,
        asset_kind=asset_kind,
        severity=severity,
        summary=summary,
        owner=owner,
        ticket_ref=ticket_ref,
        evidence_ref="finding.json",
    )
    return fid


def test_findings_list_empty(client):
    r = client.get("/api/findings", headers=_AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 0
    assert body["items"] == []
    assert body["status_counts"] == {}
    assert body["severity_counts"] == {}


def test_findings_list_filters_and_shapes_rows(client):
    _seed_finding(asset="//host/a", severity="medium", summary="a")
    fid = _seed_finding(
        task_type="web",
        asset="https://app.example/login",
        asset_kind="url",
        severity="critical",
        summary="admin exposed",
        owner="appsec",
        ticket_ref="SEC-7",
    )

    r = client.get("/api/findings?task_type=web&status=open&limit=10", headers=_AUTH)
    assert r.status_code == 200
    body = r.json()

    assert body["total"] == 1
    assert body["status_counts"] == {"open": 2}
    assert body["severity_counts"] == {"medium": 1, "critical": 1}
    item = body["items"][0]
    assert item["id"] == fid
    assert item["task_type"] == "web"
    assert item["asset"] == "https://app.example/login"
    assert item["severity"] == "critical"
    assert item["status"] == "open"
    assert item["owner"] == "appsec"
    assert item["ticket_ref"] == "SEC-7"
    assert item["seen_count"] == 1


def test_finding_detail_and_update(client):
    fid = _seed_finding(summary="initial")

    detail = client.get(f"/api/findings/{fid}", headers=_AUTH)
    assert detail.status_code == 200
    assert detail.json()["summary"] == "initial"

    r = client.patch(f"/api/findings/{fid}", headers=_AUTH, json={
        "status": "triaged",
        "owner": "enterprise-security",
        "ticket_ref": "SEC-10",
        "sla_due": 1900000000.0,
        "summary": "triaged summary",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "triaged"
    assert body["owner"] == "enterprise-security"
    assert body["ticket_ref"] == "SEC-10"
    assert body["sla_due"] == 1900000000.0
    assert body["summary"] == "triaged summary"

    again = client.get(f"/api/findings/{fid}", headers=_AUTH).json()
    assert again["status"] == "triaged"


def test_finding_update_rejects_invalid_status(client):
    fid = _seed_finding()
    r = client.patch(f"/api/findings/{fid}", headers=_AUTH, json={"status": "closed"})
    assert r.status_code == 400
    assert "invalid finding status" in r.json()["detail"]


def test_finding_detail_404(client):
    r = client.get("/api/findings/999999", headers=_AUTH)
    assert r.status_code == 404


def test_findings_requires_token(client):
    """v3.82 U3b: 무인증이던 GET/PATCH 수리 — 토큰 없으면 401, 쿼리 폴백 허용."""
    fid = _seed_finding()
    assert client.get("/api/findings").status_code == 401
    assert client.get(f"/api/findings/{fid}").status_code == 401
    assert client.patch(f"/api/findings/{fid}", json={"status": "triaged"}).status_code == 401
    assert client.get("/api/findings?token=devtoken").status_code == 200  # deprecated 폴백
    assert client.get("/api/findings", headers={"Authorization": "devtoken"}).status_code == 200
