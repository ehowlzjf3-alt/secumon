"""SMB host report service.

The report intentionally keeps two ideas separate:
- persistence keeps every observed SMB share/directory/file row, including clean rows;
- the default view filters the rendered payload to rows that have findings or issues.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

# v3.82 U3d: 도메인 테이블(smb_*) + finding_lifecycle 조회는 공용 풀을 쓰는
# service.state_domain.connect() 로 (코어 state 직접 import 제거).
from service import state_domain
from service.services import severity as _sev


SENSITIVE_HIT_CATEGORIES = {
    "secret",
    "credential",
    "pii",
    "semiconductor_process",
    "business_confidential",
}
LIFECYCLE_HIT_CATEGORIES = SENSITIVE_HIT_CATEGORIES | {"misconfig"}
PROBLEM_FETCH_STATUSES = {"error", "denied", "not_found"}
ISSUE_SEVERITIES = _sev.ISSUE_LEVELS  # SSOT


@dataclass(frozen=True)
class SmbAsset:
    host: str
    share: str | None = None
    path: str | None = None


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def _bool_or_none(v: Any) -> bool | None:
    if v is None:
        return None
    return bool(v)


def _int(v: Any) -> int:
    return int(v or 0)


def _json_list(raw: Any) -> list[str] | None:
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, list) else None


def _json_dict(raw: Any) -> dict[str, Any] | None:
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _asset_owner(host: str) -> dict[str, Any]:
    owner = state_domain.asset_owner_get(host) or {}
    return {
        "ip": owner.get("ip") or host,
        "user_id": owner.get("user_id"),
        "user_name": owner.get("user_name"),
        "user_dept": owner.get("user_dept"),
        "email": owner.get("email"),
        "source": owner.get("source"),
        "updated_at": owner.get("updated_at"),
        "known": bool(owner),
    }


EVIDENCE_LABELS = {
    "true_positive": "진성",
    "false_positive": "가성",
    "unverified": "미검증",
    "clean": "정상",
}


def _evidence_label(verdict: str) -> str:
    return EVIDENCE_LABELS.get(verdict, "미검증")


def _with_evidence_verdict(item: dict[str, Any], verdict: str) -> dict[str, Any]:
    shaped = dict(item)
    shaped["evidence_verdict"] = verdict
    shaped["evidence_label"] = _evidence_label(verdict)
    return shaped


# ── validation 살균(운영자 API egress) ────────────────────────────────────────
# smb_file_hit.validation_json / extra_json.hits[].validation 은 프로브가 만든 자유 dict 이고
# `auth_attempts[].credential_fields.username` 에 **실계정명이 마스킹 없이** 들어간다(실측:
# root·administrator·edm.park 등). 이 dict 를 그대로 응답에 실으면 브라우저·DevTools·프록시·
# 캐시에 평문 계정이 도달한다. UI 가 화면에 안 그리는 것은 누수 방지가 아니다.
# 구조(targets 등)는 보존하고 위험 값만 마스킹/제거한다.
_VALIDATION_DROP_KEYS = frozenset({
    "bound_masked",      # detector masked 원문 사본
    "password_masked",   # 앞2+뒤2 부분마스킹 = 부분 평문
    "password", "passwd", "pwd", "secret", "raw", "raw_password", "detail", "policy",
})
_VALIDATION_MASK_KEYS = frozenset({"username", "user", "principal", "account"})
_VALIDATION_MAX_DEPTH = 8


def _mask_account(value: Any) -> str:
    u = str(value or "")
    if not u:
        return ""
    if len(u) <= 2:
        return "*" * len(u)
    return u[0] + "*" * (len(u) - 2) + u[-1]


def _sanitize_validation(value: Any, _depth: int = 0) -> Any:
    if _depth > _VALIDATION_MAX_DEPTH:
        return None
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            key = str(k)
            if key in _VALIDATION_DROP_KEYS:
                continue
            if key in _VALIDATION_MASK_KEYS and isinstance(v, str):
                out[key] = _mask_account(v)
                continue
            out[key] = _sanitize_validation(v, _depth + 1)
        return out
    if isinstance(value, list):
        return [_sanitize_validation(v, _depth + 1) for v in value[:200]]
    return value


def _compact_summary(value: Any, *, limit: int = 360) -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _shape_lifecycle_hit(hit: dict[str, Any]) -> dict[str, Any]:
    shaped = dict(hit)
    if shaped.get("line_preview") in (None, "") and shaped.get("preview"):
        shaped["line_preview"] = shaped.get("preview")
    if "validation" in shaped:
        shaped["validation"] = _sanitize_validation(shaped.get("validation"))
    return _with_evidence_verdict(shaped, "true_positive")


def _lifecycle_hit_summary(hit: dict[str, Any]) -> str:
    preview = _compact_summary(hit.get("line_preview") or hit.get("preview"))
    if preview:
        return preview
    masked = _compact_summary(hit.get("masked"))
    if masked:
        return masked
    kind = str(hit.get("kind") or "").strip()
    category = str(hit.get("category") or "").strip()
    if kind and category:
        return f"{category}/{kind} 근거가 확인되었습니다."
    if kind:
        return f"{kind} 근거가 확인되었습니다."
    return ""


def _lifecycle_path_summary(
    finding: dict[str, Any],
    hits: list[dict[str, Any]],
) -> str:
    hit_summaries = [_lifecycle_hit_summary(h) for h in hits if isinstance(h, dict)]
    hit_summaries = [s for s in hit_summaries if s]
    if hit_summaries:
        if len(hit_summaries) == 1:
            return hit_summaries[0]
        joined = " / ".join(hit_summaries[:3])
        if len(hit_summaries) > 3:
            joined += f" 외 {len(hit_summaries) - 3}건"
        return _compact_summary(joined)
    return _compact_summary(finding.get("summary"))


def _shape_lifecycle_finding(row: dict[str, Any]) -> dict[str, Any]:
    extra = _json_dict(row.get("extra_json")) or {}
    hits = extra.get("hits")
    shaped_hits = [
        _shape_lifecycle_hit(hit)
        for hit in (hits if isinstance(hits, list) else [])
        if isinstance(hit, dict)
    ]
    return {
        "id": row["id"],
        "asset": row["asset"],
        "asset_kind": row["asset_kind"],
        "severity": row["severity"],
        "summary": row["summary"],
        "status": row["status"],
        "first_seen": row.get("first_seen"),
        "last_seen": row.get("last_seen"),
        "seen_count": _int(row.get("seen_count")),
        "classification": extra.get("classification"),
        "evidence": extra.get("evidence"),
        "evidence_verdict": "true_positive",
        "evidence_label": _evidence_label("true_positive"),
        "hits": shaped_hits,
        "risk_narrative": extra.get("risk_narrative"),
    }


def _fetch_lifecycle_findings_for_share(
    host: str,
    share: str,
    *,
    finding_ids: set[int] | None = None,
) -> list[dict[str, Any]]:
    host = str(host)
    share = str(share)
    if finding_ids is not None and not finding_ids:
        return []
    where = [
        "task_type='smb'",
        "status!='false_positive'",
        "asset LIKE ?",
    ]
    args: list[Any] = [f"%{host}%"]
    if finding_ids is not None:
        placeholders = ",".join("?" for _ in finding_ids)
        where.append(f"id IN ({placeholders})")
        args.extend(sorted(finding_ids))
    with state_domain.connect() as c:
        rows = c.execute(
            "SELECT id, asset, asset_kind, severity, summary, status, first_seen, "
            "last_seen, seen_count, extra_json "
            "FROM finding_lifecycle "
            f"WHERE {' AND '.join(where)} "
            "ORDER BY last_seen DESC, id DESC "
            "LIMIT 100",
            tuple(args),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        finding = _shape_lifecycle_finding(_row_dict(r))
        try:
            parsed = parse_smb_asset(str(finding.get("asset") or ""))
        except ValueError:
            continue
        if parsed.host == host and parsed.share == share:
            out.append(finding)
    return out


def _lifecycle_finding_path(finding: dict[str, Any], host: str, share: str) -> str | None:
    try:
        parsed = parse_smb_asset(str(finding.get("asset") or ""))
    except ValueError:
        return None
    if parsed.host != host or parsed.share != share or not parsed.path:
        return None
    return _normalize_path(parsed.path)


def _lifecycle_hit_path(hit: dict[str, Any], host: str, share: str) -> str | None:
    try:
        parsed = parse_smb_asset(str(hit.get("location") or ""))
    except (AttributeError, ValueError):
        return None
    if parsed.host != host or parsed.share != share or not parsed.path:
        return None
    return _normalize_path(parsed.path)


def _lifecycle_findings_by_path(
    findings: list[dict[str, Any]], host: str, share: str,
) -> dict[str, list[dict[str, Any]]]:
    by_path: dict[str, list[dict[str, Any]]] = {}
    for finding in findings:
        hits_by_path: dict[str, list[dict[str, Any]]] = {}
        path = _lifecycle_finding_path(finding, host, share)
        if path:
            hits_by_path.setdefault(path, [])
        for hit in finding.get("hits") or []:
            if not isinstance(hit, dict):
                continue
            hit_path = _lifecycle_hit_path(hit, host, share)
            if not hit_path:
                continue
            hits_by_path.setdefault(hit_path, []).append(hit)
        for report_path, hits in hits_by_path.items():
            shaped = dict(finding)
            shaped["report_path"] = report_path
            shaped["lifecycle_hits"] = hits
            shaped["finding_summary"] = finding.get("summary")
            shaped["summary"] = _lifecycle_path_summary(finding, hits)
            by_path.setdefault(report_path.lower(), []).append(shaped)
    return by_path


def _mode_right_allowed(
    row: dict[str, Any],
    access_modes: dict[str, Any] | None,
    mode: str,
    right: str,
) -> bool:
    values = (access_modes or {}).get(mode)
    if isinstance(values, dict) and right in values:
        return bool(values.get(right))
    if mode == "null" and right == "read":
        return bool(row.get("null_login_ok") and row.get("share_read"))
    if mode == "guest" and right == "read":
        return bool(row.get("guest_login_ok") and row.get("share_read"))
    if mode == "auth" and right == "read":
        return bool(row.get("auth_login_ok") and row.get("share_read"))
    if right == "write":
        return bool(row.get("share_write"))
    return False


def _auth_scope(
    row: dict[str, Any],
    access_modes: dict[str, Any] | None,
) -> dict[str, Any]:
    auth_readable = _mode_right_allowed(row, access_modes, "auth", "read")
    return {
        "auth_readable": auth_readable,
        "auth_broad_readable": bool(auth_readable),
        "interpretation": (
            "AUTH 인증으로 읽기 가능한 공유는 DS보안관제 검증 계정 기준 접근 가능 공유로 판단합니다."
        ),
    }


def _mode_label(mode: str, credential: str | None) -> str:
    if mode == "null":
        return "NULL"
    if mode == "guest":
        return "GUEST"
    if mode == "auth":
        return credential or "AUTH"
    return mode.upper()


def _principals_from_access(
    access_modes: dict[str, Any] | None,
    right: str,
    row: dict[str, Any],
) -> list[str]:
    credential = row.get("cred_name")
    labels: list[str] = []
    modes = access_modes or {}
    for mode in ("null", "guest", "auth"):
        values = modes.get(mode)
        if isinstance(values, dict) and values.get(right):
            labels.append(_mode_label(mode, credential))
    if labels:
        return labels

    if right == "read":
        legacy_modes = (
            ("null", row.get("null_login_ok")),
            ("guest", row.get("guest_login_ok")),
            ("auth", row.get("auth_login_ok")),
        )
        for mode, allowed in legacy_modes:
            if allowed:
                labels.append(_mode_label(mode, credential))
    if labels:
        return labels

    if right == "read" and row.get("share_read"):
        return ["확인됨"]
    if right == "write" and row.get("share_write"):
        return ["확인됨"]
    return []


def _normalize_path(path: str | None) -> str:
    return str(path or "").replace("\\", "/").strip("/")


def _dirname(path: str) -> str:
    clean = _normalize_path(path)
    if "/" not in clean:
        return ""
    return clean.rsplit("/", 1)[0]


def _basename(path: str) -> str:
    clean = _normalize_path(path)
    return clean.rsplit("/", 1)[-1] if clean else ""


def _under_directory(file_path: str, directory_path: str) -> bool:
    fp = _normalize_path(file_path)
    dp = _normalize_path(directory_path)
    if not dp:
        return True
    return fp.startswith(dp + "/")


_SMB_LINE_SUFFIX_RE = re.compile(r"(?::\d+(?:[,-]\d+)*|#L\d+(?:-\d+)?)$")


def parse_smb_asset(asset: str) -> SmbAsset:
    """Parse smb://host/share/path, file:smb://...:line, //host/share/path, or host/share/path."""
    raw = str(asset or "").strip()
    if raw.lower().startswith("file:"):
        raw = raw[5:]
    if raw.lower().startswith("smb://"):
        raw = raw[6:]
    raw = raw.lstrip("/\\")
    parts = [p for p in raw.replace("\\", "/").split("/") if p]
    if not parts:
        raise ValueError("empty SMB asset")
    host = parts[0]
    share = parts[1] if len(parts) > 1 else None
    path = "/".join(parts[2:]) if len(parts) > 2 else None
    if path:
        path = _SMB_LINE_SUFFIX_RE.sub("", path)
    return SmbAsset(host=host, share=share, path=path)


