"""per-subnet sweep — host 발견 + 3모드 share 권한 측정 → smb_share 적재.

LLM 0. 기존 `smb.enumerate_hosts`/`smb.list_shares_modes` + `state_domain.upsert_smb_share`
만 사용(재구현 아님). 구 모놀리스 `cli.run_smb_discovery_core` 패턴을 skill repo 로 재구성.

KEEP 불변식:
- `reset_auth_lockout_flag()` 는 **러너가 pass 시작에 1회만** 호출 — 이 모듈은 호출하지
  않는다(요구: core/agent 호출 금지). lockout 은 reactive (smb.list_shares_modes 가
  처리). lockout 감지 시 이후 host 는 auth 모드 자동 skip.
- print$ 등 프린터 share 는 discovery 단계에서도 walk 대상에서 빠지도록 마킹만
  하고 적재(존재는 기록, walk_core 가 건너뜀).
"""
from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from domains.smb.plugin.agent_types import smb
from service import state_domain as state

log = logging.getLogger("service.collector.sweep")

# IDS 마진 — 동시 445 connect / share-list 상한 (요구: 64 cap).
DEFAULT_HOST_CONCURRENCY = 64
DEFAULT_SHARE_WORKERS = 12


def _modes_summary(mm: "smb.SmbHostMultiMode") -> dict[str, Any]:
    """ShareAccess 목록 → state.upsert_smb_share access_modes JSON 페이로드."""
    out: dict[str, Any] = {"login_errors": dict(mm.login_errors or {}), "shares": {}}
    for sa in mm.shares:
        out["shares"][sa.share] = dict(sa.modes)
    return out


def _ok(modes: dict[str, dict[str, bool]], mode: str, key: str) -> bool:
    m = modes.get(mode) or {}
    return bool(m.get(key))


def sweep_subnet(
    subnet: str,
    *,
    scan_id: int,
    host_concurrency: int = DEFAULT_HOST_CONCURRENCY,
    share_workers: int = DEFAULT_SHARE_WORKERS,
) -> dict[str, int]:
    """한 subnet 를 sweep 해 smb_share 를 적재. 반환 카운트 dict.

    호출 전제: 러너가 이미 `smb.reset_auth_lockout_flag()` 를 pass 시작에 1회 호출.
    """
    hosts = smb.enumerate_hosts(subnet, concurrency=host_concurrency)
    log.info("[sweep] subnet=%s alive_hosts=%d", subnet, len(hosts))

    accessible = 0
    new_count = 0
    shares_found = 0

    def _probe(host: str) -> "tuple[str, smb.SmbHostMultiMode | None]":
        try:
            return host, smb.list_shares_modes(host)
        except Exception as e:  # noqa: BLE001 — 한 host 실패가 sweep 을 멈추지 않음
            log.warning("[sweep] list_shares_modes(%s) 실패: %r", host, e)
            return host, None

    # ThreadPool 병렬 share-list (네트워크 I/O bound). lockout 은 smb 모듈이 프로세스
    # 전역으로 처리하므로 워커 간 공유됨 — 첫 lockout 후 auth 모드 자동 skip.
    with ThreadPoolExecutor(max_workers=max(1, share_workers)) as pool:
        results = list(pool.map(_probe, hosts))

    for host, mm in results:
        if mm is None:
            continue
        any_share = False
        for sa in mm.shares:
            modes = sa.modes
            null_ok = _ok(modes, "null", "read")
            guest_ok = _ok(modes, "guest", "read")
            auth_ok = _ok(modes, "auth", "read")
            share_read = null_ok or guest_ok or auth_ok
            share_write = sa.any_write
            if not (share_read or share_write):
                # 어느 모드로도 read/write 못 하면 적재 가치 없음 (존재만 — skip).
                continue
            any_share = True
            shares_found += 1
            action, _share_id = state.upsert_smb_share(
                scan_id, subnet, host, sa.share,
                null_login_ok=null_ok,
                guest_login_ok=guest_ok,
                auth_login_ok=auth_ok,
                share_read=share_read,
                share_write=share_write,
                access_modes={"per_share": dict(modes),
                              "host_login_errors": dict(mm.login_errors or {})},
            )
            if action == "new":
                new_count += 1
        if any_share:
            accessible += 1

    # 이번 scan 에서 안 보인 share 처리:
    # - host 는 살아있는데 share 가 안 보이면 닫힘/권한제거로 closed
    # - host 자체가 445 alive 가 아니면 PC off/네트워크 차단으로 보고 8h 재시도
    unseen = state.smb_unseen_since_scan_apply(
        scan_id,
        subnets=[subnet],
        alive_hosts=hosts,
    )
    closed = unseen["closed"]
    state.subnet_mark_swept(
        subnet, scan_id=scan_id,
        hosts_found=len(hosts), shares_found=shares_found,
    )
    counts = {
        "alive_hosts": len(hosts),
        "accessible_hosts": accessible,
        "shares_found": shares_found,
        "new_shares": new_count,
        "closed_shares": closed,
        "retry_scheduled": unseen["retry_scheduled"],
    }
    log.info("[sweep] subnet=%s done %s", subnet, counts)
    return counts


