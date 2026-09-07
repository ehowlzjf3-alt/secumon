"""SMB Shares 서비스 — list (filter/q/page) + detail.

state.py 의 raw row를 UI 친화적인 nested shape로 변환.
"""
from __future__ import annotations

import json
from typing import Any

# v3.82 U3d: 도메인 테이블 접근은 service.state_domain 으로 (코어 state 미사용).
from service import state_domain
from service.services import severity as _sev

# smb_share.status 어휘의 **단일 소스**. `share_set_status` 는 검증을 안 하므로
# (임의 문자열이 들어간다) 이 집합이 사실상의 계약이다 — 웹 필터도, 리드
# `set_target_status` 의 닫힌 enum(domains/smb/plugin/lead_adapter.py)도 여기를 본다.
# 복사본을 만들면 한쪽만 갱신돼 리드가 유효한 상태를 거부하거나 오타를 통과시킨다.
SHARE_STATUSES: frozenset[str] = frozenset({
    "pending", "walked", "listing_reviewed", "in_progress",
    "triaged_completed", "triaged_errored", "closed", "ignored",
})

_VALID_STATUS = SHARE_STATUSES
_VALID_EXPOSURE = {
    "open", "public", "null", "guest", "auth", "writable",
    "print", "submitted", "hits",
}
# 공유 단위 어휘 — 정본 5단계 + "문제 없음"(none). 확장이지 다른 어휘가 아니다.
_VALID_SEVERITY = _sev.SHARE_LEVELS
_REPORT_READY_STATUSES = (
    "reported",
    "awaiting_reply",
    "reply_received",
    "reverifying",
    "re_requested",
    "partially_remediated",
    "exception_review",
    "owner_update_needed",
    "owner_reassignment_review",
    "reassigned",
    "remediated",
    "escalated",
    "closed",
)


def _json_dict(raw: Any) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _bool_or_none(v: Any) -> bool | None:
    if v is None:
        return None
    return bool(v)


def _shape(row: dict[str, Any]) -> dict[str, Any]:
    """raw share row → UI shape."""
    listing_review = _json_dict(row.get("listing_review")) or None
    modes = {
        "null": _bool_or_none(row.get("null_login_ok")),
        "guest": _bool_or_none(row.get("guest_login_ok")),
        "auth": _bool_or_none(row.get("auth_login_ok")),
    }
    rw = {
        "read": bool(row.get("share_read") or 0),
        "write": bool(row.get("share_write") or 0),
    }
    risk_flags: list[str] = []
    if row.get("excluded_reason") == "print":
        risk_flags.append("print_share")
    if row.get("excluded_reason") == "exception":
        risk_flags.append("exception_approved")
    if modes["null"] and rw["read"]:
        risk_flags.append("null_readable")
    if modes["guest"] and rw["read"]:
        risk_flags.append("guest_readable")
    if modes["auth"] and rw["read"]:
        risk_flags.append("auth_readable")
    if rw["write"]:
        risk_flags.append("share_writable")
    if int(row.get("confirmed_hits") or 0) > 0:
        risk_flags.append("confirmed_hits")
    elif int(row.get("file_with_hits") or 0) > 0:
        risk_flags.append("content_hits")
    if int(row.get("lifecycle_finding_total") or 0) > 0:
        risk_flags.append("submitted_finding")
    if row.get("severity"):
        risk_flags.append(f"review_{row['severity']}")

    return {
        "id": row["id"],
        "asset": f"smb://{row['host']}/{row['share']}",
        "host": row["host"],
        "share": row["share"],
        "subnet": row["subnet"],
        "status": row["status"],
        "modes": modes,
        "rw": rw,
        "counts": {
            "file_total": int(row.get("file_total") or 0),
            "file_with_hits": int(row.get("file_with_hits") or 0),
            "confirmed_hits": int(row.get("confirmed_hits") or 0),
            "lifecycle_findings": int(row.get("lifecycle_finding_total") or 0),
        },
        "risk_flags": risk_flags,
        "severity": row.get("severity"),
        "summary": row.get("summary"),
        "listing_review": listing_review,
        "cred_name": row.get("cred_name"),
        "excluded_reason": row.get("excluded_reason"),
        "excluded_at": row.get("excluded_at"),
        "exception": {
            "reason": row.get("exception_reason"),
            "thread_id": row.get("exception_thread_id"),
            "approved_by": row.get("exception_approved_by"),
            "approved_at": row.get("exception_at"),
        } if row.get("exception_at") or row.get("exception_reason") else None,
        "first_seen": row.get("first_seen"),
        "last_seen": row.get("last_seen"),
        "walk_done_at": row.get("walk_done_at"),
        "walk_file_count": int(row.get("walk_file_count") or 0),
        "processed_at": row.get("processed_at"),
        "listing_review_at": row.get("listing_review_at"),
    }