def _shape_hit(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "file_id": row["file_id"],
        "category": row["category"],
        "kind": row["kind"],
        "masked": row["masked"],
        "line_no": _int(row["line_no"]),
        "line_preview": row["line_preview"],
        "agent_verdict": row["agent_verdict"],
        "agent_confidence": row.get("agent_confidence"),
        "agent_note": row.get("agent_note"),
        "validation": _sanitize_validation(_json_dict(row.get("validation_json"))),
        "triaged_at": row.get("triaged_at"),
    }


def _hit_evidence_verdict(hit: dict[str, Any], *, file_confirmed: bool) -> str:
    if hit.get("agent_verdict") == "false_positive":
        return "false_positive"
    if file_confirmed:
        return "true_positive"
    return "unverified"


def _shape_hit_evidence(hit: dict[str, Any], *, file_confirmed: bool) -> dict[str, Any]:
    return _with_evidence_verdict(
        hit,
        _hit_evidence_verdict(hit, file_confirmed=file_confirmed),
    )


def _file_evidence_verdict(
    *,
    ai_confirmed: bool,
    hits: list[dict[str, Any]],
    risk_flags: list[str],
) -> str:
    if ai_confirmed:
        return "true_positive"
    if hits and all(h.get("agent_verdict") == "false_positive" for h in hits):
        return "false_positive"
    if hits or risk_flags:
        return "unverified"
    return "clean"


