"""v3.56: Codex Responses API client — kwargs 빌드 + 메시지/도구 변환 + 스트림 매핑.

fake responses.stream 으로 실제 네트워크/토큰 없이 검증.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from secu_agent.agent.llm import codex_responses_client as crc
from secu_agent.agent.llm.codex_auth import CodexAuthError
from secu_agent.agent.llm.codex_responses_client import CodexResponsesClient
from secu_agent.agent.llm.messages import (
    AssistantMessage,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from secu_agent.agent.llm.profile import AuthConfig, LLMProfile
from secu_agent.agent.llm.types import (
    LLMRequest,
    StreamMessageStop,
    StreamReasoningDelta,
    StreamTextDelta,
    StreamToolUseDelta,
    StreamToolUseStart,
    StreamToolUseStop,
    ToolSpec,
)


def _profile(**kw) -> LLMProfile:
    base = dict(
        name="codex", base_url="https://chatgpt.com/backend-api/codex",
        model="gpt-5.5", transport="codex_responses", reasoning_effort="xhigh",
        auth=AuthConfig(mode="oauth_codex"),
    )
    base.update(kw)
    return LLMProfile(**base)


def _client(**kw) -> CodexResponsesClient:
    return CodexResponsesClient(_profile(**kw))


# ---- kwargs build -------------------------------------------------------

def test_kwargs_no_max_tokens_no_temperature() -> None:
    c = _client()
    kw = c._build_kwargs(LLMRequest(messages=[], system="sys", max_tokens=9999,
                                    temperature=0.7))
    assert "max_output_tokens" not in kw
    assert "max_tokens" not in kw
    assert "temperature" not in kw
    assert kw["store"] is False
    # v3.63 preamble 이 prepend 됨 — system 텍스트가 포함되는지만 확인.
    assert "sys" in kw["instructions"]


def test_kwargs_service_tier_default_priority(monkeypatch) -> None:
    # v3.65: Codex Fast 기본 ON (priority)
    monkeypatch.delenv("SA_CODEX_SERVICE_TIER", raising=False)
    kw = _client()._build_kwargs(LLMRequest(messages=[]))
    assert kw["service_tier"] == "priority"


def test_kwargs_service_tier_profile_override(monkeypatch) -> None:
    monkeypatch.delenv("SA_CODEX_SERVICE_TIER", raising=False)
    kw = _client(service_tier="default")._build_kwargs(LLMRequest(messages=[]))
    assert kw["service_tier"] == "default"


def test_kwargs_service_tier_request_override(monkeypatch) -> None:
    monkeypatch.delenv("SA_CODEX_SERVICE_TIER", raising=False)
    kw = _client()._build_kwargs(
        LLMRequest(messages=[], vendor_params={"service_tier": "flex"})
    )
    assert kw["service_tier"] == "flex"


def test_kwargs_service_tier_env_override(monkeypatch) -> None:
    monkeypatch.setenv("SA_CODEX_SERVICE_TIER", "default")
    kw = _client(service_tier="priority")._build_kwargs(LLMRequest(messages=[]))
    assert kw["service_tier"] == "default"   # env 가 profile 이김


def test_kwargs_service_tier_disable_omits(monkeypatch) -> None:
    monkeypatch.setenv("SA_CODEX_SERVICE_TIER", "off")
    kw = _client()._build_kwargs(LLMRequest(messages=[]))
    assert "service_tier" not in kw


def test_kwargs_service_tier_invalid_omits(monkeypatch) -> None:
    monkeypatch.delenv("SA_CODEX_SERVICE_TIER", raising=False)
    kw = _client(service_tier="turbo")._build_kwargs(LLMRequest(messages=[]))
    assert "service_tier" not in kw


def test_kwargs_reasoning_from_profile_xhigh() -> None:
    kw = _client()._build_kwargs(LLMRequest(messages=[]))
    assert kw["reasoning"] == {"effort": "xhigh", "summary": "auto"}
    assert kw["include"] == ["reasoning.encrypted_content"]


def test_kwargs_reasoning_request_override() -> None:
    kw = _client()._build_kwargs(
        LLMRequest(messages=[], vendor_params={"reasoning_effort": "medium"})
    )
    assert kw["reasoning"]["effort"] == "medium"


def test_kwargs_response_format_json_object_to_text() -> None:
    kw = _client()._build_kwargs(
        LLMRequest(messages=[], vendor_params={"response_format": {"type": "json_object"}})
    )
    assert kw["text"] == {"format": {"type": "json_object"}}


def test_kwargs_response_format_json_schema() -> None:
    rf = {"type": "json_schema",
          "json_schema": {"name": "verdict", "schema": {"type": "object"}, "strict": True}}
    kw = _client()._build_kwargs(LLMRequest(messages=[], vendor_params={"response_format": rf}))
    assert kw["text"]["format"]["type"] == "json_schema"
    assert kw["text"]["format"]["name"] == "verdict"
    assert kw["text"]["format"]["schema"] == {"type": "object"}


# ---- message / tool conversion -----------------------------------------

def test_input_conversion_user_assistant_tool() -> None:
    msgs = [
        UserMessage(content=[TextBlock(text="안녕")]),
        AssistantMessage(content=[
            TextBlock(text="네"),
            ToolUseBlock(id="call_7", name="grep", input={"q": "pw"}),
        ]),
        UserMessage(content=[ToolResultBlock(tool_use_id="call_7", content="hit")]),
    ]
    items = crc._to_responses_input(msgs)
    assert items[0] == {"role": "user", "content": [{"type": "input_text", "text": "안녕"}]}
    assert items[1] == {"role": "assistant", "content": [{"type": "output_text", "text": "네"}]}
    assert items[2] == {"type": "function_call", "call_id": "call_7", "name": "grep",
                        "arguments": '{"q": "pw"}'}
    assert items[3] == {"type": "function_call_output", "call_id": "call_7", "output": "hit"}


def test_input_system_message_becomes_user_note() -> None:
    items = crc._to_responses_input([SystemMessage(text="조심")])
    assert items[0]["role"] == "user"
    assert "[SYSTEM NOTE]" in items[0]["content"][0]["text"]


# ============================================================
# v3.68: function_call ↔ function_call_output 짝 복구 (400 무한반복 방지)
#   압축/취소(ESC)/유실로 짝이 깨지면 Responses API 가
#   "No tool output found for function call ..." 400 → 루프. 방어 복구.
# ============================================================

def test_input_dangling_tool_use_gets_synthetic_output() -> None:
    # tool_use 는 있는데 그 결과(tool_result)가 없는 경우 (압축이 잘라먹음 / ESC).
    msgs = [
        AssistantMessage(content=[
            ToolUseBlock(id="call_X", name="grep", input={"q": "pw"}),
        ]),
        UserMessage(content=[TextBlock(text="계속")]),  # 결과 대신 다른 user 메시지
    ]
    items = crc._to_responses_input(msgs)
    calls = [it for it in items if it.get("type") == "function_call"]
    outs = [it for it in items if it.get("type") == "function_call_output"]
    assert len(calls) == 1 and calls[0]["call_id"] == "call_X"
    # 짝 output 이 합성되어 있어야 한다 (없으면 400).
    assert any(o["call_id"] == "call_X" for o in outs)
    # 그리고 call 다음에 와야 한다 (API 순서 요구).
    call_idx = items.index(calls[0])
    out_idx = next(i for i, it in enumerate(items)
                   if it.get("type") == "function_call_output" and it["call_id"] == "call_X")
    assert out_idx > call_idx


def test_input_orphan_tool_result_dropped() -> None:
    # 선행 tool_use 없는 tool_result (압축이 assistant 만 잘라먹음) → function_call_output 제거.
    msgs = [
        UserMessage(content=[ToolResultBlock(tool_use_id="call_GONE", content="r")]),
    ]
    items = crc._to_responses_input(msgs)
    assert not any(it.get("type") == "function_call_output" for it in items)


def test_input_wellformed_pair_unchanged() -> None:
    # 정상 짝은 그대로 (복구가 멀쩡한 흐름 안 건드림).
    msgs = [
        AssistantMessage(content=[ToolUseBlock(id="c1", name="x", input={})]),
        UserMessage(content=[ToolResultBlock(tool_use_id="c1", content="ok")]),
    ]
    items = crc._to_responses_input(msgs)
    calls = [it for it in items if it.get("type") == "function_call"]
    outs = [it for it in items if it.get("type") == "function_call_output"]
    assert len(calls) == 1 and len(outs) == 1
    assert outs[0]["output"] == "ok"  # 합성 stub 아님 — 실제 결과 보존


def test_tools_flat_schema() -> None:
    tools = [ToolSpec(name="grep", description="검색",
                      input_schema={"type": "object", "properties": {"q": {}}})]
    out = crc._to_responses_tools(tools)
    assert out == [{
        "type": "function", "name": "grep", "description": "검색", "strict": False,
        "parameters": {"type": "object", "properties": {"q": {}}},
    }]


# ---- stream mapping -----------------------------------------------------

def _ev(etype: str, **kw) -> SimpleNamespace:
    return SimpleNamespace(type=etype, **kw)


class _FakeEventStream:
    """create(stream=True) 가 돌려주는 raw 이벤트 async 이터레이터 흉내."""

    def __init__(self, events: list[Any]) -> None:
        self._events = events

    def __aiter__(self):
        async def _gen():
            for e in self._events:
                yield e
        return _gen()


def _wire_fake(client: CodexResponsesClient, events: list[Any], final: Any) -> dict:
    """events 끝에 response.completed(.response=final) 를 자동 부착."""
    captured: dict[str, Any] = {}
    status = getattr(final, "status", "completed") if final is not None else "completed"
    et = {"completed": "response.completed", "incomplete": "response.incomplete",
          "failed": "response.failed"}.get(status, "response.completed")
    full = list(events) + [SimpleNamespace(type=et, response=final)]

    class _Responses:
        async def create(self, **kw):
            captured["kwargs"] = kw
            return _FakeEventStream(full)

    fake_client = SimpleNamespace(responses=_Responses())
    client._build_client = lambda: fake_client  # type: ignore[method-assign]
    return captured


def _run(client: CodexResponsesClient, req: LLMRequest) -> list[Any]:
    async def _go() -> list[Any]:
        out = []
        async for ev in client.stream(req):
            out.append(ev)
        await client.aclose()
        return out

    return asyncio.run(_go())


def test_stream_text_usage_endturn() -> None:
    c = _client()
    final = SimpleNamespace(
        output=[SimpleNamespace(type="message", content=[
            SimpleNamespace(type="output_text", text="full")])],
        status="completed",
        usage=SimpleNamespace(input_tokens=12, output_tokens=4),
    )
    events = [_ev("response.output_text.delta", delta="he"),
              _ev("response.output_text.delta", delta="llo")]
    _wire_fake(c, events, final)
    out = _run(c, LLMRequest(messages=[], system="s"))
    texts = [e.text for e in out if isinstance(e, StreamTextDelta)]
    assert texts == ["he", "llo"]  # 델타 받았으니 backfill 안 함
    stop = [e for e in out if isinstance(e, StreamMessageStop)][0]
    assert stop.stop_reason == "end_turn"
    assert stop.usage.input_tokens == 12 and stop.usage.output_tokens == 4


def test_stream_reasoning_delta_mapped() -> None:
    c = _client()
    final = SimpleNamespace(output=[], status="completed", usage=None)
    events = [_ev("response.reasoning_summary_text.delta", delta="생각중")]
    _wire_fake(c, events, final)
    out = _run(c, LLMRequest(messages=[]))
    assert any(isinstance(e, StreamReasoningDelta) and e.text == "생각중" for e in out)


def test_stream_tool_call_emits_start_delta_stop() -> None:
    c = _client()
    fc = SimpleNamespace(type="function_call", call_id="call_9", name="grep",
                         arguments='{"q":"x"}')
    final = SimpleNamespace(output=[fc], status="completed", usage=None)
    _wire_fake(c, [], final)
    out = _run(c, LLMRequest(messages=[]))
    starts = [e for e in out if isinstance(e, StreamToolUseStart)]
    deltas = [e for e in out if isinstance(e, StreamToolUseDelta)]
    stops = [e for e in out if isinstance(e, StreamToolUseStop)]
    assert starts[0].tool_use_id == "call_9" and starts[0].name == "grep"
    assert deltas[0].input_json_delta == '{"q":"x"}'
    assert stops[0].tool_use_id == "call_9"
    stop = [e for e in out if isinstance(e, StreamMessageStop)][0]
    assert stop.stop_reason == "tool_use"


def test_stream_backfill_text_when_no_deltas() -> None:
    # chatgpt.com backend: 텍스트 델타 없이 final message 만 → backfill.
    c = _client()
    msg = SimpleNamespace(type="message", content=[
        SimpleNamespace(type="output_text", text="backfilled")])
    final = SimpleNamespace(output=[msg], status="completed", usage=None)
    _wire_fake(c, [], final)
    out = _run(c, LLMRequest(messages=[]))
    texts = [e.text for e in out if isinstance(e, StreamTextDelta)]
    assert texts == ["backfilled"]


def test_stream_uses_collected_items_when_final_empty() -> None:
    # final.output 비었지만 output_item.done 으로 흘러온 tool call 을 backfill.
    c = _client()
    fc = SimpleNamespace(type="function_call", call_id="c1", name="ls", arguments="{}")
    final = SimpleNamespace(output=[], status="completed", usage=None)
    events = [_ev("response.output_item.done", item=fc)]
    _wire_fake(c, events, final)
    out = _run(c, LLMRequest(messages=[]))
    assert any(isinstance(e, StreamToolUseStart) and e.tool_use_id == "c1" for e in out)


def test_stream_incomplete_max_tokens() -> None:
    c = _client()
    final = SimpleNamespace(
        output=[SimpleNamespace(type="message", content=[
            SimpleNamespace(type="output_text", text="cut")])],
        status="incomplete",
        incomplete_details=SimpleNamespace(reason="max_output_tokens"),
        usage=None,
    )
    _wire_fake(c, [], final)
    out = _run(c, LLMRequest(messages=[]))
    stop = [e for e in out if isinstance(e, StreamMessageStop)][0]
    assert stop.stop_reason == "max_tokens"


def test_stream_auth_error_surfaces_as_stream_error() -> None:
    c = _client()

    def _boom():
        raise CodexAuthError("재로그인", relogin_required=True)

    c._build_client = _boom  # type: ignore[method-assign]
    out = _run(c, LLMRequest(messages=[]))
    from secu_agent.agent.llm.types import StreamError
    errs = [e for e in out if isinstance(e, StreamError)]
    assert errs and errs[0].kind == "auth"


def test_cloudflare_headers_include_account_id() -> None:
    # 합성 JWT (payload = {"https://api.openai.com/auth":{"chatgpt_account_id":"acct-7"}})
    import base64
    import json
    claims = {"https://api.openai.com/auth": {"chatgpt_account_id": "acct-7"}}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    tok = f"h.{payload}.s"
    headers = _client()._cloudflare_headers(tok)
    assert headers["originator"] == "codex_cli_rs"
    assert headers["ChatGPT-Account-ID"] == "acct-7"


# ============================================================
# de-domain v3.84 #1: instructions preamble 은 등록형 훅 — 코어는 도메인-프리라
# 아무것도 등록하지 않고, plugin 이 register_instruction_preamble 로 공급한다.
# ============================================================
from secu_agent.agent.llm.instruction_preamble import (  # noqa: E402
    register_instruction_preamble,
    unregister_all_instruction_preambles,
)

_FAKE_PREAMBLE = "AUTHORIZED-TEST-PREAMBLE first line.\nsecond line of preamble."


@pytest.fixture
def _registered_preamble():
    unregister_all_instruction_preambles()
    register_instruction_preamble(lambda: _FAKE_PREAMBLE)
    try:
        yield
    finally:
        unregister_all_instruction_preambles()


def test_core_only_injects_no_preamble():
    """등록된 preamble 이 없으면(코어 단독) instructions 는 system 그대로 — 도메인-프리."""
    unregister_all_instruction_preambles()
    assert crc._apply_instruction_preamble("operator sys") == "operator sys"
    assert crc._apply_instruction_preamble("") == ""
    kw = _client()._build_kwargs(LLMRequest(messages=[], system="agent sys"))
    assert kw["instructions"] == "agent sys"


def test_preamble_prepended_when_registered(_registered_preamble):
    out = crc._apply_instruction_preamble("operator system instructions")
    assert out.startswith(_FAKE_PREAMBLE)
    assert "operator system instructions" in out


def test_preamble_empty_system_just_preamble(_registered_preamble):
    assert crc._apply_instruction_preamble("") == _FAKE_PREAMBLE


def test_preamble_double_prepend_prevented(_registered_preamble):
    once = crc._apply_instruction_preamble("orig sys")
    twice = crc._apply_instruction_preamble(once)
    assert twice == once


def test_build_kwargs_uses_registered_preamble(_registered_preamble):
    kw = _client()._build_kwargs(LLMRequest(messages=[], system="agent sys"))
    assert kw["instructions"].startswith(_FAKE_PREAMBLE)
    assert "agent sys" in kw["instructions"]
