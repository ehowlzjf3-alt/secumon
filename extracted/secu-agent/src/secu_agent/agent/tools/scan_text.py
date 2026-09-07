"""scan_text — 임의의 텍스트 덩어리를 secret/PII detector에 통과시킨다.

agent가 fetch한 컨텐츠를 직접 던지거나, evidence_dir에 stash된 큰 결과의 경로를
넘기는 두 가지 모드.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.candidate_ledger import record_candidates_seen
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess
from secu_agent.detectors import scan_text

MAX_INLINE_BYTES = 256 * 1024


class ScanTextInput(BaseModel):
    text: str | None = Field(None, description="스캔할 텍스트 (inline)")
    path: str | None = Field(None, description="evidence_dir 기준 상대 path. 텍스트 너무 크면 stash된 파일 경로.")
    label: str | None = Field(None, description="hit location 라벨 (file URL 등)")
    include_document_signals: bool = Field(
        False,
        description="등록된 문서-신호 스캐너 결과 포함 (path/title/body/classifier 신호)",
    )


class ScanTextTool(Tool[ScanTextInput]):
    name: ClassVar[str] = "scan_text"
    domain: ClassVar[str] = "core"
    description: ClassVar[str] = (
        "텍스트에서 credential/PII detector hit을 찾는다. 옵션으로 등록된 문서-신호 "
        "스캐너 결과도 포함할 수 있다.\n"
        "Modes: text=인라인 텍스트 (256KB 한계), path=evidence_dir 상대경로의 파일.\n"
        "결과: JSON {hits: [{category, kind, masked, line_no, preview}], total: N}."
    )
    input_model: ClassVar[type[BaseModel]] = ScanTextInput
    search_hint: ClassVar[str] = "secret pii detect scan credentials password token rrn"
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: ScanTextInput, context: ToolContext) -> ToolResult:
        text = validated_input.text
        label = validated_input.label or ""
        # v3.53: web 점검 content-inspection 증거 — scan_text 가 현재 browser 페이지의
        # host(또는 label 의 host)를 분석했다고 기록. set_status('tasked') 게이트가 쓴다.
        _record_web_content_inspected(context, label)

        if text is None and validated_input.path:
            p = (context.evidence_dir / validated_input.path).resolve()
            if not str(p).startswith(str(context.evidence_dir.resolve())):
                return ToolError(kind="path_escape", message="path outside evidence_dir")
            if not p.exists():
                return ToolError(kind="not_found", message=str(p))
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError as e:
                return ToolError(kind="io_error", message=str(e))
            label = label or validated_input.path

        if text is None:
            return ToolError(kind="validation", message="text 또는 path 중 하나 필요")
        if len(text.encode("utf-8", errors="ignore")) > MAX_INLINE_BYTES:
            return ToolError(
                kind="too_large",
                message=f"inline scan limit {MAX_INLINE_BYTES} bytes. path 모드로 호출하라.",
            )

        result = scan_text(
            text,
            label=label,
            include_document_signals=validated_input.include_document_signals,
        )
        if result.hits:
            # candidate ledger: hit = 후보 관찰. 침묵 게이트가 제출/기각과 대조한다.
            # samples 는 분류/위치만 — masked 값도 넣지 않는다.
            record_candidates_seen(
                context.metadata,
                source_tool=self.name,
                count=len(result.hits),
                samples=tuple(
                    f"{h.category}/{h.kind}@{label or 'inline'}"
                    for h in result.hits[:5]
                ),
            )
        payload = {
            "label": label,
            "total": len(result.hits),
            "bytes_scanned": result.bytes_scanned,
            "hits": [
                {
                    "category": h.category, "kind": h.kind, "masked": h.masked,
                    "line_no": h.line_no, "line_preview": h.line_preview,
                }
                for h in result.hits
            ],
        }
        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False, indent=2))


def _host_of(value: str) -> str:
    from urllib.parse import urlparse
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        return (urlparse(raw if "://" in raw else f"//{raw}").hostname or "").lower()
    except Exception:
        return ""


def _record_web_content_inspected(context, label: str) -> None:
    """scan_text 가 분석한 web host 기록 — set_status('tasked') 게이트가 사용.
    label 에 host 가 있으면 그걸, 없으면 현재 browser 페이지 host 를 쓴다(휴리스틱:
    보통 snapshot 직후 그 내용을 scan_text 함)."""
    try:
        host = _host_of(label)
        if not host:
            try:
                from secu_agent.agent.tools import browser_tool as _bt
                pg = _bt._SESSION_STATE.get("page")
                if pg is not None:
                    host = _host_of(str(getattr(pg, "url", "") or ""))
            except Exception:
                host = ""
        if not host or not hasattr(context, "metadata"):
            return
        hosts = context.metadata.setdefault("_web_content_inspected_hosts", [])
        if host not in hosts:
            hosts.append(host)
    except Exception:
        pass
