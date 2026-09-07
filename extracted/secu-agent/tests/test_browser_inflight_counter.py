"""브라우저 동적응답 캡처의 in-flight 카운터 누수 회귀 테스트.

버그: `_schedule_dynamic_response_capture` 가 in-flight 카운터를
`asyncio.create_task()` 앞에서 증가시켜, create_task 가 실패(no running loop
등)하면 감소를 담당하는 `_runner` 의 finally 가 영영 실행되지 않아 카운터가
영구 누수됐다 → 한도에 눌러붙어 이후 모든 캡처가 skip 되고 브라우저가 상시
busy 로 보임. 픽스: 태스크가 성공적으로 시작된 뒤에만 증가(증가/감소 페어링).

SSO/로그인 회로차단기 의미는 이 테스트 범위 밖 — 순수 카운터 회계만 검증한다.
"""
from __future__ import annotations

import asyncio

import pytest

from secu_agent.agent.tools import browser_tool as bt


def test_no_counter_leak_when_create_task_fails(monkeypatch):
    """create_task 가 예외를 던지면 in-flight 카운터는 절대 증가하지 않아야 한다."""
    monkeypatch.setattr(bt, "_DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT", 0)
    monkeypatch.setattr(bt, "_DYNAMIC_RESPONSE_CAPTURE_TASKS", set())

    def _boom(*_args, **_kwargs):
        raise RuntimeError("no running event loop")

    # 함수가 참조하는 것은 모듈 최상위 `asyncio` — 그 create_task 를 교체한다.
    monkeypatch.setattr(bt.asyncio, "create_task", _boom)

    with pytest.raises(RuntimeError):
        bt._schedule_dynamic_response_capture(
            object(), object(), page_url="https://example.internal/", evidence_dir=None,
        )

    # 핵심 단언: 태스크 시작 실패 → 카운터가 0 에서 새지 않았다.
    assert bt._DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT == 0
    assert bt._DYNAMIC_RESPONSE_CAPTURE_TASKS == set()


def test_counter_paired_increment_then_decrement_on_success(monkeypatch):
    """정상 경로: 스케줄 직후 +1, 태스크 완료 후 다시 0 으로 페어링된다."""
    monkeypatch.setattr(bt, "_DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT", 0)
    monkeypatch.setattr(bt, "_DYNAMIC_RESPONSE_CAPTURE_TASKS", set())

    observed: dict[str, int] = {}

    async def _fake_capture(_page, _resp, *, page_url=None, evidence_dir=None):
        # 태스크 본문 실행 시점의 in-flight 값을 기록 (증가가 선행됐는지 확인).
        observed["during"] = bt._DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT

    monkeypatch.setattr(bt, "_capture_dynamic_response_body", _fake_capture)

    async def _drive() -> None:
        bt._schedule_dynamic_response_capture(
            object(), object(), page_url="https://example.internal/", evidence_dir=None,
        )
        # 태스크 시작 직후 정확히 +1.
        assert bt._DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT == 1
        tasks = list(bt._DYNAMIC_RESPONSE_CAPTURE_TASKS)
        assert len(tasks) == 1
        await asyncio.gather(*tasks)

    asyncio.run(_drive())

    assert observed.get("during") == 1
    # finally 가 감소를 보장 → 0 복귀.
    assert bt._DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT == 0


def test_skip_above_limit_does_not_change_counter(monkeypatch):
    """이미 한도면 스케줄을 건너뛰되 카운터를 건드리지 않는다(증가/감소 없음)."""
    limit = bt._DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT_LIMIT
    monkeypatch.setattr(bt, "_DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT", limit)
    monkeypatch.setattr(bt, "_DYNAMIC_RESPONSE_CAPTURE_TASKS", set())

    def _should_not_be_called(*_args, **_kwargs):
        raise AssertionError("한도 초과 시 create_task 가 호출되면 안 된다")

    monkeypatch.setattr(bt.asyncio, "create_task", _should_not_be_called)

    bt._schedule_dynamic_response_capture(
        object(), object(), page_url="https://example.internal/", evidence_dir=None,
    )

    assert bt._DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT == limit
    assert bt._DYNAMIC_RESPONSE_CAPTURE_TASKS == set()
