"""Tool registry + search.

Stateless about unlocked deferred tools — caller 가 set 전달.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from secu_agent.agent.llm.types import ToolSpec
from secu_agent.agent.tools.base import Tool, is_execute_guarded


@dataclass(frozen=True, slots=True)
class SearchMatch:
    name: str
    description_preview: str
    search_hint: str
    score: float


_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")


def _validate_tool_class(tool_cls: type[Tool[Any]]) -> None:
    # v3.89: 검문소 정합 — 반드시 Tool 서브클래스(duck class 거부) + 실행될 execute 가 core
    # 검문소 래퍼여야 등록 허용(비-Tool mixin 상속 execute 등 미보호분 fail-closed, codex).
    if not (isinstance(tool_cls, type) and issubclass(tool_cls, Tool)):
        raise ValueError(f"Tool class {tool_cls!r} must subclass Tool")
    name = tool_cls.name
    if not name:
        raise ValueError(f"Tool class {tool_cls.__name__} has no name")
    if not _NAME_RE.match(name):
        raise ValueError(f"Tool name {name!r} must match [a-z][a-z0-9_]*")
    if not (tool_cls.description or "").strip():
        raise ValueError(f"Tool {name!r} has empty description")
    if not is_execute_guarded(getattr(tool_cls, "execute", None)):
        raise ValueError(
            f"Tool {name!r}: execute is not the core checkpoint wrapper "
            "(비-Tool mixin 상속/미래핑 execute — 우회 위험, 등록 거부)")
    # MRO 전체에 raw(비-guarded) execute 가 없어야 — guarded leaf 아래 raw mixin(추상 body 포함)이
    # 있으면 super() 가 그리로 진입해 permit 없이 실행된다(codex Q7d/v4). 예외는 **root Tool.execute
    # 하나만**(inert 추상 stub, identity). Tool subclass 의 추상 execute 는 이미 wrapper+flag 라 guarded.
    _root_execute = Tool.__dict__.get("execute")
    for klass in tool_cls.__mro__:
        exe = klass.__dict__.get("execute")
        # 예외는 정확히 root Tool 슬롯 하나(inert stub): klass is Tool AND 그 함수 객체. 다른 mixin 이
        # 같은 Tool.execute 를 alias 해도(klass is not Tool) 예외 안 됨(codex v5 정밀화).
        is_root = klass is Tool and exe is _root_execute
        if exe is not None and not is_root and not is_execute_guarded(exe):
            raise ValueError(
                f"Tool {name!r}: unguarded execute in {klass.__name__} "
                "(raw mixin/추상 body — super() 우회 위험, 등록 거부)")


def _terms(query: str) -> tuple[list[str], list[str]]:
    required: list[str] = []
    optional: list[str] = []
    for raw in query.split():
        if raw.startswith("+") and len(raw) > 1:
            required.append(raw[1:].lower())
        else:
            optional.append(raw.lower())
    return required, optional


def _word_boundary_hit(haystack: str, needle: str) -> bool:
    if not needle:
        return False
    return re.search(rf"\b{re.escape(needle)}\b", haystack, re.IGNORECASE) is not None


def _score_tool(tool: type[Tool[Any]], required: list[str], optional: list[str]) -> float:
    name = tool.name.lower()
    hint = tool.search_hint.lower()
    desc = tool.description.lower()
    haystack = f"{name} {hint} {desc}"
    for term in required:
        if term not in haystack:
            return 0.0
    score = 0.0
    for term in optional or required:
        if _word_boundary_hit(name, term):
            score += 5.0
        if _word_boundary_hit(hint, term):
            score += 4.0
        if _word_boundary_hit(desc, term):
            score += 2.0
        elif term in desc:
            score += 0.5
    return score


def _first_line(text: str, limit: int = 160) -> str:
    first = text.strip().splitlines()[0] if text.strip() else ""
    return first if len(first) <= limit else first[: limit - 1] + "…"


class ToolRegistry:
    def __init__(self) -> None:
        self._by_name: dict[str, type[Tool[Any]]] = {}

    def register(self, tool_cls: type[Tool[Any]]) -> None:
        if tool_cls.name in self._by_name:
            raise ValueError(f"Tool already registered: {tool_cls.name}")
        _validate_tool_class(tool_cls)
        self._by_name[tool_cls.name] = tool_cls

    def get(self, name: str) -> type[Tool[Any]] | None:
        return self._by_name.get(name)

    def get_instance(self, name: str) -> Tool[Any] | None:
        cls = self.get(name)
        return cls() if cls else None

    def all(self) -> list[type[Tool[Any]]]:
        return sorted(self._by_name.values(), key=lambda t: t.name)

    def active(self, unlocked: set[str] | None = None) -> list[type[Tool[Any]]]:
        """v3.80 Slice0e: prefix-cache 안정 순서 — [비-deferred 정렬] + [unlocked deferred 정렬].

        기존(전체 알파벳 정렬)은 deferred 도구 unlock 시 tools 배열 **중간 삽입** →
        프로바이더 렌더 순서가 tools→system→messages 라 삽입 지점 이후 프롬프트
        prefix-cache 전부 무효화(세션당 unlock 2-3회 × ~25K tokens 재처리).
        비-deferred prefix 를 고정하고 unlocked 는 꼬리에만 붙여 캐시 적중 보존.
        """
        unlocked = unlocked or set()
        base = sorted(
            (t for t in self._by_name.values() if not t.deferred),
            key=lambda t: t.name,
        )
        tail = sorted(
            (t for t in self._by_name.values() if t.deferred and t.name in unlocked),
            key=lambda t: t.name,
        )
        return base + tail

    def search(self, query: str, limit: int = 5) -> list[SearchMatch]:
        required, optional = _terms(query)
        if not required and not optional:
            return []
        scored: list[SearchMatch] = []
        for tool_cls in self._by_name.values():
            score = _score_tool(tool_cls, required, optional)
            if score <= 0:
                continue
            scored.append(SearchMatch(
                name=tool_cls.name,
                description_preview=_first_line(tool_cls.description),
                search_hint=tool_cls.search_hint,
                score=score,
            ))
        scored.sort(key=lambda m: (-m.score, m.name))
        return scored[:limit]

    def build_specs(self, unlocked: set[str] | None = None) -> list[ToolSpec]:
        return [
            ToolSpec(name=t.name, description=t.description, input_schema=t.input_schema())
            for t in self.active(unlocked)
        ]

    # ─── v3.12-A: 도메인 메타 기반 쿼리 + prompt 합성 ─────────────────

    def domains(self) -> tuple[str, ...]:
        """등록된 도구들의 도메인 정렬 unique 목록."""
        return tuple(sorted({t.domain for t in self._by_name.values()}))

    def tools_by_domain(self, domain: str) -> list[type[Tool[Any]]]:
        return sorted(
            (t for t in self._by_name.values() if t.domain == domain),
            key=lambda t: t.name,
        )

    def tools_section_text(
        self, *, domains: tuple[str, ...] | None = None,
    ) -> str:
        """도메인별 grouping 으로 도구 prompt_section concat.

        - domains 지정 시 해당 도메인만. None 이면 전부.
        - prompt_section 빈 도구는 자동 생략 — domain 헤더도 모든 도구가 빈 경우 생략.
        - 도메인 헤더 = "## {domain}"
        """
        target_domains = domains if domains is not None else self.domains()
        chunks: list[str] = []
        for d in sorted(target_domains):
            section_bodies: list[str] = []
            for t in self.tools_by_domain(d):
                if t.deferred:
                    continue  # deferred 도구는 별도 listing
                ps = (t.prompt_section or "").strip()
                if ps:
                    section_bodies.append(ps)
            if not section_bodies:
                continue
            chunks.append(f"## {d}\n\n" + "\n\n".join(section_bodies))
        return "\n\n".join(chunks)

    def dispatch_cheat_sheet_text(
        self, *, domains: tuple[str, ...] | None = None,
    ) -> str:
        """사용자 발화 → 도구 매핑 cheat sheet.

        형식 (markdown table-like):
            | 사용자 발화 / 의도 키워드          | 도구                |
            | ---                                 | ---                 |
            | secret/PII 스캔, 비밀 탐지          | scan_text           |
            | 기억 저장·조회                      | memory              |
        dispatch_keywords 빈 도구는 생략. domain 별 grouping 은 없음 (LLM lookup 용 평면).
        """
        target_domains = (
            set(domains) if domains is not None else set(self.domains())
        )
        rows: list[tuple[str, str]] = []
        for t in sorted(self._by_name.values(), key=lambda t: t.name):
            if t.domain not in target_domains:
                continue
            if t.deferred:
                continue  # deferred 도구는 cheat sheet 에서 분리
            kws = tuple(t.dispatch_keywords)
            if not kws:
                continue
            rows.append((", ".join(kws), t.name))
        if not rows:
            return ""
        kw_w = max(len(r[0]) for r in rows)
        name_w = max(len(r[1]) for r in rows)
        kw_w = max(kw_w, len("사용자 발화 / 의도 키워드"))
        name_w = max(name_w, len("도구"))
        lines = [
            f"| {'사용자 발화 / 의도 키워드'.ljust(kw_w)} | {'도구'.ljust(name_w)} |",
            f"| {'-' * kw_w} | {'-' * name_w} |",
        ]
        for kws, name in rows:
            lines.append(f"| {kws.ljust(kw_w)} | {name.ljust(name_w)} |")
        return "\n".join(lines)

    def deferred_tools_listing_text(
        self, *, domains: tuple[str, ...] | None = None,
    ) -> str:
        """deferred 도구 — 이름 + 한 줄 description + dispatch keywords.

        v3.17: schema 는 안 보이고 존재만 알린다. agent 가 tool_search 로
        unlock 후 사용. 빈 경우 빈 문자열.
        """
        target_domains = (
            set(domains) if domains is not None else set(self.domains())
        )
        rows: list[str] = []
        for t in sorted(self._by_name.values(), key=lambda t: t.name):
            if not t.deferred:
                continue
            if t.domain not in target_domains:
                continue
            desc_one = _first_line(t.description, limit=200)
            kws = ", ".join(t.dispatch_keywords) if t.dispatch_keywords else ""
            kw_part = f" (keywords: {kws})" if kws else ""
            rows.append(f"- **{t.name}** — {desc_one}{kw_part}")
        return "\n".join(rows)
