"""metadata-only walk — claimed host 의 share 트리/파일 메타를 적재.

LLM 0. fetch/scan(본문 read)은 #1 점검 에이전트의 몫 — 여기선 폴더 트리/파일 목록/
메타데이터(size·is_text_candidate·suspicious_name)만 DB 에 넣는다(요구 2).

KEEP 불변식:
- claim 단위 = HOST (`smb_host_claim_next`, file-level 금지 — 다중로그인 lockout 회피).
  러너는 collector sentinel session_id 로 claim → 시간기반 reclaim 으로 crash 복구.
- print/spool/driver share 는 `smb_share.excluded_reason='print'` + status='ignored'.
  하위 print 폴더는 하강 안 하고 파일 upsert 안 함 + `error='excluded:print'` 마커.
- truncation 시 checkpoint 재개 루프로 share 를 소진.
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from typing import Any

from domains.smb.plugin.agent_types import smb
from domains.smb.plugin.agent_types import listing_patterns
from service import state_domain as state
from service.collector import print_filter

# print 규칙 제외 파일 표본 상한 — 규모 측정용이라 전량이 아니라 표본이면 충분하다.
_EXCLUDED_SAMPLE_MAX = 20

log = logging.getLogger("service.collector.walk")

# share 당 walk 파일 상한(메타만) — checkpoint 재개로 소진. 한 번에 폭주 방지.
WALK_MAX_FILES_PER_PASS = 1000
WALK_MAX_DEPTH = 4
WALK_MAX_RESUMES = 20  # checkpoint 재개 루프 상한 (무한루프 방지)


def _mark_print_share(share_id: int) -> None:
    state.upsert_smb_directory(
        share_id, "", depth=0, listable=False,
        error=print_filter.EXCLUDED_MARKER,
    )
    state.share_mark_excluded(
        share_id,
        "print",
        summary="print/spool/driver share excluded from SMB E2E review",
    )


def _walk_one_share(host: str, share: str, share_id: int) -> dict[str, int]:
    """한 share 를 메타데이터만 walk(필요 시 checkpoint 재개). 반환 카운트."""
    if print_filter.is_print_share(share):
        # 프린터 공유 — walk 안 함, share-level 제외 플래그 + 호환용 dir 마커.
        _mark_print_share(share_id)
        return {"files": 0, "dirs": 0, "excluded_print": 1, "excluded_share": 1}

    files = dirs = excluded = 0
    excluded_sample: list[str] = []   # print 규칙에 걸린 파일 표본(규모 측정용)
    checkpoint: dict[str, Any] | None = None
    walk_error: str | None = None
    for _ in range(WALK_MAX_RESUMES):
        try:
            res = smb.walk_share_detailed(
                host, share,
                max_files=WALK_MAX_FILES_PER_PASS,
                max_depth=WALK_MAX_DEPTH,
                checkpoint=checkpoint,
            )
        except Exception as e:  # noqa: BLE001 — 한 share 실패가 host 전체를 막지 않음
            if smb.is_communication_unavailable(e):
                raise
            log.warning("[walk] %s/%s 실패: %r", host, share, e)
            # ★ 2026-08-29: 여기서 사유를 **버리고** break 하면 호출부가 실패를 못 본다.
            #   그러면 `walk_file_count=0` 이 "빈 공유" 와 "못 걸었다" 를 같은 값으로
            #   찍는다 — 실측 54공유(triaged_completed 40 · walked 14)가 그 상태였고,
            #   그중엔 인증 없이 읽히는 `12.56.53.81\AE_SERVER`(레이아웃 설계 파일)가
            #   들어 있다. 사유를 들고 나가 호출부가 상태를 가르게 한다.
            walk_error = f"{type(e).__name__}: {str(e)[:180]}"
            break

        # ★ codex 적대검증(2026-08-29) 지적 #2 — **진짜 실패 경로는 여기다.**
        #   `listPath` 실패는 `walk_share_detailed` **안에서** 잡혀 `directory_errors` 로
        #   기록되고 예외로 안 올라온다. 아래 except 는 그걸 절대 못 본다.
        #   루트(depth 0) 목록을 못 읽었으면 그 공유는 "빈 공유" 가 아니라 "못 걸었다" 다.
        #   ⚠️ 하위 디렉터리 실패는 여기 해당 없다 — 일부를 못 읽은 것과 아무것도 못 읽은
        #      것은 다르다. 루트만 본다.
        for de in getattr(res, "directory_errors", None) or []:
            if int(getattr(de, "depth", 1) or 0) == 0:
                walk_error = f"root listing failed: {getattr(de, 'error', '')}"[:200]

        for d in res.directories:
            if print_filter.is_print_path(d.path):
                state.upsert_smb_directory(
                    share_id, d.path, depth=d.depth, listable=False,
                    error=print_filter.EXCLUDED_MARKER,
                )
                excluded += 1
                continue
            state.upsert_smb_directory(
                share_id, d.path, depth=d.depth,
                listable=d.listable, error=d.error,
            )
            dirs += 1

        for de in res.directory_errors:
            state.upsert_smb_directory(
                share_id, de.path, depth=de.depth, listable=False, error=de.error,
            )

        for f in res.files:
            if print_filter.is_print_path(f.path):
                excluded += 1
                # ★ 파일 제외는 **흔적이 안 남는다** — 디렉토리와 달리 `smb_file` 엔 마커
                #   컬럼이 없어서 그냥 skip 하면 DB 에 아무것도 안 남고, 그래서 이 규칙의
                #   폭발반경을 사후에 잴 방법이 없다(실측 2026-08-28: 디렉토리 93개는
                #   `excluded:print` 로 보이는데 파일은 0을 셀 수도 없었다).
                #
                #   ⚠️ 규칙 자체가 의심스럽다: `_DEFAULT_DIR_PATTERNS` 의 `r"print"` 는
                #      앵커가 없어 `Blueprint/`·`sprint2024`·`footprint` 가 걸린다.
                #      실공유 16개에서 `Drivers/PICM`(전자현미경)·`Dll/Spool` 같은 것이
                #      이미 제외됐다. 규칙을 고치기 전에 **규모부터 잰다**(사용자 결정 B→A).
                #
                #   스키마를 늘리지 않고, 샘플을 로그로 남겨 다음 스윕에서 측정 가능하게 한다.
                if len(excluded_sample) < _EXCLUDED_SAMPLE_MAX:
                    excluded_sample.append(f.path)
                continue
            state.upsert_smb_file(
                share_id, f.path,
                size=f.size,
                is_text_candidate=f.is_text_candidate,
                suspicious_name=listing_patterns.suspicious(f.path),
            )
            files += 1

        if res.truncated and res.checkpoint:
            checkpoint = res.checkpoint
            continue
        break

    if excluded:
        log.info(
            "[walk] share=%s print-규칙 파일제외 %d건 (표본 %s)",
            share_id, excluded, excluded_sample[:_EXCLUDED_SAMPLE_MAX],
        )
    return {"files": files, "dirs": dirs, "excluded_print": excluded,
            "excluded_share": 0, "excluded_sample": excluded_sample,
            "walk_error": walk_error}


def walk_claimed_host(host_digest: dict[str, Any]) -> dict[str, int]:
    """claim 된 host digest(smb_host_claim_next 반환)의 share 전부를 walk."""
    host = host_digest["host"]
    shares = host_digest.get("shares") or []
    total = {"shares_walked": 0, "files": 0, "dirs": 0, "excluded_print": 0}
    for s in shares:
        if print_filter.is_print_share(s["share"]):
            _mark_print_share(int(s["id"]))
            total["shares_walked"] += 1
            total["excluded_print"] += 1
            continue
        # read 가능한 share 만 walk (어느 모드로도 못 읽으면 트리 못 봄).
        if not int(s.get("share_read") or 0):
            continue
        counts = _walk_one_share(host, s["share"], int(s["id"]))
        if not int(counts.get("excluded_share") or 0):
            walk_error = counts.get("walk_error")
            if walk_error:
                # ★ 걷기가 **실패**했다. 'walked' 로 찍으면 파일 0건이 "빈 공유" 와
                #   구분이 안 된다.
                #   ⚠️ 새 status 를 만들지 않는다 — `smb_share.status` 는 claim/스윕/
                #      리포트/웹 20여 곳의 `IN (...)` 목록에 하드코딩돼 있어서, 목록에
                #      없는 값은 **어디서도 안 집히는** 조용한 무덤이 된다. 걷기 전
                #      상태인 `pending` 으로 되돌리고 사유만 남긴다. `walk_done_at` 은
                #      **찍지 않는다** — 그게 "걷기를 끝냈다" 의 유일한 표식이다.
                state.share_set_status(
                    int(s["id"]), "pending",
                    walk_file_count=counts["files"],
                    last_error_kind="walk",
                    last_error=str(walk_error)[:400],
                )
            else:
                state.share_set_status(
                    int(s["id"]), "walked",
                    walk_file_count=counts["files"],
                    walk_done_at=time.time(),
                    last_error_kind=None,
                    last_error=None,
                )
        total["shares_walked"] += 1
        total["files"] += counts["files"]
        total["dirs"] += counts["dirs"]
        total["excluded_print"] += counts["excluded_print"]
    return total


def walk_pending_hosts(*, max_hosts: int | None = None) -> dict[str, int]:
    """collector sentinel 로 pending host 를 claim → walk 를 소진할 때까지 반복.

    claim 단위 HOST. None 반환(=claim 할 host 없음)이면 종료.
    """
    agg = {"hosts_walked": 0, "shares_walked": 0, "files": 0, "dirs": 0,
           "excluded_print": 0}
    n = 0
    while True:
        if max_hosts is not None and n >= max_hosts:
            break
        digest = state.smb_host_claim_next(session_id=state.COLLECTOR_SESSION_ID)
        if digest is None:
            break
        host = digest["host"]
        try:
            counts = walk_claimed_host(digest)
            agg["hosts_walked"] += 1
            for k in ("shares_walked", "files", "dirs", "excluded_print"):
                agg[k] += counts[k]
            log.info("[walk] host=%s %s", host, counts)
        except Exception as e:  # noqa: BLE001 — host 실패 시 claim 해제(재시도 가능)
            log.warning("[walk] host=%s 실패: %r — claim 해제", host, e)
            if smb.is_communication_unavailable(e):
                state.smb_host_schedule_communication_retry(
                    host,
                    reason=f"walk communication unavailable: {e!r}",
                    status="pending",
                )
            else:
                # in_progress 였던 share 를 pending 으로 되돌려 다음 pass 재시도.
                for s in digest.get("shares") or []:
                    try:
                        state.share_set_status(int(s["id"]), "pending")
                    except Exception:  # noqa: BLE001
                        pass
        n += 1
    return agg


def walk_pending_hosts_concurrent(
    *,
    max_hosts: int | None = None,
    max_workers: int = 5,
) -> dict[str, int]:
    """pending host 를 IP 단위로 최대 max_workers 개 병렬 walk."""
    workers = max(1, int(max_workers or 1))
    agg = {"hosts_walked": 0, "shares_walked": 0, "files": 0, "dirs": 0,
           "excluded_print": 0}
    claimed = 0
    stop_claiming = False

    def claim_next() -> dict[str, Any] | None:
        nonlocal claimed
        if max_hosts is not None and claimed >= max_hosts:
            return None
        digest = state.smb_host_claim_next(session_id=state.COLLECTOR_SESSION_ID)
        if digest is None:
            return None
        claimed += 1
        log.info("[walk] host claim host=%s", digest["host"])
        return digest

    def walk_digest(digest: dict[str, Any]) -> dict[str, int]:
        host = digest["host"]
        try:
            counts = walk_claimed_host(digest)
            log.info("[walk] host=%s %s", host, counts)
            return counts
        except Exception as e:  # noqa: BLE001 — host 실패 시 claim 해제(재시도 가능)
            log.warning("[walk] host=%s 실패: %r — claim 해제", host, e)
            if smb.is_communication_unavailable(e):
                state.smb_host_schedule_communication_retry(
                    host,
                    reason=f"walk communication unavailable: {e!r}",
                    status="pending",
                )
            else:
                for s in digest.get("shares") or []:
                    try:
                        state.share_set_status(int(s["id"]), "pending")
                    except Exception:  # noqa: BLE001
                        pass
            raise

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures: dict[Any, dict[str, Any]] = {}

        def submit_next() -> bool:
            digest = claim_next()
            if digest is None:
                return False
            futures[pool.submit(walk_digest, digest)] = digest
            return True

        for _ in range(workers):
            submit_next()

        while futures:
            done, _pending = wait(futures, return_when=FIRST_COMPLETED)
            for fut in done:
                _digest = futures.pop(fut)
                try:
                    counts = fut.result()
                except Exception:  # noqa: BLE001
                    stop_claiming = True
                else:
                    agg["hosts_walked"] += 1
                    for k in ("shares_walked", "files", "dirs", "excluded_print"):
                        agg[k] += counts[k]
                if not stop_claiming:
                    submit_next()

    return agg
