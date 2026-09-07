"""v3.81 T3: skill 보일러플레이트(scaffold) + lint.

skill 작성의 1순위 함정 = **디렉토리/파일명 ≠ frontmatter `name`** —
loader 가 silent skip 해서 "만들었는데 안 보임"이 된다. scaffold 는 이
불일치가 구조적으로 불가능하게 생성하고, lint 는 loader 가 조용히 버리는
모든 경우를 가시화한다 (CLI: `secu-agent skill new|lint`).

생성 레이아웃 (directory skill, Anthropic Skill 패턴):
    <name>/SKILL.md      — entry (frontmatter + 작은 본문)
    <name>/api.md        — 도구/API 시그니처 reference
    <name>/schema.md     — 데이터/finding 스키마
    <name>/snippets.md   — 검증된 코드/쿼리 스니펫
    <name>/safety.md     — 도메인 안전 계약 (trigger 주입 시 body 와 동반)
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from secu_agent.agent.skills import (
    _parse_frontmatter, _split_triggers, load_skills_all, resolve_skills_dirs,
)

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_]{1,63}$")
_BODY_CAP_BYTES = 32 * 1024  # skill_tool _SKILL_VIEW_OUTPUT_CAP 와 동일

_RESOURCE_STUBS: dict[str, str] = {
    "api.md": "# {name} — API/도구 reference\n\n(공통 도구 사용법·시그니처. 도메인 전용 도구 작성은 지양 — 공통 도구 + 가이드로.)\n",
    "schema.md": "# {name} — 데이터/finding 스키마\n\n(finding payload 형태, 업무 시스템 업로드 포맷.)\n",
    "snippets.md": "# {name} — 검증된 스니펫\n\n(python_exec/terminal 에서 그대로 쓰는 코드·쿼리. 검증 안 된 것 금지.)\n",
    "safety.md": "# {name} — 안전 계약\n\n(이 도메인 전용 가드레일. trigger 자동 주입 시 본문과 **함께** 들어간다. 읽기전용·rate-limit·lockout 규칙 등.)\n",
}

_SKILL_TEMPLATE = """\
---
name: {name}
description: {description}
domain: {domain}
when_to_use: {when_to_use}
triggers: {triggers}
---

# {name}

(여기에 작은 entry 본문 — when_to_use 요약 + 안전 핵심 + resources 안내.
상세는 api.md/schema.md/snippets.md 로 분리하고 본문은 32KB cap 아래로.)

## resources

