"""#2 조치요청 에이전트 도구 — HTML 리포트 빌드 + 스크린샷 (smb_domain_e2e 요구 4·5·6·7).

live SMB I/O 0 — confirmed finding 의 DB 행 + evidence_dir 자료만. 메일 자동발송은
generic `deliver`(sink='knox_mail') 도구가 egress 게이트(redaction/PII-scan/allowlist)
경유로 수행한다(이 모듈은 본문/제목/수신자를 만들어 주고, 발송은 deliver 가).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.deliver_tool import DeliverInput, DeliverTool
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)
from service.services import owner_recipients as orx


class SmbBuildRemediationReportInput(BaseModel):
    finding_id: int = Field(..., description="조치요청 대상 finding_lifecycle.id")
    intro_note: str = Field("", max_length=2000, description="선택: 담당자용 도입 문안(한국어).")
    render_screenshot: bool = Field(
        True, description="HTML 리포트를 PNG 로 렌더해 증거에 추가(Playwright, graceful-degrade).",
    )


class SmbBuildRemediationReportTool(Tool[SmbBuildRemediationReportInput]):
    name: ClassVar[str] = "smb_build_remediation_report"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = True  # DB/evidence read + 로컬 렌더만 (live SMB 0)
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "smb remediation report html mail 조치요청 finding"
    description: ClassVar[str] = (
        "confirmed finding 의 조치요청 HTML 리포트(제목 `[보안취약점 조치요청](IP) 공유폴더 접근권한 관리`, 공유폴더 "
        "권한 변경 등 조치사항 포함)를 만든다. live SMB I/O 없음(DB+evidence). 반환에 "
        "subject/html/recipient/screenshots 가 있어 deliver(sink='knox_mail')로 그대로 발송. "
        "render_screenshot=True 면 리포트를 PNG 로 렌더해 증거로 첨부(graceful-degrade)."
    )
    input_model: ClassVar[type[BaseModel]] = SmbBuildRemediationReportInput

    async def execute(self, vi: SmbBuildRemediationReportInput, ctx: ToolContext) -> ToolResult:
        from service.services import smb_remediation_report, shot_renderer
        from service import state_domain as state
        try:
            report = smb_remediation_report.build_remediation_report(
                finding_id=vi.finding_id, intro_note=vi.intro_note,
            )
        except ValueError as e:
            return ToolError(kind="not_found", message=str(e))

        rendered = None
        if vi.render_screenshot:
            rel = f"remediation_report_{vi.finding_id}.png"
            res = shot_renderer.render_html_to_png(report["html"], ctx.evidence_dir, rel)
            rendered = res
            if res.get("ok"):
                ordinal = len(report.get("screenshots") or []) + 1
                state.screenshot_add(
                    finding_id=vi.finding_id, rel_path=rel, kind="report",
                    caption="조치요청 리포트", sha256=res.get("sha256"), ordinal=ordinal,
                )

        owner_email = str(report.get("owner", {}).get("email") or "").strip()
        targets = report_mail_delivery_targets([owner_email] if owner_email else [])
        # ★ 회신 매칭 1차 키(티켓번호)를 제목 앞에 찍는다.
        #   이 도구는 finding 단위라 thread_id 를 인자로 받지 않는다 — subject_tag 로
        #   역조회한다(`mail_thread_find_by_subject_tag`, 최신 우선).
        #   ⚠️ 스레드를 못 찾으면 **찍지 않고 그대로 둔다.** 없는 번호를 지어내면
        #      담당자가 그 번호로 답장했을 때 영원히 안 붙는다.
        subject = report["subject"]
        _threads = state.mail_thread_find_by_subject_tag(str(report["subject_tag"]))
        if _threads:
            subject = state.stamp_subject_for_thread(subject, "smb", int(_threads[0]["id"]))
        # ★ 자동 최초 발송이 닫혀 있으면 수신처가 **비어 있다**("제작까지만").
        #   그때는 초안만 돌려주고 `deliver_hint` 를 주지 않는다 — 힌트가 있으면
        #   워커가 그걸 들고 deliver 를 시도한다.
        recipient = targets["recipients"][0] if targets["recipients"] else None
        return ToolSuccess(content=json.dumps({
            "kind": "smb_remediation_report",
            "finding_id": vi.finding_id,
            "host": report["host"],
            "subject": subject,
            "subject_tag": report["subject_tag"],
            "severity": report["severity"],
            "recipient": recipient,
            "cc": targets["cc"],
            "owner_recipient": owner_email or None,
            "delivery_policy": targets["mode"],
            "html": report["html"],
            "remediation_actions": report["remediation_actions"],
            "screenshots": [s.get("rel_path") for s in report.get("screenshots") or []],
            "report_render": rendered,
            **({"deliver_hint": {
                "action": "send", "sink_id": "knox_mail",
                "recipients": targets["recipients"], "cc": targets["cc"],
                "subject": subject,
                "finding_id": vi.finding_id,
            }} if targets["recipients"] else {
                "send_blocked": targets.get("reason") or "자동 최초 발송이 닫혀 있다",
                "next": "초안만 남긴다. 발송하려면 콘솔에서 수동 승인하라.",
            }),
        }, ensure_ascii=False))


# _csv 는 6곳에 같은 내용으로 복사돼 있었다 — SSOT 위임.
_csv = orx.csv


def _dssoc_recipients() -> list[str]:
    return (
        _csv(os.environ.get("SMB_REMEDIATION_DSSOC_RECIPIENT"))
        or _csv(os.environ.get("SA_DSSOC_MAIL_RECIPIENT"))
        or ["dssoc@samsung.com"]
    )


def report_mail_delivery_targets(
    owner_recipients: list[str] | None = None, *, manual: bool = False,
) -> dict[str, Any]:
    """조치요청 메일 수신처 — **담당자 + DSSOC**. DSSOC 만 보내는 건 드라이런 때뿐이다.

    규칙은 `owner_recipients.delivery_targets` 가 소유한다. 예전엔 4도메인이 같은 분기를
    각자 들고 있었고 기본값이 `dssoc_only` 였다 — 실발송이 켜져도 담당자가 빠지는 구멍이
    거기 있었다(자율발송 스위치와 수신처 스위치가 서로를 몰랐다).
    """
    return orx.delivery_targets(
        owner_recipients,
        mode_env="SMB_REMEDIATION_MAIL_MODE",
        dssoc_env_names=("SMB_REMEDIATION_DSSOC_RECIPIENT", "SA_DSSOC_MAIL_RECIPIENT"),
        manual=manual,
    )


def _copy_deliver_input(vi: DeliverInput, **updates: Any) -> DeliverInput:
    data = vi.model_dump() if hasattr(vi, "model_dump") else vi.dict()
    data.update(updates)
    return DeliverInput(**data)


class SmbReportMailDeliverTool(DeliverTool):
    """Report-mail scoped deliver wrapper that enforces recipient policy."""

    async def execute(self, vi: DeliverInput, ctx: ToolContext) -> ToolResult:
        if vi.action != "send" or vi.sink_id != "knox_mail":
            return await super().execute(vi, ctx)
        targets = report_mail_delivery_targets(list(vi.recipients))
        metadata = dict(vi.metadata or {})
        metadata["smb_report_mail_delivery_policy"] = targets["mode"]
        metadata["requested_recipients"] = list(vi.recipients)
        metadata["requested_cc"] = list(vi.cc)
        safe_vi = _copy_deliver_input(
            vi,
            recipients=targets["recipients"],
            cc=targets["cc"],
            metadata=metadata,
        )
        return await super().execute(safe_vi, ctx)


class SmbReportScreenshotInput(BaseModel):
    finding_id: int
    rel_path: str = Field(..., description="evidence_dir 상대 경로(.png/.jpg) — path-jail.")
    caption: str = Field("", max_length=200)
    kind: str = Field("evidence", max_length=40)


class SmbReportScreenshotTool(Tool[SmbReportScreenshotInput]):
    name: ClassVar[str] = "smb_report_screenshot"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "smb report screenshot evidence image attach path-jail"
    description: ClassVar[str] = (
        "evidence_dir 안의 증거 이미지(path-jail, .png/.jpg)를 finding 의 screenshot 으로 "
        "등록한다(최대 2~3장). 메일 리포트에 정적 URL/data-uri 로 임베드된다."
    )
    input_model: ClassVar[type[BaseModel]] = SmbReportScreenshotInput

    async def execute(self, vi: SmbReportScreenshotInput, ctx: ToolContext) -> ToolResult:
        from service.services import shot_renderer
        from service import state_domain as state
        import hashlib
        try:
            target = shot_renderer.resolve_in_jail(ctx.evidence_dir, vi.rel_path)
        except shot_renderer.PathJailError as e:
            return ToolError(kind="path_escape", message=str(e))
        if not target.is_file():
            return ToolError(kind="not_found", message=f"파일 없음: {vi.rel_path}")
        sha = hashlib.sha256(target.read_bytes()).hexdigest()
        existing = state.screenshots_for_finding(vi.finding_id, limit=3)
        if len(existing) >= 3:
            return ToolError(kind="validation", message="이미 3장 — 더 추가 불가")
        sid = state.screenshot_add(
            finding_id=vi.finding_id, rel_path=vi.rel_path, kind=vi.kind,
            caption=vi.caption, sha256=sha, ordinal=len(existing) + 1,
        )
        return ToolSuccess(content=json.dumps({
            "kind": "smb_report_screenshot", "screenshot_id": sid,
            "finding_id": vi.finding_id, "rel_path": vi.rel_path, "ordinal": len(existing) + 1,
        }, ensure_ascii=False))
