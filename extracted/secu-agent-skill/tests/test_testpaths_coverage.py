"""`testpaths` 가 모든 tests 디렉터리를 덮는지 — 조용한 커버리지 구멍 방지.

## 배경 (2026-08-20)

`domains/dev_web/tests` 가 `testpaths` 에 없었다. 그 디렉터리는 비어 있어서 그동안
문제가 드러나지 않았는데, 거기에 첫 테스트를 넣자 **전체 스위트가 그걸 조용히
건너뛰었다.** 개수만 보고 있었으면 눈치채지 못했을 것이다 — 실패가 아니라 침묵이라
에러도 안 난다.

이 테스트는 그 침묵을 실패로 바꾼다.
"""
from __future__ import annotations

import pathlib
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _configured_testpaths() -> set[str]:
    cfg = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return set(cfg["tool"]["pytest"]["ini_options"]["testpaths"])


def _actual_test_dirs() -> set[str]:
    out = set()
    for d in ROOT.rglob("tests"):
        if not d.is_dir():
            continue
        rel = d.relative_to(ROOT).as_posix()
        if rel.startswith((".venv", "build", "dist")) or "__pycache__" in rel:
            continue
        if not any(d.glob("test_*.py")):
            continue          # 비어 있으면 아직 등록할 이유가 없다
        out.add(rel)
    return out


def test_testpaths_cover_every_test_dir() -> None:
    configured, actual = _configured_testpaths(), _actual_test_dirs()
    missing = sorted(actual - configured)
    assert not missing, (
        f"tests 디렉터리가 testpaths 에 없다: {missing}. "
        "pyproject.toml 의 testpaths 에 추가하라 — 빠지면 그 테스트는 실패가 아니라 "
        "**침묵**한다."
    )


def test_configured_testpaths_all_exist() -> None:
    """죽은 경로가 남아 있으면 pytest 가 경고만 내고 넘어간다."""
    gone = sorted(p for p in _configured_testpaths() if not (ROOT / p).is_dir())
    assert not gone, f"testpaths 에 존재하지 않는 경로: {gone}"
