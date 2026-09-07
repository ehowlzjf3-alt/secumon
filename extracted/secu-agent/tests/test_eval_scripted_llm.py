"""v3.16-A: ScriptedLLMClient — deterministic LLMClient for eval harness.

호출마다 미리 정의된 ScriptedTurn 을 stream 으로 재생.
도구 시퀀스 회귀 검증 / 시나리오 dataset 구동의 토대.
"""
from __future__ import annotations

import asyncio

import pytest

from secu_agent.agent.llm.types import (
    LLMRequest,
    StreamMessageStop,
    StreamReasoningDelta,
    StreamTextDelta,
    StreamToolUseDelta,
    StreamToolUseStart,
    StreamToolUseStop,
)


async def _collect(stream) -> list:
    out = []
    async for ev in stream:
        out.append(ev)
    return out


def _drain(client, req):
    return asyncio.run(_collect(client.stream(req)))


def _empty_req() -> LLMRequest:
    return LLMRequest(messages=[], system=None)


# ─── basic shape ────────────────────────────────────────────────


def test_scripted_client_implements_llmclient_interface():
    from secu_agent.agent.eval.scripted_llm import ScriptedLLMClient
    from secu_agent.agent.llm.base import LLMClient

    c = ScriptedLLMClient(turns=[])
    assert isinstance(c, LLMClient)
    assert isinstance(c.name, str) and c.name


# ─── text-only turn ─────────────────────────────────────────────


def test_text_only_turn_yields_text_delta_then_end_turn():
    from secu_agent.agent.eval.scripted_llm import (
        ScriptedLLMClient,
        ScriptedTurn,
    )

    client = ScriptedLLMClient(turns=[ScriptedTurn(text="안녕하세요.")])
    events = _drain(client, _empty_req())

    texts = [e for e in events if isinstance(e, StreamTextDelta)]
    stops = [e for e in events if isinstance(e, StreamMessageStop)]

    assert "".join(t.text for t in texts) == "안녕하세요."
    assert len(stops) == 1
    assert stops[0].stop_reason == "end_turn"


def test_text_can_be_split_across_multiple_chunks():
    from secu_agent.agent.eval.scripted_llm import (
        ScriptedLLMClient,
        ScriptedTurn,
    )

    # 청크 분할은 implementation detail — 어쨌든 join 한 결과가 동일하면 OK.
    client = ScriptedLLMClient(turns=[ScriptedTurn(text="hello world")])
    events = _drain(client, _empty_req())
    text = "".join(e.text for e in events if isinstance(e, StreamTextDelta))
    assert text == "hello world"


# ─── tool-use turn ──────────────────────────────────────────────


def test_tool_call_turn_yields_tool_use_blocks_and_tool_use_stop():
    from secu_agent.agent.eval.scripted_llm import (
        ScriptedLLMClient,
        ScriptedToolCall,
        ScriptedTurn,
    )

    client = ScriptedLLMClient(turns=[
        ScriptedTurn(
            tool_calls=[
                ScriptedToolCall(name="list_pending_shares", input={"limit": 5}),
            ],
        ),
    ])
    events = _drain(client, _empty_req())

    starts = [e for e in events if isinstance(e, StreamToolUseStart)]
    deltas = [e for e in events if isinstance(e, StreamToolUseDelta)]
    stops_tu = [e for e in events if isinstance(e, StreamToolUseStop)]
    msg_stop = [e for e in events if isinstance(e, StreamMessageStop)]

    assert len(starts) == 1
    assert starts[0].name == "list_pending_shares"
    assert starts[0].tool_use_id  # 자동 생성된 id
    # 전체 input_json_delta concat 결과가 valid JSON.
    import json as _json
    payload = "".join(d.input_json_delta for d in deltas if d.tool_use_id == starts[0].tool_use_id)
    assert _json.loads(payload) == {"limit": 5}
    assert len(stops_tu) == 1 and stops_tu[0].tool_use_id == starts[0].tool_use_id
    assert len(msg_stop) == 1 and msg_stop[0].stop_reason == "tool_use"


