"""dev_web 보고/재검증 패스가 claim 회수를 먼저 돈다 — **과거 주차**가 실제 차이다.

## 처음에 틀리게 짚었던 것

2026-08-24 실측: `dev_web_report_thread` 137건 중 claimed 66 · 24시간 초과 54 ·
최고령 45일. 같은 시점 github·confluence·smb 는 claimed 0. 그래서 "dev_web 만 회수를
안 불러 스레드가 영구히 잠긴다" 고 읽었다. **틀렸다.**

`dev_web_report_thread_claim_next` 는 `AND (claimed_at IS NULL OR claimed_at < cutoff)`
라 **묵은 claim 을 스스로 뺏는다.** 잠기지 않는다. 회수 호출을 빼고 테스트해도 통과한다 —
처음 쓴 테스트가 그래서 장식이었다.

## 진짜 차이

둘의 조건이 다르다:

    claim_next  : status · **last_cycle_key = 현재 주차** · claimed_at < cutoff
    reclaim     : claimed_at < cutoff                      ← 주차 조건 **없음**

그래서 **과거 주차의 묵은 claim 은 회수만 푼다.** claim_next 는 그 행을 아예 안 본다.
실측 분포가 정확히 그 모양이다 — W28 67건 중 54건이 claimed, W35 12건은 전부 claimed,
그 사이 주차(W30~W34)는 0.

주차 스코핑 자체는 설계다(github 도 `reported` 에 같은 필터를 건다). 고칠 것은 그게
아니라, 지나간 주차 행에 **죽은 워커의 이름이 영구히 박혀 있는 것**이다 — 그 컬럼을
읽는 사람이 "누가 지금 잡고 있다" 고 오해한다. 실제로 내가 그렇게 오해했다.

⚠️ 포트 메서드 `reclaim_stale_report_threads()` 는 3도메인에 정의돼 있고 **호출부가 0**이다.
   정의만 보고 "배선돼 있다" 고 읽으면 안 된다 — 도는 것은 각 에이전트의 직접 호출이다.
"""
from __future__ import annotations

import asyncio
import time

#: 죽은 워커의 세션 id. `claimed_by` 는 **bigint** 다(문자열 아님).
DEAD_WORKER = -999_999
#: 지나간 주차 — claim_next 가 원리적으로 안 보는 행.
PAST_CYCLE = "2026-W01"


def _past_cycle_stale_thread(tmp_db, *, status: str):
    from secu_agent import state as core_state
    from service import state_domain as state

    finding_id, _ = core_state.finding_upsert(
        task_type="dev_web", asset="https://stuck.example.test/api", asset_kind="url",
        severity="high", summary="s", evidence_ref="e://stuck",
    )
    _, thread_id = state.dev_web_report_thread_upsert(
        target_id=None, finding_id=finding_id, domain="stuck.example.test",
        url="https://stuck.example.test/api", severity="high", status=status,
    )
    state.dev_web_report_thread_set_status(
        thread_id, status,
        claimed_by=DEAD_WORKER,
        claimed_at=time.time() - 45 * 86400,
        last_cycle_key=PAST_CYCLE,
    )
    row = state.dev_web_report_thread_get(thread_id)
    assert row["claimed_by"] == DEAD_WORKER and row["last_cycle_key"] == PAST_CYCLE
    return thread_id


def test_report_pass_clears_a_dead_workers_claim_from_a_past_cycle(tmp_db) -> None:
    """claim_next 는 과거 주차를 안 본다 — 이 행을 푸는 것은 회수뿐이다."""
    from service import state_domain as state
    from service.agents import dev_web_report_agent

    thread_id = _past_cycle_stale_thread(tmp_db, status="reported")
    asyncio.run(dev_web_report_agent.run_report_pass(max_threads=1))

    row = state.dev_web_report_thread_get(thread_id)
    assert row is not None
    assert row["claimed_by"] is None, (
        "지나간 주차 행에 죽은 워커 이름이 그대로다 — 회수를 안 돌았다. "
        "claim_next 는 이 행을 보지 않으므로 영원히 남는다."
    )


def test_reverify_pass_clears_it_too(tmp_db) -> None:
    """재검증 패스도 같은 테이블을 집는다 — 한쪽만 회수하면 반만 낫는다."""
    from service import state_domain as state
    from service.agents import dev_web_reverify_agent

    thread_id = _past_cycle_stale_thread(tmp_db, status="reply_received")
    asyncio.run(dev_web_reverify_agent.run_reverify_pass(max_threads=1))

    row = state.dev_web_report_thread_get(thread_id)
    assert row is not None
    assert row["claimed_by"] is None
