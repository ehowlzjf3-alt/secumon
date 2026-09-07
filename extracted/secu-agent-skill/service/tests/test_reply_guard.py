"""회신 안전장치 — 하지 않은 검증을 했다고 말하지 않는다. 4도메인 동일.

## 왜

`smb_build_reply(reply_kind='not_fixed')` 는 재검증 결과가 없으면 **저장된 지난 스캔**
으로 폴백해 표를 채우는데, 본문은 어느 쪽이든 "재점검한 결과 …" 라고 쓴다. 담당자가
실제로 조치를 마쳤어도 지난 스캔엔 열려 있으므로 "아직 안 됐다" 고 잘못 답한다.

⚠️ 이건 아직 일어난 적 없다(2026-08-31 확인 — 내가 한 번 오진했다). 그래도 막는 이유는
   워커 프롬프트의 "반드시 재검증" 이 **부탁일 뿐 강제가 아니기** 때문이다.
   부탁으로 지켜지는 불변식은 언젠가 깨지고, 깨져도 메일은 그럴듯하게 나간다.
"""
from __future__ import annotations

import pytest

from _shared.reply_guard import (
    STATE_ASSERTING_KINDS, asserts_current_state, check_state_assertion,
    fresh_recheck_records,
)


class _FakeAdapter:
    def __init__(self, rows):
        self.domain = "smb"
        self.recheck_records = (lambda tid: list(rows)) if rows is not None else None


@pytest.fixture
def adapter(monkeypatch):
    import _shared.thread_adapter as ta

    def _install(rows, domain="smb"):
        a = _FakeAdapter(rows)
        a.domain = domain
        monkeypatch.setitem(ta._ADAPTERS, domain, a)
    return _install


@pytest.mark.parametrize("kind", sorted(STATE_ASSERTING_KINDS))
def test_state_asserting_kinds_are_recognised(kind: str) -> None:
    assert asserts_current_state(kind)


@pytest.mark.parametrize("kind", ["how_to", "", "question", "general"])
def test_non_asserting_kinds_pass_through(kind: str, adapter) -> None:
    """방법 안내는 '지금 어떤 상태다' 를 말하지 않으므로 재검증이 필요 없다."""
    adapter([])
    assert check_state_assertion("smb", 1, kind) is None


def test_refuses_when_no_record(adapter) -> None:
    adapter([])
    msg = check_state_assertion("smb", 1, "not_fixed")
    assert msg and "재검증 기록이 없다" in msg


def test_allows_when_record_exists(adapter) -> None:
    adapter([{"created_at": 100.0, "verdict": "still_open"}])
    assert check_state_assertion("smb", 1, "not_fixed") is None


def test_stale_record_does_not_count(adapter) -> None:
    """★ 지난주 재검증으로 이번 주 주장을 확인해 줄 수 없다."""
    adapter([{"created_at": 100.0, "verdict": "still_open"}])
    assert check_state_assertion("smb", 1, "confirmed", after=200.0) is not None
    assert check_state_assertion("smb", 1, "confirmed", after=50.0) is None


def test_unresolvable_adapter_refuses_rather_than_assuming(monkeypatch) -> None:
    """어댑터를 못 구하면 '기록 없음' 이 아니라 **확인 불가**다 — 통과시키면 안 된다.

    ⚠️ 등록돼 있지 않으면 게이트가 **자기가 등록한다**(`_ensure_adapter`) — 도구 단위
       테스트나 부트스트랩 실패 런타임에서 정당한 회신까지 막히면 안 되기 때문이다.
       그래서 "등록 안 됨" 이 아니라 "등록할 방법이 없는 도메인" 으로 확인한다.
    """
    import _shared.thread_adapter as ta

    monkeypatch.setattr(ta, "_ADAPTERS", {})
    msg = check_state_assertion("web", 1, "not_fixed")   # 팩토리가 없는 도메인
    assert msg and "어댑터가 등록되지 않아" in msg


def test_unwired_recheck_slot_refuses(adapter) -> None:
    """조회가 배선되지 않은 도메인도 단언형 회신은 못 만든다."""
    adapter(None)
    msg = check_state_assertion("smb", 1, "still_exposed")
    assert msg and "배선되지 않았다" in msg


