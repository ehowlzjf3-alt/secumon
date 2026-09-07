"""Confluence agent tools."""
from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools._untrusted import wrap_untrusted
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess
from domains.services.confluence.plugin.agent_types import confluence as cf


class ConfluenceListPagesInput(BaseModel):
    space_key: str
    limit: int = Field(default=200, ge=1, le=1000)


class ConfluenceListPagesTool(Tool[ConfluenceListPagesInput]):
    name: ClassVar[str] = "confluence_list_pages"
    domain: ClassVar[str] = "confluence"
    description: ClassVar[str] = "space의 page 메타 enumerate (title 기반 흥미로운 거 우선 추천)."
    input_model: ClassVar[type[BaseModel]] = ConfluenceListPagesInput
    search_hint: ClassVar[str] = "confluence pages list space"
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: ConfluenceListPagesInput, context: ToolContext) -> ToolResult:
        try:
            pages = await asyncio.to_thread(
                cf.list_pages, validated_input.space_key, limit=validated_input.limit,
            )
        except Exception as e:
            return ToolError(kind="execution", message=repr(e))
        return ToolSuccess(content=json.dumps([asdict(p) for p in pages]))


class ConfluenceFetchPageInput(BaseModel):
    page_id: str


class ConfluenceFetchPageTool(Tool[ConfluenceFetchPageInput]):
    name: ClassVar[str] = "confluence_fetch_page"
    domain: ClassVar[str] = "confluence"
    description: ClassVar[str] = "page body (storage format HTML-ish) fetch."
    input_model: ClassVar[type[BaseModel]] = ConfluenceFetchPageInput
    search_hint: ClassVar[str] = "confluence page body fetch"
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: ConfluenceFetchPageInput, context: ToolContext) -> ToolResult:
        try:
            body = await asyncio.to_thread(cf.fetch_page_body, validated_input.page_id)
        except Exception as e:
            return ToolError(kind="execution", message=repr(e))
        if body is None:
            return ToolError(kind="not_found", message="page not accessible")
        return ToolSuccess(content=wrap_untrusted(
            f"confluence://page/{validated_input.page_id}", body,
        ))


class ConfluenceListAttachmentsInput(BaseModel):
    page_id: str


class ConfluenceListAttachmentsTool(Tool[ConfluenceListAttachmentsInput]):
    name: ClassVar[str] = "confluence_list_attachments"
    domain: ClassVar[str] = "confluence"
    description: ClassVar[str] = "page의 첨부 파일 목록 (filename + media_type + download_url)."
    input_model: ClassVar[type[BaseModel]] = ConfluenceListAttachmentsInput
    search_hint: ClassVar[str] = "confluence attachments list"
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: ConfluenceListAttachmentsInput, context: ToolContext) -> ToolResult:
        try:
            atts = await asyncio.to_thread(cf.list_attachments, validated_input.page_id)
        except Exception as e:
            return ToolError(kind="execution", message=repr(e))
        return ToolSuccess(content=json.dumps([asdict(a) for a in atts]))


class ConfluenceFetchAttachmentInput(BaseModel):
    download_path: str = Field(..., description="ConfluenceAttachment.download_url (상대경로)")
    label: str | None = None


class ConfluenceFetchAttachmentTool(Tool[ConfluenceFetchAttachmentInput]):
    name: ClassVar[str] = "confluence_fetch_attachment"
    domain: ClassVar[str] = "confluence"
    description: ClassVar[str] = "첨부 파일 텍스트 컨텐츠 (binary면 not_file 에러)."
    input_model: ClassVar[type[BaseModel]] = ConfluenceFetchAttachmentInput
    search_hint: ClassVar[str] = "confluence attachment download fetch"
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: ConfluenceFetchAttachmentInput, context: ToolContext) -> ToolResult:
        try:
            text = await asyncio.to_thread(cf.fetch_attachment_text, validated_input.download_path)
        except Exception as e:
            return ToolError(kind="execution", message=repr(e))
        if text is None:
            return ToolError(kind="not_file", message="binary or not accessible")
        return ToolSuccess(content=wrap_untrusted(
            validated_input.label or f"confluence://{validated_input.download_path}", text,
        ))
