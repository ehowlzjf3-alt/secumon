from __future__ import annotations

from pathlib import Path


def test_web_tasking_skill_frontmatter():
    """web 도메인 overview 문서(domains/web/SKILL.md)의 frontmatter.

    ⚠️ 이건 **로드되는 skill 이 아니다** — `domains/` 자체가 탐색 경로가 아니라
    (`_skill_search_dirs()` 는 `domains/<d>/skills` 만 본다) 어떤 이름을 붙여도 로드되지
    않는다. 그래서 frontmatter 를 파일로 직접 검증한다.

    2026-08-20: name 이 `web_tasking` 이라 디렉터리(`web`)와 달랐다. 못 지킬 이름을
    내걸지 않도록 디렉터리에 맞췄다 — 코어 로더가 이 불일치에 경고를 내기 시작했고
    (조용한 skip 이 실사고를 만들었다), 이 파일들이 그 경고를 매번 울리게 된다.
    """
    text = Path("domains/web/SKILL.md").read_text(encoding="utf-8")
    assert text.startswith("---"), "frontmatter 블록 필요"
    fm = text.split("---", 2)[1]
    meta = {}
    for line in fm.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
    assert meta.get("name") == "web", "이름은 디렉터리와 같아야 한다"
    assert meta.get("domain") == "web"


def test_web_tasking_skill_mentions_required_semantic_categories():
    body = Path("domains/web/SKILL.md").read_text(
        encoding="utf-8",
    ).lower()

    for text in (
        "web_resource_probe",
        "semantic validation",
        "semiconductor",
        "business confidential",
        "attack-surface",
        "spa/cdn fallback",
        "masked",
    ):
        assert text in body
