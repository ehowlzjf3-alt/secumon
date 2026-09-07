"""텍스트 없는 tool_use assistant 메시지 보정 — 게이트웨이 500 회귀 가드.

실측 근거(2026-07-29): `gateway.security.samsungds.net` 은 이 모양에 HTTP 500 을 내고
(deepseek·gemma 100% 재현), 빈 문자열 TextBlock 하나면 통과한다. 이게 A/B 1~3 차에서
두 모델을 "성능 미달"로 보이게 한 원인이었다.
"""
from __future__ import annotations

import asyncio

import pytest

from secu_agent.agent.llm.messages import (
    AssistantMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from secu_agent.agent.llm.types import LLMRequest

from service.agents.gateway_compat import (
    GatewayCompatClient,
    needs_text,
    normalize_messages,
    normalize_request,
    wrap_gateway_compat,
)


def _tool_use(call_id: str = "call_1") -> ToolUseBlock:
    return ToolUseBlock(id=call_id, name="web_fetch", input={"url": "https://x/"})


# ── 판별 ───────────────────────────────────────────────────────────────────


def test_assistant_with_tool_use_but_no_text_needs_the_fix():
    assert needs_text(AssistantMessage(content=[_tool_use()]))


def test_assistant_with_text_alongside_tool_use_is_left_alone():
    assert not needs_text(AssistantMessage(content=[TextBlock(text="fetching"), _tool_use()]))


def test_assistant_without_any_tool_use_is_left_alone():
    """도구 호출이 없는 메시지는 애초에 이 게이트웨이 버그와 무관하다."""
    assert not needs_text(AssistantMessage(content=[TextBlock(text="done")]))
    assert not needs_text(AssistantMessage(content=[]))


def test_user_messages_are_never_touched():
    assert not needs_text(UserMessage(content=[ToolResultBlock(tool_use_id="c", content="ok")]))


# ── 보정 ───────────────────────────────────────────────────────────────────


def test_empty_text_block_is_prepended_before_the_tool_call():
    """대부분의 chat template 이 content 를 tool_calls 앞에 렌더한다."""
    fixed = normalize_messages([AssistantMessage(content=[_tool_use()])])

    blocks = fixed[0].content
    assert isinstance(blocks[0], TextBlock)
    assert blocks[0].text == ""
    assert isinstance(blocks[1], ToolUseBlock)


def test_untouched_conversations_keep_the_original_list_object():
    """바꿀 게 없으면 복사하지 않는다 — 매 턴 전체 히스토리를 다시 만들지 않기 위함."""
    messages = [
        UserMessage(content=[TextBlock(text="hi")]),
        AssistantMessage(content=[TextBlock(text="calling"), _tool_use()]),
    ]

    assert normalize_messages(messages) is messages


def test_only_the_offending_messages_are_rebuilt():
    good = AssistantMessage(content=[TextBlock(text="calling"), _tool_use("a")])
    bad = AssistantMessage(content=[_tool_use("b")])
    messages = [UserMessage(content=[TextBlock(text="hi")]), good, bad]

    fixed = normalize_messages(messages)

    assert fixed[1] is good  # 멀쩡한 메시지는 그대로
    assert fixed[2] is not bad
    assert fixed[2].content[0].text == ""


def test_normalize_request_preserves_every_other_field():
    request = LLMRequest(
        messages=[AssistantMessage(content=[_tool_use()])],
        system="sys", max_tokens=16384, temperature=0.0,
    )

    fixed = normalize_request(request)

    assert fixed.system == "sys"
    assert fixed.max_tokens == 16384
    assert fixed.messages[0].content[0].text == ""


def test_request_without_offending_messages_is_returned_unchanged():
    request = LLMRequest(messages=[UserMessage(content=[TextBlock(text="hi")])])

    assert normalize_request(request) is request


# ── 래퍼 ───────────────────────────────────────────────────────────────────


class _Recorder:
    name = "inner"

    def __init__(self) -> None:
        self.seen = []

    async def stream(self, request):
        self.seen.append(request)
        return
        yield  # pragma: no cover — 빈 async generator


def _drain(client, request):
    async def _go():
        return [event async for event in client.stream(request)]

    return asyncio.run(_go())


def test_wrapper_normalizes_the_request_it_sends_down():
    inner = _Recorder()
    request = LLMRequest(messages=[AssistantMessage(content=[_tool_use()])])

    _drain(GatewayCompatClient(inner), request)

    assert inner.seen[0].messages[0].content[0].text == ""


def test_kill_switch_restores_byte_for_byte_behaviour(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SA_TOOLCALL_TEXT_COMPAT", "0")
    inner = _Recorder()

    assert wrap_gateway_compat(inner) is inner


def test_wrapper_is_on_by_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SA_TOOLCALL_TEXT_COMPAT", raising=False)
    inner = _Recorder()

    assert isinstance(wrap_gateway_compat(inner), GatewayCompatClient)


def test_wrapper_delegates_unknown_attributes_to_inner():
    inner = _Recorder()
    inner.harness_tier = "high"

    assert GatewayCompatClient(inner).harness_tier == "high"
    assert GatewayCompatClient(inner).name == "inner"


# ── _build_client 배선 ─────────────────────────────────────────────────────


def _write_profiles(tmp_path):
    path = tmp_path / "llm_profiles.yaml"
    path.write_text(
        "profiles:\n"
        "  deepseek: {base_url: 'https://x/v1', model: 'm1', auth: {mode: api_key, api_key: k}, verify_ssl: false}\n",
        encoding="utf-8",
    )
    return path


def test_build_client_applies_the_compat_wrapper(tmp_path, monkeypatch):
    """보정은 재시도 **안쪽** — 재시도가 같은 요청을 다시 보낼 때도 보정본이 나간다."""
    from service.agents import runtime

    monkeypatch.setenv("SA_CHAT_PROFILES_PATH", str(_write_profiles(tmp_path)))
    monkeypatch.setenv("SA_CHAT_PROFILE", "deepseek")
    monkeypatch.delenv("SA_CHAT_PROFILE_CHAIN", raising=False)
    monkeypatch.delenv("SA_TOOLCALL_TEXT_COMPAT", raising=False)

    client = runtime._build_client()

    # tag_profile(wrap_retry(wrap_gateway_compat(...)))
    assert isinstance(client._inner._inner, GatewayCompatClient)
