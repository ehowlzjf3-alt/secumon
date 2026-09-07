"""v3.79-perf: context_brief 의 bg completion 조회가 전체 history 대신
bounded LIMIT 로 최근 창만 로드하는지 + 출력 동일성 유지 검증.

DB/subprocess/network 없이 state.chat_messages_for 만 monkeypatch 로 대체한다.
"""
from __future__ import annotations

import pytest

from secu_agent.agent import context_brief


def _msg(role: str, content):
    return {"role": role, "content": content}


def test_bg_summary_passes_bounded_limit(monkeypatch):
    """chat_messages_for 를 unbounded(limit=None) 로 부르지 않고 상한을 넘긴다."""
    seen: dict[str, object] = {}

    def fake(session_id, *, limit=None):
        seen["limit"] = limit
        return []

    monkeypatch.setattr(context_brief.state, "chat_messages_for", fake)
    monkeypatch.delenv("SA_CONTEXT_BRIEF_MAX_MESSAGES", raising=False)

    assert context_brief._bg_completion_summary(7) is None
    # 기본값(200) 이 넘어가야 함 — None(unbounded) 이면 실패.
    assert seen["limit"] == 200


def test_env_override_controls_limit(monkeypatch):
    seen: dict[str, object] = {}

    def fake(session_id, *, limit=None):
        seen["limit"] = limit
        return []

    monkeypatch.setattr(context_brief.state, "chat_messages_for", fake)
    monkeypatch.setenv("SA_CONTEXT_BRIEF_MAX_MESSAGES", "42")
    context_brief._bg_completion_summary(7)
    assert seen["limit"] == 42


@pytest.mark.parametrize("bad", ["", "  ", "0", "-5", "abc"])
def test_env_invalid_falls_back_to_default(monkeypatch, bad):
    seen: dict[str, object] = {}

    def fake(session_id, *, limit=None):
        seen["limit"] = limit
        return []

    monkeypatch.setattr(context_brief.state, "chat_messages_for", fake)
    monkeypatch.setenv("SA_CONTEXT_BRIEF_MAX_MESSAGES", bad)
    context_brief._bg_completion_summary(7)
    assert seen["limit"] == 200


def test_output_preserved_for_bg_after_last_user(monkeypatch):
    """last user turn 이후의 bg_task_completed 만 요약 — 내용 동일성 확인."""
    msgs = [
        _msg("user", {"text": "old"}),
        _msg("assistant", {"text": "..."}),
        _msg("user", {"text": "왜 끊겼어"}),
        _msg(
            "system",
            {
                "event": "bg_task_completed",
                "process_id": "p1",
                "command": "nmap -sV 12.25.146.0/24",
                "exit_code": 0,
                "duration_sec": 12,
                "output_tail": "line-a\nline-b",
            },
        ),
    ]

    def fake(session_id, *, limit=None):
        # 상한이 주어져도 최근 창엔 관련 메시지가 다 들어있다는 전제.
        return msgs

    monkeypatch.setattr(context_brief.state, "chat_messages_for", fake)
    monkeypatch.delenv("SA_CONTEXT_BRIEF_MAX_MESSAGES", raising=False)

    out = context_brief._bg_completion_summary(7)
    assert out is not None
    assert "직전 백그라운드 작업 1개 완료" in out
    assert "[p1]" in out
    assert "exit=0" in out
    assert "nmap -sV 12.25.146.0/24" in out
    assert "line-b" in out  # tail 마지막 줄


def test_bg_before_last_user_ignored(monkeypatch):
    """직전 user turn 이전의 bg completion 은 무시(기존 semantics 유지)."""
    msgs = [
        _msg(
            "system",
            {"event": "bg_task_completed", "process_id": "old", "command": "x"},
        ),
        _msg("user", {"text": "new turn"}),
    ]

    monkeypatch.setattr(
        context_brief.state, "chat_messages_for", lambda s, *, limit=None: msgs
    )
    assert context_brief._bg_completion_summary(7) is None
