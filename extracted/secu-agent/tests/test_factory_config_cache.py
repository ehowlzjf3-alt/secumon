"""v3.79-perf: make_role_client 의 실패-sentinel 캐시 검증.

misconfiguration(hot path) 에서 build_chat_client_from_profile(=YAML/dotenv
재파싱) 와 warning 이 매 호출 반복되지 않고 첫 실패 1회만 발생하는지 확인.
성공 경로의 process-lifetime 캐시(단일 인스턴스 재사용)도 함께 검증.

실제 subprocess/네트워크/DNS/DB 없이 build_chat_client_from_profile 를
monkeypatch 로 대체하는 순수 단위 테스트.
"""
from __future__ import annotations

import logging

import pytest

from secu_agent.agent.llm import factory


@pytest.fixture(autouse=True)
def _clean_caches():
    # 모듈 수준 캐시를 테스트마다 초기화 (프로세스 정적 캐시라 격리 필요).
    factory._role_client_cache.clear()
    factory._role_client_failed.clear()
    yield
    factory._role_client_cache.clear()
    factory._role_client_failed.clear()


def test_failure_path_parses_and_warns_only_once(monkeypatch, caplog):
    monkeypatch.setenv("SA_JUDGE_PROFILE", "does-not-exist")

    calls = {"n": 0}

    def _boom(profile_name: str):
        calls["n"] += 1
        raise KeyError(f"profile {profile_name!r} 없음")

    monkeypatch.setattr(factory, "build_chat_client_from_profile", _boom)

    default = object()

    with caplog.at_level(logging.WARNING, logger=factory.log.name):
        r1 = factory.make_role_client("judge", default=default)
        r2 = factory.make_role_client("judge", default=default)
        r3 = factory.make_role_client("judge", default=default)

    # fail-open: 항상 default 반환.
    assert r1 is default and r2 is default and r3 is default
    # 재파싱 없음: 실패 후 sentinel 로 단락 → build 는 딱 1회만.
    assert calls["n"] == 1
    # warning 은 첫 실패 1회만.
    warnings = [rec for rec in caplog.records if rec.levelno == logging.WARNING]
    assert len(warnings) == 1


def test_success_path_caches_single_instance(monkeypatch):
    monkeypatch.setenv("SA_JUDGE_PROFILE", "o4-mini")

    calls = {"n": 0}
    sentinel_client = object()

    def _ok(profile_name: str):
        calls["n"] += 1
        return sentinel_client

    monkeypatch.setattr(factory, "build_chat_client_from_profile", _ok)

    default = object()
    r1 = factory.make_role_client("judge", default=default)
    r2 = factory.make_role_client("judge", default=default)

    assert r1 is sentinel_client and r2 is sentinel_client
    # process-lifetime 캐시: build 1회, 이후 캐시 재사용.
    assert calls["n"] == 1


def test_unset_env_returns_default_without_build(monkeypatch):
    monkeypatch.delenv("SA_SUMMARIZER_PROFILE", raising=False)

    def _never(profile_name: str):  # pragma: no cover - 호출되면 안 됨
        raise AssertionError("env 미설정 시 build 호출 금지")

    monkeypatch.setattr(factory, "build_chat_client_from_profile", _never)

    default = object()
    assert factory.make_role_client("summarizer", default=default) is default
