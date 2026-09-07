"""Health service — DB가 살아있는지 + 코어 큰 그림 카운트.

v3.82 U3b: smb_share/smb_file 카운트(도메인) 제거 — 도메인 테이블은 도메인
서비스 소유. 코어 카운트 = 채팅 세션 / 스케줄 / open finding.
"""
from __future__ import annotations

from typing import Any

from secu_agent import state


def health_snapshot() -> dict[str, Any]:
    with state.connect() as c:
        session_total = c.execute("SELECT COUNT(*) FROM chat_session").fetchone()[0]
        schedule_total = c.execute("SELECT COUNT(*) FROM schedule").fetchone()[0]
        finding_open = c.execute(
            "SELECT COUNT(*) FROM finding_lifecycle WHERE status = 'open'"
        ).fetchone()[0]
    return {
        "ok": True,
        "db": str(state.db_label()),
        "chat_session_total": int(session_total),
        "schedule_total": int(schedule_total),
        "finding_open": int(finding_open),
    }
