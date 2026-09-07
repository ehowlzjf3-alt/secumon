"""v3.82 U5: per-session skills 설정(chat_session.settings JSON) + /api/profile."""
from __future__ import annotations


def _token(monkeypatch):
    monkeypatch.setenv("SA_CHAT_TOKEN", "tok-123")
    return "tok-123"


def test_session_create_with_skills_persists_settings(tmp_db, client, monkeypatch):
    t = _token(monkeypatch)
    r = client.post(
        f"/api/chat/sessions?token={t}",
        json={"agent_type": "agent", "label": "skill 선택 세션",
              "skills": ["plan_mode,evidence_inspection"]},
    )
    assert r.status_code == 200, r.text
    sess = r.json()["session"]
    assert sess["settings"] == {"skills": ["plan_mode,evidence_inspection"]}

    from secu_agent import state
    row = state.chat_session_get(sess["id"])
    assert row["settings"]["skills"] == ["plan_mode,evidence_inspection"]


def test_session_create_unknown_skill_is_400(tmp_db, client, monkeypatch):
    t = _token(monkeypatch)
    r = client.post(
        f"/api/chat/sessions?token={t}",
        json={"agent_type": "agent", "skills": ["no_such_skill_xyz"]},
    )
    assert r.status_code == 400
    assert "no_such_skill_xyz" in r.json()["detail"]


def test_session_patch_updates_skills(tmp_db, client, monkeypatch):
    t = _token(monkeypatch)
    sid = client.post(
        f"/api/chat/sessions?token={t}", json={"agent_type": "agent"},
    ).json()["session"]["id"]

    r = client.patch(
        f"/api/chat/sessions/{sid}?token={t}", json={"skills": ["plan_mode"]},
    )
    assert r.status_code == 200
    assert r.json()["session"]["settings"] == {"skills": ["plan_mode"]}


def test_session_selection_resolution_helper(tmp_db, client, monkeypatch):
    """settings → SkillsSelection 해석. skill 이 사라진 경우 None 폴백(세션 보존)."""
    from secu_agent import state
    from secu_agent.web.routes.chat import _session_skills_selection

    sid = state.chat_session_new(agent_type="agent", settings={"skills": ["plan_mode"]})
    sel = _session_skills_selection(sid)
    assert sel is not None and sel.names == ("plan_mode",)

    sid2 = state.chat_session_new(agent_type="agent",
                                  settings={"skills": ["vanished_skill"]})
    assert _session_skills_selection(sid2) is None

    sid3 = state.chat_session_new(agent_type="agent")
    assert _session_skills_selection(sid3) is None


def test_profile_endpoint(tmp_db, client, monkeypatch):
    t = _token(monkeypatch)
    assert client.get("/api/profile").status_code == 401
    r = client.get(f"/api/profile?token={t}")
    assert r.status_code == 200
    body = r.json()
    assert "profile" in body
    # 모델명은 환경에 따라 다름 — 키 존재만 검증 (민감값 미노출)
    assert set(body) <= {"profile", "model", "transport", "reasoning_effort", "error"}
