"""워커 대화형 세션(`--serve`) 프로토콜 (v3.97).

## 왜 이 모드가 생겼나

단발 위임은 "작업 하나" 를 통째로 맡긴다. 그러면 워커가 10턴을 혼자 돌며 다 끝내고 부모는
결과만 받는 디스패처가 된다 — 실측에서 부모(리드)가 피벗 기록을 8런 내리 0건 썼다.
위임 단위를 **질문**으로 바꾸려면 워커가 질문 사이에 살아 있어야 한다.

여기서 고정하는 것은 **프로토콜**이다. LLM 은 부르지 않는다(가짜 harness).
"""
from __future__ import annotations

import asyncio
import io
import json
import sys
from dataclasses import dataclass
from typing import Any

import pytest

from secu_agent.agent import cli
from secu_agent.agent.events import LoopCompleted, TextChunk, TurnStarted
from secu_agent.agent.llm.messages import AssistantMessage, TextBlock


@dataclass
class _Usage:
    input_tokens: int = 1000
    output_tokens: int = 10


class _FakeCtx:
    def __init__(self) -> None:
        self.metadata: dict[str, Any] = {}


class _FakeHarness:
    """`run()` 이 이벤트를 흘리는 최소 harness. 매 pass 마다 턴수/텍스트를 지정한다."""

    def __init__(self, script: list[tuple[int, str, str]]) -> None:
        from secu_agent.agent.harness.budget import AgentBudget

        self.script = list(script)
        self.context = _FakeCtx()
        self.seen_messages: list[list[Any]] = []
        # 계약 예산 — serve 루프가 질문당 예산으로 갈아끼운다.
        self.budget = AgentBudget(max_turns=80)

    def run(self, *, initial_messages, system=None):  # noqa: ANN001
        self.seen_messages.append(list(initial_messages))
        turns, text, reason = self.script.pop(0) if self.script else (1, "ok", "end_turn")

        async def _gen():
            yield TurnStarted(turn=1)
            yield TextChunk(text=text)
            yield LoopCompleted(
                reason=reason, total_turns=turns,
                final_message=AssistantMessage(content=[TextBlock(text=text)]),
                usage=_Usage(),
            )
        return _gen()


def _run_serve(harness, stdin_lines: list[str], monkeypatch) -> list[dict]:
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(stdin_lines)))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    messages: list[Any] = [AssistantMessage(content=[TextBlock(text="task")])]
    asyncio.run(cli._serve_loop(
        harness, messages, "sys", set(), {"task_id": "t"}, "smb_file_inspect"))
    return [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]


def test_ready_then_answer_then_close(monkeypatch):
    h = _FakeHarness([(3, "답1", "end_turn"), (1, "답2", "end_turn")])
    msgs = _run_serve(h, [
        json.dumps({"ask": "질문1"}) + "\n",
        json.dumps({"ask": "질문2"}) + "\n",
        json.dumps({"close": True}) + "\n",
    ], monkeypatch)
    assert msgs[0]["ready"] is True and msgs[0]["task_id"] == "t"
    assert msgs[1]["text"] == "답1" and msgs[1]["turns_used"] == 3
    assert msgs[2]["text"] == "답2" and msgs[2]["turns_total"] == 4
    assert msgs[-1]["closed"] is True and msgs[-1]["asks"] == 2


def test_context_carries_previous_answer(monkeypatch):
    """★ 세션의 존재 이유 — 다음 질문이 직전 결론을 컨텍스트로 받는다."""
    h = _FakeHarness([(1, "첫 답", "end_turn"), (1, "둘째 답", "end_turn")])
    _run_serve(h, [json.dumps({"ask": "q1"}) + "\n",
                   json.dumps({"ask": "q2"}) + "\n",
                   json.dumps({"close": True}) + "\n"], monkeypatch)
    second = h.seen_messages[1]
    texts = [b.text for m in second for b in getattr(m, "content", [])]
    assert "첫 답" in texts, "직전 답이 다음 질문 컨텍스트에 없다 — 세션이 아니라 단발이다"
    assert "q1" in texts and "q2" in texts


def test_tool_history_is_not_carried(monkeypatch):
    """의도된 설계 — 도구 결과는 이월하지 않는다(컨텍스트 폭주 억제).

    실측 근거: 이월분은 최종 답변 텍스트뿐이라 질문당 500~1,200 tok 이다. 도구 결과까지
    이월하면 한 질문의 28K 스파이크가 그대로 쌓인다.
    """
    h = _FakeHarness([(4, "답", "end_turn"), (1, "답2", "end_turn")])
    _run_serve(h, [json.dumps({"ask": "q1"}) + "\n",
                   json.dumps({"ask": "q2"}) + "\n",
                   json.dumps({"close": True}) + "\n"], monkeypatch)
    second = h.seen_messages[1]
    assert all(type(m).__name__ in ("AssistantMessage", "UserMessage") for m in second)


