"""ContextSummarizer — long-conversation LLM-based 압축 (hermes-agent 패턴 port).

secu_agent v3.24-B: 기존 stub-based `compactor.compact_messages` 와 별도 layer.
stub compactor 는 휘발 도구 결과만 빠르게 마스킹 (cheap pre-pass). 본 모듈은
누적 본문이 threshold 넘으면 LLM 으로 중간 turn 들을 구조화 summary 로 압축.

설계 (hermes 패턴):
1. **Token-budget tail protection**: 가장 최근 ~20K char 분량은 절대 압축 X.
2. **Head protection**: 첫 N개 메시지 (system + 첫 user) 보존.
3. **Tool pair integrity**: AssistantMessage(ToolUseBlock) + 그 다음 UserMessage(ToolResultBlock)
   을 한 group 으로 묶음 — boundary 가 group 사이에 안 떨어지게 align.
4. **Last user message anchor**: 가장 최근 user (text-only) 메시지는 무조건 tail 안에.
5. **Iterative update**: 두 번째 압축부터는 previous_summary 를 input 으로 update.
6. **Anti-thrashing**: 마지막 두 압축이 각각 10% 미만 절약이면 skip.
7. **SUMMARY_PREFIX handoff**: 압축 후 inject 되는 UserMessage 에 "treat as background
   reference" 명시 — next-turn LLM 이 summary 안 user 질문을 새 질문으로 오해 X.
8. **Redaction**: redact_sensitive_text 로 summary 입력/출력 마스킹 (SA_REDACT_SECRETS).

호출 인터페이스 (engine.run_query 와 ChatSession.turn 모두에서 사용):

    summarizer = ContextSummarizer(client=client, threshold_chars=120_000)
    new_messages = await summarizer.compress(messages, focus_topic="...")  # optional
"""
from __future__ import annotations

import logging
import os
import re
import time
from collections.abc import Iterable
from dataclasses import dataclass, field