def _evidence_counts(
    hits: list[dict[str, Any]],
    *,
    ai_confirmed: bool,
) -> dict[str, int]:
    counts = {"true_positive": 0, "false_positive": 0, "unverified": 0}
    for hit in hits:
        verdict = hit.get("evidence_verdict") or "unverified"
        if verdict in counts:
            counts[verdict] += 1
    if ai_confirmed and counts["true_positive"] == 0:
        counts["true_positive"] = 1
    return counts


def _true_positive_report_file(file_row: dict[str, Any]) -> dict[str, Any]:
    shaped = dict(file_row)
    shaped["hits"] = [
        h for h in file_row.get("hits", [])
        if h.get("evidence_verdict") == "true_positive"
    ]
    return shaped


def _is_ai_issue(status: Any, severity: Any) -> bool:
    return status == "reviewed" and severity in ISSUE_SEVERITIES


def _file_risk_flags(row: dict[str, Any], hits: list[dict[str, Any]]) -> list[str]:
    flags: list[str] = []
    active_hits = [h for h in hits if h.get("agent_verdict") != "false_positive"]
    if _int(row.get("active_hits_count")) > 0 or active_hits:
        flags.append("content_hit")
    for category in sorted({str(h.get("category") or "") for h in active_hits}):
        if category in SENSITIVE_HIT_CATEGORIES:
            flags.append(f"{category}_hit")
    if row.get("file_write"):
        flags.append("file_writable")
    fetch_status = row.get("fetch_status")
    if fetch_status in PROBLEM_FETCH_STATUSES:
        flags.append(f"fetch_{fetch_status}")
    review_severity = row.get("review_severity")
    if review_severity in ISSUE_SEVERITIES:
        flags.append(f"review_{review_severity}")
    return flags


