"""Confluence E2E pipeline read-model projection."""
from __future__ import annotations

import time
from typing import Any

from domains.services.confluence.application.contracts import (
    COMPONENT_CONFLUENCE_RECHECK,
    COMPONENT_CONFLUENCE_REPORT,
    COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
    COMPONENT_CONFLUENCE_SPACE_TASK,
    COMPONENT_CONFLUENCE_SSO_DISCOVERY,
    COMPONENT_CONFLUENCE_SSO_TASK,
    CONFLUENCE_RECHECK_SESSION_ID,
    CONFLUENCE_REPORT_SESSION_ID,
    CONFLUENCE_SPACE_TASK_SESSION_ID,
    CONFLUENCE_SSO_TASK_SESSION_ID,
    PHASE_CONFLUENCE_RECHECK,
    PHASE_CONFLUENCE_REPORT,
    PHASE_CONFLUENCE_SPACE_DISCOVERY,
    PHASE_CONFLUENCE_SPACE_TASK,
    PHASE_CONFLUENCE_SSO_DISCOVERY,
    PHASE_CONFLUENCE_SSO_TASK,
)
from domains.services.confluence.application.ports import PipelineProjectionStorePort

_CONFLUENCE_REPORT_STATUSES = (
    "draft", "reported", "report_ready", "awaiting_owner",
    "recheck_requested", "rechecking", "remediated", "still_open",
    "partially_remediated", "exception_review", "owner_update_needed",
    "owner_reassignment_review", "reassigned", "escalated", "closed", "error",
)
_CONFLUENCE_HITL_STATUSES = (
    "exception_review", "owner_update_needed", "owner_reassignment_review", "reassigned",
)
_CONFLUENCE_REPLY_SEEN_STATUSES = (
    "recheck_requested", "rechecking", "still_open", "partially_remediated",
    *_CONFLUENCE_HITL_STATUSES, "remediated", "escalated", "closed",
)
_CONFLUENCE_REPORT_DONE_STATUSES = (
    "report_ready", "awaiting_owner", "recheck_requested", "rechecking",
    "still_open", "partially_remediated", "remediated", "exception_review",
    "owner_update_needed", "owner_reassignment_review", "reassigned", "escalated", "closed",
)
_CONFLUENCE_OWNER_SCOPE_STATUSES = (
    "reported", "report_ready", "awaiting_owner", "recheck_requested", "rechecking",
    "still_open", "partially_remediated", *_CONFLUENCE_HITL_STATUSES,
    "escalated", "error",
)


def _one(c, q: str, args=()) -> int:
    r = c.execute(q, args).fetchone()
    return int(r[0]) if r and r[0] is not None else 0


def _heartbeat_map(c) -> dict[str, dict[str, Any]]:
    now = time.time()
    out: dict[str, dict[str, Any]] = {}
    rows = c.execute("SELECT * FROM pipeline_heartbeat ORDER BY component").fetchall()
    for hb in rows:
        age = now - (hb["last_beat"] or 0)
        out[hb["component"]] = {
            "phase": hb["phase"],
            "detail": hb["detail"],
            "pid": hb["pid"],
            "last_beat": hb["last_beat"],
            "age_sec": round(age, 1),
            "alive": age < 600,
        }
    return out


def _status_counts(c, table: str, *, where: str = "", args=()) -> dict[str, int]:
    suffix = f" WHERE {where}" if where else ""
    rows = c.execute(
        f"SELECT status, COUNT(*) AS n FROM {table}{suffix} GROUP BY status",
        args,
    ).fetchall()
    return {str(r["status"]): int(r["n"]) for r in rows}


def _space_status_counts(c, *, cycle_key: str) -> dict[str, int]:
    out = {s: 0 for s in ("pending", "in_progress", "tasked", "skipped", "error")}
    out.update(
        _status_counts(
            c,
            "confluence_space_target",
            where="cycle_key=?",
            args=(cycle_key,),
        )
    )
    out["total"] = sum(out.values())
    out["never_scanned"] = _one(
        c,
        "SELECT COUNT(*) FROM confluence_space_target "
        "WHERE cycle_key=? AND cycle_scanned_at IS NULL",
        (cycle_key,),
    )
    out["scanned"] = _one(
        c,
        "SELECT COUNT(*) FROM confluence_space_target "
        "WHERE cycle_key=? AND cycle_scanned_at IS NOT NULL",
        (cycle_key,),
    )
    return out


def _sso_status_counts(c, *, cycle_key: str) -> dict[str, int]:
    out = {s: 0 for s in ("pending", "in_progress", "tasked", "skipped", "error")}
    out.update(
        _status_counts(
            c,
            "devops_target",
            where="service='confluence' AND cycle_key=?",
            args=(cycle_key,),
        )
    )
    out["total"] = sum(out.values())
    out["never_scanned"] = _one(
        c,
        "SELECT COUNT(*) FROM devops_target "
        "WHERE service='confluence' AND cycle_key=? AND cycle_scanned_at IS NULL",
        (cycle_key,),
    )
    out["scanned"] = _one(
        c,
        "SELECT COUNT(*) FROM devops_target "
        "WHERE service='confluence' AND cycle_key=? AND cycle_scanned_at IS NOT NULL",
        (cycle_key,),
    )
    return out


