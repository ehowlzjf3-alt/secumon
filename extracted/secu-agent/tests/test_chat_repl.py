"""v3.82 U4: secu-agent chat REPL — 승인 resolver/렌더러/CLI 배선."""
from __future__ import annotations

import asyncio
import io

import pytest
from rich.console import Console

from secu_agent.agent.tools.approval import ApprovalRequest


def _console() -> Console:
    return Console(file=io.StringIO(), force_terminal=False, width=100)


def _request() -> ApprovalRequest:
    return ApprovalRequest(
        invocation_id="approval-repl-1",
        tool_name="approval_probe",
        tool_input={"command": "dangerous-op"},
        reason="destructive tool",
    )


def test_terminal_resolver_auto_allows_and_audits(tmp_db):
    from secu_agent import state
    from secu_agent.agent.chat_repl import TerminalApprovalResolver

    sid = state.chat_session_new(agent_type="agent")
    r = TerminalApprovalResolver(console=_console(), session_id=sid,
                                 agent_type="agent", mode="auto")
    decision = asyncio.run(r.resolve(_request()))
    assert decision.behavior == "allow"
    audit = state.approval_audit_get("approval-repl-1")
    assert audit is not None
    assert audit["decision"] == "allow"
    assert audit["actor"] == "terminal"


def test_terminal_resolver_deny_mode(tmp_db):
    from secu_agent import state
    from secu_agent.agent.chat_repl import TerminalApprovalResolver

    sid = state.chat_session_new(agent_type="agent")
    r = TerminalApprovalResolver(console=_console(), session_id=sid,
                                 agent_type="agent", mode="deny")
    decision = asyncio.run(r.resolve(_request()))
    assert decision.behavior == "deny"


@pytest.mark.parametrize("answer,expected", [("y", "allow"), ("", "deny"), ("n", "deny")])
def test_terminal_resolver_ask_keystroke(tmp_db, monkeypatch, answer, expected):
    import builtins

    from secu_agent import state
    from secu_agent.agent.chat_repl import TerminalApprovalResolver

    sid = state.chat_session_new(agent_type="agent")
    monkeypatch.setattr(builtins, "input", lambda *_: answer)
    r = TerminalApprovalResolver(console=_console(), session_id=sid,
                                 agent_type="agent", mode="ask")
    decision = asyncio.run(r.resolve(_request()))
    assert decision.behavior == expected


def test_renderer_streams_and_finishes():
    from secu_agent.agent.chat_repl import _TurnRenderer
    from secu_agent.agent.events import (
        LoopCompleted, ReasoningChunk, TextChunk, ToolCallCompleted, ToolCallStarted,
    )
    from secu_agent.agent.tools.base import ToolSuccess

    out = io.StringIO()
    console = Console(file=out, force_terminal=False, width=100)
    r = _TurnRenderer(console)
    r.render(ReasoningChunk(text="생각중..."))
    r.render(TextChunk(text="결과 **요약** "))
    r.render(ToolCallStarted(tool_use_id="t1", name="scan_text", input={"text": "x"}))
    r.render(ToolCallCompleted(tool_use_id="t1", name="scan_text",
                               result=ToolSuccess(content="hits: 0")))
    r.render(LoopCompleted(reason="end_turn", total_turns=1,
                           final_message=None, usage=None))
    text = out.getvalue()
    assert "결과" in text
    assert "scan_text" in text
    assert "end_turn" in text


def test_renderer_goal_events():
    from secu_agent.agent.chat_repl import _TurnRenderer
    from secu_agent.agent.events import GoalChecklistUpdated, GoalDone, GoalPaused

    out = io.StringIO()
    r = _TurnRenderer(Console(file=out, force_terminal=False, width=100))
    r.render(GoalChecklistUpdated(flipped=1, pending=1, completed=1, total=2,
                                  reason="subnet 스캔 완료"))
    r.render(GoalPaused(goal_text="전체 점검", reason="무진전"))
    r.render(GoalDone(goal_text="전체 점검", reason="완료"))
    text = out.getvalue()
    assert "1/2" in text
    assert "일시정지" in text
    assert "goal 완료" in text


def test_cli_chat_subcommand_wired():
    import argparse

    from secu_agent.agent.chat_repl import add_subparser

    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd")
    add_subparser(sub)
    args = p.parse_args([
        "chat", "--list-sessions", "--agent_type", "agent",
        "-s", "plan_mode,evidence_inspection", "-s", "/tmp",
        "--approval-mode", "auto",
    ])
    assert args.cmd == "chat"
    assert args.skills == ["plan_mode,evidence_inspection", "/tmp"]
    assert args.approval_mode == "auto"
    assert args.list_sessions is True


def test_run_chat_list_sessions(tmp_db, capsys):
    from secu_agent import state
    from secu_agent.agent.chat_repl import run_chat

    state.chat_session_new(agent_type="agent", label="테스트 세션")

    import argparse
    args = argparse.Namespace(
        session=None, list_sessions=True, agent_type="agent",
        approval_mode="ask", skills=None, profile_name=None, evidence_dir=None,
    )
    rc = asyncio.run(run_chat(args))
    assert rc == 0
    out = capsys.readouterr().out
    assert "테스트 세션" in out
