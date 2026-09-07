"""공유를 닫는 **두 경로**가 같은 백스톱을 탄다.

## 왜 (2026-08-29 실측)

백스톱 둘은 `inspect_contract._close_queue` 안에만 있었고, 그 자리는
`if is_delegated_inspector(): ... return` **아래**였다. 리드/검토원 2단 분리 뒤
운영은 전부 위임 경로라 그 자리를 아무도 안 지나간다. 실제로 닫는
`lead_adapter._set_status` 에는 백스톱이 **하나도 없었다**.

    검토원 권고 283건 중 제출 없이 완료 권고 271건(95.8%)
    12.36.127.132\\share (null 세션으로 읽힘)
      private_key_block hit 2건 pending → finding 0, triaged_completed
"""
from __future__ import annotations

import time

import pytest

from domains.smb.plugin import share_close_backstop as backstop
from service import state_domain as state


def _share(tmp_db, *, read=True, name="share"):
    sid = state.scan_start("smb", ["10.9.0.0/24"])
    _, share_id = state.upsert_smb_share(
        sid, "10.9.0.0/24", "10.9.0.132", name,
        null_login_ok=True, share_read=read)
    return share_id


def test_closing_without_a_submission_records_the_exposure(tmp_db):
    """★ 인증 없이 읽히는 공유를 '깨끗함' 으로 닫으면 노출 사실이 사라진다."""
    share_id = _share(tmp_db)
    extra = backstop.apply(share_id, "triaged_completed",
                           saw_submit=False, rescan_soon_seconds=8 * 3600)
    assert extra.get("_exposure_finding_id"), extra


def test_a_submission_means_no_duplicate_exposure_finding(tmp_db):
    share_id = _share(tmp_db)
    extra = backstop.apply(share_id, "triaged_completed",
                           saw_submit=True, rescan_soon_seconds=8 * 3600)
    assert "_exposure_finding_id" not in extra


def test_leftover_queue_pulls_the_recheck_forward(tmp_db):
    """★ 훑을 게 남았으면 7일이 아니라 8시간."""
    share_id = _share(tmp_db)
    state.upsert_smb_file(share_id, "/a.txt", size=10,
                          is_text_candidate=True, suspicious_name=False)
    extra = backstop.apply(share_id, "triaged_completed",
                           saw_submit=True, rescan_soon_seconds=8 * 3600)
    assert extra["_pending_left"] == 1
    assert extra["retry_after"] > time.time()


def test_empty_queue_does_not_schedule_a_recheck(tmp_db):
    share_id = _share(tmp_db)
    extra = backstop.apply(share_id, "triaged_completed",
                           saw_submit=True, rescan_soon_seconds=8 * 3600)
    assert "retry_after" not in extra


@pytest.mark.parametrize("status", ["walked", "listing_reviewed", "in_progress"])
def test_non_terminal_statuses_get_no_backstop(tmp_db, status):
    """미종결은 이미 큐 안이다 — 여기에 노출 finding 을 만들면 중복이 쌓인다."""
    share_id = _share(tmp_db)
    assert backstop.apply(share_id, status,
                          saw_submit=False, rescan_soon_seconds=8 * 3600) == {}


def test_db_fields_drops_the_informational_keys():
    got = backstop.db_fields({"retry_after": 1.0, "_exposure_finding_id": 7,
                              "_pending_left": 3})
    assert got == {"retry_after": 1.0}


# ── 리드 경로가 실제로 백스톱을 탄다 ────────────────────────────────────────

def test_the_lead_close_path_applies_the_backstop(tmp_db):
    """★ 이 테스트가 없으면 리드 경로가 다시 조용히 맨몸이 된다."""
    from domains.smb.plugin.lead_adapter import _set_status

    share_id = _share(tmp_db, name="opened")
    state.upsert_smb_file(share_id, "/left.txt", size=10,
                          is_text_candidate=True, suspicious_name=False)

    out = _set_status(share_id, "triaged_completed", finding_count=0,
                      reason="검토원 제출 없음")
    assert out.get("exposure_finding_id"), out
    assert out.get("pending_files_left") == 1, out

    row = state.smb_share_resolve("10.9.0.132", "opened")
    assert row["retry_after"] is not None, "재점검 예약이 안 심겼다"
    assert row["hits_count"] == 1, "노출을 남겼는데 0건이라고 적었다"


def test_the_lead_close_path_leaves_non_terminal_alone(tmp_db):
    from domains.smb.plugin.lead_adapter import _set_status

    share_id = _share(tmp_db, name="back2queue")
    out = _set_status(share_id, "walked", finding_count=0, reason="근거 없음")
    assert "exposure_finding_id" not in out
    row = state.smb_share_resolve("10.9.0.132", "back2queue")
    assert row["status"] == "walked"


# ── codex 적대검증 #8 — 호출자가 준 숫자를 믿지 않는다 ──────────────────────

def test_backstop_consults_the_db_not_just_the_caller_count(tmp_db, monkeypatch):
    """★ `saw_submit` 은 리드가 넘긴 숫자다. 그것만 믿으면 두 방향으로 틀린다.

    실제 제출이 있는데 리드가 0 을 넘기면 노출 finding 을 **또** 만든다.
    DB 를 함께 봐서, 둘 중 하나라도 제출을 말하면 제출로 친다.
    """
    share_id = _share(tmp_db, name="hasfinding")
    monkeypatch.setattr(state, "smb_share_has_submitted_finding", lambda sid: True)
    extra = backstop.apply(share_id, "triaged_completed",
                           saw_submit=False, rescan_soon_seconds=8 * 3600)
    assert "_exposure_finding_id" not in extra, "제출이 있는데 노출 finding 을 또 만들었다"


def test_backstop_falls_back_to_caller_when_db_cannot_answer(tmp_db, monkeypatch):
    """⚠️ 못 읽은 것을 '제출 없음' 으로 단정하지 않는다 — 호출자 값으로 되돌아간다."""
    share_id = _share(tmp_db, name="dbdown")

    def _boom(_sid):
        raise RuntimeError("finding_lifecycle 읽기 실패")

    monkeypatch.setattr(state, "smb_share_has_submitted_finding", _boom)
    extra = backstop.apply(share_id, "triaged_completed",
                           saw_submit=True, rescan_soon_seconds=8 * 3600)
    assert "_exposure_finding_id" not in extra


def test_exposure_finding_itself_is_not_counted_as_a_submission(tmp_db):
    """★ 백스톱이 만든 것을 제출로 세면, 한 번 만든 뒤로 영원히 '제출 있음' 이 되어
    백스톱이 스스로 죽는다."""
    import inspect

    src = inspect.getsource(state.smb_share_has_submitted_finding)
    assert "open_share_exposure" in src
    assert "NOT LIKE" in src