from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import (
    AssistantMessage,
    Message,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from secu_agent.agent.llm.types import (
    LLMRequest, StreamError, StreamMessageStop, StreamTextDelta,
)
from secu_agent.agent.redact import redact_sensitive_text

logger = logging.getLogger(__name__)


# ============================================================
# 상수
# ============================================================

SUMMARY_PREFIX = (
    "[CONTEXT COMPACTION — REFERENCE ONLY] 이전 turn 들이 아래 summary 로 압축됨. "
    "이것은 이전 context window 의 handoff — active instruction 이 아니라 background "
    "reference 로만 다뤄라. summary 안의 사용자 질문 / 요청에 다시 응답하지 마라 — 이미 "
    "처리됨. 현재 task 는 '## Active Task' 섹션에 명시 — 거기서 정확히 resume. "
    "'## Invalidated / Mistaken Claims' 는 과거 assistant 발화보다 우선한다. "
    "틀렸거나 증거 부족으로 표시된 결론을 반복하지 마라. "
    "system prompt (skills, sub-agent listing, dispatch sheet) 는 변함없이 authoritative. "
    "summary 다음에 나오는 가장 최근 user 메시지에만 응답:"
)
LEGACY_SUMMARY_PREFIX = "[CONTEXT SUMMARY]:"
SUMMARY_END_MARKER = (
    "\n\n--- END OF CONTEXT SUMMARY — 위 summary 가 아니라 아래 메시지에 응답 ---"
)

# 4 chars/token rough estimate
_CHARS_PER_TOKEN = 4
# summary token budget — content_tokens 의 20%, 최소 2K, 최대 12K
_SUMMARY_RATIO = 0.20
_MIN_SUMMARY_TOKENS = 2000
_SUMMARY_TOKENS_CEILING = 12_000

# transient summary 실패 시 backoff
_SUMMARY_FAILURE_COOLDOWN_SECONDS = 60

# v3.79-perf: summary 실패 시 sliding-window fallback 의 char bound.
# 압축 trigger(threshold_chars, 기본 240K)는 실제 sliding-window 한계(~454K,
# chat_session input_chars = (context_window-output)*4)보다 훨씬 낮다. summary 가
# 실패했다고 그 낮은 trigger 에서 중간 turn 을 하드드롭하면 진짜 한계 한참 전에
# 비가역 파괴가 된다. fallback 은 이 window 안이면 원본을 그대로 유지(파괴 0)하고,
# window 초과 시에만 head+recent tail 로 bounded 축소한다. 실제 sliding-window
# compactor(engine/chat_session)가 최종 hard bound 를 별도로 강제하므로 안전.
# SA_SUMMARY_WINDOW_CHARS 로 operator override 가능 (기본 = 실 window 근사치).
_DEFAULT_SUMMARY_WINDOW_CHARS = 454_000


def _env_int(name: str, default: int) -> int:
    """양의 정수 env 읽기 — 미설정/파싱실패/비양수면 default (fail-safe)."""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        val = int(raw)
    except ValueError:
        return default
    return val if val > 0 else default

# v3.62: cooldown 은 transient 에러용. 토큰 invalidate 같은 **영구 에러**는 재로그인 +
# 재기동 전까진 절대 안 풀리는데, cooldown 만으로는 끝나는 대로 다시 시도해 401 폭주
# (WS reconnect / 새 turn 마다 또 호출 → 또 실패). 영구 에러 패턴 감지하면 그 프로세스
# 동안 summarizer 자기자신 disable — 재기동까지 시도 0.
_PERMANENT_AUTH_ERROR_PATTERNS = (
    "token_invalidated",
    "invalidated",
    "please try signing",
    "401",
    "unauthorized",
    "invalid_api_key",
    "incorrect api key",
    "no api key",
)


def _is_permanent_auth_error(text: str) -> bool:
    if not text:
        return False
    low = text.lower()
    return any(p in low for p in _PERMANENT_AUTH_ERROR_PATTERNS)

# pruned tool placeholder
_PRUNED_TOOL_PLACEHOLDER = "[Old tool output cleared to save context space]"


# ============================================================
# Helpers — token / 본문 측정
# ============================================================

def _block_text_length(block) -> int:
    """block 단일 길이 (char). ToolUseBlock 는 input JSON 직렬화."""
    if isinstance(block, TextBlock):
        return len(block.text)
    if isinstance(block, ToolResultBlock):
        return len(block.content) + 20  # tool_use_id metadata
    if isinstance(block, ToolUseBlock):
        # input dict 추정 — repr 길이로 대략
        return len(block.name) + len(repr(block.input)) + 20
    return 0


def _message_content_length(msg: Message) -> int:
    if isinstance(msg, SystemMessage):
        return len(msg.text)
    return sum(_block_text_length(b) for b in msg.content) + 10  # role overhead


def estimate_tokens(messages: Iterable[Message]) -> int:
    """char/4 기반 rough token 추정."""
    total = 0
    for m in messages:
        total += _message_content_length(m) // _CHARS_PER_TOKEN
    return total


def total_chars(messages: Iterable[Message]) -> int:
    return sum(_message_content_length(m) for m in messages)


# ============================================================
# Tool pair helpers
# ============================================================

def _tool_use_ids_in_assistant(msg: AssistantMessage) -> list[str]:
    return [b.id for b in msg.content if isinstance(b, ToolUseBlock)]


def _tool_result_ids_in_user(msg: UserMessage) -> list[str]:
    return [b.tool_use_id for b in msg.content if isinstance(b, ToolResultBlock)]


def _is_tool_result_carrier(msg: Message) -> bool:
    """UserMessage 안에 ToolResultBlock 이 하나라도 있으면 True."""
    if not isinstance(msg, UserMessage):
        return False
    return any(isinstance(b, ToolResultBlock) for b in msg.content)


def _user_text(msg: UserMessage) -> str:
    return "".join(b.text for b in msg.content if isinstance(b, TextBlock))


def _is_text_only_user(msg: Message) -> bool:
    """ToolResultBlock 없는 순수 text-only user 메시지."""
    if not isinstance(msg, UserMessage):
        return False
    return not any(isinstance(b, ToolResultBlock) for b in msg.content) and any(
        isinstance(b, TextBlock) and b.text.strip() for b in msg.content
    )


# ============================================================
# Summarizer 자체
# ============================================================

@dataclass
class CompressionStats:
    """compress() 호출 결과 통계."""
    triggered: bool = False
    head_count: int = 0
    middle_count: int = 0
    tail_count: int = 0
    summary_chars: int = 0
    saved_chars: int = 0
    savings_pct: float = 0.0
    summary_error: str | None = None
    fallback_used: bool = False
    dropped_count: int = 0


@dataclass
class ContextSummarizer:
    """LLM-based 대화 압축. ChatSession / engine 에서 사용."""

    client: LLMClient
    # 압축 trigger threshold (총 char 수). 이 이상이면 compress() 가 작동.
    threshold_chars: int = 120_000
    # 보호 — 첫 N 메시지 (system inline 으로 안 들어가는 케이스 대비).
    protect_first_n: int = 2
    # tail 보호 budget (char). 가장 최근 메시지들을 이 양 이하로 보존.
    tail_char_budget: int = 60_000
    # summary model — None 이면 main client 사용
    summary_model: str | None = None

    # 내부 상태
    _previous_summary: str | None = field(default=None, init=False)
    _summary_failure_cooldown_until: float = field(default=0.0, init=False)
    # v3.62: 영구 인증 에러 감지 시 set — 그 후로 LLM 호출 자체 안 함 (재기동까지).
    _disabled_reason: str | None = field(default=None, init=False)
    _ineffective_compression_count: int = field(default=0, init=False)
    _last_compression_savings_pct: float = field(default=100.0, init=False)
    compression_count: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        # v3.79-perf: trigger threshold 를 token 단위 env 로도 override 가능하게.
        # 미설정이면 생성자에서 넘어온 threshold_chars 를 그대로 존중(호출자
        # chat_session 이 SA_SUMMARIZER_THRESHOLD_CHARS 로 이미 세팅). 설정 시
        # 이쪽이 우선. char = tokens * _CHARS_PER_TOKEN.
        trig_tokens = _env_int("SA_SUMMARY_TRIGGER_TOKENS", 0)
        if trig_tokens > 0:
            self.threshold_chars = trig_tokens * _CHARS_PER_TOKEN

    # ------------------------------------------------------------------
    # Public — should_compress / compress
    # ------------------------------------------------------------------

    def should_compress(self, messages: list[Message]) -> bool:
        """현재 messages 가 압축 대상인지."""
        if total_chars(messages) < self.threshold_chars:
            return False
        if self._ineffective_compression_count >= 2:
            logger.warning(
                "compression skipped — 마지막 %d 회 압축이 10%% 미만 절약. "
                "/new 권장.", self._ineffective_compression_count,
            )
            return False
        return True

    def reset_session_state(self) -> None:
        """/new 시 호출. previous_summary / 카운터 초기화."""
        self._previous_summary = None
        self._summary_failure_cooldown_until = 0.0
        self._disabled_reason = None  # v3.62: 명시적 reset 은 영구 disable 도 풀어줌
        self._ineffective_compression_count = 0
        self._last_compression_savings_pct = 100.0
        self.compression_count = 0

    async def compress(
        self, messages: list[Message], *, focus_topic: str | None = None,
        force: bool = False,
    ) -> tuple[list[Message], CompressionStats]:
        """messages 압축. (new_messages, stats) 반환.

        force=True 면 threshold 무시하고 강제 압축 (수동 /compact 용).
        focus_topic 지정 시 summary 가 해당 토픽 정보 우선 보존.

        압축 실패 시 stats.summary_error 에 사유 set, 원본 messages 그대로 반환.
        """
        stats = CompressionStats()
        n = len(messages)
        if n < self.protect_first_n + 3:
            return messages, stats

        if not force and not self.should_compress(messages):
            return messages, stats

        # boundary 결정
        compress_start = self._align_boundary_forward(messages, self.protect_first_n)
        compress_end = self._find_tail_cut(messages, head_end=compress_start)
        if compress_start >= compress_end:
            return messages, stats

        middle = messages[compress_start:compress_end]
        if not middle:
            return messages, stats

        original_chars = total_chars(messages)

        # summary 생성
        summary_body = await self._generate_summary(
            middle, focus_topic=focus_topic,
        )
        if summary_body is None:
            # v3.79-perf: summary 실패 시 중간 turn 을 비가역 하드드롭하지 않는다.
            # 예전엔 fake "제거됨" placeholder 로 middle 을 통째 버렸는데, 이는 trigger
            # (240K) 가 실제 sliding-window 한계(~454K)보다 훨씬 낮은 지점에서 과도하게
            # 파괴하는 것. recoverable sliding-window fallback 으로 전환 — window 안이면
            # 원본 유지(파괴 0), 초과 시에만 bounded 축소.
            return self._sliding_window_fallback(messages, stats, original_chars)

        stats.summary_chars = len(summary_body)
        summary_text = self._with_summary_prefix(summary_body)
        self._previous_summary = summary_body

        # 압축된 메시지 list 조립
        compressed = list(messages[:compress_start])
        summary_msg_text = summary_text + SUMMARY_END_MARKER
        compressed.append(UserMessage(content=[TextBlock(text=summary_msg_text)]))
        compressed.extend(messages[compress_end:])

        # tool pair sanitization — orphan 제거 / stub 추가
        compressed = self._sanitize_tool_pairs(compressed)

        # stats
        stats.triggered = True
        stats.head_count = compress_start
        stats.middle_count = len(middle)
        stats.tail_count = n - compress_end
        new_chars = total_chars(compressed)
        stats.saved_chars = original_chars - new_chars
        stats.savings_pct = (
            (stats.saved_chars / original_chars * 100) if original_chars else 0.0
        )

        # anti-thrashing 카운터
        self._last_compression_savings_pct = stats.savings_pct
        if stats.savings_pct < 10:
            self._ineffective_compression_count += 1
        else:
            self._ineffective_compression_count = 0

        self.compression_count += 1
        logger.info(
            "compressed: %d → %d msgs, %d→%d chars (%.0f%% saved)",
            n, len(compressed), original_chars, new_chars, stats.savings_pct,
        )
        return compressed, stats

    def _sliding_window_fallback(
        self, messages: list[Message], stats: CompressionStats,
        original_chars: int,
    ) -> tuple[list[Message], CompressionStats]:
        """summary 생성 실패 시 recoverable fallback.

        summary 없이 중간 turn 을 fake placeholder 로 하드드롭하던 예전 동작을 대체.
        - 원본이 sliding-window bound(_DEFAULT_SUMMARY_WINDOW_CHARS, SA_SUMMARY_WINDOW_CHARS)
          안이면: **파괴 0** — 원본 그대로 반환. cooldown 후 재시도하거나, 실제
          한계에서 engine/chat_session 의 sliding_window compactor 가 bound 한다.
        - window 초과 시에만: head(protect_first_n) + recent tail 만 bounded 유지하고
          중간을 drop. 이는 진짜 한계에서의 sliding-window retention 이지 낮은 trigger
          지점의 과도 압축이 아니다. hard context limit 은 절대 안 넘긴다.
        """
        stats.summary_error = "summary generation failed"
        stats.fallback_used = True

        window_budget = _env_int(
            "SA_SUMMARY_WINDOW_CHARS", _DEFAULT_SUMMARY_WINDOW_CHARS,
        )
        # trigger 보다 낮은 window 는 무의미 — 최소 trigger 이상 보장(정합성).
        window_budget = max(window_budget, self.threshold_chars)

        if original_chars <= window_budget:
            # 파괴 없음 — summary 없이 중간 하드드롭 금지. 원본 유지.
            stats.dropped_count = 0
            logger.warning(
                "summary 실패 — sliding-window fallback: 원본 %d chars ≤ window %d, "
                "파괴 없이 유지 (cooldown 후 재시도).",
                original_chars, window_budget,
            )
            return messages, stats

        # window 초과 — head + recent tail 로 bounded 축소.
        n = len(messages)
        head_end = self._align_boundary_forward(messages, self.protect_first_n)
        head = messages[:head_end]
        head_chars = total_chars(head)
        avail = max(0, window_budget - head_chars)

        tail_start = n
        acc = 0
        for i in range(n - 1, head_end - 1, -1):
            c = _message_content_length(messages[i])
            # 최소 1개 tail 은 보장하면서 budget walk.
            if acc + c > avail and (n - i) > 1:
                break
            acc += c
            tail_start = i

        # tool pair 경계 split 회피.
        tail_start = self._align_boundary_backward(messages, tail_start)
        if tail_start < head_end:
            tail_start = head_end

        result = list(head) + list(messages[tail_start:])
        # orphan/missing tool_result 정리 (gateway 400 가드).
        result = self._sanitize_tool_pairs(result)

        new_chars = total_chars(result)
        stats.triggered = True
        stats.head_count = head_end
        stats.tail_count = n - tail_start
        stats.dropped_count = max(0, tail_start - head_end)
        stats.saved_chars = original_chars - new_chars
        stats.savings_pct = (
            (stats.saved_chars / original_chars * 100) if original_chars else 0.0
        )
        logger.warning(
            "summary 실패 — sliding-window fallback: %d→%d msgs, %d→%d chars, "
            "중간 %d개 drop (window %d 초과분만).",
            n, len(result), original_chars, new_chars,
            stats.dropped_count, window_budget,
        )
        return result, stats

    # ------------------------------------------------------------------
    # Boundary alignment
    # ------------------------------------------------------------------

    def _align_boundary_forward(
        self, messages: list[Message], idx: int,
    ) -> int:
        """compress_start 가 tool_result 위에 떨어지면 forward 로 밀어줌.

        AssistantMessage(tool_use) 와 다음 UserMessage(tool_result) 한 group.
        head 끝이 group 가운데면 다음 group 시작으로 미루기.
        """
        while idx < len(messages):
            m = messages[idx]
            # UserMessage 가 tool_result 만 갖고 있으면 직전 assistant 와 한 group
            if _is_tool_result_carrier(m):
                # text part 도 있으면 진짜 새 user turn 일 수도 — 그래도 일단 묶음.
                idx += 1
                continue
            break
        return idx

    def _align_boundary_backward(
        self, messages: list[Message], idx: int,
    ) -> int:
        """compress_end 가 tool_result 그룹 중간이면 직전 assistant 앞으로 후퇴."""
        if idx <= 0 or idx >= len(messages):
            return idx
        check = idx - 1
        # 연속 tool_result 캐리어 user 메시지들 walk back
        while check >= 0 and _is_tool_result_carrier(messages[check]):
            check -= 1
        # parent assistant 발견? 그 앞까지
        if check >= 0 and isinstance(messages[check], AssistantMessage):
            if _tool_use_ids_in_assistant(messages[check]):
                idx = check
        return idx

    def _find_last_text_user_idx(
        self, messages: list[Message], head_end: int,
    ) -> int:
        """가장 최근 text-only user 메시지 index. -1 if none."""
        for i in range(len(messages) - 1, head_end - 1, -1):
            if _is_text_only_user(messages[i]):
                return i
        return -1

    def _find_tail_cut(
        self, messages: list[Message], *, head_end: int,
    ) -> int:
        """tail 영역 시작 index. 아래 budget walk 후 align + last-user anchor."""
        n = len(messages)
        min_tail = min(3, n - head_end - 1) if n - head_end > 1 else 0
        soft_ceiling = int(self.tail_char_budget * 1.5)
        accumulated = 0
        cut_idx = n

        for i in range(n - 1, head_end - 1, -1):
            msg_chars = _message_content_length(messages[i])
            if accumulated + msg_chars > soft_ceiling and (n - i) >= min_tail:
                break
            accumulated += msg_chars
            cut_idx = i

        fallback_cut = n - min_tail
        if cut_idx > fallback_cut:
            cut_idx = fallback_cut
        if cut_idx <= head_end:
            cut_idx = max(fallback_cut, head_end + 1)

        # tool group split 회피
        cut_idx = self._align_boundary_backward(messages, cut_idx)

        # 마지막 text-user 는 무조건 tail
        last_user_idx = self._find_last_text_user_idx(messages, head_end)
        if last_user_idx >= 0 and last_user_idx < cut_idx:
            cut_idx = max(last_user_idx, head_end + 1)

        return max(cut_idx, head_end + 1)

    # ------------------------------------------------------------------
    # Summarizer LLM 호출
    # ------------------------------------------------------------------

    def _serialize_for_summary(self, turns: list[Message]) -> str:
        """summary LLM 에 전달할 텍스트로 직렬화. redact 적용."""
        parts: list[str] = []
        for msg in turns:
            if isinstance(msg, UserMessage):
                text_bits: list[str] = []
                tool_results: list[tuple[str, str]] = []
                for b in msg.content:
                    if isinstance(b, TextBlock):
                        text_bits.append(b.text)
                    elif isinstance(b, ToolResultBlock):
                        tool_results.append((b.tool_use_id, b.content))
                if text_bits:
                    txt = redact_sensitive_text("\n".join(text_bits))
                    if len(txt) > 6000:
                        txt = txt[:4000] + "\n...[truncated]...\n" + txt[-1500:]
                    parts.append(f"[USER]: {txt}")
                for tu_id, content in tool_results:
                    rc = redact_sensitive_text(content)
                    if len(rc) > 6000:
                        rc = rc[:4000] + "\n...[truncated]...\n" + rc[-1500:]
                    parts.append(f"[TOOL RESULT {tu_id[:12]}]: {rc}")
            elif isinstance(msg, AssistantMessage):
                text_bits = []
                tool_calls: list[tuple[str, str, str]] = []
                for b in msg.content:
                    if isinstance(b, TextBlock):
                        text_bits.append(b.text)
                    elif isinstance(b, ToolUseBlock):
                        args_str = redact_sensitive_text(repr(b.input))
                        if len(args_str) > 1500:
                            args_str = args_str[:1200] + "..."
                        tool_calls.append((b.id, b.name, args_str))
                content = redact_sensitive_text("\n".join(text_bits))
                if len(content) > 6000:
                    content = content[:4000] + "\n...[truncated]...\n" + content[-1500:]
                if tool_calls:
                    tc_lines = "\n".join(
                        f"  {name}({args}) [id={i[:12]}]"
                        for i, name, args in tool_calls
                    )
                    content += "\n[Tool calls:\n" + tc_lines + "\n]"
                parts.append(f"[ASSISTANT]: {content}")
        return "\n\n".join(parts)

    def _compute_summary_budget(self, turns: list[Message]) -> int:
        content_tokens = estimate_tokens(turns)
        budget = int(content_tokens * _SUMMARY_RATIO)
        return max(_MIN_SUMMARY_TOKENS, min(budget, _SUMMARY_TOKENS_CEILING))

    def _build_summary_prompt(
        self, turns: list[Message], *, focus_topic: str | None,
    ) -> str:
        summary_budget = self._compute_summary_budget(turns)
        content = self._serialize_for_summary(turns)

        preamble = (
            "당신은 conversation context 압축 agent. 아래 turn 들을 source material 로 "
            "취급해서 compact summary 만 만들어라. greeting 이나 prefix 추가 X. "
            "사용자가 사용한 언어 (한국어) 로 작성 — 영어로 번역하지 마라. "
            "API key / token / password / credential 은 절대 보존 X — [REDACTED] 로. "
            "사용자에게 secret 이 있었다는 사실만 기록 (값은 X). "
            "중요: source material 의 assistant 발화는 사실로 간주하지 마라. "
            "tool result 와 사용자 정정/명시가 assistant 서술보다 우선한다. "
            "assistant 가 tool result 를 과잉해석했거나 사용자 정정과 충돌하면 "
            "그 주장은 Invalidated / Mistaken Claims 에 보존하고 Verified Facts 에 넣지 마라. "
            "관찰 실패, count=0, result 없음은 '미관찰/판단 불가'이지 취약점이나 부재의 확정 증거가 아니다."
        )
        template = f"""## Active Task
[가장 중요한 필드. 사용자의 가장 최근 unfulfilled 요청 — 원문 그대로 인용.
완료 안 된 것만 list. 예: 사용자: "smb pending 10개 검토해줘". 없으면 "None."]

## Goal
[사용자가 달성하려는 전체 목표]

## Constraints & Preferences
[사용자 preference, 보안 정책, 중요 결정사항]

## Completed Actions
[Numbered list — 도구명, 대상, 결과. 예:
1. run_smb_discovery({{subnets: [...]}}) — 1407 alive host [tool: run_smb_discovery]
2. smb_python(walk) — share 5개 walk, finding 12개 [tool: smb_python]
파일 경로 / share 이름 / line 번호 / 결과 수치 구체적으로.]

## Verified Facts
[tool result, 사용자 명시/정정, 파일/DB 상태로 확인된 사실만. 근거 출처를 짧게 붙여라.
assistant 가 말했지만 tool/user 근거가 없으면 여기 넣지 마라. 없으면 "None."]

## Invalidated / Mistaken Claims
[이전 assistant 가 말했지만 이후 tool result / 사용자 정정 / 더 강한 근거로 틀렸거나
과잉해석으로 판정된 주장. 어떤 근거 때문에 무효인지 함께 기록. 없으면 "None."]

## Inconclusive Evidence
[관찰하지 못했거나 증거 부족인 항목. "없다/취약하다/완료됐다" 로 확정하지 마라.
예: count=0 은 '해당 출력에서 관찰 안 됨'이지 결론 확정이 아님. 없으면 "None."]

## Current Situation
[Verified Facts + Invalidated / Mistaken Claims + Inconclusive Evidence 를 반영한 현재
상황. 향후 판단은 이 섹션을 기준으로 재개.]

## Active State
[현재 작업 상태. 작업 중인 share / file, DB 상태, lockout flag 등.]

## In Progress
[압축 시점에 진행 중이던 작업]

## Blocked
[blocker / 에러 / 미해결 이슈. exact error message 포함.]

## Key Decisions
[중요 기술 결정 + 이유]

## Resolved Questions
[이미 답변된 사용자 질문 — 답까지 박아라 (반복 X).]

## Pending User Asks
[아직 답변 안 된 요청. 없으면 "None."]

## Do Not Repeat
[상투적인 후속 요청 유도 문구, 이미 틀린 것으로 판정된 결론, 이미 답변된 질문 중
다음 turn 에 반복하면 안 되는 것. 없으면 "None."]

## Relevant Files / Shares
[읽거나 walk 한 파일 / share 목록 + 짧은 설명]

## Remaining Work
[남은 작업 — context 로만 기술, instruction 으로 X]

## Critical Context
[보존 없으면 잃을 specific 값 / 에러 메시지 / 설정 / 데이터. API key / token /
password 는 절대 X — [REDACTED] 로.]

Target ~{summary_budget} tokens. CONCRETE — 파일 경로 / 명령 출력 / 에러 메시지 /
line 번호 / 수치 박아라. "변경했음" 같은 모호한 서술 X — 정확히 뭐가 어떻게 바뀌었는지.

summary 본문만. preamble / prefix X."""

        if self._previous_summary:
            prompt = (
                f"{preamble}\n\n"
                "이전 압축 summary 가 있다. 새 turn 들을 incorporate 해서 update.\n\n"
                f"PREVIOUS SUMMARY:\n{self._previous_summary}\n\n"
                f"NEW TURNS:\n{content}\n\n"
                "동일 구조 유지. 기존 정보 PRESERVE (still relevant 한 것). "
                "Completed Actions 에 신규 번호 이어붙임. In Progress → Completed 로 이동. "
                "답변된 질문 → Resolved 로 이동. Active State 갱신. "
                "Verified Facts / Invalidated / Inconclusive / Current Situation 을 "
                "새 evidence 기준으로 갱신. 틀린 과거 결론은 삭제하지 말고 Invalidated 로 이동. "
                "Active Task 는 가장 최근 unfulfilled 요청으로 갱신 (가장 중요).\n\n"
                + template
            )
        else:
            prompt = (
                f"{preamble}\n\n"
                "아래 conversation turn 들의 checkpoint summary 작성. 이후 turn 에서 "
                "이 summary 만 봐도 continuity 가 유지될 만큼 detail 보존.\n\n"
                f"TURNS:\n{content}\n\n"
                "다음 구조 사용:\n\n"
                + template
            )
        if focus_topic:
            prompt += (
                f"\n\nFOCUS TOPIC: \"{focus_topic}\"\n"
                "사용자가 이 focus topic 관련 정보 우선 보존 요청. 관련 내용은 full detail "
                "(exact value / path / output / error). 무관 내용은 한 줄로 압축 또는 생략. "
                "focus topic 섹션이 budget 의 60~70% 차지하도록. credential 은 그래도 [REDACTED]."
            )
        return prompt

    async def _generate_summary(
        self, turns: list[Message], *, focus_topic: str | None,
    ) -> str | None:
        """LLM 호출해서 summary 텍스트 반환. 실패 시 None."""
        # v3.62: 영구 인증 에러를 한 번이라도 만났으면 LLM 호출 자체 skip — 재기동/reset
        # 전까진 어차피 또 401. 폭주 차단.
        if self._disabled_reason is not None:
            return None
        now = time.monotonic()
        if now < self._summary_failure_cooldown_until:
            return None

        prompt = self._build_summary_prompt(turns, focus_topic=focus_topic)
        budget = self._compute_summary_budget(turns)
        request = LLMRequest(
            messages=[UserMessage(content=[TextBlock(text=prompt)])],
            system=(
                "context compaction agent. structured summary 만 작성, prefix X."
            ),
            tools=None,
            max_tokens=int(budget * 1.3),
            temperature=0.0,
        )
        try:
            text_parts: list[str] = []
            stop_reason: str | None = None
            error_text: str | None = None
            async for ev in self.client.stream(request):
                if isinstance(ev, StreamTextDelta):
                    text_parts.append(ev.text)
                elif isinstance(ev, StreamMessageStop):
                    stop_reason = ev.stop_reason
                elif isinstance(ev, StreamError):
                    error_text = ev.message
                    break
            if error_text:
                if _is_permanent_auth_error(error_text):
                    self._disabled_reason = error_text
                    logger.error(
                        "summary LLM permanent auth error — summarizer DISABLED for "
                        "this process. 재로그인 + 재기동 필요. err=%s", error_text,
                    )
                else:
                    self._summary_failure_cooldown_until = (
                        now + _SUMMARY_FAILURE_COOLDOWN_SECONDS
                    )
                    logger.warning("summary LLM error: %s", error_text)
                return None
            summary = "".join(text_parts).strip()
            if not summary:
                self._summary_failure_cooldown_until = (
                    now + _SUMMARY_FAILURE_COOLDOWN_SECONDS
                )
                logger.warning("summary empty (stop=%s)", stop_reason)
                return None
            return redact_sensitive_text(summary)
        except Exception as e:
            msg = str(e)
            if _is_permanent_auth_error(msg):
                self._disabled_reason = msg
                logger.error(
                    "summary LLM permanent auth exception — summarizer DISABLED for "
                    "this process. err=%s", msg,
                )
            else:
                self._summary_failure_cooldown_until = (
                    now + _SUMMARY_FAILURE_COOLDOWN_SECONDS
                )
                logger.warning("summary generation exception: %s", e)
            return None

    # ------------------------------------------------------------------
    # SUMMARY_PREFIX 도우미
    # ------------------------------------------------------------------

    @staticmethod
    def _strip_summary_prefix(text: str) -> str:
        body = (text or "").strip()
        for p in (SUMMARY_PREFIX, LEGACY_SUMMARY_PREFIX):
            if body.startswith(p):
                return body[len(p):].lstrip()
        return body

    @classmethod
    def _with_summary_prefix(cls, body: str) -> str:
        body = cls._strip_summary_prefix(body)
        return f"{SUMMARY_PREFIX}\n{body}" if body else SUMMARY_PREFIX

    @staticmethod
    def is_summary_message(msg: Message) -> bool:
        if not isinstance(msg, UserMessage):
            return False
        text = _user_text(msg).lstrip()
        return text.startswith(SUMMARY_PREFIX) or text.startswith(LEGACY_SUMMARY_PREFIX)

    # ------------------------------------------------------------------
    # Tool pair sanitization
    # ------------------------------------------------------------------

    def _sanitize_tool_pairs(self, messages: list[Message]) -> list[Message]:
        """orphan tool_result 제거 + 누락 tool_result stub 추가.

        압축으로 AssistantMessage(tool_use) 가 사라지면 그 다음 UserMessage 의
        ToolResultBlock 들은 매칭 안 됨 → LLM API reject 위험. 양방향 정리.
        """
        # 1) 살아남은 tool_use id 집합
        live_tool_use_ids: set[str] = set()
        for m in messages:
            if isinstance(m, AssistantMessage):
                live_tool_use_ids.update(_tool_use_ids_in_assistant(m))

        # 2) 등장한 tool_result id 집합
        seen_result_ids: set[str] = set()
        for m in messages:
            if isinstance(m, UserMessage):
                seen_result_ids.update(_tool_result_ids_in_user(m))

        # 3) orphan tool_result 제거 — UserMessage 안에서만 걸러서 새로 재조립
        orphans = seen_result_ids - live_tool_use_ids
        missing = live_tool_use_ids - seen_result_ids

        new_messages: list[Message] = []
        for m in messages:
            if isinstance(m, UserMessage) and orphans:
                kept_blocks = [
                    b for b in m.content
                    if not (isinstance(b, ToolResultBlock) and b.tool_use_id in orphans)
                ]
                if kept_blocks:
                    new_messages.append(UserMessage(
                        content=kept_blocks, id=m.id, created_at=m.created_at,
                    ))
                # 본문 비면 메시지 자체 drop (placeholder text 도 없는 경우)
            else:
                new_messages.append(m)

        # 4) 누락 stub 추가 — assistant(tool_use) 다음에 tool_result 가 없으면 박는다
        if missing:
            patched: list[Message] = []
            for idx, m in enumerate(new_messages):
                patched.append(m)
                if isinstance(m, AssistantMessage):
                    use_ids = _tool_use_ids_in_assistant(m)
                    need_stubs = [uid for uid in use_ids if uid in missing]
                    if not need_stubs:
                        continue
                    # 다음 메시지가 UserMessage 이고 그 안에 tool_result 가 이미 있다면 거기에 append
                    next_m = new_messages[idx + 1] if idx + 1 < len(new_messages) else None
                    if (isinstance(next_m, UserMessage)
                            and any(isinstance(b, ToolResultBlock) for b in next_m.content)):
                        # 다음 user 에 stub 추가 — patched 에서 마지막 추가한 게 m, 다음 iteration 에서 next_m
                        # 처리되는 시점에 inject 하려면 lookahead 가 필요. 간단히: 다음 user 를
                        # 미리 변환해두자.
                        # 이 분기 발생하면 missing 일관성 깨질 수 있음 — 다음 user 에 일괄 stub append.
                        # 본 loop 의 다음 회차에서 처리되도록 missing flag 만 남김.
                        pass
                    else:
                        # 별도 UserMessage 로 stub 박음
                        stub_blocks = [
                            ToolResultBlock(
                                tool_use_id=uid,
                                content="[Tool result removed by compaction — "
                                "see context summary above]",
                            ) for uid in need_stubs
                        ]
                        patched.append(UserMessage(content=stub_blocks))
                        # already added — missing 에서 제거 (다음 iter 에서 중복 X)
                        missing -= set(need_stubs)
            new_messages = patched

        return new_messages


# ============================================================
# Detector — 메시지에 SUMMARY_PREFIX 있는지
# ============================================================

def sanitize_tool_pairs(messages: list[Message]) -> list[Message]:
    """orphan tool_result 제거 + 누락 tool_result stub 추가 (gateway 400 가드).

    P1 Slice1: 모듈 레벨로 노출 — summarizer 뿐 아니라 compactor.sliding_window 도
    공유. 압축/슬라이딩으로 AssistantMessage(tool_use) 의 매칭 ToolResultBlock 이
    드롭되면 orphan/missing 이 생겨 OpenAI 호환 게이트웨이가 400 을 던진다.
    - orphan tool_result(매칭 tool_use 없음): 제거
    - missing tool_result(tool_use 만 살아남음): 해당 assistant 직후 stub UserMessage 삽입
    """
    live_use_ids: set[str] = set()
    for m in messages:
        if isinstance(m, AssistantMessage):
            live_use_ids.update(_tool_use_ids_in_assistant(m))
    seen_result_ids: set[str] = set()
    for m in messages:
        if isinstance(m, UserMessage):
            seen_result_ids.update(_tool_result_ids_in_user(m))
    orphans = seen_result_ids - live_use_ids
    missing = live_use_ids - seen_result_ids

    stripped: list[Message] = []
    for m in messages:
        if isinstance(m, UserMessage) and orphans:
            kept = [
                b for b in m.content
                if not (isinstance(b, ToolResultBlock) and b.tool_use_id in orphans)
            ]
            if kept:
                stripped.append(UserMessage(content=kept, id=m.id, created_at=m.created_at))
            # kept 가 비면 메시지 자체 drop
        else:
            stripped.append(m)

    if not missing:
        return stripped

    patched: list[Message] = []
    still = set(missing)
    for m in stripped:
        patched.append(m)
        if isinstance(m, AssistantMessage):
            need = [uid for uid in _tool_use_ids_in_assistant(m) if uid in still]
            if need:
                patched.append(UserMessage(content=[
                    ToolResultBlock(
                        tool_use_id=uid,
                        content="[Tool result removed by compaction — see context note.]",
                    )
                    for uid in need
                ]))
                still -= set(need)
    return patched


def has_prior_summary(messages: list[Message]) -> bool:
    return any(ContextSummarizer.is_summary_message(m) for m in messages)


__all__ = [
    "ContextSummarizer",
    "CompressionStats",
    "SUMMARY_PREFIX",
    "SUMMARY_END_MARKER",
    "estimate_tokens",
    "total_chars",
    "has_prior_summary",
]
