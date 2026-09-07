"""회신 매칭 통일 규칙 — 1차 티켓번호 / 2차 제목 태그.

## 왜

사용자 지시(2026-08-31): *"이건 최초에 SMB 기준으로는 헤더+ip기준으로 정했었는데
다른 도메인 기준으로는 우리가 정한 적이없어서 이것도 정해야 돼" / "이것도 마찬가지로
통일된걸로!"*

정하고 보니 셋은 **구조적으로 답장을 받을 수 없는** 상태였다. 여기서 고정하는 것은
그 셋의 회귀다 — 조용히 되돌아가면 아무도 못 잡는다(답장이 안 붙어도 로그가 안 난다).
"""
from __future__ import annotations

import pytest

import service.state_domain as state
from _shared.ticket_id import parse_ticket, stamp_subject


class TestSubjectStamp:
    @pytest.mark.parametrize("domain,tid,base", [
        ("smb", 24, "[보안취약점 조치요청](10.125.102.246) 공유폴더 접근권한 관리"),
        ("github", 552, "[GitHub 보안취약점 조치요청](RTPMS/delaylotautonomous)"),
        ("confluence", 41, "[Confluence 보안취약점 조치요청](DSCERT)"),
        ("dev_web", 123, "[Dev Web 보안취약점 조치요청](site.cdep.samsungds.net)"),
    ])
    def test_stamp_keeps_the_old_tag_for_fallback(self, domain, tid, base) -> None:
        """★ 태그를 지우면 이미 나간 메일의 답장이 전부 미아가 된다.

        2026-08-31 형식: `[보안취약점 조치요청](SMB00024)(10.125.102.246) …`
        티켓 괄호가 태그 **바로 뒤**에 오므로, 수집기 정규식이 그 그룹을 건너뛰고
        좌표를 잡아야 한다. 안 그러면 좌표가 티켓 번호로 바뀌어 폴백이 통째로 깨진다.
        """
        from _shared.ticket_id import ticket_no
        from service.collector.mail_inbound import classify_subject_tag_from_subject

        stamped = stamp_subject(base, domain, tid)
        assert parse_ticket(stamped) == (domain, tid)
        got = classify_subject_tag_from_subject(stamped)
        assert got is not None and got[0] == domain, "스탬프가 기존 태그 인식을 깨뜨렸다"
        assert ticket_no(domain, tid) not in got[1], (
            f"좌표에 티켓 번호가 섞였다: {got[1]!r} — 폴백이 스레드를 못 찾는다")
        # 옛 형식(티켓 없음)도 그대로 매칭돼야 한다 — 아직 답장이 돌아온다.
        plain = classify_subject_tag_from_subject(f"RE: {base}")
        assert plain is not None and plain[0] == domain

    def test_stamp_is_idempotent(self) -> None:
        once = stamp_subject("제목", "smb", 24)
        assert stamp_subject(once, "smb", 24) == once

    def test_reply_prefixes_pile_up_in_front_and_ticket_survives(self) -> None:
        s = stamp_subject("[보안취약점 조치요청](1.2.3.4)", "smb", 24)
        for prefix in ("RE: ", "RE:(3) ", "FW: ", "答复: "):
            assert parse_ticket(prefix + s) == ("smb", 24)


class TestPerDomainMatchStatuses:
    def test_dev_web_is_routed_at_all(self) -> None:
        """★ `_service_report_table` 이 dev_web 을 몰라 **ValueError 를 던졌다.**

        dev_web 담당자가 답장하면 POP3 수집기가 그 자리에서 죽는다.
        """
        assert state._service_report_table("dev_web") == "dev_web_report_thread"

    def test_dev_web_uses_its_own_vocabulary_not_githubs(self) -> None:
        """★ dev_web 은 github 어휘로 조회되고 있었다 — 3개는 존재하지도 않는 값이다."""
        dw = state.service_report_inbound_match_statuses("dev_web")
        assert "awaiting_reply" in dw, "dev_web 의 답장 대기 상태가 후보에 없다"
        assert "awaiting_owner" not in dw, "dev_web 어휘에 없는 상태를 찾고 있다"
        # 모든 값이 실제 dev_web 상태 어휘 안에 있어야 한다.
        unknown = [s for s in dw if s not in state._DEV_WEB_REPORT_STATUSES]
        assert not unknown, f"dev_web 어휘에 없는 매칭 상태: {unknown}"

    @pytest.mark.parametrize("domain", ["github", "confluence"])
    def test_service_domains_keep_their_own_vocabulary(self, domain: str) -> None:
        st = state.service_report_inbound_match_statuses(domain)
        assert "awaiting_owner" in st and "recheck_requested" in st

    def test_status_sets_are_not_copies(self) -> None:
        """dev_web 집합은 smb 를 **지연 참조**한다 — 복사본이면 갈린다."""
        assert set(state.service_report_inbound_match_statuses("dev_web")) == set(
            state._MAIL_THREAD_INBOUND_MATCH_STATUSES)


