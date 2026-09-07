"""리드는 한 라운드로 끝내지 않는다 (2026-08-27).

## 무엇이 있었나

큐가 밀려 있는데 리드가 턴을 남기고 스스로 끝냈다. smb 리드 실측:

    turn 1~3  list_targets ×5        ← 같은 걸 다섯 번
    turn 4~5  타깃 3개 조사
    turn 6    open_inspection ×2     ← 세션 상한(기본 2)
    turn 8    close_inspection ×1
    turn 9    set_target_status ×1 → 종료

    turns_used 9 / 40 · reason=end_turn · 큐에 밀린 타깃 215건

벽시계·토큰 상한도 오늘 풀었다. **멈출 이유가 없었는데 멈췄다.**

## 왜 이게 산출물 부족의 원인인가

    smb share  244건(print$ 제외) 중 처리된 것 29건 = 12%
    그 29건에서 hits 11 → finding 2

탐지가 안 되는 게 아니라 **아직 12%만 봤다.** 한 패스에 1~2개씩이면 215건에 32시간이다.

## 왜 워커를 늘리는 게 답이 아닌가

실측: CPU 120코어에 load 6.7, 에이전트 프로세스 CPU 0.0%(LLM 응답 대기).
로컬은 놀고 있고 병목은 **LLM 백엔드**다. 세션을 늘리면 그 경합이 늘어나는데,
오늘 검토원 7/7 이 죽은 원인이 바로 그 경합이었다. 공짜인 것부터 고친다.

## 되돌아가기 쉬운 이유

큐가 짧은 날에는 한 라운드로도 큐가 비어서 증상이 안 보인다. 그래서 "한 번 돌고
끝내는" 것이 자연스러워 보이고, 큐가 쌓이는 날 조용히 12%만 처리한다.
"""
from __future__ import annotations

from pathlib import Path

from _shared.tests import _lead_procedure

_LEAD_MD = Path(__file__).resolve().parents[1] / "skills" / "lead" / "lead.md"


def _procedure() -> str:
    """계약이 실제로 만들어 내는 유저 메시지. skip 하지 않는다.

    ★ `build_user_message()` 는 `register_all()` 을 부른다 — 서브프로세스에서 뽑는
      이유와 사고 기록은 `_lead_procedure` 모듈 주석에 한 번만 적혀 있다.
    """
    return _lead_procedure.procedure()


def test_the_procedure_tells_it_to_take_the_next_target():
    proc = _procedure()
    assert "다음 타깃으로 간다" in proc, "닫은 뒤 계속하라는 지시가 없다"
    assert "큐가 비거나 턴이 다할 때까지" in proc, "언제까지 도는지가 없다"


def test_the_session_cap_is_explained_as_concurrency_not_total():
    """★ 이 오해가 핵심이다.

    세션 상한 2 를 "이번 런에 2개만 본다" 로 읽으면 한 패스에 2개가 천장이 된다.
    실제로는 동시 개수 제한이라, 닫으면 그 자리를 다시 쓸 수 있다.
    """
    proc = _procedure()
    assert "동시 개수 제한이지 총 개수 제한이 아니다" in proc, "상한의 의미가 안 적혀 있다"

    md = _LEAD_MD.read_text(encoding="utf-8")
    assert "동시 개수 제한이지 총 개수 제한이 아니다" in md, "계약 본문에도 있어야 한다"


def test_lead_md_says_what_it_cost():
    """금지·지시만 하면 다음 사람이 되돌린다 — 실측 대가를 함께 둔다."""
    md = _LEAD_MD.read_text(encoding="utf-8")
    tail = md[md.index("## 한 라운드로 끝내지 마라"):][:1200]
    assert "9 / 40" in tail, "턴을 얼마나 남겼는지가 없다"
    assert "215" in tail, "큐에 얼마나 밀려 있었는지가 없다"


def test_repeated_list_targets_is_called_out():
    """같은 조회를 반복하면 턴만 먹는다 — 큐는 자기가 닫기 전엔 안 변한다."""
    md = _LEAD_MD.read_text(encoding="utf-8")
    assert "`list_targets` 를 반복해서 부르지 마라" in md


def test_the_two_documents_agree():
    """★ 유저 메시지와 계약 본문이 어긋나면 유저 메시지가 이긴다.

    `lead_contract.py` 주석이 못박은 함정 — 한쪽만 고치면 나중에 읽히는 쪽이
    옛 지시를 계속 준다.
    """
    proc, md = _procedure(), _LEAD_MD.read_text(encoding="utf-8")
    for claim in ("다음 타깃", "동시 개수 제한"):
        assert claim in proc and claim in md, f"{claim!r} 이 한쪽에만 있다"
