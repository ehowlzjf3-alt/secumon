"""state.py pg 커넥션 풀: env 화된 크기 + checkout 대기 관찰(로그) 검증.

실 DB/네트워크 없이 psycopg_pool.ConnectionPool 과 pool.connection() 을 fake 로
주입해 결정론적으로 검증한다. (v3.79 perf-cache: SA_PG_POOL_* env + 관찰)
"""
from __future__ import annotations

import logging
from contextlib import contextmanager

import pytest

from secu_agent import state


# ---------------------------------------------------------------------------
# env 파서 헬퍼
# ---------------------------------------------------------------------------
def test_env_int_default_when_unset(monkeypatch):
    monkeypatch.delenv("SA_PG_POOL_MAX_SIZE", raising=False)
    assert state._env_int("SA_PG_POOL_MAX_SIZE", 10) == 10


def test_env_int_override(monkeypatch):
    monkeypatch.setenv("SA_PG_POOL_MAX_SIZE", "25")
    assert state._env_int("SA_PG_POOL_MAX_SIZE", 10) == 25


def test_env_int_bad_value_falls_back(monkeypatch):
    monkeypatch.setenv("SA_PG_POOL_MAX_SIZE", "not-a-number")
    assert state._env_int("SA_PG_POOL_MAX_SIZE", 10) == 10


def test_env_int_below_minimum_falls_back(monkeypatch):
    monkeypatch.setenv("SA_PG_POOL_MAX_SIZE", "0")
    assert state._env_int("SA_PG_POOL_MAX_SIZE", 10, minimum=1) == 10


def test_env_float_override_and_default(monkeypatch):
    monkeypatch.delenv("SA_PG_POOL_WAIT_WARN_SEC", raising=False)
    assert state._pg_pool_wait_warn_sec() == pytest.approx(1.0)
    monkeypatch.setenv("SA_PG_POOL_WAIT_WARN_SEC", "0.25")
    assert state._pg_pool_wait_warn_sec() == pytest.approx(0.25)


def test_env_float_bad_value_falls_back(monkeypatch):
    monkeypatch.setenv("SA_PG_POOL_WAIT_WARN_SEC", "abc")
    assert state._env_float("SA_PG_POOL_WAIT_WARN_SEC", 1.0) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# _pg_pool(): env 값이 ConnectionPool 로 전달되는지 (fake pool 주입)
# ---------------------------------------------------------------------------
class _FakePool:
    def __init__(self, conninfo, *, min_size, max_size, open, kwargs, configure=None, reset=None):
        self.conninfo = conninfo
        self.min_size = min_size
        self.max_size = max_size
        self.opened = open
        self.kwargs = kwargs
        self.configure = configure  # v3.88: baseline search_path 콜백
        self.reset = reset          # v3.88 R2: check-in 재정규화 콜백
        self.closed = False

    def close(self):
        self.closed = True


@pytest.fixture
def _fake_connectionpool(monkeypatch):
    import psycopg_pool

    monkeypatch.setattr(psycopg_pool, "ConnectionPool", _FakePool)
    monkeypatch.setenv("SECU_AGENT_PG_DSN", "postgresql://u:p@h:5432/db")
    # 각 테스트가 깨끗한 전역 풀에서 시작하도록.
    monkeypatch.setattr(state, "_PG_POOL", None, raising=False)
    yield
    state._PG_POOL = None


def test_pg_pool_uses_env_sizes(monkeypatch, _fake_connectionpool):
    monkeypatch.setenv("SA_PG_POOL_MAX_SIZE", "17")
    monkeypatch.setenv("SA_PG_POOL_MIN_SIZE", "3")
    pool = state._pg_pool()
    assert pool.max_size == 17
    assert pool.min_size == 3
    # autocommit 커넥션 계약 보존.
    assert pool.kwargs == {"autocommit": True}
    assert pool.opened is True
    # v3.88: baseline search_path 를 고정하는 configure 콜백이 배선돼야 한다.
    assert pool.configure is state._pg_configure
    # v3.88 R2: check-in 재정규화 reset 콜백도 배선돼야 한다(누수 lock/search_path 회수).
    assert pool.reset is state._pg_reset


