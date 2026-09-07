"""dev_web 리드 어댑터 — 큐=`dev_web_target` (Phase 2a).

리드 도구 이름은 `_shared/lead_tools.py` 가 고정한다. 여기서는 "dev_web 에서 그게 무엇인가"만
채운다: 타깃=URL, 검토원=`dev_web_inspect`, 닫기=`dev_web_target_set_status`.
"""
from __future__ import annotations

from typing import Any

DEV_WEB_STATUSES: tuple[str, ...] = (
    "pending", "in_progress", "tasked", "skipped", "error",
)


def _row_summary(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": r.get("id"),
        "url": r.get("url"),
        "domain": r.get("domain"),
        "status": r.get("status"),
        "source": r.get("source"),
        "event_count": r.get("event_count"),
        "priority_score": r.get("priority_score"),
        "finding_count": r.get("finding_count"),
        "last_reason": r.get("last_reason"),
        "last_task_at": r.get("last_task_at"),
    }


def _list_targets(*, status: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    from service import state_domain as state

    rows = state.lead_targets_overview(
        "dev_web_target", status=status, limit=limit,
        # ★ 메일이 걸린 target 을 먼저 끝낸다(smb 와 같은 규칙, 2026-08-31).
        #   제출 시점에 스레드가 draft 로 열리고 target 이 끝나야 큐로 올라간다 —
        #   그 사이에 멈춘 것이 곧 안 나가는 메일이다. 기존 우선순위는 그 뒤에 그대로 산다.
        order_by="started_target_first",
        # Q4: 아직 도는 검토원의 타깃은 감춘다 · 백오프 도래 전도 감춘다.
        skip_fresh_claims=True, respect_retry_after=True,)
    return [_row_summary(r) for r in rows]


def _target_detail(target_id: int) -> dict[str, Any] | None:
    from service import state_domain as state

    row = state.dev_web_target_get(int(target_id))
    if row is None:
        return None
    # 본문 없음 — 좌표와 큐 메타뿐이다(리드 규격). 라우트/응답 본문은 검토원이 본다.
    return {"target_id": int(target_id), **_row_summary(row),
            "day_bucket": row.get("day_bucket"),
            "evidence_ref": row.get("evidence_ref")}


def _scan_summary(
    target_id: int, *, category: str | None = None, kind: str | None = None,
    verdict: str | None = None, limit: int = 20,
) -> dict[str, Any]:
    """dev_web 은 raw hit 을 영속하지 않는다 — `finding_lifecycle` 을 host 로 잇는다."""
    from urllib.parse import urlparse

    from service import state_domain as state

    from _shared.hit_view import finding_hit_summary

    row = state.dev_web_target_get(int(target_id))
    host = urlparse(str((row or {}).get("url") or "")).hostname
    if not host:
        return {"source": "none", "total": 0, "rollup": [], "shapes": [],
                "note": f"dev_web_target {target_id} 에서 host 를 못 뽑았다"}
    return finding_hit_summary(
        task_type="dev_web", asset_like=f"%//{str(host).lower()}%",
        category=category, kind=kind, verdict=verdict)


def _run_verb(action: str, *, target_id: int, ref=None, line_no=None) -> dict[str, Any]:
    """dev_web 닫힌 동사. 지금은 `reachable` 하나 (`_shared/lead_verbs` 참조).

    dev_web 은 타깃마다 **호스트가 다르다**(`xbot--…dev-ide.cdep…`, `jjhfolder--…prod.cdep…`)
    — 그래서 타깃별 도달성이 실제 정보다. 호스트를 공유하는 큐(github/confluence)에서는
    같은 동사가 항상 alive 를 돌려줘 오히려 오해를 부른다(그쪽은 미지원으로 둔다).
    """
    from service import state_domain as state

    from _shared.lead_verbs import unsupported, url_reachable

    if action != "reachable":
        return unsupported(action, f"dev_web 큐는 {action!r} 를 지원하지 않는다")
    row = state.dev_web_target_get(int(target_id))
    url = str((row or {}).get("url") or "")
    if not url:
        return {"performed": False, "result": "skipped",
                "detail": f"dev_web_target {target_id} 에 url 이 없다"}
    return url_reachable(url)


def _delegate_input(target_id: int, scope: str | None) -> dict[str, Any]:
    payload: dict[str, Any] = {"target_id": int(target_id)}
    if scope:
        payload["scope"] = scope
    return payload


def _set_status(
    target_id: int, status: str, *,
    finding_count: int | None = None, reason: str | None = None,
) -> dict[str, Any]:
    from service import state_domain as state

    fields: dict[str, Any] = {}
    if finding_count is not None:
        fields["finding_count"] = int(finding_count)
    if reason is not None:
        fields["last_reason"] = reason
    state.dev_web_target_set_status(int(target_id), status, **fields)
    return {"queue": "dev_web_target", **fields}


def dev_web_lead_adapter():
    from _shared.lead_adapter import LeadAdapter

    return LeadAdapter(
        domain="dev_web",
        inspect_agent="dev_web_inspect",
        statuses=DEV_WEB_STATUSES,
        # 주기 재개형 — `tasked/skipped/error` 도 `last_task_at` 이 오래되면 다시 열린다
        # (`dev_web_target_claim_next` 술어). 그래서 사실상 전 상태다.
        claimable_statuses=DEV_WEB_STATUSES,
        queue_label="dev/stage 웹 타깃 큐",
        list_targets=_list_targets,
        target_detail=_target_detail,
        scan_summary=_scan_summary,
        run_verb=_run_verb,
        delegate_input=_delegate_input,
        set_status=_set_status,
    )
