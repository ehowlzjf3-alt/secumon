"""ContextEngine — internal context compression policy.

This is intentionally not an external plugin system. It is a small application
service that coordinates the existing cheap tool-result compactor with the
LLM-based ContextSummarizer.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

from secu_agent.agent.compactor import compact_messages
from secu_agent.agent.context_summarizer import (
    CompressionStats,
    ContextSummarizer,
    total_chars,
)
from secu_agent.agent.llm.messages import Message


ContextEngineMode = Literal["off", "stub", "summary", "hybrid"]


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_mode(name: str, default: ContextEngineMode) -> ContextEngineMode:
    raw = (os.environ.get(name) or "").strip().lower()
    if raw in {"off", "stub", "summary", "hybrid"}:
        return raw  # type: ignore[return-value]
    return default


@dataclass(frozen=True, slots=True)
class ContextEnginePolicy:
    mode: ContextEngineMode = "hybrid"
    stub_threshold_chars: int = 60_000
    stub_keep_last_n: int = 2

    @classmethod
    def from_env(
        cls,
        *,
        default_mode: ContextEngineMode = "hybrid",
        default_stub_threshold_chars: int = 60_000,
        default_stub_keep_last_n: int = 2,
    ) -> "ContextEnginePolicy":
        return cls(
            mode=_env_mode("SA_CONTEXT_ENGINE_MODE", default_mode),
            stub_threshold_chars=_env_int(
                "SA_CONTEXT_STUB_THRESHOLD_CHARS",
                default_stub_threshold_chars,
            ),
            stub_keep_last_n=_env_int(
                "SA_CONTEXT_STUB_KEEP_LAST_N",
                default_stub_keep_last_n,
            ),
        )


@dataclass(slots=True)
class ContextEngineStats:
    mode: ContextEngineMode
    triggered: bool = False
    before_chars: int = 0
    after_chars: int = 0
    saved_chars: int = 0
    savings_pct: float = 0.0
    stub_compacted: int = 0
    summary_triggered: bool = False
    summary_stats: CompressionStats | None = None
    summary_error: str | None = None
    fallback_used: bool = False


@dataclass(slots=True)
class ContextEngine:
    policy: ContextEnginePolicy
    summarizer: ContextSummarizer | None = None

    async def compress(
        self,
        messages: list[Message],
        *,
        force: bool = False,
        focus_topic: str | None = None,
    ) -> tuple[list[Message], ContextEngineStats]:
        stats = ContextEngineStats(mode=self.policy.mode)
        stats.before_chars = total_chars(messages)

        if self.policy.mode == "off":
            stats.after_chars = stats.before_chars
            return messages, stats

        current = messages

        if self.policy.mode in {"stub", "hybrid"}:
            threshold = 0 if force else self.policy.stub_threshold_chars
            current, stub_n = compact_messages(
                current,
                char_threshold=threshold,
                keep_last_n=self.policy.stub_keep_last_n,
            )
            stats.stub_compacted = stub_n

        if self.policy.mode in {"summary", "hybrid"} and self.summarizer is not None:
            should_summary = force or self.summarizer.should_compress(current)
            if should_summary:
                current, summary_stats = await self.summarizer.compress(
                    current,
                    force=force,
                    focus_topic=focus_topic,
                )
                stats.summary_stats = summary_stats
                stats.summary_triggered = summary_stats.triggered
                stats.summary_error = summary_stats.summary_error
                stats.fallback_used = summary_stats.fallback_used

        stats.after_chars = total_chars(current)
        stats.saved_chars = stats.before_chars - stats.after_chars
        stats.savings_pct = (
            stats.saved_chars / stats.before_chars * 100
            if stats.before_chars else 0.0
        )
        stats.triggered = stats.stub_compacted > 0 or stats.summary_triggered
        return current, stats


__all__ = [
    "ContextEngine",
    "ContextEngineMode",
    "ContextEnginePolicy",
    "ContextEngineStats",
]
