"""S1: /api/smb/dashboard — status/severity/hit 집계."""
from __future__ import annotations


def test_dashboard_empty_returns_zeros(client):
    r = client.get("/api/smb/dashboard")
    assert r.status_code == 200
    body = r.json()
    assert body["status_counts"] == {}
    assert body["severity_counts"] == {}
    assert body["hits"] == {"pending": 0, "confirmed": 0, "false_positive": 0}
    assert body["cred_count"] == 0
    assert body["recent_scans"] == []


def test_dashboard_aggregates_by_status_severity_and_hits(client, seed):
    cred_id = seed.credential()
    s1 = seed.share(host="1.1.1.1", share="a", status="walked",
                    severity="high", cred_id=cred_id)
    s2 = seed.share(host="1.1.1.2", share="b", status="triaged_completed",
                    severity="critical", cred_id=cred_id)
    s3 = seed.share(host="1.1.1.3", share="c", status="walked",
                    severity="high", cred_id=cred_id)

    f1 = seed.file(s1, path="creds.env", hits=2)
    seed.hit(f1, verdict="confirmed")
    seed.hit(f1, verdict="false_positive")
    f2 = seed.file(s2, path="dump.txt", hits=1)
    seed.hit(f2, verdict="pending")

    r = client.get("/api/smb/dashboard")
    body = r.json()
    assert body["status_counts"] == {"walked": 2, "triaged_completed": 1}
    assert body["severity_counts"] == {"high": 2, "critical": 1}
    assert body["hits"] == {"pending": 1, "confirmed": 1, "false_positive": 1}
    assert body["cred_count"] == 1
    assert len(body["recent_scans"]) == 1
    scan = body["recent_scans"][0]
    assert scan["kind"] == "smb"
    assert "subnets" in scan