def test_eof_ends_the_session(monkeypatch):
    """부모가 사라지면 워커도 끝난다 — 고아 프로세스 금지."""
    h = _FakeHarness([(1, "답", "end_turn")])
    msgs = _run_serve(h, [json.dumps({"ask": "q"}) + "\n"], monkeypatch)
    assert msgs[0]["ready"] and msgs[1]["ok"]
    assert not any(m.get("closed") for m in msgs)   # EOF 는 close 응답 없이 끝


def test_bad_json_does_not_kill_the_session(monkeypatch):
    h = _FakeHarness([(1, "답", "end_turn")])
    msgs = _run_serve(h, ["{망가진\n", json.dumps({"ask": "q"}) + "\n",
                          json.dumps({"close": True}) + "\n"], monkeypatch)
    assert msgs[1]["ok"] is False and "invalid json" in msgs[1]["error"]
    assert msgs[2]["ok"] is True and msgs[2]["text"] == "답"


def test_empty_ask_is_rejected(monkeypatch):
    h = _FakeHarness([])
    msgs = _run_serve(h, [json.dumps({"ask": "  "}) + "\n",
                          json.dumps({"close": True}) + "\n"], monkeypatch)
    assert msgs[1]["ok"] is False and "ask" in msgs[1]["error"]


def test_session_budget_is_separate_from_per_ask_budget(monkeypatch):
    """★ `harness.budget` 은 `run()` 마다 리셋된다 — 세션 상한이 없으면 예산이 무한이 된다."""
    monkeypatch.setenv("SA_SERVE_MAX_ASKS", "2")
    h = _FakeHarness([(1, "a", "end_turn"), (1, "b", "end_turn")])
    msgs = _run_serve(h, [json.dumps({"ask": f"q{i}"}) + "\n" for i in range(3)]
                      + [json.dumps({"close": True}) + "\n"], monkeypatch)
    refused = [m for m in msgs if m.get("limit") == "asks"]
    assert refused, "질문 상한이 안 걸렸다"
    assert refused[0]["ok"] is False


def test_total_turn_budget_is_enforced(monkeypatch):
    monkeypatch.setenv("SA_SERVE_MAX_TURNS_TOTAL", "3")
    h = _FakeHarness([(5, "a", "end_turn"), (1, "b", "end_turn")])
    msgs = _run_serve(h, [json.dumps({"ask": "q1"}) + "\n",
                          json.dumps({"ask": "q2"}) + "\n",
                          json.dumps({"close": True}) + "\n"], monkeypatch)
    refused = [m for m in msgs if m.get("limit") == "turns"]
    assert refused, "세션 턴 상한이 안 걸렸다"


def test_max_turns_is_reported_so_the_parent_can_continue(monkeypatch):
    """캡에 걸린 건 **잘린 답**이다. 부모가 알아야 '계속해' 를 보낼 수 있다."""
    h = _FakeHarness([(8, "여기까지", "max_turns")])
    msgs = _run_serve(h, [json.dumps({"ask": "q"}) + "\n",
                          json.dumps({"close": True}) + "\n"], monkeypatch)
    assert msgs[1]["reason"] == "max_turns"


def test_stdout_is_the_channel_only(monkeypatch):
    """stdout 에 사람이 읽는 로그가 섞이면 부모의 JSON 파싱이 깨진다."""
    h = _FakeHarness([(1, "답", "end_turn")])
    monkeypatch.setattr(sys, "stdin", io.StringIO(
        json.dumps({"ask": "q"}) + "\n" + json.dumps({"close": True}) + "\n"))
    out, err = io.StringIO(), io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "stderr", err)
    asyncio.run(cli._serve_loop(h, [], "sys", set(), {"task_id": "t"}, "tt"))
    for line in out.getvalue().splitlines():
        if line.strip():
            json.loads(line)      # 전 줄이 JSON 이어야 한다
    assert "serve ask#" in err.getvalue(), "사람용 로그는 stderr 로 가야 한다"


@pytest.mark.parametrize("env,default,expect", [
    ("SA_SERVE_MAX_ASKS", 40, 40), ("SA_SERVE_MAX_TURNS_TOTAL", 120, 120),
])
def test_limits_fall_back_on_garbage(env, default, expect, monkeypatch):
    monkeypatch.setenv(env, "쓰레기")
    assert cli._serve_limit(env, default) == expect


def test_per_ask_budget_replaces_the_task_budget(monkeypatch):
    """★ 단발 예산과 질문당 예산은 **의미가 다르다**.

    단발 `<DOMAIN>_MAX_TURNS` 는 작업 하나를 끝내는 예산(smb 기본 80)이고, 세션에서는
    질문 하나에 답하는 예산이다. 같은 값을 쓰면 둘 중 하나가 망가진다 — 2026-08-21
    실기동에서 게이트가 8 로 맞췄더니 **단발 위임이 max_turns 로 죽었다**(결과 0).
    """
    monkeypatch.setenv("SA_SERVE_MAX_TURNS_PER_ASK", "5")
    h = _FakeHarness([(1, "답", "end_turn")])
    assert h.budget.max_turns == 80
    _run_serve(h, [json.dumps({"ask": "q"}) + "\n",
                   json.dumps({"close": True}) + "\n"], monkeypatch)
    assert h.budget.max_turns == 5, "세션이 계약 예산을 질문당 예산으로 안 바꿨다"