# ============================================================
# discovery 오케스트레이션 — operator 인터랙티브 트리거(run_smb_discovery) 용.
# 구 모놀리스 `cli.resolve_smb_targets` + `cli.run_smb_discovery_core`(de-domain 으로
# 코어에서 제거됨) 를 skill collector 로 재구성. sweep_subnet 재사용(재구현 아님).
# collector cron(runner.py)은 subnet 별 claim+scan 을 쓰지만, 이 경로는 operator 가
# "지금 이 대역들 1회 훑어" 하는 단발 실행 → 대상 전체를 단일 scan 으로 집계한다.
# ============================================================

def resolve_smb_targets(subnets: list[str] | None) -> list[str]:
    """스캔 대상 CIDR 결정. input 명시하면 그것만, 비면 DB enabled 풀.

    codex 리뷰: CIDR 을 정규화하고 순서보존 중복제거한다 — 같은 대역을 두 번 스윕해
    alive/accessible 카운트가 이중집계되는 것을 막는다. (겹침(overlap) 거부는 후속 하드닝.)
    """
    if subnets:
        raw = list(subnets)
    else:
        raw = [r["subnet"] for r in state.smb_target_list(enabled_only=True)]
    seen: set[str] = set()
    out: list[str] = []
    for s in raw:
        try:
            norm = state._normalize_cidr(s)
        except Exception:  # noqa: BLE001 — 이상 입력은 정규화 없이 통과(스윕이 0건 처리)
            norm = s
        if norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


async def run_smb_discovery_core(
    targets: list[str],
    *,
    is_aborted: "Callable[[], bool] | None" = None,
    host_concurrency: int = DEFAULT_HOST_CONCURRENCY,
    share_workers: int = DEFAULT_SHARE_WORKERS,
) -> dict[str, Any]:
    """대상 subnet 들을 1회 discovery — scan_start → 각 subnet sweep → scan_finish.

    반환: scan_id / alive_total / accessible_total / new_count / closed_count /
          login_stats / cancelled / status / errors.

    KEEP 불변식: `smb.reset_auth_lockout_flag()` 는 pass 오너(=이 함수)가 시작에 1회만
    호출한다(러너와 동일 패턴). 중간 재-reset 은 AD 계정 lockout 을 연장할 수 있어 금지.
    subnet 단위 실패는 전체 discovery 를 멈추지 않고 다음 subnet 으로 진행한다.

    codex 리뷰 반영: scan_finish 는 **finally 로 항상** 실행 — 협조적 취소(is_aborted)뿐
    아니라 예외/CancelledError 로 중단돼도 scan row 가 dangling 되지 않는다. subnet 실패는
    errors 에 모으고, 종료 상태를 status(ok|partial|cancelled)로 명시한다.

    주의(후속 하드닝): 이 경로는 subnet claim 을 하지 않는다. collector cron 이 같은 대역을
    동시 스윕하면 관측/claim 이 경합할 수 있다(현재 이 툴은 런타임 미배선이라 실사용 없음 —
    배선 시 owner-fenced claim 또는 running-pass 가드 필요). [S3c/S3-하드닝]
    """
    scan_id = state.scan_start("smb", list(targets))
    smb.reset_auth_lockout_flag()  # pass 오너 1회 — AD lockout 회로차단 불변식
    _ok, _why = smb.verify_auth_credential(state.smb_auth_verified_hosts())
    log.info("[sweep] auth 센티넬: %s", _why)

    agg = {"alive_total": 0, "accessible_total": 0, "new_count": 0, "closed_count": 0}
    errors: list[str] = []
    cancelled = False
    try:
        for subnet in targets:
            if is_aborted is not None and is_aborted():
                cancelled = True
                break
            try:
                counts = await asyncio.to_thread(
                    sweep_subnet, subnet,
                    scan_id=scan_id,
                    host_concurrency=host_concurrency,
                    share_workers=share_workers,
                )
            except Exception:  # noqa: BLE001 — subnet 단위 실패는 다음 subnet 을 막지 않음
                log.exception("[discovery] subnet sweep 실패 subnet=%s", subnet)
                errors.append(subnet)
                continue
            agg["alive_total"] += counts["alive_hosts"]
            agg["accessible_total"] += counts["accessible_hosts"]
            agg["new_count"] += counts["new_shares"]
            agg["closed_count"] += counts["closed_shares"]
    finally:
        # 취소/예외 무엇이든 scan 은 항상 마감 (codex: CancelledError 로 scan_finish 스킵 방지).
        state.scan_finish(
            scan_id,
            alive_total=agg["alive_total"],
            accessible_total=agg["accessible_total"],
            new_count=agg["new_count"],
            closed_count=agg["closed_count"],
        )
    status = "cancelled" if cancelled else ("partial" if errors else "ok")
    return {
        "scan_id": scan_id, **agg,
        "login_stats": {}, "cancelled": cancelled,
        "status": status, "errors": errors,
    }
