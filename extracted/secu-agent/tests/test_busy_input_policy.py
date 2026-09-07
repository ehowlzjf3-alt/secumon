from __future__ import annotations

from secu_agent.agent.busy_input_policy import classify_busy_input


def test_busy_input_followup_queues_after_current_turn():
    decision = classify_busy_input(
        "https://example.com 웹 점검해봐",
        "끝나면 보고서도 정리해줘",
    )

    assert decision.disposition == "queue_after_current"


def test_busy_input_replacement_revises_current_turn():
    decision = classify_busy_input(
        "https://example.com 웹 점검해봐",
        "아니 대상은 https://other.example 로 바꿔서 진행해",
    )

    assert decision.disposition == "revise_current"


def test_busy_input_ambiguous_defaults_to_queue():
    decision = classify_busy_input(
        "현재 작업",
        "이것도 확인해줘",
    )

    assert decision.disposition == "queue_after_current"


def test_busy_input_explicit_revise_command_revises_current_turn():
    decision = classify_busy_input(
        "현재 작업",
        "/revise 범위를 staging으로 변경",
    )

    assert decision.disposition == "revise_current"
