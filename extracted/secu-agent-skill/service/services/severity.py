"""심각도 어휘 — 정본 5단계와, 정당하게 다른 확장 어휘들.

## 왜 모았나 (실측 2026-08-24)

**같은 것이 복사돼 있었다:**
- `state_domain.py` 에 랭크맵 **4벌**(`_DEV_WEB_SEV_RANK`·`_GITHUB_SEV_RANK`·
  `_CONFLUENCE_SEV_RANK`·`_SMB_SEV_RANK`) — 내용 완전 동일. 병합 한 줄짜리도 4벌.
- `scanner.py` 안에 같은 맵이 인라인으로 한 번 더.

**반면 다음 셋은 다른 축이라 합치면 틀린다:**
- `shares._VALID_SEVERITY` 의 `none` — 공유 단위 "문제 없음". finding 심각도가 아니다.
- `master_tools._MEM_SEVERITY` 의 `clean` — 운영자가 남기는 메모 룰의 "깨끗함" 판정.
- `github_scan._BUMP` — 탐지기 kind 별 승급 사다리(4단계). `_SEVERITY` 가 낼 수 있는 값이
  critical/high/medium 뿐이라 닫혀 있고, 도메인 어휘와 목적이 다르다. 여기로 끌어오지 마라.

그래서 **합치지 않고 나란히 둔다.** `LEVELS` 를 정본으로 두고 확장은 그것을 기반으로 선언해,
갈라지면 눈에 보이고 테스트가 잡게 한다.
"""
from __future__ import annotations

from typing import Any

#: 정본 5단계 — **표시 순서(높은 것부터)**. 목록·표의 정렬 기준으로 그대로 쓴다.
LEVELS: tuple[str, ...] = ("critical", "high", "medium", "low", "informational")

#: 비교용 순위. informational=0 … critical=4.
#: ⚠️ 미지의 값은 `rank()` 가 0 으로 떨어뜨린다 — **가장 낮게** 본다.
#: 모르는 값을 높게 보면 오탐 하나가 전체 우선순위를 흔든다.
RANK: dict[str, int] = {name: i for i, name in enumerate(reversed(LEVELS))}

#: "조치가 필요한 것" — 통보·집계의 대상. low/informational 은 기록만 한다.
ISSUE_LEVELS: frozenset[str] = frozenset({"critical", "high", "medium"})

#: 공유(share) 단위 어휘 — 문제 없음을 표현하는 `none` 이 더 있다.
SHARE_LEVELS: frozenset[str] = frozenset(LEVELS) | {"none"}

#: 운영자 메모 룰 어휘 — "이 호스트는 깨끗하다" 를 남길 수 있어야 해서 `clean` 이 더 있다.
#: ⚠️ `master_tools`/`inspect_tools` 의 `Literal[...]` 은 타입이라 import 로 대체할 수 없다.
#:    대신 테스트가 이 집합과 일치하는지 대조한다.
MEMORY_LEVELS: frozenset[str] = frozenset(LEVELS) | {"clean"}


def normalize(value: Any) -> str | None:
    """소문자·공백 정리 후 정본 어휘에 있으면 반환, 아니면 None."""
    name = str(value or "").strip().lower()
    return name if name in RANK else None


def rank(value: Any) -> int:
    """비교용 순위. 미지의 값은 0(가장 낮음)."""
    return RANK.get(str(value or "").strip().lower(), 0)


def merge(a: Any, b: Any) -> Any:
    """두 심각도 중 **높은 쪽**. 스레드에 finding 이 여러 개 붙을 때 쓴다.

    ⚠️ 원본 값을 그대로 돌려준다(정규화하지 않는다) — 기존 4벌의 동작이 그랬고,
    호출부가 DB 에 그대로 넣기 때문에 여기서 값을 바꾸면 저장값이 달라진다.
    """
    return a if rank(a) >= rank(b) else b


def is_issue(value: Any) -> bool:
    """통보·집계 대상인가."""
    return str(value or "").strip().lower() in ISSUE_LEVELS
