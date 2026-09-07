"""Domain finding report projection for the autonomous workbench."""
from __future__ import annotations

import json
import time
from typing import Any
from urllib.parse import unquote, urlparse

# 코어 잔존 함수(finding_list)는 엔진 state, 도메인 테이블 raw SQL/asset_owner 는
# service.state_domain (v3.82 U3d). asset identity 헬퍼(discovery_method/
# github_identity/confluence_identity/canonicalize_by_asset)는 도메인 서비스
# 소유 finding_identity 로 이동 — 코어 taxonomy 엔 generic 만 남음.
from secu_agent import state
from secu_agent.finding_taxonomy import (
    category_rank, classification_label, classify, host_of,
)

from service import state_domain
from service.services.finding_identity import (
    canonicalize_by_asset, confluence_identity, discovery_method, github_identity,
)
from service.services import severity as _sev


_DOMAIN_DEFS: dict[str, dict[str, Any]] = {
    "smb": {
        "key": "smb",
        "label": "SMB Findings",
        "task_types": ("smb",),
        "required": (
            "asset",
            "evidence_ref",
            "severity",
            "confidence",
            "status",
            "next_action",
            "share/file context",
        ),
    },
    "web": {
        "key": "web",
        "label": "Web Findings",
        "task_types": ("web",),
        "required": (
            "asset",
            "evidence_ref",
            "severity",
            "confidence",
            "status",
            "next_action",
            "HTTP/TLS context",
        ),
    },
    "dev_web": {
        "key": "dev_web",
        "label": "Dev Web Findings",
        "task_types": ("dev_web",),
        "required": (
            "asset",
            "evidence_ref",
            "severity",
            "confidence",
            "status",
            "next_action",
            "rendered page/API evidence",
        ),
    },
    "github": {
        "key": "github",
        "label": "GitHub Findings",
        # v3.74: devops umbrella 해체 — github 네이티브 = github+jenkins(CI/코드 인프라).
        # 레거시 'devops' row 는 _rows_for_domain 가 자산기준으로 github/confluence 에
        # 분배(canonical_task_type) → 더 이상 무조건 github 흡수 아님. 신규는 canon 태깅돼
        # 'devops' 가 안 생긴다(쓰기시점 canonicalizer).
        "task_types": ("github", "jenkins"),
        "required": (
            "asset",
            "evidence_ref",
            "severity",
            "confidence",
            "status",
            "next_action",
            "repo/CI object context",
        ),
    },
    "confluence": {
        "key": "confluence",
        "label": "Confluence Findings",
        "task_types": ("confluence",),
        "required": (
            "asset",
            "evidence_ref",
            "severity",
            "confidence",
            "status",
            "next_action",
            "page/space context",
        ),
    },
}

_SEVERITY_RANK = {
    "critical": 4,
    "high": 3,
    "medium": 2,
    "low": 1,
    "informational": 0,
}
_SEVERITY_ORDER = _sev.LEVELS          # SSOT
_OPEN_STATUSES = {"open", "triaged"}
_TERMINAL_TARGET_STATUSES = {"tasked", "skipped", "error"}
_SMB_TERMINAL_STATUSES = {
    "walked",
    "listing_reviewed",
    "triaged_completed",
    "triaged_errored",
    "ignored",
    "closed",
}
_ISSUE_SEVERITIES = _sev.ISSUE_LEVELS  # SSOT — smb_reports 에도 같은 집합이 있었다


def domain_keys() -> list[str]:
    return list(_DOMAIN_DEFS)


