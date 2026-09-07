"""v3.83: TaskPlan 드라이버 결정론 테스트.

실제 SMB/워커 없이 — 가짜 fanout_fn(스크립트된 FanoutReport)과 가짜 adapter
resolver 를 주입해 phase 합성 로직만 검증한다. run_fanout 자체는 pool_factory
주입으로 별도 테스트되므로, 여기서는 그 위 드라이버(순서/gate/canary/budget/
취소)에 집중.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from secu_agent.agent.events import (
    FanoutCompleted,
    PhaseAborted,
    PhaseCompleted,
    PhaseSkipped,
    PhaseStarted,
    PlanCompleted,
    WorkerCompleted,
)
from secu_agent.agent.fanout import FanoutReport
from secu_agent.agent.task_plan import TaskPlan, Phase, PlanResult, run_plan


def _report(adapter: str, *, claimed=0, succeeded=0, failed=0, findings=0,
            cancelled=False, budget_capped=False,
            candidates_seen=0, candidates_accounted=0, silent_workers=0) -> FanoutReport:
    return FanoutReport(
        adapter=adapter, claimed=claimed, succeeded=succeeded, failed=failed,
        findings_count=findings, cancelled=cancelled, budget_capped=budget_capped,
        candidates_seen=candidates_seen, candidates_accounted=candidates_accounted,
        candidates_silent_workers=silent_workers,
        exhausted=not cancelled and not budget_capped,
    )


class _FakeFanout:
    """adapter 이름별로 스크립트된 FanoutReport 큐를 순서대로 소비.

    호출 1회 = run_fanout 1회 (canary 와 full 은 별도 호출). 각 호출은
    claimed 만큼 WorkerCompleted 를 방출 후 FanoutCompleted(report)."""

    def __init__(self, scripts: dict[str, list[FanoutReport]]):
        self.scripts = {k: list(v) for k, v in scripts.items()}
        self.calls: list[tuple[str, int, int | None]] = []  # (adapter, k, max_targets)

    def __call__(self, adapter, *, k, goal_id, max_targets, cancel_event):
        self.calls.append((adapter.name, k, max_targets))
        queue = self.scripts.get(adapter.name)
        if not queue:
            raise AssertionError(f"예상치 못한 fanout 호출: {adapter.name}")
        report = queue.pop(0)

        async def _gen():
            for i in range(report.claimed):
                ok = i < report.succeeded
                yield WorkerCompleted(
                    adapter=adapter.name, label=f"{adapter.name}-t{i}",
                    ok=ok, status="ok" if ok else "fail", duration_sec=0.0,
                )
            yield FanoutCompleted(adapter=adapter.name, report=report)

        return _gen()


def _resolver_for(*names: str):
    known = set(names)

    async def _resolve(name: str):
        if name not in known:
            raise LookupError(f"미등록: {name}")
        return SimpleNamespace(name=name)

    return _resolve


def _drain(plan, fake, **kw):
    async def go():
        return [
            ev async for ev in run_plan(
                plan, fanout_fn=fake,
                adapter_resolver=_resolver_for(*fake.scripts.keys()), **kw,
            )
        ]
    return asyncio.run(go())


def _of(events, cls):
    return [e for e in events if isinstance(e, cls)]


# ── 기본 다단 합성 ──────────────────────────────────────────────────────

def test_two_phase_sequential_success():
    fake = _FakeFanout({
        "discover": [_report("discover", claimed=3, succeeded=3, findings=1)],
        "triage": [_report("triage", claimed=3, succeeded=3, findings=2)],
    })
    plan = TaskPlan("p", (
        Phase("discover", "discover", k=2),
        Phase("triage", "triage", k=4),
    ))
    evs = _drain(plan, fake)

    starts = _of(evs, PhaseStarted)
    assert [s.phase for s in starts] == ["discover", "triage"]
    assert [s.k for s in starts] == [2, 4]

    done = _of(evs, PlanCompleted)
    assert len(done) == 1
    res: PlanResult = done[0].result
    assert not done[0].aborted and not done[0].cancelled
    assert res.total_succeeded == 6
    assert res.total_findings == 3
    # canary 아님 → 어댑터당 fan-out 정확히 1회, full k 그대로
    assert fake.calls == [("discover", 2, None), ("triage", 4, None)]


def test_worker_events_passthrough():
    fake = _FakeFanout({"a": [_report("a", claimed=2, succeeded=2)]})
    evs = _drain(TaskPlan("p", (Phase("a", "a", k=2),)), fake)
    wc = _of(evs, WorkerCompleted)
    assert len(wc) == 2 and all(w.ok for w in wc)


# ── gate: 조건부 흐름 ───────────────────────────────────────────────────

def test_gate_skips_phase_when_false():
    fake = _FakeFanout({
        "discover": [_report("discover", claimed=0)],  # 0 타깃
        # deepdive 는 호출되면 안 됨 (스크립트 없음 → 호출 시 AssertionError)
    })
    plan = TaskPlan("p", (
        Phase("discover", "discover", k=1),
        Phase("deepdive", "deepdive", k=4,
              gate=lambda r: r.total_succeeded > 0),
    ))
    evs = _drain(plan, fake)
    assert [s.phase for s in _of(evs, PhaseSkipped)] == ["deepdive"]
    assert "deepdive" not in [c[0] for c in fake.calls]
    assert _of(evs, PlanCompleted)[0].reason == "exhausted"


def test_gate_runs_phase_when_true():
    fake = _FakeFanout({
        "discover": [_report("discover", claimed=2, succeeded=2)],
        "deepdive": [_report("deepdive", claimed=2, succeeded=2)],
    })
    plan = TaskPlan("p", (
        Phase("discover", "discover", k=1),
        Phase("deepdive", "deepdive", k=4,
              gate=lambda r: r.total_succeeded > 0),
    ))
    evs = _drain(plan, fake)
    assert not _of(evs, PhaseSkipped)
    assert [s.phase for s in _of(evs, PhaseStarted)] == ["discover", "deepdive"]


# ── canary: lockout 안전 프로브 ─────────────────────────────────────────

def test_canary_pass_then_full_fanout_merges():
    fake = _FakeFanout({
        "deepdive": [
            _report("deepdive", claimed=1, succeeded=1, findings=1),   # canary
            _report("deepdive", claimed=4, succeeded=4, findings=3),   # full
        ],
    })
    plan = TaskPlan("p", (Phase("deepdive", "deepdive", k=4, canary=True),))
    evs = _drain(plan, fake)

    # canary(k=1,max=1) 후 full(k=4) — 두 번 호출
    assert fake.calls == [("deepdive", 1, 1), ("deepdive", 4, None)]
    pc = _of(evs, PhaseCompleted)[0]
    assert pc.report.claimed == 5 and pc.report.succeeded == 5
    assert pc.report.findings_count == 4
    assert not _of(evs, PhaseAborted)


def test_candidate_ledger_fields_merged_across_canary_and_full(tmp_path):
    # codex 5R: canary+full 병합에서 candidate 침묵 지표가 소실되면 안 된다.
    fake = _FakeFanout({
        "deepdive": [
            _report("deepdive", claimed=1, succeeded=1,
                    candidates_seen=3, candidates_accounted=0, silent_workers=1),  # canary
            _report("deepdive", claimed=4, succeeded=4,
                    candidates_seen=5, candidates_accounted=5, silent_workers=0),  # full
        ],
    })
    plan = TaskPlan("p", (Phase("deepdive", "deepdive", k=4, canary=True),))
    evs = _drain(plan, fake)
    pc = _of(evs, PhaseCompleted)[0]
    assert pc.report.candidates_seen == 8
    assert pc.report.candidates_accounted == 5
    assert pc.report.candidates_silent_workers == 1
    res: PlanResult = _of(evs, PlanCompleted)[0].result
    assert res.total_candidates_seen == 8
    assert res.total_silent_workers == 1


def test_canary_fail_aborts_phase_and_required_stops_plan():
    fake = _FakeFanout({
        "deepdive": [_report("deepdive", claimed=1, succeeded=0, failed=1)],  # canary 실패
        "report": [_report("report", claimed=1, succeeded=1)],  # 하류 — 실행되면 안 됨
    })
    plan = TaskPlan("p", (
        Phase("deepdive", "deepdive", k=8, canary=True, required=True),
        Phase("report", "report", k=1),
    ))
    evs = _drain(plan, fake)

    ab = _of(evs, PhaseAborted)
    assert [a.phase for a in ab] == ["deepdive"]
    # full fan-out 안 함(호출 1회=canary뿐), 하류 phase 미실행
    assert fake.calls == [("deepdive", 1, 1)]
    done = _of(evs, PlanCompleted)[0]
    assert done.aborted is True and "canary 실패" in done.reason
    assert "report" not in [s.phase for s in _of(evs, PhaseStarted)]


def test_canary_fail_non_required_continues():
    fake = _FakeFanout({
        "optional": [_report("optional", claimed=1, succeeded=0, failed=1)],  # canary 실패
        "report": [_report("report", claimed=2, succeeded=2)],
    })
    plan = TaskPlan("p", (
        Phase("optional", "optional", k=4, canary=True, required=False),
        Phase("report", "report", k=1),
    ))
    evs = _drain(plan, fake)
    assert [a.phase for a in _of(evs, PhaseAborted)] == ["optional"]
    # 하류 phase 는 진행
    assert "report" in [s.phase for s in _of(evs, PhaseStarted)]
    assert _of(evs, PlanCompleted)[0].aborted is False


def test_canary_budget_consumed_no_double_claim():
    # max_targets=3, canary 1 소비 → full 은 max_targets=2 로 호출
    fake = _FakeFanout({
        "dd": [
            _report("dd", claimed=1, succeeded=1),
            _report("dd", claimed=2, succeeded=2),
        ],
    })
    plan = TaskPlan("p", (Phase("dd", "dd", k=4, max_targets=3, canary=True),))
    evs = _drain(plan, fake)
    assert fake.calls == [("dd", 1, 1), ("dd", 4, 2)]
    assert _of(evs, PhaseCompleted)[0].report.claimed == 3


def test_canary_no_targets_completes_empty():
    fake = _FakeFanout({"dd": [_report("dd", claimed=0)]})
    plan = TaskPlan("p", (Phase("dd", "dd", k=4, canary=True),))
    evs = _drain(plan, fake)
    # canary 가 0 타깃 → full fan-out 안 함
    assert fake.calls == [("dd", 1, 1)]
    assert _of(evs, PhaseCompleted)[0].report.claimed == 0


# ── 취소 / 어댑터 부재 / 검증 ───────────────────────────────────────────

def test_cancel_mid_plan_stops_downstream():
    fake = _FakeFanout({
        "a": [_report("a", claimed=2, succeeded=1, cancelled=True)],
        "b": [_report("b", claimed=1, succeeded=1)],
    })
    plan = TaskPlan("p", (Phase("a", "a", k=2), Phase("b", "b", k=1)))
    evs = _drain(plan, fake)
    done = _of(evs, PlanCompleted)[0]
    assert done.cancelled is True
    assert "b" not in [s.phase for s in _of(evs, PhaseStarted)]


def test_missing_required_adapter_aborts_plan():
    fake = _FakeFanout({"a": [_report("a", claimed=1, succeeded=1)]})

    async def go():
        # resolver 는 'a' 만 안다 — 'ghost' 는 미등록
        return [
            ev async for ev in run_plan(
                TaskPlan("p", (Phase("ghost", "ghost", k=1),)),
                fanout_fn=fake, adapter_resolver=_resolver_for("a"),
            )
        ]
    evs = asyncio.run(go())
    assert [a.phase for a in _of(evs, PhaseAborted)] == ["ghost"]
    assert _of(evs, PlanCompleted)[0].aborted is True


def test_plan_validation():
    with pytest.raises(ValueError, match="phase 가 최소 1개"):
        TaskPlan("p", ())
    with pytest.raises(ValueError, match="이름 중복"):
        TaskPlan("p", (Phase("x", "a"), Phase("x", "b")))
    with pytest.raises(ValueError, match="k 는 1 이상"):
        Phase("x", "a", k=0)
