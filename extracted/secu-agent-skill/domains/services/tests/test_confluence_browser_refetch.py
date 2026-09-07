"""재검증 재조회를 브라우저로 (2026-08-26).

`reporter._fetch_recheck_text` 는 `/rest/api/content` 를 쳤다. 그 엔드포인트는 죽어 있다
(Basic 403 "Basic Authentication has been disabled" / Bearer PAT 429) — 즉
`confluence.recheck` 는 켜는 순간 전량 실패했다.

## 이 파일이 지키는 것

★ **"확인 못 함" 을 "조치됨" 으로 접지 않는다.** 첨부는 브라우저로 본문을 못 뽑는다.
  그걸 조용히 빈 텍스트로 돌려주면 원래 값이 안 보이니 `now_closed`(조치됨)로 판정되고,
  유출이 열린 채 스레드만 닫힌다. 그래서 사유를 돌려주고 호출측이 `unknown` 으로 남긴다.
"""
from __future__ import annotations

import pytest

from domains.services.confluence.plugin.tools.confluence_browser_refetch import (
    ATTACHMENT_UNSUPPORTED, browser_fetch_recheck_text,
)


def test_attachment_is_reported_unsupported_not_empty():
    """★ 첨부는 '못 한다'고 답한다 — 빈 텍스트는 '조치됨' 으로 오독된다."""
    payloads, err = browser_fetch_recheck_text(page_id="123", kind="attachment")
    assert payloads == []
    assert err == ATTACHMENT_UNSUPPORTED
    assert "not remediated" in err, "사유가 '조치 아님' 을 명시해야 한다"


def test_missing_base_url_is_an_error(monkeypatch):
    monkeypatch.delenv("CONFLUENCE_BASE_URL", raising=False)
    payloads, err = browser_fetch_recheck_text(page_id="123", kind="page")
    assert payloads == [] and "CONFLUENCE_BASE_URL" in err


def test_missing_page_id_is_an_error(monkeypatch):
    monkeypatch.setenv("CONFLUENCE_BASE_URL", "https://confluence.example")
    payloads, err = browser_fetch_recheck_text(page_id="", kind="page")
    assert payloads == [] and "page id" in err


def _stub(monkeypatch, text):
    monkeypatch.setenv("CONFLUENCE_BASE_URL", "https://confluence.example")
    import domains.services.confluence.plugin.tools.confluence_browser_refetch as m

    async def _collect(base, page_id, *, version):
        _collect.seen = {"base": base, "page_id": page_id, "version": version}
        return text

    monkeypatch.setattr(m, "_collect", _collect)
    return _collect


def test_page_refetch_returns_the_contract_shape(monkeypatch):
    """반환형이 예전 REST 판과 같아야 판정 로직을 안 건드린다."""
    _stub(monkeypatch, "본문에 password=hunter2 가 남아 있다")
    payloads, err = browser_fetch_recheck_text(page_id="777", kind="page")
    assert err is None
    assert len(payloads) == 1
    assert set(payloads[0]) == {"label", "text"}
    assert "hunter2" in payloads[0]["text"]


def test_version_refetch_passes_the_version_through(monkeypatch):
    seen = _stub(monkeypatch, "옛 버전 본문")
    payloads, err = browser_fetch_recheck_text(
        page_id="777", kind="page_version", version=3)
    assert err is None and seen.seen["version"] == 3
    assert payloads[0]["label"] == "777/version/3"


def test_comment_label_says_comments_are_folded_into_the_page(monkeypatch):
    """★ 댓글을 개별 인덱스로 못 가른다 — 라벨이 그 사실을 말해야 한다.

    판정에는 영향이 없다(원래 값이 이 텍스트 안에 있으면 still_open). 다만 라벨이
    `<id>/comment/3` 이라고 거짓말하면, 나중에 그 인덱스를 신뢰하는 코드가 생긴다.
    """
    _stub(monkeypatch, "page 본문 + 댓글들")
    payloads, err = browser_fetch_recheck_text(page_id="777", kind="comment")
    assert err is None and payloads[0]["label"] == "777/page+comments"


def test_an_unreadable_page_is_an_error_not_empty_text(monkeypatch):
    """★ 로그인벽/off-origin 은 '본문 없음' 이 아니라 '못 읽음' 이다."""
    _stub(monkeypatch, None)
    payloads, err = browser_fetch_recheck_text(page_id="777", kind="page")
    assert payloads == [] and "not readable" in err


def test_browser_failure_is_surfaced(monkeypatch):
    monkeypatch.setenv("CONFLUENCE_BASE_URL", "https://confluence.example")
    import domains.services.confluence.plugin.tools.confluence_browser_refetch as m

    async def _boom(base, page_id, *, version):
        raise RuntimeError("세션 죽음")

    monkeypatch.setattr(m, "_collect", _boom)
    payloads, err = browser_fetch_recheck_text(page_id="1", kind="page")
    assert payloads == [] and "세션 죽음" in err


def test_reporter_no_longer_calls_the_rest_client():
    """★ reporter 가 `cf.*` 를 다시 부르면 recheck 가 403 으로 돌아간다."""
    import inspect

    from domains.services.confluence.application import reporter

    src = inspect.getsource(reporter._fetch_recheck_text)
    for fn in ("cf.fetch_page_body(", "cf.list_comments(", "cf.list_attachments(",
               "cf.fetch_attachment_text(", "cf.fetch_page_body_version("):
        assert fn not in src, f"reporter 가 아직 REST 를 부른다: {fn}"
    assert "browser_fetch_recheck_text(" in src


def test_reporter_module_does_not_import_the_rest_client():
    """미사용 import 를 남기면 다음 사람이 '여기서 REST 를 쓰는구나' 로 읽는다."""
    from pathlib import Path

    src = Path(inspect_file()).read_text(encoding="utf-8")
    assert "import confluence as cf" not in src


def inspect_file() -> str:
    from domains.services.confluence.application import reporter

    return reporter.__file__