def test_pg_pool_default_sizes(monkeypatch, _fake_connectionpool):
    monkeypatch.delenv("SA_PG_POOL_MAX_SIZE", raising=False)
    monkeypatch.delenv("SA_PG_POOL_MIN_SIZE", raising=False)
    pool = state._pg_pool()
    assert pool.max_size == state._PG_POOL_MAX_SIZE_DEFAULT == 10
    assert pool.min_size == state._PG_POOL_MIN_SIZE_DEFAULT == 1


def test_pg_pool_min_clamped_to_max(monkeypatch, _fake_connectionpool):
    monkeypatch.setenv("SA_PG_POOL_MAX_SIZE", "4")
    monkeypatch.setenv("SA_PG_POOL_MIN_SIZE", "9")
    pool = state._pg_pool()
    assert pool.max_size == 4
    assert pool.min_size == 4  # min > max 이면 max 로 clamp


# ---------------------------------------------------------------------------
# _connect_postgres(): checkout 대기 관찰 로그
# ---------------------------------------------------------------------------
class _FakeRaw:
    def __init__(self):
        self.autocommit = False

    def execute(self, *a, **k):  # pragma: no cover - schema 부트스트랩 스킵됨
        return None


class _FakeConnPool:
    """pool.connection() 을 context manager 로 흉내내고 get_stats 제공."""

    def __init__(self):
        self.entered = 0
        self.exited = 0
        self.raw = _FakeRaw()

    @contextmanager
    def connection(self):
        self.entered += 1
        try:
            yield self.raw
        finally:
            self.exited += 1

    def get_stats(self):
        return {
            "pool_size": 10,
            "pool_available": 0,
            "requests_waiting": 3,
            "pool_max": 10,
        }


def _patch_monotonic(monkeypatch, values):
    it = iter(values)
    last = [values[-1]]

    def fake():
        try:
            last[0] = next(it)
        except StopIteration:
            pass
        return last[0]

    monkeypatch.setattr(state.time, "monotonic", fake)


def test_connect_logs_when_checkout_wait_exceeds_threshold(monkeypatch, caplog):
    fake_pool = _FakeConnPool()
    monkeypatch.setattr(state, "_pg_pool", lambda: fake_pool)
    monkeypatch.setattr(state, "_PG_SCHEMA_READY", True, raising=False)
    monkeypatch.setenv("SA_PG_POOL_WAIT_WARN_SEC", "1.0")
    # 진입 전 0.0, 진입 후 2.5 → 대기 2.5s ≥ 1.0 임계.
    _patch_monotonic(monkeypatch, [0.0, 2.5])

    with caplog.at_level(logging.WARNING, logger=state.log.name):
        with state._connect_postgres() as conn:
            assert isinstance(conn, state._PgConn)

    assert fake_pool.exited == 1  # 연결이 풀에 반환됨
    assert any("checkout 대기" in r.getMessage() for r in caplog.records)


def test_connect_no_log_when_under_threshold(monkeypatch, caplog):
    fake_pool = _FakeConnPool()
    monkeypatch.setattr(state, "_pg_pool", lambda: fake_pool)
    monkeypatch.setattr(state, "_PG_SCHEMA_READY", True, raising=False)
    monkeypatch.setenv("SA_PG_POOL_WAIT_WARN_SEC", "1.0")
    _patch_monotonic(monkeypatch, [0.0, 0.05])  # 0.05s < 1.0 임계

    with caplog.at_level(logging.WARNING, logger=state.log.name):
        with state._connect_postgres() as conn:
            assert isinstance(conn, state._PgConn)

    assert fake_pool.exited == 1
    assert not any("checkout 대기" in r.getMessage() for r in caplog.records)


def test_connect_returns_connection_even_on_body_exception(monkeypatch):
    """with-body 예외에도 finally 가 연결을 풀에 반환하고 예외를 전파해야 한다."""
    fake_pool = _FakeConnPool()
    monkeypatch.setattr(state, "_pg_pool", lambda: fake_pool)
    monkeypatch.setattr(state, "_PG_SCHEMA_READY", True, raising=False)
    monkeypatch.setenv("SA_PG_POOL_WAIT_WARN_SEC", "0")  # 관찰 비활성
    _patch_monotonic(monkeypatch, [0.0, 0.0])

    with pytest.raises(RuntimeError, match="boom"):
        with state._connect_postgres():
            raise RuntimeError("boom")

    assert fake_pool.exited == 1  # 예외에도 반환됨
