"""Skill loader — markdown frontmatter 기반 도메인 playbook.

운영팀이 코드 변경 없이 새 패턴 / 도메인 인사이트를 markdown 으로 추가.
LLM 이 `skill(action='view', name=...)` 으로 on-demand 본문 로드.

지원 구조 (v3.26 Anthropic Skill 패턴):
  1. **single-file skill**: `<name>.md` — frontmatter + body.
  2. **directory skill**: `<name>/SKILL.md` (entry) + 추가 `.md` resources.
     entry SKILL.md 는 작게 (when_to_use + 안전 핵심 + resources 가이드).
     상세 (API / schema / 스니펫) 는 `<name>/api.md`, `<name>/schema.md` 등으로 분리.
     agent 가 `skill(action='view', name=..., resource='api.md')` 로 부분 로드.

SKILL.md frontmatter 형식 (YAML):
    ---
    name: <single-file 의 basename 또는 directory basename 과 일치 필수>
    description: <한 줄 — guidance 에 표시>
    domain: <core 또는 도메인 이름 — 예: core / <도메인>>
    when_to_use: <어떤 상황에서 로드하면 좋은지>
    triggers: comma,separated,keywords,or,re:<regex>
    ---
"""
from __future__ import annotations

import logging
import os
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from secu_agent.agent.tools.registry import ToolRegistry

log = logging.getLogger(__name__)

_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)
_KV_RE = re.compile(r"^([a-z_][a-z0-9_]*):\s*(.*)$", re.MULTILINE)

# v3.81 T3: 외부 skills 디렉토리 (다중 경로, os.pathsep 또는 ',' 구분).
# 재부착 전제조건 — plugin/skill repo 의 skills 를 코드 이동 없이 로드.
SKILLS_DIRS_ENV = "SA_SKILLS_DIRS"
_MODULE_SKILLS_DIR = Path(__file__).resolve().parent

# de-domain: 도메인 skill → 기본 unlock 도구 매핑은 plugin 이 소유한다
# (적출 원형: secu-agent-skill/engine_extracts/skill_default_unlock_tools.py).
# 메커니즘(unlock_default_tools_for_skills)은 코어 잔류 — 재부착 plugin 이
# register_skill_unlock_tools() 로 등록 (v3.81 T3 plugin API).
_DEFAULT_UNLOCK_TOOLS_BY_SKILL: dict[str, tuple[str, ...]] = {}


def register_skill_unlock_tools(
    skill_name: str, tools: tuple[str, ...] | list[str],
) -> None:
    """plugin 부트스트랩용 — skill 선택 시 기본 unlock 할 도구 매핑 등록.

    중복 등록은 명시 에러 (silent override 금지 — fanout/delivery 와 동일 결).
    """
    if skill_name in _DEFAULT_UNLOCK_TOOLS_BY_SKILL:
        raise ValueError(f"skill unlock 매핑 {skill_name!r} 이미 등록됨")
    _DEFAULT_UNLOCK_TOOLS_BY_SKILL[skill_name] = tuple(tools)


def unregister_skill_unlock_tools(skill_name: str) -> bool:
    return _DEFAULT_UNLOCK_TOOLS_BY_SKILL.pop(skill_name, None) is not None


@dataclass(frozen=True, slots=True)
class Skill:
    name: str
    description: str
    domain: str
    when_to_use: str
    body: str
    path: Path
    # v3.26: directory skill 의 추가 resources (basename, e.g. "api.md").
    # single-file skill 은 empty tuple.
    resources: tuple[str, ...] = field(default_factory=tuple)
    # directory 본부 — resource 로드 시 base. single-file 은 None.
    dir_path: Path | None = None
    # v3.50: deterministic auto-injection triggers. No orchestrator-specific
    # domain keyword tables; each skill owns its own routing hints.
    triggers: tuple[str, ...] = field(default_factory=tuple)


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str] | None:
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return None
    fm_text = m.group(1)
    body = m.group(2).strip()
    fields: dict[str, str] = {}
    for km in _KV_RE.finditer(fm_text):
        k = km.group(1).strip()
        v = km.group(2).strip()
        fields[k] = v
    return fields, body