# ── v3.99: serve 전용 종료 도구 ───────────────────────────────────────
#
# 배경(실측 2026-08-22): 리드 게이트 4런에서 질문 22건 중 17건(77%)이 빈 답이었다.
# 워커가 `report_inspection` 으로 보고하고 산문 없이 끝내서, serve 가 답으로 읽는
# `text` 가 비었다. serve 에서만 그 도구를 종료 도구로 올려 pass 를 끝내게 한다.

class _Registry:
    def __init__(self, names: set[str]) -> None:
        self._names = set(names)

    def get(self, name: str):  # noqa: ANN201
        return object() if name in self._names else None


def test_serve_arms_the_answer_tool_as_terminal(monkeypatch):
    h = _FakeHarness([(1, "a", "end_turn")])
    h.registry = _Registry({"report_inspection", "smb_submit_finding"})
    h.context.metadata["terminal_tools"] = {"smb_submit_finding"}
    _run_serve(h, ['{"close": true}\n'], monkeypatch)
    assert h.context.metadata["terminal_tools"] == {
        "smb_submit_finding", "report_inspection"}


def test_arming_keeps_the_contract_terminals(monkeypatch):
    """계약의 원래 종료 도구를 **교체하지 않는다** — 더할 뿐이다."""
    h = _FakeHarness([])
    h.registry = _Registry({"report_inspection", "submit_verdict"})
    h.context.metadata["terminal_tools"] = {"submit_verdict"}
    added = cli._arm_serve_answer_tools(h)
    assert added == ["report_inspection"]
    assert "submit_verdict" in h.context.metadata["terminal_tools"]


def test_unregistered_answer_tool_is_not_armed():
    """광고할 수 없는 종료 도구를 요구하면 이행 불가능한 계약이 된다."""
    h = _FakeHarness([])
    h.registry = _Registry({"smb_submit_finding"})   # report_inspection 없음
    h.context.metadata["terminal_tools"] = {"smb_submit_finding"}
    assert cli._arm_serve_answer_tools(h) == []
    assert h.context.metadata["terminal_tools"] == {"smb_submit_finding"}


def test_arming_is_idempotent():
    h = _FakeHarness([])
    h.registry = _Registry({"report_inspection"})
    h.context.metadata["terminal_tools"] = {"report_inspection"}
    assert cli._arm_serve_answer_tools(h) == []


def test_one_shot_path_never_arms_the_answer_tool():
    """★ Phase 1 동등성 — 단발 검토원은 오늘과 같은 종료 계약으로 돈다.

    구조로 고정한다: `_arm_serve_answer_tools` 호출부가 `_serve_loop` 안에만 있다.
    """
    import ast
    import inspect

    src = inspect.getsource(cli)
    tree = ast.parse(src)
    callers: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for sub in ast.walk(node):
            if (isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name)
                    and sub.func.id == "_arm_serve_answer_tools"):
                callers.add(node.name)
    assert callers == {"_serve_loop"}, callers


def test_saw_submit_is_not_flipped_by_the_answer_tool(monkeypatch):
    """★ 엔진을 멈추는 집합과 **제출을 세는 집합**은 다른 것이다.

    `saw_submit` 은 세션 종료 때 on_submit/on_no_submit 을 고르고, smb 검토원은 그
    분기로 큐 권고 상태를 정한다. 리포트를 썼다고 "제출했다" 가 되면 안 된다.
    """
    from secu_agent.agent.events import ToolCallCompleted
    from secu_agent.agent.tools.base import ToolSuccess

    class _H(_FakeHarness):
        def run(self, *, initial_messages, system=None):  # noqa: ANN001
            async def _gen():
                yield TurnStarted(turn=1)
                yield ToolCallCompleted(
                    tool_use_id="x", name="report_inspection",
                    result=ToolSuccess(content="{}"))
                yield LoopCompleted(
                    reason="end_turn", total_turns=1,
                    final_message=AssistantMessage(content=[TextBlock(text="")]),
                    usage=_Usage())
            return _gen()

    h = _H([])
    h.registry = _Registry({"report_inspection", "smb_submit_finding"})
    h.context.metadata["terminal_tools"] = {"smb_submit_finding"}
    # 부기 집합은 계약 그대로 — report_inspection 이 없다.
    out = asyncio.run(cli._drive_once(h, [], "sys", {"smb_submit_finding"}))
    assert out.saw_submit is False
    assert out.submit_count == 0
