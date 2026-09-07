"""걷기 **실패**를 빈 공유로 적던 자리, 그리고 못 읽은 파일의 단서.

## 왜 (2026-08-29 실측)

    walk_done_at 있음 · walk_file_count=0 · 제외 아님   54공유
      triaged_completed 40 · walked 14

`_walk_one_share` 의 except 가 사유를 `log.warning` 으로 흘리고 `break` 했다.
호출부는 실패를 못 보고 그대로 `walked, walk_file_count=0` 을 찍었다 — DB 에서
"정말 빈 공유" 와 "못 걸었다" 가 **같은 값**이 된다. 그 54개 중엔 인증 없이 읽히는
`12.56.53.81\\AE_SERVER`(04nm/1.4nm 레이아웃 설계 파일)가 들어 있다.
"""
from __future__ import annotations

import pytest

from service import state_domain as state
from service.collector import walk_core


class _Res:
    directories: list = []
    directory_errors: list = []
    files: list = []
    truncated = False
    checkpoint = None


def _one_share(tmp_db, share_name="AE_SERVER"):
    sid = state.scan_start("smb", ["10.9.0.0/24"])
    _, share_id = state.upsert_smb_share(
        sid, "10.9.0.0/24", "10.9.0.81", share_name, share_read=True)
    return share_id


def _digest(share_id, share_name="AE_SERVER"):
    return {"host": "10.9.0.81",
            "shares": [{"id": share_id, "share": share_name, "share_read": 1}]}


def test_failed_walk_is_not_stamped_as_walked(tmp_db, monkeypatch):
    _SHARE = "AE_SERVER"
    share_id = _one_share(tmp_db)

    def _boom(*a, **kw):
        raise OSError("STATUS_ACCESS_DENIED on listPath")

    monkeypatch.setattr(walk_core.smb, "walk_share_detailed", _boom)
    walk_core.walk_claimed_host(_digest(share_id))

    row = state.smb_share_resolve("10.9.0.81", _SHARE)
    assert row["walk_done_at"] is None, "걷지 못했는데 '걷기 완료' 도장이 찍혔다"
    assert row["last_error_kind"] == "walk"
    assert "ACCESS_DENIED" in (row["last_error"] or "")
    assert row["status"] == "pending", "재시도 가능한 상태로 남아야 한다"


def test_genuinely_empty_share_is_still_walked(tmp_db, monkeypatch):
    """★ 대조군 — 진짜 빈 공유는 그대로 'walked' 여야 한다."""
    _SHARE = "empty"
    share_id = _one_share(tmp_db, _SHARE)
    monkeypatch.setattr(walk_core.smb, "walk_share_detailed", lambda *a, **kw: _Res())
    walk_core.walk_claimed_host(_digest(share_id, "empty"))

    row = state.smb_share_resolve("10.9.0.81", _SHARE)
    assert row["status"] == "walked"
    assert row["walk_done_at"] is not None
    assert row["walk_file_count"] == 0
    assert row["last_error_kind"] is None


def test_successful_walk_clears_a_previous_walk_error(tmp_db, monkeypatch):
    _SHARE = "flaky"
    share_id = _one_share(tmp_db, _SHARE)
    monkeypatch.setattr(walk_core.smb, "walk_share_detailed",
                        lambda *a, **kw: (_ for _ in ()).throw(OSError("boom")))
    walk_core.walk_claimed_host(_digest(share_id, "flaky"))
    assert state.smb_share_resolve("10.9.0.81", "flaky")["last_error"] is not None

    monkeypatch.setattr(walk_core.smb, "walk_share_detailed", lambda *a, **kw: _Res())
    walk_core.walk_claimed_host(_digest(share_id, "flaky"))
    row = state.smb_share_resolve("10.9.0.81", _SHARE)
    assert row["last_error"] is None and row["last_error_kind"] is None


# ── 못 읽은 파일이 단서로 돌아온다 ──────────────────────────────────────────

