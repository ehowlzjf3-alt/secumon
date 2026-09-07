"""v3.79-perf: context_summarizer trigger threshold + summary-실패 fallback 회복성.

검증 대상 (audit summarizer_threshold):
1. summary 생성이 실패해도 중간 turn 을 비가역 하드드롭하지 않는다 —
   원본이 sliding-window bound 안이면 파괴 0으로 원본 유지(recoverable).
2. window 초과 시에만 head+recent tail 로 bounded 축소 (진짜 한계에서만 drop,
   hard limit 초과 X).
3. trigger threshold 가 SA_SUMMARY_TRIGGER_TOKENS 로 override 가능.
4. fallback window 가 SA_SUMMARY_WINDOW_CHARS override + 최소 trigger 로 clamp.
5. happy-path summarize 동작은 그대로 (실패 없이 요약되면 SUMMARY_PREFIX 주입).

deterministic unit test — 실제 network/DB/subprocess 없음. LLM 호출은
monkeypatch/fake client 로 대체.
"""
from __future__ import annotations

import asyncio

import pytest

from secu_agent.agent.context_summarizer import (
    ContextSummarizer,
    SUMMARY_PREFIX,
    _CHARS_PER_TOKEN,
    _env_int,
    has_prior_summary,
    total_chars,
)
from secu_agent.agent.llm.messages import (
    AssistantMessage,
    TextBlock,
    UserMessage,
)
from secu_agent.agent.llm.types import (
    StreamMessageStop,
    StreamTextDelta,
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

class _DummyClient:
    """compress() 가 요구하는 client 필드용 stub — 여기선 _generate_summary 를
    직접 monkeypatch 하므로 stream 은 안 불린다."""

    async def stream(self, request):  # pragma: no cover - 미사용 경로
        raise AssertionError("stream should not be called in fallback tests")
        yield  # noqa: unreachable — async generator 로 만들기 위함


class _SummaryClient:
    """happy-path 용 — 고정 summary 텍스트를 스트리밍하는 fake client."""

    def __init__(self, body: str) -> None:
        self._body = body

    async def stream(self, request):
        yield StreamTextDelta(text=self._body)
        yield StreamMessageStop(stop_reason="end_turn")


def _text_msgs(n: int, size: int) -> list:
    """text-only user/assistant 를 번갈아 n개 생성. 각 본문 size chars."""
    msgs: list = []
    for i in range(n):
        block = TextBlock(text=(f"m{i:03d}-" + "x" * size))
        if i % 2 == 0:
            msgs.append(UserMessage(content=[block]))
        else:
            msgs.append(AssistantMessage(content=[block]))
    return msgs


def _force_summary_failure(summarizer: ContextSummarizer) -> None:
    async def _fail(turns, *, focus_topic=None):
        return None

    summarizer._generate_summary = _fail  # type: ignore[assignment]


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# 1. summary 실패 → window 안이면 원본 파괴 0 유지
# ---------------------------------------------------------------------------

def test_fallback_preserves_original_within_window(monkeypatch):
    monkeypatch.delenv("SA_SUMMARY_WINDOW_CHARS", raising=False)
    monkeypatch.delenv("SA_SUMMARY_TRIGGER_TOKENS", raising=False)

    msgs = _text_msgs(20, 800)  # ~16K chars — 기본 window(454K) 훨씬 아래
    assert total_chars(msgs) < 454_000

    s = ContextSummarizer(client=_DummyClient(), threshold_chars=1_000)
    _force_summary_failure(s)

    result, stats = _run(s.compress(msgs, force=True))

    # 파괴 0 — 중간 하드드롭 없음
    assert stats.fallback_used is True
    assert stats.summary_error == "summary generation failed"
    assert stats.dropped_count == 0
    # 원본 메시지 그대로 (내용 보존)
    assert result == msgs
    # fake summary placeholder 주입 안 됨 (예전 비가역 동작 회귀 방지)
    assert not has_prior_summary(result)


# ---------------------------------------------------------------------------
# 2. window 초과 시 bounded 축소 (head+tail 유지, hard limit 초과 X)
# ---------------------------------------------------------------------------

def test_fallback_bounded_shrink_over_window(monkeypatch):
    monkeypatch.setenv("SA_SUMMARY_WINDOW_CHARS", "5000")
    monkeypatch.delenv("SA_SUMMARY_TRIGGER_TOKENS", raising=False)

    msgs = _text_msgs(20, 800)  # ~16K chars > window 5000
    orig_chars = total_chars(msgs)
    assert orig_chars > 5000

    # threshold 를 낮게 둬 window clamp(max(window, threshold)) 가 5000 유지되게.
    s = ContextSummarizer(
        client=_DummyClient(), threshold_chars=1_000, protect_first_n=2,
    )
    _force_summary_failure(s)

    result, stats = _run(s.compress(msgs, force=True))

    assert stats.fallback_used is True
    assert stats.dropped_count > 0            # 실제 한계 초과분만 drop
    assert len(result) < len(msgs)
    # head 보존
    assert result[0] == msgs[0]
    assert result[1] == msgs[1]
    # tail 보존 (마지막 메시지 유지)
    assert result[-1] == msgs[-1]
    # bounded: 결과가 window 아래로 내려옴 (hard limit 초과 X)
    assert total_chars(result) <= 5000
    # 여전히 fake summary placeholder 주입 안 됨
    assert not has_prior_summary(result)


# ---------------------------------------------------------------------------
# 3. trigger threshold env override
# ---------------------------------------------------------------------------

def test_trigger_threshold_env_override(monkeypatch):
    monkeypatch.setenv("SA_SUMMARY_TRIGGER_TOKENS", "50000")
    s = ContextSummarizer(client=_DummyClient(), threshold_chars=999)
    assert s.threshold_chars == 50000 * _CHARS_PER_TOKEN


def test_trigger_threshold_default_respected_without_env(monkeypatch):
    monkeypatch.delenv("SA_SUMMARY_TRIGGER_TOKENS", raising=False)
    s = ContextSummarizer(client=_DummyClient(), threshold_chars=123_456)
    # env 미설정 시 생성자 값 존중
    assert s.threshold_chars == 123_456


def test_trigger_threshold_env_invalid_ignored(monkeypatch):
    monkeypatch.setenv("SA_SUMMARY_TRIGGER_TOKENS", "not-an-int")
    s = ContextSummarizer(client=_DummyClient(), threshold_chars=200_000)
    assert s.threshold_chars == 200_000


# ---------------------------------------------------------------------------
# 4. window clamp — trigger 보다 낮은 window 는 trigger 로 올림
# ---------------------------------------------------------------------------

def test_window_clamped_to_threshold(monkeypatch):
    # window env 를 아주 작게 두지만 threshold 는 큼 → clamp 로 threshold 이상 보장.
    monkeypatch.setenv("SA_SUMMARY_WINDOW_CHARS", "1")
    monkeypatch.delenv("SA_SUMMARY_TRIGGER_TOKENS", raising=False)

    msgs = _text_msgs(20, 800)  # ~16K chars
    orig = total_chars(msgs)

    # threshold 를 원본보다 크게 → clamp 된 window(=threshold) 안에 원본이 들어감 → 파괴 0
    s = ContextSummarizer(client=_DummyClient(), threshold_chars=orig + 100_000)
    _force_summary_failure(s)

    result, stats = _run(s.compress(msgs, force=True))
    assert stats.dropped_count == 0
    assert result == msgs


def test_env_int_helper(monkeypatch):
    monkeypatch.setenv("SA_XYZ_TEST", "42")
    assert _env_int("SA_XYZ_TEST", 7) == 42
    monkeypatch.setenv("SA_XYZ_TEST", "0")       # 비양수 → default
    assert _env_int("SA_XYZ_TEST", 7) == 7
    monkeypatch.setenv("SA_XYZ_TEST", "junk")    # 파싱실패 → default
    assert _env_int("SA_XYZ_TEST", 7) == 7
    monkeypatch.delenv("SA_XYZ_TEST", raising=False)
    assert _env_int("SA_XYZ_TEST", 7) == 7


# ---------------------------------------------------------------------------
# 5. happy path — summary 성공 시 기존 동작 유지 (SUMMARY_PREFIX 주입)
# ---------------------------------------------------------------------------

def test_happy_path_summarize_still_works(monkeypatch):
    monkeypatch.delenv("SA_SUMMARY_TRIGGER_TOKENS", raising=False)
    monkeypatch.delenv("SA_SUMMARY_WINDOW_CHARS", raising=False)

    msgs = _text_msgs(20, 800)
    s = ContextSummarizer(
        client=_SummaryClient("## Active Task\nNone.\n요약 본문"),
        threshold_chars=1_000, protect_first_n=2,
    )

    result, stats = _run(s.compress(msgs, force=True))

    assert stats.triggered is True
    assert stats.fallback_used is False
    assert stats.summary_error is None
    assert stats.summary_chars > 0
    # SUMMARY_PREFIX 주입됨
    assert has_prior_summary(result)
    assert any(
        isinstance(m, UserMessage)
        and any(SUMMARY_PREFIX in b.text for b in m.content if isinstance(b, TextBlock))
        for m in result
    )