def _base_select() -> str:
    return (
        "SELECT s.*, c.name AS cred_name, "
        "  (SELECT COUNT(*) FROM smb_file f WHERE f.share_id=s.id) AS file_total, "
        "  (SELECT COUNT(*) FROM smb_file f WHERE f.share_id=s.id AND f.hits_count>0) AS file_with_hits, "
        "  (SELECT COUNT(*) FROM smb_file_hit h JOIN smb_file f ON f.id=h.file_id "
        "   WHERE f.share_id=s.id AND h.agent_verdict='confirmed') AS confirmed_hits, "
        "  (SELECT COUNT(*) FROM finding_lifecycle fl WHERE "
        "   fl.task_type='smb' AND fl.status!='false_positive' AND ("
        + _lifecycle_asset_match_sql()
        + "   )) AS lifecycle_finding_total "
        "FROM smb_share s LEFT JOIN smb_credential c ON c.id=s.auth_credential_id "
    )


def _open_sql() -> str:
    return (
        "(s.share_read=1 OR s.share_write=1 OR s.null_login_ok=1 "
        "OR s.guest_login_ok=1 OR s.auth_login_ok=1)"
    )


def _print_sql() -> str:
    return (
        "(s.excluded_reason='print' OR LOWER(s.share)='print$' "
        "OR LOWER(s.share) LIKE 'print%')"
    )


def _lifecycle_asset_match_sql() -> str:
    return (
        "fl.asset=('smb://' || s.host || '/' || s.share) "
        "OR fl.asset LIKE ('smb://' || s.host || '/' || s.share || '/%') "
        "OR fl.asset=('file:smb://' || s.host || '/' || s.share) "
        "OR fl.asset LIKE ('file:smb://' || s.host || '/' || s.share || '/%')"
        "OR fl.asset=(CHR(92) || CHR(92) || s.host || CHR(92) || s.share) "
        "OR SUBSTR(fl.asset, 1, LENGTH(CHR(92) || CHR(92) || s.host || CHR(92) || s.share || CHR(92)))="
        "   (CHR(92) || CHR(92) || s.host || CHR(92) || s.share || CHR(92)) "
        "OR fl.asset=('file:' || CHR(92) || CHR(92) || s.host || CHR(92) || s.share) "
        "OR SUBSTR(fl.asset, 1, LENGTH('file:' || CHR(92) || CHR(92) || s.host || CHR(92) || s.share || CHR(92)))="
        "   ('file:' || CHR(92) || CHR(92) || s.host || CHR(92) || s.share || CHR(92))"
    )


def _submitted_sql() -> str:
    return (
        "EXISTS (SELECT 1 FROM finding_lifecycle fl WHERE "
        "fl.task_type='smb' AND fl.status!='false_positive' AND ("
        + _lifecycle_asset_match_sql()
        + "))"
    )


def _filter_parts(
    *, status: str | None = None, q: str | None = None,
    exposure: str | None = None, severity: str | None = None,
    open_only: bool = False, report_ready: bool = False,
) -> tuple[list[str], list[Any]]:
    where: list[str] = []
    args: list[Any] = []
    if report_ready:
        marks = ",".join("?" for _ in _REPORT_READY_STATUSES)
        where.append(
            "EXISTS (SELECT 1 FROM mail_thread mt "
            f"WHERE mt.host=s.host AND mt.status IN ({marks}))"
        )
        args.extend(_REPORT_READY_STATUSES)
    if status and status in _VALID_STATUS:
        where.append("s.status=?")
        args.append(status)
    if q:
        where.append("(s.host LIKE ? OR s.share LIKE ? OR s.subnet LIKE ? OR s.summary LIKE ?)")
        like = f"%{q}%"
        args.extend([like, like, like, like])
    if open_only:
        where.append(_open_sql())
    if exposure and exposure in _VALID_EXPOSURE:
        if exposure == "open":
            where.append(_open_sql())
        elif exposure == "public":
            where.append("((s.null_login_ok=1 OR s.guest_login_ok=1) AND s.share_read=1)")
        elif exposure == "null":
            where.append("(s.null_login_ok=1 AND s.share_read=1)")
        elif exposure == "guest":
            where.append("(s.guest_login_ok=1 AND s.share_read=1)")
        elif exposure == "auth":
            where.append("(s.auth_login_ok=1 AND s.share_read=1)")
        elif exposure == "writable":
            where.append("s.share_write=1")
        elif exposure == "print":
            where.append(_print_sql())
        elif exposure == "submitted":
            where.append(_submitted_sql())
        elif exposure == "hits":
            where.append(
                "EXISTS (SELECT 1 FROM smb_file f WHERE f.share_id=s.id AND f.hits_count>0)"
            )
    if severity and severity in _VALID_SEVERITY:
        if severity == "none":
            where.append("(s.severity IS NULL OR s.severity='')")
        else:
            where.append("s.severity=?")
            args.append(severity)
    return where, args


def _where_sql(where: list[str]) -> str:
    return (" WHERE " + " AND ".join(where)) if where else ""