def test_refusal_tells_the_worker_what_to_do(adapter) -> None:
    """거부 사유가 행동을 지시하지 않으면 워커가 재시도할 근거가 없다."""
    adapter([])
    msg = check_state_assertion("smb", 1, "not_fixed", verify_hint="smb_reverify_walk 를 돌려라")
    assert "smb_reverify_walk 를 돌려라" in msg
    assert "방법 안내나 일반 답변" in msg, "막기만 하고 대안을 안 주면 워커가 멈춘다"


def test_query_failure_is_not_treated_as_a_record(monkeypatch) -> None:
    """조회가 터지면 '기록 있음' 으로 넘어가면 안 된다."""
    import _shared.thread_adapter as ta

    class _Boom:
        domain = "smb"
        def recheck_records(self, tid):
            raise RuntimeError("DB down")

    monkeypatch.setitem(ta._ADAPTERS, "smb", _Boom())
    assert fresh_recheck_records("smb", 1) == []
    assert check_state_assertion("smb", 1, "not_fixed") is not None


def test_담당자가_아니라는_답장에_조치를_요구하지_않는다():
    """★ 2026-09-01 사고. 성예찬님이 "난생 처음 보는 주소인데.. 입사하기 전에
    만들어졌던데" 라고 답했는데, 워커가 `how_to 질문` 으로 분류하고 답장했다 —
    "입사 전 폴더라 하더라도 … 삭제해 주시기 바랍니다" 가 나갔다.

    프롬프트에 규칙은 **이미 있었다**("담당자가 아니라고 하면 기록만 하고 멈춘다").
    부탁으로 지켜지는 불변식은 언젠가 깨지고, 깨져도 조용하다. 코드가 막는다.

    ⚠️ 막는 쪽이 안전하다. 오탐이면 사람이 HITL 에서 풀면 되지만, 놓치면 엉뚱한 사람에게
       조치를 요구하는 메일이 나간다 — 회수할 수 없다.
    """
    from _shared.reply_guard import check_owner_dispute

    text = "난생 처음보는 주소인데.. 특정 폴더는 제가 입사하기전에 만들어졌던데"

    assert check_owner_dispute("how_to", text)          # 조치 요구 → 막는다
    assert check_owner_dispute("not_fixed", text)
    assert check_owner_dispute("confirmed", text) is None   # 감사 인사는 막지 않는다
    assert check_owner_dispute("how_to", "삭제했습니다") is None


def test_인용된_원문은_판정에서_뺀다():
    """⚠️ 우리가 보낸 원문이 인용으로 딸려 온다. 거기 우리 문장이 걸리면 **모든 답장이**
    담당자 분쟁으로 오판된다."""
    from _shared.reply_guard import looks_like_not_owner

    body = ("조치 완료했습니다.\n"
            "--------- Original Message ---------\n"
            "담당자가 아니시면 회신 주세요")

    assert looks_like_not_owner(body) is False


def test_회신을_만드는_도구가_전부_가드를_지난다():
    """★ 2026-09-01 사고 두 번. 가드를 `smb_build_reply` 에만 걸었더니 워커가 **공용
    도구**(`ticket_reply_compose`)로 답장을 보냈다(09:48). 하나에만 걸면 나머지로 샌다.

    회신을 만드는 도구는 셋이다 — 공용 · smb · dev_web. **세어서** 전부 확인한다.
    함수만 만들고 호출부를 안 잇는 이 저장소의 단골 형태를 여기서 막는다.
    """
    import inspect
    from pathlib import Path

    composers = {
        "_shared/reply_tools.py": "compose_reply",
        "domains/smb/plugin/tools/smb_reply_tools.py": "SmbBuildReplyTool",
        "domains/dev_web/plugin/tools/dev_web_reply_tools.py": "DevWebBuildReplyTool",
    }
    for rel in composers:
        src = Path(rel).read_text(encoding="utf-8")
        assert "check_owner_dispute" in src, f"{rel} 에 담당자 분쟁 가드가 없다"
    del inspect