def _extra(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("extra")
    return raw if isinstance(raw, dict) else {}


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def _json_dict(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _bool_or_none(raw: Any) -> bool | None:
    if raw is None:
        return None
    return bool(raw)


def _smb_asset_host_share(asset: Any) -> tuple[str, str] | None:
    raw = str(asset or "").strip()
    if not raw:
        return None
    if raw.lower().startswith("file:smb://"):
        raw = raw[5:]
    if raw.lower().startswith("smb://"):
        parsed = urlparse(raw)
        host = parsed.hostname or parsed.netloc.split("@")[-1].split(":", 1)[0]
        parts = [unquote(p) for p in parsed.path.split("/") if p]
        if host and parts:
            return host, parts[0]
        return None
    if raw.startswith("\\\\") or raw.startswith("//"):
        norm = raw.replace("\\", "/").lstrip("/")
        parts = [unquote(p) for p in norm.split("/") if p]
        if len(parts) >= 2:
            return parts[0], parts[1]
    return None


def _smb_mode_readable(
    row: dict[str, Any], access_modes: dict[str, Any], mode: str,
) -> bool | None:
    mode_info = access_modes.get(mode)
    if isinstance(mode_info, dict) and "read" in mode_info:
        return bool(mode_info.get("read"))
    login = row.get(f"{mode}_login_ok")
    if login is None:
        return None
    return bool(login) and bool(row.get("share_read"))


def _smb_access_from_share_row(row: dict[str, Any]) -> dict[str, Any]:
    access_modes = _json_dict(row.get("access_modes"))
    modes = {
        mode: _smb_mode_readable(row, access_modes, mode)
        for mode in ("null", "guest", "auth")
    }
    return {
        "modes": modes,
        "open_modes": [mode for mode, allowed in modes.items() if allowed is True],
        "share_read": _bool_or_none(row.get("share_read")),
        "share_write": _bool_or_none(row.get("share_write")),
    }


def _smb_access_for_asset(asset: Any) -> dict[str, Any] | None:
    parsed = _smb_asset_host_share(asset)
    if parsed is None:
        return None
    host, share = parsed
    with state_domain.connect() as c:
        row = c.execute(
            "SELECT null_login_ok, guest_login_ok, auth_login_ok, share_read, "
            "share_write, access_modes FROM smb_share "
            "WHERE host=? AND share=? ORDER BY last_seen DESC, id DESC LIMIT 1",
            (host, share),
        ).fetchone()
    if row is None:
        return None
    return _smb_access_from_share_row(_row_dict(row))


def _smb_owner_for_asset(asset: Any) -> dict[str, Any] | None:
    parsed = _smb_asset_host_share(asset)
    if parsed is None:
        return None
    host, _share = parsed
    return state_domain.asset_owner_get(host)


def _confidence(row: dict[str, Any]) -> float | None:
    extra = _extra(row)
    candidates = [
        extra.get("confidence"),
        (extra.get("evidence_judgment") or {}).get("confidence")
        if isinstance(extra.get("evidence_judgment"), dict) else None,
    ]
    for raw in candidates:
        if raw is None:
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        return max(0.0, min(1.0, value))
    if row.get("status") in {"false_positive", "accepted_risk"}:
        return 0.0
    return None


def _actions(row: dict[str, Any]) -> list[str]:
    extra = _extra(row)
    raw = extra.get("recommended_actions")
    if raw is None:
        raw = extra.get("next_actions")
    if raw is None:
        raw = extra.get("required_actions")
    if isinstance(raw, str):
        return [raw.strip()] if raw.strip() else []
    if isinstance(raw, list | tuple):
        return [str(item).strip() for item in raw if str(item).strip()]
    return []


def _default_next_action(row: dict[str, Any]) -> str:
    status = str(row.get("status") or "")
    severity = str(row.get("severity") or "informational")
    if status == "open" and _SEVERITY_RANK.get(severity, 0) >= 2:
        return "validate evidence, deep-dive impact, and update remediation owner"
    if status == "open":
        return "validate evidence and decide triage status"
    if status == "triaged":
        return "track owner/ticket until remediated or accepted"
    if status == "accepted_risk":
        return "review risk acceptance expiry and compensating controls"
    if status == "false_positive":
        return "retain evidence and suppress duplicate follow-up"
    if status == "remediated":
        return "verify remediation and close recurrence watch"
    return "review finding status"


def _next_action(row: dict[str, Any]) -> str:
    actions = _actions(row)
    return actions[0] if actions else _default_next_action(row)


def _fmt_epoch(ts: Any) -> str:
    """epoch float → 'YYYY-MM-DD HH:MM' (없으면 '')."""
    try:
        t = float(ts)
    except (TypeError, ValueError):
        return ""
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(t))


def _clean_summary(field: str, status: str, reason: str | None = None) -> str:
    if status == "tasked":
        base = {
            "smb": "SMB 점검 완료: 확정 finding 없음",
            "web": "Web 점검 완료: 확정 finding 없음",
            "github": "GitHub 점검 완료: 확정 finding 없음",
            "confluence": "Confluence 점검 완료: 확정 finding 없음",
        }.get(field, "점검 완료: 확정 finding 없음")
    elif status == "skipped":
        base = "점검 제외/건너뜀: 확정 finding 없음"
    elif status in {"error", "triaged_errored"}:
        base = "점검 오류: 확정 finding 없음"
    else:
        base = "점검 기록: 확정 finding 없음"
    if reason:
        return f"{base} — {reason}"
    return base


def _pivot(extra: dict[str, Any]) -> dict[str, Any] | None:
    """finding.extra['pivot'] 투영 — candidates/probes 가 있을 때만(없으면 None=숨김)."""
    p = extra.get("pivot")
    if isinstance(p, dict) and (p.get("candidates") or p.get("probes")):
        return p
    return None


def _norm_host(asset: str) -> str:
    """dedup key 용 — asset 의 host(없으면 asset 원문)."""
    return host_of(asset) or str(asset or "")


def _space_key(extra: dict[str, Any]) -> str:
    """confluence space key — finding extra['metadata']['space_key'] (없으면 '')."""
    meta = extra.get("metadata")
    if isinstance(meta, dict):
        sk = meta.get("space_key")
        if isinstance(sk, str) and sk.strip():
            return sk.strip()
    return ""


def _risk_narrative(extra: dict[str, Any]) -> dict[str, str] | None:
    """v3.76: agent 가 쓴 4부 위험내용 — 빈 subfield 는 strip, 전무하면 None(키 생략)."""
    raw = extra.get("risk_narrative")
    if not isinstance(raw, dict):
        return None
    out: dict[str, str] = {}
    for k in ("what_is_data", "how_discovered", "exploitation_path", "verification_method"):
        v = raw.get(k)
        if isinstance(v, str) and v.strip():
            out[k] = v.strip()
    return out or None


def _evidence_notes(extra: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """location → evidence note dict. agent 가 쓴 per-evidence 해설."""
    raw = extra.get("evidence_notes")
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for loc, note in raw.items():
        if isinstance(note, dict):
            out[str(loc)] = note
    return out


def _item(row: dict[str, Any], *, domain_key: str) -> dict[str, Any]:
    extra = _extra(row)
    notes = _evidence_notes(extra)
    item: dict[str, Any] = {
        "id": int(row["id"]),
        "item_type": "finding",
        "is_finding": True,
        "domain": domain_key,
        "source_task_type": row["task_type"],
        "target": str(extra.get("target") or ""),
        "asset": row["asset"],
        "asset_kind": row["asset_kind"],
        "severity": row["severity"],
        # v3.74: 위험 분류(택소노미) — hit category(없으면 asset_kind 폴백) 기반.
        "classification": classify(hits=extra.get("hits"), asset_kind=row.get("asset_kind")),
        "confidence": _confidence(row),
        "status": row["status"],
        "summary": row["summary"],
        "evidence_ref": row.get("evidence_ref"),
        "next_action": _next_action(row),
        "recommended_actions": _actions(row),
        "owner": row.get("owner"),
        "ticket_ref": row.get("ticket_ref"),
        "first_seen": row.get("first_seen"),
        "last_seen": row.get("last_seen"),
        "discovered_at": _fmt_epoch(row.get("first_seen")),
        "discovered_at_epoch": row.get("first_seen"),
        "seen_count": int(row.get("seen_count") or 0),
        "duplicate_count": 1,
        # v3.75: 발견 방식 (api 토큰스캔 / sso 브라우저). dedup 그룹이 둘 다면 'api+sso'(교차확인).
        "discovery_method": discovery_method(row["asset"]),
        "cross_confirmed": False,
        "pivot": _pivot(extra),
        "context": {
            "recommended_actions": _actions(row),
            "evidence_judgment": extra.get("evidence_judgment"),
            "hit_count": len(extra.get("hits") or [])
            if isinstance(extra.get("hits"), list) else None,
            "evidence": _hit_evidence(extra, notes),
        },
    }
    # v3.76: confluence dedup/표시용 space_key (비면 키 생략 안 함 — dedup 폴백이 참조).
    space_key = _space_key(extra)
    if space_key:
        item["space_key"] = space_key
    # v3.76: agent-writable 위험내용/pivot 해석 — 있을 때만 투영(전무 시 생략).
    narrative = _risk_narrative(extra)
    if narrative:
        item["risk_narrative"] = narrative
    pivot_interp = extra.get("pivot_interpretation")
    if isinstance(pivot_interp, str) and pivot_interp.strip():
        item["pivot_interpretation"] = pivot_interp.strip()
    # v3.78 G2: API HEAD 재확인 결과 (live_in_HEAD/historical_only/gone).
    verification = extra.get("verification")
    if isinstance(verification, dict) and verification.get("status"):
        item["verification"] = verification
    if domain_key == "smb":
        smb_access = _smb_access_for_asset(row.get("asset"))
        if smb_access is not None:
            item["smb_access"] = smb_access
        asset_owner = _smb_owner_for_asset(row.get("asset"))
        if asset_owner is not None:
            item["asset_owner"] = asset_owner
    return item


def _clean_item(
    *,
    field: str,
    source_table: str,
    source_id: int,
    asset: str,
    asset_kind: str,
    target: str,
    status: str,
    checked_at: Any,
    first_seen: Any,
    last_seen: Any,
    reason: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    summary = _clean_summary(field, status, reason)
    return {
        "id": f"clean:{source_table}:{source_id}",
        "item_type": "clean_report",
        "is_finding": False,
        "domain": field,
        "source_task_type": field,
        "target": target,
        "asset": asset,
        "asset_kind": asset_kind,
        "severity": "informational",
        "classification": {
            "key": "clean_baseline",
            "label": "이상 없음",
        },
        "classifications": [{
            "key": "clean_baseline",
            "label": "이상 없음",
        }],
        "confidence": None,
        "status": status,
        "summary": summary,
        "evidence_ref": None,
        "next_action": "정기 재검사 주기에 따라 상태를 갱신",
        "recommended_actions": [],
        "owner": None,
        "ticket_ref": None,
        "first_seen": first_seen,
        "last_seen": last_seen,
        "discovered_at": _fmt_epoch(checked_at or last_seen or first_seen),
        "discovered_at_epoch": checked_at or last_seen or first_seen,
        "seen_count": 1,
        "duplicate_count": 1,
        "discovery_method": "",
        "cross_confirmed": False,
        "context": {
            "recommended_actions": [],
            "evidence_judgment": None,
            "hit_count": 0,
            "evidence": [],
        },
        "clean_report": {
            "source_table": source_table,
            "source_id": source_id,
            "status": status,
            "checked_at": checked_at,
            "reason": reason,
            "metadata": metadata or {},
        },
    }


def _hit_evidence(
    extra: dict[str, Any], notes: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """finding hit 들에서 구체 증거(location + masked/preview)를 표에 보여줄 형태로 추출.

    v3.76: evidence_notes[location] 의 what_this_is/context_note 를 location 매칭으로 join
    (UI 가 per-evidence 로 렌더 — dict-as-string 버그 회피)."""
    hits = extra.get("hits")
    if not isinstance(hits, list):
        return []
    notes = notes or {}
    out: list[dict[str, Any]] = []
    for h in hits[:12]:
        if not isinstance(h, dict):
            continue
        ev = str(h.get("masked") or h.get("preview") or "").strip()
        if not ev:
            continue
        loc = str(h.get("location") or "")
        entry: dict[str, Any] = {
            "category": str(h.get("category") or ""),
            "location": loc,
            "evidence": ev[:600],
        }
        note = notes.get(loc)
        if isinstance(note, dict):
            wti = note.get("what_this_is")
            if isinstance(wti, str) and wti.strip():
                entry["what_this_is"] = wti.strip()
            cn = note.get("context_note")
            if isinstance(cn, str) and cn.strip():
                entry["context_note"] = cn.strip()
        out.append(entry)
    return out


def _rows_for_domain(domain_key: str, *, limit: int) -> list[dict[str, Any]]:
    domain = _DOMAIN_DEFS[domain_key]
    own = set(domain["task_types"])
    rows: list[dict[str, Any]] = []
    per_type_limit = max(limit, 1)
    for task_type in domain["task_types"]:
        rows.extend(state.finding_list(task_type=task_type, limit=per_type_limit))
    # v3.74: 레거시 'devops' umbrella row 를 자산기준으로 github/confluence/jenkins 에 분배
    # (canonical_task_type). 신규 finding 은 쓰기시점에 canon 태깅돼 'devops' 가 안 생기므로
    # 이 경로는 레거시 전용 safety-net. smb/web 도메인은 해당 service 를 안 가져 미조회.
    if own & {"github", "jenkins", "confluence"}:
        for row in state.finding_list(task_type="devops", limit=per_type_limit):
            # v3.82 U3d: 코어 canonical_task_type 은 plugin 등록형(미등록=passthrough)
            # — 도메인 서비스는 자기 소유 휴리스틱(canonicalize_by_asset)을 직접 호출.
            routed = canonicalize_by_asset("devops", row.get("asset") or "") or "devops"
            if routed == "devops":
                routed = "github"  # 식별 불가 dev-infra → github 기본
            if routed in own:
                rows.append(row)
    # v3.78 F2: false_positive(이메일-only 노이즈 소급정리 등)는 통합 뷰에서 제외.
    # 삭제가 아니라 status 필터 — DB 엔 남아 감사·복구 가능.
    rows = [row for row in rows if row.get("status") != "false_positive"]
    rows.sort(key=lambda row: (float(row.get("last_seen") or 0), int(row["id"])), reverse=True)
    return rows[:limit]


def _stats(items: list[dict[str, Any]]) -> dict[str, Any]:
    by_status: dict[str, int] = {}
    by_severity: dict[str, int] = {}
    finding_items = [item for item in items if item.get("item_type") != "clean_report"]
    clean_items = [item for item in items if item.get("item_type") == "clean_report"]
    for item in items:
        by_status[item["status"]] = by_status.get(item["status"], 0) + 1
        by_severity[item["severity"]] = by_severity.get(item["severity"], 0) + 1
    highest = "none"
    for severity in _SEVERITY_ORDER:
        if any(item["severity"] == severity for item in finding_items):
            highest = severity
            break
    return {
        "total": len(items),
        "finding_total": len(finding_items),
        "clean_total": len(clean_items),
        "open": sum(1 for item in finding_items if item["status"] in _OPEN_STATUSES),
        "highest_severity": highest,
        "by_status": by_status,
        "by_severity": by_severity,
    }


def _identity(it: dict[str, Any], domain_key: str) -> str:
    """dedup 그룹 키 = 자산 식별자만 (D2). 분류는 키에서 제거.

    smb=asset 전체 / github=github_identity /
    confluence=confluence_identity(asset) or space_key / else=_norm_host.
    식별 불가 시 host 폴백."""
    asset = it["asset"]
    if domain_key == "smb":
        return str(asset or "").strip().lower().rstrip("/")
    if domain_key == "github":
        ident = github_identity(asset)
        if ident:
            # v3.77: github 은 **repo 단위** 병합 — github_identity 는 'org/repo::file'(또는
            # commit 은 'org/repo::sha')를 주는데, sha/파일이 매 commit 유일이라 병합이 안 됐다.
            # ::tail 을 떼어 'org/repo' 로 그룹핑(파일/commit 디테일은 members[] 보존).
            return ident.split("::", 1)[0]
    elif domain_key == "confluence":
        # confluence_identity(도메인 서비스 finding_identity 소유)가 우선,
        # 식별 불가(legacy confluence:42 등)면 space_key 폴백.
        ident = confluence_identity(asset)
        if ident:
            return str(ident)
        sk = it.get("space_key")
        if isinstance(sk, str) and sk.strip():
            return sk.strip().lower()
    return _norm_host(asset)


def _merge_classifications(grp: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """그룹 전체의 unique {key,label} 분류 리스트 (category 우선순위 desc 정렬)."""
    seen: dict[str, dict[str, Any]] = {}
    for it in grp:
        cls = it.get("classification") or {}
        key = str(cls.get("key") or "")
        if key and key not in seen:
            seen[key] = {"key": key, "label": classification_label(key)}
    return sorted(seen.values(), key=lambda c: category_rank(c["key"]), reverse=True)


def _dedup(items: list[dict[str, Any]], domain_key: str) -> list[dict[str, Any]]:
    """도메인/분야 내 dedup — key=자산식별자만 (D2). 대표=심각도↑→최근→id↑.

    v3.76: 분류를 키에서 제거 → 같은 식별자면 분류 달라도 1행 병합. 그룹별:
    - severity = 그룹 max (명시적 override)
    - classifications = 그룹 전체 unique {key,label} (category 우선순위 desc)
    - classification(단수) = classifications[0] (back-compat 유지)
    - duplicate_count = len(grp), members = 병합 item 전체(cap 50)
    - api+sso 동시면 cross_confirmed."""
    groups: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    for it in items:
        key = _identity(it, domain_key)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(it)
    out: list[dict[str, Any]] = []
    for key in order:
        grp = groups[key]
        rep = max(grp, key=lambda x: (
            _SEVERITY_RANK.get(x["severity"], 0),
            float(x.get("last_seen") or 0),
            int(x["id"]),
        ))
        max_severity = max(
            (x["severity"] for x in grp),
            key=lambda s: _SEVERITY_RANK.get(s, 0),
        )
        methods = {it.get("discovery_method") for it in grp if it.get("discovery_method")}
        cross = {"api", "sso"} <= methods
        method = "api+sso" if cross else rep.get("discovery_method", "")
        classifications = _merge_classifications(grp)
        merged = {
            **rep,
            "severity": max_severity,
            "duplicate_count": len(grp),
            "discovery_method": method,
            "cross_confirmed": cross,
            "classifications": classifications,
            "members": grp[:50],
        }
        if classifications:
            merged["classification"] = classifications[0]
        out.append(merged)
    out.sort(key=lambda x: (
        _SEVERITY_RANK.get(x["severity"], 0), float(x.get("last_seen") or 0),
    ), reverse=True)
    return out


# field(분야) — 통합 Findings 메뉴의 분야 컬럼. domain_key 와 1:1 이지만 라벨 표기.
_FIELD_LABELS = {
    "smb": "SMB",
    "web": "Web",
    "github": "GitHub",
    "confluence": "Confluence",
}


def build_field_items(field: str, *, limit: int) -> list[dict[str, Any]]:
    """한 분야(field=domain_key)의 dedup 된 finding item 리스트.

    get_domain_report / list_all_findings 가 공유 (분야 내에서만 dedup)."""
    raw_items = [
        _item(row, domain_key=field)
        for row in _rows_for_domain(field, limit=limit)
    ]
    return _dedup(raw_items, field)


def _append_clean_item(
    out: list[dict[str, Any]],
    item: dict[str, Any],
    *,
    field: str,
    existing_identities: set[str],
    seen: set[str],
) -> None:
    ident = _identity(item, field)
    if not ident or ident in existing_identities or ident in seen:
        return
    seen.add(ident)
    out.append(item)


def _terminal_status_placeholders(values: set[str]) -> str:
    return ",".join("?" for _ in values)


def _clean_web_items(*, limit: int, existing: list[dict[str, Any]]) -> list[dict[str, Any]]:
    statuses = tuple(sorted(_TERMINAL_TARGET_STATUSES))
    with state_domain.connect() as c:
        rows = c.execute(
            "SELECT * FROM web_target_domain "
            f"WHERE status IN ({_terminal_status_placeholders(set(statuses))}) "
            "AND COALESCE(finding_count, 0)=0 "
            "ORDER BY COALESCE(last_task_at, last_seen_at, discovered_at) DESC, id DESC "
            "LIMIT ?",
            (*statuses, limit),
        ).fetchall()
    existing_identities = {_identity(it, "web") for it in existing}
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        r = _row_dict(row)
        domain = str(r.get("domain") or "")
        item = _clean_item(
            field="web",
            source_table="web_target_domain",
            source_id=int(r["id"]),
            asset=f"https://{domain}" if "://" not in domain else domain,
            asset_kind="web_target",
            target=domain,
            status=str(r.get("status") or "tasked"),
            checked_at=r.get("last_task_at"),
            first_seen=r.get("discovered_at"),
            last_seen=r.get("last_seen_at"),
            reason=r.get("last_reason"),
            metadata={
                "source": r.get("source"),
                "day_bucket": r.get("day_bucket"),
                "event_count": int(r.get("event_count") or 0),
            },
        )
        _append_clean_item(out, item, field="web", existing_identities=existing_identities, seen=seen)
    return out


def _clean_devops_items(
    *, field: str, service: str, limit: int, existing: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    statuses = tuple(sorted(_TERMINAL_TARGET_STATUSES))
    with state_domain.connect() as c:
        rows = c.execute(
            "SELECT * FROM devops_target "
            f"WHERE service=? AND status IN ({_terminal_status_placeholders(set(statuses))}) "
            "AND COALESCE(finding_count, 0)=0 "
            "ORDER BY COALESCE(last_task_at, last_seen_at, discovered_at) DESC, id DESC "
            "LIMIT ?",
            (service, *statuses, limit),
        ).fetchall()
    existing_identities = {_identity(it, field) for it in existing}
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        r = _row_dict(row)
        url = str(r.get("url") or "")
        item = _clean_item(
            field=field,
            source_table="devops_target",
            source_id=int(r["id"]),
            asset=url,
            asset_kind="url",
            target=host_of(url) or url,
            status=str(r.get("status") or "tasked"),
            checked_at=r.get("last_task_at"),
            first_seen=r.get("discovered_at"),
            last_seen=r.get("last_seen_at"),
            reason=r.get("last_reason"),
            metadata={
                "service": r.get("service"),
                "source": r.get("source"),
                "day_bucket": r.get("day_bucket"),
                "access_count": int(r.get("access_count") or 0),
            },
        )
        _append_clean_item(out, item, field=field, existing_identities=existing_identities, seen=seen)
    return out


def _clean_github_repo_items(*, limit: int, existing: list[dict[str, Any]]) -> list[dict[str, Any]]:
    statuses = tuple(sorted(_TERMINAL_TARGET_STATUSES))
    with state_domain.connect() as c:
        rows = c.execute(
            "SELECT * FROM github_repo_target "
            f"WHERE status IN ({_terminal_status_placeholders(set(statuses))}) "
            "AND COALESCE(finding_count, 0)=0 "
            "ORDER BY COALESCE(last_scanned_at, last_seen, first_seen) DESC, id DESC "
            "LIMIT ?",
            (*statuses, limit),
        ).fetchall()
    existing_identities = {_identity(it, "github") for it in existing}
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        r = _row_dict(row)
        repo = str(r.get("repo") or "")
        item = _clean_item(
            field="github",
            source_table="github_repo_target",
            source_id=int(r["id"]),
            asset=f"github:{repo}",
            asset_kind="repository",
            target=repo,
            status=str(r.get("status") or "tasked"),
            checked_at=r.get("last_scanned_at"),
            first_seen=r.get("first_seen"),
            last_seen=r.get("last_seen"),
            reason=r.get("last_reason"),
            metadata={
                "repo": repo,
                "default_branch": r.get("default_branch"),
                "pushed_at": r.get("pushed_at"),
                "last_scanned_sha": r.get("last_scanned_sha"),
            },
        )
        _append_clean_item(out, item, field="github", existing_identities=existing_identities, seen=seen)
    return out


def _clean_confluence_space_items(*, limit: int, existing: list[dict[str, Any]]) -> list[dict[str, Any]]:
    statuses = tuple(sorted(_TERMINAL_TARGET_STATUSES))
    with state_domain.connect() as c:
        rows = c.execute(
            "SELECT * FROM confluence_space_target "
            f"WHERE status IN ({_terminal_status_placeholders(set(statuses))}) "
            "AND COALESCE(finding_count, 0)=0 "
            "ORDER BY COALESCE(last_scanned_at, last_seen, first_seen) DESC, id DESC "
            "LIMIT ?",
            (*statuses, limit),
        ).fetchall()
    existing_identities = {_identity(it, "confluence") for it in existing}
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        r = _row_dict(row)
        space_key = str(r.get("space_key") or "")
        item = _clean_item(
            field="confluence",
            source_table="confluence_space_target",
            source_id=int(r["id"]),
            asset=f"confluence:{space_key}:space",
            asset_kind="confluence_space",
            target=str(r.get("space_name") or space_key),
            status=str(r.get("status") or "tasked"),
            checked_at=r.get("last_scanned_at"),
            first_seen=r.get("first_seen"),
            last_seen=r.get("last_seen"),
            reason=r.get("last_reason"),
            metadata={
                "space_key": space_key,
                "space_name": r.get("space_name"),
                "space_type": r.get("space_type"),
            },
        )
        item["space_key"] = space_key
        _append_clean_item(
            out, item, field="confluence",
            existing_identities=existing_identities, seen=seen,
        )
    return out


def _smb_review_is_issue(row: dict[str, Any]) -> bool:
    if row.get("severity") in _ISSUE_SEVERITIES:
        return True
    review = _json_dict(row.get("listing_review"))
    return str(review.get("severity") or "") in _ISSUE_SEVERITIES


def _clean_smb_items(*, limit: int, existing: list[dict[str, Any]]) -> list[dict[str, Any]]:
    statuses = tuple(sorted(_SMB_TERMINAL_STATUSES))
    with state_domain.connect() as c:
        rows = c.execute(
            "SELECT s.*, "
            "  (SELECT COUNT(*) FROM smb_file f WHERE f.share_id=s.id) AS file_total, "
            "  (SELECT COUNT(*) FROM smb_file f WHERE f.share_id=s.id "
            "   AND f.review_status='reviewed' "
            "   AND f.review_severity IN ('critical','high','medium')) AS reviewed_issue_file_total, "
            "  (SELECT COUNT(*) FROM smb_file_hit h JOIN smb_file f ON f.id=h.file_id "
            "   WHERE f.share_id=s.id AND h.agent_verdict='confirmed') AS confirmed_hit_total "
            "FROM smb_share s "
            f"WHERE s.status IN ({_terminal_status_placeholders(set(statuses))}) "
            "ORDER BY COALESCE(s.processed_at, s.listing_review_at, s.walk_done_at, s.last_seen) DESC, s.id DESC "
            "LIMIT ?",
            (*statuses, limit),
        ).fetchall()
    existing_identities = {_identity(it, "smb") for it in existing}
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        r = _row_dict(row)
        if _smb_review_is_issue(r) or int(r.get("reviewed_issue_file_total") or 0) > 0:
            continue
        asset = f"smb://{r.get('host')}/{r.get('share')}"
        item = _clean_item(
            field="smb",
            source_table="smb_share",
            source_id=int(r["id"]),
            asset=asset,
            asset_kind="smb_share",
            target=str(r.get("host") or ""),
            status=str(r.get("status") or "walked"),
            checked_at=r.get("processed_at") or r.get("listing_review_at") or r.get("walk_done_at"),
            first_seen=r.get("first_seen"),
            last_seen=r.get("last_seen"),
            reason=r.get("summary"),
            metadata={
                "subnet": r.get("subnet"),
                "share": r.get("share"),
                "file_total": int(r.get("file_total") or 0),
                "confirmed_hit_total": int(r.get("confirmed_hit_total") or 0),
            },
        )
        item["smb_access"] = _smb_access_from_share_row(r)
        asset_owner = state_domain.asset_owner_get(str(r.get("host") or ""))
        if asset_owner is not None:
            item["asset_owner"] = asset_owner
        _append_clean_item(out, item, field="smb", existing_identities=existing_identities, seen=seen)
    return out


def build_clean_items(field: str, *, limit: int, existing: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if field == "smb":
        return _clean_smb_items(limit=limit, existing=existing)
    if field == "web":
        return _clean_web_items(limit=limit, existing=existing)
    if field == "github":
        return (
            _clean_github_repo_items(limit=limit, existing=existing)
            + _clean_devops_items(field="github", service="github", limit=limit, existing=existing)
        )[:limit]
    if field == "confluence":
        return (
            _clean_confluence_space_items(limit=limit, existing=existing)
            + _clean_devops_items(
                field="confluence", service="confluence", limit=limit, existing=existing,
            )
        )[:limit]
    return []


def get_domain_report(domain_key: str, *, limit: int = 100) -> dict[str, Any]:
    if domain_key not in _DOMAIN_DEFS:
        raise ValueError(f"invalid domain report: {domain_key!r}")
    limit = max(1, min(int(limit), 500))
    domain = _DOMAIN_DEFS[domain_key]
    items = build_field_items(domain_key, limit=limit)
    return {
        "metadata": {
            "kind": "domain_finding_report",
            "generated_at": time.time(),
            "domain": domain_key,
            "label": domain["label"],
            "task_types": list(domain["task_types"]),
            "limit": limit,
        },
        "required": list(domain["required"]),
        "stats": _stats(items),
        "items": items,
    }


def list_domain_reports(*, limit: int = 100) -> dict[str, Any]:
    items = [get_domain_report(key, limit=limit) for key in domain_keys()]
    return {
        "total": len(items),
        "items": items,
    }


def _facets(items: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """통합 Findings 필터 facet 카운트 — field/severity/classification/status/
    discovery_method/cross_confirmed 별 {key,label,count}."""
    def _count(pairs: list[tuple[str, str]]) -> list[dict[str, Any]]:
        counts: dict[str, int] = {}
        labels: dict[str, str] = {}
        order: list[str] = []
        for key, label in pairs:
            if key not in counts:
                counts[key] = 0
                labels[key] = label
                order.append(key)
            counts[key] += 1
        return [{"key": k, "label": labels[k], "count": counts[k]} for k in order]

    field_pairs: list[tuple[str, str]] = []
    severity_pairs: list[tuple[str, str]] = []
    classification_pairs: list[tuple[str, str]] = []
    status_pairs: list[tuple[str, str]] = []
    method_pairs: list[tuple[str, str]] = []
    cross_pairs: list[tuple[str, str]] = []
    visibility_pairs: list[tuple[str, str]] = []
    for it in items:
        field = str(it.get("field") or it.get("domain") or "")
        field_pairs.append((field, str(it.get("field_label") or _FIELD_LABELS.get(field, field))))
        severity_pairs.append((str(it["severity"]), str(it["severity"])))
        for cls in (it.get("classifications") or [it.get("classification") or {}]):
            ckey = str(cls.get("key") or "")
            if ckey:
                classification_pairs.append((ckey, str(cls.get("label") or classification_label(ckey))))
        status_pairs.append((str(it["status"]), str(it["status"])))
        method = str(it.get("discovery_method") or "")
        if method:
            method_pairs.append((method, method))
        cross_pairs.append(
            ("cross_confirmed", "교차확인") if it.get("cross_confirmed") else ("single", "단일"),
        )
        visibility_pairs.append(
            ("clean", "이상 없음") if it.get("item_type") == "clean_report"
            else ("finding", "파인딩")
        )
    return {
        "field": _count(field_pairs),
        "severity": _count(severity_pairs),
        "classification": sorted(
            _count(classification_pairs),
            key=lambda c: category_rank(c["key"]), reverse=True,
        ),
        "status": _count(status_pairs),
        "discovery_method": _count(method_pairs),
        "cross_confirmed": _count(cross_pairs),
        "visibility": _count(visibility_pairs),
    }


def list_all_findings(*, limit: int = 100, include_clean: bool = False) -> dict[str, Any]:
    """v3.76: 통합 Findings — 4개 분야(field)의 dedup 된 finding 을 단일 flat 리스트로.

    각 field 내에서만 dedup(교차-field 병합 금지) 후 연결. item 에 field/field_label 부착.
    반환: {metadata, items, stats, facets}."""
    limit = max(1, min(int(limit), 500))
    items: list[dict[str, Any]] = []
    for field in domain_keys():
        field_label = _FIELD_LABELS.get(field, field)
        field_items = build_field_items(field, limit=limit)
        if include_clean:
            field_items = field_items + build_clean_items(
                field, limit=limit, existing=field_items,
            )
        for it in field_items:
            it = {**it, "field": field, "field_label": field_label}
            items.append(it)
    return {
        "metadata": {
            "kind": "all_findings",
            "generated_at": time.time(),
            "fields": list(domain_keys()),
            "limit": limit,
            "include_clean": include_clean,
        },
        "items": items,
        "stats": _stats(items),
        "facets": _facets(items),
    }
