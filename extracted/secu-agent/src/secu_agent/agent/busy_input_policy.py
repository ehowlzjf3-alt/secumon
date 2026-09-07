"""Classify user input that arrives while a chat turn is still running."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal


BusyInputDisposition = Literal["queue_after_current", "revise_current"]


@dataclass(frozen=True, slots=True)
class BusyInputDecision:
    disposition: BusyInputDisposition
    reason: str


_FOLLOWUP_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"끝나(면|고|는\s*대로)"),
    re.compile(r"완료(되면|하고|한\s*다음)"),
    re.compile(r"다음(으로|엔|에는|에)"),
    re.compile(r"그\s*다음"),
    re.compile(r"이후(에)?"),
    re.compile(r"추가로"),
    re.compile(r"그리고"),
    re.compile(r"또\b"),
    re.compile(r"\bafter\b|\bthen\b|\bnext\b|\balso\b", re.I),
)

_REVISION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^(아니|아냐|잠깐|스톱|stop)\b", re.I),
    re.compile(r"그거\s*말고|이거\s*말고|말고"),
    re.compile(r"대신"),
    re.compile(r"바꿔|변경|수정|정정"),
    re.compile(r"취소하고|중단하고|멈추고"),
    re.compile(r"방금|아까|지금\s*하던|현재\s*작업"),
    re.compile(r"(대상|url|도메인|범위|scope|target)\s*(은|는|을|를|:)", re.I),
)

_STRONG_REVISION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^(아니|아냐|잠깐|스톱|stop)\b", re.I),
    re.compile(r"취소하고|중단하고|멈추고"),
    re.compile(r"그거\s*말고|이거\s*말고"),
)


def classify_busy_input(current_text: str, incoming_text: str) -> BusyInputDecision:
    """Decide whether incoming busy input revises the active turn or queues next.

    Ambiguous input is queued. Aborting an active turn is only chosen when the
    incoming message carries clear replacement/correction signals.
    """
    del current_text
    text = " ".join(incoming_text.strip().split())
    if not text:
        return BusyInputDecision("queue_after_current", "empty busy input")

    lowered = text.lower()
    if lowered.startswith("/queue"):
        return BusyInputDecision("queue_after_current", "explicit queue command")
    if lowered.startswith(("/interrupt", "/revise", "/replace")):
        return BusyInputDecision("revise_current", "explicit revise command")

    follow_score = sum(1 for pattern in _FOLLOWUP_PATTERNS if pattern.search(text))
    revision_score = sum(1 for pattern in _REVISION_PATTERNS if pattern.search(text))
    strong_revision = any(pattern.search(text) for pattern in _STRONG_REVISION_PATTERNS)

    if revision_score and (strong_revision or revision_score >= follow_score):
        return BusyInputDecision("revise_current", "replacement/correction wording")
    if follow_score:
        return BusyInputDecision("queue_after_current", "follow-up sequencing wording")
    return BusyInputDecision("queue_after_current", "ambiguous busy input defaults to queue")
