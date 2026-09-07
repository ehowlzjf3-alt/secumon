"""v3.83: task CLI 배선 테스트.

null 어댑터(claim_next→None)로 전체 실제 파이프라인(레지스트리 → run_task →
run_plan → run_fanout → WorkerPool)을 서브프로세스 0개로 end-to-end 검증.
어댑터 등록은 별도(plugin) 책임 — 여기서는 배선만 본다.
"""
from __future__ import annotations

import argparse
import asyncio

import pytest

from secu_agent.agent.fanout import (
    register_fanout_adapter,
    unregister_fanout_adapter,
)
from secu_agent.agent.task_cli import run_task
from secu_agent.agent.task_plan import (
    TaskPlan,
    Phase,
    get_task_plan,
    list_task_plans,
    register_task_plan,
    unregister_task_plan,
)


def _ns(**kw) -> argparse.Namespace:
    return argparse.Namespace(
        plan=kw.get("plan"),
        list_plans=kw.get("list_plans", False),
        goal_id=kw.get("goal_id"),
    )


def test_plan_registry_register_get_list_dup():
    plan = TaskPlan("reg_test", (Phase("a", "x"),))
    register_task_plan(plan)
    try:
        assert get_task_plan("reg_test") is plan
        assert "reg_test" in list_task_plans()
        with pytest.raises(ValueError, match="이미 등록"):
            register_task_plan(TaskPlan("reg_test", (Phase("b", "y"),)))
    finally:
        assert unregister_task_plan("reg_test")
    assert get_task_plan("reg_test") is None


def test_list_plans_returns_zero():
    register_task_plan(TaskPlan("list_test", (Phase("scan", "x", k=2),)))
    try:
        assert asyncio.run(run_task(_ns(list_plans=True))) == 0
    finally:
        unregister_task_plan("list_test")


def test_unknown_plan_returns_2():
    assert asyncio.run(run_task(_ns(plan="nope_does_not_exist"))) == 2


def test_no_plan_no_list_returns_2():
    assert asyncio.run(run_task(_ns())) == 2


class _NullAdapter:
    """0 타깃 어댑터 — claim_next 가 즉시 None → 워커 spawn 0 (서브프로세스 없음)."""

    name = "test_null_adapter"

    async def claim_next(self):
        return None

    async def build_spec(self, target):  # pragma: no cover - 호출 안 됨
        raise AssertionError("0 타깃이라 build_spec 호출 안 됨")

    async def release(self, target, completion, *, success):
        return None

    def summarize(self, report):
        return "0 targets"


def test_end_to_end_null_adapter_runs_full_pipeline():
    register_fanout_adapter("test_null_adapter", lambda: _NullAdapter())
    register_task_plan(
        TaskPlan("e2e_test", (Phase("scan", "test_null_adapter", k=2),)))
    try:
        # 레지스트리→run_task→run_plan→run_fanout→WorkerPool 전 경로 실행.
        # 0 타깃 → 정상 완료(서브프로세스 0). aborted 아님 → rc 0.
        assert asyncio.run(run_task(_ns(plan="e2e_test"))) == 0
    finally:
        unregister_task_plan("e2e_test")
        unregister_fanout_adapter("test_null_adapter")


def test_missing_adapter_aborts_returns_1():
    # plan 은 등록됐지만 어댑터 미등록 → run_plan 이 PhaseAborted(fail-closed) → rc 1
    register_task_plan(
        TaskPlan("noadapter_test", (Phase("scan", "ghost_adapter", k=1),)))
    try:
        assert asyncio.run(run_task(_ns(plan="noadapter_test"))) == 1
    finally:
        unregister_task_plan("noadapter_test")
