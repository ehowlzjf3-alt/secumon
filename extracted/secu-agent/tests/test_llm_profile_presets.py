"""프로파일 로스터의 **기록**이 실물과 갈라지지 않게 (2026-08-22).

## 무엇이 있었나

`config/llm_profiles.yaml` 은 gitignore 대상이다(.gitignore:12). 즉 커밋에 남는
로스터는 `.example` 뿐인데, 실제로 갈라져 있었다 —

    실물   : gemma deepseek codex o4-mini llama-4-maverick gaussO4 qwen
    example: gauss gemma llama-4-maverick

**워커가 도는 deepseek 도, 리드가 도는 codex 도 커밋 기록에 없었다.** 재설치하면
둘 다 사라지고, `.env` 가 가리키는 이름은 `_profile_names_from_env` 가 **조용히
버린다**(안 깨지고 사내 기본으로 fail-safe) — 그래서 오타처럼 티도 안 난다.

여기서 거는 것 둘:

1. `.env.example` 의 프리셋이 가리키는 모든 프로파일 이름이 example 로스터에 있다.
   (은퇴한 gauss-o41·gpt-oss 를 계속 예시로 남겨두던 것도 이 검사에 걸린다.)
2. 실물 yaml 이 있으면, 실물에만 있는 프로파일이 없어야 한다 — 있으면 그건
   "재설치하면 사라질 배선" 이다.

## 왜 이름만 보고 값은 안 보나

값(base_url·키)은 환경마다 다르고 `${VAR}` 로 늦게 채워진다. 갈라져서 사고가 난 건
**이름**이었다. 단 하나 예외로 deepseek 의 `model` 은 값까지 핀한다 — `openai/` 접두를
붙이면 게이트웨이가 400 "Invalid model name" 을 낸다(gemma/gauss 는 별칭과 실모델명이
둘 다 등록돼 있어 통하지만 deepseek 은 별칭뿐이다). 기존 프로필 관례를 복사하면 깨진다.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "config" / "llm_profiles.yaml.example"
LIVE = ROOT / "config" / "llm_profiles.yaml"
ENV_EXAMPLE = ROOT / ".env.example"

# 프로파일 **이름**을 값으로 갖는 env 키. 체인 키는 콤마로 여러 개를 담는다.
_PROFILE_ENV = re.compile(
    r"^\s*#?\s*(SA_CHAT_PROFILE|SA_CHAT_PROFILE_CHAIN|SA_LEAD_PROFILE"
    r"|SA_LEAD_PROFILE_CHAIN|SA_JUDGE_PROFILE|SA_SUMMARIZER_PROFILE)"
    r'\s*=\s*"?([^"#\n]*)"?\s*$'
)


def _roster(path: Path) -> set[str]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return set(data.get("profiles") or {})


def _names_referenced(path: Path) -> dict[str, set[str]]:
    """env 파일이 언급하는 프로파일 이름 → 그 이름을 쓴 키들."""
    out: dict[str, set[str]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = _PROFILE_ENV.match(line)
        if not m:
            continue
        key, raw = m.group(1), m.group(2).strip()
        for name in (p.strip() for p in raw.split(",")):
            if name:                       # 빈 값 = "역할 분리 끄기" 라 이름이 아니다
                out.setdefault(name, set()).add(key)
    return out


def test_env_example_presets_only_name_profiles_that_exist():
    roster = _roster(EXAMPLE)
    referenced = _names_referenced(ENV_EXAMPLE)
    assert referenced, ".env.example 에 프로파일 프리셋이 하나도 없다 — 블록이 지워졌나?"
    missing = {n: sorted(k) for n, k in referenced.items() if n not in roster}
    assert not missing, (
        f"{ENV_EXAMPLE.name} 이 로스터에 없는 프로파일을 가리킨다: {missing}. "
        f"현재 로스터={sorted(roster)}. 없는 이름은 조용히 버려지고 사내 기본으로 "
        "떨어진다 — 예시가 거짓말이 된다."
    )


def test_example_records_the_profiles_we_actually_run_on():
    """워커(deepseek)·리드(codex)·vision 대체(gemma) 는 기록에 반드시 있어야 한다."""
    roster = _roster(EXAMPLE)
    for name in ("deepseek", "codex", "gemma"):
        assert name in roster, (
            f"{name} 이 {EXAMPLE.name} 에 없다. 실물 yaml 은 gitignore 라 여기서 빠지면 "
            "재설치 때 그 배선이 통째로 사라진다."
        )


def test_deepseek_model_has_no_openai_prefix():
    profiles = yaml.safe_load(EXAMPLE.read_text(encoding="utf-8"))["profiles"]
    model = profiles["deepseek"]["model"]
    assert not model.startswith("openai/"), (
        f"deepseek model={model!r} — `openai/` 접두를 붙이면 게이트웨이가 400 "
        '"Invalid model name" 을 낸다(별칭만 등록돼 있다).'
    )


def test_live_roster_has_nothing_the_example_would_lose():
    if not LIVE.exists():           # 클린 체크아웃/CI 에는 실물이 없다
        return
    only_live = _roster(LIVE) - _roster(EXAMPLE)
    assert not only_live, (
        f"실물 llm_profiles.yaml 에만 있는 프로파일: {sorted(only_live)}. "
        "gitignore 라 커밋에 안 남는다 — .example 에도 넣어라(재설치하면 사라진다)."
    )
