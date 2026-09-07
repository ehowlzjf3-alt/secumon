"""검토원 idle 예산은 **LLM 클라이언트 타임아웃보다 커야 한다** (2026-08-27).

## 무엇이 있었나

검토원이 죽는 이유가 예산 부족이 아니라 **순서 역전**이었다. 실측:

    LLM 클라이언트 timeout   300s   (config/llm_profiles.yaml)
    검토원 idle 예산         300s   (도메인 inspect_contract)
    실제 사망                300.3s · 300.3 · 300.4 · 300.3 · 300.3

    github     검토원 idle 사망  7/7   (100%)
    confluence                  10/38  (26%)
    dev_web                      0/4

두 숫자가 같으면 워치독이 `idle_check_interval_sec=1.0` 만큼 늦게, 그러나 **먼저**
이긴다. 호출은 아직 살아 있는데 런이 죽고, 검토원은 `report_inspection` 을 못 부른다.
그 위에서 리드는 "검사가 미완이라 닫을 수 없다" 고 옳게 판단해 큐를 안 닫았다 —
즉 이 한 줄이 github 리드가 0건을 닫은 근본 원인이었다.

## 왜 크게 두면 되나

클라이언트 타임아웃은 **관측 가능한 사건**이다. 터지면 `stream_error → LoopError` 가
나오고 하네스가 `activity.touch(ev.type)` 로 시계를 되돌린다. 워치독이 조금만 늦으면
개입할 필요가 없다 — 클라이언트가 먼저 말한다.

그래서 워치독이 제 역할을 찾는다: **클라이언트조차 아무 말이 없는 진짜 죽음**만 잡는다.

## 이 파일이 막는 것

프로파일 timeout 을 올렸는데 idle 예산을 안 올리는 것. 그러면 조용히 예전 상태로
돌아가고, 증상은 "검토원이 이유 없이 죽는다" 로만 보인다.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from _shared.inspect_contract import INSPECTOR_IDLE_SEC_DEFAULT

_PROFILES = Path(
    os.environ.get("SA_ENGINE_DIR", str(Path.home() / "project" / "secu-agent"))
) / "config" / "llm_profiles.yaml"

_INSPECT_CONTRACTS = (
    "domains/dev_web/plugin/inspect_contract.py",
    "domains/smb/plugin/inspect_contract.py",
    "domains/services/confluence/plugin/inspect_contract.py",
    "domains/services/github/plugin/inspect_contract.py",
)
_REPO = Path(__file__).resolve().parents[2]


def _profile_timeouts() -> list[int]:
    if not _PROFILES.exists():
        pytest.skip(f"프로파일 파일 없음: {_PROFILES}")
    text = _PROFILES.read_text(encoding="utf-8")
    return [int(m) for m in re.findall(r"^\s*timeout:\s*(\d+)\s*$", text, re.M)]


def test_idle_budget_exceeds_every_client_timeout():
    """★ 불변식. 하나라도 넘으면 그 프로파일을 쓰는 검토원이 살아서 죽는다."""
    timeouts = _profile_timeouts()
    assert timeouts, "프로파일에서 timeout 을 하나도 못 읽었다 — 파서가 깨졌다"
    worst = max(timeouts)
    assert INSPECTOR_IDLE_SEC_DEFAULT > worst, (
        f"idle 예산 {INSPECTOR_IDLE_SEC_DEFAULT}s 가 제일 큰 클라이언트 timeout "
        f"{worst}s 이하다 — 이 조합에서 워치독이 **살아 있는 검토원을** 죽인다. "
        f"프로파일 timeout 을 올렸으면 INSPECTOR_IDLE_SEC_DEFAULT 도 올려라.")


def test_the_gap_is_not_razor_thin():
    """동률이 사고였다 — 여유가 없으면 같은 일이 반올림으로 다시 난다.

    실측 사망은 300.34s 였다(예산 300s + `idle_check_interval_sec` 1.0s).
    """
    worst = max(_profile_timeouts())
    assert INSPECTOR_IDLE_SEC_DEFAULT - worst >= 60, (
        f"여유 {INSPECTOR_IDLE_SEC_DEFAULT - worst}s 는 너무 얇다 (최소 60s)")


@pytest.mark.parametrize("rel", _INSPECT_CONTRACTS)
def test_every_inspector_uses_the_shared_default(rel):
    """★ 숫자를 도메인마다 따로 적으면 하나가 뒤처진다.

    실제로 네 도메인이 전부 `300` 을 **각자** 적고 있었다. 한 곳만 고치면 나머지 셋은
    조용히 옛 값으로 남는다 — 그게 이 사고가 도메인별로 다르게 보인 이유다.
    """
    src = (_REPO / rel).read_text(encoding="utf-8")
    assert "default_idle_sec=INSPECTOR_IDLE_SEC_DEFAULT" in src, f"{rel}: 공유 기본값을 안 쓴다"
    assert not re.search(r"default_idle_sec=\d+", src), f"{rel}: 숫자를 직접 적었다"


def test_the_env_override_still_works():
    """운영이 급할 때 환경변수로 덮을 수 있어야 한다 — 코드 배포를 기다리지 않게."""
    import inspect

    from _shared import inspect_contract

    src = inspect.getsource(inspect_contract.build_inspect_contract)
    assert '_MAX_IDLE_SEC' in src, "환경변수 오버라이드 경로가 사라졌다"