class _FakeAdapter:
    def __init__(self, domain: str, status: str) -> None:
        self.domain = domain
        self._status = status

    def thread_get(self, thread_id: int):
        if thread_id != 7:
            return None
        return {"id": 7, "status": self._status, "subject_tag": "[태그](x)"}


@pytest.fixture
def fake_registry(monkeypatch):
    """어댑터 레지스트리만 갈아끼운다 — bootstrap 을 in-process 로 부르지 않는다.

    ⚠️ `plugin.bootstrap` 은 import 만으로 전역을 바꾼다. 이 저장소에서 그 함정을
       두 번 밟았다(`_shared/tests/test_inspect_contract_wiring.py` 머리말).
    """
    import _shared.thread_adapter as ta

    def _install(domain: str, status: str) -> None:
        monkeypatch.setitem(ta._ADAPTERS, domain, _FakeAdapter(domain, status))

    return _install


class TestUnifiedMatching:
    def test_ticket_wins_when_thread_is_open(self, fake_registry) -> None:
        fake_registry("github", "awaiting_owner")
        from _shared.reply_match import MATCHED_BY_TICKET, match_inbound_thread

        m = match_inbound_thread("RE: [티켓 GH00007] 확인했습니다")
        assert m["matched_by"] == MATCHED_BY_TICKET
        assert (m["domain"], m["thread_id"]) == ("github", 7)

    def test_closed_thread_is_reported_not_silently_dropped(self, fake_registry) -> None:
        """★ 조용히 폴백하면 '왜 안 붙었나'를 되짚을 수 없다."""
        fake_registry("github", "closed")
        from _shared.reply_match import match_inbound_thread

        m = match_inbound_thread("RE: [티켓 GH00007] 확인")
        assert m is not None and "ticket_rejected" in m
        assert m.get("matched_by") is None

    def test_missing_thread_is_reported(self, fake_registry) -> None:
        fake_registry("smb", "awaiting_reply")
        from _shared.reply_match import match_inbound_thread

        m = match_inbound_thread("RE: [티켓 SMB00099] 확인")
        assert m is not None and "없다" in m["ticket_rejected"]

    def test_unknown_prefix_falls_through_without_guessing(self) -> None:
        from _shared.reply_match import match_inbound_thread

        assert match_inbound_thread("[티켓 ZZ00001] 뭔가") is None


def test_missing_adapter_is_reported_not_silently_downgraded(monkeypatch) -> None:
    """★ 어댑터가 없으면 티켓 매칭이 **통째로 꺼진다**. 조용히 태그로 떨어지면 안 된다.

    `service/agents/runtime.py` 는 부트스트랩이 실패해도 warning 만 남기고 진행한다.
    그 상태에서 1차 키가 조용히 사라지면 아무도 모른다 — 답장은 여전히 태그로 붙으니
    겉보기엔 정상이고, 도메인 오분류·주차 혼동만 되살아난다.
    """
    import _shared.thread_adapter as ta
    from _shared.reply_match import match_inbound_thread

    monkeypatch.setattr(ta, "_ADAPTERS", {})
    m = match_inbound_thread("RE: [티켓 SMB00024] 확인")
    assert m is not None and "어댑터가 등록되지 않았다" in m["ticket_rejected"]
