"""`_skill_search_dirs()` 가 같은 디렉터리를 두 번 주지 않는지.

## 배경 (2026-08-20 실측)

워커 subprocess 로그마다 이 경고가 돌고 있었다:

    skill 이름 충돌 — 무시: github_task (<경로>/github_task/SKILL.md;
                                       선등록 <같은 경로>/github_task/SKILL.md)

**같은 경로**가 양쪽에 찍혔다. 원인은 두 겹이었다:

  1. `_skill_search_dirs()` 가 4도메인 skills 를 하드코딩으로 넣는다.
  2. 각 도메인 `infrastructure/runtime.py` 가 워커를 띄울 때
     `SA_SKILLS_DIRS=<자기 도메인 skills>` 를 주입한다.
  → 스폰한 도메인의 디렉터리가 두 번 들어가고, `load_skills_all` 이 그 디렉터리를
     두 번 훑는다(도메인 skill 수만큼 경고).

동작은 옳았다(같은 디렉터리라 first-wins 가 같은 skill 을 고른다). 그래서 오래 남았다.
실제 손해는 (a) 중복 스캔, (b) **진짜 이름 충돌이 이 소음에 묻히는 것**이다.
"""
from __future__ import annotations

import os

import pytest

from service.agents import runtime


def _names(dirs) -> list[str]:
    return [str(d.expanduser().resolve()) for d in dirs]


def test_no_duplicates_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SA_SKILLS_DIRS", raising=False)
    got = _names(runtime._skill_search_dirs())
    assert len(got) == len(set(got))


def test_env_repeating_a_builtin_dir_is_deduped(monkeypatch: pytest.MonkeyPatch) -> None:
    """★ 실제로 나던 상황 — 도메인 러너가 자기 skills 를 env 로 다시 넣는다."""
    monkeypatch.delenv("SA_SKILLS_DIRS", raising=False)
    base = runtime._skill_search_dirs()
    github = next(d for d in base if "github" in str(d))

    monkeypatch.setenv("SA_SKILLS_DIRS", str(github))
    got = _names(runtime._skill_search_dirs())
    assert len(got) == len(set(got)), "env 가 가리킨 디렉터리가 중복으로 들어갔다"
    assert len(got) == len(base), "dedup 이 되면 개수가 늘지 않아야 한다"


def test_env_adds_a_genuinely_new_dir(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    """dedup 이 새 경로까지 막으면 안 된다."""
    monkeypatch.delenv("SA_SKILLS_DIRS", raising=False)
    n0 = len(runtime._skill_search_dirs())
    monkeypatch.setenv("SA_SKILLS_DIRS", str(tmp_path))
    got = runtime._skill_search_dirs()
    assert len(got) == n0 + 1
    assert str(tmp_path) in _names(got)


def test_symlinked_duplicate_is_deduped(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    """경로 문자열이 달라도 같은 곳이면 한 번만 — 컨테이너 마운트에서 실제로 갈린다."""
    monkeypatch.delenv("SA_SKILLS_DIRS", raising=False)
    base = runtime._skill_search_dirs()
    smb = next(d for d in base if "smb" in str(d))
    link = tmp_path / "smb_link"
    link.symlink_to(smb, target_is_directory=True)

    monkeypatch.setenv("SA_SKILLS_DIRS", str(link))
    got = _names(runtime._skill_search_dirs())
    assert len(got) == len(set(got))
    assert len(got) == len(base)


def test_multiple_env_entries_are_deduped(monkeypatch: pytest.MonkeyPatch) -> None:
    """도메인 러너는 기존 값 뒤에 자기 것을 **덧붙인다** — 체인이 길어지면 중복이 는다."""
    monkeypatch.delenv("SA_SKILLS_DIRS", raising=False)
    base = runtime._skill_search_dirs()
    a = next(d for d in base if "github" in str(d))
    b = next(d for d in base if "confluence" in str(d))

    monkeypatch.setenv("SA_SKILLS_DIRS", os.pathsep.join([str(a), str(b), str(a)]))
    got = _names(runtime._skill_search_dirs())
    assert len(got) == len(set(got))
    assert len(got) == len(base)


def test_contract_still_loads_after_dedup() -> None:
    """dedup 이 실제 계약 로딩을 깨지 않았는지 — 4도메인 전부."""
    for name in ("smb_task", "dev_web_task", "github_task", "confluence_task"):
        body = runtime.load_skill_contract(name, resource="worker.md")
        assert body.strip(), name