def _split_triggers(raw: str) -> tuple[str, ...]:
    if not raw:
        return ()
    sep = ";" if ";" in raw else ","
    return tuple(part.strip() for part in raw.split(sep) if part.strip())


def _build_skill_from_md(
    md: Path, *, expected_name: str, dir_path: Path | None,
    resources: tuple[str, ...], domain_filter: str | None,
) -> Skill | None:
    try:
        text = md.read_text()
    except OSError:
        return None
    parsed = _parse_frontmatter(text)
    if parsed is None:
        return None
    fields, body = parsed
    name = fields.get("name", "").strip()
    if not name or name != expected_name:
        # ★ 조용히 넘기면 그 skill 은 '없는' 셈이 된다 — `skill(action='view', name=...)`
        # 가 not_found 를 돌려주는데 왜인지는 아무 데도 안 남는다. 실측(2026-08-20):
        # 도메인 루트 SKILL.md 7개(smb_tasking 등)가 이 분기로 통째로 사라져 있었고,
        # 그 사이 워커 지시문은 그것들을 열어보라고 시키고 있었다.
        # name 이 아예 없는 건(frontmatter 없는 일반 문서) 정상이라 조용히 넘긴다.
        if name:
            log.warning(
                "skill %s: frontmatter name=%r 이 기대 이름(%s)과 달라 무시된다 — "
                "디렉터리/파일 이름과 같게 맞춰라(이 skill 은 로드되지 않는다)",
                md, name, expected_name,
            )
        return None
    sk_domain = fields.get("domain", "core").strip()
    if domain_filter is not None and sk_domain != domain_filter:
        return None
    return Skill(
        name=name,
        description=fields.get("description", "").strip(),
        domain=sk_domain,
        when_to_use=fields.get("when_to_use", "").strip(),
        body=body,
        path=md,
        resources=resources,
        dir_path=dir_path,
        triggers=_split_triggers(fields.get("triggers", "")),
    )


def load_skills(
    skills_dir: Path | str, *, domain: str | None = None,
) -> list[Skill]:
    """skills_dir 안의 skill 들 파싱.

    - single-file: `<name>.md` (frontmatter, file stem == name)
    - directory: `<name>/SKILL.md` (frontmatter, dir basename == name) + 같은 디렉토리
      안 다른 *.md 가 resources (SKILL.md 제외, 정렬)
    - frontmatter 없거나 name mismatch 시 skip (silent)
    - domain 지정 시 해당 도메인만
    - 디렉토리 없으면 빈 list
    """
    d = Path(skills_dir)
    if not d.exists() or not d.is_dir():
        return []
    out: list[Skill] = []

    # 1) single-file skills
    for md in sorted(d.glob("*.md")):
        if not md.is_file():
            continue
        sk = _build_skill_from_md(
            md, expected_name=md.stem, dir_path=None,
            resources=(), domain_filter=domain,
        )
        if sk is not None:
            out.append(sk)

    # 2) directory skills — `<name>/SKILL.md` + 같은 디렉토리 *.md resources
    for sub in sorted(p for p in d.iterdir() if p.is_dir()):
        entry = sub / "SKILL.md"
        if not entry.is_file():
            continue
        resources = tuple(
            sorted(
                p.name for p in sub.glob("*.md")
                if p.name != "SKILL.md" and p.is_file()
            )
        )
        sk = _build_skill_from_md(
            entry, expected_name=sub.name, dir_path=sub,
            resources=resources, domain_filter=domain,
        )
        if sk is not None:
            out.append(sk)

    return sorted(out, key=lambda s: s.name)


