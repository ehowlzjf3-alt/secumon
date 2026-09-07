"""병합이 진행한 스레드를 draft 로 되돌리지 않는다.

배경 (2026-08-28 실측): `dev_web_report_thread` 에 **발송을 52회 시도한 스레드가
status=draft** 로 앉아 있었다. 원인은 `_dev_web_report_thread_upsert` 의 merged 분기가
`status=?` 를 무조건 대입하는데, 그 인자의 기본값이 "draft" 이고 유일한 운영 호출부
(`dev_web_submit_finding_tool`)가 언제나 그 값을 넘긴다는 것이었다.

merged 분기는 **같은 target 에 finding 이 하나 더 붙을 때** 탄다 — 한 사이트에서
발견이 여러 건 나오는 흔한 경우다. 후보 SELECT 는 terminal(remediated/closed) 을 뺀
**전부**를 잡으므로 `reported`·`awaiting_reply` 스레드도 여기로 들어와 강등됐다.

바로 위 dup 분기(같은 finding_id)가 status 를 아예 안 건드린다 — 그게 설계 의도의
증거다. 병합은 "같은 대상에 finding 이 하나 더 붙었다" 이지 "처음부터 다시" 가 아니다.
"""
from __future__ import annotations

import datetime as dt

import pytest

from service import state_domain as sd


def _today() -> str:
    return dt.date.today().isoformat()


def _thread(thread_id: int) -> dict:
    with sd.connect() as c:
        row = c.execute(
            "SELECT * FROM dev_web_report_thread WHERE id=?", (thread_id,)
        ).fetchone()
    return dict(row)


def _target(slug: str) -> int:
    return sd.dev_web_target_upsert(
        f"https://{slug}.example.test", source="manual", day_bucket=_today(),
    )


@pytest.mark.parametrize(
    "progressed",
    ["reported", "awaiting_reply", "escalated", "owner_update_needed", "reassigned"],
)
def test_merge_does_not_regress_a_progressed_thread(tmp_db, progressed):
    """진행한 스레드에 새 finding 이 붙어도 상태를 잃지 않는다."""
    target_id = _target(f"regress-{progressed}")
    action, thread_id = sd.dev_web_report_thread_upsert(
        target_id=target_id, finding_id=901,
        domain=f"regress-{progressed}.example.test",
        url=f"https://regress-{progressed}.example.test",
        status=progressed,
    )
    assert action == "new"

    # 같은 target 에 **다른** finding 이 붙는다 — merged 분기.
    action, merged_id = sd.dev_web_report_thread_upsert(
        target_id=target_id, finding_id=902,
        domain=f"regress-{progressed}.example.test",
        url=f"https://regress-{progressed}.example.test",
        status="draft",   # 생성 기본값. 운영 호출부가 언제나 이걸 넘긴다.
    )
    assert action == "merged"
    assert merged_id == thread_id
    assert _thread(thread_id)["status"] == progressed


def test_merge_still_carries_the_new_finding_and_severity(tmp_db):
    """상태를 지키는 것이 병합 자체를 막는다는 뜻은 아니다."""
    target_id = _target("carry")
    _, thread_id = sd.dev_web_report_thread_upsert(
        target_id=target_id, finding_id=911,
        domain="carry.example.test", url="https://carry.example.test",
        status="reported", severity="low",
    )
    action, _ = sd.dev_web_report_thread_upsert(
        target_id=target_id, finding_id=912,
        domain="carry.example.test", url="https://carry.example.test",
        status="draft", severity="critical",
        report_json={"summary": "새 발견"},
    )
    assert action == "merged"
    row = _thread(thread_id)
    assert row["status"] == "reported"          # 진행 상태 보존
    assert row["finding_id"] == 912             # 새 finding 반영
    assert row["severity"] == "critical"        # 심각도는 나쁜 쪽으로 병합
    assert "새 발견" in str(row["report_json"])


def test_draft_thread_still_takes_the_incoming_status(tmp_db):
    """아직 draft 인 스레드는 인자를 그대로 받는다 — 파라미터의 의미를 죽이지 않는다."""
    target_id = _target("draft")
    _, thread_id = sd.dev_web_report_thread_upsert(
        target_id=target_id, finding_id=921,
        domain="draft.example.test", url="https://draft.example.test",
        status="draft",
    )
    action, _ = sd.dev_web_report_thread_upsert(
        target_id=target_id, finding_id=922,
        domain="draft.example.test", url="https://draft.example.test",
        status="escalated",
    )
    assert action == "merged"
    assert _thread(thread_id)["status"] == "escalated"


def test_same_finding_still_never_touches_status(tmp_db):
    """dup 분기의 기존 동작 — 회귀 기준선."""
    target_id = _target("dup")
    _, thread_id = sd.dev_web_report_thread_upsert(
        target_id=target_id, finding_id=931,
        domain="dup.example.test", url="https://dup.example.test",
        status="awaiting_reply",
    )
    action, dup_id = sd.dev_web_report_thread_upsert(
        target_id=target_id, finding_id=931,
        domain="dup.example.test", url="https://dup.example.test",
        status="draft",
    )
    assert action == "dup"
    assert dup_id == thread_id
    assert _thread(thread_id)["status"] == "awaiting_reply"
