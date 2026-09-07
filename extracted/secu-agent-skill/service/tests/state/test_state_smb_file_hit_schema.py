"""v3.42 F1-a: smb_file_hit 의 line_preview 통일 검증.

이전: column/dict key = 'preview', Hit.line_preview — 두 이름 불일치 함정
이후: 둘 다 'line_preview' 로 통일.
"""
from __future__ import annotations

import service.state_domain as sd
from secu_agent import state


def test_smb_file_hit_column_name_is_line_preview(tmp_db):
    """schema 가 'line_preview' 사용 (기존 'preview' 아님)."""
    with sd.connect() as c:
        cols = {r["column_name"] for r in c.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='smb_file_hit'").fetchall()}
    assert "line_preview" in cols
    assert "validation_json" in cols
    assert "preview" not in cols, (
        "column 이름 통일 후 'preview' 는 없어야 — 마이그레이션 미적용"
    )


def test_add_file_hits_uses_line_preview_key(seed):
    """dict 인풋: 'line_preview' key 가 정답."""
    sid = seed.share()
    fid = seed.file(share_id=sid)
    sd.add_file_hits(fid, [{
        "category": "secret", "kind": "aws_access_key_id",
        "masked": "AKIA****", "line_no": 10,
        "line_preview": "export KEY=AKIA****",
        "validation": {
            "kind": "credential_reachability",
            "policy": "GET only; POST/PUT/PATCH/DELETE not sent",
            "attempted": True,
        },
    }])
    with sd.connect() as c:
        row = c.execute(
            "SELECT line_preview, validation_json FROM smb_file_hit WHERE file_id=?", (fid,),
        ).fetchone()
    assert row["line_preview"] == "export KEY=AKIA****"
    assert "GET only" in row["validation_json"]


def test_add_file_hit_manual_param_is_line_preview(seed):
    """add_file_hit_manual 의 keyword 도 'line_preview'."""
    sid = seed.share()
    fid = seed.file(share_id=sid)
    sd.add_file_hit_manual(
        fid, category="secret", kind="internal_token",
        masked="tk=***", line_no=3, line_preview="tk=secret_xyz",
        verdict="confirmed",
    )
    with sd.connect() as c:
        row = c.execute(
            "SELECT line_preview, agent_verdict FROM smb_file_hit WHERE file_id=?",
            (fid,),
        ).fetchone()
    assert row["line_preview"] == "tk=secret_xyz"
    assert row["agent_verdict"] == "confirmed"
