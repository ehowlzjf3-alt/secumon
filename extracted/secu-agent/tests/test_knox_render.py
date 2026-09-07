"""KnoxTurnRenderer — LoopEvent 스트림을 Knox 채팅 메시지로 변환."""
from __future__ import annotations

from secu_agent.agent.events import (
    LoopError,
    ReasoningChunk,
    TextChunk,
    ToolCallStarted,
)
from secu_agent.knox.render import KnoxTurnRenderer


def test_text_chunks_accumulate_into_one_final_message():
    r = KnoxTurnRenderer()
    assert r.on_event(TextChunk(text="안녕")) == []
    assert r.on_event(TextChunk(text="하세요")) == []
    assert r.finalize() == ["안녕하세요"]


def test_reasoning_is_suppressed():
    r = KnoxTurnRenderer()
    assert r.on_event(ReasoningChunk(text="thinking...")) == []
    assert r.finalize() == []


def test_loop_error_is_emitted():
    r = KnoxTurnRenderer()
    out = r.on_event(LoopError(message="boom"))
    assert len(out) == 1
    assert "boom" in out[0]
    assert "⚠" in out[0]


def test_finding_card_from_submit_finding():
    r = KnoxTurnRenderer()
    ev = ToolCallStarted(
        tool_use_id="t1",
        name="submit_finding",
        input={"finding": {
            "severity": "high",
            "summary": "노출된 AWS 키 발견",
            "target": "10.0.0.5/share",
            "hits": [{"kind": "aws_key"}, {"kind": "aws_key"}],
        }},
    )
    out = r.on_event(ev)
    assert len(out) == 1
    card = out[0]
    assert "🚨" in card
    assert "high" in card.lower()
    assert "노출된 AWS 키" in card
    assert "10.0.0.5/share" in card
    assert "2" in card  # hits 건수


def test_nonfinding_tool_suppressed_by_default():
    r = KnoxTurnRenderer()
    ev = ToolCallStarted(tool_use_id="t2", name="python_exec", input={"code": "x"})
    assert r.on_event(ev) == []


def test_nonfinding_tool_shown_in_verbose():
    r = KnoxTurnRenderer(verbose=True)
    ev = ToolCallStarted(tool_use_id="t3", name="smb_walk", input={})
    out = r.on_event(ev)
    assert len(out) == 1
    assert "smb_walk" in out[0]


def test_finalize_empty_returns_nothing():
    r = KnoxTurnRenderer()
    assert r.finalize() == []
