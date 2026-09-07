"""GET /api/agents/* — dashboard adapter for pipeline agent sessions."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, HTTPException

from domains.smb.application.contracts import SA_SESSION_ID
from service import state_domain as state
from service.services import agent_transcripts

router = APIRouter(prefix="/api/agents")

_AGENTS = {
    "task": {"label": "#1 점검 에이전트", "stage": "점검"},
    "mail": {"label": "#2 조치요청 에이전트", "stage": "리포팅·메일"},
    "reverify": {"label": "#3 답장·재검증", "stage": "답장·재검증"},
}

_SHARE_STATUS_LABELS = {
    "pending": "대기",
    "walked": "워킹 완료",
    "listing_reviewed": "목록 검토 완료",
    "in_progress": "진행 중",
    "triaged_completed": "점검 완료",
    "triaged_errored": "점검 오류",
    "ignored": "큐 제외",
    "closed": "완결",
}

_THREAD_STATUS_LABELS = {
    "draft": "레포트 초안",
    "reported": "레포트 정리 완료",
    "awaiting_reply": "메일 발송 후 회신 대기",
    "reply_received": "회신 수신",
    "reverifying": "재검증 중",
    "re_requested": "재조치 요청",
    "partially_remediated": "부분 조치 확인",
    "exception_review": "업무 예외 검토",
    "owner_update_needed": "담당자 확인 필요",
    "owner_reassignment_review": "담당자 변경 검토",
    "reassigned": "담당자 이관",
    "remediated": "조치 완료",
    "escalated": "에스컬레이션",
}


def _dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def _share_status_label(status: Any) -> str:
    value = str(status or "")
    return _SHARE_STATUS_LABELS.get(value, value or "-")


def _thread_status_label(status: Any) -> str:
    value = str(status or "")
    return _THREAD_STATUS_LABELS.get(value, value or "-")


def _age(ts: float | None) -> str:
    if not ts:
        return "기록 없음"
    sec = max(0, int(time.time() - float(ts)))
    if sec < 60:
        return f"{sec}s 전"
    if sec < 3600:
        return f"{sec // 60}m 전"
    if sec < 86400:
        return f"{sec // 3600}h 전"
    return f"{sec // 86400}d 전"


def _heartbeats(c) -> dict[str, dict[str, Any]]:
    rows = c.execute("SELECT * FROM pipeline_heartbeat").fetchall()
    out: dict[str, dict[str, Any]] = {}
    now = time.time()
    for r in rows:
        d = _dict(r)
        d["age_sec"] = round(now - float(d.get("last_beat") or 0), 1)
        d["alive"] = bool(d["age_sec"] < 600)
        out[str(d["component"])] = d
    return out


def _latest_run(c, component: str) -> dict[str, Any] | None:
    row = c.execute(
        "SELECT * FROM pipeline_run WHERE component=? "
        "ORDER BY started_at DESC LIMIT 1",
        (component,),
    ).fetchone()
    return _dict(row) if row else None


def _count(c, sql: str, args: tuple[Any, ...] = ()) -> int:
    row = c.execute(sql, args).fetchone()
    return int(row[0] or 0) if row else 0


def _task_fanout(c, limit: int = 8) -> list[dict[str, Any]]:
    now = time.time()
    stale_cutoff = now - state.SMB_CLAIM_STALE_SECONDS
    rows = c.execute(
        "SELECT id, host, share, status, severity, hits_count, claimed_by, claimed_at, "
        "COALESCE(processed_at, walk_done_at, last_seen, first_seen) AS updated_at "
        "FROM smb_share "
        "WHERE status IN ('in_progress','walked','listing_reviewed','triaged_completed','triaged_errored') "
        "ORDER BY "
        "CASE WHEN status='in_progress' AND claimed_by=? AND claimed_at >= ? THEN 0 "
        "     WHEN status IN ('walked','listing_reviewed') THEN 1 "
        "     WHEN status='in_progress' AND claimed_by=? AND (claimed_at IS NULL OR claimed_at < ?) THEN 1 "
        "     WHEN severity IS NOT NULL THEN 2 ELSE 3 END, "
        "updated_at DESC LIMIT ?",
        (SA_SESSION_ID, stale_cutoff, SA_SESSION_ID, stale_cutoff, limit),
    ).fetchall()
    items = []
    for r in rows:
        d = _dict(r)
        row_status = str(d.get("status") or "")
        claimed_at = d.get("claimed_at")
        is_fresh_task_claim = (
            row_status == "in_progress"
            and int(d.get("claimed_by") or 0) == SA_SESSION_ID
            and claimed_at is not None
            and float(claimed_at) >= stale_cutoff
        )
        is_stale_task_claim = (
            row_status == "in_progress"
            and int(d.get("claimed_by") or 0) == SA_SESSION_ID
            and (claimed_at is None or float(claimed_at) < stale_cutoff)
        )
        if is_fresh_task_claim:
            status = "active"
        elif row_status in {"walked", "listing_reviewed"} or is_stale_task_claim:
            status = "queued"
        elif d.get("severity"):
            status = "finding"
        else:
            status = "done"
        items.append({
            "id": f"share-{int(d['id'])}",
            "title": f"\\\\{d['host']}\\{d['share']}",
            "subtitle": f"{_share_status_label(row_status)} · hits {int(d.get('hits_count') or 0)}",
            "status": status,
            "status_label": _share_status_label(row_status),
            "target": {
                "kind": "smb_share",
                "host": d.get("host"),
                "share": d.get("share"),
                "display": f"\\\\{d['host']}\\{d['share']}",
            },
            "updated_at": d.get("updated_at"),
        })
    return items


def _thread_fanout(
    c,
    component: str,
    *,
    cycle_key: str,
    limit: int = 8,
) -> list[dict[str, Any]]:
    if component == "mail":
        statuses = ("reported", "awaiting_reply")
    else:
        statuses = (
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
        )
    placeholders = ",".join("?" for _ in statuses)
    rows = c.execute(
        f"SELECT * FROM mail_thread WHERE status IN ({placeholders}) "
        "AND last_cycle_key=? ORDER BY updated_at DESC LIMIT ?",
        (*statuses, cycle_key, max(limit * 8, 32)),
    ).fetchall()
    by_host: dict[str, dict[str, Any]] = {}
    items = []
    for r in rows:
        d = _dict(r)
        host = str(d.get("host") or f"thread-{d['id']}")
        cur = by_host.setdefault(host, {
            "latest": d,
            "count": 0,
            "statuses": set(),
        })
        cur["count"] += 1
        cur["statuses"].add(d.get("status") or "unknown")
        if float(d.get("updated_at") or 0) > float(cur["latest"].get("updated_at") or 0):
            cur["latest"] = d
    for host, grouped in by_host.items():
        d = grouped["latest"]
        statuses_text = ", ".join(_thread_status_label(s) for s in sorted(grouped["statuses"]))
        items.append({
            "id": f"thread-{int(d['id'])}",
            "title": host,
            "subtitle": f"IP thread {grouped['count']}건 · {statuses_text} · attempt {int(d.get('attempt_count') or 0)}",
            "status": d.get("status") or "unknown",
            "status_label": _thread_status_label(d.get("status")),
            "target": {
                "kind": "mail_thread",
                "host": host,
                "thread_id": int(d["id"]),
                "display": host,
            },
            "updated_at": d.get("updated_at"),
        })
    items.sort(key=lambda x: float(x.get("updated_at") or 0), reverse=True)
    return items[:limit]


def _main_line(
    component: str,
    hb: dict[str, Any] | None,
    run: dict[str, Any] | None,
    queue: int,
    *,
    active: bool = False,
) -> str:
    phase = (hb or {}).get("phase") or ("task" if component == "task" and active else "stale")
    liveness = "가동" if ((hb or {}).get("alive") or active) else "중단"
    detail = (run or {}).get("detail") or (run or {}).get("status") or "run 기록 없음"
    beat_age = _age((hb or {}).get("last_beat"))
    unit = "개" if component == "task" else "대"
    return f"{phase} · {liveness} · 대기 {queue}{unit} · {detail} · heartbeat {beat_age}"


@router.get("/overview")
def overview() -> dict[str, Any]:
    with state.connect() as c:
        cycle_key = state.smb_current_cycle_key()
        hb = _heartbeats(c)
        queues = {
            "task": _count(
                c,
                "SELECT COUNT(*) FROM smb_share "
                "WHERE status IN ('walked','listing_reviewed') "
                "OR (status='in_progress' AND claimed_by=? AND (claimed_at IS NULL OR claimed_at < ?))",
                (SA_SESSION_ID, time.time() - state.SMB_CLAIM_STALE_SECONDS),
            ),
            "mail": _count(
                c,
                "SELECT COUNT(DISTINCT host) FROM mail_thread "
                "WHERE status='reported' AND last_cycle_key=?",
                (cycle_key,),
            ),
            "reverify": _count(
                c,
                "SELECT COUNT(DISTINCT host) FROM mail_thread "
                "WHERE (status='reverifying' OR "
                "(status='reply_received' AND (retry_after IS NULL OR retry_after <= ?))) "
                "AND last_cycle_key=?",
                (time.time(), cycle_key),
            ),
        }
        agents = []
        for component, meta in _AGENTS.items():
            flag = state.control_flag_get(component)
            run = _latest_run(c, component)
            fanout = (
                _task_fanout(c)
                if component == "task"
                else _thread_fanout(c, component, cycle_key=cycle_key)
            )
            h = hb.get(component)
            active = any((it.get("status") or "") in {"active", "reverifying"} for it in fanout)
            agents.append({
                "component": component,
                "label": meta["label"],
                "stage": meta["stage"],
                "enabled": bool(int(flag["enabled"])),
                "alive": bool((h and h.get("alive")) or active),
                "phase": (h or {}).get("phase"),
                "main_line": _main_line(component, h, run, queues[component], active=active),
                "queue": queues[component],
                "sessions": fanout,
            })
    return {"agents": agents, "cycle_key": cycle_key, "generated_at": time.time()}


def _message(role: str, text: str, ts: float | None = None) -> dict[str, Any]:
    return {"role": role, "content": {"text": text}, "created_at": ts or time.time()}


def _apply_transcript(
    session: dict[str, Any],
    component: str,
    session_ref: str,
) -> dict[str, Any]:
    try:
        transcript = agent_transcripts.transcript_session(
            component,  # type: ignore[arg-type]
            session_ref,
        )
    except Exception:  # noqa: BLE001 — dashboard fallback must remain available.
        transcript = None
    if not transcript:
        return session
    merged = dict(session)
    merged["source"] = transcript["source"]
    merged["messages"] = transcript["messages"]
    merged["transcript"] = transcript["transcript"]
    return merged


def _host_session(host: str) -> dict[str, Any]:
    with state.connect() as c:
        rows = c.execute(
            "SELECT host, share, status, severity, summary, hits_count, "
            "COALESCE(processed_at, walk_done_at, last_seen, first_seen) AS updated_at "
            "FROM smb_share WHERE host=? ORDER BY updated_at DESC LIMIT 12",
            (host,),
        ).fetchall()
    if not rows:
        raise HTTPException(404, f"host session not found: {host}")
    shares = [_dict(r) for r in rows]
    messages = [
        _message("system", f"#1 점검 에이전트 fan-out session · {host}", shares[0].get("updated_at")),
        _message("user", f"{host}의 SMB 공유를 worker별로 분리해 판정합니다."),
    ]
    for s in shares:
        sev = s.get("severity") or "-"
        summary = (s.get("summary") or "").strip() or "요약 없음"
        messages.append(_message(
            "assistant",
            f"공유 \\\\{host}\\{s.get('share')}\n"
            f"상태: {_share_status_label(s.get('status'))}\n"
            f"위험도: {sev}\n"
            f"확인된 hit: {s.get('hits_count') or 0}건\n"
            f"{summary}",
            s.get("updated_at"),
        ))
    session = {
        "id": f"host-{host}",
        "component": "task",
        "title": host,
        "source": "pipeline-adapter",
        "stage": _AGENTS["task"]["stage"],
        "target": {"kind": "smb_host", "host": host, "display": host},
        "messages": messages,
    }
    return _apply_transcript(session, "task", f"host-{host}")


def _share_session(share_id: int) -> dict[str, Any]:
    with state.connect() as c:
        row = c.execute(
            "SELECT * FROM smb_share WHERE id=?",
            (share_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(404, f"share session not found: {share_id}")
        share = _dict(row)
        files = c.execute(
            "SELECT id, path, size, suspicious_name, hits_count, scan_status "
            "FROM smb_file WHERE share_id=? "
            "ORDER BY suspicious_name DESC, hits_count DESC, path LIMIT 20",
            (share_id,),
        ).fetchall()
    host = share.get("host")
    name = share.get("share")
    target = f"\\\\{host}\\{name}"
    status_label = _share_status_label(share.get("status"))
    messages = [
        _message("system", f"#1 점검 share worker · share_id={share_id}", share.get("updated_at")),
        _message("user", f"대상 공유 {target}의 노출 여부를 조사합니다. 현재 단계는 {status_label}입니다."),
        _message(
            "assistant",
            f"점검 상태: {status_label}\n"
            f"위험도: {share.get('severity') or '-'}\n"
            f"확인된 hit: {share.get('hits_count') or 0}건\n"
            f"{(share.get('summary') or '').strip() or '요약 없음'}",
            share.get("processed_at") or share.get("walk_done_at") or share.get("last_seen"),
        ),
    ]
    for f in [_dict(r) for r in files]:
        messages.append(_message(
            "assistant",
            f"{f.get('path')} · suspicious={f.get('suspicious_name')} "
            f"hits={f.get('hits_count') or 0} scan={f.get('scan_status') or '-'}",
        ))
    session = {
        "id": f"share-{share_id}",
        "component": "task",
        "title": target,
        "source": "share-worker",
        "stage": _AGENTS["task"]["stage"],
        "status": share.get("status"),
        "status_label": status_label,
        "target": {
            "kind": "smb_share",
            "host": host,
            "share": name,
            "display": target,
        },
        "share": share,
        "messages": messages,
    }
    return _apply_transcript(session, "task", f"share-{share_id}")


def _thread_session(component: str, thread_id: int) -> dict[str, Any]:
    thread = state.mail_thread_get(thread_id)
    if thread is None:
        raise HTTPException(404, f"thread session not found: {thread_id}")
    mail = state.mail_messages_for_thread(thread_id)
    label = _AGENTS[component]["label"]
    status_label = _thread_status_label(thread.get("status"))
    messages = [
        _message("system", f"{label} fan-out session · thread_id={thread_id}", thread.get("created_at")),
        _message(
            "user",
            f"{thread.get('host')}의 finding {thread.get('finding_id')} 조치 흐름을 정리합니다. 현재 단계는 {status_label}입니다.",
            thread.get("created_at"),
        ),
    ]
    if mail:
        for m in mail:
            role = "user" if m.get("direction") == "in" else "assistant"
            subject = m.get("subject") or "(제목 없음)"
            body = (m.get("body_excerpt") or "").strip()
            verdict = m.get("agent_verdict") or "-"
            messages.append(_message(role, f"{subject} · verdict={verdict}\n{body}", m.get("received_at")))
    else:
        reason = thread.get("last_reason") or "메일 메시지 기록 없음"
        messages.append(_message("assistant", reason, thread.get("updated_at")))
    session = {
        "id": f"thread-{thread_id}",
        "component": component,
        "title": f"{thread.get('host')} · thread {thread_id}",
        "source": "pipeline-adapter",
        "stage": _AGENTS[component]["stage"],
        "status": thread.get("status"),
        "status_label": status_label,
        "target": {
            "kind": "mail_thread",
            "host": thread.get("host"),
            "thread_id": thread_id,
            "display": thread.get("host"),
        },
        "thread": thread,
        "messages": messages,
    }
    return _apply_transcript(session, component, f"thread-{thread_id}")


@router.get("/sessions/{component}/{session_ref}")
def session_detail(component: str, session_ref: str) -> dict[str, Any]:
    if component not in _AGENTS:
        raise HTTPException(400, f"unknown component: {component}")
    if component == "task" and session_ref.startswith("host-"):
        return _host_session(session_ref.removeprefix("host-"))
    if component == "task" and session_ref.startswith("share-"):
        try:
            share_id = int(session_ref.removeprefix("share-"))
        except ValueError as e:
            raise HTTPException(400, f"invalid share ref: {session_ref}") from e
        return _share_session(share_id)
    if component in {"mail", "reverify"} and session_ref.startswith("thread-"):
        try:
            thread_id = int(session_ref.removeprefix("thread-"))
        except ValueError as e:
            raise HTTPException(400, f"invalid thread ref: {session_ref}") from e
        return _thread_session(component, thread_id)
    raise HTTPException(404, f"session not found: {component}/{session_ref}")
