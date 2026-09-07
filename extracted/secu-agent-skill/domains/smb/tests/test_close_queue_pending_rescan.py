"""훑을 게 남은 공유는 7일을 기다리지 않는다.

## 왜 (2026-08-28 실측)

`triaged_completed` 는 영구 종결이 아니라 **7일 롤링 재점검**이다
(`SMB_TASK_RESCAN_SECONDS = 7 * 86400`). 그런데 `_close_queue` 는 스캔 큐가
비었는지 **보지 않고** 닫는다.

    triaged_completed 공유 50개  →  미스캔 text 후보 67,851건

한 패스가 300건을 훑으니 7일 주기로는 226패스, **4년이 넘는다.**

상태 어휘는 안 바꾼다 — 판정이 끝났다는 사실(`triaged_completed`)과 훑을 게
남았다는 사실은 서로 다르고 둘 다 남아야 한다. 이미 있는 `retry_after` 로
다음 주기만 당긴다. claim SQL 이 `status='triaged_completed' AND retry_after <= now`
를 이미 보고 있다.
"""
from __future__ import annotations

import time

import pytest

from domains.smb.plugin import inspect_contract as ic


class _State:
    """`share_set_status` 로 넘어온 인자만 붙잡는다."""

    def __init__(self, pending: int):
        self._pending = pending
        self.calls: list[tuple] = []

    def count_files_pending_scan(self, *, share_id, **_k):
        del share_id
        if self._pending < 0:
            raise RuntimeError("셀 수 없다")
        return self._pending

    def share_set_status(self, share_id, status, **fields):
        self.calls.append((share_id, status, fields))

    def smb_share_ensure_open_exposure_finding(self, share_id, *, status):
        del share_id, status
        return None


@pytest.fixture
def closed(monkeypatch):
    def _go(pending: int, *, saw_submit: bool = True):
        # ⚠️ `_close_queue` 는 함수 안에서 `from service import state_domain` 를 한다 —
        #    그건 패키지 **속성**을 읽으므로 sys.modules 교체로는 안 바뀐다.
        #    실제 모듈의 함수를 갈아끼운다.
        from service import state_domain as real

        st = _State(pending)
        for name in ("count_files_pending_scan", "share_set_status",
                     "smb_share_ensure_open_exposure_finding"):
            monkeypatch.setattr(real, name, getattr(st, name))
        monkeypatch.setattr(ic, "_shares_of", lambda _spec: [7])
        monkeypatch.setattr(
            "_shared.queue_ownership.is_delegated_inspector", lambda: False)
        ic._close_queue({}, saw_submit=saw_submit)
        return st
    return _go


def test_a_drained_share_keeps_the_seven_day_cycle(closed):
    """진짜로 다 훑었으면 예전 그대로 — 7일 주기를 당기지 않는다."""
    st = closed(pending=0)
    _sid, status, fields = st.calls[0]
    assert status == "triaged_completed"
    assert "retry_after" not in fields


def test_a_share_with_files_left_comes_back_soon(closed):
    """★ 6만 8천 건이 일주일씩 기다리던 자리."""
    st = closed(pending=1234)
    _sid, status, fields = st.calls[0]
    assert status == "triaged_completed", "상태 어휘는 바꾸지 않는다"
    assert fields["retry_after"] > time.time()
    assert fields["retry_after"] < time.time() + 7 * 86400, "7일보다 빨라야 의미가 있다"
    assert fields["retry_after"] <= time.time() + ic._RESCAN_SOON_SECONDS + 5


def test_counting_failure_falls_back_to_the_old_cycle(closed):
    """못 세면 예전 동작으로 — 모르는 채로 큐를 재촉하지 않는다(fail-safe)."""
    st = closed(pending=-1)
    _sid, _status, fields = st.calls[0]
    assert "retry_after" not in fields


def test_verdict_and_queue_are_separate_facts(closed):
    """제출이 없어도(hits_count=0) 큐가 남았으면 다시 온다 — 서로 다른 사실이다."""
    st = closed(pending=50, saw_submit=False)
    _sid, _status, fields = st.calls[0]
    assert fields["hits_count"] == 0
    assert "retry_after" in fields


# ── 권고는 검토원이 실제로 한 일을 반영한다 (#3c) ──────────────────────────
#
# 리드의 `set_target_status` 는 권고와 다르게 닫으려면 근거를 요구한다. 그래서
# 아무것도 못 한 검토원이 "완료" 를 권고하면 리드가 그걸 따르도록 압박받는다 —
# 판단이 아니라 관성이다. 실측 2026-08-28: `clean` 131건 중 56건(43%)이 파일을
# 한 번도 안 연 세션이었다.

import json as _json

from _shared.inspector_report import REPORT_FILENAME


@pytest.fixture
def delegated(monkeypatch, tmp_path):
    """위임된 검토원으로 만들고, 남긴 권고를 돌려준다."""
    def _go(looked_files, *, saw_submit: bool):
        if looked_files is not None:
            (tmp_path / REPORT_FILENAME).write_text(
                _json.dumps({"verdict": "clean",
                             "looked_at": {"files": looked_files, "bytes": 0,
                                           "source": "code"}}),
                encoding="utf-8")
        monkeypatch.setattr(ic, "_shares_of", lambda _spec: [11])
        monkeypatch.setattr(
            "_shared.queue_ownership.is_delegated_inspector", lambda: True)
        ic._close_queue({}, saw_submit=saw_submit, evidence_dir=tmp_path)
        return _json.loads(
            (tmp_path / "recommended_status.json").read_text(encoding="utf-8"))
    return _go


def test_an_inspector_that_opened_nothing_does_not_recommend_completed(delegated):
    """★ 못 본 것을 '완료' 로 권고하지 않는다 — 큐로 되돌린다."""
    rec = delegated(0, saw_submit=False)
    assert rec["recommended_status"] == "walked"
    assert "하나도 열지 못했다" in rec["reason"]
    assert rec["looked_at_files"] == 0


def test_an_inspector_that_read_files_still_recommends_completed(delegated):
    """실제로 봤으면 예전 그대로 — 제출이 없어도 판정은 판정이다."""
    rec = delegated(37, saw_submit=False)
    assert rec["recommended_status"] == "triaged_completed"
    assert "37" in rec["reason"]


def test_a_submission_always_recommends_completed(delegated):
    """제출이 있으면 열람 수를 따지지 않는다 — 회귀 기준선."""
    rec = delegated(0, saw_submit=True)
    assert rec["recommended_status"] == "triaged_completed"
    assert rec["finding_count"] == 1


def test_a_missing_report_is_treated_as_having_read_nothing(delegated):
    """모르면 '봤다' 고 치지 않는다(fail-safe)."""
    rec = delegated(None, saw_submit=False)
    assert rec["recommended_status"] == "walked"