def test_multiple_tool_calls_in_one_turn():
    from secu_agent.agent.eval.scripted_llm import (
        ScriptedLLMClient,
        ScriptedToolCall,
        ScriptedTurn,
    )

    client = ScriptedLLMClient(turns=[
        ScriptedTurn(tool_calls=[
            ScriptedToolCall(name="a", input={}),
            ScriptedToolCall(name="b", input={"x": 1}),
        ]),
    ])
    events = _drain(client, _empty_req())
    starts = [e for e in events if isinstance(e, StreamToolUseStart)]
    assert [s.name for s in starts] == ["a", "b"]
    # id 가 서로 달라야 함
    assert starts[0].tool_use_id != starts[1].tool_use_id


# ─── multi-turn replay ──────────────────────────────────────────


def test_consecutive_calls_replay_in_order():
    from secu_agent.agent.eval.scripted_llm import (
        ScriptedLLMClient,
        ScriptedToolCall,
        ScriptedTurn,
    )

    client = ScriptedLLMClient(turns=[
        ScriptedTurn(tool_calls=[ScriptedToolCall(name="t1", input={})]),
        ScriptedTurn(text="결과 확인했어요."),
    ])

    ev1 = _drain(client, _empty_req())
    ev2 = _drain(client, _empty_req())

    starts = [e for e in ev1 if isinstance(e, StreamToolUseStart)]
    assert [s.name for s in starts] == ["t1"]
    text = "".join(e.text for e in ev2 if isinstance(e, StreamTextDelta))
    assert text == "결과 확인했어요."


def test_call_after_script_exhausted_raises():
    from secu_agent.agent.eval.scripted_llm import (
        ScriptedLLMClient,
        ScriptedTurn,
    )

    client = ScriptedLLMClient(turns=[ScriptedTurn(text="one")])
    _ = _drain(client, _empty_req())  # turn 1 소진

    with pytest.raises(RuntimeError, match="script exhausted|out of turns"):
        _drain(client, _empty_req())


# ─── reasoning delta (옵션) ────────────────────────────────────


def test_reasoning_delta_buried_separately():
    from secu_agent.agent.eval.scripted_llm import (
        ScriptedLLMClient,
        ScriptedTurn,
    )

    client = ScriptedLLMClient(turns=[
        ScriptedTurn(reasoning="사용자가 discovery 를 원함", text="실행할게요."),
    ])
    events = _drain(client, _empty_req())
    rs = [e for e in events if isinstance(e, StreamReasoningDelta)]
    ts = [e for e in events if isinstance(e, StreamTextDelta)]
    assert "".join(r.text for r in rs) == "사용자가 discovery 를 원함"
    assert "".join(t.text for t in ts) == "실행할게요."


# ─── usage 토큰 ────────────────────────────────────────────────


def test_message_stop_carries_usage_when_provided():
    from secu_agent.agent.eval.scripted_llm import (
        ScriptedLLMClient,
        ScriptedTurn,
    )

    client = ScriptedLLMClient(turns=[
        ScriptedTurn(text="x", input_tokens=10, output_tokens=3),
    ])
    events = _drain(client, _empty_req())
    stop = next(e for e in events if isinstance(e, StreamMessageStop))
    assert stop.usage is not None
    assert stop.usage.input_tokens == 10
    assert stop.usage.output_tokens == 3


# ─── error case ─────────────────────────────────────────────────


def test_empty_text_and_no_tool_calls_is_valid_end_turn():
    from secu_agent.agent.eval.scripted_llm import (
        ScriptedLLMClient,
        ScriptedTurn,
    )

    client = ScriptedLLMClient(turns=[ScriptedTurn()])
    events = _drain(client, _empty_req())
    stops = [e for e in events if isinstance(e, StreamMessageStop)]
    assert len(stops) == 1 and stops[0].stop_reason == "end_turn"
