"""github 리드 어댑터 — 큐=`devops_target` (service='github') (Phase 2a).

⚠️ `devops_target` 은 github 과 confluence 가 **공유하는** 테이블이다. 이 어댑터는
`service='github'` 로 좁힌다 — 안 그러면 github 리드가 confluence 타깃을 닫는다.
"""
from __future__ import annotations

from typing import Any

GITHUB_STATUSES: tuple[str, ...] = (
    "pending", "in_progress", "tasked", "skipped", "error",
)

_SERVICE = "github"


def _row_summary(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": r.get("id"),
        "url": r.get("url"),
        "service": r.get("service"),
        "status": r.get("status"),
        "source": r.get("source"),
        "access_count": r.get("access_count"),
        "finding_count": r.get("finding_count"),
        "last_reason": r.get("last_reason"),
        "last_task_at": r.get("last_task_at"),
    }


def _list_targets(*, status: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    from service import state_domain as state

    rows = state.lead_targets_overview(
        "devops_target", status=status, limit=limit,
        # ★ 높음 우선 + 묶는 단위 우선 — 4도메인 같은 규칙(사용자 결정 2026-08-31).
        #   ① 높음 이상 스레드가 걸린 대상 ② 조치요청 스레드가 살아 있는 대상 ③ 기존 순서
        order_by="started_target_first", service=_SERVICE,
        # Q4: 아직 도는 검토원의 타깃은 감춘다 · 백오프 도래 전도 감춘다.
        skip_fresh_claims=True, respect_retry_after=True,)
    return [_row_summary(r) for r in rows]


def _get_scoped(target_id: int) -> dict[str, Any] | None:
    from service import state_domain as state

    row = state.devops_target_get(int(target_id))
    if row is None or str(row.get("service") or "") != _SERVICE:
        return None
    return row


def _target_detail(target_id: int) -> dict[str, Any] | None:
    row = _get_scoped(target_id)
    if row is None:
        return None
    # 본문 없음 — repo/URL 좌표와 큐 메타뿐이다. 코드는 검토원이 본다.
    return {"target_id": int(target_id), **_row_summary(row),
            "day_bucket": row.get("day_bucket"),
            "cycle_key": row.get("cycle_key")}


def _repo_slug(url: str) -> str | None:
    """`https://github.samsungds.net/org/repo(.git)` → `org/repo`.

    finding asset 은 `github:<org>/<repo>/<path>` 형식이다(실측). 그 접두어를 만든다.
    """
    from urllib.parse import urlparse

    path = urlparse(str(url or "")).path.strip("/")
    if path.endswith(".git"):
        path = path[: -len(".git")]
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        return None
    return f"{parts[0]}/{parts[1]}"


def _scan_summary(
    target_id: int, *, category: str | None = None, kind: str | None = None,
    verdict: str | None = None, limit: int = 20,
) -> dict[str, Any]:
    """github 은 raw hit 을 영속하지 않는다 — `finding_lifecycle` 을 repo slug 로 잇는다.

    실측(2026-08-21): 최근 타깃 300개 중 219개(73%)가 이미 finding 이 있는 repo 다.
    """
    from _shared.hit_view import finding_hit_summary

    row = _get_scoped(target_id)
    slug = _repo_slug(str((row or {}).get("url") or ""))
    if not slug:
        return {"source": "none", "total": 0, "rollup": [], "shapes": [],
                "note": f"devops_target {target_id} URL 에서 org/repo 를 못 뽑았다"}
    return finding_hit_summary(
        task_type="github", asset_like=f"github:{slug.lower()}/%",
        category=category, kind=kind, verdict=verdict)


def _run_verb(action: str, *, target_id: int, ref=None, line_no=None) -> dict[str, Any]:
    """github 닫힌 동사 — 지금은 **없다.** 없는 것을 없다고 말한다.

    ★ `reachable` 을 여기 붙이면 안 된다. github 타깃은 전부 같은 호스트
    (`github.samsungds.net`)라 TCP 는 **항상 alive** 다. 그런데 실측에서 이 큐의 실패는
    도달성이 아니라 **권한**이었다(`repo metadata not found` / SSO 벽 / private).
    항상 alive 를 돌려주는 동사는 정보가 0이면서 리드에게 "살아 있으니 봐도 된다" 는
    잘못된 신호를 준다 — 조용히 틀리는 쪽이라 만들지 않는다.

    접근 가능 여부는 검토원이 판정하고 `report_inspection(verdict="blocked")` 로 답한다.
    """
    from _shared.lead_verbs import unsupported

    return unsupported(
        action,
        "github 타깃은 호스트를 공유해 도달성이 항상 alive 다 — 이 큐의 실패는 권한이지 "
        "도달성이 아니다. 접근 가능 여부는 검토원에게 물어라(verdict=blocked).")


def _delegate_input(target_id: int, scope: str | None) -> dict[str, Any]:
    row = _get_scoped(target_id)
    if row is None:
        raise RuntimeError(f"devops_target(service={_SERVICE}) 없음: {target_id}")
    # github 검토원의 user message 는 kind='sso_url' 만 받는다
    # (`github_task_worker._build_user_text`) — 그 계약을 그대로 만족시킨다.
    payload: dict[str, Any] = {
        "kind": "sso_url",
        "target_id": int(target_id),
        "url": row.get("url"),
    }
    if scope:
        payload["scope"] = scope
    return payload


def _set_status(
    target_id: int, status: str, *,
    finding_count: int | None = None, reason: str | None = None,
) -> dict[str, Any]:
    from service import state_domain as state

    if _get_scoped(target_id) is None:
        raise RuntimeError(f"devops_target(service={_SERVICE}) 없음: {target_id}")
    fields: dict[str, Any] = {}
    if finding_count is not None:
        fields["finding_count"] = int(finding_count)
    if reason is not None:
        fields["last_reason"] = reason
    state.devops_target_set_status(int(target_id), status, **fields)
    return {"queue": "devops_target", "service": _SERVICE, **fields}


def github_lead_adapter():
    from _shared.lead_adapter import LeadAdapter

    return LeadAdapter(
        domain="github",
        inspect_agent="github_inspect",
        statuses=GITHUB_STATUSES,
        # 주기 재개형 — `devops_target_claim_next` 이 tasked/skipped/error 도
        # `last_task_at` 기준으로 다시 연다.
        claimable_statuses=GITHUB_STATUSES,
        queue_label="GitHub 타깃 큐",
        list_targets=_list_targets,
        target_detail=_target_detail,
        scan_summary=_scan_summary,
        run_verb=_run_verb,
        delegate_input=_delegate_input,
        set_status=_set_status,
    )
