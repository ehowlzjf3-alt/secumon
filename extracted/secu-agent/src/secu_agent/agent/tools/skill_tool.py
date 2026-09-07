"""SkillTool — LLM on-demand skill 로드 (Anthropic Skill 패턴).

action=list                       → 사용 가능 skill 인덱스 (이름 + description + resources)
action=view, name=X               → entry body (single-file body 또는 SKILL.md body)
action=view, name=X, resource=Y   → directory skill 의 추가 docs (`<name>/Y.md` 또는 `<name>/Y`)

설계 (v3.26):
- view 본문은 **직접 inline 통과** — engine 의 stash wrapper 거치지 않음 (`_CORE_NO_STASH_TOOLS` 등록).
  SKILL.md 가 작게 (보통 < 4KB) 작성되어 있다는 전제. 본문 크면 그건 분할 시그널.
- resource 인자 path safety: 단순 basename 또는 sub-path. `..` / absolute / null-byte 금지.
- single-file skill 에 resource 인자 주면 validation error.
"""
from __future__ import annotations

from pathlib import Path
from typing import ClassVar, Literal

from pydantic import BaseModel, Field

from secu_agent.agent.skills import (
    Skill,
    load_skills_all,
    resolve_skills_dirs,
    unlock_default_tools_for_skills,
)
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


# 안전 출력 cap — entry 본문은 보통 < 8KB. resource 도 비슷.
# 이 cap 안 넘기게 SKILL.md 작성 (분할 신호).
_SKILL_VIEW_OUTPUT_CAP = 32 * 1024


class SkillInput(BaseModel):
    action: Literal["list", "view"]
    name: str | None = Field(None, max_length=80,
                             description="action=view 시 필수")
    resource: str | None = Field(
        None, max_length=120,
        description=(
            "directory skill 의 추가 reference 파일 (e.g. 'api.md'). "
            "path 는 단순 파일명만 — `..`/absolute 거부. "
            "생략 시 entry body (SKILL.md)."
        ),
    )


def _resolve_skill_dirs(ctx: ToolContext) -> list[Path]:
    """v3.82 U4: ctx.metadata['skills_dir'] 는 **additive** — resolve_skills_dirs()
    (코어 first-wins fail-safe) 뒤에 추가된다. 구 '교체' 시맨틱은 코어 dir 보호를
    우회하는 구멍이라 폐기."""
    dirs = list(resolve_skills_dirs())
    explicit = ctx.metadata.get("skills_dir") if ctx.metadata else None
    extra: list[Path] = []
    if isinstance(explicit, (str, Path)):
        extra = [Path(explicit)]
    elif isinstance(explicit, (list, tuple)):
        extra = [Path(p) for p in explicit]
    sel = _skills_selection(ctx)
    if sel is not None:
        extra.extend(Path(d) for d in sel.extra_dirs)
    for d in extra:
        r = d.resolve()
        if r not in dirs:
            dirs.append(r)
    return dirs


def _skills_selection(ctx: ToolContext):
    sel = ctx.metadata.get("skills_selection") if ctx.metadata else None
    return sel


def _validate_resource(name: str) -> str | None:
    """resource path safety. 통과하면 None, 거부하면 reason 반환."""
    if not name:
        return "empty"
    if "\x00" in name:
        return "null byte"
    if name.startswith("/") or name.startswith("\\"):
        return "absolute path 금지"
    # 어떤 형태든 `..` 세그먼트 금지
    parts = name.replace("\\", "/").split("/")
    if any(p == ".." for p in parts):
        return "상위 디렉토리 (..) 금지"
    return None


def _cap_output(text: str) -> str:
    if len(text) <= _SKILL_VIEW_OUTPUT_CAP:
        return text
    keep = _SKILL_VIEW_OUTPUT_CAP - 200
    return text[:keep] + (
        f"\n\n... [truncated — body exceeded {_SKILL_VIEW_OUTPUT_CAP} bytes. "
        f"이 skill 은 분할이 필요합니다. 운영자에게 보고하세요.]"
    )


def _format_available_skills(skills: list[Skill], skill_dirs: list[Path]) -> str:
    dirs_text = ", ".join(str(d) for d in skill_dirs)
    if not skills:
        return f"available skills: (none) (dirs: {dirs_text})"
    lines = [f"available skills (총 {len(skills)}, dirs: {dirs_text}):"]
    for skill in skills:
        when = f" — when: {skill.when_to_use}" if skill.when_to_use else ""
        lines.append(
            f"  - {skill.name} [{skill.domain}]: {skill.description}{when}"
        )
    return "\n".join(lines)


