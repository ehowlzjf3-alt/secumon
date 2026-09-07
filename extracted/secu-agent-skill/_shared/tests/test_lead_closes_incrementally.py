"""리드는 타깃을 **하나씩** 닫는다 — 끝에 몰아 닫으면 예산이 다 가져간다 (2026-08-26).

## 무엇이 있었나

github 리드 실기동:

    15턴 · 1800s(벽시계 만료) · 166k 토큰 · **닫은 타깃 0건**
    budget_trip: kind=wall_clock, elapsed_sec=1800.8, limit_sec=1800
    검토원 세션 4개도 같이 잘려 finding 제출 0건

30분과 166k 토큰을 쓰고 아무것도 남기지 못했다.

## 왜 github 만이 아닌가

네 도메인 전부 **마지막 턴에 몰아서** 닫고 있었다:

    smb         10턴 → 마지막 턴에 close 2건
    confluence  11턴 → 마지막 턴에 close 4건
    dev_web       ?턴 → 마지막 턴에 close 3건
    github      15턴 → 마지막 턴에 **도달 못 함** → 0건

github 은 ask 가 느려서 먼저 걸렸을 뿐이다. all-or-nothing 구조 자체가 결함이다.

## 프롬프트가 시킨 일이었다

    lead_contract  "5. 타깃을 다 본 뒤 set_target_status 로 …"
    lead.md        "타깃을 다 본 뒤 **네가** set_target_status 로 닫아라."

한국어로 "타깃을 다 본 뒤" 는 '그 타깃' 으로도 '모든 타깃' 으로도 읽힌다.
실기동 4건이 전부 후자로 읽었다. 모호함을 없애는 것이 고침이다.

## 왜 되돌아갈 수 있나

예산이 넉넉한 날에는 몰아 닫아도 멀쩡히 돌아간다 — 증상이 안 보인다. 그래서
"정리해서 마지막에 한 번" 이 다시 자연스러워 보이고, 큐가 커지는 날 조용히 죽는다.
"""
from __future__ import annotations

from pathlib import Path

from _shared.tests import _lead_procedure

_LEAD_MD = Path(__file__).resolve().parents[1] / "skills" / "lead" / "lead.md"


def _procedure() -> str:
    """계약이 실제로 만들어 내는 유저 메시지(절차).

    ★ `build_user_message()` 는 `register_all()` 을 부른다 — 이 프로세스에서 부르면
      pii/secret 판정기와 `dev_web` 브라우저 검증 게이트가 켜진 채 남아 남의 테스트를
      깨뜨린다. 사유와 격리 방법은 `_lead_procedure` 한 곳에 적혀 있다.
    """
    return _lead_procedure.procedure()


def test_lead_md_tells_it_to_close_one_at_a_time():
    t = _LEAD_MD.read_text(encoding="utf-8")
    assert "그 자리에서 닫아라" in t, "하나씩 닫으라는 지시가 없다"
    assert "몰아서 닫지 마라" in t, "몰아 닫기 금지가 없다"


def test_lead_md_says_why_not_just_what():
    """금지만 하면 다음 사람이 '정리해서 한 번에' 로 되돌린다 — 대가를 함께 적는다."""
    t = _LEAD_MD.read_text(encoding="utf-8")
    tail = t[t.index("그 자리에서 닫아라"):][:900]
    assert "턴 중간에 잘린다" in tail, "왜 마무리 기회가 없는지가 없다"
    assert "0건" in tail, "실제로 무엇을 잃었는지가 없다"


def test_lead_md_no_longer_says_close_after_seeing_all():
    """★ 옛 문장이 남아 있으면 새 지시와 **모순**이다 — 모델은 둘 다 읽는다."""
    t = _LEAD_MD.read_text(encoding="utf-8")
    assert "타깃을 다 본 뒤 **네가**" not in t, "옛 일괄-닫기 지시가 남아 있다"


def test_the_procedure_agrees_with_the_contract_body():
    """★ 유저 메시지와 계약 본문은 **같이** 움직여야 한다.

    `lead_contract.py:143` 주석이 못박은 함정이다 — 한쪽만 고치면 유저 메시지가
    (더 늦게 읽혀 더 무겁게 받는 쪽이) 옛 지시를 계속 준다.
    """
    proc = _procedure()
    assert "그 자리에서" in proc, "절차가 아직 일괄 닫기를 지시한다"
    assert "몰아서 닫지 마라" in proc
    assert "타깃을 다 본 뒤 set_target_status" not in proc, "옛 문장이 남아 있다"


def test_the_procedure_still_keeps_queue_ownership_with_the_lead():
    """닫기 시점을 바꾸는 것이지 **누가 닫느냐**를 바꾸는 게 아니다."""
    proc = _procedure()
    assert "검토원은 위임받았을 때 큐를 닫지 않는다" in proc
