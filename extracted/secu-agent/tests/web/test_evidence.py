from __future__ import annotations


def test_evidence_api_reads_json_under_allowed_root(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from secu_agent.web.app import create_app

    monkeypatch.setenv("SA_CHAT_TOKEN", "tok-123")
    monkeypatch.setenv("SA_CHAT_EVIDENCE", str(tmp_path))
    evidence = tmp_path / "probe.json"
    evidence.write_text('{"ok": true, "n": 1}', encoding="utf-8")

    client = TestClient(create_app())
    r = client.get(f"/api/evidence?token=tok-123&path={evidence}")

    assert r.status_code == 200
    body = r.json()
    assert body["path"] == str(evidence)
    assert body["json"] == {"ok": True, "n": 1}
    assert body["text"].startswith("{")


def test_evidence_api_rejects_path_outside_allowed_root(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from secu_agent.web.app import create_app

    monkeypatch.setenv("SA_CHAT_TOKEN", "tok-123")
    monkeypatch.setenv("SA_CHAT_EVIDENCE", str(tmp_path / "allowed"))
    outside = tmp_path / "outside.json"
    outside.write_text("{}", encoding="utf-8")

    client = TestClient(create_app())
    r = client.get(f"/api/evidence?token=tok-123&path={outside}")

    assert r.status_code == 403
