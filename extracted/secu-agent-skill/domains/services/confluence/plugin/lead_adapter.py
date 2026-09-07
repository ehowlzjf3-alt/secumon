"""confluence 리드 어댑터 2종 — space 큐 / keyword_search 큐 (Phase 2a).

## 왜 둘인가

검토원을 둘로 나눈 것과 **같은 이유**다(Phase 1). 큐가 둘이고 상태 도구가 다르다:
`confluence_space_target` ↔ `confluence_search_target`. 하나로 합치면 검색 리드가
space 큐를 닫을 수 있고, 그건 에러를 내지 않는다 — 조용히 틀린다.

리드 도구 이름은 양쪽 다 같다(`list_targets`/`set_target_status`/…) — 어댑터만 다르다.
그게 "구현방법 동일" 의 의미다.
"""
from __future__ import annotations

import json
from typing import Any

CONFLUENCE_STATUSES: tuple[str, ...] = (
    "pending", "in_progress", "tasked", "skipped", "error",
)


# ── space 큐 ──────────────────────────────────────────────────────────

def _space_summary(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": r.get("id"),
        "space_key": r.get("space_key"),
        "space_name": r.get("space_name"),
        "space_type": r.get("space_type"),
        "status": r.get("status"),
        "finding_count": r.get("finding_count"),
        "last_reason": r.get("last_reason"),
        "last_scanned_at": r.get("last_scanned_at"),
    }


