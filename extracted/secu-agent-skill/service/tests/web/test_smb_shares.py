"""S2: /api/smb/shares — list + detail."""
from __future__ import annotations


def test_list_empty(client):
    r = client.get("/api/smb/shares")
    assert r.status_code == 200
    body = r.json()
    assert body == {"total": 0, "items": []}


def test_list_shapes_modes_and_rw_and_counts(client, seed):
    sid = seed.share(
        host="10.0.0.5", share="Public",
        null=True, guest=False, auth=True,
        read=True, write=False, status="walked",
        severity="medium", summary="creds-ish",
    )
    f1 = seed.file(sid, path="a/.env", hits=1)
    seed.hit(f1, verdict="confirmed")
    seed.file(sid, path="a/notes.txt", suspicious=False, hits=0)

    r = client.get("/api/smb/shares")
    body = r.json()
    assert body["total"] == 1
    item = body["items"][0]
    assert item["host"] == "10.0.0.5"
    assert item["share"] == "Public"
    assert item["status"] == "walked"
    assert item["modes"] == {"null": True, "guest": False, "auth": True}
    assert item["rw"] == {"read": True, "write": False}
    assert item["counts"]["file_total"] == 2
    assert item["counts"]["file_with_hits"] == 1
    assert item["counts"]["confirmed_hits"] == 1
    assert item["severity"] == "medium"


def test_list_filters_by_status(client, seed):
    seed.share(host="1.1.1.1", share="a", status="walked")
    seed.share(host="1.1.1.2", share="b", status="triaged_completed")
    seed.share(host="1.1.1.3", share="c", status="walked")

    r = client.get("/api/smb/shares?status=walked")
    body = r.json()
    assert body["total"] == 2
    assert {x["host"] for x in body["items"]} == {"1.1.1.1", "1.1.1.3"}


def test_list_search_q_matches_host_or_share(client, seed):
    seed.share(host="10.20.30.40", share="public")
    seed.share(host="10.20.30.41", share="AI_filter")
    seed.share(host="172.16.0.1", share="secret_dump")

    r = client.get("/api/smb/shares?q=AI")
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["share"] == "AI_filter"

    r = client.get("/api/smb/shares?q=172.16")
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["host"] == "172.16.0.1"


def test_list_paginates(client, seed):
    for i in range(5):
        seed.share(host=f"10.0.0.{i}", share=f"s{i}", status="walked")
    r = client.get("/api/smb/shares?limit=2&offset=0")
    body = r.json()
    assert body["total"] == 5
    assert len(body["items"]) == 2


def test_list_hosts_groups_shares_and_filters_print(client, seed):
    seed.share(host="10.0.0.5", share="Public", auth=True, read=True)
    sid = seed.share(host="10.0.0.5", share="print$", auth=True, read=True, status="ignored")
    seed.share(host="10.0.0.6", share="Users", guest=True, read=True)
    import service.state_domain as sd
    sd.share_mark_excluded(sid, "print")

    body = client.get("/api/smb/hosts?open_only=true").json()
    assert body["total"] == 2
    by_host = {x["host"]: x for x in body["items"]}
    assert by_host["10.0.0.5"]["counts"]["share_total"] == 2
    assert by_host["10.0.0.5"]["counts"]["auth_share_total"] == 2
    assert by_host["10.0.0.5"]["counts"]["print_share_total"] == 1
    assert len(by_host["10.0.0.5"]["shares"]) == 2

    body = client.get("/api/smb/hosts?exposure=print").json()
    assert body["total"] == 1
    assert body["items"][0]["host"] == "10.0.0.5"
    assert body["items"][0]["shares"][0]["share"] == "print$"


def test_list_hosts_filters_report_ready_threads_before_and_after_mail_send(client, seed):
    seed.share(host="10.0.0.5", share="Public", auth=True, read=True, status="triaged_completed")
    seed.share(host="10.0.0.6", share="Mailed", auth=True, read=True, status="triaged_completed")
    seed.share(host="10.0.0.7", share="NoReport", auth=True, read=True, status="triaged_completed")

    import service.state_domain as sd
    sd.mail_thread_upsert(
        finding_id=101,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        status="reported",
    )
    sd.mail_thread_upsert(
        finding_id=102,
        host="10.0.0.6",
        subject_tag="[보안취약점 조치요청](10.0.0.6)",
        status="awaiting_reply",
    )

    body = client.get("/api/smb/hosts?report_ready=true").json()

    assert body["total"] == 2
    assert {x["host"] for x in body["items"]} == {"10.0.0.5", "10.0.0.6"}


def test_list_hosts_counts_unc_lifecycle_findings_as_submitted(client, seed):
    from secu_agent import state

    seed.share(host="10.0.0.17", share="C$", auth=True, read=True, status="triaged_completed")
    state.finding_upsert(
        task_type="smb",
        asset=r"\\10.0.0.17\C$",
        asset_kind="location",
        severity="high",
        summary="Windows 관리 공유 C$가 인증 계정으로 열람 가능",
    )

    body = client.get("/api/smb/hosts?exposure=submitted").json()

    assert body["total"] == 1
    item = body["items"][0]
    assert item["host"] == "10.0.0.17"
    assert item["counts"]["lifecycle_share_total"] == 1
    assert item["shares"][0]["counts"]["lifecycle_findings"] == 1


def test_detail_returns_share_with_listing_review_decoded(client, seed):
    review = {"severity": "high", "summary": "personal folder leak",
              "follow_up_actions": ["owner 통보"]}
    sid = seed.share(host="10.0.0.5", share="x",
                     status="walked", listing_review=review)

    r = client.get(f"/api/smb/shares/{sid}")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == sid
    assert body["host"] == "10.0.0.5"
    assert body["listing_review"] == review


def test_detail_404(client):
    r = client.get("/api/smb/shares/99999")
    assert r.status_code == 404
