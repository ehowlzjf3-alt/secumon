"""SMB agent_type agent tools."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import uuid
from dataclasses import asdict
from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools._untrusted import wrap_untrusted
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess
from secu_agent.agent.tools.image_tools import (
    _DEFAULT_VISION_PROMPT,
    _DEFAULT_VISION_INLINE_CAP,
    _FMT_TO_MIME,
    _detect_image,
    _vision_analyze,
)
from domains.smb.plugin.agent_types import smb


class SmbInspectImageInput(BaseModel):
    host: str
    share: str
    path: str = Field(..., description="share-root 기준 이미지 path (예: banners/대강당.jpg)")
    max_bytes: int = Field(default=2 * 1024 * 1024, ge=1024, le=10 * 1024 * 1024)
    analyze: bool = Field(
        default=True,
        description="True면 vision-capable LLM으로 이미지 본문/텍스트를 보안 관점에서 분석.",
    )
    prompt: str | None = Field(
        default=None,
        description="analyze=True일 때 기본 보안 분석 프롬프트 대신 사용할 프롬프트.",
    )


def _artifact_name(host: str, share: str, path: str, fmt: str) -> str:
    base = f"{host}_{share}_{path}".replace("\\", "/")
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._-")
    if len(safe) > 120:
        safe = safe[:120]
    return f"{safe or 'smb_image'}_{uuid.uuid4().hex[:8]}.{fmt if fmt != 'jpeg' else 'jpg'}"


def _find_file_id(host: str, share: str, path: str) -> int | None:
    from service import state_domain as state
    with state.connect() as c:
        row = c.execute(
            "SELECT f.id FROM smb_file f JOIN smb_share s ON s.id=f.share_id "
            "WHERE s.host=? AND s.share=? AND f.path=? "
            "ORDER BY f.id DESC LIMIT 1",
            (host, share, path),
        ).fetchone()
    return int(row["id"]) if row is not None else None


def _record_image_status(
    host: str,
    share: str,
    path: str,
    *,
    fetch_status: str,
    file_read: bool,
    note: str | None = None,
) -> None:
    from service import state_domain as state
    file_id = _find_file_id(host, share, path)
    if file_id is None:
        return
    state.file_record_fetch(file_id, fetch_status=fetch_status, file_read=file_read)
    if note:
        state.file_set_note(file_id, note=note[:1500], tags=["이미지", "vision"])


class SmbInspectImageTool(Tool[SmbInspectImageInput]):
    name: ClassVar[str] = "smb_inspect_image"
    domain: ClassVar[str] = "smb"
    description: ClassVar[str] = (
        "SMB 원격 이미지(JPG/PNG/GIF/WebP)를 읽어 evidence artifact로 저장하고, "
        "analyze=True면 vision LLM으로 이미지 안 텍스트/화면/민감정보를 분석한다. "
        "READ-only SMB 접근이며 POST/수정 없음."
    )
    input_model: ClassVar[type[BaseModel]] = SmbInspectImageInput
    search_hint: ClassVar[str] = "smb image jpg png jpeg vision inspect ocr banner screenshot"
    is_read_only: ClassVar[bool] = False
    is_destructive: ClassVar[bool] = False
    deferred: ClassVar[bool] = False
    prompt_section: ClassVar[str] = (
        "### smb_inspect_image(host, share, path, analyze=True, max_bytes=2097152)\n"
        "SMB 원격 JPG/PNG/GIF/WebP를 실제로 읽어 evidence artifact 저장 + vision 분석. "
        "smb_host_sweep의 image_candidates 또는 `.jpg/.png/.webp/.gif` 파일을 본문 확인할 때 사용. "
        "이미지를 보지 않고 문제없음/스킵으로 결론 내리지 말 것."
    )

    def _get_vision_client(self):
        from secu_agent.agent.llm.factory import build_chat_client_from_profile
        profile = os.environ.get("SA_VISION_PROFILE", "gaussO4")
        return build_chat_client_from_profile(profile)

    async def execute(self, vi: SmbInspectImageInput, context: ToolContext) -> ToolResult:
        fetched = await asyncio.to_thread(
            smb.fetch_file_bytes,
            vi.host, vi.share, vi.path,
            max_bytes=vi.max_bytes,
        )
        source = f"smb://{vi.host}/{vi.share}/{vi.path}"
        if fetched.status == "too_large":
            _record_image_status(
                vi.host, vi.share, vi.path,
                fetch_status="image_too_large", file_read=False,
            )
            return ToolError(kind="too_large", message=f"{source}: {fetched.message}")
        if fetched.status in {"denied", "not_found", "error"}:
            _record_image_status(
                vi.host, vi.share, vi.path,
                fetch_status=f"image_{fetched.status}", file_read=False,
            )
            kind = "permission" if fetched.status == "denied" else fetched.status
            return ToolError(kind=kind, message=f"{source}: {fetched.message}")
        if fetched.status == "empty":
            _record_image_status(
                vi.host, vi.share, vi.path,
                fetch_status="image_empty", file_read=True,
            )
            return ToolError(kind="binary", message=f"{source}: empty image file")

        detected = _detect_image(fetched.data)
        if detected is None:
            _record_image_status(
                vi.host, vi.share, vi.path,
                fetch_status="image_invalid", file_read=True,
            )
            return ToolError(kind="binary", message=f"{source}: supported image header not detected")
        fmt, width, height = detected

        out_dir = context.evidence_dir / "smb_images"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / _artifact_name(vi.host, vi.share, vi.path, fmt)
        out_path.write_bytes(fetched.data)
        digest = hashlib.sha256(fetched.data).hexdigest()
        payload: dict[str, object] = {
            "source": source,
            "artifact_path": str(out_path),
            "format": fmt,
            "width": width,
            "height": height,
            "bytes_read": len(fetched.data),
            "remote_size": fetched.size,
            "truncated": fetched.truncated,
            "sha256": digest,
            "analyzed": False,
        }

        if fetched.truncated:
            payload["analysis_status"] = "skipped_truncated"
            _record_image_status(
                vi.host, vi.share, vi.path,
                fetch_status="image_truncated", file_read=True,
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))

        if not vi.analyze:
            _record_image_status(
                vi.host, vi.share, vi.path,
                fetch_status="image_read", file_read=True,
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))

        prompt = vi.prompt or (
            _DEFAULT_VISION_PROMPT
            + "\n\nSMB 원본 경로: "
            + source
            + "\n이미지 안의 한글/영문 텍스트도 OCR처럼 읽고, "
            + "자격증명·PII·내부 URL/IP·공정자료·경영자료 단서가 있으면 유형만 마스킹해 보고."
        )
        try:
            client = self._get_vision_client()
        except Exception as e:  # noqa: BLE001
            payload["analysis_status"] = "unavailable"
            payload["analysis_error"] = f"{type(e).__name__}: {e}"
            _record_image_status(
                vi.host, vi.share, vi.path,
                fetch_status="image_read", file_read=True,
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))

        try:
            analysis = await _vision_analyze(
                client,
                prompt,
                fetched.data,
                _FMT_TO_MIME.get(fmt, "image/png"),
            )
        except Exception as e:  # noqa: BLE001
            payload["analysis_status"] = "error"
            payload["analysis_error"] = f"{type(e).__name__}: {e}"
            _record_image_status(
                vi.host, vi.share, vi.path,
                fetch_status="image_read", file_read=True,
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))

        payload["analyzed"] = True
        payload["analysis_status"] = "ok"
        payload["analysis"] = analysis
        _record_image_status(
            vi.host, vi.share, vi.path,
            fetch_status="image_analyzed", file_read=True,
            note=analysis,
        )
        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))


class SmbInspectPdfInput(BaseModel):
    host: str
    share: str
    path: str = Field(..., description="share-root 기준 PDF path")
    max_bytes: int = Field(default=4 * 1024 * 1024, ge=1024, le=20 * 1024 * 1024)
    max_pages: int = Field(default=3, ge=1, le=10, description="이미지 PDF vision 분석 page 상한")
    analyze: bool = Field(
        default=True,
        description="텍스트 추출이 안 되는 이미지 PDF면 PyMuPDF 렌더링 후 vision 분석.",
    )
    prompt: str | None = Field(
        default=None,
        description="이미지 PDF vision 분석 프롬프트.",
    )


def _record_pdf_status(
    host: str,
    share: str,
    path: str,
    *,
    fetch_status: str,
    file_read: bool,
    note: str | None = None,
    tags: list[str] | None = None,
) -> None:
    from service import state_domain as state
    file_id = _find_file_id(host, share, path)
    if file_id is None:
        return
    state.file_record_fetch(file_id, fetch_status=fetch_status, file_read=file_read)
    if note:
        state.file_set_note(file_id, note=note[:1500], tags=tags or ["PDF"])


class SmbInspectPdfTool(Tool[SmbInspectPdfInput]):
    name: ClassVar[str] = "smb_inspect_pdf"
    domain: ClassVar[str] = "smb"
    description: ClassVar[str] = (
        "SMB 원격 PDF를 읽어 텍스트를 추출하고 scan_text로 분류한다. 텍스트가 없는 "
        "이미지 PDF는 PyMuPDF가 있으면 페이지를 PNG로 렌더링해 vision 분석한다. READ-only."
    )
    input_model: ClassVar[type[BaseModel]] = SmbInspectPdfInput
    search_hint: ClassVar[str] = "smb pdf inspect pypdf pymupdf image pdf vision ocr"
    is_read_only: ClassVar[bool] = False
    is_destructive: ClassVar[bool] = False
    deferred: ClassVar[bool] = False
    prompt_section: ClassVar[str] = (
        "### smb_inspect_pdf(host, share, path, analyze=True, max_pages=3)\n"
        "SMB 원격 PDF를 실제로 읽는다. 텍스트 PDF는 텍스트 추출 + scan_text, "
        "이미지 PDF는 PyMuPDF 렌더링 후 vision 분석. smb_host_sweep의 pdf_candidates를 "
        "보고 호출. PDF를 보지 않고 문제없음/스킵으로 결론 내리지 말 것."
    )

    def _get_vision_client(self):
        from secu_agent.agent.llm.factory import build_chat_client_from_profile
        profile = os.environ.get("SA_VISION_PROFILE", "gaussO4")
        return build_chat_client_from_profile(profile)

    async def execute(self, vi: SmbInspectPdfInput, context: ToolContext) -> ToolResult:
        from service.probes.hit_legibility import enrich_and_relegible
        from secu_agent.detectors import scan_text

        fetched = await asyncio.to_thread(
            smb.fetch_file_bytes,
            vi.host, vi.share, vi.path,
            max_bytes=vi.max_bytes,
        )
        source = f"smb://{vi.host}/{vi.share}/{vi.path}"
        if fetched.status == "too_large":
            _record_pdf_status(
                vi.host, vi.share, vi.path,
                fetch_status="pdf_too_large", file_read=False,
            )
            return ToolError(kind="too_large", message=f"{source}: {fetched.message}")
        if fetched.status in {"denied", "not_found", "error"}:
            _record_pdf_status(
                vi.host, vi.share, vi.path,
                fetch_status=f"pdf_{fetched.status}", file_read=False,
            )
            kind = "permission" if fetched.status == "denied" else fetched.status
            return ToolError(kind=kind, message=f"{source}: {fetched.message}")
        if fetched.status == "empty":
            _record_pdf_status(
                vi.host, vi.share, vi.path,
                fetch_status="pdf_empty", file_read=True,
            )
            return ToolError(kind="binary", message=f"{source}: empty PDF file")
        if not smb.is_pdf_candidate(vi.path) or not fetched.data[:1024].lstrip().startswith(b"%PDF-"):
            _record_pdf_status(
                vi.host, vi.share, vi.path,
                fetch_status="pdf_invalid", file_read=True,
            )
            return ToolError(kind="binary", message=f"{source}: PDF header not detected")

        out_dir = context.evidence_dir / "smb_pdfs"
        page_dir = out_dir / "pages"
        out_dir.mkdir(parents=True, exist_ok=True)
        page_dir.mkdir(parents=True, exist_ok=True)
        pdf_path = out_dir / _artifact_name(vi.host, vi.share, vi.path, "pdf")
        pdf_path.write_bytes(fetched.data)
        payload: dict[str, object] = {
            "source": source,
            "artifact_path": str(pdf_path),
            "bytes_read": len(fetched.data),
            "remote_size": fetched.size,
            "truncated": fetched.truncated,
            "text_extracted": False,
            "scan_hits": [],
            "page_images": [],
            "analyzed": False,
        }

        text = smb._extract_document_text(vi.path, fetched.data)
        if text:
            sr = scan_text(text, label=source, include_document_signals=True)
            payload["text_extracted"] = True
            payload["text_chars"] = len(text)
            payload["text_preview"] = text[:4000]
            payload["scan_hits"] = [
                {
                    "category": h.category,
                    "kind": h.kind,
                    "masked": h.masked,
                    "line_no": h.line_no,
                }
                for h in sr.hits
            ]
            _record_pdf_status(
                vi.host, vi.share, vi.path,
                fetch_status="pdf_text",
                file_read=True,
                note=f"PDF text extracted; hits={len(sr.hits)}",
                tags=["PDF", "text"],
            )
            file_id = _find_file_id(vi.host, vi.share, vi.path)
            if file_id is not None:
                from service import state_domain as state
                state.file_record_scan(file_id, hits_count=len(sr.hits))
                if sr.hits:
                    state.add_file_hits(
                        file_id,
                        enrich_and_relegible(text, list(sr.hits)),
                    )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))

        if fetched.truncated:
            payload["analysis_status"] = "skipped_truncated"
            _record_pdf_status(
                vi.host, vi.share, vi.path,
                fetch_status="pdf_truncated", file_read=True,
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))

        if not vi.analyze:
            payload["analysis_status"] = "skipped_analyze_false"
            _record_pdf_status(
                vi.host, vi.share, vi.path,
                fetch_status="pdf_image_pending_vision", file_read=True,
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))

        page_images = smb.render_pdf_pages_as_images(fetched.data, max_pages=vi.max_pages)
        if not page_images:
            payload["analysis_status"] = "render_unavailable"
            payload["analysis_error"] = "PyMuPDF unavailable or PDF pages could not be rendered"
            _record_pdf_status(
                vi.host, vi.share, vi.path,
                fetch_status="pdf_render_unavailable", file_read=True,
                note="PDF text not extracted and page rendering unavailable",
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))

        prompt = vi.prompt or (
            _DEFAULT_VISION_PROMPT
            + "\n\nSMB 원본 PDF 경로: "
            + source
            + "\n이 PDF 페이지는 이미지 PDF일 수 있다. 화면의 텍스트를 OCR처럼 읽고 "
            + "자격증명·PII·내부 URL/IP·공정자료·경영자료 단서가 있으면 유형만 마스킹해 보고."
        )
        try:
            client = self._get_vision_client()
        except Exception as e:  # noqa: BLE001
            payload["analysis_status"] = "unavailable"
            payload["analysis_error"] = f"{type(e).__name__}: {e}"
            _record_pdf_status(
                vi.host, vi.share, vi.path,
                fetch_status="pdf_rendered", file_read=True,
            )
            return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))

        analyses: list[dict[str, object]] = []
        for idx, data in enumerate(page_images, start=1):
            detected = _detect_image(data)
            if detected is None:
                continue
            fmt, width, height = detected
            page_path = page_dir / _artifact_name(vi.host, vi.share, f"{vi.path}_page{idx}", fmt)
            page_path.write_bytes(data)
            page_payload: dict[str, object] = {
                "page": idx,
                "artifact_path": str(page_path),
                "format": fmt,
                "width": width,
                "height": height,
                "bytes": len(data),
            }
            if len(data) > _DEFAULT_VISION_INLINE_CAP:
                page_payload["analysis_status"] = "skipped_too_large"
                analyses.append(page_payload)
                continue
            try:
                page_payload["analysis"] = await _vision_analyze(
                    client, prompt, data, _FMT_TO_MIME.get(fmt, "image/png"),
                )
                page_payload["analysis_status"] = "ok"
            except Exception as e:  # noqa: BLE001
                page_payload["analysis_status"] = "error"
                page_payload["analysis_error"] = f"{type(e).__name__}: {e}"
            analyses.append(page_payload)

        payload["page_images"] = analyses
        payload["analyzed"] = any(p.get("analysis_status") == "ok" for p in analyses)
        payload["analysis_status"] = "ok" if payload["analyzed"] else "no_page_analysis"
        _record_pdf_status(
            vi.host, vi.share, vi.path,
            fetch_status="pdf_analyzed" if payload["analyzed"] else "pdf_rendered",
            file_read=True,
            note=json.dumps({"page_images": analyses}, ensure_ascii=False)[:1500],
            tags=["PDF", "vision"],
        )
        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))
