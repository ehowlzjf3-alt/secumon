"""dev_web pipeline read-model projection."""
from __future__ import annotations

import time
from typing import Any

from domains.dev_web.application.contracts import (
    COMPONENT_DISCOVERY,
    COMPONENT_TASK,
    COMPONENT_REPORT,
    COMPONENT_REVERIFY,
    SA_SESSION_ID,
    REPORT_SESSION_ID,
    REVERIFY_SESSION_ID,
)
from domains.dev_web.application.ports import PipelineProjectionStorePort


def _one(c, q: str, args=()) -> int:
    row = c.execute(q, args).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def _rows(c, q: str, args=()) -> list[str]:
    return [str(r[0]) for r in c.execute(q, args).fetchall() if r[0] is not None]


def _heartbeat_map(c) -> dict[str, dict[str, Any]]:
    now = time.time()
    out: dict[str, dict[str, Any]] = {}
    for row in c.execute("SELECT * FROM pipeline_heartbeat ORDER BY component").fetchall():
        component = str(row["component"])
        if not component.startswith("dev_web"):
            continue
        age = now - (row["last_beat"] or 0)
        out[component] = {
            "phase": row["phase"],
            "detail": row["detail"],
            "pid": row["pid"],
            "last_beat": row["last_beat"],
            "age_sec": round(age, 1),
            "alive": age < 600,
        }
    return out


def _target_counts(c, *, cycle_key: str) -> dict[str, int]:
    rows = c.execute(
        "SELECT status, COUNT(*) AS n FROM dev_web_target "
        "WHERE cycle_key=? GROUP BY status",
        (cycle_key,),
    ).fetchall()
    out = {"pending": 0, "in_progress": 0, "tasked": 0, "skipped": 0, "error": 0, "total": 0}
    for row in rows:
        out[row["status"]] = int(row["n"])
        out["total"] += int(row["n"])
    return out


def _thread_counts(c, *, cycle_key: str) -> dict[str, int]:
    rows = c.execute(
        "SELECT status, COUNT(*) AS n FROM dev_web_report_thread "
        "WHERE last_cycle_key=? GROUP BY status",
        (cycle_key,),
    ).fetchall()
    out: dict[str, int] = {"total": 0}
    for row in rows:
        out[row["status"]] = int(row["n"])
        out["total"] += int(row["n"])
    return out


def _hitl_count(counts: dict[str, int]) -> int:
    return (
        counts.get("exception_review", 0)
        + counts.get("owner_update_needed", 0)
        + counts.get("owner_reassignment_review", 0)
        + counts.get("reassigned", 0)
    )