@dataclass(frozen=True)
class SkillsSelection:
    """per-invocation skill 선택 — 세션 시작 시 고정 (v3.82 U4).

    - names: 비어있지 않으면 이름 필터. **first-wins dedup 후** 적용되고,
      미존재 이름은 ValueError (fail-loud — silent skip 금지).
    - extra_dirs: resolve 순서 **맨 뒤에 추가** (additive). 코어 dir 이 항상
      첫 번째인 first-wins fail-safe 를 유지한다 — 교체 시맨틱 금지.

    3개 로드 경로(시스템프롬프트 인덱스 / trigger 자동주입 / skill 도구)가
    전부 같은 selection 을 통과해야 한다 — 한 경로라도 빠지면 deselect 된
    skill 이 trigger 로 무음 재주입되거나 not_found 불일치가 생긴다.
    """

    names: tuple[str, ...] = ()
    extra_dirs: tuple[Path, ...] = ()


def parse_skills_selection(values: Iterable[str] | None) -> SkillsSelection | None:
    """CLI `-s` 값들 → SkillsSelection. 항목 = 이름 또는 디렉토리 경로.

    경로 판정: os.sep 포함 또는 실존 디렉토리. 명시 경로가 없으면 ValueError
    (fail-loud — env 와 달리 운영자가 직접 지정한 값이다). None/빈 = 선택 없음.
    """
    if not values:
        return None
    names: list[str] = []
    dirs: list[Path] = []
    for raw in values:
        for entry in str(raw).split(","):
            e = entry.strip()
            if not e:
                continue
            if os.sep in e or Path(e).expanduser().is_dir():
                path = Path(e).expanduser()
                if not path.is_dir():
                    raise ValueError(f"-s 디렉토리 없음: {e}")
                dirs.append(path.resolve())
            else:
                names.append(e)
    if not names and not dirs:
        return None
    return SkillsSelection(names=tuple(names), extra_dirs=tuple(dirs))


def resolve_skills_dirs() -> list[Path]:
    """skills 디렉토리 목록 — 코어 모듈 dir + env `SA_SKILLS_DIRS` 외부 경로.

    v3.81 T3 (재부착 전제조건): plugin/skill repo 의 skills 를 코드 이동
    없이 로드. 구분자는 os.pathsep(:) 우선, 없으면 ','. 존재하지 않는
    경로는 warning 후 skip. **코어 dir 이 항상 첫 번째** — 이름 충돌 시
    first-wins 라 외부 dir 이 코어 skill(보안 정책 등)을 silent override
    할 수 없다 (fail-safe).
    """
    dirs: list[Path] = [_MODULE_SKILLS_DIR]
    raw = (os.environ.get(SKILLS_DIRS_ENV) or "").strip()
    if not raw:
        return dirs
    sep = os.pathsep if os.pathsep in raw else ","
    for part in raw.split(sep):
        p = part.strip()
        if not p:
            continue
        path = Path(p).expanduser()
        if not path.is_dir():
            log.warning("%s 경로 없음 — skip: %s", SKILLS_DIRS_ENV, path)
            continue
        resolved = path.resolve()
        if resolved in dirs:
            continue
        dirs.append(resolved)
    return dirs


def load_skills_all(
    dirs: Iterable[Path | str] | None = None, *, domain: str | None = None,
    selection: SkillsSelection | None = None,
) -> list[Skill]:
    """다중 dir 로드 + 이름 dedup (first-wins — resolve_skills_dirs 순서).

    충돌(같은 name 이 뒤 dir 에도)은 warning 으로 가시화하고 무시한다.
    selection(v3.82 U4): extra_dirs 는 dirs=None 일 때 resolve 뒤에 additive,
    names 는 dedup **후** 필터 — 미존재 이름은 ValueError (fail-loud).
    """
    if dirs is None:
        dirs = list(resolve_skills_dirs())
        if selection is not None:
            for d in selection.extra_dirs:
                r = Path(d).resolve()
                if r not in dirs:
                    dirs.append(r)
    seen: dict[str, Skill] = {}
    for d in dirs:
        for sk in load_skills(d, domain=domain):
            prev = seen.get(sk.name)
            if prev is not None:
                log.warning(
                    "skill 이름 충돌 — 무시: %s (%s; 선등록 %s)",
                    sk.name, sk.path, prev.path,
                )
                continue
            seen[sk.name] = sk
    if selection is not None and selection.names:
        unknown = set(selection.names) - set(seen)
        if unknown:
            raise ValueError(
                f"-s 미존재 skill: {sorted(unknown)} (사용 가능: {sorted(seen)})"
            )
        seen = {n: sk for n, sk in seen.items() if n in selection.names}
    return sorted(seen.values(), key=lambda s: s.name)


