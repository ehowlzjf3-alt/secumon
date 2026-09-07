"""스레드가 닫히면 finding 도 닫히는가 — 4도메인 대칭 (2026-08-28).

smb 는 `mail_thread` 를 remediated 로 닫을 때 finding 도 닫았다. github·confluence 는
그 짝이 **아예 없어서**(호출 누락) finding 이 영원히 `open` 이었고, dev_web·smb 는
있긴 했는데 엔진 어휘에 없는 `"resolved"` 를 써서 ValueError 가 나고 `except` 가
삼켰다(68a39b8 에서 수정). 두 원인이 달랐고 증상은 같았다 — finding 92건 전부 open.

⚠️ 이 테스트가 없으면 다시 조용히 끊긴다: 스레드 전이는 성공하고 finding 만 안 닫히므로
   호출부에서는 아무 신호도 안 난다.
"""
from __future__ import annotations

import pytest

from secu_agent import state as core_state
import service.state_domain as sd


def _finding(task_type: str, asset: str) -> int:
    fid, _created = core_state.finding_upsert(
        task_type=task_type, asset=asset, asset_kind="url",
        severity="low", summary="t",
    )
    return int(fid)


@pytest.mark.parametrize("domain,closing", [
    ("github", "remediated"), ("github", "closed"),
    ("confluence", "remediated"), ("confluence", "closed"),
])
def test_closing_a_thread_closes_its_finding(tmp_db, domain, closing):
    fid = _finding(domain, f"https://x.test/{domain}/{closing}")
    if domain == "github":
        _ref, tid = sd.github_report_thread_upsert(repo="o/r", finding_id=fid)
        set_status = sd.github_report_thread_set_status
    else:
        _ref, tid = sd.confluence_report_thread_upsert(space_key="SP", finding_id=fid)
        set_status = sd.confluence_report_thread_set_status

    assert core_state.finding_list(task_type=domain, limit=50)[0]["status"] == "open"
    set_status(int(tid), closing)

    row = [r for r in core_state.finding_list(task_type=domain, limit=50) if r["id"] == fid][0]
    assert row["status"] == "remediated", f"{domain}/{closing}: finding 이 안 닫혔다"


@pytest.mark.parametrize("domain,keep", [
    ("github", "rechecking"), ("github", "still_open"),
    ("confluence", "rechecking"), ("confluence", "still_open"),
])
def test_non_closing_status_leaves_the_finding_open(tmp_db, domain, keep):
    """⚠️ 아무 전이에서나 닫으면 안 된다 — 재검증 중/미해결은 열려 있어야 한다."""
    fid = _finding(domain, f"https://x.test/{domain}/{keep}")
    if domain == "github":
        _ref, tid = sd.github_report_thread_upsert(repo="o/r", finding_id=fid)
        set_status = sd.github_report_thread_set_status
    else:
        _ref, tid = sd.confluence_report_thread_upsert(space_key="SP", finding_id=fid)
        set_status = sd.confluence_report_thread_set_status

    set_status(int(tid), keep)
    row = [r for r in core_state.finding_list(task_type=domain, limit=50) if r["id"] == fid][0]
    assert row["status"] == "open", f"{domain}/{keep}: 아직 안 끝났는데 닫혔다"


def test_finding_close_failure_does_not_block_the_thread_transition(tmp_db, monkeypatch):
    """★ finding 종료가 실패해도 스레드는 닫혀야 한다 — 반대로 묶으면 큐가 멈춘다."""
    fid = _finding("github", "https://x.test/boom")
    _ref, tid = sd.github_report_thread_upsert(repo="o/r", finding_id=fid)

    def _boom(*a, **kw):
        raise RuntimeError("engine down")

    monkeypatch.setattr(core_state, "finding_update", _boom)
    sd.github_report_thread_set_status(int(tid), "remediated")

    rows = sd.github_report_threads_overview(status="remediated", limit=10)
    assert any(int(r["id"]) == int(tid) for r in rows), "스레드 전이가 finding 실패에 묶였다"
