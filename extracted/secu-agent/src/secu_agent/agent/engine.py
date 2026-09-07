"""Agentic query loop.

하나의 turn = LLM call → zero-or-more tool exec → optional loop-back.
stop_reason='end_turn' 또는 가드 트립까지 반복.

Concurrency-safe 도구는 batch 병렬, 나머지는 직렬. recursion 방지 위해
NO_STASH 도구 결과는 stash 안 함.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from secu_agent.agent.candidate_ledger import build_candidate_ledger_reminder
from secu_agent.agent.execution_contract import build_execution_contract_reminder
from secu_agent.agent.finding_followup import build_finding_followup_reminder
from secu_agent.agent.terminal_contract import (
    REQUIRE_TERMINAL_TOOL_KEY,
    TERMINAL_INVOKED_KEY,
    TERMINAL_WAIVED_KEY,
    build_terminal_tool_reminder,
)
from secu_agent.agent.mutation_verifier import (
    build_mutation_verifier_footer,
    record_mutation_result,
)
from secu_agent.agent.events import (
    LlmCallMeasured,
    LoopCompleted,
    LoopError,
    LoopEvent,
    LoopStopReason,
    TextChunk,
    ToolCallCompleted,
    ToolCallStarted,
    TurnStarted,
)
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import (
    AssistantMessage,
    ContentBlock,
    ImageBlock,
    Message,
    StopReason,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from secu_agent.agent.llm.types import (
    LLMRequest,
    StreamError,
    StreamEvent,
    StreamMessageStop,
    StreamTextDelta,
    StreamToolUseDelta,
    StreamToolUseStart,
    StreamToolUseStop,
    StreamUsage,
)
from secu_agent.agent.compactor import (
    _total_chars as _message_total_chars,
    compact_messages,
    sliding_window,
)
from secu_agent.agent.read_context import clear_read_state
from secu_agent.agent.repeat_error import (
    REPEAT_CALL_HALT_THRESHOLD,
    RepeatErrorState,
    build_halt_message,
    build_repeat_call_halt_message,
    call_fingerprint,
    extract_error_signature,
)
from secu_agent.agent.stash import stash_large_result, tool_result_inline_max
from secu_agent.agent.tool_guardrails import (
    ToolCallGuardrailConfig,
    ToolCallGuardrailController,
    ToolGuardrailDecision,
)
from secu_agent.agent.turn_contract import should_emit_text_before_tool_calls
from secu_agent.agent.tools.base import (
    ToolContext,
    ToolError,
    ToolInvocation,
    ToolSuccess,
    tool_is_concurrency_safe,
)
from secu_agent.agent.tools.invoker import invoke_tool
from secu_agent.agent.tools.registry import ToolRegistry


# v3.72: 하이브리드 reasoning 승급 시 사용할 effort (자율 base 는 medium, 승급은 xhigh).
_DEEP_REASONING_EFFORT = os.environ.get("SA_DEEP_REASONING_EFFORT", "xhigh")

# F4-C: tool 이 되먹이는 이미지의 턴당 총 base64 바이트 상한(컨텍스트/비용 보호). 0=비활성
# (이미지 되먹임 끔). SA_TOOL_IMAGE_MAX_BYTES 로 조정.
_TOOL_IMAGE_MAX_BYTES_DEFAULT = 4 * 1024 * 1024


def _tool_image_cap_bytes() -> int:
    raw = os.environ.get("SA_TOOL_IMAGE_MAX_BYTES", "").strip()
    if not raw:
        return _TOOL_IMAGE_MAX_BYTES_DEFAULT
    try:
        value = int(raw)
    except ValueError:
        return _TOOL_IMAGE_MAX_BYTES_DEFAULT
    return value if value >= 0 else 0


_TOOL_IMAGE_HISTORY_KEEP_DEFAULT = 2  # 히스토리에 유지할 최근 이미지 수(나머지는 텍스트 치환)


def _tool_image_history_keep() -> int:
    raw = os.environ.get("SA_TOOL_IMAGE_HISTORY_KEEP", "").strip()
    if not raw:
        return _TOOL_IMAGE_HISTORY_KEEP_DEFAULT
    try:
        value = int(raw)
    except ValueError:
        return _TOOL_IMAGE_HISTORY_KEEP_DEFAULT
    return max(0, value)


def _prune_history_images(messages: "list[Message]", keep_last: int) -> None:
    """F4-C(C4): **이전 라운드**의 ImageBlock 을 최근 keep_last 개만 남기고 나머지는 텍스트
    placeholder 로 치환한다. 매 LLM 라운드에 전체 히스토리가 재전송되므로, 가지치기가 없으면
    반복 스크린샷이 컨텍스트를 무한 누적시킨다.

    **현재 라운드(마지막 메시지)의 이미지는 절대 가지치지 않는다**(D2: 모델이 아직 못 본 새
    이미지 — 한 라운드에 keep_last 초과 스크린샷을 찍어도 이번엔 전부 보여준다. 다음 라운드엔
    prior 가 되어 keep_last 로 줄어든다). keep_last=0 은 '현재 라운드만'. in-place 변경."""
    if not messages:
        return
    last_idx = len(messages) - 1  # 현재 라운드 = 보존
    positions: list[tuple[int, int]] = []
    for mi in range(last_idx):  # 마지막 메시지 제외
        content = getattr(messages[mi], "content", None)
        if not isinstance(content, list):
            continue
        for bi, b in enumerate(content):
            if isinstance(b, ImageBlock):
                positions.append((mi, bi))
    if len(positions) <= keep_last:
        return
    for mi, bi in positions[: len(positions) - keep_last]:  # 오래된 prior 부터 치환
        messages[mi].content[bi] = TextBlock(
            text="[이전 스크린샷 이미지 생략 — 컨텍스트 절약]",
        )


def _append_tool_images(
    result_blocks: "list[ContentBlock]",
    tool_calls: "list[ToolUseBlock]",
    images_by_id: "dict[str, tuple]",
) -> None:
    """F4-C: tool 이 반환한 이미지를 tool-result 직후 user 파트로 주입(비전 되먹임). 턴당
    총 base64 바이트 cap 을 넘으면 이후 이미지는 드롭(텍스트 결과는 그대로) — 컨텍스트 보호.
    tool_calls 순서대로 처리해 결정적."""
    cap = _tool_image_cap_bytes()
    if cap <= 0 or not images_by_id:
        return
    used = 0
    for call in tool_calls:
        for im in images_by_id.get(call.id, ()):  # type: ignore[union-attr]
            size = len(getattr(im, "data_b64", "") or "")
            if size == 0 or used + size > cap:
                continue  # 빈/초과 이미지 드롭(나머지 작은 것 기회 유지)
            result_blocks.append(
                ImageBlock(media_type=im.media_type, data_b64=im.data_b64),
            )
            used += size


def _resolve_reasoning_effort(
    base_effort: str | None, metadata: dict[str, object],
) -> str | None:
    """v3.72: 하이브리드 reasoning. base(자율=medium)에 더해 metadata 의
    `deep_passes_remaining` 카운터가 양수면 그 pass 를 _DEEP_REASONING_EFFORT(xhigh)로
    승급하고 카운터를 1 소진한다. 카운터는 deep_mode 도구(에이전트 판단) 또는
    finding_followup 안전망(HIGH severity 신호)이 세팅. 매 LLM 콜마다 호출되는 순수 함수."""
    try:
        rem = int(metadata.get("deep_passes_remaining", 0) or 0)
    except (TypeError, ValueError):
        rem = 0
    if rem > 0:
        metadata["deep_passes_remaining"] = rem - 1
        return _DEEP_REASONING_EFFORT
    return base_effort


@dataclass(slots=True)
class QueryConfig:
    # None = 무제한 (Claude Code 스타일). 사용자가 ESC/cancel 로 통제. 자율 영역은 정수 cap.
    max_turns: int | None = 60
    max_tokens_per_call: int = 16384
    temperature: float = 0.0
    parallel_readonly_limit: int = 5
    # context_compactor — 누적 char 가 이 값 넘으면 오래된 휘발 도구 결과 stub 화.
    # gpt-oss-120b context window 131K 토큰 (~400K char). 60K char ≈ 20K 토큰 — 15% 활용.
    # ── 컨텍스트 예산 (2026-08-27 실측 기반) ──────────────────────────────
    #
    # 서빙 모델 한계를 **실측**했다(gateway 는 max_input 을 안 알려준다 — None):
    #
    #     gemma (openai/Gemma4-260430)   256,000 토큰 통과 · 512,000 거부
    #     deepseek-v4                    1,000,000 (게이트웨이 신고값)
    #
    # 옛 값 60,000자는 안전선(256K 토큰 ≈ 1,024,000자)의 **6%** 였다. 리드 실측
    # 컨텍스트가 68,000자였으니 매 턴 압축이 걸리면서 아무것도 못 줄이고 있었다
    # (리드 도구는 COMPACTABLE_TOOLS 에 하나도 없다).
    #
    # ⚠️ 상한까지 채우지 않는다. 프로파일이 바뀌면 한계도 바뀌고(codex 는 다르다),
    #    출력 토큰과 reasoning 도 같은 창을 쓴다. 실측 안전선의 1/4 쯤에서 끊는다.
    compact_char_threshold: int = 240_000
    compact_keep_last_n: int = 2
    # v3.47: sliding window — compact 후에도 누적 char 가 이 값 넘으면 head + tail 만 유지.
    # gpt-oss-120b 131K 토큰 ≈ 400K char. 200K = ~50% 활용 (안전 margin).
    # ★ 마지막 방어선. 여기 닿으면 **요약이 아니라 절단**이다(head_n + tail_n 만 남음).
    #   압축 임계값보다 넉넉히 위에 둬야 압축이 먼저 일할 기회를 갖는다.
    sliding_window_max_chars: int = 600_000
    sliding_window_head_n: int = 4
    sliding_window_tail_n: int = 12
    # plan execution contract — approved/executing plan_mode must use tools or exit.
    max_plan_contract_reminders: int = 2
    # execution contract — active todos must use tools or terminal todo updates.
    max_execution_contract_reminders: int = 3
    # finding follow-up contract — tool-produced finding signals must refine todos.
    max_finding_followup_reminders: int = 3
    # candidate ledger contract — observed candidates need submit or explicit triage.
    max_candidate_ledger_reminders: int = 2
    # terminal-tool contract — required completion status tool must be *invoked*,
    # not described as text (weak-model failure mode). opt-in via metadata.
    max_terminal_tool_reminders: int = 2
    # Hermes-style tool loop guardrails.
    tool_guardrails: bool = True
    tool_guardrail_warnings_enabled: bool = True
    tool_guardrail_hard_stop_enabled: bool = False
    tool_guardrail_exact_failure_warn_after: int = 2
    tool_guardrail_exact_failure_block_after: int = 5
    tool_guardrail_same_tool_failure_warn_after: int = 3
    tool_guardrail_same_tool_failure_halt_after: int = 8
    tool_guardrail_no_progress_warn_after: int = 2
    tool_guardrail_no_progress_block_after: int = 5
    # reasoning_effort override — None 이면 LLM profile 의 기본값. operator chat 같은
    # interactive orchestrator 는 'low' 가 적합 (deep reasoning 은 sub-agent 가 함).
    reasoning_effort: str | None = None
    # v3.87 Front-D: 모델 등급(profile.harness_tier 에서 전파). _tool_guardrail_config 만
    # 소비 — 생산성 loop-guard 임계값을 등급에 맞춰 스케일한다. 안전 게이트는 참조 안 함.
    harness_tier: str | None = None


@dataclass(slots=True)
class _ToolUseBuilder:
    id: str
    name: str
    args_buffer: str = ""
    sealed: bool = False
    parsed_input: dict[str, object] | None = None


@dataclass(slots=True)
class _AssistantBuilder:
    text_parts: list[str] = field(default_factory=list)
    tool_uses: dict[str, _ToolUseBuilder] = field(default_factory=dict)
    tool_use_order: list[str] = field(default_factory=list)
    stop_reason: StopReason | None = None
    usage: StreamUsage | None = None

    def apply(self, ev: StreamEvent) -> ToolUseBlock | None:
        if isinstance(ev, StreamTextDelta):
            self.text_parts.append(ev.text)
        elif isinstance(ev, StreamToolUseStart):
            if ev.tool_use_id not in self.tool_uses:
                self.tool_uses[ev.tool_use_id] = _ToolUseBuilder(ev.tool_use_id, ev.name)
                self.tool_use_order.append(ev.tool_use_id)
        elif isinstance(ev, StreamToolUseDelta):
            if ev.tool_use_id in self.tool_uses:
                self.tool_uses[ev.tool_use_id].args_buffer += ev.input_json_delta
        elif isinstance(ev, StreamToolUseStop):
            tub = self.tool_uses.get(ev.tool_use_id)
            if tub is not None and not tub.sealed:
                parsed = _parse_tool_args(tub.args_buffer)
                tub.sealed = True
                tub.parsed_input = parsed
                if _tool_args_parse_valid(parsed):
                    return ToolUseBlock(id=tub.id, name=tub.name, input=parsed)
        elif isinstance(ev, StreamMessageStop):
            self.stop_reason = ev.stop_reason
            self.usage = ev.usage
        return None

    def build(self) -> AssistantMessage:
        content: list[ContentBlock] = []
        if self.text_parts:
            content.append(TextBlock(text="".join(self.text_parts)))
        for tid in self.tool_use_order:
            tub = self.tool_uses[tid]
            parsed = tub.parsed_input
            if parsed is None:
                parsed = _parse_tool_args(tub.args_buffer)
            content.append(ToolUseBlock(id=tub.id, name=tub.name, input=parsed))
        return AssistantMessage(content=content, stop_reason=self.stop_reason)


def _parse_tool_args(buffer: str) -> dict[str, object]:
    """LLM 의 raw JSON tool args 를 lenient 하게 parse.

    LLM 이 흔히 깨뜨리는 패턴:
    1. 문자열 안에 raw \\n/\\t (escape 안 함) → strict=False 로 통과.
    2. single quote 를 `\\'` 로 escape — JSON 표준에 없음 → invalid escape error.
       fix: `\\'` → `'` substitute 후 재시도.
    """
    if not buffer:
        return {}
    candidates = [buffer]
    # v3.34-A: invalid JSON escape (\\') 정규화 시도. Python string 에서 r"\'" 는 단순히
    # backslash + quote 두 글자. `replace` 로 잘라낸 다음 strict 재시도.
    if "\\'" in buffer:
        candidates.append(buffer.replace("\\'", "'"))
    for cand in candidates:
        for strict in (True, False):
            try:
                result: object = json.loads(cand, strict=strict)
            except json.JSONDecodeError:
                continue
            if isinstance(result, dict):
                return result
            return {"__parse_error": buffer}
    return {"__parse_error": buffer}


def _tool_args_parse_valid(parsed: dict[str, object]) -> bool:
    return "__parse_error" not in parsed


# 가벼운 enum / scan 결과는 stash 안 함 — recursion 방지.
# skill (v3.26): view 본문은 자체 size cap 처리 — agent 가 두 번째 호출 강요 없이 직접 read.
# 코어 자신의 도구만 둔다. 도메인 도구는 plugin 이 `register_no_stash_tool` 로 등록한다.
#
# de-domain (2026-08-20): 여기 도메인 도구 이름 9개가 하드코딩돼 있었고 그중 **7개는
# 이미 존재하지 않는 이름**이었다(smb_enum_hosts/smb_list_shares/smb_walk_share/
# gh_list_repos/gh_list_paths_matching/jenkins_list_jobs/jenkins_list_builds).
# 도메인 도구가 사라져도 코어는 알 길이 없어서 죽은 채로 남았다 — 등록형으로 바꾸면
# 도구와 면제가 같은 곳에서 산다.
_CORE_NO_STASH_TOOLS: frozenset[str] = frozenset({
    "scan_text", "submit_finding",
    # skill (v3.26): view 본문은 자체 size cap 처리 — agent 가 두 번째 호출 강요 없이 직접 read.
    "skill",
    # v3.48: evidence-read 도구 결과는 stash 안 함 — 결과가 이미 evidence 본문이라
    # stash 가 또 작동하면 새 file 생성 → agent 가 그 file 또 read → 무한 loop.
    # 도구 자체에 30K char cap 박혀있어서 안전.
    "read_evidence_file", "grep_evidence",
    "host_read", "host_search", "host_code_outline",
})

_PLUGIN_NO_STASH_TOOLS: set[str] = set()


def register_no_stash_tool(name: str) -> None:
    """이 도구 결과는 stash 하지 않는다 (plugin API).

    가벼운 enum/list 결과처럼 stash 가 오히려 turn 을 낭비시키는 도구용이다.
    코어 도구는 `_CORE_NO_STASH_TOOLS` 에, 도메인 도구는 이 훅으로.
    미등록은 그냥 stash 대상 — fail-safe 다(누락돼도 동작이 깨지지 않고 turn 만 는다).
    """
    n = str(name or "").strip()
    if not n:
        raise ValueError("no-stash 도구 이름이 비어 있음")
    _PLUGIN_NO_STASH_TOOLS.add(n)


def unregister_no_stash_tool(name: str) -> bool:
    """등록 해제 (test/plugin 재부착용)."""
    return _PLUGIN_NO_STASH_TOOLS.discard(str(name or "").strip()) or True


def no_stash_tools() -> frozenset[str]:
    return frozenset(_CORE_NO_STASH_TOOLS | _PLUGIN_NO_STASH_TOOLS)


def _format_tool_result(
    result: ToolSuccess | ToolError, context: ToolContext, tool_name: str,
) -> tuple[str, bool]:
    if isinstance(result, ToolError):
        return f"[{result.kind}] {result.message}", True
    raw = result.content
    if tool_name not in no_stash_tools() and len(raw) > tool_result_inline_max():
        summary, _ = stash_large_result(tool_name, raw, context.evidence_dir)
        return summary, False
    return raw, False


# Front-D: 모델 등급별 **생산성 loop-guard** 임계값 스케일. 안전 불변식과 무관 —
# 강한 모델은 자기수정 잘 하니 느슨(오탐 halt↓), 약한 모델은 루프 위험 커 엄격(조기 halt).
# None/mid = 1.0(무변). 스케일은 count 임계값에만 적용(warn/block/halt 카운트); 경보 on/off
# 불리언과 안전 게이트는 절대 건드리지 않는다.
# 등급별 의도 배율(문서·테스트용). 실제 산술은 _tier_scaled 가 정수 연산으로 수행한다.
_HARNESS_TIER_GUARDRAIL_SCALE = {"frontier": 2.0, "mid": 1.0, "small": 0.5}
# 값을 실제로 바꾸는 등급(mid/None/미지는 passthrough) — 위 배율에서 파생(단일 진실원).
_HARNESS_TIER_SCALING = frozenset(
    t for t, s in _HARNESS_TIER_GUARDRAIL_SCALE.items() if s != 1.0
)


def _round_half_even_div2(n: int) -> int:
    """정수 round-half-to-even(n/2) — float 미사용이라 초대형 정수도 정확·오버플로 없음.
    round(n*0.5) 와 동일 결과(짝수 반올림)."""
    q, r = divmod(n, 2)
    if r == 0:
        return q
    return q if q % 2 == 0 else q + 1  # n 홀수 → q+0.5 → 짝수쪽으로 반올림


def _tier_scaled(base: int, tier: str | None) -> int:
    """loop-guard count 임계값을 등급별로 스케일 — **정수 연산만**(float 정밀/오버플로 회피).
    frontier=정수배(×2, 느슨), small=정수 round-half-even(÷2, 엄격, 최소 1). mid/None/미지는
    **원본 그대로 통과**(0 포함 — 정확한 하위호환)."""
    t = tier or "mid"
    if t == "frontier":
        return base * 2
    if t == "small":
        return max(1, _round_half_even_div2(base))
    return base  # mid/미지 = 정확 passthrough


def _tier_scaled_pair(warn: int, block: int, tier: str | None) -> tuple[int, int]:
    """(warn, block) 쌍을 등급별로 스케일. **스케일하는 등급(frontier/small)에서만** 원래
    warn<block 이던 사다리를 보존한다 — small ÷2 가 둘 다 floor 로 눌러 붕괴하는 경계
    (4/5→2/2, 1/2→1/1)에서도 최소 1/2 2단 사다리를 보장(warn 단계 소실 방지). mid/None
    (passthrough)은 어떤 복원도 하지 않아 원본 쌍을 정확히 그대로 둔다(하위호환)."""
    sw, sb = _tier_scaled(warn, tier), _tier_scaled(block, tier)
    # 스케일이 사다리를 실제로 붕괴시킨 경우(sw>=sb)에만 복원 — 안 붕괴했으면(예 frontier
    # (0,1)→(0,2)) 스케일 원값 그대로 둔다(불필요하게 warn 을 끌어올리지 않음).
    if (tier or "mid") in _HARNESS_TIER_SCALING and warn < block and sw >= sb:
        sb = max(sb, 2)              # 최소 block=2 (warn 사다리 유지)
        sw = max(1, min(sw, sb - 1))  # warn 은 1..block-1
    return sw, sb


def _tool_guardrail_config(cfg: QueryConfig) -> ToolCallGuardrailConfig:
    tier = cfg.harness_tier
    exact_warn, exact_block = _tier_scaled_pair(
        cfg.tool_guardrail_exact_failure_warn_after,
        cfg.tool_guardrail_exact_failure_block_after, tier)
    same_warn, same_halt = _tier_scaled_pair(
        cfg.tool_guardrail_same_tool_failure_warn_after,
        cfg.tool_guardrail_same_tool_failure_halt_after, tier)
    nop_warn, nop_block = _tier_scaled_pair(
        cfg.tool_guardrail_no_progress_warn_after,
        cfg.tool_guardrail_no_progress_block_after, tier)
    return ToolCallGuardrailConfig(
        warnings_enabled=cfg.tool_guardrail_warnings_enabled,
        hard_stop_enabled=cfg.tool_guardrail_hard_stop_enabled,
        exact_failure_warn_after=exact_warn,
        exact_failure_block_after=exact_block,
        same_tool_failure_warn_after=same_warn,
        same_tool_failure_halt_after=same_halt,
        no_progress_warn_after=nop_warn,
        no_progress_block_after=nop_block,
    )


def _tool_guardrail_for_context(context: ToolContext) -> ToolCallGuardrailController | None:
    guard = context.metadata.get("_tool_guardrail_controller")
    if isinstance(guard, ToolCallGuardrailController):
        return guard
    return None


def _guardrail_note(decision: ToolGuardrailDecision) -> str:
    label = "Tool loop warning" if decision.action == "warn" else "Tool loop hard stop"
    return f"{label} ({decision.code}): {decision.message}"


def _append_guardrail_decision(
    result: ToolSuccess | ToolError,
    decision: ToolGuardrailDecision,
    context: ToolContext,
) -> ToolSuccess | ToolError:
    if decision.action == "allow":
        return result
    note = _guardrail_note(decision)
    if decision.action == "halt":
        context.signal.set()
    if isinstance(result, ToolError):
        return ToolError(kind=result.kind, message=f"{result.message}\n\n{note}")
    # F4-C: 가드레일 note 를 붙일 때 images 보존(스크린샷 되먹임 유실 방지).
    return ToolSuccess(content=f"{result.content}\n\n[{note}]", images=result.images)


def _plan_steps_text(plan: object) -> str:
    if not isinstance(plan, dict):
        return "saved plan"
    raw_steps = plan.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        return "saved plan"
    steps = [str(s) for s in raw_steps[:6]]
    return "; ".join(steps)


def _build_plan_contract_reminder(context: ToolContext) -> str | None:
    if not context.metadata.get("plan_mode_active"):
        return None
    status = str(context.metadata.get("plan_mode_status") or "approved")
    if status not in {"approved", "executing"}:
        return None
    steps = _plan_steps_text(context.metadata.get("plan_mode_plan"))
    if status == "approved":
        return (
            "[SYSTEM NOTE] plan_mode is approved and active. "
            "Do not answer with a text-only promise. Call the concrete tools needed "
            f"to execute the approved plan now. steps: {steps}. "
            "When the work is complete, call exit_plan_mode with a summary."
        )
    return (
        "[SYSTEM NOTE] plan_mode is executing. "
        "A text-only result cannot close this state. Continue with the required "
        f"tool calls for the approved plan, or call exit_plan_mode if complete. "
        f"steps: {steps}."
    )


async def _stream_and_yield(
    client: LLMClient, request: LLMRequest, builder: _AssistantBuilder,
    executor: _StreamingToolExecutor | None = None,
    context: ToolContext | None = None,
) -> AsyncIterator[LoopEvent | StreamError | _StreamToolEvent | _StreamAborted]:
    from secu_agent.agent.events import ReasoningChunk as _RC
    from secu_agent.agent.llm.types import StreamReasoningDelta as _SRD

    # ★ 요청을 보내는 **그 순간** 부모 타이머를 한 번 되돌린다 (2026-08-27).
    #
    #   idle 워치독은 `turn_started` 이후 이벤트가 없으면 운다. 그런데 모델이 첫 청크를
    #   내놓기까지(추론·백엔드 대기) 관측 가능한 이벤트가 **하나도 없다**. 그래서
    #   느린 호출 하나가 살아 있는 런을 죽였다 — 실측 2026-08-27:
    #
    #       [loop error] harness idle timeout: no observable activity for 300.3s
    #                    after turn_started
    #       github 검토원 7/7 · confluence 10/38 이 이렇게 죽었다
    #
    #   여기서 한 번 touch 하면 호출은 `max_idle_sec` 만큼의 시간을 온전히 받는다.
    #
    #   ⚠️ 하트비트가 아니다. **요청당 한 번**이다. 응답이 영영 안 오면 워치독은 여전히
    #      운다 — 그게 워치독의 일이다. 주기적으로 touch 하면 멎은 호출을 무한정 붙잡는다.
    #
    #   ⚠️ 이것만으로는 부족하다. `max_idle_sec` 이 클라이언트 timeout 보다 커야
    #      "클라이언트가 먼저 말하고, 워치독은 진짜 죽음만 잡는" 순서가 된다
    #      (`_shared/inspect_contract.INSPECTOR_IDLE_SEC_DEFAULT` 와 그 테스트 참조).
    if context is not None:
        context.report_progress("llm_request_sent")

    async for ev in client.stream(request):
        if context is not None and context.aborted:
            if executor is not None:
                await executor.cancel(discard_results=True)
            yield _StreamAborted()
            return
        sealed_call = builder.apply(ev)
        if sealed_call is not None and executor is not None:
            await executor.submit(sealed_call)
        if isinstance(ev, _SRD):
            yield _RC(text=ev.text)
        elif isinstance(ev, StreamError):
            yield ev
            return
        if executor is not None:
            for tool_event, block in executor.drain_ready():
                yield _StreamToolEvent(tool_event, block)
        if context is not None and context.aborted:
            if executor is not None:
                await executor.cancel(discard_results=True)
            yield _StreamAborted()
            return


@dataclass(frozen=True, slots=True)
class _StreamToolEvent:
    event: LoopEvent
    block: ToolResultBlock | None


@dataclass(frozen=True, slots=True)
class _StreamAborted:
    pass


def _assistant_text(assistant: AssistantMessage) -> str:
    return "".join(b.text for b in assistant.content if isinstance(b, TextBlock))


def _append_text_to_assistant(
    assistant: AssistantMessage, extra_text: str,
) -> AssistantMessage:
    if not extra_text:
        return assistant
    content: list[ContentBlock] = list(assistant.content)
    for idx in range(len(content) - 1, -1, -1):
        block = content[idx]
        if isinstance(block, TextBlock):
            content[idx] = TextBlock(text=block.text + extra_text)
            return AssistantMessage(content=content, stop_reason=assistant.stop_reason)
    content.append(TextBlock(text=extra_text))
    return AssistantMessage(content=content, stop_reason=assistant.stop_reason)


def _finalize_text_answer(
    assistant: AssistantMessage, context: ToolContext,
) -> tuple[AssistantMessage, str]:
    footer = build_mutation_verifier_footer(context.metadata)
    final = _append_text_to_assistant(assistant, footer)
    return final, _assistant_text(final)


def _partition_calls(
    calls: list[ToolUseBlock], registry: ToolRegistry,
) -> list[tuple[bool, list[ToolUseBlock]]]:
    """연속 concurrency-safe call은 한 batch, 나머지는 단독 batch."""
    batches: list[tuple[bool, list[ToolUseBlock]]] = []
    for call in calls:
        tool_cls = registry.get(call.name)
        is_concurrency_safe = tool_is_concurrency_safe(tool_cls) if tool_cls else False
        if is_concurrency_safe and batches and batches[-1][0]:
            batches[-1][1].append(call)
        else:
            batches.append((is_concurrency_safe, [call]))
    return batches


async def _invoke_with_semaphore(
    sem: asyncio.Semaphore, call: ToolUseBlock,
    registry: ToolRegistry, context: ToolContext,
) -> tuple[ToolUseBlock, ToolSuccess | ToolError]:
    async with sem:
        result = await _invoke_tool_with_guardrails(call, registry, context)
        return call, result


@dataclass(slots=True)
class _RunningStreamingTool:
    call: ToolUseBlock
    is_concurrency_safe: bool
    cancel_message: str = "aborted mid-turn"


class _StreamingToolExecutor:
    """Start sealed tool_use blocks during streaming while preserving barriers."""

    def __init__(
        self,
        registry: ToolRegistry,
        context: ToolContext,
        cfg: QueryConfig,
    ) -> None:
        self._registry = registry
        self._context = context
        self._sem = asyncio.Semaphore(max(1, cfg.parallel_readonly_limit))
        self._queued: list[ToolUseBlock] = []
        self._running: dict[asyncio.Task[None], _RunningStreamingTool] = {}
        self._events: asyncio.Queue[
            tuple[LoopEvent, ToolResultBlock | None]
        ] = asyncio.Queue()
        self._started_ids: set[str] = set()
        self._discard_results = False
        self._batch_cancelling = False
        self._lock = asyncio.Lock()
        self._abort_task: asyncio.Task[None] | None = None

    @property
    def started_ids(self) -> set[str]:
        return set(self._started_ids)

    def start_abort_monitor(self) -> None:
        if self._abort_task is None:
            self._abort_task = asyncio.create_task(self._watch_abort())

    async def stop_abort_monitor(self) -> None:
        task = self._abort_task
        self._abort_task = None
        if task is None:
            return
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def submit(self, call: ToolUseBlock) -> None:
        async with self._lock:
            if self._discard_results or self._context.aborted:
                return
            self._queued.append(call)
            self._schedule_locked()

    def drain_ready(self) -> list[tuple[LoopEvent, ToolResultBlock | None]]:
        events: list[tuple[LoopEvent, ToolResultBlock | None]] = []
        while True:
            try:
                events.append(self._events.get_nowait())
            except asyncio.QueueEmpty:
                return events

    async def drain_until_idle(
        self,
    ) -> AsyncIterator[tuple[LoopEvent, ToolResultBlock | None]]:
        while True:
            for item in self.drain_ready():
                yield item
            async with self._lock:
                active = bool(self._queued or self._running)
            if not active:
                return
            yield await self._events.get()

    async def cancel(self, *, discard_results: bool) -> None:
        async with self._lock:
            if discard_results:
                self._discard_results = True
                self._queued.clear()
                self._clear_events_locked()
            tasks = list(self._running)
            self._cancel_running_locked("aborted mid-turn")
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if discard_results:
            async with self._lock:
                self._clear_events_locked()

    async def _watch_abort(self) -> None:
        await self._context.signal.wait()
        await self.cancel(discard_results=True)

    def _clear_events_locked(self) -> None:
        while True:
            try:
                self._events.get_nowait()
            except asyncio.QueueEmpty:
                return

    def _call_is_concurrency_safe(self, call: ToolUseBlock) -> bool:
        tool_cls = self._registry.get(call.name)
        return tool_is_concurrency_safe(tool_cls) if tool_cls else False

    def _schedule_locked(self) -> None:
        if self._discard_results or self._batch_cancelling:
            return
        if self._context.aborted:
            self._cancel_queued_locked("aborted mid-turn")
            return
        while self._queued:
            if any(not info.is_concurrency_safe for info in self._running.values()):
                return
            call = self._queued[0]
            is_concurrency_safe = self._call_is_concurrency_safe(call)
            if not is_concurrency_safe and self._running:
                return
            self._queued.pop(0)
            self._start_locked(call, is_concurrency_safe)
            if not is_concurrency_safe:
                return

    def _start_locked(self, call: ToolUseBlock, is_concurrency_safe: bool) -> None:
        self._started_ids.add(call.id)
        # (종료 도구 계약 플래그는 invoker._execute 의 canonical choke point 가
        # 실제 execute 진입 시 기록한다 — task 생성 시점인 여기서 세면 취소/검증/
        # 권한 실패로 execute 에 도달 못 한 도구를 오분류한다, codex R6.)
        self._events.put_nowait((
            ToolCallStarted(tool_use_id=call.id, name=call.name, input=call.input),
            None,
        ))
        task = asyncio.create_task(self._run_call(call))
        self._running[task] = _RunningStreamingTool(call, is_concurrency_safe)

    def _cancel_running_locked(self, message: str) -> None:
        for task, info in self._running.items():
            info.cancel_message = message
            task.cancel()

    def _cancel_queued_locked(self, message: str) -> None:
        while self._queued:
            call = self._queued.pop(0)
            self._started_ids.add(call.id)
            self._events.put_nowait((
                ToolCallStarted(tool_use_id=call.id, name=call.name, input=call.input),
                None,
            ))
            self._events.put_nowait((
                ToolCallCompleted(
                    tool_use_id=call.id,
                    name=call.name,
                    result=ToolError(kind="cancelled", message=message),
                ),
                ToolResultBlock(
                    tool_use_id=call.id,
                    content=f"[cancelled] {message}",
                    is_error=True,
                ),
            ))

    async def _run_call(self, call: ToolUseBlock) -> None:
        task = asyncio.current_task()
        result: ToolSuccess | ToolError
        hard_failure = False
        try:
            _call, result = await _invoke_with_semaphore(
                self._sem, call, self._registry, self._context,
            )
        except asyncio.CancelledError:
            async with self._lock:
                info = self._running.get(task)
                discard = self._discard_results
            if discard:
                await self._finish_task(task, completed=None, hard_failure=False)
                return
            message = info.cancel_message if info is not None else "aborted mid-turn"
            result = ToolError(kind="cancelled", message=message)
        except Exception as e:
            result = ToolError(kind="execution", message=f"{type(e).__name__}: {e}")
            hard_failure = True

        completed = _tool_call_completed(call, result, self._context)
        await self._finish_task(task, completed=completed, hard_failure=hard_failure)

    async def _finish_task(
        self,
        task: asyncio.Task[None] | None,
        completed: tuple[LoopEvent, ToolResultBlock] | None,
        *,
        hard_failure: bool,
    ) -> None:
        async with self._lock:
            if task is not None:
                self._running.pop(task, None)
            if completed is not None and not self._discard_results:
                self._events.put_nowait(completed)
            if self._discard_results:
                return
            if hard_failure and self._running:
                self._batch_cancelling = True
                self._cancel_running_locked("cancelled after sibling failure")
            if self._batch_cancelling and not self._running:
                self._batch_cancelling = False
            if not self._batch_cancelling:
                self._schedule_locked()


def _tool_call_completed(
    call: ToolUseBlock,
    result: ToolSuccess | ToolError,
    context: ToolContext,
) -> tuple[ToolCallCompleted, ToolResultBlock]:
    content, is_error = _format_tool_result(result, context, call.name)
    surfaced: ToolSuccess | ToolError = result
    if isinstance(result, ToolSuccess) and content is not result.content:
        # F4-C: content 는 마스킹/포맷될 수 있으나 images 는 보존해 되먹임에 쓴다.
        surfaced = ToolSuccess(content=content, images=result.images)
    record_mutation_result(
        context.metadata,
        tool_name=call.name,
        tool_input=call.input,
        result=result,
    )
    return (
        ToolCallCompleted(tool_use_id=call.id, name=call.name, result=surfaced),
        ToolResultBlock(tool_use_id=call.id, content=content, is_error=is_error),
    )


async def _invoke_tool_with_guardrails(
    call: ToolUseBlock,
    registry: ToolRegistry,
    context: ToolContext,
) -> ToolSuccess | ToolError:
    tool_cls = registry.get(call.name)
    is_ro = bool(tool_cls and tool_cls.is_read_only)
    guard = _tool_guardrail_for_context(context)
    if guard is not None:
        before = guard.before_call(call.name, call.input, is_read_only=is_ro)
        if before.action == "block":
            return ToolError(kind="budget", message=_guardrail_note(before))

    result = await invoke_tool(
        ToolInvocation(id=call.id, name=call.name, input=call.input),
        registry, context,
    )
    if guard is None:
        return result

    observed = result.message if isinstance(result, ToolError) else result.content
    after = guard.after_call(
        call.name,
        call.input,
        observed,
        is_read_only=is_ro,
        failed=isinstance(result, ToolError),
    )
    return _append_guardrail_decision(result, after, context)


async def _run_tool_calls(
    calls: list[ToolUseBlock], registry: ToolRegistry,
    context: ToolContext, cfg: QueryConfig,
) -> AsyncIterator[tuple[LoopEvent, ToolResultBlock | None]]:
    batches = _partition_calls(calls, registry)
    sem = asyncio.Semaphore(max(1, cfg.parallel_readonly_limit))

    for is_concurrency_safe, batch in batches:
        if context.aborted:
            for call in batch:
                yield (
                    ToolCallStarted(tool_use_id=call.id, name=call.name, input=call.input),
                    None,
                )
                yield (
                    ToolCallCompleted(
                        tool_use_id=call.id, name=call.name,
                        result=ToolError(kind="cancelled", message="aborted mid-turn"),
                    ),
                    ToolResultBlock(
                        tool_use_id=call.id, content="[cancelled] aborted mid-turn", is_error=True,
                    ),
                )
            continue

        if is_concurrency_safe and len(batch) > 1:
            for call in batch:
                yield (
                    ToolCallStarted(tool_use_id=call.id, name=call.name, input=call.input),
                    None,
                )
            tasks = [
                asyncio.create_task(_invoke_with_semaphore(sem, c, registry, context))
                for c in batch
            ]
            task_indexes = {task: i for i, task in enumerate(tasks)}
            pending = set(tasks)
            abort_task = asyncio.create_task(context.signal.wait())
            try:
                while pending:
                    wait_for = set(pending)
                    if not abort_task.done():
                        wait_for.add(abort_task)
                    done, _ = await asyncio.wait(
                        wait_for, return_when=asyncio.FIRST_COMPLETED,
                    )
                    hard_failure = False
                    completed_tasks = [task for task in done if task in pending]
                    for task in completed_tasks:
                        pending.remove(task)
                        call = batch[task_indexes[task]]
                        try:
                            _call, result = task.result()
                        except asyncio.CancelledError:
                            result = ToolError(kind="cancelled", message="aborted mid-turn")
                            hard_failure = True
                        except Exception as e:
                            result = ToolError(
                                kind="execution",
                                message=f"{type(e).__name__}: {e}",
                            )
                            hard_failure = True
                        yield _tool_call_completed(call, result, context)

                    if pending and (hard_failure or (abort_task in done and context.aborted)):
                        message = (
                            "aborted mid-turn"
                            if context.aborted
                            else "cancelled after sibling failure"
                        )
                        cancelling = sorted(pending, key=lambda task: task_indexes[task])
                        for task in cancelling:
                            task.cancel()
                        await asyncio.gather(*cancelling, return_exceptions=True)
                        for task in cancelling:
                            pending.discard(task)
                            call = batch[task_indexes[task]]
                            try:
                                _call, result = task.result()
                            except asyncio.CancelledError:
                                result = ToolError(kind="cancelled", message=message)
                            except Exception as e:
                                result = ToolError(
                                    kind="execution",
                                    message=f"{type(e).__name__}: {e}",
                                )
                            yield _tool_call_completed(call, result, context)
            finally:
                if pending:
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                if not abort_task.done():
                    abort_task.cancel()
                    await asyncio.gather(abort_task, return_exceptions=True)
        else:
            for call in batch:
                yield (
                    ToolCallStarted(tool_use_id=call.id, name=call.name, input=call.input),
                    None,
                )
                result = await _invoke_tool_with_guardrails(call, registry, context)
                yield _tool_call_completed(call, result, context)


async def run_query(
    *,
    client: LLMClient,
    registry: ToolRegistry,
    context: ToolContext,
    initial_messages: list[Message],
    system: str | None = None,
    config: QueryConfig | None = None,
    unlocked_tools: set[str] | None = None,
) -> AsyncIterator[LoopEvent]:
    cfg = config or QueryConfig()
    messages: list[Message] = list(initial_messages)
    unlocked = set(unlocked_tools or ())
    context.registry = registry
    context.unlocked_tools = unlocked
    clear_read_state(context.metadata)
    if cfg.tool_guardrails:
        context.metadata["_tool_guardrail_controller"] = ToolCallGuardrailController(
            _tool_guardrail_config(cfg),
        )
    else:
        context.metadata.pop("_tool_guardrail_controller", None)
    turn = 0
    cumulative_usage: StreamUsage | None = None
    final_message: AssistantMessage | None = None

    while True:
        if context.aborted:
            yield LoopCompleted(
                reason="aborted", total_turns=turn,
                final_message=final_message, usage=cumulative_usage,
            )
            return

        turn += 1
        if cfg.max_turns is not None and turn > cfg.max_turns:
            yield LoopCompleted(
                reason="max_turns", total_turns=turn - 1,
                final_message=final_message, usage=cumulative_usage,
            )
            return

        # turn-내 호출 카운터 reset (harness/web_fetch 등이 사용)
        context.per_turn_counts.clear()
        yield TurnStarted(turn=turn)

        # context compactor — 누적 본문 폭증 방지. 휘발 도구 결과만 stub 치환.
        messages, _compacted_n = compact_messages(
            messages,
            char_threshold=cfg.compact_char_threshold,
            keep_last_n=cfg.compact_keep_last_n,
        )
        if _compacted_n > 0:
            clear_read_state(context.metadata)
        # v3.47: compact 후에도 임계 초과면 sliding window — head + tail 만 유지.
        # 영속 도구 (smb_python / submit_finding) 결과나 누적 turn 폭주 응급 처치.
        messages, _dropped_n = sliding_window(
            messages,
            max_chars=cfg.sliding_window_max_chars,
            head_n=cfg.sliding_window_head_n,
            tail_n=cfg.sliding_window_tail_n,
        )
        if _dropped_n > 0:
            clear_read_state(context.metadata)

        vendor: dict[str, object] = {}
        # v3.72: 하이브리드 reasoning — base(자율=medium) + deep_passes_remaining 승급(xhigh).
        effort = _resolve_reasoning_effort(cfg.reasoning_effort, context.metadata)
        if effort is not None:
            vendor["reasoning_effort"] = effort
        request = LLMRequest(
            messages=messages,
            system=system,
            tools=registry.build_specs(unlocked),
            max_tokens=cfg.max_tokens_per_call,
            temperature=cfg.temperature,
            vendor_params=vendor,
        )

        builder = _AssistantBuilder()
        streaming_executor = _StreamingToolExecutor(registry, context, cfg)
        stream_error: StreamError | None = None
        stream_aborted = False
        # terminal 도구 (기본: submit_finding, file_triage에선 triage_done)
        terminal_names: set[str] = context.metadata.get(
            "terminal_tools", {"submit_finding"},
        )  # type: ignore[assignment]
        terminal = False
        # v3.42 F2: 같은 도구+같은 에러 연속 카운터 — context 안에 carry-over
        repeat_state = RepeatErrorState.from_metadata(context.metadata)
        repeat_halt_sig: str | None = None
        # v3.48: 같은 (tool, input) 반복 호출 카운터 — 무한 stash loop 잡음
        call_counts: dict[str, int] = context.metadata.setdefault("_repeat_call_counts", {})
        repeat_call_halt: tuple[str, int] | None = None
        result_blocks_by_id: dict[str, list[ToolResultBlock]] = {}
        # F4-C: tool_use_id → 되먹일 이미지(ToolSuccess.images). tool-result 직후 user
        # 메시지로 주입한다. in-memory 턴 한정(영속 안 됨).
        images_by_id: dict[str, tuple] = {}
        stream_tool_events: list[tuple[LoopEvent, ToolResultBlock | None]] = []

        def _record_tool_event(
            ev: LoopEvent,
            block: ToolResultBlock | None,
        ) -> None:
            nonlocal repeat_call_halt, repeat_halt_sig, terminal
            if block is not None:
                result_blocks_by_id.setdefault(block.tool_use_id, []).append(block)
            if (
                isinstance(ev, ToolCallCompleted)
                and isinstance(ev.result, ToolSuccess)
                and ev.result.images
            ):
                images_by_id[ev.tool_use_id] = ev.result.images
            if isinstance(ev, ToolCallStarted):
                fp = call_fingerprint(ev.name, ev.input or {})
                if fp is not None:  # None = repeat-halt 제외 도구 (상태조회/반복호출)
                    call_counts[fp] = call_counts.get(fp, 0) + 1
                    if call_counts[fp] >= REPEAT_CALL_HALT_THRESHOLD and repeat_call_halt is None:
                        repeat_call_halt = (ev.name, call_counts[fp])
            if isinstance(ev, ToolCallCompleted):
                sig = extract_error_signature(ev.name, ev.result)
                if repeat_state.update(sig):
                    repeat_halt_sig = sig
                if ev.name in terminal_names and isinstance(ev.result, ToolSuccess):
                    terminal = True
                    # (terminal_tool_invoked 플래그는 invoker._execute 가 execute
                    # 진입 시 이미 기록 — 여기서 성공-한정으로 다시 세면 yield 후 기록
                    # 이라 consumer close 시 유실될 수 있다, codex R6.)

        streaming_executor.start_abort_monitor()
        try:
            async for ev in _stream_and_yield(
                client, request, builder, streaming_executor, context,
            ):
                if isinstance(ev, StreamError):
                    stream_error = ev
                    break
                if isinstance(ev, _StreamAborted):
                    stream_aborted = True
                    break
                if isinstance(ev, _StreamToolEvent):
                    stream_tool_events.append((ev.event, ev.block))
                    continue
                yield ev
        except BaseException:
            # 스트림 예외/취소(GeneratorExit 포함) 시 실행기의 in-flight/큐 도구를
            # 취소·폐기한다 — 안 그러면 tool 태스크가 run_query 반환 후까지 leak 실행
            # 되고(결과 폐기), 종료 도구가 반환 후 뒤늦게 dispatch 돼 플래그가 지각
            # set 되는 타이밍 갭이 생긴다(codex R4/R5). 취소하면 종료 도구는 dispatch
            # 안 돼 플래그가 None 유지 → resume 게이트가 올바르게 발동(종료 미완료).
            # abort/max_tokens 정상 분기가 이미 하는 cancel 을 예외 경로에도 대칭 적용.
            await streaming_executor.cancel(discard_results=True)
            raise
        finally:
            # 종료 도구 계약 플래그(TERMINAL_INVOKED_KEY)는 스트리밍 실행기
            # _start_locked 가 **디스패치 시점에 원자적으로** set 한다(codex R4). 여기서
            # 스냅샷을 뜨지 않는다 — stop_abort_monitor 중 지각 dispatch 레이스와
            # 취소-큐 오분류를 그 원자 기록이 이미 회피하기 때문. (post-stream 경로는
            # 아래 _record_tool_event 의 성공 시 기록이 커버.)
            await streaming_executor.stop_abort_monitor()

        if stream_aborted:
            await streaming_executor.cancel(discard_results=True)
            yield LoopCompleted(
                reason="aborted", total_turns=turn,
                final_message=final_message, usage=cumulative_usage,
            )
            return

        if stream_error is not None:
            await streaming_executor.cancel(discard_results=True)
            yield LoopError(message=f"stream {stream_error.kind}: {stream_error.message}")
            yield LoopCompleted(
                reason="stream_error", total_turns=turn,
                final_message=final_message, usage=cumulative_usage,
            )
            return

        assistant = builder.build()
        final_message = assistant
        messages.append(assistant)

        if builder.usage is not None:
            cumulative_usage = (
                builder.usage if cumulative_usage is None
                else StreamUsage(
                    input_tokens=cumulative_usage.input_tokens + builder.usage.input_tokens,
                    output_tokens=cumulative_usage.output_tokens + builder.usage.output_tokens,
                    cache_read_input_tokens=(
                        cumulative_usage.cache_read_input_tokens
                        + builder.usage.cache_read_input_tokens
                    ),
                    cache_creation_input_tokens=(
                        cumulative_usage.cache_creation_input_tokens
                        + builder.usage.cache_creation_input_tokens
                    ),
                )
            )

        # v3.62 Q5: 이 LLM 호출의 토큰/세그먼트 계측 — request 기준(assistant append 무관).
        # tokens 없는 provider 면 0. DB 기록은 consumer(ChatSession) 가.
        yield LlmCallMeasured(
            turn=turn,
            system_chars=len(system or ""),
            tools_chars=len(json.dumps(request.tools, default=str)),
            history_chars=_message_total_chars(request.messages),
            input_tokens=(builder.usage.input_tokens if builder.usage else 0),
            output_tokens=(builder.usage.output_tokens if builder.usage else 0),
            cache_read_input_tokens=(
                builder.usage.cache_read_input_tokens if builder.usage else 0
            ),
            cache_creation_input_tokens=(
                builder.usage.cache_creation_input_tokens if builder.usage else 0
            ),
        )

        stop_reason = builder.stop_reason or "end_turn"

        if stop_reason == "max_tokens":
            await streaming_executor.cancel(discard_results=True)
            assistant, assistant_text = _finalize_text_answer(assistant, context)
            final_message = assistant
            messages[-1] = assistant
            if assistant_text:
                yield TextChunk(text=assistant_text)
            yield LoopCompleted(
                reason="max_tokens", total_turns=turn,
                final_message=assistant, usage=cumulative_usage,
            )
            return

        tool_calls = [b for b in assistant.content if isinstance(b, ToolUseBlock)]
        if not tool_calls:
            assistant_text = _assistant_text(assistant)
            plan_reminder = _build_plan_contract_reminder(context)
            if plan_reminder is not None:
                count = int(context.metadata.get("plan_contract_reminder_count", 0))
                if count < cfg.max_plan_contract_reminders:
                    context.metadata["plan_contract_reminder_count"] = count + 1
                    messages.append(UserMessage(content=[TextBlock(text=plan_reminder)]))
                    continue
            finding_reminder = build_finding_followup_reminder(
                context.metadata,
                todo_available=registry.get("todo") is not None,
            )
            if finding_reminder is not None:
                count = int(context.metadata.get("finding_followup_reminder_count", 0))
                if count < cfg.max_finding_followup_reminders:
                    context.metadata["finding_followup_reminder_count"] = count + 1
                    messages.append(UserMessage(content=[TextBlock(text=finding_reminder)]))
                    continue
                yield LoopError(
                    message=(
                        "finding follow-up contract violation: finding signals "
                        "remain pending after repeated text-only responses"
                    ),
                )
                yield LoopCompleted(
                    reason="contract_violation", total_turns=turn,
                    final_message=None, usage=cumulative_usage,
                )
                return
            # candidate ledger 침묵 게이트 — 후보를 관찰(seen>0)하고도 제출 0·기각
            # 기록 0 인 채 text-only 로 끝내려는 시도를 되돌린다. finding_followup 이
            # "신호가 난 것"을 지키는 문이라면 이건 "신호조차 안 낸 침묵"을 지키는
            # 문. enforce 는 metadata opt-in(워커 cli) — chat 경로는 비발동.
            candidate_reminder = build_candidate_ledger_reminder(
                context.metadata,
                triage_available=registry.get("triage_candidates") is not None,
            )
            if candidate_reminder is not None:
                count = int(context.metadata.get("candidate_ledger_reminder_count", 0))
                if count < cfg.max_candidate_ledger_reminders:
                    context.metadata["candidate_ledger_reminder_count"] = count + 1
                    messages.append(UserMessage(content=[TextBlock(text=candidate_reminder)]))
                    continue
                yield LoopError(
                    message=(
                        "candidate ledger contract violation: observed candidates "
                        "remain unaccounted (0 submitted, 0 triaged) after "
                        "repeated text-only responses"
                    ),
                )
                yield LoopCompleted(
                    reason="contract_violation", total_turns=turn,
                    final_message=None, usage=cumulative_usage,
                )
                return
            execution_reminder = build_execution_contract_reminder(context.metadata)
            if execution_reminder is not None:
                count = int(context.metadata.get("execution_contract_reminder_count", 0))
                if count < cfg.max_execution_contract_reminders:
                    context.metadata["execution_contract_reminder_count"] = count + 1
                    messages.append(UserMessage(content=[TextBlock(text=execution_reminder)]))
                    continue
                yield LoopError(
                    message=(
                        "execution contract violation: active todo items remain "
                        "after repeated text-only responses"
                    ),
                )
                yield LoopCompleted(
                    reason="contract_violation", total_turns=turn,
                    final_message=None, usage=cumulative_usage,
                )
                return
            # 종료 도구 계약(candidate_ledger 형제) — 필수 종료 상태 도구를
            # tool_use 로 호출하지 않고 텍스트로만 서술하고 끝낸 워커를 되돌린다.
            # opt-in(워커 cli 의 require_terminal_tool), 아직 한 번도 호출되지
            # 않았고, 종료 도구가 이번 턴에 **모델에 실제 광고된**(callable) 때만.
            # deferred 도구는 unlocked 여야 광고되므로 registry 멤버십이 아니라
            # active(unlocked) 기준으로 판정한다 — 안 그러면 잠긴 종료 도구를
            # 요구해 이행 불가능한 contract_violation 이 난다(codex). candidate_ledger
            # 다음에 둔다 — 후보 정산이 먼저, 그 다음 종료.
            # 광고된(모델이 실제 호출 가능한) 종료 도구 부분집합을 한 번 계산해
            # predicate·reminder·violation 에 **동일하게** 쓴다 — 안 그러면 잠긴
            # deferred 종료 도구가 reminder/violation 에 새어 이행 불가능한 요구가
            # 된다(codex R6). deferred 는 unlocked 여야, 비-deferred 는 항상 광고.
            _advertised_terminals = sorted(
                n for n in terminal_names
                if (tc := registry.get(n)) is not None
                and (not tc.deferred or n in unlocked)
            )
            # ⚠️ 면제(TERMINAL_WAIVED_KEY)는 도메인 도구가 **큐를 직접 조회해서**
            #    "닫을 대상이 없다" 를 확인했을 때만 선다. LLM 이 쓴 문자열로는 못 선다.
            #    큐가 비면 리드는 claim 한 적 없는 대상에 상태를 찍을 수 없어서
            #    이 요구가 이행 불가능해진다(실측 2026-08-27: 리드 20건 사망,
            #    19건이 읽기 전용 list_targets 하나만 부르고 죽었다).
            if (
                context.metadata.get(REQUIRE_TERMINAL_TOOL_KEY)
                and not context.metadata.get(TERMINAL_INVOKED_KEY)
                and not context.metadata.get(TERMINAL_WAIVED_KEY)
                and _advertised_terminals
            ):
                terminal_reminder = build_terminal_tool_reminder(_advertised_terminals)
                if terminal_reminder is not None:
                    count = int(
                        context.metadata.get("terminal_tool_reminder_count", 0)
                    )
                    if count < cfg.max_terminal_tool_reminders:
                        context.metadata["terminal_tool_reminder_count"] = count + 1
                        messages.append(
                            UserMessage(content=[TextBlock(text=terminal_reminder)])
                        )
                        continue
                    yield LoopError(
                        message=(
                            "terminal tool contract violation: required terminal "
                            f"status tool ({_advertised_terminals}) was described "
                            "as text but never invoked"
                        ),
                    )
                    yield LoopCompleted(
                        reason="contract_violation", total_turns=turn,
                        final_message=None, usage=cumulative_usage,
                    )
                    return
            assistant, assistant_text = _finalize_text_answer(assistant, context)
            final_message = assistant
            messages[-1] = assistant
            if assistant_text:
                yield TextChunk(text=assistant_text)
            # 면제로 끝난 런은 end_turn 과 구분한다 — "일이 없어서 끝났다" 를
            # 따로 셀 수 있어야 조용한 no-op 이 아니다.
            _end_reason: LoopStopReason = (
                "no_work"
                if (context.metadata.get(TERMINAL_WAIVED_KEY)
                    and not context.metadata.get(TERMINAL_INVOKED_KEY))
                else "end_turn"
            )
            yield LoopCompleted(
                reason=_end_reason, total_turns=turn,
                final_message=assistant, usage=cumulative_usage,
            )
            return

        assistant_text = _assistant_text(assistant)
        if should_emit_text_before_tool_calls(assistant_text):
            yield TextChunk(text=assistant_text)

        # 도구 실행 단계 — 실행기가 아직 활성(draining)이다. 이 구간의 yield 에서
        # consumer 가 조기 close(GeneratorExit)하거나 예외가 나면 실행기의 running/
        # queued 도구가 취소되지 않고 run_query 반환 후까지 leak 실행된다
        # (drain_until_idle 은 자체 cleanup 이 없다, codex R6). 예외/취소 시 실행기를
        # 취소하고 _run_tool_calls 하위 iterator 도 aclose 해 leak(과 종료 도구의 지각
        # 실행)을 막는다 — 스트림 단계 except 와 대칭. (주의: LlmCallMeasured 등 이
        # try 밖 yield 에서의 조기 close 는 여전히 leak 가능 — 전 턴을 감싸는 executor-
        # lifetime cleanup 은 코어 루프 전반의 pre-existing 사안이라 별건으로 남긴다.)
        try:
            for ev, block in stream_tool_events:
                yield ev
                _record_tool_event(ev, block)
            stream_tool_events.clear()

            async for ev, block in streaming_executor.drain_until_idle():
                yield ev
                _record_tool_event(ev, block)

            remaining_tool_calls = [
                call for call in tool_calls if call.id not in streaming_executor.started_ids
            ]
            # aclosing: 조기 close/예외 시 _run_tool_calls 의 동시 태스크를 동기적으로
            # 닫는다(streaming_executor.cancel 은 그 iterator 태스크를 안 건드림, codex R7).
            async with contextlib.aclosing(
                _run_tool_calls(remaining_tool_calls, registry, context, cfg)
            ) as _rtc:
                async for ev, block in _rtc:
                    yield ev
                    _record_tool_event(ev, block)
        except BaseException:
            await streaming_executor.cancel(discard_results=True)
            raise
        repeat_state.write_to(context.metadata)

        result_blocks: list[ContentBlock] = []
        for call in tool_calls:
            blocks = result_blocks_by_id.get(call.id)
            if blocks:
                result_blocks.append(blocks.pop(0))
        # F4-C: tool 이 반환한 이미지를 tool-result 뒤에 user 이미지 파트로 주입(비전 되먹임).
        _append_tool_images(result_blocks, tool_calls, images_by_id)

        messages.append(UserMessage(content=result_blocks))
        # F4-C(C4): 최근 N개 이미지만 히스토리에 유지 — 반복 스크린샷의 컨텍스트 무한 누적 방지.
        _prune_history_images(messages, _tool_image_history_keep())

        if repeat_halt_sig is not None:
            halt_text = build_halt_message(repeat_halt_sig)
            yield TextChunk(text=halt_text)
            yield LoopCompleted(
                reason="repeat_error_halt", total_turns=turn,
                final_message=AssistantMessage(content=[TextBlock(text=halt_text)]),
                usage=cumulative_usage,
            )
            return

        # v3.48: 같은 (tool, input) 반복 호출 halt
        if repeat_call_halt is not None:
            tool_name, count = repeat_call_halt
            halt_text = build_repeat_call_halt_message(tool_name, count)
            yield TextChunk(text=halt_text)
            yield LoopCompleted(
                reason="repeat_call_halt", total_turns=turn,
                final_message=AssistantMessage(content=[TextBlock(text=halt_text)]),
                usage=cumulative_usage,
            )
            return

        if terminal:
            # candidate ledger 침묵 게이트 — terminal 우회 봉쇄. set_status 류가
            # terminal 인 워커(github/confluence)는 침묵한 채 set_status(done) 호출로
            # text-only 분기를 안 탄다 — 여기서도 같은 게이트를 태운다. submit 이
            # terminal 인 계약은 submit 자체가 submitted 를 기록하므로 비발동.
            # 리마인더 캡은 text-only 분기와 공유(총량 불변), 캡 도달 시 완료 허용
            # (terminal 은 이미 성공한 실제 작업 — 침묵 부채만으로 무효화하지 않고
            # 부모가 worker_result 의 candidates 지표로 degrade 판정한다).
            candidate_reminder = build_candidate_ledger_reminder(
                context.metadata,
                triage_available=registry.get("triage_candidates") is not None,
            )
            if candidate_reminder is not None:
                count = int(context.metadata.get("candidate_ledger_reminder_count", 0))
                if count < cfg.max_candidate_ledger_reminders:
                    context.metadata["candidate_ledger_reminder_count"] = count + 1
                    messages.append(UserMessage(content=[TextBlock(text=candidate_reminder)]))
                    continue
            yield LoopCompleted(
                reason="end_turn", total_turns=turn,
                final_message=assistant, usage=cumulative_usage,
            )
            return
