"""fanout 어댑터가 런 시작에 stale claim 을 회수한다 (2026-08-22).

## 무엇이 있었나

코어 `FanoutAdapter.release` 의 계약 주석은 이렇게 적혀 있다 —

    "예외는 로그만 (**stale reclaim 백스톱이 회수**)"

그 백스톱이 **아무 데서도 안 불렸다.** `devops_reclaim_stale_claims` 는 v3.80 Slice0b 에
함수와 테스트만 만들어지고 런타임 호출부가 0 이었다(형제 `web_reclaim_stale_claims` ·
`dev_web_reclaim_stale_claims` 도 같다).

실측: `platform.devops_target` 에 2026-06-02 에 claim 된 `in_progress` 98건이 2.5개월째
남아 있었다. claim_next 의 시간-stale 분기가 회수하긴 하는데, **cycle_key 를 지정한 claim 은
`cycle_key=?` 를 요구**해서 사이클이 없는 이 행들은 영영 안 잡힌다. 그동안 큐 카운트도
거짓말을 한다(in_progress 98 = "지금 98개가 돌고 있음"으로 읽힌다).

## 왜 factory 안인가

코어 `_resolve_adapter` 가 **phase 마다** factory 를 부른다(task_plan.py:136). 그래서
어댑터 인스턴스는 런당 하나고, 인스턴스 플래그 = 런당 1회다. 코어 프로토콜에 5번째 hook
(phase-entry)을 추가할 필요가 없다 — 그건 코어 변경이고, 여기서 필요 없다.
"""
from __future__ import annotations

import asyncio

import pytest


class _Store:
    """claim 은 항상 None(=줄 것 없음). 회수 호출만 센다."""

    def __init__(self, reclaimed: int = 3) -> None:
        self.reclaim_calls = 0
        self._reclaimed = reclaimed

    def reclaim_stale_sso_claims(self) -> int:
        self.reclaim_calls += 1
        return self._reclaimed

    def claim_sso_target(self, **_kw):
        return None


class _LegacyStore(_Store):
    """`reclaim_stale_sso_claims` 가 없는 구 store — 백스톱은 optional 이어야 한다."""

    reclaim_stale_sso_claims = None   # type: ignore[assignment]


def _adapters():
    # dev_web·github 은 빠졌다 — 두 평면 어댑터가 은퇴하면서(2026-08-28) 백스톱을
    # 부르던 호출부가 사라졌다. dev_web 은 대체물이 없어 아래
    # `test_dev_web_reclaim_says_it_lost_its_call_site` 가 그 사실을 지키고,
    # github 은 confluence 의 sso 레인이 같은 `devops_target` 을 계속 회수한다
    # (`devops_reclaim_stale_claims` 에 service 필터가 없다).
    from domains.services.confluence.application import fanout as cf
    return [("confluence", cf._make_sso_adapter)]


class _Services:
    def __init__(self, store) -> None:
        self.store = store
        self.runtime = None


@pytest.mark.parametrize("name,factory", _adapters(), ids=[n for n, _ in _adapters()])
def test_first_claim_runs_the_backstop_once(name, factory):
    store = _Store()
    adapter = factory(_Services(store))

    async def go():
        for _ in range(4):
            assert await adapter.claim_next() is None

    asyncio.run(go())
    assert store.reclaim_calls == 1, (
        f"{name}: claim 마다 회수하면 안 된다(런당 1회) — {store.reclaim_calls}회 불렸다")


@pytest.mark.parametrize("name,factory", _adapters(), ids=[n for n, _ in _adapters()])
def test_each_run_gets_a_fresh_backstop(name, factory):
    """factory 가 phase 마다 불리므로 새 런은 다시 회수해야 한다.

    클래스 속성으로 플래그를 두면서 factory 밖에 클래스를 두면 이게 깨진다 —
    두 번째 런이 첫 런의 플래그를 물려받아 영영 회수를 안 한다.
    """
    store = _Store()
    for _ in range(3):
        adapter = factory(_Services(store))
        asyncio.run(adapter.claim_next())
    assert store.reclaim_calls == 3, f"{name}: 런마다 1회여야 한다"