def pipeline_overview(
    *,
    store: PipelineProjectionStorePort,
    live: bool = False,
) -> dict[str, Any]:
    del live
    with store.connect() as c:
        cycle_key = store.current_cycle_key()
        tc = _target_counts(c, cycle_key=cycle_key)
        rc = _thread_counts(c, cycle_key=cycle_key)
        hb = _heartbeat_map(c)
        stages = [
            {
                "key": "discovery",
                "label": "Discovery",
                "owner": "dev_web_discovery",
                "queue": tc["pending"],
                "done": tc["total"] > 0 and tc["pending"] == 0 and tc["in_progress"] == 0,
                "status": "active" if hb.get(COMPONENT_DISCOVERY, {}).get("alive") else "idle",
                "active": [],
                "next": _rows(
                    c,
                    "SELECT domain FROM dev_web_target WHERE status='pending' "
                    "AND cycle_key=? ORDER BY priority_score DESC, event_count DESC LIMIT 10",
                    (cycle_key,),
                ),
                "metrics": [
                    {"label": "targets", "value": tc["total"]},
                    {"label": "pending", "value": tc["pending"]},
                ],
            },
            {
                "key": "task",
                "label": "Task",
                "owner": "dev_web_task",
                "queue": tc["pending"],
                "done": tc["tasked"] + tc["skipped"] + tc["error"],
                "status": "active" if hb.get(COMPONENT_TASK, {}).get("alive") else "waiting",
                "active": _rows(
                    c,
                    "SELECT domain FROM dev_web_target WHERE status='in_progress' "
                    "AND claimed_by=? AND cycle_key=? ORDER BY claimed_at ASC LIMIT 10",
                    (SA_SESSION_ID, cycle_key),
                ),
                "next": _rows(
                    c,
                    "SELECT domain FROM dev_web_target WHERE status='pending' "
                    "AND cycle_key=? ORDER BY priority_score DESC, event_count DESC LIMIT 10",
                    (cycle_key,),
                ),
                "metrics": [
                    {"label": "tasked", "value": tc["tasked"]},
                    {"label": "skipped", "value": tc["skipped"]},
                    {
                        "label": "findings",
                        "value": _one(
                            c,
                            "SELECT COUNT(DISTINCT finding_id) FROM dev_web_report_thread "
                            "WHERE last_cycle_key=? AND finding_id IS NOT NULL",
                            (cycle_key,),
                        ),
                    },
                ],
            },
            {
                "key": "report",
                "label": "Report",
                "owner": "dev_web_report",
                "queue": rc.get("reported", 0),
                "done": (
                    # 초안까지 만들고 발송만 남은 것(report_ready)도 이 단계는 끝난 것이다.
                    # 안 세면 파킹된 스레드가 화면에서 통째로 증발한다.
                    rc.get("report_ready", 0)
                    + rc.get("awaiting_reply", 0)
                    + rc.get("reply_received", 0)
                    + rc.get("reverifying", 0)
                    + rc.get("re_requested", 0)
                    + rc.get("partially_remediated", 0)
                    + rc.get("remediated", 0)
                    + _hitl_count(rc)
                ),
                "status": "active" if hb.get(COMPONENT_REPORT, {}).get("alive") else "waiting",
                "active": _rows(
                    c,
                    "SELECT domain FROM dev_web_report_thread WHERE status='reported' "
                    "AND claimed_by=? AND last_cycle_key=? ORDER BY claimed_at ASC LIMIT 10",
                    (REPORT_SESSION_ID, cycle_key),
                ),
                "next": _rows(
                    c,
                    "SELECT domain FROM dev_web_report_thread WHERE status='reported' "
                    "AND last_cycle_key=? ORDER BY updated_at ASC LIMIT 10",
                    (cycle_key,),
                ),
                "metrics": [
                    {"label": "reported_queue", "value": rc.get("reported", 0)},
                    # 발송 스위치가 꺼져 있어 대기 중인 초안. 0 이 아니면 "보낼 게 쌓였다".
                    {"label": "report_ready", "value": rc.get("report_ready", 0)},
                    {"label": "awaiting_reply", "value": rc.get("awaiting_reply", 0)},
                    {"label": "hitl", "value": _hitl_count(rc)},
                ],
            },
            {
                "key": "reverify",
                "label": "Reverify",
                "owner": "dev_web_reverify",
                "queue": rc.get("reply_received", 0) + rc.get("re_requested", 0),
                "done": rc.get("remediated", 0),
                "status": "active" if hb.get(COMPONENT_REVERIFY, {}).get("alive") else "waiting",
                "active": _rows(
                    c,
                    "SELECT domain FROM dev_web_report_thread WHERE status='reverifying' "
                    "AND claimed_by=? AND last_cycle_key=? ORDER BY claimed_at ASC LIMIT 10",
                    (REVERIFY_SESSION_ID, cycle_key),
                ),
                "next": _rows(
                    c,
                    "SELECT domain FROM dev_web_report_thread WHERE status IN ("
                    "'reply_received','re_requested','partially_remediated',"
                    "'exception_review','owner_update_needed',"
                    "'owner_reassignment_review','reassigned') "
                    "AND last_cycle_key=? ORDER BY updated_at ASC LIMIT 10",
                    (cycle_key,),
                ),
                "metrics": [
                    {"label": "remediated", "value": rc.get("remediated", 0)},
                    {"label": "still_open", "value": rc.get("re_requested", 0)},
                    {"label": "partial", "value": rc.get("partially_remediated", 0)},
                    {"label": "hitl", "value": _hitl_count(rc)},
                ],
            },
        ]
        return {
            "kind": "dev_web_pipeline_overview",
            "cycle_key": cycle_key,
            "stages": stages,
            "target_status_counts": tc,
            "report_thread_status_counts": rc,
            "heartbeats": hb,
            "control_flags": {
                component: store.control_flag_get(component)
                for component in (
                    COMPONENT_DISCOVERY,
                    COMPONENT_TASK,
                    COMPONENT_REPORT,
                    COMPONENT_REVERIFY,
                )
            },
            "recent_runs": {
                component: store.pipeline_runs_recent(component, limit=3)
                for component in (COMPONENT_DISCOVERY, COMPONENT_TASK, COMPONENT_REPORT, COMPONENT_REVERIFY)
            },
        }
