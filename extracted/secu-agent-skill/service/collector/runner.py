"""SMB E2E 수집기 러너 — LLM 0 독립 cron (smb_domain_e2e 요구 1·2·12).

`python -m service.collector.runner`  (또는 --once 1회 / --dry-run).

매 tick:
  (a) pipeline_heartbeat upsert (liveness — 대시보드)
  (b) control_flag(collector) SELECT — enabled=0 면 sweep skip(하트비트만)
  (c) due(주간 cycle 미완료 또는 8h gap-rescan subnet 있음) 또는 run_now 소비됨 → 1 pass 실행
  (d) collector reclaim(시간기반) — crash 로 물린 host claim 회수

1 pass (단일-run 가드: pipeline_run 'running' 1개만):
  pass 시작 1회 `smb.reset_auth_lockout_flag()` (러너 소유 — KEEP 불변식)
  → 모든 due subnet sweep(sweep_core) → walk pending hosts(walk_core, 메타만)
  → owner-enrich(splunk_owner, Splunk 설정 시) → pipeline_run_finish.

핸드오프: walk 완료 share(status='walked') 가 #1 점검 에이전트 큐. 이 러너는 점검을
하지 않는다 — 무거운 수집만(토큰 0).
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from typing import Any

from domains.smb.plugin.agent_types import smb
from service import state_domain as state
from service.collector import splunk_owner, sweep_core, walk_core

log = logging.getLogger("service.collector.runner")

COMPONENT = "collector"
DEFAULT_POLL_SECONDS = 300.0
DEFAULT_SUBNET_WORKERS = 5
DEFAULT_WALK_WORKERS = 5
DEFAULT_OWNER_BATCH_SIZE = 5
MAX_SUBNET_WORKERS = 32
MAX_WALK_WORKERS = 16
MAX_OWNER_BATCH_SIZE = 50
OWNER_PENDING_STALE_SECONDS = 1800
# 단일-run 가드: 마지막 'running' pipeline_run 이 이만큼 묵으면 stale 로 보고 무시.
RUN_STALE_SECONDS = 6 * 3600


def _poll_seconds() -> float:
    raw = os.environ.get("COLLECTOR_POLL_SECONDS", "")
    try:
        v = float(raw)
        if v > 0:
            return v
    except ValueError:
        pass
    return DEFAULT_POLL_SECONDS


def _rescan_cooldown() -> float:
    # 같은 주차 안의 누락 보정 기본(8h). 주간 새판은 cycle_key/cycle_swept_at 이 담당.
    raw = os.environ.get("COLLECTOR_RESCAN_SECONDS", "")
    try:
        v = float(raw)
        if v > 0:
            return v
    except ValueError:
        pass
    return float(state.SMB_SUBNET_GAP_RESCAN_SECONDS)


def _subnet_workers() -> int:
    raw = (
        os.environ.get("COLLECTOR_SUBNET_WORKERS")
        or os.environ.get("COLLECTOR_SUBNET_CONCURRENCY")
        or ""
    )
    try:
        v = int(raw)
        if v > 0:
            return min(v, MAX_SUBNET_WORKERS)
    except ValueError:
        pass
    return DEFAULT_SUBNET_WORKERS


def _walk_workers() -> int:
    raw = (
        os.environ.get("COLLECTOR_WALK_WORKERS")
        or os.environ.get("COLLECTOR_WALK_CONCURRENCY")
        or ""
    )
    try:
        v = int(raw)
        if v > 0:
            return min(v, MAX_WALK_WORKERS)
    except ValueError:
        pass
    return DEFAULT_WALK_WORKERS


def _owner_batch_size() -> int:
    raw = (
        os.environ.get("COLLECTOR_OWNER_BATCH_SIZE")
        or os.environ.get("COLLECTOR_OWNER_WORKERS")
        or ""
    )
    try:
        v = int(raw)
        if v > 0:
            return min(v, MAX_OWNER_BATCH_SIZE)
    except ValueError:
        pass
    return DEFAULT_OWNER_BATCH_SIZE


def _has_running_pass() -> bool:
    """단일-run 가드 — 아직 안 끝난(stale 아님) collector pass 가 있으면 True."""
    recent = state.pipeline_runs_recent(COMPONENT, limit=5)
    now = time.time()
    for r in recent:
        if r.get("status") == "running" and r.get("finished_at") is None:
            started = r.get("started_at") or 0
            if now - started < RUN_STALE_SECONDS:
                return True
    return False


def _due_subnets(cooldown: float) -> list[str]:
    rows = state.subnets_pending_sweep(limit=10000, cooldown_seconds=cooldown)
    return [r["subnet"] for r in rows]


def _walk_pending_count() -> int:
    cycle_key = state.smb_current_cycle_key()
    with state.connect() as c:
        row = c.execute(
            "SELECT COUNT(DISTINCT host) AS n FROM smb_share WHERE status='pending' "
            "AND cycle_key=? AND (retry_after IS NULL OR retry_after <= ?)",
            (cycle_key, time.time()),
        ).fetchone()
    return int(row["n"]) if row else 0


def _owner_pending_count() -> int:
    cycle_key = state.smb_current_cycle_key()
    cutoff = time.time() - OWNER_PENDING_STALE_SECONDS
    with state.connect() as c:
        row = c.execute(
            "SELECT COUNT(*) AS n FROM ("
            " SELECT DISTINCT s.host "
            " FROM smb_share s "
            " LEFT JOIN asset_owner a ON a.ip=s.host "
            " WHERE s.status NOT IN ('closed','ignored') "
            " AND s.cycle_key=? "
            " AND (a.ip IS NULL OR (a.source='splunk:pending' AND a.updated_at < ?))"
            ") q",
            (cycle_key, cutoff),
        ).fetchone()
    return int(row["n"]) if row else 0


def _owner_claim_ips(*, limit: int) -> list[str]:
    cycle_key = state.smb_current_cycle_key()
    cutoff = time.time() - OWNER_PENDING_STALE_SECONDS
    with state.connect() as c:
        rows = c.execute(
            "SELECT DISTINCT s.host "
            "FROM smb_share s "
            "LEFT JOIN asset_owner a ON a.ip=s.host "
            "WHERE s.status NOT IN ('closed','ignored') "
            "AND s.cycle_key=? "
            "AND (a.ip IS NULL OR (a.source='splunk:pending' AND a.updated_at < ?)) "
            "ORDER BY s.host LIMIT ?",
            (cycle_key, cutoff, max(1, limit)),
        ).fetchall()
    ips = [str(r["host"]) for r in rows if r["host"]]
    for ip in ips:
        state.asset_owner_upsert(ip, source="splunk:pending")
    return ips


def _owner_release_pending(ips: list[str]) -> None:
    if not ips:
        return
    placeholders = ",".join("?" for _ in ips)
    with state.connect() as c:
        c.execute(
            f"DELETE FROM asset_owner WHERE source='splunk:pending' AND ip IN ({placeholders})",
            ips,
        )


def _stage_enabled(stage_key: str) -> bool:
    """세부 노드(collector.sweep/walk/owner) on/off. 미설정이면 ON 기본."""
    f = state.control_flag_get(stage_key)
    return bool(int(f.get("enabled", 1)))


def _subnet_claim_id(slot: int) -> int:
    # 슬롯별 claim id 를 분리해야 한 패스 안에서 같은 subnet 을 다시 claim 하지 않는다.
    return state.COLLECTOR_SESSION_ID - (os.getpid() * 100) - slot - 1


def _claim_next_subnet(slot: int, *, cooldown: float) -> dict[str, Any] | None:
    claim_id = _subnet_claim_id(slot)
    row = state.smb_subnet_claim_next(
        session_id=claim_id,
        cooldown_seconds=cooldown,
    )
    if not row:
        return None
    row["_claim_id"] = claim_id
    row["_slot"] = slot
    log.info("[runner] subnet claim slot=%d subnet=%s", slot, row.get("subnet"))
    return row


def _sweep_claimed_subnet(row: dict[str, Any]) -> dict[str, Any]:
    subnet = str(row["subnet"])
    state.heartbeat_upsert(COMPONENT, phase="sweep", detail=subnet, pid=os.getpid())
    scan_id = state.scan_start("smb", [subnet])
    counts = sweep_core.sweep_subnet(subnet, scan_id=scan_id)
    state.scan_finish(
        scan_id,
        alive_total=counts["alive_hosts"],
        accessible_total=counts["accessible_hosts"],
        new_count=counts["new_shares"],
        closed_count=counts["closed_shares"],
    )
    return {"subnet": subnet, "counts": counts}


def _sweep_due_subnets_concurrent(*, cooldown: float, workers: int) -> tuple[dict[str, int], int]:
    """Due subnet 을 최대 workers 개씩 병렬 sweep. 실패 subnet 은 패스 끝에 재시도 가능하게 해제."""
    agg = {"subnets_swept": 0, "hosts_found": 0, "shares_found": 0}
    failed: list[tuple[str, int, str]] = []
    stop_claiming = False

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures: dict[Any, dict[str, Any]] = {}

        def submit_next(slot: int) -> bool:
            row = _claim_next_subnet(slot, cooldown=cooldown)
            if not row:
                return False
            futures[pool.submit(_sweep_claimed_subnet, row)] = row
            return True

        for slot in range(workers):
            submit_next(slot)
        state.heartbeat_upsert(
            COMPONENT, phase="sweep", detail=f"{len(futures)}/{workers} subnets", pid=os.getpid(),
        )

        while futures:
            done, _pending = wait(futures, return_when=FIRST_COMPLETED)
            for fut in done:
                row = futures.pop(fut)
                slot = int(row["_slot"])
                claim_id = int(row["_claim_id"])
                subnet = str(row["subnet"])
                try:
                    res = fut.result()
                except Exception as e:  # noqa: BLE001 — subnet 단위 실패는 다른 sweep 을 막지 않음
                    failed.append((subnet, claim_id, repr(e)[:300]))
                    log.exception("[runner] subnet sweep failed subnet=%s", subnet)
                    if len(failed) >= workers:
                        stop_claiming = True
                else:
                    counts = res["counts"]
                    agg["subnets_swept"] += 1
                    agg["hosts_found"] += counts["alive_hosts"]
                    agg["shares_found"] += counts["shares_found"]

                if not stop_claiming:
                    submit_next(slot)
                state.heartbeat_upsert(
                    COMPONENT,
                    phase="sweep",
                    detail=f"{len(futures)}/{workers} subnets",
                    pid=os.getpid(),
                )

    for subnet, claim_id, err in failed:
        try:
            state.smb_subnet_release_claim(subnet, session_id=claim_id)
        except Exception:  # noqa: BLE001
            log.exception("[runner] failed subnet claim release failed subnet=%s err=%s", subnet, err)
    if failed:
        log.warning("[runner] subnet sweep failures=%d", len(failed))
    return agg, len(failed)


def _add_walk_counts(dst: dict[str, int], src: dict[str, int]) -> None:
    for key in ("hosts_walked", "shares_walked", "files", "dirs", "excluded_print"):
        dst[key] = int(dst.get(key, 0)) + int(src.get(key, 0))


def _walk_pending_hosts_until_sweep_done(*, workers: int, sweep_future: Any | None = None) -> dict[str, int]:
    """스윕이 도는 동안 새로 생기는 pending host 까지 계속 워킹한다."""
    agg = {"hosts_walked": 0, "shares_walked": 0, "files": 0, "dirs": 0,
           "excluded_print": 0}
    idle_sleep = 5.0
    while True:
        pending = _walk_pending_count()
        if pending > 0:
            state.heartbeat_upsert(
                COMPONENT, phase="walk", detail=f"{pending} pending/{workers} workers", pid=os.getpid(),
            )
            counts = walk_core.walk_pending_hosts_concurrent(max_workers=workers)
            _add_walk_counts(agg, counts)
            continue
        if sweep_future is not None and not sweep_future.done():
            state.heartbeat_upsert(
                COMPONENT, phase="walk", detail=f"waiting/{workers} workers", pid=os.getpid(),
            )
            time.sleep(idle_sleep)
            continue
        break
    return agg


def _owner_enrich_until_sources_done(
    *,
    batch_size: int,
    source_futures: list[Any] | None = None,
) -> dict[str, int]:
    agg = {"queried": 0, "persisted": 0, "missing": 0, "errors": 0}
    if not splunk_owner.splunk_enabled():
        log.info("[runner] splunk disabled — owner-enrich skip")
        return agg

    idle_sleep = 5.0
    futures = source_futures or []
    while True:
        ips = _owner_claim_ips(limit=batch_size)
        if ips:
            state.heartbeat_upsert(
                "collector.owner", phase="owner_enrich", detail=",".join(ips), pid=os.getpid(),
            )
            log.info("[runner] owner lookup ips=%s", ips)
            res = splunk_owner.enrich_owners(set(ips), max_results=max(batch_size, len(ips)))
            if int(res.get("error", 0)):
                _owner_release_pending(ips)
                agg["errors"] += 1
            agg["queried"] += int(res.get("queried", 0))
            agg["persisted"] += int(res.get("persisted", 0))
            agg["missing"] += int(res.get("missing", 0))
            continue

        if any(not f.done() for f in futures):
            state.heartbeat_upsert(
                "collector.owner", phase="owner_wait", detail=f"waiting/{batch_size}", pid=os.getpid(),
            )
            time.sleep(idle_sleep)
            continue
        break

    state.heartbeat_upsert("collector.owner", phase="idle", detail=None, pid=os.getpid())
    return agg


def run_one_pass(*, dry_run: bool = False) -> dict[str, int]:
    """1 수집 pass — sweep(due subnets) → walk → owner-enrich. 카운트 반환."""
    cooldown = _rescan_cooldown()
    due = _due_subnets(cooldown)
    agg = {"subnets_swept": 0, "hosts_found": 0, "shares_found": 0,
           "shares_walked": 0, "owners_enriched": 0}

    # 세부 노드별 on/off (요구: 노드별 분할). 각 sub-flag 가 0 이면 그 단계 skip.
    do_sweep = _stage_enabled("collector.sweep")
    do_walk = _stage_enabled("collector.walk")
    do_owner = _stage_enabled("collector.owner")
    walk_pending = _walk_pending_count() if do_walk else 0
    owner_pending = _owner_pending_count() if do_owner and splunk_owner.splunk_enabled() else 0
    has_sweep_work = do_sweep and bool(due)
    has_walk_work = do_walk and walk_pending > 0
    has_owner_work = do_owner and owner_pending > 0 and splunk_owner.splunk_enabled()

    if not has_sweep_work and not has_walk_work and not has_owner_work:
        log.info(
            "[runner] 수집 작업 없음 (due_subnets=%d, pending_walk_hosts=%d, pending_owner_hosts=%d, cooldown=%.0fs) — pass skip",
            len(due), walk_pending, owner_pending, cooldown,
        )
        return agg
    if dry_run:
        log.info(
            "[runner] DRY-RUN due_subnets=%s pending_walk_hosts=%d pending_owner_hosts=%d",
            due, walk_pending, owner_pending,
        )
        agg["subnets_swept"] = len(due)
        return agg

    if _has_running_pass():
        log.warning("[runner] 직전 pass 가 아직 running — 중복 실행 가드, skip")
        return agg

    run_id = state.pipeline_run_start(COMPONENT)
    # KEEP 불변식: lockout reset 은 러너가 pass 시작에 1회만 (core/agent 호출 금지).
    smb.reset_auth_lockout_flag()
    # reset 직후 1회 센티넬 — 과거 auth 성공 host 로 자격증명 유효성을 먼저 확정한다.
    # 확정되면 개별 host 의 LOGON_FAILURE 가 전역 회로를 끊지 않는다(smb.py 주석 참조).
    _ok, _why = smb.verify_auth_credential(state.smb_auth_verified_hosts())
    log.info("[runner] auth 센티넬: %s", _why)

    sweep_errors = 0
    try:
        if has_sweep_work and do_walk:
            subnet_workers = _subnet_workers()
            walk_workers = _walk_workers()
            owner_batch = _owner_batch_size()
            log.info(
                "[runner] sweep+walk%s start due=%d sweep_workers=%d walk_workers=%d owner_batch=%d",
                "+owner" if do_owner and splunk_owner.splunk_enabled() else "",
                len(due), subnet_workers, walk_workers, owner_batch,
            )
            with ThreadPoolExecutor(max_workers=3) as phases:
                sweep_future = phases.submit(
                    _sweep_due_subnets_concurrent,
                    cooldown=cooldown,
                    workers=subnet_workers,
                )
                walk_future = phases.submit(
                    _walk_pending_hosts_until_sweep_done,
                    workers=walk_workers,
                    sweep_future=sweep_future,
                )
                owner_future = None
                if do_owner and splunk_owner.splunk_enabled():
                    owner_future = phases.submit(
                        _owner_enrich_until_sources_done,
                        batch_size=owner_batch,
                        source_futures=[sweep_future, walk_future],
                    )
                sweep_agg, sweep_errors = sweep_future.result()
                walk_counts = walk_future.result()
                owner_counts = owner_future.result() if owner_future else {"persisted": 0}
            agg["subnets_swept"] += sweep_agg["subnets_swept"]
            agg["hosts_found"] += sweep_agg["hosts_found"]
            agg["shares_found"] += sweep_agg["shares_found"]
            agg["shares_walked"] += walk_counts["shares_walked"]
            agg["owners_enriched"] += int(owner_counts.get("persisted", 0))
        elif has_sweep_work:
            workers = _subnet_workers()
            log.info("[runner] sweep start due=%d workers=%d", len(due), workers)
            sweep_agg, sweep_errors = _sweep_due_subnets_concurrent(
                cooldown=cooldown,
                workers=workers,
            )
            agg["subnets_swept"] += sweep_agg["subnets_swept"]
            agg["hosts_found"] += sweep_agg["hosts_found"]
            agg["shares_found"] += sweep_agg["shares_found"]

        # walk (메타만) — claim 단위 HOST.
        if do_walk and not has_sweep_work:
            workers = _walk_workers()
            log.info("[runner] walk start workers=%d", workers)
            walk_counts = _walk_pending_hosts_until_sweep_done(workers=workers)
            agg["shares_walked"] += walk_counts["shares_walked"]

        # collect walked share 들의 host IP → owner-enrich (Splunk 설정 시).
        if do_owner and splunk_owner.splunk_enabled() and not has_sweep_work:
            owner_counts = _owner_enrich_until_sources_done(batch_size=_owner_batch_size())
            agg["owners_enriched"] += int(owner_counts.get("persisted", 0))

        finish_status = "ok" if sweep_errors == 0 else "error"
        finish_detail = None if sweep_errors == 0 else f"sweep_failed={sweep_errors}"
        state.pipeline_run_finish(
            run_id, status=finish_status, detail=finish_detail,
            subnets_swept=agg["subnets_swept"], hosts_found=agg["hosts_found"],
            shares_found=agg["shares_found"], shares_walked=agg["shares_walked"],
            owners_enriched=agg["owners_enriched"],
        )
        state.heartbeat_upsert(
            COMPONENT,
            phase="idle" if finish_status == "ok" else "error",
            detail=finish_detail or f"last pass {agg}",
            pid=os.getpid(),
        )
    except Exception as e:  # noqa: BLE001 — pass 실패도 러너는 죽지 않음
        log.exception("[runner] pass 실패")
        state.pipeline_run_finish(run_id, status="error", detail=repr(e)[:500],
                                  subnets_swept=agg["subnets_swept"])
        state.heartbeat_upsert(
            COMPONENT,
            phase="error",
            detail=repr(e)[:500],
            pid=os.getpid(),
        )
    log.info("[runner] pass done %s", agg)
    return agg


def _walked_host_ips(*, limit: int = 2000) -> set[str]:
    """현재 walked/triaged share 의 host IP 집합 (owner-enrich 대상)."""
    cycle_key = state.smb_current_cycle_key()
    with state.connect() as c:
        rows = c.execute(
            "SELECT DISTINCT host FROM smb_share "
            "WHERE cycle_key=? AND status IN ('walked','listing_reviewed','triaged_completed') "
            "LIMIT ?",
            (cycle_key, limit),
        ).fetchall()
    return {r["host"] for r in rows if r["host"]}


def tick(*, dry_run: bool = False) -> None:
    """1 poll tick — 하트비트 + 제어플래그 + reclaim + (due/run_now) pass."""
    state.heartbeat_upsert(COMPONENT, phase="poll", pid=os.getpid())
    state.smb_collector_reclaim_stale()  # crash 로 물린 host claim 회수

    flag = state.control_flag_get(COMPONENT)
    run_now = state.control_flag_consume_run_now(COMPONENT)
    if not int(flag.get("enabled", 1)) and not run_now:
        state.heartbeat_upsert(COMPONENT, phase="disabled", pid=os.getpid())
        log.info("[runner] disabled (control_flag) — pass skip")
        return

    cooldown = _rescan_cooldown()
    if run_now or _due_subnets(cooldown) or _walk_pending_count() > 0 or _owner_pending_count() > 0:
        run_one_pass(dry_run=dry_run)
    else:
        state.heartbeat_upsert(COMPONENT, phase="idle", pid=os.getpid())


async def _loop(*, dry_run: bool = False) -> None:
    poll = _poll_seconds()
    stop = asyncio.Event()

    def _sig(*_a):  # noqa: ANN002
        stop.set()

    try:
        loop = asyncio.get_running_loop()
        for s in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(s, _sig)
    except (NotImplementedError, RuntimeError):
        pass

    log.info("[runner] poll loop 시작 (interval=%.0fs)", poll)
    while not stop.is_set():
        try:
            await asyncio.to_thread(tick, dry_run=dry_run)
        except Exception:  # noqa: BLE001 — 러너는 죽지 않는다
            log.exception("[runner] tick 실패")
        try:
            await asyncio.wait_for(stop.wait(), timeout=poll)
        except asyncio.TimeoutError:
            pass
    log.info("[runner] poll loop 종료")


def main(argv: "list[str] | None" = None) -> int:
    p = argparse.ArgumentParser(description="SMB E2E 수집기 러너 (LLM 0)")
    p.add_argument("--once", action="store_true", help="1 tick 만 실행하고 종료")
    p.add_argument("--dry-run", action="store_true", help="due subnet 만 출력, 수집 안 함")
    p.add_argument("--pass", dest="pass_now", action="store_true",
                   help="control_flag 무시하고 즉시 1 pass 실행")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=os.environ.get("COLLECTOR_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # 프로세스 .env 자동 로드 (엔진 cli.py 와 동일 위생 — web 프로세스 밖 단독 기동 대비).
    _load_dotenv()

    if args.pass_now:
        run_one_pass(dry_run=args.dry_run)
        return 0
    if args.once:
        tick(dry_run=args.dry_run)
        return 0
    asyncio.run(_loop(dry_run=args.dry_run))
    return 0


def _load_dotenv() -> None:
    """skill repo .env + 엔진 .env 를 환경에 로드(이미 있는 키는 보존)."""
    from service.runtime_env import load_runtime_env

    load_runtime_env(load_plugins=False)


if __name__ == "__main__":
    sys.exit(main())