class SkillTool(Tool[SkillInput]):
    name: ClassVar[str] = "skill"
    description: ClassVar[str] = (
        "Domain playbook (skill) 인덱스 + 본문 로드.\n"
        "- action='list': 사용 가능 skill (이름 / 도메인 / 설명 / resources)\n"
        "- action='view' + name: skill entry body 전체 inline\n"
        "- action='view' + name + resource: directory skill 의 추가 reference\n"
        "  (action='list' 가 보여준 resources 중 하나). resource path 는 단순 파일명만.\n"
        "큰 도메인 playbook 을 system prompt 에 다 박지 않고 필요할 때만 로드. "
        "운영팀이 새 markdown 파일 / 디렉토리 추가하면 자동 등록."
    )
    input_model: ClassVar[type[BaseModel]] = SkillInput
    is_read_only: ClassVar[bool] = True
    domain: ClassVar[str] = "core"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "skill", "playbook", "패턴", "가이드",
    )
    prompt_section: ClassVar[str] = (
        "### skill(action, name=..., resource=...)\n"
        "도메인별 playbook (markdown) on-demand 로드.\n"
        "- `action='list'`: 사용 가능 skill 확인 (resources 도 표시)\n"
        "- `action='view' + name`: entry body 전체 (작은 SKILL.md 본문이 그대로)\n"
        "- `action='view' + name + resource='X.md'`: directory skill 의 추가 docs\n"
        "운영 패턴 / 도메인 인사이트 / anti-pattern 등이 skill 로 외부화. "
        "막혔거나 API 시그니처 헷갈리면 entry 본문 + 필요한 resource 즉시 view."
    )

    async def execute(self, vi: SkillInput, ctx: ToolContext) -> ToolResult:
        skill_dirs = _resolve_skill_dirs(ctx)
        # v3.34-C: 같은 session 안에서 같은 (skill, resource) view 가 반복되면
        # 짧은 reminder 만 반환 — 매 user msg 마다 2KB 토큰 낭비 방지.
        # 사용자가 명시적 list 호출하면 캐시 무관 — 짧음.
        cache_key = None
        if vi.action == "view" and vi.name:
            cache_key = f"skill_view::{vi.name}::{vi.resource or ''}"
            cache: set = ctx.metadata.setdefault("_skill_view_cache", set())
            if cache_key in cache:
                resource_suffix = f" / resource: {vi.resource}" if vi.resource else ""
                return ToolSuccess(content=(
                    f"[이미 본 skill: {vi.name}{resource_suffix} — 본문 재인쇄 생략] "
                    f"본문 내용을 다시 보려면 직접 기억해서 재인쇄 X. "
                    f"바로 작업 진행."
                ))
        sel = _skills_selection(ctx)
        names = tuple(getattr(sel, "names", ()) or ())
        skills: list[Skill] = load_skills_all(skill_dirs)
        if names:
            # v3.82 U4: per-session 이름 선택 — list/view 모두 동일 필터
            # (시스템프롬프트 인덱스와 불일치 시 not_found 혼선 방지)
            skills = [s for s in skills if s.name in names]
        if vi.action == "list":
            if not skills:
                dirs_text = ", ".join(str(d) for d in skill_dirs)
                return ToolSuccess(content=f"skill 없음 (dirs: {dirs_text})")
            lines = [f"skills (총 {len(skills)}):"]
            for s in skills:
                when = f" — when: {s.when_to_use}" if s.when_to_use else ""
                lines.append(
                    f"  - {s.name} [{s.domain}]: {s.description}{when}"
                )
                if s.resources:
                    res_list = ", ".join(s.resources)
                    lines.append(f"      resources: {res_list}")
            return ToolSuccess(content="\n".join(lines))

        # view
        if not vi.name:
            return ToolError(
                kind="validation",
                message="action='view' 는 name 필수",
            )
        skill = next((s for s in skills if s.name == vi.name), None)
        if skill is None:
            return ToolError(
                kind="not_found",
                message=(
                    f"skill '{vi.name}' not found. "
                    f"Use skill(action='list') and only load listed skill names; "
                    f"do not invent skill names.\n"
                    f"{_format_available_skills(skills, skill_dirs)}"
                ),
            )

        # resource 인자 — directory skill 만 지원
        if vi.resource is not None:
            if skill.dir_path is None:
                return ToolError(
                    kind="validation",
                    message=(
                        f"skill '{skill.name}' 는 single-file 이라 resource 없음. "
                        f"기본 view (resource 생략) 로 호출."
                    ),
                )
            reason = _validate_resource(vi.resource)
            if reason is not None:
                return ToolError(
                    kind="path_escape",
                    message=f"resource path 거부: {reason}",
                )
            target = (skill.dir_path / vi.resource).resolve()
            try:
                target.relative_to(skill.dir_path.resolve())
            except ValueError:
                return ToolError(
                    kind="path_escape",
                    message="resource 가 skill 디렉토리 밖을 가리킴",
                )
            if not target.is_file():
                return ToolError(
                    kind="not_found",
                    message=(
                        f"resource '{vi.resource}' not found in skill "
                        f"'{skill.name}'. 사용 가능: {', '.join(skill.resources)}"
                    ),
                )
            try:
                body = target.read_text()
            except OSError as e:
                return ToolError(kind="io_error", message=f"read 실패: {e}")
            header = f"# skill: {skill.name} / resource: {vi.resource}\n\n"
            if cache_key is not None:
                ctx.metadata["_skill_view_cache"].add(cache_key)
            loaded = unlock_default_tools_for_skills(
                [skill.name],
                registry=ctx.registry,
                unlocked_tools=ctx.unlocked_tools,
            )
            suffix = (
                "\n\n[auto-loaded tools]\n" + ", ".join(loaded)
                if loaded else ""
            )
            return ToolSuccess(content=_cap_output(header + body + suffix))

        # 기본 view — entry body
        meta = (
            f"# skill: {skill.name}\n"
            f"domain: {skill.domain}\n"
            f"description: {skill.description}\n"
        )
        if skill.when_to_use:
            meta += f"when_to_use: {skill.when_to_use}\n"
        if skill.resources:
            meta += f"resources: {', '.join(skill.resources)} "\
                    f"(view 에 resource='X.md' 인자로 로드)\n"
        if cache_key is not None:
            ctx.metadata["_skill_view_cache"].add(cache_key)
        loaded = unlock_default_tools_for_skills(
            [skill.name],
            registry=ctx.registry,
            unlocked_tools=ctx.unlocked_tools,
        )
        suffix = (
            "\n\n[auto-loaded tools]\n" + ", ".join(loaded)
            if loaded else ""
        )
        return ToolSuccess(content=_cap_output(meta + "\n" + skill.body + suffix))
