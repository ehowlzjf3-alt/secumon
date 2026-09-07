"""smb 리드 어댑터 — 큐=`smb_share` (Phase 2a).

리드 도구 이름은 `_shared/lead_tools.py` 가 고정한다. 여기서는 "smb 에서 그게 무엇인가"만
채운다: 타깃=공유(share), 검토원=`smb_file_inspect`, 닫기=`share_set_status`.

⚠️ `target_detail` 은 **파일 목록**만 준다(`share_files_filtered`) — 본문 없음.
구 리드 프로토타입(`master_tools.ReadFileQuickTool`)이 본문을 반환했는데, 그건 리드
규격이 아니다. 승격한 것은 목록/메타 쪽(`ListShareFilesTool`/`ReadFileMetadataTool`)이다.
"""
from __future__ import annotations

import time
from typing import Any

# smb_share.status 어휘 — 러너/디스커버리가 쓰는 값과 같아야 한다.
def _smb_statuses() -> tuple[str, ...]:
    """smb_share.status 닫힌 enum — 정본은 `service.services.shares.SHARE_STATUSES`.

    ⚠️ 여기에 목록을 **복사하지 마라.** 처음엔 복사했다가 실측에서 틀린 게 드러났다
    (2026-08-21: 실 DB 에는 `closed`/`ignored` 가 있는데 복사본엔 없었고, 복사본에만
    있는 값도 있었다). `share_set_status` 는 검증을 안 하므로 이 enum 이 유일한 가드다.
    """
    from service.services.shares import SHARE_STATUSES

    return tuple(sorted(SHARE_STATUSES))

_DETAIL_FILE_LIMIT = 100