def _thread_status_counts(c, *, cycle_key: str) -> dict[str, int]:
    out = {s: 0 for s in _CONFLUENCE_REPORT_STATUSES}
    out.update(
        _status_counts(
            c,
            "confluence_report_thread",
            where="last_cycle_key=?",
            args=(cycle_key,),
        )
    )
    return out


def _space_targets(
    c,
    *,
    mode: str,
    cooldown_seconds: float,
    stale_seconds: float,
    cycle_key: str,
) -> list[dict[str, str]]:
    now = time.time()
    stale_cutoff = now - stale_seconds
    fresh_cutoff = now - cooldown_seconds
    if mode == "active":
        rows = c.execute(
            "SELECT id, space_key FROM confluence_space_target "
            "WHERE cycle_key=? AND status='in_progress' AND claimed_by=? "
            "AND claimed_at >= ? "
            "ORDER BY claimed_at ASC, id ASC LIMIT 10",
            (cycle_key, CONFLUENCE_SPACE_TASK_SESSION_ID, stale_cutoff),
        ).fetchall()
    elif mode == "stuck":
        rows = c.execute(
            "SELECT id, space_key FROM confluence_space_target "
            "WHERE cycle_key=? AND status='in_progress' "
            "AND (claimed_at IS NULL OR claimed_at < ? OR COALESCE(claimed_by, -1)<>?) "
            "ORDER BY COALESCE(claimed_at, 0) ASC, id ASC LIMIT 10",
            (cycle_key, stale_cutoff, CONFLUENCE_SPACE_TASK_SESSION_ID),
        ).fetchall()
    else:
        rows = c.execute(
            "SELECT id, space_key FROM confluence_space_target "
            "WHERE cycle_key=? AND (status='pending' "
            "OR (status='in_progress' AND claimed_at IS NOT NULL AND claimed_at < ?) "
            "OR (status IN ('tasked','skipped','error') "
            "AND (cycle_scanned_at IS NULL OR last_scanned_at IS NULL OR last_scanned_at < ?))) "
            "AND (retry_after IS NULL OR retry_after <= ?) "
            "ORDER BY (cycle_scanned_at IS NULL) DESC, "
            "(last_scanned_at IS NULL) DESC, last_scanned_at ASC, id ASC LIMIT 10",
            (cycle_key, stale_cutoff, fresh_cutoff, now),
        ).fetchall()
    return [
        {
            "label": str(r["space_key"]),
            "component": COMPONENT_CONFLUENCE_SPACE_TASK,
            "session_ref": f"space-{int(r['id'])}",
        }
        for r in rows
    ]


def _sso_targets(
    c,
    *,
    mode: str,
    cooldown_seconds: float,
    stale_seconds: float,
    cycle_key: str,
) -> list[dict[str, str]]:
    now = time.time()
    stale_cutoff = now - stale_seconds
    fresh_cutoff = now - cooldown_seconds
    if mode == "active":
        rows = c.execute(
            "SELECT id, url FROM devops_target "
            "WHERE service='confluence' AND cycle_key=? "
            "AND status='in_progress' AND claimed_by=? "
            "AND claimed_at >= ? "
            "ORDER BY claimed_at ASC, id ASC LIMIT 10",
            (cycle_key, CONFLUENCE_SSO_TASK_SESSION_ID, stale_cutoff),
        ).fetchall()
    elif mode == "stuck":
        rows = c.execute(
            "SELECT id, url FROM devops_target "
            "WHERE service='confluence' AND cycle_key=? AND status='in_progress' "
            "AND (claimed_at IS NULL OR claimed_at < ? OR COALESCE(claimed_by, -1)<>?) "
            "ORDER BY COALESCE(claimed_at, 0) ASC, id ASC LIMIT 10",
            (cycle_key, stale_cutoff, CONFLUENCE_SSO_TASK_SESSION_ID),
        ).fetchall()
    else:
        rows = c.execute(
            "SELECT id, url FROM devops_target "
            "WHERE service='confluence' AND cycle_key=? "
            "AND (status != 'in_progress' OR (claimed_at IS NOT NULL AND claimed_at < ?)) "
            "AND (cycle_scanned_at IS NULL OR last_task_at IS NULL OR last_task_at < ?) "
            "AND (retry_after IS NULL OR retry_after <= ?) "
            "ORDER BY (cycle_scanned_at IS NULL) DESC, "
            "(last_task_at IS NULL) DESC, access_count DESC, last_task_at ASC, id ASC LIMIT 10",
            (cycle_key, stale_cutoff, fresh_cutoff, now),
        ).fetchall()
    return [
        {
            "label": str(r["url"]),
            "component": COMPONENT_CONFLUENCE_SSO_TASK,
            "session_ref": f"devops-{int(r['id'])}",
        }
        for r in rows
    ]