def list_shares(
    *, status: str | None = None, q: str | None = None,
    exposure: str | None = None, severity: str | None = None,
    open_only: bool = False, limit: int = 50, offset: int = 0,
) -> dict[str, Any]:
    where, args = _filter_parts(
        status=status, q=q, exposure=exposure,
        severity=severity, open_only=open_only,
    )
    where_sql = _where_sql(where)

    with state_domain.connect() as c:
        total = c.execute(
            "SELECT COUNT(*) FROM smb_share s" + where_sql, args,
        ).fetchone()[0]
        rows = c.execute(
            _base_select() + where_sql
            + " ORDER BY s.last_seen DESC LIMIT ? OFFSET ?",
            (*args, limit, offset),
        ).fetchall()
        items = [_shape({k: r[k] for k in r.keys()}) for r in rows]

    return {"total": int(total), "items": items}


def list_hosts(
    *, status: str | None = None, q: str | None = None,
    exposure: str | None = None, severity: str | None = None,
    open_only: bool = False, report_ready: bool = False,
    limit: int = 50, offset: int = 0,
) -> dict[str, Any]:
    where, args = _filter_parts(
        status=status, q=q, exposure=exposure,
        severity=severity, open_only=open_only, report_ready=report_ready,
    )
    where_sql = _where_sql(where)
    public_sql = "((s.null_login_ok=1 OR s.guest_login_ok=1) AND s.share_read=1)"
    auth_sql = "(s.auth_login_ok=1 AND s.share_read=1)"
    with state_domain.connect() as c:
        total = c.execute(
            "SELECT COUNT(*) FROM (SELECT s.host FROM smb_share s"
            + where_sql + " GROUP BY s.host) q",
            args,
        ).fetchone()[0]
        host_rows = c.execute(
            "SELECT s.host, MIN(s.subnet) AS subnet, COUNT(*) AS share_total, "
            f"SUM(CASE WHEN {_open_sql()} THEN 1 ELSE 0 END) AS open_share_total, "
            f"SUM(CASE WHEN {_print_sql()} THEN 1 ELSE 0 END) AS print_share_total, "
            f"SUM(CASE WHEN {public_sql} THEN 1 ELSE 0 END) AS public_share_total, "
            f"SUM(CASE WHEN {auth_sql} THEN 1 ELSE 0 END) AS auth_share_total, "
            "SUM(CASE WHEN s.share_write=1 THEN 1 ELSE 0 END) AS writable_share_total, "
            "SUM((SELECT COUNT(*) FROM smb_file f WHERE f.share_id=s.id)) AS file_total, "
            "SUM((SELECT COUNT(*) FROM smb_file f WHERE f.share_id=s.id AND f.hits_count>0)) AS file_with_hits, "
            "SUM((SELECT COUNT(*) FROM smb_file_hit h JOIN smb_file f ON f.id=h.file_id "
            "     WHERE f.share_id=s.id AND h.agent_verdict='confirmed')) AS confirmed_hits, "
            f"SUM(CASE WHEN {_submitted_sql()} THEN 1 ELSE 0 END) AS lifecycle_share_total, "
            "MAX(s.last_seen) AS last_seen "
            "FROM smb_share s" + where_sql
            + " GROUP BY s.host ORDER BY MAX(s.last_seen) DESC LIMIT ? OFFSET ?",
            (*args, limit, offset),
        ).fetchall()
        hosts = [r["host"] for r in host_rows]
        shares_by_host: dict[str, list[dict[str, Any]]] = {str(h): [] for h in hosts}
        if hosts:
            host_marks = ",".join("?" for _ in hosts)
            share_where = list(where) + [f"s.host IN ({host_marks})"]
            share_args = [*args, *hosts]
            rows = c.execute(
                _base_select() + _where_sql(share_where)
                + " ORDER BY s.host ASC, s.share ASC",
                share_args,
            ).fetchall()
            for r in rows:
                shaped = _shape({k: r[k] for k in r.keys()})
                shares_by_host.setdefault(str(shaped["host"]), []).append(shaped)

    items: list[dict[str, Any]] = []
    for r in host_rows:
        host = str(r["host"])
        items.append({
            "host": host,
            "asset": f"smb://{host}",
            "subnet": r["subnet"],
            "counts": {
                "share_total": int(r["share_total"] or 0),
                "open_share_total": int(r["open_share_total"] or 0),
                "print_share_total": int(r["print_share_total"] or 0),
                "public_share_total": int(r["public_share_total"] or 0),
                "auth_share_total": int(r["auth_share_total"] or 0),
                "writable_share_total": int(r["writable_share_total"] or 0),
                "file_total": int(r["file_total"] or 0),
                "file_with_hits": int(r["file_with_hits"] or 0),
                "confirmed_hits": int(r["confirmed_hits"] or 0),
                "lifecycle_share_total": int(r["lifecycle_share_total"] or 0),
            },
            "last_seen": r["last_seen"],
            "shares": shares_by_host.get(host, []),
        })
    return {"total": int(total), "items": items}


def get_share(share_id: int) -> dict[str, Any] | None:
    with state_domain.connect() as c:
        row = c.execute(
            _base_select() + " WHERE s.id=?", (share_id,),
        ).fetchone()
        if row is None:
            return None
        return _shape({k: row[k] for k in row.keys()})
