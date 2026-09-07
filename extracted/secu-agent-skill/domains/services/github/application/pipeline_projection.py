"""GitHub E2E pipeline read-model projection."""
from __future__ import annotations

import time
from typing import Any

from domains.services.github.application.contracts import (
    COMPONENT_GITHUB_DISCOVERY,
    COMPONENT_GITHUB_RECHECK,
    COMPONENT_GITHUB_REPORT,
    COMPONENT_GITHUB_SCAN,
    COMPONENT_GITHUB_SSO_DISCOVERY,
    COMPONENT_GITHUB_SSO_TASK,
    GITHUB_RECHECK_SESSION_ID,
    GITHUB_REPORT_SESSION_ID,
    GITHUB_SCAN_SESSION_ID,
    GITHUB_SSO_TASK_SESSION_ID,
    PHASE_GITHUB_DISCOVERY,
    PHASE_GITHUB_RECHECK,
    PHASE_GITHUB_REPORT,
    PHASE_GITHUB_SCAN,
    PHASE_GITHUB_SSO_DISCOVERY,
    PHASE_GITHUB_SSO_TASK,
)

_GITHUB_HITL_STATUSES = (
    "exception_review", "owner_update_needed", "owner_reassignment_review", "reassigned",
)
_GITHUB_REPLY_SEEN_STATUSES = (
    "recheck_requested", "rechecking", "still_open", "partially_remediated",
    *_GITHUB_HITL_STATUSES, "remediated", "escalated", "closed",
)
_GITHUB_REPORT_DONE_STATUSES = (
    "report_ready", "awaiting_owner", "recheck_requested", "rechecking",
    "partially_remediated", "still_open", *_GITHUB_HITL_STATUSES,
    "remediated", "escalated", "closed",
)
_GITHUB_OWNER_SCOPE_STATUSES = (
    "reported", "report_ready", "awaiting_owner", "recheck_requested", "rechecking",
    "still_open", "partially_remediated", *_GITHUB_HITL_STATUSES, "escalated", "error",
)


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


def _one(c, q: str, args=()) -> int:
    r = c.execute(q, args).fetchone()
    return int(r[0]) if r and r[0] is not None else 0


def _status_counts(c, table: str, *, where: str = "", args=()) -> dict[str, int]:
    suffix = f" WHERE {where}" if where else ""
    rows = c.execute(
        f"SELECT status, COUNT(*) AS n FROM {table}{suffix} GROUP BY status",
        args,
    ).fetchall()
    return {r["status"]: int(r["n"]) for r in rows}


def _sso_status_counts(c, *, cycle_key: str) -> dict[str, int]:
    out = {s: 0 for s in ("pending", "in_progress", "tasked", "skipped", "error")}
    out.update(
        _status_counts(
            c,
            "devops_target",
            where="service='github' AND cycle_key=?",
            args=(cycle_key,),
        )
    )
    out["total"] = sum(out.values())
    out["never_scanned"] = _one(
        c,
        "SELECT COUNT(*) FROM devops_target "
        "WHERE service='github' AND cycle_key=? AND cycle_scanned_at IS NULL",
        (cycle_key,),
    )
    out["scanned"] = _one(
        c,
        "SELECT COUNT(*) FROM devops_target "
        "WHERE service='github' AND cycle_key=? AND cycle_scanned_at IS NOT NULL",
        (cycle_key,),
    )
    return out


def _repo_targets(c, q: str, args=()) -> list[dict[str, str]]:
    return [
        {
            "label": str(r["repo"]),
            "component": "github.scan",
            "session_ref": f"repo-{int(r['id'])}",
        }
        for r in c.execute(q, args).fetchall()
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
            "WHERE service='github' AND cycle_key=? "
            "AND status='in_progress' AND claimed_by=? "
            "AND claimed_at >= ? "
            "ORDER BY claimed_at ASC, id ASC LIMIT 10",
            (cycle_key, GITHUB_SSO_TASK_SESSION_ID, stale_cutoff),
        ).fetchall()
    elif mode == "stuck":
        rows = c.execute(
            "SELECT id, url FROM devops_target "
            "WHERE service='github' AND cycle_key=? AND status='in_progress' "
            "AND (claimed_at IS NULL OR claimed_at < ? OR COALESCE(claimed_by, -1)<>?) "
            "ORDER BY COALESCE(claimed_at, 0) ASC, id ASC LIMIT 10",
            (cycle_key, stale_cutoff, GITHUB_SSO_TASK_SESSION_ID),
        ).fetchall()
    else:
        rows = c.execute(
            "SELECT id, url FROM devops_target "
            "WHERE service='github' AND cycle_key=? "
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
            "component": COMPONENT_GITHUB_SSO_TASK,
            "session_ref": f"devops-{int(r['id'])}",
        }
        for r in rows
    ]


