"""/gw HTTP 계층 + authz E2E (FastAPI TestClient). 라이브 DSN 필요(lifespan이 풀 open)."""
import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("SECU_AGENT_PG_DSN"),
    reason="라이브 threat_hunter DSN 필요(lifespan pool open)",
)

TOKEN = "test-gw-token"


@pytest.fixture()
def client():
    os.environ["GATEWAY_TOKEN"] = TOKEN
    from fastapi.testclient import TestClient

    from digisecu_gateway.app import create_app

    with TestClient(create_app()) as c:  # lifespan 실행(풀 open/close)
        yield c


def _auth():
    return {"authorization": f"Bearer {TOKEN}"}


def test_healthz_no_auth(client):
    r = client.get("/gw/healthz")
    assert r.status_code == 200 and r.json()["service"] == "digisecu-gateway"


def test_readyz(client):
    r = client.get("/gw/readyz")
    assert r.status_code == 200 and r.json()["db"] == "threat_hunter"


def test_findings_requires_token(client):
    assert client.get("/gw/findings").status_code == 401
    assert client.get("/gw/findings", headers={"authorization": "Bearer wrong"}).status_code == 401


def test_findings_ok(client):
    r = client.get("/gw/findings?limit=2", headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert "total" in body and "items" in body and len(body["items"]) <= 2


def test_queue_depth_ok(client):
    r = client.get("/gw/queue/depth", headers=_auth())
    assert r.status_code == 200
    domains = {i["agentType"] for i in r.json()["items"]}
    assert {"smb", "dev_web", "github", "confluence"} <= domains


def test_workspace_payload_ok(client):
    r = client.get("/gw/workspaces/smb/payload", headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["key"] == "smb" and "findings" in body and "reports" in body and "kpi" in body


def test_workspace_unknown_domain_404(client):
    assert client.get("/gw/workspaces/bogus/payload", headers=_auth()).status_code == 404


def test_quality_candidates_requires_token(client):
    assert client.get("/gw/quality/candidates").status_code == 401


def test_quality_candidates_rejects_bad_window(client):
    assert client.get("/gw/quality/candidates?windowDays=0", headers=_auth()).status_code == 422
    assert client.get("/gw/quality/candidates?windowDays=31", headers=_auth()).status_code == 422


# ── 대상(src) 축 + 개요 집계 라우트 ────────────────────────────────────────────


def test_sources_requires_token(client):
    assert client.get("/gw/sources").status_code == 401


def test_sources_ok(client):
    r = client.get("/gw/sources?limit=3", headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 0 and len(body["items"]) <= 3
    assert body["ownerLookup"] in ("ok", "denied")
    for it in body["items"]:
        assert it["domain"] in ("smb", "dev_web", "github", "confluence")
        assert len(it["srcKey"]) == 16  # 불투명 키 — UI 는 이걸로 되묻는다
    # 담당자 메일이 실려 나가므로 상세와 같은 취급.
    assert r.headers.get("cache-control") == "no-store"


def test_sources_rejects_unknown_domain(client):
    assert client.get("/gw/sources?domain=nope", headers=_auth()).status_code == 404


def test_sources_rejects_unknown_thread_state(client):
    """미지 필터를 조용히 무시하고 전체를 내면 화면이 거짓말을 한다 — 422 로 거부."""
    assert client.get("/gw/sources?threadState=nope", headers=_auth()).status_code == 422


def test_findings_src_key_filter_roundtrip(client):
    """대시보드 링크 경로 — /gw/sources 의 건수와 srcKey 로 되물은 total 이 같아야 한다."""
    src = client.get("/gw/sources?limit=1", headers=_auth()).json()
    if not src["items"]:
        pytest.skip("대상 0건")
    it = src["items"][0]
    got = client.get(f"/gw/findings?srcKey={it['srcKey']}&limit=1", headers=_auth()).json()
    assert got["total"] == it["findings"]


def test_findings_rejects_malformed_src_key(client):
    """게이트웨이가 낸 형태만 되받는다(무의미 스캔·주입 방지)."""
    for bad in ("../etc", "ZZZZ", "0" * 15, "0" * 17, "' OR 1=1--"):
        r = client.get("/gw/findings", params={"srcKey": bad}, headers=_auth())
        assert r.status_code == 422, bad


def test_stats_ok(client):
    r = client.get("/gw/stats", headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert {d["domain"] for d in body["domains"]} == {"smb", "dev_web", "github", "confluence"}
    assert body["totals"]["findings"] == sum(d["findings"] for d in body["domains"])
    assert body["week"].count("-W") == 1
    # ⚠️ weekly.resolved 는 신뢰할 수 있는 정의가 없어 항상 0 — 조치는 domains[].remediated 로.
    assert all(w["resolved"] == 0 for w in body["weekly"])
    assert r.headers.get("cache-control") == "no-store"


def test_reports_expose_send_history(client):
    """발송 이력 필드가 계약대로 나오는지 — smb 는 recurrenceCount 보유, 나머지는 null."""
    smb = client.get("/gw/workspaces/smb/reports?limit=3", headers=_auth()).json()
    for it in smb:
        assert "cycleKeys" in it and isinstance(it["cycleKeys"], list)
        assert "attemptCount" in it and "firstReportedAt" in it
    gh = client.get("/gw/workspaces/github/reports?limit=3", headers=_auth()).json()
    for it in gh:
        # github_report_thread 에는 컬럼 자체가 없다 — 0 이 아니라 null 이어야 한다.
        assert it["recurrenceCount"] is None
        assert it["lastErrorKind"] is None
