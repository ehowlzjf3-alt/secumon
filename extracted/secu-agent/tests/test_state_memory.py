"""memory_rule state-layer 테스트.

scope-based 영속 룰. master agent 가 share 시작 시 recall, 끝날 때 save.
- scope: 'host' (key=IP), 'share' (key='host:share'),
  'path_pattern' (key=부분 매칭 토큰), 'global' (key='*')
- severity_hint: optional bias (informational/clean/high/critical)
"""
from __future__ import annotations

import time

import pytest


@pytest.fixture(autouse=True)
def _register_domain_scopes():
    """de-domain v3.84 #5: host/share/path_pattern 은 이제 plugin 등록형 scope 다
    (코어 base = global/operator). 이 모듈은 도메인이 그 scope 를 등록한 상황을
    시뮬레이션해 memory 스코핑 메커니즘을 검증한다 (register/unregister 로 격리)."""
    from secu_agent import state
    for s in ("host", "share", "path_pattern"):
        state.register_memory_scope(s)
    yield
    for s in ("host", "share", "path_pattern"):
        state.unregister_memory_scope(s)


def test_memory_add_and_get(tmp_db):
    from secu_agent import state

    mid = state.memory_add(
        scope="host", key="1.2.3.4",
        rule="이 host 의 print$ 는 known good — 표준 driver share",
        severity_hint="informational",
        tags=["known_good", "print_dollar"],
        source="operator",
    )
    assert isinstance(mid, int) and mid > 0

    row = state.memory_get(mid)
    assert row["scope"] == "host"
    assert row["key"] == "1.2.3.4"
    assert "known good" in row["rule"]
    assert row["severity_hint"] == "informational"
    assert "known_good" in row["tags"]
    assert row["source"] == "operator"
    assert row["hit_count"] == 0


def test_memory_add_rejects_invalid_scope(tmp_db):
    from secu_agent import state
    with pytest.raises(ValueError):
        state.memory_add(scope="invalid", key="x", rule="x")


def test_scope_registry_open_for_other_domains(tmp_db):
    """de-domain v3.84 #5: 코어 base(global/operator) 밖 scope 는 등록 전엔 거부,
    register_memory_scope 후 허용 — 비-점검 도메인 어댑터도 자기 scope 를 쓸 수 있다
    (코어가 점검 scope 만 강제하던 누출 제거). 'repo' 는 autouse 픽스처 미등록 scope."""
    from secu_agent import state
    assert "repo" not in state.valid_memory_scopes()
    with pytest.raises(ValueError):
        state.memory_add(scope="repo", key="k", rule="r")
    state.register_memory_scope("repo")
    try:
        assert "repo" in state.valid_memory_scopes()
        mid = state.memory_add(scope="repo", key="k", rule="r")
        assert mid > 0
    finally:
        state.unregister_memory_scope("repo")
    # 해제 후 다시 거부 (코어 base 는 불변)
    assert {"global", "operator"} <= state.valid_memory_scopes()
    with pytest.raises(ValueError):
        state.memory_add(scope="repo", key="k2", rule="r")


def test_memory_add_rejects_invalid_severity_hint(tmp_db):
    from secu_agent import state
    with pytest.raises(ValueError):
        state.memory_add(scope="host", key="x", rule="x",
                         severity_hint="purple")


def test_memory_search_by_scope(tmp_db):
    from secu_agent import state

    state.memory_add(scope="host", key="1.1.1.1", rule="A")
    state.memory_add(scope="host", key="2.2.2.2", rule="B")
    state.memory_add(scope="global", key="*", rule="C")

    hosts = state.memory_search(scope="host")
    assert {r["key"] for r in hosts} == {"1.1.1.1", "2.2.2.2"}

    all_rules = state.memory_search()
    assert len(all_rules) == 3


def test_memory_touch_increments_hit_count(tmp_db):
    from secu_agent import state
    mid = state.memory_add(scope="global", key="*", rule="r")
    state.memory_touch(mid)
    state.memory_touch(mid)
    assert state.memory_get(mid)["hit_count"] == 2


def test_memory_delete(tmp_db):
    from secu_agent import state
    mid = state.memory_add(scope="host", key="1.1.1.1", rule="r")
    assert state.memory_delete(mid) is True
    assert state.memory_get(mid) is None
    assert state.memory_delete(mid) is False


def test_memory_add_upserts_on_same_scope_key(tmp_db):
    """같은 (scope, key) 로 add 하면 기존 룰 update — 룰 누적이 아니라 최신화."""
    from secu_agent import state

    mid1 = state.memory_add(scope="host", key="1.1.1.1",
                            rule="old", severity_hint="low")
    mid2 = state.memory_add(scope="host", key="1.1.1.1",
                            rule="new — updated rule",
                            severity_hint="informational",
                            tags=["dev"])
    assert mid1 == mid2
    row = state.memory_get(mid1)
    assert "new" in row["rule"]
    assert row["severity_hint"] == "informational"
    assert "dev" in row["tags"]


def test_memory_expires_at_filters_out_expired(tmp_db):
    from secu_agent import state
    past = time.time() - 60
    future = time.time() + 3600
    state.memory_add(scope="host", key="1.1.1.1", rule="expired",
                     expires_at=past)
    state.memory_add(scope="host", key="2.2.2.2", rule="active",
                     expires_at=future)
    state.memory_add(scope="host", key="3.3.3.3", rule="forever")

    rows = state.memory_search(scope="host")
    keys = {r["key"] for r in rows}
    assert "1.1.1.1" not in keys
    assert "2.2.2.2" in keys
    assert "3.3.3.3" in keys
