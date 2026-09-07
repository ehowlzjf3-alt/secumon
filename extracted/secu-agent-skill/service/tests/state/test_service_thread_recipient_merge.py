"""space/저장소 스레드의 수신처는 덮어쓰지 않고 합친다.

배경 (2026-08-28 실측): `confluence_report_thread` id 2·4 의 `attempt_count` 가
**60초마다 정확히 +2** 씩 올라 541 에 닿아 있었다. `status`·`finding_ids`·`severity` 는
불변인데 attempt 만 올랐다.

원인은 이렇다. report 스레드는 **space(또는 저장소) 단위**라 finding 여러 개를 모은다.
그런데 upsert 가 이번 finding 의 담당자를 스레드에 **그대로 덮어썼다.** 담당자가 다른
두 finding 이 한 스레드를 공유하면 매 패스마다 서로 덮어쓰고, 재개 가드가 그 차이를
"리포트 내용이 바뀌었다" 로 읽어 `report_ready` → `reported` 로 되돌린다.

    thread 2 (MASKResist)  36576 → hs3h.choi, kh93.park
                           36577 → kh93.park

합집합으로 두면 각 finding 의 담당자는 이미 포함된 부분집합이라 "바뀐 게 없다" 가 된다.
그리고 부수 효과가 하나 더 있다 — **아무도 수신처에서 빠지지 않는다.** 마지막에 쓴
finding 의 담당자만 남던 예전 동작은 나머지 담당자를 조용히 지우고 있었다.

⚠️ github 이 같은 구조인데 안 싸운 건 한 저장소의 finding 들이 담당자가 같아서지
   설계가 달라서가 아니다. 두 도메인을 같은 계약으로 묶는다.
"""
from __future__ import annotations

import pytest

from service import state_domain as sd


def test_merge_helper_is_a_sorted_union():
    """정렬은 필수다 — 순서가 흔들리면 그 자체가 '바뀌었다' 로 읽힌다."""
    merged, grew = sd._merge_service_recipients("b@x.test, a@x.test", "c@x.test")
    assert merged == "a@x.test, b@x.test, c@x.test"
    assert grew is True


def test_merge_helper_reports_no_growth_for_a_subset():
    """★ 순환을 멈추는 핵심 — 이미 포함된 담당자는 '변화 없음' 이다."""
    merged, grew = sd._merge_service_recipients("a@x.test, b@x.test", "b@x.test")
    assert merged == "a@x.test, b@x.test"
    assert grew is False


def test_merge_helper_keeps_stored_when_incoming_is_empty():
    merged, grew = sd._merge_service_recipients("a@x.test", None)
    assert merged == "a@x.test"
    assert grew is False
    assert sd._merge_service_recipients(None, None) == (None, False)


@pytest.mark.parametrize(
    ("upsert", "getter", "key"),
    [
        pytest.param("confluence_report_thread_upsert",
                     "confluence_report_thread_get", "space_key", id="confluence"),
        pytest.param("github_report_thread_upsert",
                     "github_report_thread_get", "repo", id="github"),
    ],
)
def test_two_findings_with_different_owners_stop_fighting(tmp_db, upsert, getter, key):
    """★ 재현 테스트 — 담당자가 다른 두 finding 이 한 스레드를 공유해도 진동하지 않는다."""
    do_upsert = getattr(sd, upsert)
    do_get = getattr(sd, getter)
    scope = {key: "OSCILLATE"}

    _, thread_id = do_upsert(
        finding_id=9001, severity="high",
        recipient="a@x.test, b@x.test", owner_recipient="a@x.test, b@x.test",
        **scope,
    )
    do_upsert(
        finding_id=9002, severity="medium",
        recipient="b@x.test", owner_recipient="b@x.test",
        **scope,
    )
    # 발송까지 끝났다고 치고 파킹한다.
    getattr(sd, f"{upsert.rsplit('_upsert', 1)[0]}_set_status")(
        thread_id, "report_ready")

    before = do_get(thread_id)
    assert before["status"] == "report_ready"

    # 다음 패스가 두 finding 을 다시 훑는다 — 예전엔 여기서 둘이 서로 덮어썼다.
    for _ in range(3):
        do_upsert(finding_id=9001, severity="high",
                  recipient="a@x.test, b@x.test",
                  owner_recipient="a@x.test, b@x.test", **scope)
        do_upsert(finding_id=9002, severity="medium",
                  recipient="b@x.test", owner_recipient="b@x.test", **scope)

    after = do_get(thread_id)
    assert after["status"] == "report_ready", "파킹이 풀렸다 — 순환이 살아 있다"
    assert after["attempt_count"] == before["attempt_count"], (
        f"attempt 가 올랐다 {before['attempt_count']} -> {after['attempt_count']}"
    )
    # 아무도 빠지지 않는다.
    assert after["owner_recipient"] == "a@x.test, b@x.test"


@pytest.mark.parametrize(
    ("upsert", "getter", "key"),
    [
        pytest.param("confluence_report_thread_upsert",
                     "confluence_report_thread_get", "space_key", id="confluence"),
        pytest.param("github_report_thread_upsert",
                     "github_report_thread_get", "repo", id="github"),
    ],
)
def test_a_genuinely_new_owner_still_reopens_the_report(tmp_db, upsert, getter, key):
    """가드를 죽이면 안 된다 — **진짜로 새 담당자가 붙으면** 리포트를 다시 연다."""
    do_upsert = getattr(sd, upsert)
    do_get = getattr(sd, getter)
    scope = {key: "REOPEN"}

    _, thread_id = do_upsert(
        finding_id=9101, severity="high",
        recipient="a@x.test", owner_recipient="a@x.test", **scope,
    )
    getattr(sd, f"{upsert.rsplit('_upsert', 1)[0]}_set_status")(
        thread_id, "report_ready")

    do_upsert(finding_id=9101, severity="high",
              recipient="a@x.test, new@x.test",
              owner_recipient="a@x.test, new@x.test", **scope)

    after = do_get(thread_id)
    assert after["status"] == "reported", "새 담당자가 붙었는데 리포트를 안 다시 열었다"
    assert after["owner_recipient"] == "a@x.test, new@x.test"