def test_unread_leads_surface_name_signals(tmp_db):
    """★ 이름 판정기는 walk 때 이미 돌았는데 소비자가 큐 ORDER BY 뿐이었다."""
    share_id = _one_share(tmp_db, "공유폴더")
    # ① 열 수도 없는데 이름이 의심 — 신분증 이미지
    state.upsert_smb_file(share_id, "회비 환불 건/신분증 사본_권지수 회원.jpg",
                          size=812_345, is_text_candidate=False, suspicious_name=True)
    # ② 열어봤는데 못 읽음
    denied = state.upsert_smb_file(share_id, "인사/급여대장.txt", size=4096,
                                   is_text_candidate=True, suspicious_name=True)
    state.file_record_scan_skipped(denied, reason="denied")
    # ③ 이름도 안 걸리고 열 대상도 아님 — 단서가 아니다
    state.upsert_smb_file(share_id, "icon.dll", size=10,
                          is_text_candidate=False, suspicious_name=False)
    # ④ 정상적으로 훑은 것 — 단서가 아니다
    ok = state.upsert_smb_file(share_id, "readme.txt", size=10,
                               is_text_candidate=True, suspicious_name=False)
    state.file_record_scan(ok, hits_count=0)

    got = state.files_unread_leads(share_id=share_id, limit=10)
    paths = [i["path"] for i in got["items"]]
    assert got["total"] == 2, got
    assert "회비 환불 건/신분증 사본_권지수 회원.jpg" in paths
    assert "인사/급여대장.txt" in paths
    assert "icon.dll" not in paths and "readme.txt" not in paths
    assert all(i["name_signal"] for i in got["items"])


def test_unread_leads_report_the_total_not_just_the_sample(tmp_db):
    """★ 표본만 주고 전량인 척하지 않는다."""
    share_id = _one_share(tmp_db, "many")
    for i in range(15):
        fid = state.upsert_smb_file(share_id, f"secret_{i}.bin", size=10,
                                    is_text_candidate=False, suspicious_name=True)
        del fid
    got = state.files_unread_leads(share_id=share_id, limit=3)
    assert got["total"] == 15
    assert len(got["items"]) == 3


# ── codex 적대검증 #2 — 진짜 실패 경로 ──────────────────────────────────────

class _RootDenied:
    """`listPath` 가 루트에서 실패했을 때 walk_share_detailed 가 돌려주는 모양.

    ★ 이게 핵심이다 — 실패는 **예외로 안 올라온다.** 안에서 잡혀 `directory_errors` 가
    된다. 앞선 테스트는 `walk_share_detailed` 자체를 raise 시켜서 이 층을 통째로
    건너뛰었고, codex 가 그걸 잡았다(2026-08-29).
    """
    directories: list = []
    files: list = []
    truncated = False
    checkpoint = None

    def __init__(self):
        from domains.smb.plugin.agent_types.smb import SmbDirectoryError
        self.directory_errors = [
            SmbDirectoryError(path="", depth=0, error="STATUS_ACCESS_DENIED")
        ]


def test_root_listing_failure_is_not_an_empty_share(tmp_db, monkeypatch):
    """루트를 못 읽었으면 '파일 0개' 가 아니라 '못 걸었다' 다."""
    _SHARE = "denied_root"
    share_id = _one_share(tmp_db, _SHARE)
    monkeypatch.setattr(walk_core.smb, "walk_share_detailed",
                        lambda *a, **kw: _RootDenied())
    walk_core.walk_claimed_host(_digest(share_id, _SHARE))

    row = state.smb_share_resolve("10.9.0.81", _SHARE)
    assert row["walk_done_at"] is None, "루트를 못 읽었는데 '걷기 완료' 도장이 찍혔다"
    assert row["last_error_kind"] == "walk"
    assert "root listing" in (row["last_error"] or "")


class _SubdirDenied(_RootDenied):
    """하위 디렉터리만 실패 — 루트는 읽혔다. 이건 '못 걸었다' 가 아니다."""

    def __init__(self):
        from domains.smb.plugin.agent_types.smb import SmbDirectoryError
        self.directory_errors = [
            SmbDirectoryError(path="sub/deep", depth=2, error="STATUS_ACCESS_DENIED")
        ]


def test_subdirectory_failure_still_counts_as_walked(tmp_db, monkeypatch):
    """⚠️ 일부를 못 읽은 것과 아무것도 못 읽은 것은 다르다 — 하위 실패로 공유를 되돌리면
    매 주기 같은 공유를 다시 걷는다."""
    _SHARE = "partial"
    share_id = _one_share(tmp_db, _SHARE)
    monkeypatch.setattr(walk_core.smb, "walk_share_detailed",
                        lambda *a, **kw: _SubdirDenied())
    walk_core.walk_claimed_host(_digest(share_id, _SHARE))

    row = state.smb_share_resolve("10.9.0.81", _SHARE)
    assert row["status"] == "walked"
    assert row["walk_done_at"] is not None