def _list_targets(*, status: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    from service import state_domain as state

    rows = state.lead_targets_overview(
        # ★ **시작한 host 를 먼저 끝낸다**(사용자 결정 2026-08-31). `last_seen DESC` 는
        #   host 를 섞어서, 141개 host 를 하나씩 찔러 놓고 아무것도 완성하지 못했다
        #   (창 200행에 host 122개 · draft 25건이 공유 1~3개만 남기고 멈춤).
        #   smb 는 host 의 공유를 다 봐야 메일 한 통으로 나간다 — 완성이 곧 발송이다.
        "smb_share", status=status, limit=limit, order_by="started_host_first",
        # Q4: 아직 도는 검토원의 타깃은 감춘다 · 백오프 도래 전도 감춘다.
        skip_fresh_claims=True, respect_retry_after=True,
        # ★ print$ 는 설계상 점검 제외다(`print_filter.py`). 큐의 91%가 그것이라
        #   이게 없으면 무필터 목록 200행이 전부 프린터 공유이고, 리드가
        #   `report_no_targets` 로 끝낼 수도 없다(실측: 5건 전부 accepted=false).
        #   ⚠️ 노출 목록(webapp `shares.py`)에서는 계속 보인다 — 여기서만 뺀다.
        exclude_marked=True,
        # Q3: 롤링 재점검 — 끝난 지 SMB_TASK_RESCAN_SECONDS(7일) 지난 triaged_completed 를
        #     다시 큐에 남긴다. 이 조건은 원래 은퇴한 `smb_task_claim_next` 에만 있었고
        #     리드 경로엔 없어서, "주 1회 사이클" 설계가 코드에서 사라져 있었다.
        recheck_after_seconds=state.SMB_TASK_RESCAN_SECONDS)
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append({
            "id": r.get("id"),
            "host": r.get("host"),
            "share": r.get("share"),
            "status": r.get("status"),
            "file_count": r.get("walk_file_count"),
            # ⚠️ `smb_share.hits_count` 는 **이름이 거짓말이다** — 탐지 건수가 아니라
            #    **제출된 finding 개수**다(`smb_submit_finding_tool.py:442` 가 +1,
            #    `_set_status:179` 가 finding_count 로 덮는다). 실측 2026-08-29:
            #    share 1695 는 이 값이 1인데 raw hit 이 15,500건이다.
            #    `hits_count` 라는 이름으로 리드에게 주면 "탐지 0건 = 깨끗한 공유" 로 읽힌다.
            #    사실대로 부른다. 진짜 탐지 수는 `target_hit_summary` 의 total/pending_verdict 다.
            #    (파일 단위 `smb_file.hits_count` 는 진짜 hit 수라 아래 상세에선 그대로 쓴다.)
            "finding_count": r.get("hits_count"),
            "auth": bool(r.get("auth_credential_id")),
            "last_seen": r.get("last_seen"),
        })
    return out


def _target_detail(target_id: int) -> dict[str, Any] | None:
    from service import state_domain as state

    rows = state.lead_targets_overview("smb_share", limit=1, id=int(target_id))
    if not rows:
        return None
    share = rows[0]
    files = state.share_files_filtered(
        int(target_id), offset=0, limit=_DETAIL_FILE_LIMIT)
    items = [{
        "id": it.get("id"),
        "path": it.get("path"),
        "size": it.get("size"),
        "fetch_status": it.get("fetch_status"),
        "suspicious_name": bool(it.get("suspicious_name")),
        "hits_count": it.get("hits_count"),
        "review_status": it.get("review_status"),
    } for it in (files.get("items") or [])]
    from _shared.cred_handle import smb_cred_handles

    return {
        "target_id": int(target_id),
        "host": share.get("host"),
        "share": share.get("share"),
        "status": share.get("status"),
        # 본문 없음 — 경로·크기·상태뿐이다(리드 규격).
        "file_total": files.get("total"),
        "files": items,
        # Phase 2c: 값 없는 크리덴셜 핸들. 리드는 여기 id 를 골라
        # delegate_inspect(use_cred=<id>) 로 **지시만** 한다.
        "cred_handles": smb_cred_handles(),
    }


def _scan_summary(
    target_id: int, *, category: str | None = None, kind: str | None = None,
    verdict: str | None = None, limit: int = 20,
) -> dict[str, Any]:
    """`smb_file_hit` 기반 — 4도메인 중 **유일하게** finding 이전 raw hit 을 갖는다.

    ⚠️ `line_preview` 는 SELECT 하지 않는다(`state_domain.share_hit_shapes` 참조).
    본문 줄은 리드에게 가지 않는다 — 사용자 결정 2026-08-21.
    """
    from service import state_domain as state

    from _shared.hit_view import CATEGORY_PRIORITY

    filters = {"category": category, "kind": kind, "verdict": verdict}
    roll = state.share_hit_rollup(int(target_id), **filters)
    shapes = state.share_hit_shapes(
        int(target_id), limit=limit, priority=CATEGORY_PRIORITY, **filters)
    note = ""
    if not roll:
        # ★ "0건" 과 "안 봤음" 은 다르다. 이 프로젝트에서 반복해서 데인 자리다.
        note = ("저장된 탐지 결과가 0건이다 — 스캔이 안 됐을 수도, 정말 깨끗할 수도 "
                "있다. target_detail 의 fetch_status/scan_status 로 구분하라.")
    return {
        "source": "smb_file_hit",
        "total": sum(int(r.get("count") or 0) for r in roll),
        "rollup": roll, "shapes": shapes, "note": note,
    }


def _run_verb(action: str, *, target_id: int, ref=None, line_no=None) -> dict[str, Any]:
    """smb 닫힌 동사. 지금은 `reachable` 하나 (`_shared/lead_verbs` 참조).

    ⚠️ 도달성 판정은 `agent_types.smb.tcp_alive` — **스윕이 쓰는 것과 같은 정본**이다.
    `lead_verbs.tcp_probe` 로 갈아타지 마라. 같은 질문에 두 개의 답이 생긴다.
    """
    from _shared.lead_verbs import timeout_sec, unsupported

    if action != "reachable":
        return unsupported(action, f"smb 큐는 {action!r} 를 지원하지 않는다")
    from service import state_domain as state

    rows = state.lead_targets_overview("smb_share", limit=1, id=int(target_id))
    host = str((rows[0] if rows else {}).get("host") or "")
    if not host:
        return {"performed": False, "result": "skipped",
                "detail": f"smb_share {target_id} 에 host 가 없다"}
    import time as _t

    from domains.smb.plugin.agent_types import smb as _smb

    t0 = _t.monotonic()
    alive = _smb.tcp_alive(host, 445, timeout=timeout_sec())
    return {"performed": True, "result": "alive" if alive else "dead",
            "port": 445, "ms": int((_t.monotonic() - t0) * 1000)}


def _delegate_input(target_id: int, scope: str | None) -> dict[str, Any]:
    from service import state_domain as state

    rows = state.lead_targets_overview("smb_share", limit=1, id=int(target_id))
    if not rows:
        raise RuntimeError(f"smb_share 없음: {target_id}")
    share = rows[0]
    host = share.get("host")
    if not host:
        raise RuntimeError(f"smb_share {target_id} 에 host 가 없다")
    payload: dict[str, Any] = {
        "host": str(host),
        "share_ids": [int(target_id)],
        "share_id": int(target_id),
    }
    if scope:
        payload["scope"] = scope
    return payload


def _set_status(
    target_id: int, status: str, *,
    finding_count: int | None = None, reason: str | None = None,
) -> dict[str, Any]:
    """리드가 공유를 닫는 **유일한** 자리.

    ★ 2026-08-29: 여기엔 백스톱이 하나도 없었다. 검토원 계약(`inspect_contract`)에는
      둘 다 있었지만 `if is_delegated_inspector(): ... return` **아래**라, 운영이
      전부 위임 경로가 된 뒤로는 아무도 그 자리를 지나가지 않는다.
      결과: 권고 283건 중 271건(95.8%)이 "제출 없이 완료" 로 닫혔고,
      인증 없이 읽히는 `12.36.127.132\\share` 의 개인키 hit 2건이 finding 0으로 닫혔다.
    """
    from domains.smb.plugin import share_close_backstop as backstop
    from domains.smb.plugin.inspect_contract import _RESCAN_SOON_SECONDS
    from service import state_domain as state

    fields: dict[str, Any] = {"processed_at": time.time()}
    if finding_count is not None:
        fields["hits_count"] = int(finding_count)
    extra = backstop.apply(
        int(target_id), status,
        saw_submit=bool(finding_count), rescan_soon_seconds=_RESCAN_SOON_SECONDS)
    fields.update(backstop.db_fields(extra))
    if extra.get("_exposure_finding_id") and not fields.get("hits_count"):
        # 노출 자체를 남겼으면 "0건" 이라고 적지 않는다.
        fields["hits_count"] = 1
    state.share_set_status(int(target_id), status, **fields)
    out: dict[str, Any] = {"queue": "smb_share", "reason": reason}
    if extra.get("_exposure_finding_id"):
        out["exposure_finding_id"] = extra["_exposure_finding_id"]
        out["note"] = ("제출이 없어 **노출 자체**를 draft finding 으로 남겼다 — "
                       "공유가 열려 있다는 사실은 그 자체로 보고 대상이다.")
    if extra.get("_pending_left"):
        out["pending_files_left"] = extra["_pending_left"]
        out["recheck_in_hours"] = round(_RESCAN_SOON_SECONDS / 3600, 1)
    return out


def smb_lead_adapter():
    from _shared.lead_adapter import LeadAdapter

    return LeadAdapter(
        domain="smb",
        inspect_agent="smb_file_inspect",
        statuses=_smb_statuses(),
        # ★ smb 의 판정대기는 `walked`/`listing_reviewed` 다 — `pending` 이 아니다.
        #   `smb_task_claim_next` 주석: "수집기가 채운 walked/listing_reviewed(판정 대기)".
        #   2026-08-26 실측: pending 0건 / walked 1건 → pending 으로 물으면 영원히 idle.
        claimable_statuses=("walked", "listing_reviewed", "pending", "in_progress"),
        queue_label="SMB share 큐",
        list_targets=_list_targets,
        target_detail=_target_detail,
        scan_summary=_scan_summary,
        run_verb=_run_verb,
        delegate_input=_delegate_input,
        set_status=_set_status,
    )
