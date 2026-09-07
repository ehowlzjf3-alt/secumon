"""v3.83: TaskPlan — 결정론 다단(多段) phase 오케스트레이션 드라이버.

`run_fanout`(단일 fan-out phase) 위에 작성자가 phase 를 순차 합성하는 층이다.
discover → triage → deep-dive → verify → report 같은 파이프라인을 **코드가
결정론으로 지휘**한다 (모델이 아니라). 각 phase 는 등록형 fanout 어댑터를
이름으로 참조하고, 자기 k / budget / canary / gate 를 가진다.

통일 원리 유지: **코어 = 드라이버 + 게이트, 도메인 = 등록형 어댑터.**
- 동시성 k 는 phase spec(작성자)이 정한다 — 모델 주도 fan-out 아님. 그래서
  claim 조율·budget·lockout 안전이 전부 결정론 드라이버 손에 있다.
- canary: lockout 안전 프로브. fan-out 전에 k=1 로 첫 타깃 **1개만** 돌리고,
  실패면(auth 잠김 등) 나머지를 안 두드리고 phase 중단. 첫 타깃은 버려지지
  않고 그대로 1 claim 을 소비한다 (낭비 0) — run_fanout 의 max_targets=1 +
  어댑터 claim/release 계약을 그대로 탄다.
- gate: 누적 결과(PlanResult)의 순수 함수. 직전 phase 산출에 따라 다음 phase
  를 건너뛴다 (예: discover 가 0 타깃이면 deep-dive skip).

이 모듈은 드라이버만 — phase/plan 은 작성자(또는 plugin)가 조립한다. 실제
루프(RalphController)·CLI 연결은 별도. 어댑터 구현은 plugin/skill repo 소유.
"""
from __future__ import annotations

import asyncio
import inspect
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field

from secu_agent.agent.events import (
    FanoutCompleted,
    LoopEvent,
    PhaseAborted,
    PhaseCompleted,
    PhaseSkipped,
    PhaseStarted,
    PlanCompleted,
)
from secu_agent.agent.fanout import (
    FanoutAdapter,
    FanoutReport,
    get_fanout_adapter_factory,
    run_fanout,
)

# run_fanout 호환 시그니처 — 테스트에서 가짜로 주입(실제 SMB 없이 드라이버 검증).
FanoutFn = Callable[..., AsyncIterator[LoopEvent]]


@dataclass(frozen=True, slots=True)
class Phase:
    """plan 의 한 단계 — 등록형 fanout 어댑터 1개에 대한 실행 spec.

    - adapter: register_fanout_adapter 로 등록된 이름.
    - k: 이 phase 의 동시 워커 수 (작성자 결정, 모델 아님).
    - max_targets: 이 phase 예산(claim 상한). None = 어댑터 소진까지.
    - canary: True 면 fan-out 전 k=1 로 첫 타깃 1개 프로브 → 실패 시 중단.
    - required: True 인데 phase 가 abort 되면 plan 전체 중단(하류 phase 미실행).
    - gate: PlanResult → bool. False 면 이 phase skip (결정론 조건부 흐름).
    """

    name: str
    adapter: str
    k: int = 1
    max_targets: int | None = None
    canary: bool = False
    required: bool = True
    gate: Callable[["PlanResult"], bool] | None = None

    def __post_init__(self) -> None:
        if self.k < 1:
            raise ValueError(f"phase {self.name!r}: k 는 1 이상 ({self.k})")
        if self.max_targets is not None and self.max_targets < 1:
            raise ValueError(
                f"phase {self.name!r}: max_targets 는 1 이상 또는 None ({self.max_targets})"
            )


@dataclass(frozen=True, slots=True)
class TaskPlan:
    """순차 실행되는 phase 들의 결정론 합성."""

    name: str
    phases: tuple[Phase, ...]

    def __post_init__(self) -> None:
        if not self.phases:
            raise ValueError(f"plan {self.name!r}: phase 가 최소 1개 필요")
        names = [p.name for p in self.phases]
        if len(names) != len(set(names)):
            raise ValueError(f"plan {self.name!r}: phase 이름 중복 — {names}")


