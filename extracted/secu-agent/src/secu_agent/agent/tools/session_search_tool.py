"""session_search — cross-session 패턴 검색 (코어, trigram 부분일치).

과거 세션 기록과 memory rule 을 통합 검색한다. operator / finding_narrator 등
코어 모드에서 사용. scope 컨텍스트(master_share_id)가 있으면 scope-scoped,
없으면 unrestricted 검색으로 동작한다.

de-domain v3.84 #4: kind 는 개방형 문자열 — 코어가 도메인 index kind 를 열거하지
않는다. 도메인 kind(file_review/share_review 등)는 도메인 어댑터가 색인·질의한다.
"""
from __future__ import annotations

import asyncio
from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent import state
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


def _scoped_share_id(context: ToolContext) -> int | ToolError:
    sid = context.metadata.get("master_share_id")
    if sid is None:
        return ToolError(kind="execution",
                         message="master_share_id not set in context")
    return int(sid)  # type: ignore[arg-type]


class SessionSearchInput(BaseModel):
    query: str = Field(
        ..., min_length=2, max_length=200,
        description="검색어 (한글 OK, trigram 매칭). "
                    "전체 query 가 한 phrase 로 묶여 본문에 해당 순서로 나오면 매칭.",
    )
    kind: str | None = Field(
        None, max_length=40,
        description="index kind 필터 (등록된 kind, 예: memory_rule). 미지정=전체.",
    )
    include_self: bool = Field(
        False,
        description="기본 False — 자기 scope 의 결과 제외 (cross-scope 패턴 인지 목적). "
                    "True 면 자기 scope 도 포함.",
    )
    limit: int = Field(15, ge=1, le=50)


class SessionSearchTool(Tool[SessionSearchInput]):
    name: ClassVar[str] = "session_search"
    description: ClassVar[str] = (
        "과거 세션 기록과 memory rule 을 통합 검색 — cross-session 패턴 인지용.\n"
        "예: 키워드/이름으로 검색 → 과거 다른 세션에서 같은 항목/패턴 본 적 있는지 확인.\n"
        "기본은 자기 scope 제외 (include_self=False) — '다른 곳에서 본 적 있나' 만 확인."
    )
    input_model: ClassVar[type[BaseModel]] = SessionSearchInput
    search_hint: ClassVar[str] = "session search cross pattern history"
    is_read_only: ClassVar[bool] = True
    domain: ClassVar[str] = "core"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "찾아봐", "이름으로",
    )
    prompt_section: ClassVar[str] = (
        "### session_search(query, kind=None, include_self=False, limit=15)\n"
        "과거 세션 기록/룰 통합 검색. cross-session 패턴.\n"
        "- 예: 사람/시스템 이름 → 다른 세션에도 같은 항목 있었나\n"
        "- 예: 특정 키워드/토큰 → 과거 같은 항목이 기록된 적 있나"
    )

    async def execute(self, validated_input: SessionSearchInput,
                      context: ToolContext) -> ToolResult:
        # master_share_id 있으면 share-scoped 모드, 없으면 (operator) unrestricted
        sid_or_err = _scoped_share_id(context)
        sid = None if isinstance(sid_or_err, ToolError) else sid_or_err

        # operator 모드는 항상 전체 검색. scoped 모드면 기본 self exclude.
        exclude = None
        if sid is not None and not validated_input.include_self:
            exclude = sid

        def _q():
            return state.session_search(
                validated_input.query,
                kind=validated_input.kind,
                exclude_share_id=exclude,
                limit=validated_input.limit,
            )
        rows = await asyncio.to_thread(_q)

        if not rows:
            return ToolSuccess(
                content=f"no results for '{validated_input.query}' "
                        f"(검색 결과 없음)",
            )

        lines = [f"found {len(rows)} match(es) for '{validated_input.query}':"]
        for r in rows:
            # 도메인-중립 렌더: 위치는 kind 별 등록 렌더러가 채운다(register_index_renderer).
            # 코어 memory_rule 등 미등록 kind = 위치 없음. 코어는 host/share_name 같은
            # 도메인 색인 컬럼의 의미를 모른다.
            rendered = state.render_index_location(r)
            loc = f" {rendered}" if rendered else ""
            path = f" path={r['path']}" if r.get("path") else ""
            content = (r.get("content") or "")[:200]
            lines.append(
                f"  - [{r['kind']} ref_id={r['ref_id']}]{loc}{path}\n"
                f"    {content}"
            )
        return ToolSuccess(content="\n".join(lines))
