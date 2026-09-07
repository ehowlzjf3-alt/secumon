"""스캔 도구가 자기 손으로 세운 장벽 둘을 걷어냈다.

## 왜 (2026-08-27 실측)

`smb_scan_share` 완료 호출 **241건 중 94건(39%)이 `error:validation`** 이었다 —
실행조차 안 됐다. 사유는 둘뿐이다:

  71건  share_id 누락. 워커가 넘긴 인자는 `{"host": "12.54.62.109", "share": "Users"}`
        였다. 워커는 사람이 읽는 신원을 쥐고 있는데 도구는 DB 의 int id 만 받았다.
   9건  max_bytes_per_file=10485760 이 `le=4194304` 에 걸림. 그런데 그 값을 넣게
        만든 것이 **도구 자신의 note** 다("올려 다시 불러라" — 상한은 안 알려줬다).

둘 다 "찾기는 코드가" 를 막는 어포던스 문제이지 판정 문제가 아니다. 훑는 대상도,
게이트도, 판정도 그대로다 — 도구를 부를 수 있게 만들 뿐이다.
"""
from __future__ import annotations

import pytest

from domains.smb.plugin.tools import smb_scan_tools as m


def test_share_id_is_optional_now():
    """host+share 만 있어도 입력 검증을 통과한다 — 71건이 여기서 죽었다."""
    vi = m.SmbScanShareInput(host="12.54.62.109", share="Users")
    assert vi.share_id is None
    assert (vi.host, vi.share) == ("12.54.62.109", "Users")


def test_share_id_only_still_works():
    """기존 호출 방식은 그대로 산다."""
    assert m.SmbScanShareInput(share_id=7).share_id == 7


def test_the_ceiling_is_named_in_the_field_description():
    """워커가 상한을 **알 수 있어야** 그 위로 안 올린다."""
    desc = m.SmbScanShareInput.model_fields["max_bytes_per_file"].description or ""
    assert str(m._MAX_BYTES_CEILING) in desc


def test_the_tool_description_offers_both_ways_to_name_a_share():
    body = m.SmbScanShareTool.description
    assert "share_id" in body
    assert "host" in body and "share" in body


def test_unresolvable_share_says_why_instead_of_scanning_something_else(monkeypatch):
    """★ 조용한 오작동 금지 — 이름만 주면 다른 host 를 훑을 수 있다.

    같은 이름의 공유(`SMSSIG$`, `SCCMContentLib$`)가 host 마다 있다. 아무거나 고르면
    엉뚱한 host 를 훑고 그 결과를 이 공유의 판정으로 쓴다. 그래서 거부하고 말한다.
    """
    from service import state_domain as state

    monkeypatch.setattr(state, "smb_share_resolve", lambda h, s: None)
    out = m._scan_share_blocking(m.SmbScanShareInput(share="SMSSIG$"), object())
    assert type(out).__name__ == "ToolError"
    assert "host" in out.message and "share" in out.message


@pytest.mark.parametrize("given", [m._MAX_BYTES_CEILING, 512 * 1024])
def test_note_never_tells_the_worker_to_raise_the_cap(monkeypatch, given):
    """★ 도구가 시킨 대로 했더니 도구가 거부하던 자리다.

    2026-08-29 개정: 크기 분기 자체가 사라졌다. 큐가 더는 크기로 거르지 않고
    (`max_size=` 제거), 큰 파일은 **앞부분만** 읽는다. 그래서 "더 큰 게 남았으니
    올려라" 라는 상태가 존재하지 않는다 — 어떤 값으로 불러도 올리라고 하면 안 된다.
    """
    from service import state_domain as state

    monkeypatch.setattr(state, "files_pending_scan", lambda **k: [])
    monkeypatch.setattr(state, "count_files_pending_scan", lambda **k: 0)
    monkeypatch.setattr(state, "files_unread_leads",
                        lambda **k: {"total": 0, "items": []})
    out = m._scan_share_blocking(
        m.SmbScanShareInput(share_id=1, max_bytes_per_file=given), object())
    assert out["scanned"] == 0
    assert "올려" not in out["note"]


def test_queue_is_not_filtered_by_size_anymore(monkeypatch):
    """★ `max_size=` 한 인자가 512K 초과 33,553건을 큐에서 지우고 있었다.

    부분읽기는 `fetch_file_on` 에 이미 있었는데 큐가 그 파일을 안 보여줬다.
    """
    from service import state_domain as state

    seen: dict[str, object] = {}

    def _pending(**kw):
        seen.update(kw)
        return []

    monkeypatch.setattr(state, "files_pending_scan", _pending)
    monkeypatch.setattr(state, "count_files_pending_scan", lambda **k: 0)
    monkeypatch.setattr(state, "files_unread_leads",
                        lambda **k: {"total": 0, "items": []})
    m._scan_share_blocking(
        m.SmbScanShareInput(share_id=1, max_bytes_per_file=512 * 1024), object())
    assert "max_size" not in seen, "크기 필터가 큐에 다시 물렸다"


def test_unread_files_come_back_as_leads(monkeypatch):
    """★ 못 읽은 파일이 아무 데도 안 나타나던 자리.

    사용자 결정(2026-08-29): "못 읽으면 우선 넘기고 제목이나 다른 주변 요소들로
    위험도 판단도 하고".
    """
    from service import state_domain as state

    monkeypatch.setattr(state, "files_pending_scan", lambda **k: [])
    monkeypatch.setattr(state, "count_files_pending_scan", lambda **k: 0)
    monkeypatch.setattr(state, "files_unread_leads", lambda **k: {
        "total": 227,
        "items": [{"file_id": 1, "path": "회비 환불 건/신분증 사본_권지수 회원.jpg",
                   "size": 812345, "name_signal": True, "why": "본문 스캔 대상 아님"}],
    })
    out = m._scan_share_blocking(m.SmbScanShareInput(share_id=1), object())
    assert out["unread_total"] == 227
    assert out["unread_leads"][0]["name_signal"] is True
    assert "없는 것처럼 닫지 마라" in out["note"]


def test_empty_queue_note_is_unchanged(monkeypatch):
    """진짜로 다 훑었을 때의 문구는 그대로다 — 회귀 기준선."""
    from service import state_domain as state

    monkeypatch.setattr(state, "files_pending_scan", lambda **k: [])
    monkeypatch.setattr(state, "count_files_pending_scan", lambda **k: 0)
    out = m._scan_share_blocking(m.SmbScanShareInput(share_id=1), object())
    assert "다 훑었다" in out["note"]