def _thread_targets(c, q: str, args=(), *, component: str) -> list[dict[str, str]]:
    return [
        {
            "label": str(r["space_key"]),
            "component": component,
            "session_ref": f"confluence-thread-{int(r['id'])}",
        }
        for r in c.execute(q, args).fetchall()
    ]


def _stage_targets(
    c,
    *,
    space_rescan: float,
    space_claim_stale: float,
    devops_rescan: float,
    devops_claim_stale: float,
    thread_stale: float,
    cycle_key: str,
) -> dict[str, dict[str, list[Any]]]:
    now = time.time()
    stale_thread = now - thread_stale
    return {
        "space_discovery": {
            "active": [],
            "next": _space_targets(
                c,
                mode="next",
                cooldown_seconds=space_rescan,
                stale_seconds=space_claim_stale,
                cycle_key=cycle_key,
            ),
        },
        "space_task": {
            "active": _space_targets(
                c,
                mode="active",
                cooldown_seconds=space_rescan,
                stale_seconds=space_claim_stale,
                cycle_key=cycle_key,
            ),
            "next": _space_targets(
                c,
                mode="next",
                cooldown_seconds=space_rescan,
                stale_seconds=space_claim_stale,
                cycle_key=cycle_key,
            ),
            "stuck": _space_targets(
                c,
                mode="stuck",
                cooldown_seconds=space_rescan,
                stale_seconds=space_claim_stale,
                cycle_key=cycle_key,
            ),
        },
        "sso_discovery": {
            "active": [],
            "next": _sso_targets(
                c,
                mode="next",
                cooldown_seconds=devops_rescan,
                stale_seconds=devops_claim_stale,
                cycle_key=cycle_key,
            ),
        },
        "sso_task": {
            "active": _sso_targets(
                c,
                mode="active",
                cooldown_seconds=devops_rescan,
                stale_seconds=devops_claim_stale,
                cycle_key=cycle_key,
            ),
            "next": _sso_targets(
                c,
                mode="next",
                cooldown_seconds=devops_rescan,
                stale_seconds=devops_claim_stale,
                cycle_key=cycle_key,
            ),
            "stuck": _sso_targets(
                c,
                mode="stuck",
                cooldown_seconds=devops_rescan,
                stale_seconds=devops_claim_stale,
                cycle_key=cycle_key,
            ),
        },
        "owner": {
            "active": [],
            "next": _thread_targets(
                c,
                "SELECT id, space_key FROM confluence_report_thread "
                f"WHERE status IN ({','.join('?' for _ in _CONFLUENCE_OWNER_SCOPE_STATUSES)}) "
                "AND last_cycle_key=? AND TRIM(COALESCE(owner_recipient, ''))='' "
                "ORDER BY updated_at ASC LIMIT 10",
                (*_CONFLUENCE_OWNER_SCOPE_STATUSES, cycle_key),
                component=COMPONENT_CONFLUENCE_REPORT,
            ),
        },
        "report": {
            "active": _thread_targets(
                c,
                "SELECT id, space_key FROM confluence_report_thread "
                "WHERE status='reported' AND last_cycle_key=? "
                "AND TRIM(COALESCE(owner_recipient, ''))<>'' "
                "AND claimed_by=? AND claimed_at >= ? "
                "ORDER BY claimed_at ASC LIMIT 10",
                (cycle_key, CONFLUENCE_REPORT_SESSION_ID, stale_thread),
                component=COMPONENT_CONFLUENCE_REPORT,
            ),
            "next": _thread_targets(
                c,
                "SELECT id, space_key FROM confluence_report_thread "
                "WHERE status='reported' AND last_cycle_key=? "
                "AND TRIM(COALESCE(owner_recipient, ''))<>'' "
                "AND (retry_after IS NULL OR retry_after <= ?) "
                "AND (claimed_at IS NULL OR claimed_at < ?) "
                "ORDER BY updated_at ASC LIMIT 10",
                (cycle_key, now, stale_thread),
                component=COMPONENT_CONFLUENCE_REPORT,
            ),
            "stuck": _thread_targets(
                c,
                "SELECT id, space_key FROM confluence_report_thread "
                "WHERE status='reported' AND last_cycle_key=? AND claimed_at IS NOT NULL "
                "AND TRIM(COALESCE(owner_recipient, ''))<>'' "
                "AND (claimed_at < ? OR COALESCE(claimed_by, -1)<>?) "
                "ORDER BY claimed_at ASC, id ASC LIMIT 10",
                (cycle_key, stale_thread, CONFLUENCE_REPORT_SESSION_ID),
                component=COMPONENT_CONFLUENCE_REPORT,
            ),
        },
        "reply": {
            "active": _thread_targets(
                c,
                "SELECT id, space_key FROM confluence_report_thread "
                "WHERE status='awaiting_owner' AND last_cycle_key=? "
                "AND claimed_by=? AND claimed_at >= ? "
                "ORDER BY claimed_at ASC, id ASC LIMIT 10",
                (cycle_key, CONFLUENCE_RECHECK_SESSION_ID, stale_thread),
                component=COMPONENT_CONFLUENCE_RECHECK,
            ),
            "next": _thread_targets(
                c,
                "SELECT id, space_key FROM confluence_report_thread "
                "WHERE status='awaiting_owner' AND last_cycle_key=? "
                "AND (retry_after IS NULL OR retry_after <= ?) "
                "AND (claimed_at IS NULL OR claimed_at < ?) "
                "ORDER BY COALESCE(notified_at, updated_at) ASC, id ASC LIMIT 10",
                (cycle_key, now, stale_thread),
                component=COMPONENT_CONFLUENCE_RECHECK,
            ),
            "stuck": _thread_targets(
                c,
                "SELECT id, space_key FROM confluence_report_thread "
                "WHERE status='awaiting_owner' AND last_cycle_key=? "
                "AND claimed_at IS NOT NULL "
                "AND (claimed_at < ? OR COALESCE(claimed_by, -1)<>?) "
                "ORDER BY COALESCE(claimed_at, 0) ASC, id ASC LIMIT 10",
                (cycle_key, stale_thread, CONFLUENCE_RECHECK_SESSION_ID),
                component=COMPONENT_CONFLUENCE_RECHECK,
            ),
        },
        "recheck": {
            "active": _thread_targets(
                c,
                "SELECT id, space_key FROM confluence_report_thread "
                "WHERE last_cycle_key=? AND ("
                "(status='recheck_requested' AND claimed_by=? AND claimed_at >= ?) "
                "OR (status='rechecking' AND claimed_by=? AND claimed_at >= ?)"
                ") ORDER BY claimed_at ASC, id ASC LIMIT 10",
                (
                    cycle_key,
                    CONFLUENCE_RECHECK_SESSION_ID,
                    stale_thread,
                    CONFLUENCE_RECHECK_SESSION_ID,
                    stale_thread,
                ),
                component=COMPONENT_CONFLUENCE_RECHECK,
            ),
            "next": _thread_targets(
                c,
                "SELECT id, space_key FROM confluence_report_thread "
                "WHERE status='recheck_requested' AND last_cycle_key=? "
                "AND (retry_after IS NULL OR retry_after <= ?) "
                "AND (claimed_at IS NULL OR claimed_at < ?) "
                "ORDER BY updated_at ASC LIMIT 10",
                (cycle_key, now, stale_thread),
                component=COMPONENT_CONFLUENCE_RECHECK,
            ),
            "stuck": _thread_targets(
                c,
                "SELECT id, space_key FROM confluence_report_thread "
                "WHERE last_cycle_key=? AND ("
                "(status='recheck_requested' AND claimed_at IS NOT NULL "
                "AND (claimed_at < ? OR COALESCE(claimed_by, -1)<>?)) "
                "OR (status='rechecking' AND "
                "(claimed_at IS NULL OR claimed_at < ? OR COALESCE(claimed_by, -1)<>?))"
                ") ORDER BY COALESCE(claimed_at, 0) ASC, id ASC LIMIT 10",
                (
                    cycle_key,
                    stale_thread,
                    CONFLUENCE_RECHECK_SESSION_ID,
                    stale_thread,
                    CONFLUENCE_RECHECK_SESSION_ID,
                ),
                component=COMPONENT_CONFLUENCE_RECHECK,
            ),
        },
        "done": {
            "active": [],
            "next": _thread_targets(
                c,
                "SELECT id, space_key FROM confluence_report_thread "
                "WHERE status IN ('remediated','closed') AND last_cycle_key=? "
                "ORDER BY updated_at DESC LIMIT 8",
                (cycle_key,),
                component=COMPONENT_CONFLUENCE_RECHECK,
            ),
        },
    }


