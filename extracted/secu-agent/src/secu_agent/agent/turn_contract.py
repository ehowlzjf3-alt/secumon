"""Deterministic contracts for one assistant turn.

These checks are intentionally local and structural. They do not ask another
LLM to judge the answer, and they do not share state with coverage hooks.
"""
from __future__ import annotations

import re


_WHITESPACE_RE = re.compile(r"\s+")

_USER_RESPONSE_REQUESTS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(어떤|어느)\s*.{0,24}(단계|작업|범위|대상|항목|방식|도메인)"),
    re.compile(r"(원하시는|원하는)\s*.{0,24}(작업|단계|항목|방식|범위)"),
    re.compile(r"(알려\s*주세요|알려\s*주시|말씀\s*해\s*주세요|말씀\s*해\s*주시)"),
    re.compile(r"(선택|골라|지정)\s*.{0,16}(주세요|주시면|해\s*주세요)"),
    re.compile(r"(진행|실행|시도|테스트)\s*해도\s*(될까요|됩니까)"),
    re.compile(r"(무엇을|어디부터|어디를)"),
    re.compile(r"\?\s*$"),
)


def normalize_turn_text(text: str) -> str:
    """Collapse whitespace so streamed chunks and full text classify the same."""
    return _WHITESPACE_RE.sub(" ", text).strip()


def looks_like_user_response_request(text: str) -> bool:
    """Return True when assistant text asks the user to answer or choose.

    This is not a quality score. It is a narrow structural signal used only when
    the same assistant message also contains tool calls.
    """
    normalized = normalize_turn_text(text)
    if not normalized:
        return False
    return any(pattern.search(normalized) for pattern in _USER_RESPONSE_REQUESTS)


def should_emit_text_before_tool_calls(text: str) -> bool:
    """Decide whether pre-tool assistant text may be shown to the user.

    Tool calls are an action commitment. A user-response request in that same
    assistant message is contradictory, so the UI-facing text is suppressed and
    the tool calls proceed.
    """
    return bool(normalize_turn_text(text)) and not looks_like_user_response_request(text)
