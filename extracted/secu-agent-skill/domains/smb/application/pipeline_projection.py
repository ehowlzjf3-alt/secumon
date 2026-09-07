"""SMB pipeline read-model projection.

E2E 흐름을 컴포넌트→세부단계 트리로 구성해, 각 단계의 [대상/처리/산출] 숫자와 큐
깊이, liveness 를 한 번에 준다. 무거운 GROUP BY 는 한 connection 안에서 한 번씩만.

흐름:
  수집 cronjob ─ 스윕 → 워킹 → 담당자조회
      → #1 점검 에이전트 (적대적 판정)
      → #2 리포팅·메일 (조치요청)
      → #3 답장수신 → 재검증 → 완결
"""
from __future__ import annotations

import time
from typing import Any

from domains.smb.application.contracts import (
    COLLECTOR_SESSION_ID,
    COMPONENT_COLLECTOR,
    COMPONENT_TASK,
    COMPONENT_MAIL,
    COMPONENT_REVERIFY,
    SA_SESSION_ID,
    MAIL_SESSION_ID,
    PHASE_TASK,
    PHASE_REPORT_MAIL,
    PHASE_REVERIFY,
    REVERIFY_SESSION_ID,
)
from domains.smb.application.ports import PipelineProjectionStorePort


def _heartbeat_map(c) -> dict[str, dict[str, Any]]:
    now = time.time()
    out: dict[str, dict[str, Any]] = {}
    rows = c.execute("SELECT * FROM pipeline_heartbeat ORDER BY component").fetchall()
    for hb in rows:
        age = now - (hb["last_beat"] or 0)
        out[hb["component"]] = {
            "phase": hb["phase"], "detail": hb["detail"], "pid": hb["pid"],
            "last_beat": hb["last_beat"], "age_sec": round(age, 1),
            "alive": age < 600,
        }
    return out


def _one(c, q: str, args=()) -> int:
    r = c.execute(q, args).fetchone()
    return int(r[0]) if r and r[0] is not None else 0


def _share_status_counts(c) -> dict[str, int]:
    rows = c.execute("SELECT status, COUNT(*) AS n FROM smb_share GROUP BY status").fetchall()
    return {r["status"]: int(r["n"]) for r in rows}


def _thread_status_counts(c) -> dict[str, int]:
    rows = c.execute("SELECT status, COUNT(*) AS n FROM mail_thread GROUP BY status").fetchall()
    return {r["status"]: int(r["n"]) for r in rows}


def _col(c, q, args=()) -> list[str]:
    return [str(r[0]) for r in c.execute(q, args).fetchall() if r[0] is not None]


def _share_targets(c, q, args=()) -> list[dict[str, str]]:
    return [
        {
            "label": f"\\\\{r['host']}\\{r['share']}",
            "component": "task",
            "session_ref": f"share-{int(r['id'])}",
        }
        for r in c.execute(q, args).fetchall()
        if r["id"] is not None and r["host"] is not None and r["share"] is not None
    ]


