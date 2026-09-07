"""심각도 어휘 계약 — 정본 5단계와 확장 어휘의 관계를 고정한다.

같은 랭크맵이 state_domain 에 4벌, scanner 에 1벌 있었다. 반면 `none`·`clean` 은
다른 축이라 합치면 틀린다. 이 파일은 "무엇이 같고 무엇이 다른지" 를 못박는다.
"""
from __future__ import annotations

import pytest

from service.services import severity as sv


def test_정본은_5단계이고_표시_순서다():
    assert sv.LEVELS == ("critical", "high", "medium", "low", "informational")


def test_랭크는_informational_0_에서_critical_4():
    assert sv.RANK == {
        "informational": 0, "low": 1, "medium": 2, "high": 3, "critical": 4,
    }


def test_모르는_값은_가장_낮게_본다():
    """★ 높게 보면 오탐 하나가 전체 우선순위를 흔든다."""
    assert sv.rank("bogus") == 0
    assert sv.rank(None) == 0
    assert sv.rank("") == 0
    assert sv.normalize("bogus") is None


def test_병합은_높은_쪽을_고르고_원본을_그대로_돌려준다():
    assert sv.merge("high", "critical") == "critical"
    assert sv.merge("critical", "high") == "critical"
    # ⚠️ 정규화하지 않는다 — 호출부가 DB 에 그대로 넣으므로 값이 바뀌면 저장값이 달라진다.
    assert sv.merge("HIGH", "low") == "HIGH"
    assert sv.merge("low", None) == "low"
    assert sv.merge(None, None) is None


def test_동점이면_앞을_유지한다():
    # 기존 4벌이 `>=` 였다. 순서가 안정적이어야 재실행 결과가 흔들리지 않는다.
    assert sv.merge("high", "high") == "high"


def test_조치_대상은_상위_3단계():
    assert sv.ISSUE_LEVELS == {"critical", "high", "medium"}
    assert sv.is_issue("HIGH") is True
    assert sv.is_issue("low") is False
    assert sv.is_issue(None) is False


# ── 확장 어휘 — 합치지 않고 나란히 ────────────────────────────────────────────
def test_확장_어휘는_정본을_전부_포함한다():
    assert set(sv.LEVELS) < sv.SHARE_LEVELS
    assert set(sv.LEVELS) < sv.MEMORY_LEVELS


def test_확장분은_서로_섞이지_않는다():
    # none(공유 단위 "문제 없음")과 clean(운영자 메모 판정)은 다른 축이다.
    assert "none" in sv.SHARE_LEVELS and "none" not in sv.MEMORY_LEVELS
    assert "clean" in sv.MEMORY_LEVELS and "clean" not in sv.SHARE_LEVELS
    # 정본에는 둘 다 없다 — finding 심각도가 아니다.
    assert "none" not in sv.LEVELS and "clean" not in sv.LEVELS


def test_운영자_메모_Literal_이_SSOT_와_어긋나지_않는다():
    """`Literal[...]` 은 타입이라 import 로 대체할 수 없다 — 대신 대조한다.

    이게 없으면 한쪽만 값을 추가해도 아무도 모른다(담당자 키 목록이 그랬다).
    """
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    # ⚠️ 같은 어휘인데 이름이 다르다 — master 는 _MEM_SEVERITY, inspect 는 _INSPECT_SEVERITY.
    #    이름이 다르면 grep 으로도 안 묶이니 여기서 둘 다 본다.
    for rel, name in (("domains/smb/plugin/tools/master_tools.py", "_MEM_SEVERITY"),
                      ("domains/smb/plugin/tools/inspect_tools.py", "_INSPECT_SEVERITY")):
        src = (root / rel).read_text(encoding="utf-8")
        m = re.search(rf"{name} = Literal\[(.*?)\]", src, re.S)
        assert m, rel
        declared = set(re.findall(r'"(\w+)"', m.group(1)))
        assert declared == sv.MEMORY_LEVELS, (rel, declared ^ sv.MEMORY_LEVELS)


def test_탐지기_승급_사다리는_여기로_끌어오지_않는다():
    """github_scan._BUMP 는 kind 별 승급용이고 _SEVERITY 값에 대해 닫혀 있다.

    도메인 5단계와 목적이 달라 통합 대상이 아니다 — 그 사실을 테스트로 남긴다.
    (옆에 있던 _ORDER 는 사용처가 0이라 제거했다.)
    """
    from domains.services.github.plugin.agent_types import github_scan as gs

    assert not hasattr(gs, "_ORDER")
    producible = set(gs._SEVERITY.values())
    assert producible <= set(gs._BUMP), "승급 사다리가 열려 있으면 KeyError 가 난다"