@dataclass
class PlanResult:
    """plan 누적 집계 — phase 별 FanoutReport. gate 와 최종 보고가 읽는다."""

    plan_name: str
    reports: list[tuple[str, FanoutReport]] = field(default_factory=list)

    def add(self, phase_name: str, report: FanoutReport) -> None:
        self.reports.append((phase_name, report))

    def phase_reports(self, phase_name: str) -> list[FanoutReport]:
        return [r for n, r in self.reports if n == phase_name]

    @property
    def total_claimed(self) -> int:
        return sum(r.claimed for _, r in self.reports)

    @property
    def total_succeeded(self) -> int:
        return sum(r.succeeded for _, r in self.reports)

    @property
    def total_failed(self) -> int:
        return sum(r.failed for _, r in self.reports)

    @property
    def total_findings(self) -> int:
        return sum(r.findings_count for _, r in self.reports)

    @property
    def total_candidates_seen(self) -> int:
        return sum(r.candidates_seen for _, r in self.reports)

    @property
    def total_candidates_accounted(self) -> int:
        return sum(r.candidates_accounted for _, r in self.reports)

    @property
    def total_silent_workers(self) -> int:
        # v3.90: seen>0 & accounted==0 인 침묵 워커 총수 (다단 오케스트레이션 가시화).
        return sum(r.candidates_silent_workers for _, r in self.reports)


async def _resolve_adapter(name: str) -> FanoutAdapter:
    factory = get_fanout_adapter_factory(name)
    if factory is None:
        raise LookupError(f"fanout adapter {name!r} 미등록")
    out = factory()
    if inspect.isawaitable(out):
        out = await out
    return out  # type: ignore[return-value]


def _merge_report(into: FanoutReport, src: FanoutReport) -> None:
    """canary + full 두 fan-out 보고를 한 phase 보고로 합산."""
    into.claimed += src.claimed
    into.succeeded += src.succeeded
    into.failed += src.failed
    into.tokens_in += src.tokens_in
    into.tokens_out += src.tokens_out
    into.findings_count += src.findings_count
    # v3.90 candidate ledger 가시화 필드도 합산(codex 5R) — 병합 누락 시 다단
    # 오케스트레이션(PhaseCompleted/PlanCompleted)에서 침묵 워커가 소실된다.
    into.candidates_seen += src.candidates_seen
    into.candidates_accounted += src.candidates_accounted
    into.candidates_silent_workers += src.candidates_silent_workers
    into.failures.extend(src.failures)
    into.duration_sec += src.duration_sec
    into.exhausted = src.exhausted  # 마지막 fan-out 의 종료 성격이 phase 성격
    into.budget_capped = into.budget_capped or src.budget_capped
    into.cancelled = into.cancelled or src.cancelled


async def _run_fanout_collect(
    fanout_fn: FanoutFn,
    adapter: FanoutAdapter,
    *,
    k: int,
    goal_id: int | None,
    max_targets: int | None,
    cancel_event: asyncio.Event | None,
) -> AsyncIterator[LoopEvent | FanoutReport]:
    """run_fanout 를 돌리며 WorkerCompleted 는 그대로 re-yield, 최종
    FanoutReport 는 마지막에 yield(드라이버가 집계용으로 가로챔)."""
    report: FanoutReport | None = None
    async for ev in fanout_fn(
        adapter, k=k, goal_id=goal_id, max_targets=max_targets,
        cancel_event=cancel_event,
    ):
        if isinstance(ev, FanoutCompleted):
            report = ev.report
        else:
            yield ev
    if report is not None:
        yield report


