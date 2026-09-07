"""티켓 번호 파싱과 회신 본문 조립 — 순수 로직(부트스트랩 불필요)."""
from __future__ import annotations

import pytest

from _shared.ticket_id import parse_ticket, subject_marker, ticket_no


class TestTicketId:
    @pytest.mark.parametrize("domain,expected", [
        ("smb", "SMB00024"), ("github", "GH00024"),
        ("confluence", "CF00024"), ("dev_web", "DW00024"),
    ])
    def test_prefix_per_domain(self, domain: str, expected: str) -> None:
        assert ticket_no(domain, 24) == expected

    def test_smb_keeps_the_number_people_already_saw(self) -> None:
        """★ smb 는 콘솔이 이미 `SMB%05d` 를 보여주고 있었다. 재발급 금지."""
        import service.state_domain as state

        assert ticket_no("smb", 24) == state.mail_thread_ticket_no(24)

    def test_unknown_domain_is_refused_not_guessed(self) -> None:
        with pytest.raises(ValueError, match="티켓 접두가 없는 도메인"):
            ticket_no("web", 1)

    @pytest.mark.parametrize("subject,expected", [
        ("[티켓 SMB00024] 공유폴더", ("smb", 24)),
        ("RE:(3) [티켓 GH00137] repo", ("github", 137)),
        ("FW: [티켓 CF00019]", ("confluence", 19)),
        ("답장 [티켓 DW00045] 사이트", ("dev_web", 45)),
        # 사람이 제목 앞뒤를 고쳐도 살아남는다.
        ("Re: Re: 회신드립니다 [티켓 SMB00024] — 확인", ("smb", 24)),
    ])
    def test_parses_through_reply_prefixes(self, subject: str, expected: tuple) -> None:
        assert parse_ticket(subject) == expected

    @pytest.mark.parametrize("subject", [
        "[보안취약점 조치요청](10.125.102.246)",   # 옛 제목 태그 — 티켓 없음
        "[티켓 XX00001]",                          # 모르는 접두
        "티켓 SMB00024",                           # 대괄호 없음
        "",
    ])
    def test_returns_none_instead_of_guessing(self, subject: str) -> None:
        """★ 조용히 추측하지 않는다 — 호출부가 제목 태그로 **명시적으로** 폴백해야 한다."""
        assert parse_ticket(subject) is None

    def test_marker_round_trips(self) -> None:
        for d in ("smb", "github", "confluence", "dev_web"):
            assert parse_ticket(subject_marker(d, 7)) == (d, 7)


class TestReplyBody:
    def _render(self, **kw):
        from _shared.reply_body import ReplyBlock, register_reply_block, render_reply

        register_reply_block(ReplyBlock(
            name="_t_block", purpose="테스트용", html="<p>블록내용</p>", domains=("smb",)))
        return render_reply(domain="smb", **kw)

    def test_llm_text_is_escaped_not_injected(self) -> None:
        """★ LLM 이 쓴 문자열이 그대로 메일 HTML 이 된다 — 마크업을 통과시키면 안 된다."""
        out = self._render(answer='<script>alert(1)</script> & "따옴표"')
        assert "<script>" not in out["html"]
        assert "&lt;script&gt;" in out["html"]

    def test_blank_lines_become_paragraphs(self) -> None:
        out = self._render(answer="첫 문단\n둘째 줄\n\n다음 문단")
        assert out["html"].count("<p>") >= 3
        assert "둘째 줄" in out["html"]

    def test_unknown_block_is_reported_not_swallowed(self) -> None:
        """★ 조용히 버리면 워커는 절차 안내가 나간 줄 안다."""
        out = self._render(answer="답", blocks=["_t_block", "없는것"])
        assert out["blocks_used"] == ["_t_block"]
        assert out["blocks_unknown"] == ["없는것"]
        assert "블록내용" in out["html"]

    def test_same_block_is_not_pasted_twice(self) -> None:
        out = self._render(answer="답", blocks=["_t_block", "_t_block"])
        assert out["blocks_used"] == ["_t_block"]
        assert out["html"].count("블록내용") == 1

    def test_ticket_number_is_in_the_body_too(self) -> None:
        """제목을 사람이 고쳐도 본문에 남아 있으면 매칭할 수 있다."""
        out = self._render(answer="답", ticket_no="SMB00024")
        assert "SMB00024" in out["html"]

    def test_domain_scoped_blocks_do_not_leak(self) -> None:
        from _shared.reply_body import render_reply

        out = render_reply(domain="github", answer="답", blocks=["_t_block"])
        assert out["blocks_used"] == []
        assert out["blocks_unknown"] == ["_t_block"], "smb 전용 블록이 github 에 보였다"


class TestHtmlToText:
    def test_strips_script_and_style(self) -> None:
        from _shared.ticket_context import html_to_text

        t = html_to_text("<style>p{color:red}</style><script>x=1</script><p>본문</p>")
        assert t.strip() == "본문"

    def test_truncates_long_bodies(self) -> None:
        from _shared.ticket_context import html_to_text

        t = html_to_text("<p>" + ("가" * 5000) + "</p>", limit=100)
        assert len(t) < 200 and "이하 생략" in t
