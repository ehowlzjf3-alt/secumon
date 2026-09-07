"""SMB Files 서비스 — share 내 파일 list + 파일 detail (+ hits)."""
from __future__ import annotations

import json
from typing import Any

# v3.82 U3d: 도메인 테이블 접근은 service.state_domain 으로 (코어 state 미사용).
from service import state_domain


def _bool_or_none(v: Any) -> bool | None:
    if v is None:
        return None
    return bool(v)


def _tags(raw: Any) -> list[str] | None:
    if raw is None:
        return None
    try:
        v = json.loads(raw)
        return v if isinstance(v, list) else None
    except (ValueError, TypeError):
        return None


def _shape_file(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": r["id"],
        "share_id": r["share_id"],
        "path": r["path"],
        "size": int(r.get("size") or 0),
        "is_text_candidate": bool(r.get("is_text_candidate") or 0),
        "suspicious_name": bool(r.get("suspicious_name") or 0),
        "fetch_status": r.get("fetch_status"),
        "scan_status": r.get("scan_status"),
        "file_read": _bool_or_none(r.get("file_read")),
        "file_write": _bool_or_none(r.get("file_write")),
        "hits_count": int(r.get("hits_count") or 0),
        "agent_note": r.get("agent_note"),
        "agent_tags": _tags(r.get("agent_tags")),
        "last_walked_at": r.get("last_walked_at"),
        "last_fetched_at": r.get("last_fetched_at"),
        "last_scanned_at": r.get("last_scanned_at"),
    }


def _shape_hit(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": r["id"],
        "file_id": r["file_id"],
        "category": r["category"],
        "kind": r["kind"],
        "masked": r["masked"],
        "line_no": int(r["line_no"]),
        "line_preview": r["line_preview"],
        "agent_verdict": r["agent_verdict"],
        "agent_confidence": r.get("agent_confidence"),
        "agent_note": r.get("agent_note"),
        "triaged_at": r.get("triaged_at"),
    }


def share_exists(share_id: int) -> bool:
    with state_domain.connect() as c:
        return c.execute(
            "SELECT 1 FROM smb_share WHERE id=?", (share_id,),
        ).fetchone() is not None


def list_files_in_share(
    share_id: int, *,
    suspicious_only: bool = False, hits_only: bool = False,
    limit: int = 200, offset: int = 0,
) -> dict[str, Any]:
    where = ["share_id=?"]
    args: list[Any] = [share_id]
    if suspicious_only:
        where.append("suspicious_name=1")
    if hits_only:
        where.append("hits_count>0")
    where_sql = " WHERE " + " AND ".join(where)

    with state_domain.connect() as c:
        total = c.execute(
            "SELECT COUNT(*) FROM smb_file" + where_sql, args,
        ).fetchone()[0]
        rows = c.execute(
            "SELECT * FROM smb_file" + where_sql
            + " ORDER BY suspicious_name DESC, hits_count DESC, path "
            + "LIMIT ? OFFSET ?",
            (*args, limit, offset),
        ).fetchall()
        items = [_shape_file({k: r[k] for k in r.keys()}) for r in rows]

    return {"total": int(total), "items": items}


def get_file_detail(file_id: int) -> dict[str, Any] | None:
    with state_domain.connect() as c:
        row = c.execute(
            "SELECT * FROM smb_file WHERE id=?", (file_id,),
        ).fetchone()
        if row is None:
            return None
        file_dict = _shape_file({k: row[k] for k in row.keys()})
        hit_rows = c.execute(
            "SELECT * FROM smb_file_hit WHERE file_id=? ORDER BY line_no",
            (file_id,),
        ).fetchall()
        file_dict["hits"] = [_shape_hit({k: r[k] for k in r.keys()}) for r in hit_rows]
        return file_dict