def _thread_targets(c, q: str, args=(), *, component: str) -> list[dict[str, str]]:
    return [
        {
            "label": str(r["repo"]),
            "component": component,
            "session_ref": f"github-thread-{int(r['id'])}",
        }
        for r in c.execute(q, args).fetchall()
    ]


def _stage_targets(
    c,
    *,
    repo_claim_stale: float,
    repo_rescan: float,
    devops_rescan: float,
    devops_claim_stale: float,
    thread_stale: float,
    cycle_key: str,
) -> dict[str, dict[str, list[Any]]]:
    now = time.time()
    due = now - repo_rescan
    stale_repo = now - repo_claim_stale
    stale_thread = now - thread_stale
    return {
        "discover": {
            "active": _repo_targets(
                c,
                "SELECT id, repo FROM github_repo_target WHERE last_seen >= ? "
                "ORDER BY last_seen DESC LIMIT 10",
                (now - 900,),
            ),
            "next": [],
        },
        "scan": {
            "active": _repo_targets(
                c,
                "SELECT id, repo FROM github_repo_target "
                "WHERE cycle_key=? AND status='in_progress' AND claimed_by=? "
                "AND claimed_at >= ? "
                "ORDER BY claimed_at ASC LIMIT 10",
                (cycle_key, GITHUB_SCAN_SESSION_ID, stale_repo),
            ),
            "next": _repo_targets(
                c,
                "SELECT id, repo FROM github_repo_target "
                "WHERE cycle_key=? "
                "AND (status!='in_progress' OR (claimed_at IS NOT NULL AND claimed_at < ?)) "
                "AND (cycle_scanned_at IS NULL OR last_scanned_at IS NULL OR last_scanned_at < ?) "
                "AND (retry_after IS NULL OR retry_after <= ?) "
                "ORDER BY (cycle_scanned_at IS NULL) DESC, "
                "(last_scanned_at IS NULL) DESC, last_scanned_at ASC, id ASC LIMIT 10",
                (cycle_key, stale_repo, due, now),
            ),
            "stuck": _repo_targets(
                c,
                "SELECT id, repo FROM github_repo_target "
                "WHERE cycle_key=? AND status='in_progress' "
                "AND (claimed_at IS NULL OR claimed_at < ? OR COALESCE(claimed_by, -1)<>?) "
                "ORDER BY COALESCE(claimed_at, 0) ASC, id ASC LIMIT 10",
                (cycle_key, stale_repo, GITHUB_SCAN_SESSION_ID),
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
                "SELECT id, repo FROM github_report_thread "
                f"WHERE status IN ({','.join('?' for _ in _GITHUB_OWNER_SCOPE_STATUSES)}) "
                "AND last_cycle_key=? AND TRIM(COALESCE(owner_recipient, ''))='' "
                "ORDER BY updated_at ASC LIMIT 10",
                (*_GITHUB_OWNER_SCOPE_STATUSES, cycle_key),
                component="github.report",
            ),
        },
        "report": {
            "active": _thread_targets(
                c,
                "SELECT id, repo FROM github_report_thread "
                "WHERE status='reported' AND last_cycle_key=? "
                "AND TRIM(COALESCE(owner_recipient, ''))<>'' "
                "AND claimed_by=? AND claimed_at >= ? "
                "ORDER BY claimed_at ASC LIMIT 10",
                (cycle_key, GITHUB_REPORT_SESSION_ID, stale_thread),
                component="github.report",
            ),
            "next": _thread_targets(
                c,
                "SELECT id, repo FROM github_report_thread "
                "WHERE status='reported' AND last_cycle_key=? "
                "AND TRIM(COALESCE(owner_recipient, ''))<>'' "
                "AND (retry_after IS NULL OR retry_after <= ?) "
                "AND (claimed_at IS NULL OR claimed_at < ?) "
                "ORDER BY updated_at ASC LIMIT 10",
                (cycle_key, now, stale_thread),
                component="github.report",
            ),
            "stuck": _thread_targets(
                c,
                "SELECT id, repo FROM github_report_thread "
                "WHERE status='reported' AND last_cycle_key=? AND claimed_at IS NOT NULL "
                "AND TRIM(COALESCE(owner_recipient, ''))<>'' "
                "AND (claimed_at < ? OR COALESCE(claimed_by, -1)<>?) "
                "ORDER BY claimed_at ASC, id ASC LIMIT 10",
                (cycle_key, stale_thread, GITHUB_REPORT_SESSION_ID),
                component="github.report",
            ),
        },
        "reply": {
            "active": _thread_targets(
                c,
                "SELECT id, repo FROM github_report_thread "
                "WHERE status='awaiting_owner' AND last_cycle_key=? "
                "AND claimed_by=? AND claimed_at >= ? "
                "ORDER BY claimed_at ASC, id ASC LIMIT 10",
                (cycle_key, GITHUB_RECHECK_SESSION_ID, stale_thread),
                component="github.recheck",
            ),
            "next": _thread_targets(
                c,
                "SELECT id, repo FROM github_report_thread "
                "WHERE status='awaiting_owner' AND last_cycle_key=? "
                "AND (retry_after IS NULL OR retry_after <= ?) "
                "AND (claimed_at IS NULL OR claimed_at < ?) "
                "ORDER BY COALESCE(notified_at, updated_at) ASC, id ASC LIMIT 10",
                (cycle_key, now, stale_thread),
                component="github.recheck",
            ),
            "stuck": _thread_targets(
                c,
                "SELECT id, repo FROM github_report_thread "
                "WHERE status='awaiting_owner' AND last_cycle_key=? "
                "AND claimed_at IS NOT NULL "
                "AND (claimed_at < ? OR COALESCE(claimed_by, -1)<>?) "
                "ORDER BY COALESCE(claimed_at, 0) ASC, id ASC LIMIT 10",
                (cycle_key, stale_thread, GITHUB_RECHECK_SESSION_ID),
                component="github.recheck",
            ),
        },
        "recheck": {
            "active": _thread_targets(
                c,
                "SELECT id, repo FROM github_report_thread "
                "WHERE last_cycle_key=? AND ("
                "(status='recheck_requested' AND claimed_by=? AND claimed_at >= ?) "
                "OR (status='rechecking' AND claimed_by=? AND claimed_at >= ?)"
                ") ORDER BY claimed_at ASC, id ASC LIMIT 10",
                (
                    cycle_key,
                    GITHUB_RECHECK_SESSION_ID,
                    stale_thread,
                    GITHUB_RECHECK_SESSION_ID,
                    stale_thread,
                ),
                component="github.recheck",
            ),
            "next": _thread_targets(
                c,
                "SELECT id, repo FROM github_report_thread "
                "WHERE status='recheck_requested' AND last_cycle_key=? "
                "AND (retry_after IS NULL OR retry_after <= ?) "
                "AND (claimed_at IS NULL OR claimed_at < ?) "
                "ORDER BY updated_at ASC LIMIT 10",
                (cycle_key, now, stale_thread),
                component="github.recheck",
            ),
            "stuck": _thread_targets(
                c,
                "SELECT id, repo FROM github_report_thread "
                "WHERE last_cycle_key=? AND ("
                "(status='recheck_requested' AND claimed_at IS NOT NULL "
                "AND (claimed_at < ? OR COALESCE(claimed_by, -1)<>?)) "
                "OR (status='rechecking' AND "
                "(claimed_at IS NULL OR claimed_at < ? OR COALESCE(claimed_by, -1)<>?))"
                ") ORDER BY COALESCE(claimed_at, 0) ASC, id ASC LIMIT 10",
                (
                    cycle_key,
                    stale_thread,
                    GITHUB_RECHECK_SESSION_ID,
                    stale_thread,
                    GITHUB_RECHECK_SESSION_ID,
                ),
                component="github.recheck",
            ),
        },
        "done": {
            "active": [],
            "next": _thread_targets(
                c,
                "SELECT id, repo FROM github_report_thread "
                "WHERE status IN ('remediated','closed') AND last_cycle_key=? "
                "ORDER BY updated_at DESC LIMIT 8",
                (cycle_key,),
                component="github.recheck",
            ),
        },
    }


