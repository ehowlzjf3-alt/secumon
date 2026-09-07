"""vision 미지원 프로파일 보호 — ImageBlock 강등 계약.

배경(실측 2026-08-20): deepseek 는 이미지 입력을 HTTP 400 으로 거부하고, 그 400 은
`invalid_request`(retryable=False)라 **재시도도 폴백도 안 걸린다**. 코어 엔진은 도구가
반환한 이미지를 대화에 ImageBlock 으로 주입하므로(engine.py:173), smb_inspect_image /
dev_web 스크린샷이 한 번 돌면 그 뒤 모든 요청이 400 = 태스크 영구 사망.

여기서 고정하는 것: ①이미지가 사라지고 자리표시자가 남는다 ②지원 모델은 무손실
③프로파일별로 독립 적용(폴백 체인) ④kill-switch ⑤바꿀 게 없으면 원본 그대로.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest

from secu_agent.agent.llm.messages import (
    AssistantMessage, ImageBlock, TextBlock, ToolUseBlock, UserMessage,
)
from service.agents import vision_compat as vc


@pytest.fixture(autouse=True)
def _isolate_unsupported_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """★ 이 모듈이 검증하는 건 **코드 기본값**(`_DEFAULT_UNSUPPORTED`)이다.

    `SA_VISION_UNSUPPORTED_PROFILES` 는 목록에 추가가 아니라 **완전 대체** 라서,
    운영 `.env` 가 바뀌면 무관한 테스트가 줄줄이 깨진다. 실제로 2026-08-20 에
    운영 목록이 `gauss-o32` → `deepseek` 로 바뀌면서 3건이 깨졌다(설정은 정상,
    테스트가 env 를 안 막은 게 원인).

    env override 자체를 보는 `test_env_list_replaces_the_default` 는 본문에서
    다시 setenv 하므로 이 fixture 뒤에 적용된다 — 영향 없다.
    """
    monkeypatch.delenv("SA_VISION_UNSUPPORTED_PROFILES", raising=False)


@dataclass
class _Req:
    messages: list[Any] = field(default_factory=list)
    tools: list[Any] = field(default_factory=list)


class _Echo:
    """받은 요청을 그대로 기록하는 최소 client."""

    name = "echo"

    def __init__(self) -> None:
        self.seen: list[Any] = []

    async def stream(self, request):
        self.seen.append(request)
        yield TextBlock(text="ok")


def _drain(client, request):
    """레포 관례: pytest-asyncio 없이 asyncio.run 으로 스트림을 소진."""
    async def _go():
        return [e async for e in client.stream(request)]
    return asyncio.run(_go())


def _img_request():
    return _Req(messages=[
        UserMessage(content=[TextBlock(text="분석하라")]),
        AssistantMessage(content=[ToolUseBlock(id="t1", name="smb_inspect_image", input={})]),
        UserMessage(content=[
            TextBlock(text="tool result"),
            ImageBlock(media_type="image/png", data_b64="AAAA"),
            ImageBlock(media_type="image/jpeg", data_b64="BBBB"),
        ]),
    ])


# ── ① 이미지 제거 + 자리표시자 ───────────────────────────────────────────
def test_images_are_replaced_with_a_single_placeholder():
    out = vc.strip_images(_img_request().messages)
    blocks = out[2].content
    assert not any(isinstance(b, ImageBlock) for b in blocks)
    texts = [b.text for b in blocks if isinstance(b, TextBlock)]
    assert texts[0] == "tool result"          # 기존 텍스트 보존
    assert "이미지 2장 생략" in texts[-1]      # 여러 장 → 자리표시자 1개
    assert len(texts) == 2


def test_non_image_messages_are_untouched():
    original = _img_request().messages
    out = vc.strip_images(original)
    assert out[0] is original[0]
    assert out[1] is original[1]


# ── ② 지원 모델은 무손실 ─────────────────────────────────────────────────
@pytest.mark.parametrize("profile", ["gemma", "codex", "llama-4-maverick", None])
def test_supported_profiles_are_not_wrapped(profile):
    inner = _Echo()
    assert vc.wrap_vision_compat(inner, profile=profile) is inner


def test_unsupported_profile_is_wrapped_and_strips_images():
    inner = _Echo()
    client = vc.wrap_vision_compat(inner, profile="deepseek")
    assert client is not inner
    _drain(client, _img_request())
    sent = inner.seen[0]
    assert not any(
        isinstance(b, ImageBlock) for m in sent.messages for b in m.content
    ), "vision 미지원 프로파일에 ImageBlock 이 그대로 나갔다 — 400 으로 태스크가 죽는다"


# ── ③ 프로파일별 독립 적용(폴백 체인) ────────────────────────────────────
def test_fallback_chain_downgrades_only_the_blind_profile():
    """deepseek 만 강등되고 gemma 는 이미지를 그대로 받아야 한다 —
    체인 전체를 한 번에 감싸면 이미지 증거를 통째로 잃는다."""
    blind_inner, seeing_inner = _Echo(), _Echo()
    blind = vc.wrap_vision_compat(blind_inner, profile="deepseek")
    seeing = vc.wrap_vision_compat(seeing_inner, profile="gemma")

    _drain(blind, _img_request())
    _drain(seeing, _img_request())

    assert not any(isinstance(b, ImageBlock)
                   for m in blind_inner.seen[0].messages for b in m.content)
    assert any(isinstance(b, ImageBlock)
               for m in seeing_inner.seen[0].messages for b in m.content)


# ── ④ kill-switch / 목록 override ────────────────────────────────────────
def test_kill_switch_disables_wrapping(monkeypatch):
    monkeypatch.setenv("SA_VISION_COMPAT", "0")
    inner = _Echo()
    assert vc.wrap_vision_compat(inner, profile="deepseek") is inner


def test_env_list_replaces_the_default(monkeypatch):
    monkeypatch.setenv("SA_VISION_UNSUPPORTED_PROFILES", "some-other-model")
    assert vc.supports_vision("deepseek") is True
    assert vc.supports_vision("some-other-model") is False


def test_default_list_only_contains_measured_profiles():
    """⚠️ 추측으로 넣으면 멀쩡한 모델의 이미지 증거를 조용히 버린다.
    수용하는 모델을 넣으면 멀쩡한 이미지 증거를 조용히 버린다."""
    assert vc.unsupported_profiles() == {"deepseek"}


# ── ⑤ 바꿀 게 없으면 원본 그대로 ─────────────────────────────────────────
def test_request_without_images_is_returned_unchanged():
    req = _Req(messages=[UserMessage(content=[TextBlock(text="hi")])])
    assert vc.normalize_request(req) is req


def test_empty_messages_request_is_returned_unchanged():
    req = _Req(messages=[])
    assert vc.normalize_request(req) is req


def test_message_list_identity_preserved_when_no_images():
    messages = [UserMessage(content=[TextBlock(text="hi")])]
    assert vc.strip_images(messages) is messages
