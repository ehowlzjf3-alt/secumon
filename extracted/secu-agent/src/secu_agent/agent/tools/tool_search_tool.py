"""ToolSearchTool — deferred 도구 schema 동적 unlock (v3.17).

Claude Code 의 ToolSearch 패턴 이식. 무거운/희귀 도구 schema 를 system prompt
에서 빼두고 (deferred=True) agent 가 필요할 때 query / select 로 unlock.

흐름:
1. system_prompt 가 "deferred 도구 목록 (이름+한줄)" 를 별도 섹션으로 노출.
2. agent 가 tool_search(query=...) 호출 → registry.search() → unlock + 결과 반환.
3. 다음 model pass 부터 build_specs() 가 unlocked 포함 → 호출 가능.

query 형식:
- 일반 키워드: "sandbox malware ELF"  → registry.search()
- select 모드: "select:run_in_sandbox,bash_evidence"  → 정확 이름 매칭
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    ToolSuccess,
)

_MAX_RESULTS_CAP = 10
_DEFAULT_MAX = 5


class ToolSearchInput(BaseModel):
    query: str = Field(
        description=(
            "키워드 ('sandbox malware') 또는 'select:NAME[,NAME...]' 직접 지정. "
            "'+term' prefix 는 필수 매칭."
        ),
    )
    max_results: int = Field(
        default=_DEFAULT_MAX,
        description=f"반환할 최대 매치 수 (1~{_MAX_RESULTS_CAP}).",
    )


def _format_match_line(name: str, description_preview: str, hint: str) -> str:
    parts = [f"- **{name}** — {description_preview}"]
    if hint:
        parts.append(f"  hint: {hint}")
    return "\n".join(parts)


class ToolSearchTool(Tool[ToolSearchInput]):
    name: ClassVar[str] = "tool_search"
    description: ClassVar[str] = (
        "deferred 도구 schema 를 unlock. query 키워드 또는 'select:NAME' 로 "
        "필요한 도구 schema 만 로드 — system prompt 토큰 절약."
    )
    input_model: ClassVar[type[BaseModel]] = ToolSearchInput
    is_destructive: ClassVar[bool] = False
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = False  # 본인은 항상 노출
    domain: ClassVar[str] = "core"
    search_hint: ClassVar[str] = "tool search unlock schema deferred discovery"
    prompt_section: ClassVar[str] = (
        "**tool_search** — deferred 도구 schema unlock. system prompt 에 이름만 "
        "보이는 도구를 부르려면 먼저 tool_search(query='...') 또는 "
        "tool_search(query='select:tool_name') 로 schema 를 로드. 로드된 도구는 "
        "다음 model pass 부터 호출 가능하므로, 이미 loaded 로 나온 도구를 다시 "
        "tool_search 하지 말고 직접 호출."
    )

    async def execute(self, payload: ToolSearchInput, context: ToolContext) -> ToolResult:
        raw = (payload.query or "").strip()
        if not raw:
            return ToolError(kind="validation", message="query 비어있음.")

        if context.registry is None:
            return ToolError(
                kind="execution",
                message="registry 미주입 — engine 외부에서 호출됨.",
            )

        cap = max(1, min(int(payload.max_results), _MAX_RESULTS_CAP))

        if raw.lower().startswith("select:"):
            return self._select_mode(raw[len("select:"):], context, cap)
        return self._keyword_mode(raw, context, cap)

    def _select_mode(
        self, names_csv: str, context: ToolContext, cap: int,
    ) -> ToolResult:
        names = [n.strip() for n in names_csv.split(",") if n.strip()]
        if not names:
            return ToolError(kind="validation", message="select: 뒤 도구 이름 없음.")

        loaded: list[str] = []
        missing: list[str] = []
        for n in names[:cap]:
            cls = context.registry.get(n) if context.registry else None
            if cls is None:
                missing.append(n)
                continue
            context.unlocked_tools.add(n)
            loaded.append(n)

        lines: list[str] = []
        if loaded:
            lines.append("loaded:")
            for n in loaded:
                cls = context.registry.get(n)
                desc = (cls.description if cls else "").splitlines()[0] if cls else ""
                lines.append(_format_match_line(n, desc, cls.search_hint if cls else ""))
        if missing:
            lines.append("")
            lines.append("missing (unknown tool name):")
            for n in missing:
                lines.append(f"- {n}")
        if not lines:
            lines.append("no tools selected.")
        return ToolSuccess(content="\n".join(lines))

    def _keyword_mode(
        self, query: str, context: ToolContext, cap: int,
    ) -> ToolResult:
        if context.registry is None:  # narrowing 위해 재확인
            return ToolError(kind="execution", message="registry 미주입.")
        matches = context.registry.search(query, limit=cap)
        if not matches:
            return ToolSuccess(content=f"no match for query: {query!r}")

        loaded: list[str] = []
        for m in matches:
            context.unlocked_tools.add(m.name)
            loaded.append(m.name)

        lines = [f"loaded {len(loaded)} tools for query {query!r}:"]
        for m in matches:
            lines.append(_format_match_line(m.name, m.description_preview, m.search_hint))
        return ToolSuccess(content="\n".join(lines))
