"""리드 유저 메시지가 **실제로 등록된 도구**를 지시하는가.

## 왜 별도 테스트인가

리드는 지시서를 두 장 받는다:

    시스템 프롬프트   `_shared/skills/lead/lead.md`   "너는 이런 사람이다"
    유저 메시지       `lead_contract._user_message`   "지금 이걸 해라"

둘이 다른 말을 하면 **유저 메시지가 이긴다** — 나중에 읽히는 '이번 작업 지시'라
모델이 더 무겁게 받는다. 그런데 새 기능이 들어올 때 고쳐지는 건 대개 계약 본문 쪽이다.

실제로 두 번 데였다:

1. 2026-08-21 (`eaf6c87`) — 계약 본문에 세션 섹션을 넣으며 옛 단발 섹션을 안 지웠다.
   리드가 둘 다 읽고 **단발을 골랐다.** 그때는 본문만 정리했다.
2. 2026-08-26 — 같은 함정이 **유저 메시지**에 그대로 남아 있었다(절차 3 =
   `delegate_inspect`). 실기동에서 codex 가 무시하고 세션을 골라 드러나지 않았을 뿐이고,
   작은 모델이면 지시대로 단발로 갔을 것이다.

그래서 여기서 고정한다: **유저 메시지가 지시하는 도구는 그 런에 실제로 등록된 것이어야 한다.**
"""
from __future__ import annotations

import pytest

from _shared.tests import _lead_procedure

_SPEC = {"charter_ref": "SECOPS-TEST", "target": {"target_ids": [1]}}
_SESSION_TOOLS = ("open_inspection", "ask_inspector", "close_inspection")


@pytest.fixture
def user_message():
    """`build_lead_contract` 가 만든 유저 메시지 — smb 어댑터 기준.

    ★ 서브프로세스에서 뽑는다. 이유는 `_lead_procedure` 모듈 주석에 한 번만 적혀 있다
      (예전엔 이 자리에 "register_all 은 부르지 않는다" 고 적혀 있었고, 틀린 말이었다).
    """
    def _build(*, sessions: bool) -> str:
        return _lead_procedure.procedure(_SPEC, sessions=sessions)

    return _build


def test_session_run_directs_the_lead_at_session_tools(user_message):
    """세션이 켜져 있으면 절차가 세션을 지시해야 한다."""
    msg = user_message(sessions=True)
    for name in _SESSION_TOOLS:
        assert name in msg, f"세션 런인데 유저 메시지가 {name} 을 안 가르친다"


def test_session_run_does_not_prescribe_the_oneshot_path(user_message):
    """★ 세션 런의 절차가 `delegate_inspect` 를 **처방**하면 안 된다.

    도구 자체는 롤백 경로로 남아 있다(등록은 되어 있다). 문제는 유저 메시지가 그걸
    기본 절차로 지시하는 것이다 — 계약 본문은 정확히 반대를 말한다.
    """
    msg = user_message(sessions=True)
    for line in msg.splitlines():
        if line.strip().startswith(("1.", "2.", "3.", "4.", "5.")):
            assert "delegate_inspect" not in line, (
                f"세션 런의 절차가 단발 위임을 지시한다: {line!r}")


def test_rollback_run_directs_the_lead_at_the_oneshot_path(user_message):
    """★ 도구면이 바뀌면 지시도 같이 바뀐다.

    `SA_LEAD_SESSIONS=0` 이면 세션 도구가 **아예 등록되지 않는다**. 그 런에서
    `open_inspection` 을 지시하면 리드가 없는 도구를 부르며 턴을 버린다
    (2026-08-21 A/B 에서 `open_inspection: err:not_found` 가 두 번 났다).
    """
    msg = user_message(sessions=False)
    assert "delegate_inspect" in msg
    for line in msg.splitlines():
        if line.strip().startswith("3."):
            for name in _SESSION_TOOLS:
                assert name not in line, (
                    f"세션이 꺼진 런인데 절차가 {name} 을 지시한다: {line!r}")


def test_procedure_three_is_findable(user_message):
    """절차 3을 접두어로 찾는 분기가 계속 성립하는가 — 못 찾으면 롤백 지시가 안 바뀐다."""
    msg = user_message(sessions=True)
    threes = [ln for ln in msg.splitlines() if ln.strip().startswith("3. ")]
    assert len(threes) == 1, f"절차 3이 {len(threes)}개다 — 롤백 분기가 조용히 깨진다"
