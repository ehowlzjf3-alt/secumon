"""dev_web_submit_finding — generic finding write plus dev_web E2E transition."""
from __future__ import annotations

import json
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.schema.finding import TaskFinding
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolResult, ToolSuccess
from secu_agent.agent.tools.submit_finding import SubmitFindingTool, _asset_kind_from_location
from secu_agent.finding_taxonomy import canonical_task_type, host_of

from service import state_domain as state
from service.services.finding_verification import make_agent_verification


class DevWebSubmitFindingInput(BaseModel):
    finding: TaskFinding
    target_id: int | None = Field(
        default=None,
        description="dev_web_target.id. 제공되면 report thread와 target 진행률에 연결한다.",
    )
    report_note: str | None = Field(default=None, max_length=2000)


class DevWebSubmitFindingTool(SubmitFindingTool):
    name: ClassVar[str] = "dev_web_submit_finding"
    domain: ClassVar[str] = "dev_web"
    input_model: ClassVar[type[BaseModel]] = DevWebSubmitFindingInput
    search_hint: ClassVar[str] = "dev_web submit finding report thread e2e"
    description: ClassVar[str] = (
        SubmitFindingTool.description
        + "\n\n[dev_web E2E] finding_lifecycle 기록 후 dev_web_report_thread(draft)를 생성한다. "
        "task_type은 'dev_web'으로 제출하고, browser로 실제 렌더/본문 분석한 증거만 제출한다."
    )

    async def execute(self, validated_input: DevWebSubmitFindingInput, context: ToolContext) -> ToolResult:
        # ⚠️ 예전엔 task_type != 'dev_web' 이면 **거부**했다. 워커가 필드를 빠뜨리면
        # (기본값 'generic') 제출이 죽는다 — 2026-08-17 하루에 6건이 이렇게 사라졌다.
        # 이 도구를 통과하는 finding 은 정의상 전부 dev_web 이므로 확정한다.
        # 다른 도메인을 **명시**한 경우만 거부해 워커의 혼동을 드러낸다.
        from _shared.submit_task_type import ensure_task_type

        pinned = ensure_task_type(
            validated_input.finding, "dev_web", tool_name="dev_web_submit_finding")
        if isinstance(pinned, ToolError):
            return pinned
        finding = pinned
        # 키는 마킹 래퍼가 소유한다 — 생산자/소비자가 문자열을 각자 들고 있으면
        # 한쪽만 바뀌었을 때 게이트가 조용히 항상-거부/항상-통과가 된다.
        from domains.dev_web.plugin.tools.dev_web_coverage_tools import (
            BROWSER_DEEP_DIVE_KEY,
        )

        if not context.metadata.get(BROWSER_DEEP_DIVE_KEY):
            return ToolError(
                kind="validation",
                message=(
                    "dev_web finding requires browser deep-dive evidence after web_site_sweep "
                    "(browser_query snapshot/html/screenshot or browser_action navigate/click/scroll)"
                ),
            )
        result = await super().execute(SubmitFindingTool.input_model(finding=finding), context)
        if isinstance(result, ToolError):
            return result
        if "lifecycle" not in result.content:
            return result

        asset = finding.hits[0].location if finding.hits else finding.task_id
        asset_kind = _asset_kind_from_location(asset) if finding.hits else "task"
        canon = canonical_task_type(finding.task_type, asset)
        discriminator = "|".join(sorted({h.category for h in finding.hits}))
        from secu_agent import state as core_state

        fp = core_state.finding_fingerprint(
            task_type=canon,
            asset=asset,
            asset_kind=asset_kind,
            discriminator=discriminator,
        )
        finding_id = _finding_id_by_fingerprint(fp)
        if finding_id is None:
            return ToolSuccess(content=result.content + " (dev_web_e2e: finding_id 조회 실패, 전이 skip)")
        core_state.finding_update(
            finding_id,
            extra={
                "agent_verification": make_agent_verification(
                    method="dev_web_browser_deep_dive",
                    source="dev_web_submit_finding",
                    checks=(
                        "web_site_sweep_completed",
                        "post_sweep_browser_deep_dive",
                        "finding_submitted_by_agent",
                    ),
                    details={
                        "target_id": validated_input.target_id,
                        "hit_count": len(finding.hits),
                    },
                )
            },
            merge_extra=True,
        )

        target = state.dev_web_target_get(validated_input.target_id) if validated_input.target_id else None
        url = str((target or {}).get("url") or asset or finding.target or "")
        domain = str((target or {}).get("domain") or host_of(url) or host_of(asset) or "")
        # ★ 본문은 **대상(src) 전체**를 묶는다 — 티켓의 단위가 사이트이기 때문이다.
        #   여기서 이 finding 하나만 담으면 같은 사이트의 나머지가 본문에서 사라진다
        #   (실측 2026-08-30: 한 사이트에 finding 5건인 대상이 있는데 본문엔 1건뿐이었다).
        #   smb·github·confluence 는 이미 host/repo/space 전체를 묶는다 — dev_web 만 달랐다.
        #   ⚠️ 제출마다 다시 만든다. 그래야 **마지막 제출 뒤에** 본문이 완전해진다
        #      ("src 의 finding 이 전부 들어오면" 을 별도 신호 없이 만족한다).
        report_json = _build_domain_report(
            domain, current=finding, note=validated_input.report_note,
            evidence_ref=str(context.evidence_dir / "finding.json"),
        )
        action, thread_id = state.dev_web_report_thread_upsert(
            target_id=validated_input.target_id,
            finding_id=finding_id,
            domain=domain,
            url=url or f"https://{domain}",
            subject_tag=state.normalize_dev_web_subject_tag(domain),
            severity=finding.severity,
            recipient=None,   # 아직 모른다. ↓ _default_recipient 주석 참조
            status="draft",
            report_json=report_json,
        )
        if validated_input.target_id:
            state.dev_web_target_set_status(
                validated_input.target_id,
                "in_progress",
                finding_count=1,
                report_thread_id=thread_id,
                evidence_ref=str(context.evidence_dir / "finding.json"),
            )
        return ToolSuccess(content=(
            result.content
            + f"; dev_web_e2e: finding_id={finding_id} domain={domain} "
            + f"report_thread={action}(id={thread_id})"
        ))


