"""티켓 번호 검색 — 메일에 나간 번호로 콘솔에서 대상을 찾는다.

## 왜

조치요청·회신 메일 제목에 `[티켓 SMB00024]` 가 붙는다. 담당자가 그 번호로 문의했을 때
운영자가 콘솔에서 못 찾으면 표식이 반쪽이다.

## ★ 게이트웨이는 번호를 **계산하지 않는다**

처음엔 접두 지도(SMB/GH/CF/DW)를 여기 복제했다. 저장소가 달라 스킬을 import 할 수
없어서였는데, 그러면 한쪽만 바뀌었을 때 **메일에 찍힌 번호를 콘솔이 못 읽는다**
(조용한 실패 — 검색이 0건을 돌려줄 뿐 오류가 안 난다).

2026-08-31 에 번호를 스레드 행에 **저장**하도록 바꿨다. 생산자는 스킬의
`state_domain.thread_ensure_ticket_no` 하나이고 게이트웨이는 소비자다. 덤으로 번호가
불변이 된다 — 사람에게 이미 나간 값이라 접두 규칙이 바뀌어도 재발급되면 안 된다.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

LIVE = pytest.mark.skipif(
    not os.environ.get("SECU_AGENT_PG_DSN"),
    reason="라이브 threat_hunter DSN(SECU_AGENT_PG_DSN) 필요",
)
_SRC = Path(__file__).resolve().parents[1] / "src" / "digisecu_gateway"


def test_gateway_holds_no_copy_of_the_prefix_map() -> None:
    """★ 사본이 되살아나지 않는지 고정한다."""
    assert not (_SRC / "ticket_id.py").exists(), (
        "게이트웨이가 티켓 접두 지도를 다시 갖게 됐다 — 저장된 ticket_no 를 읽어라")
    repo = (_SRC / "repos" / "source_repo.py").read_text(encoding="utf-8")
    for token in ('"SMB"', '"GH"', '"CF"', '"DW"'):
        assert token not in repo, f"접두 리터럴 {token} 이 게이트웨이에 들어왔다"


def test_all_four_thread_tables_declare_the_column() -> None:
    """한 테이블이라도 빠지면 그 도메인 티켓이 검색에서 통째로 사라진다."""
    from digisecu_gateway.domains import DOMAIN_TABLES, DOMAINS, REPORT_HAS_TICKET_NO

    for domain in DOMAINS:
        table = DOMAIN_TABLES[domain].report_thread_table
        assert table in REPORT_HAS_TICKET_NO, f"{domain}({table}) 에 ticket_no 미선언"


@pytest.fixture()
def pool():
    os.environ.setdefault("GATEWAY_TOKEN", "test")
    from digisecu_gateway.config import Config
    from digisecu_gateway.db import ReadOnlyPool

    p = ReadOnlyPool(Config.load())
    p.open()
    yield p
    p.close()


def _items(result):
    return result.items if hasattr(result, "items") else result["items"]


@LIVE
def test_ticket_number_finds_the_source(pool) -> None:
    """★ 게이트웨이 SQL 은 유닛 테스트가 못 잡는다.

    2026-08-27 에 `/gw/stats` 가 "22 placeholders but 14 parameters" 로 500 이 났는데
    게이트웨이 테스트 284건이 전부 통과했다 — 그 쿼리를 실DB로 도는 테스트가 없었다.
    """
    from digisecu_gateway.repos import source_repo

    target = next((r for r in _items(source_repo.list_sources(pool, limit=5)) if r.ticketNo), None)
    if target is None:
        pytest.skip("티켓 번호가 있는 대상이 없다")
    got = _items(source_repo.list_sources(pool, q=target.ticketNo, limit=5))
    assert any(r.srcKey == target.srcKey for r in got), f"{target.ticketNo} 로 못 찾았다"


@LIVE
@pytest.mark.parametrize("shape", ["{t}", "[티켓 {t}]", "티켓 {t}", "{lower}"])
def test_operator_can_paste_the_number_as_it_appears_in_mail(pool, shape: str) -> None:
    """운영자는 메일에서 통째로 복사해 붙인다 — 대괄호·접두·대소문자를 벗겨야 한다."""
    from digisecu_gateway.repos import source_repo

    target = next((r for r in _items(source_repo.list_sources(pool, limit=5)) if r.ticketNo), None)
    if target is None:
        pytest.skip("티켓 번호가 있는 대상이 없다")
    q = shape.format(t=target.ticketNo, lower=target.ticketNo.lower())
    got = _items(source_repo.list_sources(pool, q=q, limit=5))
    assert any(r.srcKey == target.srcKey for r in got), f"{q!r} 로 못 찾았다"


@LIVE
def test_plain_search_still_works(pool) -> None:
    """티켓 분기를 넣으면서 평범한 대상 검색을 깨뜨리지 않았는지."""
    from digisecu_gateway.repos import source_repo

    rows = _items(source_repo.list_sources(pool, limit=1))
    if not rows or not rows[0].src:
        pytest.skip("대상이 없다")
    assert _items(source_repo.list_sources(pool, limit=5)), "필터 없는 목록이 비었다"


@LIVE
def test_smb_draft_body_is_readable_before_sending(pool) -> None:
    """★ 발송 전 smb 티켓도 본문이 보여야 한다.

    화면은 본문이 있을 때만 "메일 준비됨" 과 발송 버튼을 그린다. `mail_thread.report_json`
    은 2026-08-29 에 생겼는데 smb 읽기 경로(`_smb_body`)가 안 붙어 있어서, 발송 전
    티켓은 전부 빈 칸이었고 **발송할 방법 자체가 없었다**(2026-08-31 실측 W36 draft 22건).

    ⚠️ 초안을 "발송됨" 으로 그리지 않는다 — `state` 가 사실을 말해야 한다.
    """
    from digisecu_gateway.repos import mail_body_repo, source_repo

    rows = _items(source_repo.list_sources(pool, domain="smb", limit=20))
    drafts = [r for r in rows if r.threadId and str(r.threadStatus or "") == "draft"]
    if not drafts:
        pytest.skip("발송 전 smb 티켓이 없다")
    b = mail_body_repo.mail_body(pool, domain="smb", thread_id=int(drafts[0].threadId))
    assert b.hasBody, "초안 본문을 못 읽었다 — 화면에 발송 버튼이 안 뜬다"
    assert b.state == "draft", f"초안을 {b.state!r} 로 그리면 거짓말이다"
    assert b.isHtml, "초안 HTML 을 텍스트로 내려보내면 화면이 원시 마크업을 그린다"
    assert not str(b.body or "").lstrip().startswith("{"), (
        "report_json 을 통째로 내려보냈다 — 안의 html 을 꺼내야 한다")