@pytest.mark.parametrize("name,factory", _adapters(), ids=[n for n, _ in _adapters()])
def test_store_without_the_backstop_still_claims(name, factory):
    """백스톱은 optional 이다 — 없다고 claim 이 죽으면 안 된다."""
    adapter = factory(_Services(_LegacyStore()))
    assert asyncio.run(adapter.claim_next()) is None


def test_reclaim_is_wired_on_both_state_gateways():
    """포트 구현이 실제로 코어 함수를 부르는지 — 이름만 있고 비어 있으면 안 된다."""
    import inspect

    from domains.services.confluence.infrastructure.runtime import ConfluenceStateGateway
    from domains.services.github.infrastructure.runtime import GithubStateGateway

    src = inspect.getsource(ConfluenceStateGateway.reclaim_stale_sso_claims)
    assert "devops_reclaim_stale_claims" in src

    # github 쪽은 호출부와 함께 지웠다 — 이름만 남기면 배선된 줄 안다.
    # `devops_target` 회수는 위 confluence 레인이 테이블 전체를 훑어 계속된다.
    assert not hasattr(GithubStateGateway, "reclaim_stale_sso_claims")
    assert not hasattr(GithubStateGateway, "claim_sso_target")


def test_dev_web_reclaim_says_it_lost_its_call_site():
    """★ 배선이 사라진 사실도 코드에 남아야 한다 — 위 web 케이스와 같은 이유다.

    `dev_web_reclaim_stale_claims` 의 유일한 호출부는 평면 task 팬아웃 어댑터였고,
    2026-08-28 에 그 레인이 은퇴하면서 함께 지워졌다. 리드가 쓰는
    ✅ 정정: 영구히 잠기지는 않는다 — 리드의 `claimable_statuses` 가 `in_progress` 를
       포함해 다음 패스가 다시 집는다. ⚠️ 다만 stale 임계 검사가 사라져서, 위험이
       "영원히 잠김" 에서 "아직 도는 검토원의 타깃을 다시 위임" 쪽으로 옮겼다.

    ⚠️ 포트 메서드(`DevWebStateGateway.reclaim_stale_task_claims`)도 함께 지웠다.
       이름만 남겨 두면 다음 사람이 "배선돼 있겠지" 하고 믿는다.
    """
    import inspect

    from domains.dev_web.infrastructure.runtime import DevWebStateGateway
    from service import state_domain as sd

    assert not hasattr(DevWebStateGateway, "reclaim_stale_task_claims"), (
        "호출부 없는 포트 메서드가 되살아났다"
    )
    doc = inspect.getdoc(sd.dev_web_reclaim_stale_claims) or ""
    assert "런타임 호출부가 없다" in doc, "배선을 잃은 이유가 코드에 없다"


def test_retired_web_reclaim_says_it_is_unwired():
    """★ 죽은 함수를 설명 없이 두면 다음 사람이 "배선돼 있겠지" 하고 믿는다.

    코어 `FanoutAdapter.release` 주석이 정확히 그랬다 — "stale reclaim 백스톱이 회수"
    라고 전제했는데 그 백스톱이 아무 데서도 안 불렸다.

    `web` 도메인은 은퇴했다(claim 호출부 0 · fanout 어댑터 없음 · 게이트웨이
    DOMAIN_TABLES 에도 없음). 그래서 `web_target_domain` 은 643행 중 537행(84%)이
    2026-06-01 부터 잠겨 있지만 아무도 안 읽어 영향이 없다. 배선하지 **않는다**는
    결정과 그 근거가 코드에 남아 있어야 한다.
    """
    import inspect

    from service import state_domain as sd

    doc = inspect.getdoc(sd.web_reclaim_stale_claims) or ""
    assert "런타임 소비자가 없다" in doc, "배선 안 한 이유가 코드에 없다"
    assert "은퇴" in doc