def github_pipeline_overview(*, store: Any, live: bool = False) -> dict[str, Any]:
    ensure_cycle = getattr(store, "ensure_repo_cycle_current", None)
    if callable(ensure_cycle):
        ensure_cycle()
    ensure_sso_cycle = getattr(store, "ensure_sso_cycle_current", None)
    if callable(ensure_sso_cycle):
        ensure_sso_cycle()
    with store.connect() as c:
        now = time.time()
        cycle_key = store.current_cycle_key()
        due_cutoff = now - store.github_repo_rescan_seconds
        stale_repo = now - store.github_repo_claim_stale_seconds
        stale_thread = now - store.github_report_thread_claim_stale_seconds
        devops_stale_cutoff = now - store.devops_claim_stale_seconds
        devops_fresh_cutoff = now - store.devops_rescan_seconds
        hb = _heartbeat_map(c)
        repo_counts = _status_counts(
            c,
            "github_repo_target",
            where="cycle_key=?",
            args=(cycle_key,),
        )
        sso_counts = _sso_status_counts(c, cycle_key=cycle_key)
        thread_counts = _status_counts(
            c,
            "github_report_thread",
            where="last_cycle_key=?",
            args=(cycle_key,),
        )
        targets = _stage_targets(
            c,
            repo_claim_stale=store.github_repo_claim_stale_seconds,
            repo_rescan=store.github_repo_rescan_seconds,
            devops_rescan=store.devops_rescan_seconds,
            devops_claim_stale=store.devops_claim_stale_seconds,
            thread_stale=store.github_report_thread_claim_stale_seconds,
            cycle_key=cycle_key,
        )

        repo_total = _one(c, "SELECT COUNT(*) FROM github_repo_target WHERE cycle_key=?", (cycle_key,))
        never_scanned = _one(
            c,
            "SELECT COUNT(*) FROM github_repo_target "
            "WHERE cycle_key=? AND cycle_scanned_at IS NULL",
            (cycle_key,),
        )
        due_repos = _one(
            c,
            "SELECT COUNT(*) FROM github_repo_target "
            "WHERE cycle_key=? "
            "AND (status!='in_progress' OR (claimed_at IS NOT NULL AND claimed_at < ?)) "
            "AND (cycle_scanned_at IS NULL OR last_scanned_at IS NULL OR last_scanned_at < ?) "
            "AND (retry_after IS NULL OR retry_after <= ?)",
            (cycle_key, stale_repo, due_cutoff, now),
        )
        scan_processing = _one(
            c,
            "SELECT COUNT(*) FROM github_repo_target WHERE cycle_key=? AND status='in_progress' "
            "AND claimed_by=? AND claimed_at >= ?",
            (cycle_key, GITHUB_SCAN_SESSION_ID, stale_repo),
        )
        scan_stuck = _one(
            c,
            "SELECT COUNT(*) FROM github_repo_target WHERE cycle_key=? AND status='in_progress' "
            "AND (claimed_at IS NULL OR claimed_at < ? OR COALESCE(claimed_by, -1)<>?)",
            (cycle_key, stale_repo, GITHUB_SCAN_SESSION_ID),
        )
        scanned = _one(
            c,
            "SELECT COUNT(*) FROM github_repo_target "
            "WHERE cycle_key=? AND cycle_scanned_at IS NOT NULL",
            (cycle_key,),
        )
        skipped_or_error = _one(
            c,
            "SELECT COUNT(*) FROM github_repo_target "
            "WHERE cycle_key=? AND status IN ('skipped','error')",
            (cycle_key,),
        )
        sso_queue = _one(
            c,
            "SELECT COUNT(*) FROM devops_target WHERE service='github' "
            "AND cycle_key=? "
            "AND (status != 'in_progress' OR (claimed_at IS NOT NULL AND claimed_at < ?)) "
            "AND (cycle_scanned_at IS NULL OR last_task_at IS NULL OR last_task_at < ?) "
            "AND (retry_after IS NULL OR retry_after <= ?)",
            (cycle_key, devops_stale_cutoff, devops_fresh_cutoff, now),
        )
        sso_processing = _one(
            c,
            "SELECT COUNT(*) FROM devops_target WHERE service='github' "
            "AND cycle_key=? AND status='in_progress' AND claimed_by=? AND claimed_at >= ?",
            (cycle_key, GITHUB_SSO_TASK_SESSION_ID, devops_stale_cutoff),
        )
        sso_stuck = _one(
            c,
            "SELECT COUNT(*) FROM devops_target WHERE service='github' "
            "AND cycle_key=? AND status='in_progress' "
            "AND (claimed_at IS NULL OR claimed_at < ? OR COALESCE(claimed_by, -1)<>?)",
            (cycle_key, devops_stale_cutoff, GITHUB_SSO_TASK_SESSION_ID),
        )
        findings = _one(c, "SELECT COUNT(*) FROM finding_lifecycle WHERE task_type='github'")
        live_head = _one(
            c,
            "SELECT COUNT(*) FROM finding_lifecycle WHERE task_type='github' "
            "AND extra_json LIKE '%live_in_HEAD%'",
        )
        history_only = _one(
            c,
            "SELECT COUNT(*) FROM finding_lifecycle WHERE task_type='github' "
            "AND extra_json LIKE '%historical_only%'",
        )
        report_queue = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread WHERE status='reported' "
            "AND TRIM(COALESCE(owner_recipient, ''))<>'' "
            "AND last_cycle_key=? AND (retry_after IS NULL OR retry_after <= ?) "
            "AND (claimed_at IS NULL OR claimed_at < ?)",
            (cycle_key, now, stale_thread),
        )
        report_processing = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread WHERE status='reported' "
            "AND TRIM(COALESCE(owner_recipient, ''))<>'' "
            "AND last_cycle_key=? AND claimed_by=? AND claimed_at >= ?",
            (cycle_key, GITHUB_REPORT_SESSION_ID, stale_thread),
        )
        report_stuck = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread WHERE status='reported' "
            "AND last_cycle_key=? AND claimed_at IS NOT NULL "
            "AND TRIM(COALESCE(owner_recipient, ''))<>'' "
            "AND (claimed_at < ? OR COALESCE(claimed_by, -1)<>?)",
            (cycle_key, stale_thread, GITHUB_REPORT_SESSION_ID),
        )
        report_ready = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread "
            f"WHERE status IN ({','.join('?' for _ in _GITHUB_REPORT_DONE_STATUSES)}) "
            "AND last_cycle_key=?",
            (*_GITHUB_REPORT_DONE_STATUSES, cycle_key),
        )
        owner_total = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread "
            f"WHERE status IN ({','.join('?' for _ in _GITHUB_OWNER_SCOPE_STATUSES)}) "
            "AND last_cycle_key=?",
            (*_GITHUB_OWNER_SCOPE_STATUSES, cycle_key),
        )
        owner_ready = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread "
            f"WHERE status IN ({','.join('?' for _ in _GITHUB_OWNER_SCOPE_STATUSES)}) "
            "AND last_cycle_key=? AND TRIM(COALESCE(owner_recipient, ''))<>''",
            (*_GITHUB_OWNER_SCOPE_STATUSES, cycle_key),
        )
        owner_missing = max(0, owner_total - owner_ready)
        owner_delivery_only = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread "
            f"WHERE status IN ({','.join('?' for _ in _GITHUB_OWNER_SCOPE_STATUSES)}) "
            "AND last_cycle_key=? AND TRIM(COALESCE(owner_recipient, ''))='' "
            "AND TRIM(COALESCE(recipient, ''))<>''",
            (*_GITHUB_OWNER_SCOPE_STATUSES, cycle_key),
        )
        reply_waiting = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread "
            "WHERE status='awaiting_owner' AND last_cycle_key=? "
            "AND (retry_after IS NULL OR retry_after <= ?) "
            "AND (claimed_at IS NULL OR claimed_at < ?)",
            (cycle_key, now, stale_thread),
        )
        reply_processing = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread "
            "WHERE status='awaiting_owner' AND last_cycle_key=? "
            "AND claimed_by=? AND claimed_at >= ?",
            (cycle_key, GITHUB_RECHECK_SESSION_ID, stale_thread),
        )
        reply_stuck = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread "
            "WHERE status='awaiting_owner' AND last_cycle_key=? "
            "AND claimed_at IS NOT NULL "
            "AND (claimed_at < ? OR COALESCE(claimed_by, -1)<>?)",
            (cycle_key, stale_thread, GITHUB_RECHECK_SESSION_ID),
        )
        reply_seen_statuses = tuple(s for s in _GITHUB_REPLY_SEEN_STATUSES if s != "recheck_requested")
        reply_seen = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread "
            "WHERE ((status='recheck_requested' "
            "AND (claimed_at IS NULL OR claimed_at < ? OR claimed_by<>?)) "
            f"OR status IN ({','.join('?' for _ in reply_seen_statuses)})) "
            "AND last_cycle_key=?",
            (stale_thread, GITHUB_RECHECK_SESSION_ID, *reply_seen_statuses, cycle_key),
        )
        recheck_queue = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread "
            "WHERE status='recheck_requested' AND last_cycle_key=? "
            "AND (retry_after IS NULL OR retry_after <= ?) "
            "AND (claimed_at IS NULL OR claimed_at < ?)",
            (cycle_key, now, stale_thread),
        )
        recheck_processing = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread WHERE last_cycle_key=? AND ("
            "(status='recheck_requested' AND claimed_by=? AND claimed_at >= ?) "
            "OR (status='rechecking' AND claimed_by=? AND claimed_at >= ?)"
            ")",
            (
                cycle_key,
                GITHUB_RECHECK_SESSION_ID,
                stale_thread,
                GITHUB_RECHECK_SESSION_ID,
                stale_thread,
            ),
        )
        recheck_stuck = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread WHERE last_cycle_key=? AND ("
            "(status='recheck_requested' AND claimed_at IS NOT NULL "
            "AND (claimed_at < ? OR COALESCE(claimed_by, -1)<>?)) "
            "OR (status='rechecking' AND "
            "(claimed_at IS NULL OR claimed_at < ? OR COALESCE(claimed_by, -1)<>?))"
            ")",
            (
                cycle_key,
                stale_thread,
                GITHUB_RECHECK_SESSION_ID,
                stale_thread,
                GITHUB_RECHECK_SESSION_ID,
            ),
        )
        partially_remediated = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread "
            "WHERE status='partially_remediated' AND last_cycle_key=?",
            (cycle_key,),
        )
        remediated = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread WHERE status='remediated' AND last_cycle_key=?",
            (cycle_key,),
        )
        still_open = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread WHERE status='still_open' AND last_cycle_key=?",
            (cycle_key,),
        )
        hitl = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread "
            f"WHERE status IN ({','.join('?' for _ in _GITHUB_HITL_STATUSES)}) "
            "AND last_cycle_key=?",
            (*_GITHUB_HITL_STATUSES, cycle_key),
        )
        escalated = _one(
            c,
            "SELECT COUNT(*) FROM github_report_thread WHERE status='escalated' AND last_cycle_key=?",
            (cycle_key,),
        )

    def st(component: str) -> str:
        h = hb.get(component)
        if h and h["alive"] and h["phase"] not in (None, "idle", "poll", "disabled"):
            return "active"
        if h and h["alive"]:
            return "idle"
        return "waiting"

    stages = [
        {
            "key": "discover",
            "label": "① Repo Discovery",
            "owner": "GitHub collector",
            "icon": "GH",
            "status": st(COMPONENT_GITHUB_DISCOVERY),
            "queue": 0,
            "processing_count": len(targets["discover"]["active"]),
            "done": repo_total,
            "metrics": [
                {"label": "큐 전체 repo", "value": repo_total, "unit": "개"},
                {"label": "미스캔 repo", "value": never_scanned, "unit": "개"},
                {"label": "스캔 완료 repo", "value": scanned, "unit": "개"},
            ],
        },
        {
            "key": "scan",
            "label": "② Secret Scan",
            "owner": "GitHub scan agent",
            "icon": "SCAN",
            "status": st(COMPONENT_GITHUB_SCAN),
            "queue": due_repos,
            "processing_count": scan_processing,
            "stuck_count": scan_stuck,
            "done": scanned,
            "metrics": [
                {"label": "스캔 대기 repo", "value": due_repos, "unit": "개"},
                {"label": "스캔 중 repo", "value": scan_processing, "unit": "개"},
                {"label": "멈춘 claim", "value": scan_stuck, "unit": "개"},
                {"label": "스캔 실패/제외", "value": skipped_or_error, "unit": "개"},
                {"label": "GitHub finding", "value": findings, "unit": "건"},
                {"label": "HEAD live", "value": live_head, "unit": "건"},
                {"label": "history only", "value": history_only, "unit": "건"},
            ],
        },
        {
            "key": "sso_discovery",
            "label": "③ SSO URL Discovery",
            "owner": "GitHub SSO discovery",
            "icon": "SSO",
            "status": st(COMPONENT_GITHUB_SSO_DISCOVERY),
            "queue": 0,
            "processing_count": len(targets["sso_discovery"]["active"]),
            "done": sso_counts["total"],
            "metrics": [
                {"label": "SSO URL 전체", "value": sso_counts["total"], "unit": "개"},
                {"label": "미점검 URL", "value": sso_counts["never_scanned"], "unit": "개"},
                {"label": "점검 완료 URL", "value": sso_counts["scanned"], "unit": "개"},
            ],
        },
        {
            "key": "sso_task",
            "label": "④ Browser/API SSO Task",
            "owner": "GitHub SSO task worker",
            "icon": "URL",
            "status": st(COMPONENT_GITHUB_SSO_TASK),
            "queue": sso_queue,
            "processing_count": sso_processing,
            "stuck_count": sso_stuck,
            "done": sso_counts["scanned"],
            "metrics": [
                {"label": "SSO 점검 대기", "value": sso_queue, "unit": "URL"},
                {"label": "SSO 점검 중", "value": sso_processing, "unit": "URL"},
                {"label": "멈춘 claim", "value": sso_stuck, "unit": "URL"},
                {"label": "SSO 실패/제외", "value": sso_counts["skipped"] + sso_counts["error"], "unit": "URL"},
            ],
        },
        {
            "key": "owner",
            "label": "⑤ Owner Resolve",
            "owner": "GitHub report sync",
            "icon": "OWN",
            "status": st(COMPONENT_GITHUB_REPORT),
            "queue": owner_missing,
            "processing_count": 0,
            "done": owner_ready,
            "metrics": [
                {"label": "담당자 대상 repo", "value": owner_total, "unit": "repo"},
                {"label": "담당자 후보 있음", "value": owner_ready, "unit": "repo"},
                {"label": "담당자 후보 없음", "value": owner_missing, "unit": "repo"},
                {"label": "발송 수신자만 있음", "value": owner_delivery_only, "unit": "repo"},
            ],
        },
        {
            "key": "report",
            "label": "⑥ Repo Report",
            "owner": "GitHub report agent",
            "icon": "RPT",
            "status": st(COMPONENT_GITHUB_REPORT),
            "queue": report_queue,
            "processing_count": report_processing,
            "stuck_count": report_stuck,
            "done": report_ready,
            "metrics": [
                {"label": "리포트 대기", "value": report_queue, "unit": "repo"},
                {"label": "리포트 처리중", "value": report_processing, "unit": "repo"},
                {"label": "멈춘 claim", "value": report_stuck, "unit": "repo"},
                {"label": "리포트 작성", "value": report_ready, "unit": "repo"},
            ],
        },
        {
            "key": "reply",
            "label": "⑦ Reply Intake",
            "owner": "POP3 reply collector",
            "icon": "MAIL",
            "status": st(COMPONENT_GITHUB_RECHECK),
            "queue": reply_waiting,
            "processing_count": reply_processing,
            "stuck_count": reply_stuck,
            "done": reply_seen,
            "metrics": [
                {"label": "답장 대기 repo", "value": reply_waiting, "unit": "repo"},
                {"label": "답장 처리중 repo", "value": reply_processing, "unit": "repo"},
                {"label": "멈춘 claim", "value": reply_stuck, "unit": "repo"},
                {"label": "답장 수신 repo", "value": reply_seen, "unit": "repo"},
            ],
        },
        {
            "key": "recheck",
            "label": "⑧ Remediation Recheck",
            "owner": "GitHub recheck agent",
            "icon": "RE",
            "status": st(COMPONENT_GITHUB_RECHECK),
            "queue": recheck_queue,
            "processing_count": recheck_processing,
            "stuck_count": recheck_stuck,
            "done": remediated + partially_remediated + still_open + hitl,
            "metrics": [
                {"label": "재검증 대기", "value": recheck_queue, "unit": "repo"},
                {"label": "재검증 중", "value": recheck_processing, "unit": "repo"},
                {"label": "멈춘 claim", "value": recheck_stuck, "unit": "repo"},
                {"label": "부분 조치", "value": partially_remediated, "unit": "repo"},
                {"label": "조치 확인", "value": remediated, "unit": "repo"},
                {"label": "잔존 노출", "value": still_open, "unit": "repo"},
                {"label": "HITL 검토", "value": hitl, "unit": "repo"},
            ],
        },
        {
            "key": "done",
            "label": "⑨ Closed",
            "owner": "-",
            "icon": "OK",
            "status": "idle",
            "queue": 0,
            "processing_count": 0,
            "done": remediated,
            "metrics": [
                {"label": "조치 완료 repo", "value": remediated, "unit": "개"},
                {"label": "부분 조치 repo", "value": partially_remediated, "unit": "개"},
                {"label": "잔존 노출 repo", "value": still_open, "unit": "개"},
                {"label": "에스컬레이션 repo", "value": escalated, "unit": "개"},
            ],
        },
    ]

    control_by_stage = {
        "discover": COMPONENT_GITHUB_DISCOVERY,
        "scan": COMPONENT_GITHUB_SCAN,
        "sso_discovery": COMPONENT_GITHUB_SSO_DISCOVERY,
        "sso_task": COMPONENT_GITHUB_SSO_TASK,
        "owner": COMPONENT_GITHUB_REPORT,
        "report": COMPONENT_GITHUB_REPORT,
        "reply": COMPONENT_GITHUB_RECHECK,
        "recheck": COMPONENT_GITHUB_RECHECK,
    }
    phase_by_stage = {
        "discover": PHASE_GITHUB_DISCOVERY,
        "scan": PHASE_GITHUB_SCAN,
        "sso_discovery": PHASE_GITHUB_SSO_DISCOVERY,
        "sso_task": PHASE_GITHUB_SSO_TASK,
        "owner": PHASE_GITHUB_REPORT,
        "report": PHASE_GITHUB_REPORT,
        "reply": PHASE_GITHUB_RECHECK,
        "recheck": PHASE_GITHUB_RECHECK,
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
        COMPONENT_GITHUB_DISCOVERY,
        COMPONENT_GITHUB_SCAN,
        COMPONENT_GITHUB_SSO_DISCOVERY,
        COMPONENT_GITHUB_SSO_TASK,
        COMPONENT_GITHUB_REPORT,
        COMPONENT_GITHUB_RECHECK,
    )
    return {
        "kind": "github_pipeline_overview",
        "generated_at": time.time(),
        "cycle_key": cycle_key,
        "live": live,
        "stages": stages,
        "repo_status_counts": repo_counts,
        "sso_status_counts": sso_counts,
        "report_thread_status_counts": thread_counts,
        "findings_total": findings,
        "heartbeats": {k: v for k, v in hb.items() if k in components},
        "control": {comp: store.control_flag_get(comp) for comp in components},
        "recent_runs": {comp: store.pipeline_runs_recent(comp, limit=3) for comp in components},
    }