def _stage_targets(
    c,
    store: PipelineProjectionStorePort,
    cycle_key: str,
) -> dict[str, dict[str, list[str]]]:
    """각 단계의 '현재 진행중' 대상 + 없으면 '다음 대기' head. UI 카드 표시용.

    sweep=subnet, 나머지=IP(host). 진행중(claim된)이 우선, 없으면 큐 head.
    """
    out: dict[str, dict[str, list[str]]] = {}
    now = time.time()
    # ① 스윕: claim 된 subnet(진행중) → 없으면 due 대기 head
    active = _col(c, "SELECT subnet FROM smb_target_subnet WHERE claimed_at IS NOT NULL "
                    "AND claimed_at >= ? AND cycle_key=? ORDER BY claimed_at ASC LIMIT 10",
                  (now - store.smb_subnet_claim_stale_seconds, cycle_key))
    nextq = _col(c, "SELECT subnet FROM smb_target_subnet WHERE enabled=1 AND claimed_at IS NULL "
                    "AND cycle_key=? AND cycle_swept_at IS NULL "
                    "ORDER BY id ASC LIMIT 10",
                 (cycle_key,))
    out["sweep"] = {"active": active, "next": nextq}
    # ② 워킹: collector 가 claim 한 in_progress host(IP) → 없으면 pending host head
    a = _col(c, "SELECT host FROM smb_share WHERE status='in_progress' AND claimed_by=? "
                "AND claimed_at >= ? AND cycle_key=? GROUP BY host ORDER BY MIN(claimed_at) ASC LIMIT 10",
             (COLLECTOR_SESSION_ID, now - store.collector_claim_stale_seconds, cycle_key))
    n = _col(c, "SELECT host FROM smb_share WHERE status='pending' "
                "AND cycle_key=? GROUP BY host ORDER BY COUNT(*) DESC, MIN(id) ASC LIMIT 10",
             (cycle_key,))
    out["walking"] = {"active": a, "next": n}
    # ③ 담당자: Splunk pending claim → 없으면 담당자 조회 대기 IP
    active = _col(c, "SELECT ip FROM asset_owner WHERE source='splunk:pending' "
                    "AND updated_at >= ? ORDER BY updated_at ASC LIMIT 10",
                  (now - 1800,))
    nextq = _col(c, "SELECT DISTINCT s.host FROM smb_share s "
                    "LEFT JOIN asset_owner a ON a.ip=s.host "
                    "WHERE s.status NOT IN ('closed','ignored') "
                    "AND s.cycle_key=? "
                    "AND (a.ip IS NULL OR (a.source='splunk:pending' AND a.updated_at < ?)) "
                    "ORDER BY s.host LIMIT 10",
                 (cycle_key, now - 1800))
    out["owner"] = {"active": active, "next": nextq}
    # ④ 점검: worker/claim 단위가 share 이므로 표시도 \\host\share 기준.
    a = _share_targets(
        c,
        "SELECT id, host, share FROM smb_share "
        "WHERE status='in_progress' AND claimed_by=? "
        "AND claimed_at >= ? AND cycle_key=? "
        "ORDER BY claimed_at ASC, id ASC LIMIT 10",
        (SA_SESSION_ID, now - store.smb_claim_stale_seconds, cycle_key),
    )
    n = _share_targets(
        c,
        "SELECT id, host, share FROM smb_share "
        "WHERE cycle_key=? AND (status IN ('walked','listing_reviewed') "
        "OR (status='in_progress' AND claimed_by=? AND (claimed_at IS NULL OR claimed_at < ?))) "
        "ORDER BY CASE WHEN status='in_progress' THEN 1 ELSE 0 END, "
        "COALESCE(walk_done_at, last_seen, first_seen, claimed_at) ASC, host ASC, id ASC LIMIT 10",
        (cycle_key, SA_SESSION_ID, now - store.smb_claim_stale_seconds),
    )
    out["task"] = {"active": a, "next": n}
    # ⑤ 리포팅: draft 는 host 판정 완료 대기, reported 는 메일 발송 대기.
    a = _col(
        c,
        "SELECT host FROM mail_thread WHERE status='reported' AND claimed_by=? "
        "AND claimed_at >= ? AND last_cycle_key=? "
        "GROUP BY host ORDER BY MIN(claimed_at) ASC LIMIT 10",
        (MAIL_SESSION_ID, now - store.mail_thread_claim_stale_seconds, cycle_key),
    )
    n = _col(
        c,
        "SELECT host FROM mail_thread WHERE (status='draft' OR "
        "(status='reported' AND (claimed_at IS NULL OR claimed_at < ?))) "
        "AND last_cycle_key=? "
        "GROUP BY host ORDER BY MIN(CASE WHEN status='reported' THEN 0 ELSE 1 END), "
        "MIN(updated_at) ASC LIMIT 10",
        (now - store.mail_thread_claim_stale_seconds, cycle_key),
    )
    out["report"] = {"active": a, "next": n}
    # ⑥ 답장: awaiting_reply 는 POP3 대기, claim 된 reply_received 는 짧은 처리중 창.
    a = _col(
        c,
        "SELECT host FROM mail_thread WHERE status='reply_received' AND claimed_by=? "
        "AND claimed_at >= ? AND last_cycle_key=? "
        "GROUP BY host ORDER BY MIN(claimed_at) ASC LIMIT 10",
        (REVERIFY_SESSION_ID, now - store.mail_thread_claim_stale_seconds, cycle_key),
    )
    n = _col(
        c,
        "SELECT host FROM mail_thread WHERE status='awaiting_reply' "
        "AND last_cycle_key=? GROUP BY host ORDER BY MIN(updated_at) ASC LIMIT 10",
        (cycle_key,),
    )
    out["reply"] = {"active": a, "next": n}
    # ⑦ 재검증: reply_received 는 재검증 대기, reverifying 은 실제 walk 처리중.
    a = _col(
        c,
        "SELECT host FROM mail_thread WHERE status='reverifying' "
        "AND last_cycle_key=? GROUP BY host ORDER BY MIN(updated_at) ASC LIMIT 10",
        (cycle_key,),
    )
    n = _col(
        c,
        "SELECT host FROM mail_thread WHERE status='reply_received' "
        "AND (claimed_at IS NULL OR claimed_at < ?) "
        "AND (retry_after IS NULL OR retry_after <= ?) "
        "AND last_cycle_key=? GROUP BY host ORDER BY MIN(updated_at) ASC LIMIT 10",
        (now - store.mail_thread_claim_stale_seconds, now, cycle_key),
    )
    out["reverify"] = {"active": a, "next": n}
    # ⑧ 완결: 최근 remediated host
    out["done"] = {"active": [], "next": _col(
        c,
        "SELECT host FROM mail_thread WHERE status='remediated' "
        "AND last_cycle_key=? ORDER BY updated_at DESC LIMIT 6",
        (cycle_key,),
    )}
    return out


