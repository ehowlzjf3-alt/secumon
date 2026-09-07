"""v3.81 T1d (=Slice2 재정의): generic fan-out 헬퍼 + 어댑터 프로토콜.

부모(Ralph 루프)가 타깃들을 WorkerPool 워커로 분배하는 루프-레벨 batch
fan-out 의 도메인-불문 기계. 설계 원문: `docs/design/parallel-subagent-
design-v3.80.md` (롤링 풀, 부모 선claim, fail-closed 결과, 타깃=1turn).

통일 원리: **코어 = 프로토콜 + 게이트, 도메인 = 등록형 어댑터.**
도메인별 차이는 어댑터 3+1 요소뿐 — claim_next / build_spec / release /
summarize. 어댑터 등록(`register_fanout_adapter`)이 재부착 plugin API 의
첫 조각이다 — secu-agent-skill 재부착 시 도메인(smb/web/...) 어댑터가
여기 등록되고, 코어는 도메인을 모른 채 기계만 돌린다.

계약 (CONTRACTS.md "v3.80 워커 계약" + T1d):
- claim 은 부모(어댑터 claim_next) 단독, 순차 1회씩 — 워커는 claim 안 함.
- 타깃 = 1 turn: 완료당 `goal_record_turn` 정확 1회 (parse_fail=None,
  progress=None — judge streak 비간섭).
- 결과는 worker_result.json fail-closed — invalid 면 실패로 집계하고
  release(success=False) (어댑터가 claim 해제 → 재점검).
- **결정론 종료 (T1a 의 구조적 복원)**: claim_next None ∧ 활성 워커 0
  이중 조건(WorkerPool.run 내장)으로 끝나면 report.exhausted=True —
  루프 통합부가 이 신호로 GoalDone 을 결정론으로 박을 수 있다 (judge 불요).
- 취소: cancel_event set → pool.cancel() (SIGTERM→grace→SIGKILL).
  완료는 전부 yield 후 report.cancelled=True.
- max_targets (K_eff = max_turns - turns_used) 도달 시 claim 중단 —
  report.budget_capped=True (예산 초과 자체가 불가능, F4).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from secu_agent import state
from secu_agent.agent.events import FanoutCompleted, WorkerCompleted
from secu_agent.agent.schema.worker_result import (
    WorkerResult, WorkerResultInvalid,
)
from secu_agent.agent.worker_pool import (
    WorkerCompletion, WorkerPool, WorkerSpec,
)

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class FanoutTarget:
    """어댑터 claim_next 의 반환 — 불투명 claim 핸들 + 표시 라벨.

    payload 는 어댑터 전용 (claim row id 등) — release 때 그대로 돌려준다.
    """

    label: str
    payload: Any = None


@runtime_checkable
class FanoutAdapter(Protocol):
    """도메인 어댑터 프로토콜 — 재부착 plugin API 의 첫 조각.

    구현은 plugin/skill repo 소유. 코어는 이 4개 hook 만 안다.
    모든 hook 은 async (sync DB 호출은 어댑터가 to_thread 로 감쌀 것).
    """

    name: str

    async def claim_next(self) -> FanoutTarget | None:
        """다음 타깃 원자적 claim. None = 지금 줄 것 없음 (영구 아님 —
        완료가 날 때마다 재질의된다. WorkerPool 계약)."""
        ...

    async def build_spec(self, target: FanoutTarget) -> WorkerSpec:
        """타깃 → WorkerSpec (task_spec.json 작성 + evidence dir 생성 포함).
        예외 = 그 타깃 실패 처리 (release success=False)."""
        ...

    async def release(
        self, target: FanoutTarget, completion: WorkerCompletion | None,
        *, success: bool,
    ) -> None:
        """완료/실패 후 claim 처분 — 성공이면 mark-done, 실패면 해제(재점검).
        completion None = spawn 전 실패(spec build 예외/취소). 예외는 로그만
        (stale reclaim 백스톱이 회수)."""
        ...

    def summarize(self, report: "FanoutReport") -> str:
        """부모 컨텍스트/시스템 노트용 집계 요약 (워커 transcript 금지)."""
        ...


@dataclass
class FanoutReport:
    """fan-out 1회분 집계 — 부모는 이것만 받는다 (컨텍스트 경계)."""

    adapter: str
    claimed: int = 0
    succeeded: int = 0
    failed: int = 0
    exhausted: bool = False      # claim None ∧ 활성 0 자연 종료 (결정론 종료 신호)
    budget_capped: bool = False  # max_targets 도달로 claim 중단
    cancelled: bool = False
    tokens_in: int = 0
    tokens_out: int = 0
    findings_count: int = 0
    # v3.90 candidate ledger 가시화: fan-out 전체에서 관찰 후보 vs 해명(제출+기각).
    # 자동 재큐는 안 함(무한루프 위험) — 관측만.
    candidates_seen: int = 0
    candidates_accounted: int = 0
    # codex 4R #3: 합산은 워커별 provenance 를 잃는다(A 5/0 + B 1/1 = 6/1 로 A 침묵
    # 식별 불가). seen>0 & accounted==0 인 **침묵 워커 수** 를 따로 센다 — per-worker
    # 정확 지표는 각 worker_result.json 이 보유(source of truth).
    candidates_silent_workers: int = 0
    failures: list[str] = field(default_factory=list)  # 실패 타깃 label
    duration_sec: float = 0.0


def _completion_ok(completion: WorkerCompletion) -> tuple[bool, str]:
    """성공 판정 + 표시용 status. 성공 = exited ∧ 유효 결과 ∧ status ok."""
    if completion.outcome != "exited":
        return False, completion.outcome
    r = completion.result
    if isinstance(r, WorkerResultInvalid):
        return False, f"invalid:{r.reason}"
    assert isinstance(r, WorkerResult)
    return r.status == "ok", r.status


# ── 워커 완료 관측 훅 (CORE-ASK ASK-1 — 재부착 plugin read-model) ─────────
#
# 코어는 completion 분류의 **단일 지점**이다 — invalid(worker_result 누락/
# 파싱실패/스키마위반) 을 정확히 아는 곳은 여기뿐. 스킬은 이 completion 을
# 자기 DB(skill_quality)/게이트웨이 read-model 로 영속하고 싶지만, 코어는
# 프로토콜(빈 훅)만 소유하고 sink 로직·DB 는 절대 반입하지 않는다
# (register_evidence_judge / register_candidate_counter 전례와 동일한 결).
#
# observer(target, spec, completion, ok) — spec 은 completion.spec 와 동일값을
# 편의로 넘긴다. sink 는 spec.env["SA_ATTEMPT_ID"] 같은 상관관계 id 를 도로
# 꺼내 쓴다(코어는 attempt_id 개념을 모른다).
WorkerCompletionObserver = Callable[
    [FanoutTarget, WorkerSpec, WorkerCompletion, bool], None
]

_COMPLETION_OBSERVERS: list[WorkerCompletionObserver] = []
_OBSERVERS_LOCK = threading.Lock()


def register_worker_completion_observer(fn: WorkerCompletionObserver) -> None:
    """observer 등록 (plugin API). 동일 callable 재등록은 idempotent(무시) —

    read-model observer 를 두 번 심어 completion 당 2회 발화하는 사고를 막는다
    (adapter 레지스트리의 name-중복 raise 와 달리 observer 는 익명 리스트라
    identity 로 중복만 제거). 서로 다른 observer 는 모두 공존·발화한다.

    중복 판정은 **identity(`is`)** — `==` 를 쓰면 observer 가 정의한 `__eq__`
    (예: frozen dataclass)를 락 안에서 호출해 ①값-같음 서로 다른 인스턴스를
    한 개로 오인하거나 ②`__eq__` 가 레지스트리를 재진입하면 비재귀 락
    데드락에 빠질 수 있다(codex).
    """
    with _OBSERVERS_LOCK:
        if not any(o is fn for o in _COMPLETION_OBSERVERS):
            _COMPLETION_OBSERVERS.append(fn)


def unregister_worker_completion_observer(fn: WorkerCompletionObserver) -> bool:
    """등록 해제 (test/plugin 재부착용). 미등록이면 False. identity(`is`) 매칭."""
    with _OBSERVERS_LOCK:
        for i, o in enumerate(_COMPLETION_OBSERVERS):
            if o is fn:
                del _COMPLETION_OBSERVERS[i]
                return True
        return False


def _notify_completion_observers(
    target: FanoutTarget, spec: WorkerSpec,
    completion: WorkerCompletion, ok: bool,
) -> None:
    """등록 observer 를 completion 당 정확히 1회 발화 — best-effort.

    observer 예외는 log 후 삼킴: 팬아웃/release 흐름에 절대 영향 없다
    (candidate_counter 훅의 예외격리 전례: candidate_ledger.run_candidate_counters).
    미등록 시 즉시 반환 → observer 0개면 기존 동작과 byte-for-byte 동일.
    """
    with _OBSERVERS_LOCK:
        observers = tuple(_COMPLETION_OBSERVERS)
    for fn in observers:
        try:
            fn(target, spec, completion, ok)
        except (Exception, asyncio.CancelledError):  # noqa: BLE001
            # 관측 실패는 fan-out 을 못 끊는다("절대 영향 없음"). CancelledError 는
            # BaseException 이라 `except Exception` 을 새는데, observer 는 sync 라
            # 이 안엔 await 가 없다 → 여기서 나오는 CancelledError 는 협조적
            # 취소가 아니라 observer 자신이 던진 것 → 삼켜도 안전. SystemExit/
            # KeyboardInterrupt 는 그대로 전파(프로세스 신호는 안 가로챈다).
            log.warning(
                "worker completion observer %r 실패 (label=%s): 삼킴",
                getattr(fn, "__name__", fn), spec.label, exc_info=True,
            )


async def run_fanout(
    adapter: FanoutAdapter,
    *,
    k: int,
    goal_id: int | None = None,
    max_targets: int | None = None,
    cancel_event: asyncio.Event | None = None,
    pool_factory: Callable[[int], WorkerPool] | None = None,
):
    """롤링 fan-out 실행 — WorkerCompleted 이벤트를 yield 하고 마지막에
    FanoutCompleted(report) 를 yield 한다.

    AsyncIterator[WorkerCompleted | FanoutCompleted]. 루프 통합부는
    `async for ev in run_fanout(...)` 로 재방출하고 FanoutCompleted 의
    report 로 결정론 종료(exhausted)/pause(cancelled) 를 판단한다.
    """
    if max_targets is not None and max_targets <= 0:
        # 예산 0 — claim 자체를 안 한다 (F4: 예산 초과 불가능)
        report = FanoutReport(adapter=adapter.name, budget_capped=True)
        yield FanoutCompleted(adapter=adapter.name, report=report)
        return

    start = time.monotonic()
    report = FanoutReport(adapter=adapter.name)
    pool = pool_factory(k) if pool_factory is not None else WorkerPool(k)
    # spec.label → FanoutTarget (release 때 claim 핸들 복원)
    targets_by_label: dict[str, FanoutTarget] = {}

    async def _next_spec() -> WorkerSpec | None:
        while True:
            if cancel_event is not None and cancel_event.is_set():
                pool.cancel()
                return None
            if max_targets is not None and report.claimed >= max_targets:
                report.budget_capped = True
                return None
            target = await adapter.claim_next()
            if target is None:
                return None
            report.claimed += 1
            try:
                spec = await adapter.build_spec(target)
            except Exception as e:  # noqa: BLE001 — 한 타깃 실패가 풀을 못 끊음
                log.warning(
                    "fanout %s: build_spec 실패 — release 후 다음 타깃: "
                    "label=%s: %r", adapter.name, target.label, e,
                )
                report.failed += 1
                report.failures.append(target.label)
                await _release_quiet(target, None, success=False)
                continue
            targets_by_label[spec.label] = target
            return spec

    async def _release_quiet(
        target: FanoutTarget, completion: WorkerCompletion | None,
        *, success: bool,
    ) -> None:
        try:
            await adapter.release(target, completion, success=success)
        except Exception as e:  # noqa: BLE001 — 해제 실패는 stale reclaim 몫
            log.warning(
                "fanout %s: release 실패 (stale reclaim 백스톱 대상): "
                "label=%s success=%s: %r",
                adapter.name, target.label, success, e,
            )

    # cancel 응답성: 슬롯이 다 차 있어도 (next_spec 미호출 구간) SIGTERM 전파
    watcher: asyncio.Task[None] | None = None
    if cancel_event is not None:
        async def _watch_cancel() -> None:
            await cancel_event.wait()
            pool.cancel()
        watcher = asyncio.create_task(_watch_cancel())

    try:
        async with contextlib.aclosing(pool.run(_next_spec)) as gen:
            async for completion in gen:
                ok, status = _completion_ok(completion)
                target = targets_by_label.pop(
                    completion.spec.label,
                    FanoutTarget(label=completion.spec.label),
                )

                # ASK-1: completion 분류 직후 즉시 발화 — 이후 bookkeeping/
                # goal_record_turn 이 raise 해도 completion 당 정확 1회를 보장한다
                # ("release 와 독립적으로"). target 은 아래 finally 의 _release_quiet
                # 가 받는 것과 **동일 핸들**이라 observer 와 release 의 상관관계가
                # 어긋나지 않는다(label 유일성은 어댑터 계약 — 코어는 release 와 같은
                # 키를 공유할 뿐 새 correlation 을 만들지 않음).
                try:
                    _notify_completion_observers(
                        target, completion.spec, completion, ok,
                    )

                    if ok:
                        report.succeeded += 1
                    else:
                        report.failed += 1
                        report.failures.append(completion.spec.label)
                    if isinstance(completion.result, WorkerResult):
                        report.tokens_in += completion.result.tokens_in
                        report.tokens_out += completion.result.tokens_out
                        report.findings_count += completion.result.findings_count
                        _c_seen = completion.result.candidates_seen
                        _c_acct = completion.result.candidates_accounted
                        report.candidates_seen += _c_seen
                        report.candidates_accounted += _c_acct
                        if _c_seen > 0 and _c_acct == 0:
                            report.candidates_silent_workers += 1

                    # 타깃 = 1 turn (워커 계약 4). judge streak 은 비간섭(None).
                    if goal_id is not None:
                        summary = (
                            completion.result.summary
                            if isinstance(completion.result, WorkerResult)
                            else completion.result.detail
                        )
                        await asyncio.to_thread(
                            state.goal_record_turn, goal_id,
                            verdict="continue",
                            reason=(
                                f"fanout {adapter.name}: {completion.spec.label} "
                                f"{status} — {summary}"
                            )[:500],
                            parse_fail=None,
                        )
                finally:
                    # 완료당 정확 1회 release — 위 bookkeeping/goal_record_turn 이
                    # (DB 장애로) raise 해도 claim 은 반드시 반납한다. observer 가
                    # 이미 completion 을 기록했는데 claim 이 미반납되면 read-model
                    # done ↔ 미release 불일치(stale reclaim 재실행→중복 attempt)가
                    # 난다 — finally 로 그 창을 닫는다(codex R2). _release_quiet 는
                    # 자체 예외를 삼키므로 원 예외를 가리지 않는다.
                    await _release_quiet(target, completion, success=ok)

                yield WorkerCompleted(
                    adapter=adapter.name, label=completion.spec.label,
                    ok=ok, status=status,
                    duration_sec=completion.duration_sec,
                )
    finally:
        if watcher is not None:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher

    report.cancelled = pool.cancelled
    report.exhausted = (
        not report.cancelled and not report.budget_capped
    )
    report.duration_sec = time.monotonic() - start
    yield FanoutCompleted(adapter=adapter.name, report=report)


# ── 어댑터 레지스트리 (재부착 plugin API) ─────────────────────────────
#
# plugin/skill repo 가 import 시점(또는 명시 부트스트랩)에 등록한다.
# 코어는 이름으로 찾을 뿐 도메인 구현을 모른다. factory 는 호출 시점
# 평가 — 어댑터가 세션/DB 자원을 lazy 하게 잡을 수 있게.

_FANOUT_ADAPTERS: dict[str, Callable[[], FanoutAdapter | Awaitable[FanoutAdapter]]] = {}


def register_fanout_adapter(
    name: str, factory: Callable[[], FanoutAdapter | Awaitable[FanoutAdapter]],
) -> None:
    """이름 중복은 명시 에러 — 어댑터 충돌은 silent override 금지."""
    if name in _FANOUT_ADAPTERS:
        raise ValueError(f"fanout adapter {name!r} 이미 등록됨")
    _FANOUT_ADAPTERS[name] = factory


def unregister_fanout_adapter(name: str) -> bool:
    return _FANOUT_ADAPTERS.pop(name, None) is not None


def get_fanout_adapter_factory(
    name: str,
) -> Callable[[], FanoutAdapter | Awaitable[FanoutAdapter]] | None:
    return _FANOUT_ADAPTERS.get(name)


def list_fanout_adapters() -> list[str]:
    return sorted(_FANOUT_ADAPTERS)
