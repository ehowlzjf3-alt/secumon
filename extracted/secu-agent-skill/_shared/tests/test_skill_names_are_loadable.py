"""skill/agent 이름이 파일·디렉터리와 맞는지 — 안 맞으면 **조용히 사라진다**.

## 배경 (2026-08-20 실측)

`_build_skill_from_md` 는 `name != expected_name` 이면 `None` 을 돌려주고 끝난다.
그래서 도메인 루트 SKILL.md 7개(`smb_tasking`, `dev_web_tasking`, `github_e2e` …)가
통째로 사라져 있었고, 그 사이 문서·프롬프트는 그것들을 `skill(action='view', ...)` 로
열라고 시키고 있었다. 워커는 not_found 만 받았고 왜인지는 아무 데도 안 남았다.

코어 로더에 경고를 넣었지만(2026-08-20), 경고는 로그를 보는 사람이 있어야 소용이 있다.
여기서 구조로 고정한다.

⚠️ 도메인 루트(`domains/<d>/SKILL.md`)는 skill 이 **아니다** — `domains/` 자체가 탐색
경로가 아니다(`_skill_search_dirs()` 는 `domains/<d>/skills` 만 본다). 그래도 이름은
디렉터리와 맞춰 둔다: 못 지킬 이름을 내걸지 않기 위해서고, 나중에 탐색 경로가 늘어도
조용히 사라지지 않게 하기 위해서다.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_NAME_RE = re.compile(r"^name:\s*(.+)$", re.MULTILINE)


def _frontmatter_name(md: Path) -> str | None:
    text = md.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return None
    head = text[: text.index("---", 3)] if "---" in text[3:] else text
    m = _NAME_RE.search(head)
    return m.group(1).strip() if m else None


def _all_skill_mds() -> list[Path]:
    return sorted(_REPO.glob("domains/**/SKILL.md")) + sorted(_REPO.glob("roles/*/SKILL.md"))


@pytest.mark.parametrize("md", _all_skill_mds(), ids=lambda p: str(p.relative_to(_REPO)))
def test_skill_name_matches_its_directory(md: Path) -> None:
    name = _frontmatter_name(md)
    if name is None:
        return   # frontmatter 없는 문서 — skill 을 자처하지 않으므로 정상
    assert name == md.parent.name, (
        f"{md.relative_to(_REPO)}: name={name!r} 이 디렉터리({md.parent.name!r})와 다르다 — "
        f"로더가 **조용히 skip** 한다. 둘을 같게 맞춰라"
    )


def test_every_search_dir_skill_actually_loads() -> None:
    """★ 탐색 경로 안의 skill 은 하나도 빠짐없이 로드돼야 한다."""
    from secu_agent.agent.skills import load_skills_all
    from service.agents import runtime

    dirs = runtime._skill_search_dirs()
    expected = {
        p.parent.name
        for d in dirs for p in Path(d).glob("*/SKILL.md")
    }
    loaded = {s.name for s in load_skills_all(dirs=dirs)}
    missing = expected - loaded
    assert not missing, f"탐색 경로에 있는데 로드 안 된 skill: {sorted(missing)}"


def test_worker_contract_resources_referenced_by_docs_are_reachable() -> None:
    """문서가 `resource='X'` 로 열라고 시키면 그 X 가 실제 resource 여야 한다."""
    from secu_agent.agent.skills import load_skills_all
    from service.agents import runtime

    by_name = {s.name: s for s in load_skills_all(dirs=runtime._skill_search_dirs())}
    pattern = re.compile(
        r"skill\(action='view',\s*name='([A-Za-z0-9_]+)'(?:,\s*resource='([^']+)')?\)")

    problems: list[str] = []
    for md in _REPO.glob("domains/**/*.md"):
        for name, resource in pattern.findall(md.read_text(encoding="utf-8")):
            sk = by_name.get(name)
            if sk is None:
                problems.append(f"{md.relative_to(_REPO)}: skill {name!r} 이 로드되지 않는다")
            elif resource and resource not in sk.resources:
                problems.append(
                    f"{md.relative_to(_REPO)}: {name}/{resource} 가 resource 에 없다 "
                    f"(있는 것: {sk.resources})")
    assert not problems, "\n".join(problems)


@pytest.mark.parametrize("md", sorted(_REPO.glob("domains/**/agents/*.md")),
                         ids=lambda p: str(p.relative_to(_REPO)))
def test_agent_name_matches_its_filename(md: Path) -> None:
    """`load_agents` 는 `md.stem != name` 이면 조용히 skip 한다."""
    name = _frontmatter_name(md)
    assert name is not None, f"{md.relative_to(_REPO)}: agent 정의에 frontmatter 가 없다"
    assert name == md.stem, (
        f"{md.relative_to(_REPO)}: name={name!r} 이 파일명({md.stem!r})과 다르다 — "
        f"이 sub-agent 는 호출 불가 상태다"
    )
