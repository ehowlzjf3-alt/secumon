"""Shared report-cycle helpers for service E2E domains."""
from __future__ import annotations

import json
from typing import Any


def report_cycle_summary(thread: dict[str, Any]) -> dict[str, Any]:
    """Normalize weekly cycle metadata stored on a service report thread."""
    keys: list[str] = []
    try:
        raw = json.loads(thread.get("cycle_keys") or "[]")
    except Exception:
        raw = []
    if isinstance(raw, list):
        for value in raw:
            key = str(value or "").strip()
            if key and key not in keys:
                keys.append(key)
    for name in ("first_cycle_key", "last_cycle_key"):
        key = str(thread.get(name) or "").strip()
        if key and key not in keys:
            keys.append(key)
    first = keys[0] if keys else str(thread.get("first_cycle_key") or "").strip()
    last = keys[-1] if keys else str(thread.get("last_cycle_key") or "").strip()
    week_count = max(1, len(keys))
    return {
        "first_cycle_key": first or None,
        "last_cycle_key": last or None,
        "cycle_keys": keys,
        "accumulated_week_count": week_count,
        "recurrence_count": max(0, week_count - 1),
        "is_recurring": week_count > 1,
    }


def accumulated_week_label(summary: dict[str, Any]) -> str:
    count = int(summary.get("accumulated_week_count") or 1)
    return f"{max(1, count)}주 누적 확인"


def notice_recurrence_label(sent_count: int) -> str:
    """재확인 문구의 제목 — **안내 횟수**로 말한다.

    ⚠️ 예전엔 `accumulated_week_label`(스캔 주차)을 썼다. 우리가 두 주 연속 본 것과
       담당자에게 두 번 알린 것은 다르다. 첫 발송인데 "2주 누적 확인" 이 나갔다
       (2026-08-31 실측).
    """
    n = max(0, int(sent_count or 0))
    return f"{n + 1}번째 안내 · 이전 {n}회 안내"


def should_show_recurrence(sent_count: int) -> bool:
    """"이전에 안내드린" 을 말해도 되는가 — **한 번이라도 나갔을 때만.**"""
    return max(0, int(sent_count or 0)) >= 1