def pipeline_overview(
    *,
    store: PipelineProjectionStorePort,
    live: bool = False,
) -> dict[str, Any]:
    store.ensure_space_cycle_current()
    store.ensure_sso_cycle_current()
    with store.connect() as c:
        cycle_key = store.current_cycle_key()
        now = time.time()
        stale_thread = now - store.confluence_report_thread_claim_stale_seconds
        spaces = _space_status_counts(c, cycle_key=cycle_key)
        sso = _sso_status_counts(c, cycle_key=cycle_key)
        threads = _thread_status_counts(c, cycle_key=cycle_key)
        hb = _heartbeat_map(c)
        targets = _stage_targets(
            c,
            space_rescan=store.confluence_space_rescan_seconds,
            space_claim_stale=store.confluence_space_claim_stale_seconds,
            devops_rescan=store.devops_rescan_seconds,
            devops_claim_stale=store.devops_claim_stale_seconds,
            thread_stale=store.confluence_report_thread_claim_stale_seconds,
            cycle_key=cycle_key,
        )
        findings = _one(c, "SELECT COUNT(*) FROM finding_lifecycle WHERE task_type='confluence'")
        finding_spaces = _one(
            c,
            "SELECT COUNT(DISTINCT CASE "
            "WHEN asset LIKE 'confluence:%:%' THEN split_part(asset, ':', 2) "
            "ELSE asset END) "
            "FROM finding_lifecycle WHERE task_type='confluence'",
        )
        space_stale_cutoff = now - store.confluence_space_claim_stale_seconds
        space_fresh_cutoff = now - store.confluence_space_rescan_seconds
        devops_stale_cutoff = now - store.devops_claim_stale_seconds
        devops_fresh_cutoff = now - store.devops_rescan_seconds
        space_queue = _one(
            c,
            "SELECT COUNT(*) FROM confluence_space_target "
            "WHERE cycle_key=? AND (status='pending' "
            "OR (status='in_progress' AND claimed_at IS NOT NULL AND claimed_at < ?) "
            "OR (status IN ('tasked','skipped','error') "
            "AND (cycle_scanned_at IS NULL OR last_scanned_at IS NULL OR last_scanned_at < ?))) "
            "AND (retry_after IS NULL OR retry_after <= ?)",
            (cycle_key, space_stale_cutoff, space_fresh_cutoff, now),
        )
        space_processing = _one(
            c,
            "SELECT COUNT(*) FROM confluence_space_target "
            "WHERE cycle_key=? AND status='in_progress' AND claimed_by=? AND claimed_at >= ?",
            (cycle_key, CONFLUENCE_SPACE_TASK_SESSION_ID, space_stale_cutoff),
        )
        space_stuck = _one(
            c,
            "SELECT COUNT(*) FROM confluence_space_target "
            "WHERE cycle_key=? AND status='in_progress' "
            "AND (claimed_at IS NULL OR claimed_at < ? OR COALESCE(claimed_by, -1)<>?)",
            (cycle_key, space_stale_cutoff, CONFLUENCE_SPACE_TASK_SESSION_ID),
        )
        sso_queue = _one(
            c,
            "SELECT COUNT(*) FROM devops_target WHERE service='confluence' "
            "AND cycle_key=? "
            "AND (status != 'in_progress' OR (claimed_at IS NOT NULL AND claimed_at < ?)) "
            "AND (cycle_scanned_at IS NULL OR last_task_at IS NULL OR last_task_at < ?) "
            "AND (retry_after IS NULL OR retry_after <= ?)",
            (cycle_key, devops_stale_cutoff, devops_fresh_cutoff, now),
        )
        sso_processing = _one(
            c,
            "SELECT COUNT(*) FROM devops_target WHERE service='confluence' "
            "AND cycle_key=? AND status='in_progress' AND claimed_by=? AND claimed_at >= ?",
            (cycle_key, CONFLUENCE_SSO_TASK_SESSION_ID, devops_stale_cutoff),
        )
        sso_stuck = _one(
            c,
            "SELECT COUNT(*) FROM devops_target WHERE service='confluence' "
            "AND cycle_key=? AND status='in_progress' "
            "AND (claimed_at IS NULL OR claimed_at < ? OR COALESCE(claimed_by, -1)<>?)",
            (cycle_key, devops_stale_cutoff, CONFLUENCE_SSO_TASK_SESSION_ID),
        )
        report_queue = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread WHERE status='reported' "
            "AND TRIM(COALESCE(owner_recipient, ''))<>'' "
            "AND last_cycle_key=? AND (retry_after IS NULL OR retry_after <= ?) "
            "AND (claimed_at IS NULL OR claimed_at < ?)",
            (cycle_key, now, stale_thread),
        )
        report_processing = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread WHERE status='reported' "
            "AND TRIM(COALESCE(owner_recipient, ''))<>'' "
            "AND last_cycle_key=? AND claimed_by=? AND claimed_at >= ?",
            (cycle_key, CONFLUENCE_REPORT_SESSION_ID, stale_thread),
        )
        report_stuck = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread WHERE status='reported' "
            "AND last_cycle_key=? AND claimed_at IS NOT NULL "
            "AND TRIM(COALESCE(owner_recipient, ''))<>'' "
            "AND (claimed_at < ? OR COALESCE(claimed_by, -1)<>?)",
            (cycle_key, stale_thread, CONFLUENCE_REPORT_SESSION_ID),
        )
        report_ready = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread "
            "WHERE status IN ('report_ready','awaiting_owner','recheck_requested',"
            "'rechecking','still_open','partially_remediated','remediated',"
            "'exception_review','owner_update_needed','owner_reassignment_review',"
            "'reassigned','escalated','closed') AND last_cycle_key=?",
            (cycle_key,),
        )
        owner_total = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread "
            f"WHERE status IN ({','.join('?' for _ in _CONFLUENCE_OWNER_SCOPE_STATUSES)}) "
            "AND last_cycle_key=?",
            (*_CONFLUENCE_OWNER_SCOPE_STATUSES, cycle_key),
        )
        owner_ready = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread "
            f"WHERE status IN ({','.join('?' for _ in _CONFLUENCE_OWNER_SCOPE_STATUSES)}) "
            "AND last_cycle_key=? AND TRIM(COALESCE(owner_recipient, ''))<>''",
            (*_CONFLUENCE_OWNER_SCOPE_STATUSES, cycle_key),
        )
        owner_missing = max(0, owner_total - owner_ready)
        owner_delivery_only = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread "
            f"WHERE status IN ({','.join('?' for _ in _CONFLUENCE_OWNER_SCOPE_STATUSES)}) "
            "AND last_cycle_key=? AND TRIM(COALESCE(owner_recipient, ''))='' "
            "AND TRIM(COALESCE(recipient, ''))<>''",
            (*_CONFLUENCE_OWNER_SCOPE_STATUSES, cycle_key),
        )
        reply_waiting = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread "
            "WHERE status='awaiting_owner' AND last_cycle_key=? "
            "AND (retry_after IS NULL OR retry_after <= ?) "
            "AND (claimed_at IS NULL OR claimed_at < ?)",
            (cycle_key, now, stale_thread),
        )
        reply_processing = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread "
            "WHERE status='awaiting_owner' AND last_cycle_key=? "
            "AND claimed_by=? AND claimed_at >= ?",
            (cycle_key, CONFLUENCE_RECHECK_SESSION_ID, stale_thread),
        )
        reply_stuck = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread "
            "WHERE status='awaiting_owner' AND last_cycle_key=? "
            "AND claimed_at IS NOT NULL "
            "AND (claimed_at < ? OR COALESCE(claimed_by, -1)<>?)",
            (cycle_key, stale_thread, CONFLUENCE_RECHECK_SESSION_ID),
        )
        reply_seen_statuses = tuple(s for s in _CONFLUENCE_REPLY_SEEN_STATUSES if s != "recheck_requested")
        reply_seen = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread "
            "WHERE ((status='recheck_requested' "
            "AND (claimed_at IS NULL OR claimed_at < ? OR claimed_by<>?)) "
            f"OR status IN ({','.join('?' for _ in reply_seen_statuses)})) "
            "AND last_cycle_key=?",
            (stale_thread, CONFLUENCE_RECHECK_SESSION_ID, *reply_seen_statuses, cycle_key),
        )
        recheck_queue = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread WHERE status='recheck_requested' "
            "AND (retry_after IS NULL OR retry_after <= ?) "
            "AND last_cycle_key=? AND (claimed_at IS NULL OR claimed_at < ?)",
            (now, cycle_key, stale_thread),
        )
        recheck_processing = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread WHERE last_cycle_key=? AND ("
            "(status='recheck_requested' AND claimed_by=? AND claimed_at >= ?) "
            "OR (status='rechecking' AND claimed_by=? AND claimed_at >= ?)"
            ")",
            (
                cycle_key,
                CONFLUENCE_RECHECK_SESSION_ID,
                stale_thread,
                CONFLUENCE_RECHECK_SESSION_ID,
                stale_thread,
            ),
        )
        recheck_stuck = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread WHERE last_cycle_key=? AND ("
            "(status='recheck_requested' AND claimed_at IS NOT NULL "
            "AND (claimed_at < ? OR COALESCE(claimed_by, -1)<>?)) "
            "OR (status='rechecking' AND "
            "(claimed_at IS NULL OR claimed_at < ? OR COALESCE(claimed_by, -1)<>?))"
            ")",
            (
                cycle_key,
                stale_thread,
                CONFLUENCE_RECHECK_SESSION_ID,
                stale_thread,
                CONFLUENCE_RECHECK_SESSION_ID,
            ),
        )
        remediated = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread "
            "WHERE status='remediated' AND last_cycle_key=?",
            (cycle_key,),
        )
        still_open = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread "
            "WHERE status='still_open' AND last_cycle_key=?",
            (cycle_key,),
        )
        partial = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread "
            "WHERE status='partially_remediated' AND last_cycle_key=?",
            (cycle_key,),
        )
        exception_review = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread WHERE status IN ("
            "'exception_review','owner_update_needed','owner_reassignment_review','reassigned') "
            "AND last_cycle_key=?",
            (cycle_key,),
        )
        escalated = _one(
            c,
            "SELECT COUNT(*) FROM confluence_report_thread "
            "WHERE status='escalated' AND last_cycle_key=?",
            (cycle_key,),
        )

    def st(comp: str) -> str:
        h = hb.get(comp)
        if h and h["alive"] and h["phase"] not in (None, "idle", "poll", "disabled"):
            return "active"
        if h and h["alive"]:
            return "idle"
        return "waiting"

    stages = [
        {
            "key": "space_discovery",
            "label": "① Space Discovery",
            "owner": "run_confluence_space_discovery",
            "status": st(COMPONENT_CONFLUENCE_SPACE_DISCOVERY),
            "queue": spaces["never_scanned"],
            "processing_count": 0,
            "done": spaces["scanned"],
            "metrics": [
                {"label": "등록 space", "value": spaces["total"], "unit": "개"},
                {"label": "미검사 space", "value": spaces["never_scanned"], "unit": "개"},
                {"label": "검사 이력 space", "value": spaces["scanned"], "unit": "개"},
            ],
        },
        {
            "key": "space_task",
            "label": "② API Space Task",
            "owner": "confluence_task worker",
            "status": st(COMPONENT_CONFLUENCE_SPACE_TASK),
            "queue": space_queue,
            "processing_count": space_processing,
            "stuck_count": space_stuck,
            "done": spaces["tasked"] + spaces["skipped"],
            "metrics": [
                {"label": "대기 space", "value": space_queue, "unit": "개"},
                {"label": "처리중 space", "value": space_processing, "unit": "개"},
                {"label": "멈춘 claim", "value": space_stuck, "unit": "개"},
                {"label": "완료 space", "value": spaces["tasked"], "unit": "개"},
                {"label": "스킵 space", "value": spaces["skipped"], "unit": "개"},
                {"label": "오류 space", "value": spaces["error"], "unit": "개"},
            ],
        },
        {
            "key": "sso_discovery",
            "label": "③ SSO URL Discovery",
            "owner": "run_devops_discovery",
            "status": st(COMPONENT_CONFLUENCE_SSO_DISCOVERY),
            "queue": sso["never_scanned"],
            "processing_count": 0,
            "done": sso["scanned"],
            "metrics": [
                {"label": "등록 URL", "value": sso["total"], "unit": "개"},
                {"label": "미검사 URL", "value": sso["never_scanned"], "unit": "개"},
                {"label": "검사 이력 URL", "value": sso["scanned"], "unit": "개"},
            ],
        },
        {
            "key": "sso_task",
            "label": "④ Browser SSO Task",
            "owner": "confluence_task worker",
            "status": st(COMPONENT_CONFLUENCE_SSO_TASK),
            "queue": sso_queue,
            "processing_count": sso_processing,
            "stuck_count": sso_stuck,
            "done": sso["tasked"] + sso["skipped"],
            "metrics": [
                {"label": "대기 URL", "value": sso_queue, "unit": "개"},
                {"label": "처리중 URL", "value": sso_processing, "unit": "개"},
                {"label": "멈춘 claim", "value": sso_stuck, "unit": "개"},
                {"label": "완료 URL", "value": sso["tasked"], "unit": "개"},
                {"label": "스킵 URL", "value": sso["skipped"], "unit": "개"},
                {"label": "오류 URL", "value": sso["error"], "unit": "개"},
            ],
        },
        {
            "key": "owner",
            "label": "⑤ Owner Resolve",
            "owner": "confluence_report sync",
            "status": st(COMPONENT_CONFLUENCE_REPORT),
            "queue": owner_missing,
            "processing_count": 0,
            "done": owner_ready,
            "metrics": [
                {"label": "담당자 대상", "value": owner_total, "unit": "space"},
                {"label": "담당자 후보 있음", "value": owner_ready, "unit": "space"},
                {"label": "담당자 후보 없음", "value": owner_missing, "unit": "space"},
                {"label": "발송 수신자만 있음", "value": owner_delivery_only, "unit": "space"},
            ],
        },
        {
            "key": "report",
            "label": "⑥ Space Report",
            "owner": "confluence_report worker",
            "status": st(COMPONENT_CONFLUENCE_REPORT),
            "queue": report_queue,
            "processing_count": report_processing,
            "stuck_count": report_stuck,
            "done": report_ready,
            "metrics": [
                {"label": "Confluence finding", "value": findings, "unit": "건"},
                {"label": "영향 space", "value": finding_spaces, "unit": "개"},
                {"label": "리포트 대기", "value": report_queue, "unit": "space"},
                {"label": "리포트 처리중", "value": report_processing, "unit": "space"},
                {"label": "멈춘 claim", "value": report_stuck, "unit": "space"},
                {"label": "리포트 작성", "value": report_ready, "unit": "space"},
            ],
        },
        {
            "key": "reply",
            "label": "⑦ Reply Intake",
            "owner": "POP3 reply collector",
            "status": st(COMPONENT_CONFLUENCE_RECHECK),
            "queue": reply_waiting,
            "processing_count": reply_processing,
            "stuck_count": reply_stuck,
            "done": reply_seen,
            "metrics": [
                {"label": "답장 대기", "value": reply_waiting, "unit": "space"},
                {"label": "답장 처리중", "value": reply_processing, "unit": "space"},
                {"label": "멈춘 claim", "value": reply_stuck, "unit": "space"},
                {"label": "답장 수신", "value": reply_seen, "unit": "space"},
            ],
        },
        {
            "key": "recheck",
            "label": "⑧ Remediation Recheck",
            "owner": "confluence_recheck worker",
            "status": st(COMPONENT_CONFLUENCE_RECHECK),
            "queue": recheck_queue,
            "processing_count": recheck_processing,
            "stuck_count": recheck_stuck,
            "done": remediated + still_open + partial + exception_review,
            "metrics": [
                {"label": "재검증 대기", "value": recheck_queue, "unit": "space"},
                {"label": "재검증 중", "value": recheck_processing, "unit": "space"},
                {"label": "멈춘 claim", "value": recheck_stuck, "unit": "space"},
                {"label": "조치 확인", "value": remediated, "unit": "space"},
                {"label": "잔존 노출", "value": still_open, "unit": "space"},
                {"label": "부분 조치", "value": partial, "unit": "space"},
                {"label": "HITL 검토", "value": exception_review, "unit": "space"},
            ],
        },
        {
            "key": "done",
            "label": "⑨ Closed",
            "owner": "-",
            "status": "idle",
            "queue": 0,
            "processing_count": 0,
            "done": remediated,
            "metrics": [
                {"label": "조치 완료", "value": remediated, "unit": "space"},
                {"label": "부분 조치", "value": partial, "unit": "space"},
                {"label": "HITL 검토", "value": exception_review, "unit": "space"},
                {"label": "에스컬레이션", "value": escalated, "unit": "space"},
            ],
        },
    ]

    control_by_stage = {
        "space_discovery": COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
        "space_task": COMPONENT_CONFLUENCE_SPACE_TASK,
        "sso_discovery": COMPONENT_CONFLUENCE_SSO_DISCOVERY,
        "sso_task": COMPONENT_CONFLUENCE_SSO_TASK,
        "owner": COMPONENT_CONFLUENCE_REPORT,
        "report": COMPONENT_CONFLUENCE_REPORT,
        "reply": COMPONENT_CONFLUENCE_RECHECK,
        "recheck": COMPONENT_CONFLUENCE_RECHECK,
    }
    phase_by_stage = {
        "space_discovery": PHASE_CONFLUENCE_SPACE_DISCOVERY,
        "space_task": PHASE_CONFLUENCE_SPACE_TASK,
        "sso_discovery": PHASE_CONFLUENCE_SSO_DISCOVERY,
        "sso_task": PHASE_CONFLUENCE_SSO_TASK,
        "owner": PHASE_CONFLUENCE_REPORT,
        "report": PHASE_CONFLUENCE_REPORT,
        "reply": PHASE_CONFLUENCE_RECHECK,
        "recheck": PHASE_CONFLUENCE_RECHECK,
    }
    for stage in stages:
        key = stage["key"]
        component = control_by_stage.get(key)
        stage["control_key"] = component
        stage["node_enabled"] = bool(int(store.control_flag_get(component)["enabled"])) if component else None
        stage["proc"] = component
        stage["proc_alive"] = bool(hb.get(component, {}).get("alive")) if component else False
        stage["proc_phase"] = hb.get(component, {}).get("phase") if component else None
        stage["targets"] = targets.get(key, {"active": [], "next": []})
        stage["processing"] = int(stage.pop("processing_count", len(stage["targets"].get("active", []))) or 0)
        stage["stuck"] = int(stage.pop("stuck_count", 0) or 0)
        if stage["node_enabled"] is False:
            stage["status"] = "waiting"
        elif stage["stuck"] > 0 and stage["processing"] == 0:
            stage["status"] = "waiting"
        elif stage["processing"] > 0:
            stage["status"] = "active"
        elif component and stage["proc_alive"]:
            stage["status"] = "active" if stage["proc_phase"] == phase_by_stage.get(key) else "idle"

    components = (
        COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
        COMPONENT_CONFLUENCE_SPACE_TASK,
        COMPONENT_CONFLUENCE_SSO_DISCOVERY,
        COMPONENT_CONFLUENCE_SSO_TASK,
        COMPONENT_CONFLUENCE_REPORT,
        COMPONENT_CONFLUENCE_RECHECK,
    )
    return {
        "kind": "confluence_pipeline_overview",
        "generated_at": time.time(),
        "cycle_key": cycle_key,
        "live": live,
        "stages": stages,
        "space_status_counts": spaces,
        "sso_status_counts": sso,
        "report_thread_status_counts": threads,
        "findings_total": findings,
        "heartbeats": {k: v for k, v in hb.items() if k in components},
        "heartbeat": hb,
        "control": {comp: store.control_flag_get(comp) for comp in components},
        "recent_runs": {comp: store.pipeline_runs_recent(comp, limit=3) for comp in components},
    }