SAFETY_RESOURCE = "safety.md"


def skill_body_with_safety(skill: Skill) -> str:
    """skill body + (있으면) per-skill safety.md 동반 — v3.81 T3.

    trigger 자동 주입(_auto_skill_context_for_turn) 경로에서 사용:
    매칭된 도메인의 안전 계약이 playbook 과 **반드시 함께** 들어간다.
    무관 도메인의 safety 는 안 실리므로 토큰 낭비 없음 (확정 결정, 사용자 ⑤안).
    """
    if skill.dir_path is None or SAFETY_RESOURCE not in skill.resources:
        return skill.body
    try:
        safety = (skill.dir_path / SAFETY_RESOURCE).read_text(encoding="utf-8")
    except OSError:
        return skill.body
    if not safety.strip():
        return skill.body
    return (
        skill.body
        + f"\n\n### {skill.name} 안전 계약 (safety.md — 위반 금지)\n\n"
        + safety.strip()
    )


def build_skills_guidance(
    skills_dir: Path | str | None = None, *,
    selection: SkillsSelection | None = None,
) -> str:
    """available skills index — system prompt 에 inject.

    LLM 에게:
      - 어떤 skill 들이 있는지 (이름 + description + when_to_use)
      - skill_view(name) 으로 본문 로드하는 법
      - directory skill 의 resources 도 안내

    skills_dir=None (v3.81 T3 기본) → resolve_skills_dirs() 다중 경로.
    """
    if skills_dir is None:
        skills = load_skills_all(selection=selection)
    else:
        skills = load_skills(skills_dir)
    if not skills:
        return ""
    lines = [
        "## Skills (on-demand 로드)",
        "",
        "필요할 때 `skill(action='view', name=\"...\")` 로 본문 로드. "
        "directory skill 은 `resource='api.md'` 같은 추가 인자로 세부 reference 로드.",
        "",
        "| skill | 도메인 | 설명 | resources |",
        "| --- | --- | --- | --- |",
    ]
    for s in skills:
        desc = s.description or "-"
        if s.resources:
            res = ", ".join(s.resources)
        else:
            res = "-"
        lines.append(f"| `{s.name}` | {s.domain} | {desc} | {res} |")
    return "\n".join(lines)


def default_tools_for_skill(skill_name: str) -> tuple[str, ...]:
    """Return tool names that should be available when a skill is selected."""
    return _DEFAULT_UNLOCK_TOOLS_BY_SKILL.get(skill_name, ())


def unlock_default_tools_for_skills(
    skill_names: list[str] | tuple[str, ...] | set[str],
    *,
    registry: "ToolRegistry | None",
    unlocked_tools: set[str],
) -> list[str]:
    """Unlock default tool schemas for selected skills when registered.

    Heavy per-domain tools stay deferred globally; selecting a skill unlocks its
    registered working-set tools without spending a separate model pass.
    """
    loaded: list[str] = []
    for skill_name in skill_names:
        for tool_name in default_tools_for_skill(skill_name):
            if registry is not None and registry.get(tool_name) is None:
                continue
            if tool_name in unlocked_tools:
                continue
            unlocked_tools.add(tool_name)
            loaded.append(tool_name)
    return loaded