def _build_domain_report(
    domain: str, *, current: Any, note: str | None, evidence_ref: str,
) -> dict[str, Any]:
    """이 사이트(domain)의 finding **전부**로 본문 재료를 만든다.

    ⚠️ 이 도메인의 티켓 단위는 사이트다. 본문이 finding 1건짜리면 티켓과 본문의
       모수가 어긋난다 — 화면은 "발견 5" 인데 메일엔 1건만 적힌다.
    ⚠️ 조회가 실패해도 제출을 죽이지 않는다. 그때는 최소한 현재 finding 만이라도 담는다.
    """
    items: list[dict[str, Any]] = []
    try:
        with state.connect() as c:
            rows = c.execute(
                "SELECT id, severity, summary, asset, first_seen FROM finding_lifecycle "
                "WHERE task_type='dev_web' "
                # ⚠️ 정규식의 `?` 는 바인딩 자리표시자로 바뀐다 — `{0,1}` 로 쓴다.
                "  AND split_part(regexp_replace(asset,'^https{0,1}://',''),'/',1)=? "
                "ORDER BY first_seen DESC LIMIT 50",
                (str(domain or ""),),
            ).fetchall()
        for r in rows:
            items.append({
                "finding_id": int(r["id"]),
                "severity": str(r["severity"] or ""),
                "summary": str(r["summary"] or ""),
                "asset": str(r["asset"] or ""),
            })
    except Exception:  # noqa: BLE001 — 본문 재료 실패가 제출을 되돌리지 않는다
        items = []
    if not items:
        items = [{
            "finding_id": None,
            "severity": str(getattr(current, "severity", "") or ""),
            "summary": str(getattr(current, "summary", "") or ""),
            "asset": str(getattr(current, "target", "") or ""),
        }]
    return {
        "domain": domain,
        "finding_count": len(items),
        "findings": items,
        # 대표 서술 — 이번에 제출한 것. 목록은 위 findings 가 전부 들고 있다.
        "summary": getattr(current, "summary", None),
        "risk_narrative": getattr(current, "risk_narrative", None),
        "recommended_actions": list(getattr(current, "recommended_actions", None) or []),
        "evidence_ref": evidence_ref,
        "note": note,
    }


def _finding_id_by_fingerprint(fingerprint: str) -> int | None:
    with state.connect() as c:
        row = c.execute(
            "SELECT id FROM finding_lifecycle WHERE fingerprint=?",
            (fingerprint,),
        ).fetchone()
    return int(row["id"]) if row else None


# ⚠️ 여기 있던 `_default_recipient()` 를 걷어냈다 — **스레드를 만들 때 수신처를 못 박던 값**이다.
#
# 실측(2026-08-24): `dev_web_report_thread` 137행 전부 `dssoc@samsung.com`, NULL 0행.
# 그런데 `awaiting_reply` 는 0행이다 — 한 건도 안 보냈는데 전부 "DSSOC 로 보냄" 으로
# 기록돼 있었다. 그 결과:
#   · 게이트웨이 `deliveryTarget` 이 137건 전부 "DSSOC" 로 뜬다(한 번도 안 보낸 것까지)
#   · `dev_web/webapp/routes/targets.py` 의 `has_request_mail` 이 **항상 True** 다
#     (발송 경로가 `request_message_id` 를 None 으로 두므로 recipient 가 유일한 근거인데
#      그게 상수였다)
#
# 이제 NULL 로 태어나고, **실제 발송 후에** `dev_web_report_agent` 가 진짜 수신자를 적는다.
# 발송 수신처는 `dev_web_report_delivery_targets()` 가 정한다 — 이 컬럼이 아니다.
