"""Loop events emitted to observers (CLI, audit, tests)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from secu_agent.agent.llm.messages import AssistantMessage
from secu_agent.agent.llm.types import StreamUsage
from secu_agent.agent.tools.base import ToolResult


@dataclass(frozen=True, slots=True)
class TurnStarted:
    turn: int
    type: Literal["turn_started"] = "turn_started"


@dataclass(frozen=True, slots=True)
class TextChunk:
    text: str
    type: Literal["text_chunk"] = "text_chunk"


@dataclass(frozen=True, slots=True)
class ReasoningChunk:
    """reasoning 모델의 사고 trace — display 전용. LLM context / DB persistence 에 안 들어감."""
    text: str
    type: Literal["reasoning_chunk"] = "reasoning_chunk"


@dataclass(frozen=True, slots=True)
class ToolCallStarted:
    tool_use_id: str
    name: str
    input: dict[str, object]
    type: Literal["tool_call_started"] = "tool_call_started"


@dataclass(frozen=True, slots=True)
class ToolCallCompleted:
    tool_use_id: str
    name: str
    result: ToolResult
    type: Literal["tool_call_completed"] = "tool_call_completed"


LoopStopReason = Literal[
    "end_turn", "max_turns", "max_tokens", "stream_error", "aborted",
    "contract_violation",
    # 코드가 확인한 "닫을 대상이 없음". 정상 종료지만 end_turn 과 구분해서 센다 —
    # 리드가 빈 큐를 보고 끝낸 것과 일을 하고 끝낸 것은 다른 사실이다.
    "no_work",
]


@dataclass(frozen=True, slots=True)
class LoopCompleted:
    reason: LoopStopReason
    total_turns: int
    final_message: AssistantMessage | None
    usage: StreamUsage | None
    type: Literal["loop_completed"] = "loop_completed"


@dataclass(frozen=True, slots=True)
class LoopError:
    message: str
    type: Literal["loop_error"] = "loop_error"


# v3.62 Q5: LLM 호출 1회당 토큰/세그먼트 계측. engine 이 측정값만 emit (순수 유지),
# ChatSession 이 token_usage 테이블에 기록. char 는 system/tools/history 비중 proxy.
@dataclass(frozen=True, slots=True)
class LlmCallMeasured:
    turn: int
    system_chars: int
    tools_chars: int
    history_chars: int
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    type: Literal["llm_call_measured"] = "llm_call_measured"


# v3.35: Ralph loop — goal lifecycle events. ChatSession 이 outer loop 으로 emit.
@dataclass(frozen=True, slots=True)
class GoalDecomposed:
    goal_text: str
    item_count: int
    type: Literal["goal_decomposed"] = "goal_decomposed"


@dataclass(frozen=True, slots=True)
class GoalChecklistUpdated:
    flipped: int
    pending: int
    completed: int
    total: int
    reason: str
    type: Literal["goal_checklist_updated"] = "goal_checklist_updated"


@dataclass(frozen=True, slots=True)
class GoalDone:
    goal_text: str
    reason: str
    type: Literal["goal_done"] = "goal_done"


@dataclass(frozen=True, slots=True)
class GoalPaused:
    goal_text: str
    reason: str
    type: Literal["goal_paused"] = "goal_paused"


@dataclass(frozen=True, slots=True)
class GoalContinuation:
    """다음 iteration 의 continuation prompt 가 inject 됐다는 알림."""
    turn_used: int
    max_turns: int
    type: Literal["goal_continuation"] = "goal_continuation"


@dataclass(frozen=True, slots=True)
class BgTaskCompleted:
    """v3.43-P4: background process 가 끝났음을 알리는 push event.

    process_tool 의 watcher 가 proc.wait() 종료 시 emit. frontend banner / context_brief
    / WS broadcast 가 수신.
    """
    process_id: str
    command: str
    exit_code: int | None
    output_path: str
    output_tail: str
    duration_sec: float
    type: Literal["bg_task_completed"] = "bg_task_completed"


@dataclass(frozen=True, slots=True)
class WorkerCompleted:
    """v3.81 T1d: fan-out 워커 1개 완료 — UI 카운터용 경량 이벤트.

    batch fan-out 은 타깃당 GoalContinuation(LLM 패스) 대신 이걸 방출한다 —
    부모는 워커 transcript 를 받지 않고 집계 카운터만 갱신 (컨텍스트 경계).
    """
    adapter: str
    label: str
    ok: bool
    status: str  # WorkerResult.status 또는 invalid reason/outcome
    duration_sec: float
    type: Literal["worker_completed"] = "worker_completed"


@dataclass(frozen=True, slots=True)
class FanoutCompleted:
    """v3.81 T1d: fan-out 1회분 종결 보고 — report 는 fanout.FanoutReport."""
    adapter: str
    report: Any
    type: Literal["fanout_completed"] = "fanout_completed"


@dataclass(frozen=True, slots=True)
class PhaseStarted:
    """v3.83: TaskPlan 한 phase 진입 — UI phase 그룹 헤더용."""
    plan: str
    phase: str
    adapter: str
    k: int
    canary: bool
    type: Literal["phase_started"] = "phase_started"


@dataclass(frozen=True, slots=True)
class PhaseCompleted:
    """v3.83: phase 종결 — report 는 fanout.FanoutReport (canary+full 합산)."""
    plan: str
    phase: str
    report: Any
    type: Literal["phase_completed"] = "phase_completed"


@dataclass(frozen=True, slots=True)
class PhaseSkipped:
    """v3.83: gate 가 False 라 phase 미실행 (결정론 조건부 흐름)."""
    plan: str
    phase: str
    reason: str
    type: Literal["phase_skipped"] = "phase_skipped"


@dataclass(frozen=True, slots=True)
class PhaseAborted:
    """v3.83: canary 실패/어댑터 부재 등으로 phase 중단 (fan-out 안 함)."""
    plan: str
    phase: str
    reason: str
    type: Literal["phase_aborted"] = "phase_aborted"


@dataclass(frozen=True, slots=True)
class PlanCompleted:
    """v3.83: TaskPlan 전체 종결 — result 는 task_plan.PlanResult."""
    plan: str
    result: Any
    aborted: bool
    cancelled: bool
    reason: str
    type: Literal["plan_completed"] = "plan_completed"


LoopEvent = (
    TurnStarted | TextChunk | ReasoningChunk | ToolCallStarted | ToolCallCompleted
    | LoopCompleted | LoopError | LlmCallMeasured
    | GoalDecomposed | GoalChecklistUpdated | GoalDone | GoalPaused
    | GoalContinuation
    | BgTaskCompleted
    | WorkerCompleted | FanoutCompleted
    | PhaseStarted | PhaseCompleted | PhaseSkipped | PhaseAborted | PlanCompleted
)
