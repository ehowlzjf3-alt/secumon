"""P1: prefix-cache telemetry.

StreamUsage gains cache_read/cache_creation fields (default 0); token_usage
persists them; token_usage_summary sums them + derives cache_hit_pct. This is the
measurement layer that validates the prefix-stability work — shared by all
compaction designs (A/B/C).
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

from secu_agent import state
from secu_agent.agent.llm.types import LLMRequest, StreamMessageStop, StreamUsage


def test_stream_usage_cache_fields_default_zero():
    u = StreamUsage(input_tokens=10, output_tokens=2)
    assert u.cache_read_input_tokens == 0
    assert u.cache_creation_input_tokens == 0


def test_stream_usage_cache_fields_settable():
    u = StreamUsage(
        input_tokens=100, output_tokens=5,
        cache_read_input_tokens=80, cache_creation_input_tokens=20,
    )
    assert u.cache_read_input_tokens == 80
    assert u.cache_creation_input_tokens == 20


def test_token_usage_record_and_summary_cache(tmp_db):
    sid = state.chat_session_new(agent_type="operator")
    state.token_usage_record(
        session_id=sid, turn_seq=1,
        system_chars=100, tools_chars=200, history_chars=50,
        input_tokens=100, output_tokens=3,
        cache_read_input_tokens=80, cache_creation_input_tokens=20,
    )
    state.token_usage_record(
        session_id=sid, turn_seq=2,
        system_chars=100, tools_chars=200, history_chars=150,
        input_tokens=200, output_tokens=4,
        cache_read_input_tokens=180, cache_creation_input_tokens=20,
    )
    s = state.token_usage_summary(sid)
    assert s["cache_read_input_tokens"] == 260
    assert s["cache_creation_input_tokens"] == 40
    # cache_hit_pct = cache_read / input * 100 = 260 / 300 * 100
    assert round(s["cache_hit_pct"], 2) == round(260 / 300 * 100, 2)


def test_token_usage_record_cache_defaults_zero(tmp_db):
    sid = state.chat_session_new(agent_type="operator")
    state.token_usage_record(
        session_id=sid, turn_seq=1,
        system_chars=10, tools_chars=10, history_chars=10,
        input_tokens=5, output_tokens=5,
    )
    s = state.token_usage_summary(sid)
    assert s["cache_read_input_tokens"] == 0
    assert s["cache_creation_input_tokens"] == 0
    assert s["cache_hit_pct"] == 0.0


def test_token_usage_summary_empty_cache_hit_zero(tmp_db):
    sid = state.chat_session_new(agent_type="operator")
    s = state.token_usage_summary(sid)
    assert s["cache_hit_pct"] == 0.0


# ---------------------------------------------------------------------------
# client-side: OpenAI 호환 provider 는 cache-write(creation) 수치를 보고하지
# 않으므로 (input - cached) 를 creation 으로 합성하면 안 된다 (관측 왜곡).
# cached_tokens 는 read 로만 싣고 creation 은 0 이어야 한다.
# ---------------------------------------------------------------------------

def test_codex_usage_from_does_not_synthesize_cache_creation():
    from secu_agent.agent.llm.codex_responses_client import _usage_from

    final = SimpleNamespace(usage=SimpleNamespace(
        input_tokens=100, output_tokens=4,
        input_tokens_details=SimpleNamespace(cached_tokens=80),
    ))
    u = _usage_from(final)
    assert u.input_tokens == 100
    assert u.cache_read_input_tokens == 80
    # (100 - 80)=20 을 creation 으로 라벨하지 않는다.
    assert u.cache_creation_input_tokens == 0


def _gateway_client(tmp_path: Path):
    from secu_agent.agent.llm.internal_gateway import OpenAICompatClient
    from secu_agent.agent.llm.profile import load_profiles

    p = tmp_path / "p.yaml"
    p.write_text(
        "profiles:\n  g:\n    base_url: http://x/v1\n    model: m\n",
        encoding="utf-8",
    )
    return OpenAICompatClient(load_profiles(p)["g"])


def test_gateway_stream_does_not_synthesize_cache_creation(tmp_path: Path):
    client = _gateway_client(tmp_path)

    usage_chunk = SimpleNamespace(
        usage=SimpleNamespace(
            prompt_tokens=100, completion_tokens=4,
            prompt_tokens_details=SimpleNamespace(cached_tokens=80),
        ),
        choices=[],
    )
    finish_chunk = SimpleNamespace(
        usage=None,
        choices=[SimpleNamespace(
            delta=SimpleNamespace(content=None, tool_calls=None),
            finish_reason="stop",
        )],
    )

    class _FakeStream:
        def __aiter__(self):
            async def _gen():
                for ch in (usage_chunk, finish_chunk):
                    yield ch
            return _gen()

    async def _fake_create(**_kw):
        return _FakeStream()

    client._client.chat.completions.create = _fake_create  # type: ignore[attr-defined]

    async def _go():
        out = []
        async for ev in client.stream(LLMRequest(messages=[], max_tokens=64)):
            out.append(ev)
        await client.aclose()
        return out

    events = asyncio.run(_go())
    stop = [e for e in events if isinstance(e, StreamMessageStop)][0]
    assert stop.usage is not None
    assert stop.usage.input_tokens == 100
    assert stop.usage.cache_read_input_tokens == 80
    assert stop.usage.cache_creation_input_tokens == 0