def _add_unique(flags: list[str], flag: str) -> None:
    if flag and flag not in flags:
        flags.append(flag)


def _lifecycle_risk_flags(lifecycle_findings: list[dict[str, Any]] | None) -> list[str]:
    flags: list[str] = []
    for finding in lifecycle_findings or []:
        for hit in (finding.get("lifecycle_hits") or finding.get("hits") or []):
            if not isinstance(hit, dict):
                continue
            category = str(hit.get("category") or "")
            if category in LIFECYCLE_HIT_CATEGORIES:
                _add_unique(flags, f"{category}_hit")
            kind = str(hit.get("kind") or "")
            if "vehicle_plate" in kind or "차량" in kind:
                _add_unique(flags, "vehicle_plate")
            if "administrative_share" in kind:
                _add_unique(flags, "administrative_share")
            if "auth_readable" in kind:
                _add_unique(flags, "auth_readable")
    return flags


def _shape_file(
    row: dict[str, Any],
    hits: list[dict[str, Any]],
    *,
    top_finding_ids: set[int] | None = None,
    lifecycle_findings: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    active_hit_count = _int(row.get("active_hits_count"))
    risk_flags = _file_risk_flags(row, hits)
    path = _normalize_path(row.get("path"))
    review_status = row.get("review_status")
    review_severity = row.get("review_severity")
    in_share_top_findings = int(row["id"]) in (top_finding_ids or set())
    has_lifecycle_finding = bool(lifecycle_findings)
    if has_lifecycle_finding and "submitted_finding" not in risk_flags:
        risk_flags.append("submitted_finding")
    for flag in _lifecycle_risk_flags(lifecycle_findings):
        _add_unique(risk_flags, flag)
    ai_confirmed = (
        _is_ai_issue(review_status, review_severity)
        or in_share_top_findings
        or has_lifecycle_finding
    )
    shaped_hits = [
        _shape_hit_evidence(hit, file_confirmed=ai_confirmed)
        for hit in hits
    ]
    evidence_verdict = _file_evidence_verdict(
        ai_confirmed=ai_confirmed,
        hits=hits,
        risk_flags=risk_flags,
    )
    evidence_counts = _evidence_counts(shaped_hits, ai_confirmed=ai_confirmed)
    return {
        "id": row["id"],
        "share_id": row["share_id"],
        "path": path,
        "directory": _dirname(path),
        "name": _basename(path),
        "size": None if row.get("size") is None else _int(row.get("size")),
        "synthetic": bool(row.get("_synthetic")),
        "is_text_candidate": bool(row.get("is_text_candidate") or 0),
        "suspicious_name": bool(row.get("suspicious_name") or 0),
        "fetch_status": row.get("fetch_status"),
        "scan_status": row.get("scan_status"),
        "access": {
            "read": _bool_or_none(row.get("file_read")),
            "write": _bool_or_none(row.get("file_write")),
        },
        "hits_count": active_hit_count,
        "raw_hits_count": _int(row.get("hits_count")),
        "review": {
            "status": review_status,
            "severity": review_severity,
            "summary": row.get("review_summary"),
            "reviewed_at": row.get("reviewed_at"),
            "top_finding": in_share_top_findings,
        },
        "lifecycle_findings": lifecycle_findings or [],
        "agent_note": row.get("agent_note"),
        "agent_tags": _json_list(row.get("agent_tags")),
        "last_walked_at": row.get("last_walked_at"),
        "last_fetched_at": row.get("last_fetched_at"),
        "last_scanned_at": row.get("last_scanned_at"),
        "risk_flags": risk_flags,
        "evidence_verdict": evidence_verdict,
        "evidence_label": _evidence_label(evidence_verdict),
        "evidence_counts": evidence_counts,
        "has_candidate": bool(risk_flags),
        "ai_confirmed": ai_confirmed,
        "has_finding": ai_confirmed,
        "hits": shaped_hits,
    }


def _directory_risk_flags(row: dict[str, Any], file_total: int, flagged_files: int) -> list[str]:
    flags: list[str] = []
    if row.get("listable") == 0:
        flags.append("not_listable")
    if row.get("error"):
        flags.append("listing_error")
    if row.get("writable"):
        flags.append("directory_writable")
    return flags


def _shape_directory(row: dict[str, Any], files: list[dict[str, Any]]) -> dict[str, Any]:
    path = _normalize_path(row.get("path"))
    child_files = [f for f in files if _under_directory(f.get("path", ""), path)]
    flagged_files = [f for f in child_files if f.get("has_finding")]
    hit_files = [f for f in child_files if f.get("has_candidate") or f.get("has_finding")]
    risk_flags = _directory_risk_flags(row, len(child_files), len(flagged_files))
    return {
        "id": row["id"],
        "share_id": row["share_id"],
        "path": path,
        "depth": _int(row.get("depth")),
        "listable": _bool_or_none(row.get("listable")),
        "readable": _bool_or_none(row.get("readable")),
        "writable": _bool_or_none(row.get("writable")),
        "error": row.get("error"),
        "last_seen": row.get("last_seen"),
        "file_total": len(child_files),
        "flagged_files": len(flagged_files),
        "hit_files": len(hit_files),
        "risk_flags": risk_flags,
        "has_candidate": bool(risk_flags),
        "has_finding": bool(flagged_files),
    }


def _share_risk_flags(
    row: dict[str, Any],
    directories: list[dict[str, Any]],
    files: list[dict[str, Any]],
    *,
    access_modes: dict[str, Any] | None = None,
    lifecycle_findings: list[dict[str, Any]] | None = None,
) -> list[str]:
    flags: list[str] = []
    if row.get("excluded_reason") == "exception":
        flags.append("exception_approved")
    if lifecycle_findings:
        flags.append("submitted_finding")
        for flag in _lifecycle_risk_flags(lifecycle_findings):
            _add_unique(flags, flag)
    if row.get("share_write"):
        flags.append("share_writable")
    if row.get("null_login_ok") and row.get("share_read"):
        flags.append("null_readable")
    if row.get("guest_login_ok") and row.get("share_read"):
        flags.append("guest_readable")
    if _auth_scope(row, access_modes).get("auth_broad_readable"):
        flags.append("auth_broad_readable")
    severity = row.get("severity")
    if severity in ISSUE_SEVERITIES:
        flags.append(f"share_review_{severity}")
    if (
        _int(row.get("directory_issue_total")) > 0
        or any(d.get("has_finding") for d in directories)
    ):
        flags.append("directory_issue")
    if any(f.get("has_candidate") or f.get("has_finding") for f in files):
        flags.append("file_issue")
    return flags


def _top_finding_file_ids(listing_review: dict[str, Any] | None) -> set[int]:
    ids: set[int] = set()
    if not listing_review:
        return ids
    for item in listing_review.get("top_findings") or []:
        try:
            ids.add(int(item.get("file_id")))
        except (AttributeError, TypeError, ValueError):
            continue
    return ids


def _fetch_shares(
    host: str,
    share: str | None,
    *,
    cycle_key: str | None = None,
) -> list[dict[str, Any]]:
    where = ["s.host=?"]
    args: list[Any] = [host]
    if share:
        where.append("s.share=?")
        args.append(share)
    if cycle_key:
        where.append("s.cycle_key=?")
        args.append(cycle_key)
    sql = (
        "SELECT s.*, c.name AS cred_name, "
        "  (SELECT COUNT(*) FROM smb_directory d WHERE d.share_id=s.id) AS directory_total, "
        "  (SELECT COUNT(*) FROM smb_directory d WHERE d.share_id=s.id "
        "   AND (d.listable=0 OR d.writable=1 OR d.error IS NOT NULL)) AS directory_issue_total, "
        "  (SELECT COUNT(*) FROM smb_file f WHERE f.share_id=s.id) AS file_total, "
        "  (SELECT COUNT(*) FROM smb_file f WHERE f.share_id=s.id AND f.suspicious_name=1) AS suspicious_file_total, "
        "  (SELECT COUNT(DISTINCT f.id) FROM smb_file f "
        "   JOIN smb_file_hit h ON h.file_id=f.id "
        "   WHERE f.share_id=s.id AND h.agent_verdict!='false_positive') AS file_with_hits, "
        "  (SELECT COUNT(*) FROM smb_file f WHERE f.share_id=s.id AND f.file_write=1) AS writable_file_total, "
        "  (SELECT COUNT(*) FROM smb_file f WHERE f.share_id=s.id "
        "   AND f.fetch_status IN ('error','denied','not_found')) AS inaccessible_file_total, "
        "  (SELECT COUNT(*) FROM smb_file f WHERE f.share_id=s.id "
        "   AND f.review_severity IN ('critical','high','medium')) AS reviewed_issue_file_total, "
        "  (SELECT COUNT(*) FROM smb_file f WHERE f.share_id=s.id "
        "   AND (EXISTS (SELECT 1 FROM smb_file_hit h WHERE h.file_id=f.id "
        "                AND h.agent_verdict!='false_positive') OR f.file_write=1 "
        "        OR f.fetch_status IN ('error','denied','not_found') "
        "        OR f.review_severity IN ('critical','high','medium'))) AS file_issue_total, "
        "  (SELECT COUNT(*) FROM smb_file_hit h JOIN smb_file f ON f.id=h.file_id "
        "   WHERE f.share_id=s.id AND h.agent_verdict!='false_positive') AS hit_total, "
        "  (SELECT COUNT(*) FROM smb_file_hit h JOIN smb_file f ON f.id=h.file_id "
        "   WHERE f.share_id=s.id AND h.agent_verdict='confirmed') AS confirmed_hit_total "
        "FROM smb_share s LEFT JOIN smb_credential c ON c.id=s.auth_credential_id "
        "WHERE " + " AND ".join(where) + " "
        "ORDER BY s.share ASC"
    )
    with state_domain.connect() as c:
        return [_row_dict(r) for r in c.execute(sql, tuple(args)).fetchall()]


def _fetch_files(share_id: int, limit: int) -> list[dict[str, Any]]:
    with state_domain.connect() as c:
        rows = c.execute(
            "SELECT q.* FROM ("
            "  SELECT f.*, "
            "    (SELECT COUNT(*) FROM smb_file_hit h WHERE h.file_id=f.id "
            "     AND h.agent_verdict!='false_positive') AS active_hits_count "
            "  FROM smb_file f WHERE f.share_id=?"
            ") q "
            "ORDER BY "
            "CASE WHEN active_hits_count>0 OR file_write=1 "
            "          OR fetch_status IN ('error','denied','not_found') "
            "          OR review_severity IN ('critical','high','medium') "
            "     THEN 1 ELSE 0 END DESC, "
            "active_hits_count DESC, suspicious_name DESC, file_write DESC, path ASC "
            "LIMIT ?",
            (share_id, limit),
        ).fetchall()
    return [_row_dict(r) for r in rows]


def _fetch_files_by_paths(share_id: int, paths: list[str]) -> list[dict[str, Any]]:
    clean_paths = sorted({_normalize_path(p) for p in paths if _normalize_path(p)})
    if not clean_paths:
        return []
    placeholders = ",".join("?" for _ in clean_paths)
    with state_domain.connect() as c:
        rows = c.execute(
            "SELECT f.*, "
            "  (SELECT COUNT(*) FROM smb_file_hit h WHERE h.file_id=f.id "
            "   AND h.agent_verdict!='false_positive') AS active_hits_count "
            "FROM smb_file f WHERE f.share_id=? AND f.path IN (" + placeholders + ") "
            "ORDER BY path ASC",
            (share_id, *clean_paths),
        ).fetchall()
    return [_row_dict(r) for r in rows]


def _synthetic_lifecycle_file(
    share_id: int,
    path: str,
    lifecycle_findings: list[dict[str, Any]],
) -> dict[str, Any]:
    severity = None
    summary = None
    if lifecycle_findings:
        severity = lifecycle_findings[0].get("severity")
        summary = _lifecycle_path_summary(lifecycle_findings[0], lifecycle_findings[0].get("lifecycle_hits") or [])
    return {
        "id": -(abs(hash((share_id, path))) % 1_000_000_000 + 1),
        "share_id": share_id,
        "path": path,
        "size": None,
        "_synthetic": True,
        "is_text_candidate": 0,
        "suspicious_name": 0,
        "fetch_status": None,
        "scan_status": None,
        "file_read": True,
        "file_write": None,
        "hits_count": 0,
        "active_hits_count": 0,
        "review_status": "lifecycle_finding",
        "review_severity": severity,
        "review_summary": summary,
        "reviewed_at": None,
        "agent_note": None,
        "agent_tags": None,
        "last_walked_at": None,
        "last_fetched_at": None,
        "last_scanned_at": None,
    }


def _fetch_hits(file_ids: list[int]) -> dict[int, list[dict[str, Any]]]:
    if not file_ids:
        return {}
    placeholders = ",".join("?" for _ in file_ids)
    with state_domain.connect() as c:
        rows = c.execute(
            "SELECT * FROM smb_file_hit WHERE file_id IN (" + placeholders + ") "
            "ORDER BY file_id ASC, line_no ASC, id ASC",
            tuple(file_ids),
        ).fetchall()
    hits_by_file: dict[int, list[dict[str, Any]]] = {}
    for row in rows:
        hit = _shape_hit(_row_dict(row))
        hits_by_file.setdefault(int(hit["file_id"]), []).append(hit)
    return hits_by_file


def _fetch_directories(share_id: int, limit: int) -> list[dict[str, Any]]:
    return state_domain.directories_for_share(share_id, limit=limit)


def _shape_share(
    row: dict[str, Any],
    *,
    findings_only: bool,
    limit_per_share: int,
    lifecycle_finding_ids: set[int] | None = None,
) -> dict[str, Any]:
    lifecycle_findings = _fetch_lifecycle_findings_for_share(
        str(row["host"]), str(row["share"]),
        finding_ids=lifecycle_finding_ids,
    )
    lifecycle_by_path = _lifecycle_findings_by_path(
        lifecycle_findings, str(row["host"]), str(row["share"]),
    )
    lifecycle_report_paths = {
        key: str(items[0].get("report_path") or key)
        for key, items in lifecycle_by_path.items()
        if items
    }
    listing_review = _json_dict(row.get("listing_review"))
    top_finding_ids = _top_finding_file_ids(listing_review)
    file_rows = _fetch_files(int(row["id"]), limit_per_share)
    existing_paths = {_normalize_path(r.get("path")).lower() for r in file_rows}
    missing_lifecycle_paths = [
        lifecycle_report_paths[path]
        for path in lifecycle_by_path.keys()
        if path not in existing_paths
    ]
    if missing_lifecycle_paths:
        extra_rows = _fetch_files_by_paths(int(row["id"]), missing_lifecycle_paths)
        file_rows.extend(extra_rows)
        existing_paths.update(_normalize_path(r.get("path")).lower() for r in extra_rows)
    still_missing_lifecycle_paths = [
        path for path in lifecycle_by_path.keys() if path not in existing_paths
    ]
    for path in still_missing_lifecycle_paths:
        report_path = lifecycle_report_paths.get(path, path)
        file_rows.append(
            _synthetic_lifecycle_file(int(row["id"]), report_path, lifecycle_by_path[path])
        )
    hits_by_file = _fetch_hits([int(r["id"]) for r in file_rows])
    files_all = [
        _shape_file(
            r,
            hits_by_file.get(int(r["id"]), []),
            top_finding_ids=top_finding_ids,
            lifecycle_findings=lifecycle_by_path.get(_normalize_path(r.get("path")).lower()),
        )
        for r in file_rows
    ]
    directory_rows = _fetch_directories(int(row["id"]), limit_per_share)
    directories_all = [_shape_directory(r, files_all) for r in directory_rows]
    access_modes = _json_dict(row.get("access_modes")) or {}
    access_scope = _auth_scope(row, access_modes)
    risk_flags = _share_risk_flags(
        row, directories_all, files_all, access_modes=access_modes,
        lifecycle_findings=lifecycle_findings,
    )
    read_principals = _principals_from_access(access_modes, "read", row)
    write_principals = _principals_from_access(access_modes, "write", row)
    ai_share_confirmed = bool(listing_review and listing_review.get("severity") in ISSUE_SEVERITIES)
    ai_confirmed = ai_share_confirmed or any(f["has_finding"] for f in files_all)
    has_lifecycle_finding = bool(lifecycle_findings)
    has_finding = ai_confirmed or has_lifecycle_finding

    true_positive_files = [f for f in files_all if f["evidence_verdict"] == "true_positive"]
    files = (
        [_true_positive_report_file(f) for f in true_positive_files]
        if findings_only else files_all
    )
    directories = (
        [d for d in directories_all if d["has_finding"]]
        if findings_only else directories_all
    )
    evidence_counts = {
        "true_positive": sum(f["evidence_counts"]["true_positive"] for f in files_all),
        "false_positive": sum(f["evidence_counts"]["false_positive"] for f in files_all),
        "unverified": sum(f["evidence_counts"]["unverified"] for f in files_all),
    }

    return {
        "id": row["id"],
        "host": row["host"],
        "share": row["share"],
        "subnet": row["subnet"],
        "status": row["status"],
        "summary": row.get("summary"),
        "severity": row.get("severity"),
        "excluded_reason": row.get("excluded_reason"),
        "excluded_at": row.get("excluded_at"),
        "exception": {
            "reason": row.get("exception_reason"),
            "thread_id": row.get("exception_thread_id"),
            "approved_by": row.get("exception_approved_by"),
            "approved_at": row.get("exception_at"),
        } if row.get("exception_at") or row.get("exception_reason") else None,
        "listing_review": listing_review,
        "lifecycle_findings": lifecycle_findings,
        "access": {
            "modes": {
                "null": _bool_or_none(row.get("null_login_ok")),
                "guest": _bool_or_none(row.get("guest_login_ok")),
                "auth": _bool_or_none(row.get("auth_login_ok")),
            },
            "matrix": access_modes,
            "principals": {
                "read": read_principals,
                "write": write_principals,
            },
            "share": {
                "read": bool(row.get("share_read") or 0),
                "write": bool(row.get("share_write") or 0),
            },
            "scope": access_scope,
            "credential": row.get("cred_name"),
        },
        "counts": {
            "directories_total": _int(row.get("directory_total")),
            "directory_issues": _int(row.get("directory_issue_total")),
            "files_total": _int(row.get("file_total")),
            "suspicious_files": _int(row.get("suspicious_file_total")),
            "files_with_hits": _int(row.get("file_with_hits")),
            "writable_files": _int(row.get("writable_file_total")),
            "inaccessible_files": _int(row.get("inaccessible_file_total")),
            "reviewed_issue_files": _int(row.get("reviewed_issue_file_total")),
            "candidate_file_issues": _int(row.get("file_issue_total")),
            "file_issues": sum(1 for f in files_all if f["has_finding"]),
            "hits_total": _int(row.get("hit_total")),
            "confirmed_hits": _int(row.get("confirmed_hit_total")),
            "true_positive_files": len(true_positive_files),
            "false_positive_files": sum(
                1 for f in files_all if f["evidence_verdict"] == "false_positive"
            ),
            "unverified_files": sum(
                1 for f in files_all if f["evidence_verdict"] == "unverified"
            ),
            "evidence_total": sum(evidence_counts.values()),
            "true_positive_evidence": evidence_counts["true_positive"],
            "false_positive_evidence": evidence_counts["false_positive"],
            "unverified_evidence": evidence_counts["unverified"],
        },
        "coverage": {
            "walk_file_count": _int(row.get("walk_file_count")),
            "walk_done_at": row.get("walk_done_at"),
            "processed_at": row.get("processed_at"),
            "directories_returned": len(directories),
            "files_returned": len(files),
            "directory_limit_per_share": limit_per_share,
            "file_limit_per_share": limit_per_share,
            "directories_truncated_by_limit": _int(row.get("directory_total")) > len(directory_rows),
            "files_truncated_by_limit": _int(row.get("file_total")) > len(file_rows),
        },
        "risk_flags": risk_flags,
        "has_candidate": bool(risk_flags),
        "ai_confirmed": ai_confirmed,
        "has_finding": has_finding,
        "directories": directories,
        "files": files,
        "hidden_clean": {
            "directories": max(0, len(directories_all) - len(directories)),
            "files": (
                max(0, _int(row.get("file_total")) - sum(1 for f in files_all if f["has_finding"]))
                if findings_only else 0
            ),
        },
    }


def smb_host_report(
    host: str,
    *,
    share: str | None = None,
    path: str | None = None,
    findings_only: bool = True,
    limit_per_share: int = 5000,
    cycle_key: str | None = None,
    finding_ids: set[int] | list[int] | tuple[int, ...] | None = None,
) -> dict[str, Any]:
    lifecycle_finding_ids = (
        {int(fid) for fid in finding_ids}
        if finding_ids is not None else None
    )
    share_rows = _fetch_shares(host, share, cycle_key=cycle_key)
    shaped_all = [
        _shape_share(
            r,
            findings_only=findings_only,
            limit_per_share=limit_per_share,
            lifecycle_finding_ids=lifecycle_finding_ids,
        )
        for r in share_rows
    ]
    shares = [s for s in shaped_all if s["has_finding"]] if findings_only else shaped_all
    null_exposure_total = sum(
        1 for s in shaped_all if "NULL" in s["access"]["principals"]["read"]
    )
    guest_exposure_total = sum(
        1 for s in shaped_all if "GUEST" in s["access"]["principals"]["read"]
    )
    public_exposure_total = sum(
        1 for s in shaped_all
        if any(p in {"NULL", "GUEST"} for p in s["access"]["principals"]["read"])
    )
    auth_broad_exposure_total = sum(
        1 for s in shaped_all if s["access"]["scope"]["auth_broad_readable"]
    )
    writable_share_total = sum(1 for s in shaped_all if s["access"]["share"]["write"])
    share_finding_total = sum(1 for s in shaped_all if s["has_finding"])
    directory_finding_total = sum(len([d for d in s["directories"] if d.get("has_finding")]) for s in shaped_all)
    file_finding_total = sum(s["counts"]["file_issues"] for s in shaped_all)

    totals = {
        "share_total": len(shaped_all),
        "share_shown": len(shares),
        "share_finding_total": share_finding_total,
        "directory_total": sum(s["counts"]["directories_total"] for s in shaped_all),
        "directory_shown": sum(len(s["directories"]) for s in shares),
        "directory_finding_total": directory_finding_total,
        "file_total": sum(s["counts"]["files_total"] for s in shaped_all),
        "file_shown": sum(len(s["files"]) for s in shares),
        "file_finding_total": file_finding_total,
        "hit_total": sum(s["counts"]["hits_total"] for s in shaped_all),
        "confirmed_hit_total": sum(s["counts"]["confirmed_hits"] for s in shaped_all),
        "true_positive_file_total": sum(s["counts"]["true_positive_files"] for s in shaped_all),
        "false_positive_file_total": sum(s["counts"]["false_positive_files"] for s in shaped_all),
        "unverified_file_total": sum(s["counts"]["unverified_files"] for s in shaped_all),
        "true_positive_evidence_total": sum(s["counts"]["true_positive_evidence"] for s in shaped_all),
        "false_positive_evidence_total": sum(s["counts"]["false_positive_evidence"] for s in shaped_all),
        "unverified_evidence_total": sum(s["counts"]["unverified_evidence"] for s in shaped_all),
        "null_exposure_total": null_exposure_total,
        "guest_exposure_total": guest_exposure_total,
        "public_exposure_total": public_exposure_total,
        "auth_broad_exposure_total": auth_broad_exposure_total,
        "writable_share_total": writable_share_total,
        "writable_file_total": sum(s["counts"]["writable_files"] for s in shaped_all),
        "hidden_clean_shares": max(0, len(shaped_all) - len(shares)),
        "hidden_clean_directories": sum(s["hidden_clean"]["directories"] for s in shaped_all),
        "hidden_clean_files": sum(s["hidden_clean"]["files"] for s in shaped_all),
    }

    risk_flags = sorted({flag for s in shaped_all for flag in s["risk_flags"]})
    return {
        "kind": "smb_host_report",
        "host": host,
        "asset_owner": _asset_owner(host),
        "focus": {
            "share": share,
            "path": _normalize_path(path) if path else None,
        } if share or path else None,
        "filters": {
            "findings_only": findings_only,
            "limit_per_share": limit_per_share,
            "cycle_key": cycle_key,
            "finding_ids": sorted(lifecycle_finding_ids) if lifecycle_finding_ids is not None else None,
        },
        "summary": {
            **totals,
            "risk_flags": risk_flags,
        },
        "shares": shares,
    }


def smb_report_for_asset(
    asset: str,
    *,
    findings_only: bool = True,
    limit_per_share: int = 5000,
    cycle_key: str | None = None,
) -> dict[str, Any]:
    parsed = parse_smb_asset(asset)
    return smb_host_report(
        parsed.host,
        share=parsed.share,
        path=parsed.path,
        findings_only=findings_only,
        limit_per_share=limit_per_share,
        cycle_key=cycle_key,
    )
