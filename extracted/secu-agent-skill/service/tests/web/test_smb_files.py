"""S3: /api/smb/shares/{id}/files + /api/smb/files/{id}."""
from __future__ import annotations


def test_list_files_for_share_empty(client, seed):
    sid = seed.share(host="1.1.1.1", share="a")
    r = client.get(f"/api/smb/shares/{sid}/files")
    assert r.status_code == 200
    assert r.json() == {"total": 0, "items": []}


def test_list_files_returns_shape_with_counts(client, seed):
    sid = seed.share(host="1.1.1.1", share="a")
    f = seed.file(sid, path="a/.env", size=256,
                  fetch_status="text", read=True, write=False, hits=2)
    seed.hit(f, verdict="confirmed")
    seed.hit(f, verdict="pending")

    r = client.get(f"/api/smb/shares/{sid}/files")
    body = r.json()
    assert body["total"] == 1
    item = body["items"][0]
    assert item["path"] == "a/.env"
    assert item["size"] == 256
    assert item["fetch_status"] == "text"
    assert item["file_read"] is True
    assert item["file_write"] is False
    assert item["hits_count"] == 2
    assert item["suspicious_name"] is True


def test_list_files_filter_suspicious_only(client, seed):
    sid = seed.share()
    seed.file(sid, path="boring.txt", suspicious=False)
    seed.file(sid, path="creds.env", suspicious=True)

    r = client.get(f"/api/smb/shares/{sid}/files?suspicious_only=true")
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["path"] == "creds.env"


def test_list_files_filter_hits_only(client, seed):
    sid = seed.share()
    seed.file(sid, path="a", hits=0)
    f2 = seed.file(sid, path="b", hits=1)
    seed.hit(f2)

    r = client.get(f"/api/smb/shares/{sid}/files?hits_only=true")
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["path"] == "b"


def test_file_detail_returns_hits(client, seed):
    sid = seed.share()
    fid = seed.file(sid, path="a.env", hits=2)
    seed.hit(fid, kind="aws_access_key_id", verdict="confirmed",
             confidence=0.95, note="real key")
    seed.hit(fid, kind="kr_rrn", verdict="false_positive")

    r = client.get(f"/api/smb/files/{fid}")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == fid
    assert body["path"] == "a.env"
    assert len(body["hits"]) == 2
    verdicts = {h["agent_verdict"] for h in body["hits"]}
    assert verdicts == {"confirmed", "false_positive"}
    # 평문/raw 전체 본문을 노출하지 않음 — line_preview만.
    assert all("line_preview" in h and "masked" in h for h in body["hits"])


def test_file_detail_404(client):
    r = client.get("/api/smb/files/99999")
    assert r.status_code == 404


def test_list_files_share_404(client):
    r = client.get("/api/smb/shares/99999/files")
    assert r.status_code == 404