def _walking_host_counts(c, *, cycle_key: str) -> dict[str, int]:
    """워킹 IP 상태를 대기/처리중/누적으로 상호 배타 계산."""
    row = c.execute(
        "WITH host_state AS ("
        " SELECT host, "
        " MAX(CASE WHEN status='in_progress' AND claimed_by=? THEN 1 ELSE 0 END) AS processing, "
        " MAX(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending, "
        " MAX(CASE WHEN cycle_walk_done_at IS NOT NULL "
        "          OR status IN ('walked','listing_reviewed','triaged_completed','triaged_errored','ignored') "
        "          OR (status='in_progress' AND claimed_by IS NOT NULL AND claimed_by<>?) "
        "     THEN 1 ELSE 0 END) AS done "
        " FROM smb_share WHERE cycle_key=? GROUP BY host"
        ") "
        "SELECT "
        " COALESCE(SUM(CASE WHEN processing=1 THEN 1 ELSE 0 END),0) AS processing, "
        " COALESCE(SUM(CASE WHEN processing=0 AND pending=1 THEN 1 ELSE 0 END),0) AS pending, "
        " COALESCE(SUM(CASE WHEN processing=0 AND pending=0 AND done=1 THEN 1 ELSE 0 END),0) AS done "
        "FROM host_state",
        (COLLECTOR_SESSION_ID, COLLECTOR_SESSION_ID, cycle_key),
    ).fetchone()
    pending = int(row["pending"] or 0)
    processing = int(row["processing"] or 0)
    done = int(row["done"] or 0)
    return {
        "pending": pending,
        "processing": processing,
        "done": done,
        "total": pending + processing + done,
    }


def _owner_host_counts(c, *, cycle_key: str) -> dict[str, int]:
    """Splunk 담당자 조회 IP 상태를 대기/처리중/성공/실패로 계산."""
    row = c.execute(
        "WITH target AS ("
        " SELECT DISTINCT s.host FROM smb_share s WHERE s.status NOT IN ('closed','ignored') AND s.cycle_key=?"
        "), host_state AS ("
        " SELECT t.host, a.source, a.updated_at "
        " FROM target t LEFT JOIN asset_owner a ON a.ip=t.host"
        ") "
        "SELECT "
        " COALESCE(SUM(CASE WHEN source='splunk:pending' AND updated_at >= ? THEN 1 ELSE 0 END),0) AS processing, "
        " COALESCE(SUM(CASE WHEN source LIKE 'splunk:%:missing' "
        "                  OR source LIKE 'splunk:%:error' "
        "             THEN 1 ELSE 0 END),0) AS failed, "
        " COALESCE(SUM(CASE WHEN source IS NOT NULL "
        "                  AND source<>'splunk:pending' "
        "                  AND source NOT LIKE 'splunk:%:missing' "
        "                  AND source NOT LIKE 'splunk:%:error' "
        "             THEN 1 ELSE 0 END),0) AS mapped, "
        " COALESCE(SUM(CASE WHEN source IS NULL "
        "                  OR (source='splunk:pending' AND updated_at < ?) "
        "             THEN 1 ELSE 0 END),0) AS pending, "
        " COUNT(*) AS total "
        "FROM host_state",
        (cycle_key, time.time() - 1800, time.time() - 1800),
    ).fetchone()
    return {
        "pending": int(row["pending"] or 0),
        "processing": int(row["processing"] or 0),
        "mapped": int(row["mapped"] or 0),
        "failed": int(row["failed"] or 0),
        "total": int(row["total"] or 0),
    }


