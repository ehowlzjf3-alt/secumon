"""runner._evidence_size_mb throttle + fail-safe 검증.

목표(perf/safety):
- 매 tool 완료마다 evidence dir 전체 walk를 하지 않고 interval 내에서는 캐시 재사용.
- walk 실패 시 조용히 0을 돌려 size cap을 무력화하지 않고 last-known 값 유지.
- SA_EVIDENCE_SIZE_SCAN_INTERVAL_SEC override.

DB/네트워크/실제 subprocess/sleep 없음 — monkeypatch로 time/walk를 주입.
"""
from __future__ import annotations

import secu_agent.agent.harness.runner as runner


def _make_harness(tmp_path):
    return runner.GuardedHarness(
        client=None,
        registry=None,
        evidence_dir=tmp_path,
    )


def _fake_clock():
    state = {"t": 1000.0}

    def now():
        return state["t"]

    return state, now


def test_throttle_reuses_cache_within_interval(tmp_path, monkeypatch):
    """interval 안에서는 재-walk하지 않고 캐시를 재사용한다."""
    state, now = _fake_clock()
    monkeypatch.setattr(runner.time, "monotonic", now)

    calls = {"n": 0}

    def fake_scan(path):
        calls["n"] += 1
        return 5.0

    monkeypatch.setattr(runner, "_dir_size_mb", fake_scan)

    h = _make_harness(tmp_path)
    h._dir_scan_interval_sec = 10.0

    # 첫 호출: 캐시 없음 → 스캔
    assert h._evidence_size_mb() == 5.0
    assert calls["n"] == 1

    # interval 내 반복 호출: 캐시 재사용, 추가 walk 없음
    state["t"] += 3.0
    assert h._evidence_size_mb() == 5.0
    state["t"] += 6.0  # 총 9s < 10s
    assert h._evidence_size_mb() == 5.0
    assert calls["n"] == 1


def test_rescan_after_interval(tmp_path, monkeypatch):
    """interval 경과 후에는 다시 walk 하고 새 값을 반영한다."""
    state, now = _fake_clock()
    monkeypatch.setattr(runner.time, "monotonic", now)

    sizes = iter([5.0, 42.0])

    def fake_scan(path):
        return next(sizes)

    monkeypatch.setattr(runner, "_dir_size_mb", fake_scan)

    h = _make_harness(tmp_path)
    h._dir_scan_interval_sec = 10.0

    assert h._evidence_size_mb() == 5.0
    state["t"] += 11.0  # interval 초과
    assert h._evidence_size_mb() == 42.0


def test_scan_error_returns_last_known_not_zero(tmp_path, monkeypatch):
    """walk 실패 시 0이 아니라 마지막으로 알려진 값을 돌려 cap을 지킨다."""
    state, now = _fake_clock()
    monkeypatch.setattr(runner.time, "monotonic", now)

    def boom(path):
        raise OSError("permission denied")

    monkeypatch.setattr(runner, "_dir_size_mb", boom)

    h = _make_harness(tmp_path)
    h._dir_scan_interval_sec = 10.0
    # 이전에 알려진 큰 값 (cap을 넘긴 상태를 흉내)
    h._last_dir_size_mb = 999.0
    h._last_dir_scan_ts = None  # 강제로 스캔 시도

    used = h._evidence_size_mb()
    assert used == 999.0  # NOT 0.0 — cap이 조용히 뚫리지 않음


def test_scan_error_throttles_retry(tmp_path, monkeypatch):
    """에러 후에도 throttle이 걸려 매 호출마다 walk를 재시도하지 않는다."""
    state, now = _fake_clock()
    monkeypatch.setattr(runner.time, "monotonic", now)

    calls = {"n": 0}

    def boom(path):
        calls["n"] += 1
        raise OSError("io error")

    monkeypatch.setattr(runner, "_dir_size_mb", boom)

    h = _make_harness(tmp_path)
    h._dir_scan_interval_sec = 10.0
    h._last_dir_scan_ts = None

    h._evidence_size_mb()
    h._evidence_size_mb()  # interval 내 재호출
    assert calls["n"] == 1  # 재시도는 interval 이후에만


def test_dir_size_mb_sums_real_files(tmp_path):
    """실제 파일 크기를 합산한다 (MB 단위)."""
    (tmp_path / "a.bin").write_bytes(b"x" * (1024 * 1024))  # 1 MiB
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "b.bin").write_bytes(b"y" * (1024 * 1024))  # 1 MiB

    mb = runner._dir_size_mb(tmp_path)
    assert abs(mb - 2.0) < 0.01


def test_dir_size_mb_propagates_walk_error(tmp_path, monkeypatch):
    """walk 자체가 실패하면 0을 삼키지 않고 OSError를 전파한다."""
    def bad_rglob(pattern):
        raise OSError("cannot list")

    monkeypatch.setattr(runner.Path, "rglob", lambda self, pattern: bad_rglob(pattern))

    import pytest
    with pytest.raises(OSError):
        runner._dir_size_mb(tmp_path)


def test_read_scan_interval_env_override(monkeypatch):
    monkeypatch.setenv("SA_EVIDENCE_SIZE_SCAN_INTERVAL_SEC", "2.5")
    assert runner._read_scan_interval_sec() == 2.5


def test_read_scan_interval_default_and_bad_values(monkeypatch):
    monkeypatch.delenv("SA_EVIDENCE_SIZE_SCAN_INTERVAL_SEC", raising=False)
    assert runner._read_scan_interval_sec() == 10.0

    monkeypatch.setenv("SA_EVIDENCE_SIZE_SCAN_INTERVAL_SEC", "not-a-number")
    assert runner._read_scan_interval_sec() == 10.0  # 안전 기본값 fallback

    monkeypatch.setenv("SA_EVIDENCE_SIZE_SCAN_INTERVAL_SEC", "-5")
    assert runner._read_scan_interval_sec() == 10.0  # 음수 → 기본값

    monkeypatch.setenv("SA_EVIDENCE_SIZE_SCAN_INTERVAL_SEC", "0")
    assert runner._read_scan_interval_sec() == 0.0  # 0 = throttle 해제 허용
