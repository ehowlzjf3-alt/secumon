"""v3.81 T2: DeliverTool — finding/보고를 등록된 delivery sink 로 전달.

코어 egress 정책 (agent/delivery.py):
- 기본 dry-run: draft 파일 생성 + audit 만, 외부 발송 없음.
- 자율발송은 opt-in 4조건 (sink env opt-in / charter / 수신자 allowlist /
  마스킹 후 스캔 hit 0) 전부 충족 시에만.
sink 어댑터는 등록형 (plugin/skill 소유, Knox Mail 만 코어 기본).
"""
from __future__ import annotations

from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field

from secu_agent.agent.delivery import (
    AUTOSEND_SINKS_ENV, DeliveryError, DeliveryPayload, deliver,
    ensure_core_sinks, list_delivery_sinks,
)
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


class DeliverInput(BaseModel):
    action: Literal["list", "send"] = Field(
        "send", description="list: 등록 sink 확인, send: 전달 (기본 dry-run)",
    )
    sink_id: str | None = Field(
        None, max_length=64, description="action='send' 시 대상 sink",
    )
    recipients: list[str] = Field(
        default_factory=list, description="TO 수신자 (send 필수)",
    )
    cc: list[str] = Field(default_factory=list)
    subject: str = Field("", max_length=500)
    body: str = Field("", max_length=100_000)
    finding_id: int | None = Field(
        None, description="관련 finding id (audit 추적용)",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict, description="sink 어댑터 전용 옵션",
    )


class DeliverTool(Tool[DeliverInput]):
    name: ClassVar[str] = "deliver"
    description: ClassVar[str] = (
        "finding/보고를 delivery sink(메일 등)로 전달.\n"
        "- action='list': 등록된 sink + 자율발송 opt-in 상태 확인\n"
        "- action='send': sink_id/recipients/subject/body 로 전달\n"
        "기본은 dry-run (draft 생성·audit 만, 실발송 없음). 자율발송은 "
        "운영자 opt-in 4조건(sink/charter/수신자 allowlist/스캔 무잔존) "
        "전부 충족 시에만. 본문은 발송 전 강제 마스킹 — 평문 secret/PII "
        "금지 (유형·분류만 기술)."
    )
    input_model: ClassVar[type[BaseModel]] = DeliverInput
    is_read_only: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "메일 발송", "deliver", "결과 전달", "담당자 통보",
    )
    prompt_section: ClassVar[str] = (
        "### deliver(action, sink_id, recipients, subject, body)\n"
        "결과 전달 — `deliver(action='list')` 로 sink 확인 후 send. "
        "기본 dry-run: draft 만 만들어진다 (실발송은 운영자 opt-in 환경에서만). "
        "본문에 평문 secret/PII 금지 — 자동 마스킹되며 잔존 시 발송 차단된다."
    )

    async def execute(self, vi: DeliverInput, ctx: ToolContext) -> ToolResult:
        ensure_core_sinks()
        if vi.action == "list":
            import os
            opted = (os.environ.get(AUTOSEND_SINKS_ENV) or "").strip()
            sinks = list_delivery_sinks()
            if not sinks:
                return ToolSuccess(content="등록된 delivery sink 없음")
            lines = [f"delivery sinks (총 {len(sinks)}; 자율발송 opt-in: "
                     f"{opted or '(없음 — 전부 dry-run)'}):"]
            lines += [f"  - {s.sink_id}: {s.description}" for s in sinks]
            return ToolSuccess(content="\n".join(lines))

        if not vi.sink_id:
            return ToolError(
                kind="validation",
                message="action='send' 는 sink_id 필수 — deliver(action='list') 로 확인.",
            )
        charter_ref = str(ctx.metadata.get("charter_ref") or "").strip()
        payload = DeliveryPayload(
            subject=vi.subject,
            body=vi.body,
            recipients=tuple(vi.recipients),
            cc=tuple(vi.cc),
            finding_id=vi.finding_id,
            metadata=vi.metadata or None,
        )
        try:
            result = await deliver(
                vi.sink_id, payload,
                evidence_dir=ctx.evidence_dir, charter_ref=charter_ref,
            )
        except DeliveryError as e:
            return ToolError(kind="validation", message=str(e))

        if result.mode == "sent":
            return ToolSuccess(content=f"[deliver:{result.sink_id}] 발송 완료 — {result.detail}")
        return ToolSuccess(content=(
            f"[deliver:{result.sink_id}] dry-run — {result.detail}"
        ))