def _space_list(*, status: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    from service import state_domain as state

    rows = state.lead_targets_overview(
        # ★ 높음 우선 + 묶는 단위 우선 — 4도메인 같은 규칙(사용자 결정 2026-08-31).
        #   ① 높음 이상 스레드가 걸린 대상 ② 조치요청 스레드가 살아 있는 대상 ③ 기존 순서
        "confluence_space_target", status=status, limit=limit,
        order_by="started_target_first",
        # Q4: 아직 도는 검토원의 타깃은 감춘다 · 백오프 도래 전도 감춘다.
        skip_fresh_claims=True, respect_retry_after=True,)
    return [_space_summary(r) for r in rows]


def _space_detail(target_id: int) -> dict[str, Any] | None:
    from service import state_domain as state

    row = state.confluence_space_target_get(int(target_id))
    if row is None:
        return None
    # 본문 없음 — space key/이름/큐 메타뿐이다. 페이지 본문은 검토원이 본다.
    return {"target_id": int(target_id), **_space_summary(row),
            "cycle_key": row.get("cycle_key")}


def _space_scan_summary(
    target_id: int, *, category: str | None = None, kind: str | None = None,
    verdict: str | None = None, limit: int = 20,
) -> dict[str, Any]:
    """confluence 는 raw hit 을 영속하지 않는다 — finding asset URL 의 space key 로 잇는다.

    실측 asset: `https://confluence.samsungds.net/spaces/<KEY>/pages/<id>/<title>`.
    """
    from service import state_domain as state

    from _shared.hit_view import finding_hit_summary

    row = state.confluence_space_target_get(int(target_id))
    key = str((row or {}).get("space_key") or "").strip()
    if not key:
        return {"source": "none", "total": 0, "rollup": [], "shapes": [],
                "note": f"confluence_space_target {target_id} 에 space_key 가 없다"}
    return finding_hit_summary(
        task_type="confluence", asset_like=f"%/spaces/{key.lower()}/%",
        category=category, kind=kind, verdict=verdict)


def _run_verb(action: str, *, target_id: int, ref=None, line_no=None) -> dict[str, Any]:
    """confluence 닫힌 동사 — 지금은 **없다.** 두 큐(space/keyword)가 같다.

    ★ github 과 같은 이유다. 모든 타깃이 `confluence.samsungds.net` 하나를 쓰므로 TCP 는
    항상 alive 이고, 실측에서 이 큐의 실패는 전부 **HTTP 403**(권한)이었다. 도달성 동사는
    그 403 을 alive 로 덮어 리드가 세션을 계속 열게 만든다.
    """
    from _shared.lead_verbs import unsupported

    return unsupported(
        action,
        "confluence 타깃은 호스트를 공유해 도달성이 항상 alive 다 — 실측 실패는 전부 "
        "HTTP 403(권한)이었다. 접근 가능 여부는 검토원에게 물어라(verdict=blocked).")


def _space_delegate_input(target_id: int, scope: str | None) -> dict[str, Any]:
    from service import state_domain as state

    row = state.confluence_space_target_get(int(target_id))
    if row is None:
        raise RuntimeError(f"confluence_space_target 없음: {target_id}")
    # 검토원 user message 는 kind='space_batch' 를 받는다
    # (`confluence_task_worker._build_user_text`).
    payload: dict[str, Any] = {
        "kind": "space_batch",
        "target_ids": [int(target_id)],
        "space_keys": [row.get("space_key")],
    }
    if scope:
        payload["scope"] = scope
    return payload


def _space_set_status(
    target_id: int, status: str, *,
    finding_count: int | None = None, reason: str | None = None,
) -> dict[str, Any]:
    from service import state_domain as state

    fields: dict[str, Any] = {}
    if finding_count is not None:
        fields["finding_count"] = int(finding_count)
    if reason:
        fields["last_reason"] = reason[:500]
    state.confluence_space_target_set_status(int(target_id), status, **fields)
    return {"queue": "confluence_space_target", **fields}


def confluence_lead_adapter():
    from _shared.lead_adapter import LeadAdapter

    return LeadAdapter(
        domain="confluence",
        inspect_agent="confluence_inspect",
        statuses=CONFLUENCE_STATUSES,
        # 주기 재개형 — claim 술어가 `cycle_key=현재주차 AND cycle_scanned_at IS NULL`
        # 이라 **skipped 도 주가 바뀌면 다시 열린다**. 실측(2026-08-26): space 25건이
        # 전부 skipped 인데 평면 레인이 하루 255번 돌았다.
        claimable_statuses=CONFLUENCE_STATUSES,
        queue_label="Confluence space 큐",
        list_targets=_space_list,
        target_detail=_space_detail,
        scan_summary=_space_scan_summary,
        run_verb=_run_verb,
        delegate_input=_space_delegate_input,
        set_status=_space_set_status,
    )


# ── keyword_search 큐 ─────────────────────────────────────────────────

def _search_summary(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": r.get("id"),
        "keyword": r.get("keyword"),
        "status": r.get("status"),
        "finding_count": r.get("finding_count"),
        "last_reason": r.get("last_reason"),
        "last_scanned_at": r.get("last_scanned_at"),
    }


def _search_list(*, status: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    from service import state_domain as state

    rows = state.lead_targets_overview(
        "confluence_search_target", status=status, limit=limit, order_by="id DESC",
        # Q4: 아직 도는 검토원의 타깃은 감춘다 · 백오프 도래 전도 감춘다.
        skip_fresh_claims=True, respect_retry_after=True,)
    return [_search_summary(r) for r in rows]


def _scope_space_keys(row: dict[str, Any]) -> list[str] | None:
    raw = row.get("scope_json")
    if not raw:
        return None
    try:
        got = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return None
    if isinstance(got, dict):
        got = got.get("space_keys")
    if isinstance(got, list):
        return [str(x) for x in got]
    return None


def _search_detail(target_id: int) -> dict[str, Any] | None:
    from service import state_domain as state

    row = state.confluence_search_target_get(int(target_id))
    if row is None:
        return None
    return {"target_id": int(target_id), **_search_summary(row),
            "scope_space_keys": _scope_space_keys(row),
            "cycle_key": row.get("cycle_key")}


def _search_scan_summary(
    target_id: int, *, category: str | None = None, kind: str | None = None,
    verdict: str | None = None, limit: int = 20,
) -> dict[str, Any]:
    """키워드검색 큐에는 hit view 를 줄 수 없다 — **없는 것을 없다고 말한다.**

    타깃은 키워드이고 finding 의 asset 은 페이지 URL 이다. 둘을 잇는 키가 DB 에 없다
    (`confluence_search_target` 에 finding 역참조가 없고, finding extra 에 키워드가
    안 남는다). 여기서 space 큐처럼 URL 로 근사하면 **다른 타깃의 결과를 이 타깃 것으로
    보여주게 된다** — 조용히 틀리는 쪽이라 하지 않는다.
    """
    return {
        "source": "none", "total": 0, "rollup": [], "shapes": [],
        "note": ("키워드검색 큐는 타깃(키워드)과 finding(페이지 URL) 을 잇는 키가 "
                 "없어 hit view 를 줄 수 없다. space 큐(confluence)에서 보라."),
    }


def _search_delegate_input(target_id: int, scope: str | None) -> dict[str, Any]:
    from service import state_domain as state

    row = state.confluence_search_target_get(int(target_id))
    if row is None:
        raise RuntimeError(f"confluence_search_target 없음: {target_id}")
    search: dict[str, Any] = {"keywords": [row.get("keyword")]}
    keys = _scope_space_keys(row)
    if keys:
        search["scope_space_keys"] = keys
    payload: dict[str, Any] = {
        "kind": "keyword_search",
        "target_ids": [int(target_id)],
        "searches": [search],
    }
    if scope:
        payload["scope"] = scope
    return payload


def _search_set_status(
    target_id: int, status: str, *,
    finding_count: int | None = None, reason: str | None = None,
) -> dict[str, Any]:
    from service import state_domain as state

    fields: dict[str, Any] = {}
    if finding_count is not None:
        fields["finding_count"] = int(finding_count)
    if reason:
        fields["last_reason"] = reason[:500]
    state.confluence_search_target_set_status(int(target_id), status, **fields)
    return {"queue": "confluence_search_target", **fields}


def confluence_search_lead_adapter():
    from _shared.lead_adapter import LeadAdapter

    return LeadAdapter(
        domain="confluence_search",
        inspect_agent="confluence_search_inspect",
        statuses=CONFLUENCE_STATUSES,
        # 주기 재개형 — claim 술어가 `cycle_key=현재주차 AND cycle_scanned_at IS NULL`
        # 이라 **skipped 도 주가 바뀌면 다시 열린다**. 실측(2026-08-26): space 25건이
        # 전부 skipped 인데 평면 레인이 하루 255번 돌았다.
        claimable_statuses=CONFLUENCE_STATUSES,
        queue_label="Confluence 키워드검색 큐",
        list_targets=_search_list,
        target_detail=_search_detail,
        scan_summary=_search_scan_summary,
        run_verb=_run_verb,
        delegate_input=_search_delegate_input,
        set_status=_search_set_status,
    )