async def run_plan(
    plan: TaskPlan,
    *,
    goal_id: int | None = None,
    cancel_event: asyncio.Event | None = None,
    adapter_resolver: Callable[[str], Awaitable[FanoutAdapter]] | None = None,
    fanout_fn: FanoutFn = run_fanout,
) -> AsyncIterator[LoopEvent]:
    """plan 의 phase 를 순차 실행 — phase 경계 이벤트 + 내부 WorkerCompleted 를
    한 스트림으로 yield, 마지막에 PlanCompleted(PlanResult).

    결정론: 흐름(순서/gate/canary/budget)은 전부 이 드라이버(코드)가 정한다.
    """
    resolve = adapter_resolver or _resolve_adapter
    result = PlanResult(plan_name=plan.name)
    aborted = False
    cancelled = False
    abort_reason = ""

    for phase in plan.phases:
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            break

        if phase.gate is not None and not phase.gate(result):
            yield PhaseSkipped(plan=plan.name, phase=phase.name, reason="gate=false")
            continue

        try:
            adapter = await resolve(phase.adapter)
        except Exception as e:  # noqa: BLE001 — 어댑터 부재/생성 실패는 phase abort
            yield PhaseAborted(
                plan=plan.name, phase=phase.name,
                reason=f"adapter {phase.adapter!r} resolve 실패: {e!r}",
            )
            if phase.required:
                aborted = True
                abort_reason = f"{phase.name}: adapter {phase.adapter!r} 없음"
                break
            continue

        yield PhaseStarted(
            plan=plan.name, phase=phase.name, adapter=phase.adapter,
            k=phase.k, canary=phase.canary,
        )

        phase_report = FanoutReport(adapter=phase.adapter)
        budget = phase.max_targets

        # ── canary: k=1, 첫 타깃 1개만 프로브 ─────────────────────────
        if phase.canary:
            canary_report: FanoutReport | None = None
            async for ev in _run_fanout_collect(
                fanout_fn, adapter, k=1, goal_id=goal_id, max_targets=1,
                cancel_event=cancel_event,
            ):
                if isinstance(ev, FanoutReport):
                    canary_report = ev
                else:
                    yield ev
            if canary_report is not None:
                _merge_report(phase_report, canary_report)

            if canary_report is not None and canary_report.cancelled:
                cancelled = True
                result.add(phase.name, phase_report)
                yield PhaseCompleted(plan=plan.name, phase=phase.name, report=phase_report)
                break

            if canary_report is None or canary_report.claimed == 0:
                # 타깃 자체가 없음 — 빈 phase 완료
                result.add(phase.name, phase_report)
                yield PhaseCompleted(plan=plan.name, phase=phase.name, report=phase_report)
                continue

            if canary_report.failed >= 1 and canary_report.succeeded == 0:
                result.add(phase.name, phase_report)
                yield PhaseAborted(
                    plan=plan.name, phase=phase.name,
                    reason="canary 실패 — fan-out 중단 (lockout 안전)",
                )
                if phase.required:
                    aborted = True
                    abort_reason = f"{phase.name}: canary 실패"
                    break
                continue

            # canary 통과 — 남은 예산 차감
            if budget is not None:
                budget -= canary_report.claimed
                if budget <= 0:
                    result.add(phase.name, phase_report)
                    yield PhaseCompleted(plan=plan.name, phase=phase.name, report=phase_report)
                    continue

        # ── full fan-out: k=phase.k, 남은 타깃 ────────────────────────
        full_report: FanoutReport | None = None
        async for ev in _run_fanout_collect(
            fanout_fn, adapter, k=phase.k, goal_id=goal_id, max_targets=budget,
            cancel_event=cancel_event,
        ):
            if isinstance(ev, FanoutReport):
                full_report = ev
            else:
                yield ev
        if full_report is not None:
            _merge_report(phase_report, full_report)
            if full_report.cancelled:
                cancelled = True

        result.add(phase.name, phase_report)
        yield PhaseCompleted(plan=plan.name, phase=phase.name, report=phase_report)
        if cancelled:
            break

    yield PlanCompleted(
        plan=plan.name,
        result=result,
        aborted=aborted,
        cancelled=cancelled,
        reason=abort_reason or ("cancelled" if cancelled else "exhausted"),
    )


# ── plan 레지스트리 (재부착 plugin API) ───────────────────────────────
#
# fanout 어댑터 레지스트리와 동형 — plugin/skill repo 가 부트스트랩에서
# register_task_plan 으로 등록한다. 코어는 이름으로 찾을 뿐 plan 내용을
# 모른다. 이름 중복 = 명시 에러 (silent override 금지).

_TASK_PLANS: dict[str, TaskPlan] = {}


def register_task_plan(plan: TaskPlan) -> None:
    if plan.name in _TASK_PLANS:
        raise ValueError(f"task plan {plan.name!r} 이미 등록됨")
    _TASK_PLANS[plan.name] = plan


def unregister_task_plan(name: str) -> bool:
    return _TASK_PLANS.pop(name, None) is not None


def get_task_plan(name: str) -> TaskPlan | None:
    return _TASK_PLANS.get(name)


def list_task_plans() -> list[str]:
    return sorted(_TASK_PLANS)
