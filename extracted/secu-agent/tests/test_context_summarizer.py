"""ContextSummarizer — LLM-based 대화 압축 (v3.24-B).

핵심 검증:
- 기본 trigger: threshold 미만 → no-op, 이상 → compress
- head/tail 보호
- tool pair sanitization (orphan / missing)
- SUMMARY_PREFIX handoff prefix
- iterative update (previous_summary 활용)
- anti-thrashing
- focus_topic 전달
- redact 적용
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass

import pytest

from secu_agent.agent.context_summarizer import (
    SUMMARY_END_MARKER,
    SUMMARY_PREFIX,
    CompressionStats,
    ContextSummarizer,
    estimate_tokens,
    has_prior_summary,
    total_chars,
)
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import (
    AssistantMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage,
)
from secu_agent.agent.llm.types import (
    LLMRequest, StreamError, StreamMessageStop, StreamTextDelta,
)


# ============================================================
# 테스트용 LLM mock
# ============================================================

@dataclass
class _ScriptedSummaryClient(LLMClient):
    """summary 호출에 정해진 텍스트 반환. error 모드도 지원."""
    summary_text: str = "## Active Task\n사용자: 'pending 5개 검토'\n\n## Completed Actions\n1. walk share 5개\n\n## Active State\nshare 5개 walked"
    error_msg: str | None = None
    calls: list[LLMRequest] = None

    def __post_init__(self):
        if self.calls is None:
            self.calls = []

    @property
    def name(self) -> str:
        return "scripted-summary"

    async def stream(self, request: LLMRequest) -> AsyncIterator:
        self.calls.append(request)
        if self.error_msg:
            yield StreamError(message=self.error_msg, kind="api")
            return
        yield StreamTextDelta(text=self.summary_text)
        yield StreamMessageStop(stop_reason="end_turn")


def _user_text(text: str) -> UserMessage:
    return UserMessage(content=[TextBlock(text=text)])


def _asst_text(text: str) -> AssistantMessage:
    return AssistantMessage(content=[TextBlock(text=text)])


def _asst_tool(tool_use_id: str, name: str = "smb_python", input_: dict | None = None) -> AssistantMessage:
    return AssistantMessage(content=[ToolUseBlock(
        id=tool_use_id, name=name, input=input_ or {"code": "..."},
    )])


def _user_tool_result(tool_use_id: str, content: str) -> UserMessage:
    return UserMessage(content=[ToolResultBlock(tool_use_id=tool_use_id, content=content)])


def _run(coro):
    return asyncio.run(coro)


# ============================================================
# Helpers
# ============================================================

def test_estimate_tokens_rough():
    msgs = [_user_text("hello world " * 100)]
    # 12 chars * 100 = 1200 chars, ~300 tokens
    t = estimate_tokens(msgs)
    assert 250 <= t <= 400


def test_total_chars_counts_blocks():
    msgs = [
        _user_text("abc"),
        _asst_text("defgh"),
    ]
    # 두 메시지 모두 role overhead +10 이므로 대략
    assert total_chars(msgs) >= 8


def test_has_prior_summary_detects_prefix():
    msgs = [
        _user_text("first"),
        _user_text(SUMMARY_PREFIX + "\nbody"),
        _user_text("after"),
    ]
    assert has_prior_summary(msgs)


# ============================================================
# should_compress / 트리거 게이트
# ============================================================

def test_should_compress_false_under_threshold():
    summ = ContextSummarizer(client=_ScriptedSummaryClient(), threshold_chars=100_000)
    msgs = [_user_text("x" * 100)]
    assert not summ.should_compress(msgs)


def test_should_compress_true_over_threshold():
    summ = ContextSummarizer(client=_ScriptedSummaryClient(), threshold_chars=1000)
    msgs = [_user_text("x" * 1500), _asst_text("y" * 500)]
    assert summ.should_compress(msgs)


def test_should_compress_anti_thrashing():
    summ = ContextSummarizer(client=_ScriptedSummaryClient(), threshold_chars=100)
    summ._ineffective_compression_count = 2
    msgs = [_user_text("x" * 1000)]
    assert not summ.should_compress(msgs)


# ============================================================
# compress() — no-op 시나리오
# ============================================================

def test_compress_noop_under_threshold():
    summ = ContextSummarizer(client=_ScriptedSummaryClient(), threshold_chars=1_000_000)
    msgs = [_user_text("hi"), _asst_text("hello"), _user_text("ok")]
    new_msgs, stats = _run(summ.compress(msgs))
    assert not stats.triggered
    assert new_msgs == msgs


def test_compress_noop_too_few_messages():
    summ = ContextSummarizer(client=_ScriptedSummaryClient(), threshold_chars=1)
    msgs = [_user_text("hi"), _asst_text("hello")]
    new_msgs, stats = _run(summ.compress(msgs))
    assert not stats.triggered
    assert new_msgs == msgs


# ============================================================
# compress() — 정상 압축 (force=True 로 강제)
# ============================================================

def test_compress_force_triggers_and_injects_summary():
    client = _ScriptedSummaryClient(summary_text="요약 본문 X / Y / Z")
    summ = ContextSummarizer(
        client=client, threshold_chars=1_000_000,
        protect_first_n=2, tail_char_budget=100,
    )
    msgs = [
        _user_text("첫 user"),
        _asst_text("첫 assistant"),
        _user_text("두번째 user"),
        _asst_text("두번째 assistant"),
        _user_text("세번째 user"),
        _asst_text("세번째 assistant"),
        _user_text("마지막 user 질문"),
    ]
    new_msgs, stats = _run(summ.compress(msgs, force=True))
    assert stats.triggered
    assert stats.head_count == 2
    assert stats.tail_count >= 1
    # summary message 가 head 와 tail 사이에 삽입돼야
    summary_idxs = [i for i, m in enumerate(new_msgs)
                    if isinstance(m, UserMessage)
                    and SUMMARY_PREFIX in "".join(
                        b.text for b in m.content if isinstance(b, TextBlock))]
    assert len(summary_idxs) == 1
    # LLM 호출됐는지
    assert len(client.calls) == 1


def test_compress_force_preserves_last_user_message():
    client = _ScriptedSummaryClient()
    summ = ContextSummarizer(
        client=client, threshold_chars=1_000_000,
        protect_first_n=1, tail_char_budget=50,
    )
    msgs = [
        _user_text("첫 user"),
        _asst_text("a"), _user_text("b"),
        _asst_text("c"), _user_text("d"),
        _asst_text("e"), _user_text("마지막 user 메시지 보존되어야"),
    ]
    new_msgs, stats = _run(summ.compress(msgs, force=True))
    last = new_msgs[-1]
    assert isinstance(last, UserMessage)
    assert "마지막 user 메시지 보존" in "".join(
        b.text for b in last.content if isinstance(b, TextBlock))


def test_compress_force_summary_has_end_marker():
    client = _ScriptedSummaryClient(summary_text="요약")
    summ = ContextSummarizer(
        client=client, threshold_chars=1_000_000,
        protect_first_n=1, tail_char_budget=50,
    )
    msgs = [
        _user_text("u1"), _asst_text("a1"),
        _user_text("u2"), _asst_text("a2"),
        _user_text("u3"), _asst_text("a3"),
        _user_text("u4"),
    ]
    new_msgs, _ = _run(summ.compress(msgs, force=True))
    full = "\n".join(
        "".join(b.text for b in m.content if isinstance(b, TextBlock))
        for m in new_msgs if isinstance(m, UserMessage)
    )
    assert SUMMARY_END_MARKER.strip() in full


# ============================================================
# Tool pair integrity
# ============================================================

def test_compress_keeps_tool_use_and_result_paired():
    """assistant(tool_use=X) → user(tool_result=X) 가 한 group 으로 유지."""
    client = _ScriptedSummaryClient()
    summ = ContextSummarizer(
        client=client, threshold_chars=1_000_000,
        protect_first_n=1, tail_char_budget=10,
    )
    msgs = [
        _user_text("start"),
        _asst_tool("tu_1"), _user_tool_result("tu_1", "result1"),
        _asst_tool("tu_2"), _user_tool_result("tu_2", "result2"),
        _asst_text("done"),
        _user_text("end"),
    ]
    new_msgs, stats = _run(summ.compress(msgs, force=True))
    assert stats.triggered
    # orphan tool_result 가 남으면 안 됨
    all_tool_use_ids = set()
    all_result_ids = set()
    for m in new_msgs:
        if isinstance(m, AssistantMessage):
            for b in m.content:
                if isinstance(b, ToolUseBlock):
                    all_tool_use_ids.add(b.id)
        elif isinstance(m, UserMessage):
            for b in m.content:
                if isinstance(b, ToolResultBlock):
                    all_result_ids.add(b.tool_use_id)
    assert all_result_ids.issubset(all_tool_use_ids), \
        f"orphan tool_result: {all_result_ids - all_tool_use_ids}"


def test_sanitize_removes_orphan_tool_results():
    """수동 sanitize 호출 — assistant 가 없는 tool_result 제거."""
    summ = ContextSummarizer(client=_ScriptedSummaryClient())
    msgs = [
        _user_text("hi"),
        _user_tool_result("orphan_id", "result"),
        _user_text("end"),
    ]
    out = summ._sanitize_tool_pairs(msgs)
    # orphan tool_result block 사라짐
    for m in out:
        if isinstance(m, UserMessage):
            for b in m.content:
                assert not (isinstance(b, ToolResultBlock) and b.tool_use_id == "orphan_id")


def test_sanitize_adds_stub_for_missing_tool_result():
    """assistant(tool_use) 다음 tool_result 가 없으면 stub 박힘."""
    summ = ContextSummarizer(client=_ScriptedSummaryClient())
    msgs = [
        _user_text("hi"),
        _asst_tool("tu_alone"),
        _user_text("end"),  # 이건 tool_result 캐리어가 아님
    ]
    out = summ._sanitize_tool_pairs(msgs)
    stub_found = False
    for m in out:
        if isinstance(m, UserMessage):
            for b in m.content:
                if isinstance(b, ToolResultBlock) and b.tool_use_id == "tu_alone":
                    stub_found = True
                    assert "removed by compaction" in b.content
    assert stub_found


# ============================================================
# Iterative update
# ============================================================

def test_compress_uses_previous_summary_on_second_call():
    client = _ScriptedSummaryClient(summary_text="first summary body")
    summ = ContextSummarizer(
        client=client, threshold_chars=1_000_000,
        protect_first_n=1, tail_char_budget=10,
    )
    msgs = [
        _user_text("u1"), _asst_text("a1"),
        _user_text("u2"), _asst_text("a2"),
        _user_text("u3"),
    ]
    _run(summ.compress(msgs, force=True))
    assert summ._previous_summary == "first summary body"

    # 두 번째 호출 — prompt 안에 PREVIOUS SUMMARY 등장해야
    client.summary_text = "updated summary"
    _run(summ.compress(msgs, force=True))
    second_prompt = "".join(
        b.text for b in client.calls[1].messages[0].content
        if isinstance(b, TextBlock)
    )
    assert "PREVIOUS SUMMARY" in second_prompt
    assert "first summary body" in second_prompt


def test_reset_session_state_clears_previous_summary():
    client = _ScriptedSummaryClient()
    summ = ContextSummarizer(client=client)
    summ._previous_summary = "old"
    summ._ineffective_compression_count = 5
    summ.reset_session_state()
    assert summ._previous_summary is None
    assert summ._ineffective_compression_count == 0


# ============================================================
# Focus topic
# ============================================================

def test_compress_focus_topic_injected_into_prompt():
    client = _ScriptedSummaryClient()
    summ = ContextSummarizer(
        client=client, threshold_chars=1_000_000,
        protect_first_n=1, tail_char_budget=10,
    )
    msgs = [
        _user_text("u1"), _asst_text("a1"),
        _user_text("u2"), _asst_text("a2"),
        _user_text("u3"),
    ]
    _run(summ.compress(msgs, force=True, focus_topic="SMB 점검 결과"))
    prompt = "".join(
        b.text for b in client.calls[0].messages[0].content
        if isinstance(b, TextBlock)
    )
    assert "FOCUS TOPIC" in prompt
    assert "SMB 점검 결과" in prompt


# ============================================================
# Summary truth-state schema
# ============================================================

def test_summary_prefix_invalidated_claims_override_old_assistant_text():
    assert "Invalidated / Mistaken Claims" in SUMMARY_PREFIX
    assert "과거 assistant 발화보다 우선" in SUMMARY_PREFIX
    assert "반복하지 마라" in SUMMARY_PREFIX


def test_build_summary_prompt_requires_truth_state_sections():
    summ = ContextSummarizer(client=_ScriptedSummaryClient())
    msgs = [
        _user_text("대상 사이트 보안 상태 확인"),
        _asst_text("세션 쿠키 Secure/HttpOnly 누락 확정"),
        _asst_tool(
            "tu_cookie",
            name="browser_visit",
            input_={"url": "https://example.test"},
        ),
        _user_tool_result(
            "tu_cookie",
            "Set-Cookie count=0\nNo response cookies observed in this capture.",
        ),
    ]
    prompt = summ._build_summary_prompt(msgs, focus_topic=None)

    for heading in (
        "## Verified Facts",
        "## Invalidated / Mistaken Claims",
        "## Inconclusive Evidence",
        "## Current Situation",
        "## Do Not Repeat",
    ):
        assert heading in prompt
    assert "tool result 와 사용자 정정/명시가 assistant 서술보다 우선" in prompt
    assert "Verified Facts 에 넣지 마라" in prompt
    assert "count=0" in prompt
    assert "미관찰/판단 불가" in prompt


def test_previous_summary_update_keeps_invalidated_claims_visible():
    summ = ContextSummarizer(client=_ScriptedSummaryClient())
    summ._previous_summary = (
        "## Invalidated / Mistaken Claims\n"
        "- 이전 assistant의 쿠키 플래그 누락 확정 주장은 증거 부족."
    )
    prompt = summ._build_summary_prompt([_user_text("다시 이어서")], focus_topic=None)
    assert "PREVIOUS SUMMARY" in prompt
    assert "쿠키 플래그 누락 확정 주장은 증거 부족" in prompt
    assert "틀린 과거 결론은 삭제하지 말고 Invalidated 로 이동" in prompt


# ============================================================
# 실패 모드 — LLM error → fallback summary
# ============================================================

def test_compress_falls_back_when_llm_errors():
    # v3.79-perf: summary 생성 실패 시 중간 turn 을 비가역 하드드롭하지 않는다.
    # 원본이 window(≥trigger) 안이면 파괴 0 — 원본 그대로 유지하고 cooldown 후
    # 재시도한다. 예전엔 fake "Summary 생성 실패" placeholder 로 middle 을 통째
    # 버렸는데(trigger 240K < 실제 한계 454K 에서의 과도 파괴), 이를 recoverable
    # sliding-window fallback 으로 대체했다.
    client = _ScriptedSummaryClient(error_msg="upstream 500")
    summ = ContextSummarizer(
        client=client, threshold_chars=1_000_000,
        protect_first_n=1, tail_char_budget=10,
    )
    msgs = [
        _user_text("u1"), _asst_text("a1"),
        _user_text("u2"), _asst_text("a2"),
        _user_text("u3"),
    ]
    new_msgs, stats = _run(summ.compress(msgs, force=True))
    assert stats.summary_error is not None
    assert stats.fallback_used
    # window 안 → 파괴 없이 원본 보존 (비가역 드롭 금지). 압축 아님 → triggered False.
    assert not stats.triggered
    assert stats.dropped_count == 0
    assert new_msgs == msgs
    # 예전의 "Summary 생성 실패" placeholder 는 더 이상 주입되지 않는다.
    full = "\n".join(
        "".join(b.text for b in m.content if isinstance(b, TextBlock))
        for m in new_msgs if isinstance(m, UserMessage)
    )
    assert "Summary 생성 실패" not in full
    assert SUMMARY_PREFIX not in full


def test_compress_cooldown_after_failure_blocks_next_call():
    client = _ScriptedSummaryClient(error_msg="upstream 500")
    summ = ContextSummarizer(
        client=client, threshold_chars=1_000_000,
        protect_first_n=1, tail_char_budget=10,
    )
    msgs = [
        _user_text("u1"), _asst_text("a1"),
        _user_text("u2"),
    ]
    _run(summ.compress(msgs, force=True))
    # 두 번째 호출 — cooldown 안이면 LLM 다시 안 부름
    first_call_count = len(client.calls)
    _run(summ.compress(msgs, force=True))
    assert len(client.calls) == first_call_count  # cooldown 으로 skip


# ============================================================
# SUMMARY_PREFIX 도우미
# ============================================================

def test_strip_summary_prefix_handles_both_formats():
    body = ContextSummarizer._strip_summary_prefix(SUMMARY_PREFIX + "\nbody")
    assert body == "body"
    body2 = ContextSummarizer._strip_summary_prefix("[CONTEXT SUMMARY]:\nbody2")
    assert body2 == "body2"


def test_with_summary_prefix_normalizes():
    out = ContextSummarizer._with_summary_prefix("내용")
    assert out.startswith(SUMMARY_PREFIX)
    assert "내용" in out
    # 이미 prefix 있으면 중복 X
    out2 = ContextSummarizer._with_summary_prefix(out)
    assert out2.count(SUMMARY_PREFIX) == 1


# ============================================================
# Anti-thrashing — 절약 효과 추적
# ============================================================

def test_savings_pct_tracked_in_stats():
    client = _ScriptedSummaryClient(summary_text="작은 요약")
    summ = ContextSummarizer(
        client=client, threshold_chars=1_000_000,
        protect_first_n=1, tail_char_budget=10,
    )
    large_msg = _user_text("x" * 5000)
    msgs = [
        _user_text("u1"),
        large_msg, _asst_text("a"),
        large_msg, _asst_text("a"),
        _user_text("end"),
    ]
    _, stats = _run(summ.compress(msgs, force=True))
    assert stats.savings_pct > 0


# ============================================================
# v3.62: 영구 인증 에러 → summarizer self-disable (재시도 폭주 방지)
# ============================================================

@pytest.mark.parametrize("err_msg", [
    "Error code: 401 - {'error': {'code': 'token_invalidated', 'message': "
    "'Your authentication token has been invalidated. Please try signing in again.'}}",
    "401 Unauthorized",
    "Incorrect API key provided",
])
def test_perm_auth_error_disables_summarizer(err_msg):
    client = _ScriptedSummaryClient(error_msg=err_msg)
    summ = ContextSummarizer(client=client, threshold_chars=100)
    msgs = [_user_text("dummy turn " + "x" * 200)]
    # 1차 호출: 에러 → disable
    out1 = _run(summ._generate_summary(msgs, focus_topic=None))
    assert out1 is None
    assert summ._disabled_reason is not None
    assert len(client.calls) == 1
    # 2차 호출: 이미 disable 됐으니 LLM 안 부르고 None 반환
    out2 = _run(summ._generate_summary(msgs, focus_topic=None))
    assert out2 is None
    assert len(client.calls) == 1  # ★ 핵심: 재시도 없음
    # 3차도 안 부름
    _run(summ._generate_summary(msgs, focus_topic=None))
    assert len(client.calls) == 1


def test_transient_error_uses_cooldown_not_disable():
    """transient 에러(예: server timeout)는 cooldown 만 — disable 안 함."""
    client = _ScriptedSummaryClient(error_msg="500 Internal Server Error")
    summ = ContextSummarizer(client=client, threshold_chars=100)
    msgs = [_user_text("dummy " + "x" * 200)]
    _run(summ._generate_summary(msgs, focus_topic=None))
    assert summ._disabled_reason is None  # disable 안 됨
    assert summ._summary_failure_cooldown_until > 0  # cooldown 은 set


def test_reset_session_state_clears_disable():
    client = _ScriptedSummaryClient(error_msg="401 token_invalidated")
    summ = ContextSummarizer(client=client, threshold_chars=100)
    msgs = [_user_text("dummy " + "x" * 200)]
    _run(summ._generate_summary(msgs, focus_topic=None))
    assert summ._disabled_reason is not None
    summ.reset_session_state()
    assert summ._disabled_reason is None
    # reset 후 (에러 client 그대로지만) 다시 시도는 함
    _run(summ._generate_summary(msgs, focus_topic=None))
    assert len(client.calls) == 2