def pipeline_overview(
    *,
    store: PipelineProjectionStorePort,
    live: bool = False,
) -> dict[str, Any]:
    """단계 트리 + liveness + 큐 + cron 제어 + 최근 cycle.

    각 stage: {key, label, owner, icon, queue, metrics:[{label,value,unit}],
               done, status('active'|'idle'|'waiting')}.
    """
    cycle_key = store.current_cycle_key()
    with store.connect() as c:
        ss = _share_status_counts(c)
        ts = _thread_status_counts(c)
        hb = _heartbeat_map(c)
        tgts = _stage_targets(c, store, cycle_key)

        # ---- 수집 cronjob 세부 ----
        subnet_total = _one(c, "SELECT COUNT(*) FROM smb_target_subnet WHERE enabled=1")
        subnet_swept = _one(
            c,
            "SELECT COUNT(*) FROM smb_target_subnet "
            "WHERE enabled=1 AND cycle_key=? AND cycle_swept_at IS NOT NULL",
            (cycle_key,),
        )
        hosts_found = _one(
            c,
            "SELECT COALESCE(SUM(cycle_hosts_found),0) FROM smb_target_subnet WHERE cycle_key=?",
            (cycle_key,),
        )
        shares_found = _one(
            c,
            "SELECT COALESCE(SUM(cycle_shares_found),0) FROM smb_target_subnet WHERE cycle_key=?",
            (cycle_key,),
        )
        shares_total = _one(c, "SELECT COUNT(*) FROM smb_share WHERE cycle_key=?", (cycle_key,))
        dirs = _one(
            c,
            "SELECT COUNT(*) FROM smb_directory d JOIN smb_share s ON s.id=d.share_id "
            "WHERE s.cycle_key=?",
            (cycle_key,),
        )
        files = _one(
            c,
            "SELECT COUNT(*) FROM smb_file f JOIN smb_share s ON s.id=f.share_id "
            "WHERE s.cycle_key=?",
            (cycle_key,),
        )
        text_cand = _one(
            c,
            "SELECT COUNT(*) FROM smb_file f JOIN smb_share s ON s.id=f.share_id "
            "WHERE s.cycle_key=? AND f.is_text_candidate=1",
            (cycle_key,),
        )
        suspicious = _one(
            c,
            "SELECT COUNT(*) FROM smb_file f JOIN smb_share s ON s.id=f.share_id "
            "WHERE s.cycle_key=? AND f.suspicious_name=1",
            (cycle_key,),
        )
        excluded_print = _one(
            c,
            "SELECT COUNT(*) FROM smb_share WHERE cycle_key=? AND excluded_reason='print'",
            (cycle_key,),
        )
        owners = _one(c, "SELECT COUNT(*) FROM asset_owner")
        scans_done = _one(c, "SELECT COUNT(*) FROM scan WHERE finished_at IS NOT NULL")
        walk_hosts = _walking_host_counts(c, cycle_key=cycle_key)
        owner_hosts = _owner_host_counts(c, cycle_key=cycle_key)
        now = time.time()
        task_stale_cutoff = now - store.smb_claim_stale_seconds

        # ---- 점검 ----
        task_queue_shares = _one(
            c,
            "SELECT COUNT(*) FROM smb_share "
            "WHERE cycle_key=? AND (status IN ('walked','listing_reviewed') "
            "OR (status='in_progress' AND claimed_by=? AND (claimed_at IS NULL OR claimed_at < ?)))",
            (cycle_key, SA_SESSION_ID, task_stale_cutoff),
        )
        task_processing_shares = _one(
            c,
            "SELECT COUNT(*) FROM smb_share "
            "WHERE cycle_key=? AND status='in_progress' AND claimed_by=? AND claimed_at >= ?",
            (cycle_key, SA_SESSION_ID, task_stale_cutoff),
        )
        task_triaged_shares = _one(
            c,
            "SELECT COUNT(*) FROM smb_share "
            "WHERE cycle_key=? AND status='triaged_completed'",
            (cycle_key,),
        )
        task_error_shares = _one(
            c,
            "SELECT COUNT(*) FROM smb_share "
            "WHERE cycle_key=? AND status='triaged_errored'",
            (cycle_key,),
        )
        finding_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread "
            "WHERE last_cycle_key=?",
            (cycle_key,),
        )
        findings = _one(c, "SELECT COUNT(*) FROM finding_lifecycle WHERE task_type='smb'")

        # ---- 메일/답장/재검증 ----
        report_draft_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status='draft' "
            "AND last_cycle_key=?",
            (cycle_key,),
        )
        mail_queue_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status='reported' "
            "AND (claimed_at IS NULL OR claimed_at < ?) "
            "AND last_cycle_key=?",
            (now - store.mail_thread_claim_stale_seconds, cycle_key),
        )
        mail_processing_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status='reported' "
            "AND claimed_by=? AND claimed_at >= ? "
            "AND last_cycle_key=?",
            (MAIL_SESSION_ID, now - store.mail_thread_claim_stale_seconds, cycle_key),
        )
        mail_waiting_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread "
            "WHERE status IN ('awaiting_reply','reply_received','reverifying','re_requested',"
            "'partially_remediated','exception_review','owner_update_needed',"
            "'owner_reassignment_review','reassigned','remediated','escalated','closed') "
            "AND last_cycle_key=?",
            (cycle_key,),
        )
        reply_waiting_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status='awaiting_reply' "
            "AND last_cycle_key=?",
            (cycle_key,),
        )
        reply_processing_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status='reply_received' "
            "AND claimed_by=? AND claimed_at >= ? "
            "AND last_cycle_key=?",
            (REVERIFY_SESSION_ID, now - store.mail_thread_claim_stale_seconds, cycle_key),
        )
        reply_received_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status='reply_received' "
            "AND (claimed_at IS NULL OR claimed_at < ? OR claimed_by<>?) "
            "AND (retry_after IS NULL OR retry_after <= ?) "
            "AND last_cycle_key=?",
            (now - store.mail_thread_claim_stale_seconds, REVERIFY_SESSION_ID, now, cycle_key),
        )
        reply_seen_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread "
            "WHERE ((status='reply_received' "
            "AND (claimed_at IS NULL OR claimed_at < ? OR claimed_by<>?)) "
            "OR status IN ('reverifying','re_requested',"
            "'partially_remediated','exception_review','owner_update_needed',"
            "'owner_reassignment_review','reassigned','remediated','escalated','closed')) "
            "AND last_cycle_key=?",
            (now - store.mail_thread_claim_stale_seconds, REVERIFY_SESSION_ID, cycle_key),
        )
        reverifying_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status='reverifying' "
            "AND last_cycle_key=?",
            (cycle_key,),
        )
        re_requested_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status='re_requested' "
            "AND last_cycle_key=?",
            (cycle_key,),
        )
        remediated_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status='remediated' "
            "AND last_cycle_key=?",
            (cycle_key,),
        )
        partial_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status='partially_remediated' "
            "AND last_cycle_key=?",
            (cycle_key,),
        )
        hitl_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status IN ("
            "'exception_review','owner_update_needed','owner_reassignment_review','reassigned'"
            ") AND last_cycle_key=?",
            (cycle_key,),
        )
        escalated_hosts = _one(
            c,
            "SELECT COUNT(DISTINCT host) FROM mail_thread WHERE status='escalated' "
            "AND last_cycle_key=?",
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
            "key": "sweep", "label": "① 스윕 (subnet→host)", "owner": "수집 cronjob",
            "icon": "📡", "status": st(COMPONENT_COLLECTOR),
            "queue": subnet_total - subnet_swept,
            "done": subnet_swept,
            "metrics": [
                {"label": "대상 subnet", "value": subnet_total, "unit": "개"},
                {"label": "워킹 대상 IP", "value": walk_hosts["total"], "unit": "대"},
                {"label": "발견 IP", "value": hosts_found, "unit": "대"},
                {"label": "열린 공유", "value": shares_found, "unit": "개"},
                {"label": "스캔 사이클", "value": scans_done, "unit": "회"},
            ],
        },
        {
            "key": "walking", "label": "② 워킹 (폴더/파일 메타)", "owner": "수집 cronjob",
            "icon": "🗂", "status": st(COMPONENT_COLLECTOR),
            "queue": walk_hosts["pending"],
            "processing_count": walk_hosts["processing"],
            "done": walk_hosts["done"],
            "metrics": [
                {"label": "share", "value": shares_total, "unit": "개"},
                {"label": "디렉터리", "value": dirs, "unit": "개"},
                {"label": "파일", "value": files, "unit": "개"},
                {"label": "텍스트 후보", "value": text_cand, "unit": "개"},
                {"label": "의심 파일명", "value": suspicious, "unit": "개"},
                {"label": "프린터 제외 share", "value": excluded_print, "unit": "개"},
            ],
        },
        {
            "key": "owner", "label": "③ 담당자 조회 (Splunk)", "owner": "수집 cronjob",
            "icon": "👤", "status": st(COMPONENT_COLLECTOR),
            "queue": owner_hosts["pending"],
            "processing_count": owner_hosts["processing"],
            "done": owner_hosts["mapped"],
            "metrics": [
                {"label": "담당자 대상 IP", "value": owner_hosts["total"], "unit": "대"},
                {"label": "담당자 매핑 성공", "value": owner_hosts["mapped"], "unit": "대"},
                {"label": "담당자 매핑 실패", "value": owner_hosts["failed"], "unit": "대"},
            ],
        },
        {
            "key": "task", "label": "④ 점검 (적대적 판정)", "owner": "#1 점검 에이전트",
            "icon": "🔍", "status": st(COMPONENT_TASK),
            "queue": task_queue_shares,
            "processing_count": task_processing_shares,
            "done": task_triaged_shares + task_error_shares,
            "metrics": [
                {"label": "판정 대기 share", "value": task_queue_shares, "unit": "개"},
                {"label": "판정 중 share", "value": task_processing_shares, "unit": "개"},
                {"label": "판정 완료 share", "value": task_triaged_shares, "unit": "개"},
                {"label": "판정 실패 share", "value": task_error_shares, "unit": "개"},
                {"label": "Finding 대상 IP", "value": finding_hosts, "unit": "대"},
            ],
        },
        {
            "key": "report", "label": "⑤ 리포팅·메일", "owner": "#2 조치요청 에이전트",
            "icon": "✉️", "status": st(COMPONENT_MAIL),
            "queue": report_draft_hosts + mail_queue_hosts,
            "processing_count": mail_processing_hosts,
            "done": mail_waiting_hosts,
            "metrics": [
                {"label": "리포트 준비 IP", "value": report_draft_hosts, "unit": "대"},
                {"label": "발송 대기 IP", "value": mail_queue_hosts, "unit": "대"},
                {"label": "발송 처리중 IP", "value": mail_processing_hosts, "unit": "대"},
                {"label": "발송 완료 IP", "value": mail_waiting_hosts, "unit": "대"},
            ],
        },
        {
            "key": "reply", "label": "⑥ 답장 수신 (POP3)", "owner": "#3 답장·재검증",
            "icon": "📨", "status": st(COMPONENT_REVERIFY),
            "queue": reply_waiting_hosts,
            "processing_count": reply_processing_hosts,
            "done": reply_seen_hosts,
            "metrics": [
                {"label": "답장 대기 IP", "value": reply_waiting_hosts, "unit": "대"},
                {"label": "답장 처리중 IP", "value": reply_processing_hosts, "unit": "대"},
                {"label": "답장 수신 IP", "value": reply_seen_hosts, "unit": "대"},
            ],
        },
        {
            "key": "reverify", "label": "⑦ 재검증 (실제 walk)", "owner": "#3 답장·재검증",
            "icon": "🔁", "status": st(COMPONENT_REVERIFY),
            "queue": reply_received_hosts,
            "processing_count": reverifying_hosts,
            "done": remediated_hosts + re_requested_hosts + partial_hosts + hitl_hosts,
            "metrics": [
                {"label": "재검증 대기 IP", "value": reply_received_hosts, "unit": "대"},
                {"label": "재검증 중 IP", "value": reverifying_hosts, "unit": "대"},
                {"label": "조치 확인 IP", "value": remediated_hosts, "unit": "대"},
                {"label": "재요청 IP", "value": re_requested_hosts, "unit": "대"},
                {"label": "부분 조치 IP", "value": partial_hosts, "unit": "대"},
                {"label": "HITL 검토 IP", "value": hitl_hosts, "unit": "대"},
            ],
        },
        {
            "key": "done", "label": "⑧ 완결", "owner": "—",
            "icon": "✅", "status": "idle",
            "queue": 0,
            "done": remediated_hosts,
            "metrics": [
                {"label": "조치 완료 IP", "value": remediated_hosts, "unit": "대"},
                {"label": "부분 조치 IP", "value": partial_hosts, "unit": "대"},
                {"label": "HITL 검토 IP", "value": hitl_hosts, "unit": "대"},
                {"label": "에스컬레이션 IP", "value": escalated_hosts, "unit": "대"},
            ],
        },
    ]

    # stage → control_flag 키 (노드별 on/off). done 은 토글 없음.
    _stage_ctrl = {
        "sweep": "collector.sweep", "walking": "collector.walk", "owner": "collector.owner",
        "task": COMPONENT_TASK, "report": COMPONENT_MAIL,
        "reply": COMPONENT_REVERIFY, "reverify": COMPONENT_REVERIFY,
    }
    # stage → 러너 프로세스(heartbeat 컴포넌트).
    _stage_proc = {
        "sweep": COMPONENT_COLLECTOR, "walking": COMPONENT_COLLECTOR, "owner": COMPONENT_COLLECTOR,
        "task": COMPONENT_TASK, "report": COMPONENT_MAIL,
        "reply": COMPONENT_REVERIFY, "reverify": COMPONENT_REVERIFY, "done": None,
    }
    _stage_proc["owner"] = "collector.owner"

    _active_phase = {
        "sweep": "sweep",
        "walking": "walk",
        "owner": "owner_enrich",
        "task": PHASE_TASK,
        "report": PHASE_REPORT_MAIL,
        "reply": PHASE_REVERIFY,
        "reverify": PHASE_REVERIFY,
    }

    # 각 stage 에 현재 진행/대기 대상 목록 + 처리중 수 + 노드별 제어/프로세스 상태 주입.
    for s in stages:
        t = tgts.get(s["key"], {"active": [], "next": []})
        ck = _stage_ctrl.get(s["key"])
        s["control_key"] = ck
        s["node_enabled"] = bool(int(store.control_flag_get(ck)["enabled"])) if ck else None
        proc = _stage_proc.get(s["key"])
        s["proc"] = proc
        s["proc_alive"] = bool(hb.get(proc, {}).get("alive")) if proc else False
        s["proc_phase"] = hb.get(proc, {}).get("phase") if proc else None

        # 구버전 collector 는 subnet claim 없이 heartbeat.detail 만 남겼다.
        # 새 러너의 다중 처리에서는 claim 목록을 우선 사용하고, 없을 때만 detail fallback.
        if s["key"] == "sweep" and s["proc_alive"] and s["proc_phase"] == "sweep":
            cur = hb.get("collector", {}).get("detail")
            if cur and not t.get("active"):
                t = {"active": [str(cur)], "next": [x for x in t.get("next", []) if str(x) != str(cur)]}

        s["targets"] = t
        s["processing"] = int(s.pop("processing_count", len(t.get("active", []))) or 0)
        if s["key"] == "sweep":
            s["queue"] = max(0, int(s.get("queue") or 0) - s["processing"])

        # 한 collector 프로세스가 sweep/walk/owner 를 순차 수행하므로, phase 가 맞는
        # stage 만 active 로 보이게 한다. OFF 노드는 대기 상태로 둔다.
        expected_phase = _active_phase.get(s["key"])
        if s["node_enabled"] is False:
            s["status"] = "waiting"
        elif s["processing"] > 0:
            s["status"] = "active"
        elif proc and s["proc_alive"]:
            s["status"] = "active" if s["proc_phase"] == expected_phase else "idle"

    return {
        "kind": "pipeline_overview",
        "generated_at": time.time(),
        "cycle_key": cycle_key,
        "live": live,
        "stages": stages,
        "share_status_counts": ss,
        "mail_thread_status_counts": ts,
        "findings_total": findings,
        "heartbeats": hb,
        "control": {
            comp: store.control_flag_get(comp)
            for comp in (COMPONENT_COLLECTOR, COMPONENT_TASK, COMPONENT_MAIL, COMPONENT_REVERIFY)
        },
        "recent_runs": {
            comp: store.pipeline_runs_recent(comp, limit=3)
            for comp in (COMPONENT_COLLECTOR, COMPONENT_TASK, COMPONENT_MAIL, COMPONENT_REVERIFY)
        },
    }
