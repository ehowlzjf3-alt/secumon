"""v3.78 F2: 기존 finding 소급 정리 — 제외 대상 PII 노이즈 → false_positive."""
from __future__ import annotations


def _mk(state, task_type, asset, hits, severity="medium"):
    fid, _ = state.finding_upsert(
        task_type=task_type, asset=asset, asset_kind="repository_file",
        severity=severity, summary="s", extra={"hits": hits},
    )
    return fid


def test_find_low_value_findings_detects_email_only(tmp_db):
    from secu_agent import state
    from secu_agent.agent.finding_cleanup import find_low_value_findings

    email = _mk(state, "github", "github:o/r/AUTHORS",
                [{"category": "pii", "kind": "email"}])
    vehicle = _mk(state, "smb", "smb://10.0.0.5/image/CH01.jpg",
                  [{"category": "pii", "kind": "vehicle_plate_images"}])
    secret = _mk(state, "github", "github:o/r/.env",
                 [{"category": "secret", "kind": "aws_access_key_id"}], "high")
    rrn = _mk(state, "web", "https://x/doc",
              [{"category": "pii", "kind": "kr_rrn"}], "high")

    ids = {r["id"] for r in find_low_value_findings()}
    assert email in ids
    assert vehicle in ids
    assert secret not in ids   # secret 동반 → 유지
    assert rrn not in ids      # 고가치 PII → 유지


def test_retro_mark_low_value_dry_run_then_apply(tmp_db):
    from secu_agent import state
    from secu_agent.agent.finding_cleanup import retro_mark_low_value

    email = _mk(state, "github", "github:o/r/AUTHORS",
                [{"category": "pii", "kind": "email"}])
    secret = _mk(state, "github", "github:o/r/.env",
                 [{"category": "secret", "kind": "x"}], "high")

    dry = retro_mark_low_value(apply=False, reason="r")
    assert dry["count"] == 1
    assert dry["applied"] is False
    assert state.finding_get(email)["status"] == "open"  # dry-run 은 안 바꿈

    res = retro_mark_low_value(apply=True, reason="이메일-only 소급정리")
    assert res["count"] == 1
    assert res["applied"] is True
    assert state.finding_get(email)["status"] == "false_positive"
    assert state.finding_get(email)["extra"]["status_reason"] == "이메일-only 소급정리"
    assert state.finding_get(secret)["status"] == "open"


def test_retro_only_touches_open_not_triaged(tmp_db):
    """사람이 이미 검토(triaged/accepted 등)한 finding 은 자동 전이 금지."""
    from secu_agent import state
    from secu_agent.agent.finding_cleanup import retro_mark_low_value

    email = _mk(state, "github", "github:o/r/AUTHORS",
                [{"category": "pii", "kind": "email"}])
    state.finding_update(email, status="triaged")

    res = retro_mark_low_value(apply=True, reason="r")
    assert res["count"] == 0
    assert state.finding_get(email)["status"] == "triaged"
