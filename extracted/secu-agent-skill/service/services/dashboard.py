"""SMB Dashboard 서비스 — 상태/심각도/hit 집계 + 최근 스캔."""
from __future__ import annotations

import json
from typing import Any

# v3.82 U3d: 도메인 테이블 접근은 service.state_domain 으로 (코어 state 미사용).
from service import state_domain


def smb_dashboard() -> dict[str, Any]:
    with state_domain.connect() as c:
        status_counts = {
            r["status"]: r["n"] for r in c.execute(
                "SELECT status, COUNT(*) AS n FROM smb_share GROUP BY status"
            ).fetchall()
        }
        severity_counts = {
            r["severity"]: r["n"] for r in c.execute(
                "SELECT severity, COUNT(*) AS n FROM smb_share "
                "WHERE severity IS NOT NULL GROUP BY severity"
            ).fetchall()
        }
        hits_rows = c.execute(
            "SELECT agent_verdict, COUNT(*) AS n FROM smb_file_hit GROUP BY agent_verdict"
        ).fetchall()
        hits = {"pending": 0, "confirmed": 0, "false_positive": 0}
        for r in hits_rows:
            hits[r["agent_verdict"]] = r["n"]

        cred_count = c.execute(
            "SELECT COUNT(*) FROM smb_credential WHERE enabled=1"
        ).fetchone()[0]

    recent = state_domain.recent_scans(kind="smb", limit=10)
    for s in recent:
        if s.get("subnets"):
            try:
                s["subnets"] = json.loads(s["subnets"])
            except (ValueError, TypeError):
                pass

    return {
        "status_counts": status_counts,
        "severity_counts": severity_counts,
        "hits": hits,
        "cred_count": int(cred_count),
        "recent_scans": recent,
    }