- `api.md` — 공통 도구 사용 가이드
- `schema.md` — 데이터/업로드 스키마
- `snippets.md` — 검증된 스니펫
- `safety.md` — 안전 계약 (trigger 주입 시 자동 동반)
"""


def scaffold_skill(
    skills_dir: Path | str,
    *,
    name: str,
    domain: str = "core",
    description: str = "",
    when_to_use: str = "",
    triggers: tuple[str, ...] = (),
) -> Path:
    """directory skill 생성 — frontmatter name == 디렉토리명 보장.

    반환 = 생성된 skill 디렉토리. 이미 존재하면 ValueError (덮어쓰기 금지).
    """
    if not _NAME_RE.match(name):
        raise ValueError(
            f"skill name {name!r} 무효 — ^[a-z0-9][a-z0-9_]{{1,63}}$ "
            "(loader 는 디렉토리명==frontmatter name 일치를 요구)"
        )
    base = Path(skills_dir)
    target = base / name
    if target.exists():
        raise ValueError(f"이미 존재: {target}")
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text(_SKILL_TEMPLATE.format(
        name=name,
        description=description or f"{name} playbook",
        domain=domain,
        when_to_use=when_to_use or "(어떤 상황에서 로드할지)",
        triggers=", ".join(triggers) if triggers else name,
    ), encoding="utf-8")
    for fname, stub in _RESOURCE_STUBS.items():
        (target / fname).write_text(stub.format(name=name), encoding="utf-8")
    return target


@dataclass(frozen=True, slots=True)
class LintIssue:
    severity: str  # "error" (loader 가 skip — 안 보임) | "warn"
    path: str
    message: str

    def __str__(self) -> str:
        return f"[{self.severity}] {self.path}: {self.message}"


def _lint_one(
    md: Path, *, expected_name: str, kind: str, issues: list[LintIssue],
) -> str | None:
    """frontmatter 검사 — 유효하면 skill name 반환, 아니면 None."""
    try:
        text = md.read_text(encoding="utf-8")
    except OSError as e:
        issues.append(LintIssue("error", str(md), f"읽기 실패: {e}"))
        return None
    parsed = _parse_frontmatter(text)
    if parsed is None:
        issues.append(LintIssue(
            "error", str(md),
            "frontmatter 없음/형식 오류 — loader 가 silent skip (안 보임)",
        ))
        return None
    fields, body = parsed
    name = fields.get("name", "").strip()
    if not name:
        issues.append(LintIssue(
            "error", str(md), "frontmatter `name` 누락 — silent skip",
        ))
        return None
    if name != expected_name:
        issues.append(LintIssue(
            "error", str(md),
            f"name {name!r} ≠ {kind} {expected_name!r} — silent skip "
            "(1순위 함정)",
        ))
        return None
    if len(body.encode("utf-8")) > _BODY_CAP_BYTES:
        issues.append(LintIssue(
            "error", str(md),
            f"body {len(body.encode('utf-8'))}B > {_BODY_CAP_BYTES}B cap — "
            "skill_view 가 절단함. resources 로 분할 필요",
        ))
    for raw in _split_triggers(fields.get("triggers", "")):
        if raw.startswith("re:"):
            try:
                re.compile(raw[3:])
            except re.error as e:
                issues.append(LintIssue(
                    "error", str(md),
                    f"trigger 정규식 컴파일 실패 {raw!r}: {e} — 매칭 안 됨",
                ))
    for field_name in ("description", "when_to_use"):
        if not fields.get(field_name, "").strip():
            issues.append(LintIssue(
                "warn", str(md), f"`{field_name}` 비어 있음 — 인덱스 표에 '-'",
            ))
    return name


def lint_skills(dirs: list[Path] | None = None) -> list[LintIssue]:
    """skills 디렉토리들 정적 검사 — loader 의 silent skip 전수 가시화.

    dirs=None → resolve_skills_dirs() (코어 + SA_SKILLS_DIRS).
    """
    if dirs is None:
        dirs = resolve_skills_dirs()
    issues: list[LintIssue] = []
    trigger_owner: dict[str, str] = {}

    for d in dirs:
        d = Path(d)
        if not d.is_dir():
            issues.append(LintIssue("error", str(d), "디렉토리 없음"))
            continue
        for md in sorted(d.glob("*.md")):
            _lint_one(md, expected_name=md.stem, kind="파일명", issues=issues)
        for sub in sorted(p for p in d.iterdir() if p.is_dir()):
            entry = sub / "SKILL.md"
            if not entry.is_file():
                if any(sub.glob("*.md")):
                    issues.append(LintIssue(
                        "error", str(sub),
                        "SKILL.md 없음 — directory skill 로 인식 안 됨",
                    ))
                continue
            _lint_one(entry, expected_name=sub.name, kind="디렉토리명",
                      issues=issues)

    # trigger 충돌 — 같은 trigger 문자열이 두 skill 에 있으면 둘 다 주입됨
    for skill in load_skills_all(dirs):
        for raw in skill.triggers:
            t = raw.strip().lower()
            if not t:
                continue
            prev = trigger_owner.get(t)
            if prev is not None and prev != skill.name:
                issues.append(LintIssue(
                    "warn", str(skill.path),
                    f"trigger {raw!r} 가 {prev!r} 와 충돌 — 둘 다 자동 주입됨",
                ))
                continue
            trigger_owner[t] = skill.name
    return issues
