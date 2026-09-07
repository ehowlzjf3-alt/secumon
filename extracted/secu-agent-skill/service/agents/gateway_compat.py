"""사내 security 게이트웨이(LiteLLM) 호환 — 텍스트 없는 tool_use assistant 메시지 보정.

## 실측 (2026-07-29)

`gateway.security.samsungds.net` 은 assistant 메시지가 **tool_calls 만 있고 content 가
null** 이면 HTTP 500 을 낸다:

    Error code: 500 - 'async for' requires an object with __aiter__ method, got NoneType

gauss-o32·gemma 둘 다(같은 게이트웨이). gpt-oss(apigw)는 정상. 재현율 100%.
**빈 문자열 TextBlock 하나만 넣어도 통과한다** — 그래서 이 보정은 한 줄짜리다.

## 왜 이게 중요한가

A/B 1~3 차에서 gauss/gemma 를 "완주율 50%·findings 0" 으로 보이게 한 진짜 원인이다.
모델이 **말없이 도구를 부른 턴** 하나가 대화 히스토리에 남으면, 그 뒤 모든 요청이 500 이
된다. dev_web/smb 는 초반에 곧장 도구를 부르는 흐름이라 매번 걸렸고(3 차 실측 0/2·0/3),
github/confluence 는 모델이 말을 섞어 살아남았다. 고립 프로브로는 안 보였다 —
도구 40 개·컨텍스트 400KB·max_tokens 16384·동시 5 스트림 전부 통과했었다.

## 범위

요청을 내려보내기 직전에만 손댄다. 빈 문자열은 의미상 중립이고 OpenAI 호환 서버가
`content: ""` 를 받아들이므로 모든 프로파일에 균일 적용한다(A/B 비교 가능성 유지).
kill-switch: `SA_TOOLCALL_TEXT_COMPAT=0`.
"""
from __future__ import annotations

import os
from dataclasses import replace
from typing import Any, AsyncIterator

from secu_agent.agent.llm.messages import AssistantMessage, TextBlock, ToolUseBlock


def _disabled() -> bool:
    return (os.environ.get("SA_TOOLCALL_TEXT_COMPAT", "1") or "").strip().lower() in {
        "0", "false", "no", "off",
    }


def needs_text(message: object) -> bool:
    """tool_use 는 있는데 TextBlock 이 없는 assistant 메시지인가."""
    if not isinstance(message, AssistantMessage):
        return False
    blocks = list(getattr(message, "content", None) or [])
    if not any(isinstance(b, ToolUseBlock) for b in blocks):
        return False
    return not any(isinstance(b, TextBlock) for b in blocks)


def normalize_messages(messages: list[Any]) -> list[Any]:
    """보정이 필요한 메시지만 빈 TextBlock 을 **맨 앞에** 붙여 새로 만든다.

    맨 앞인 이유: 대부분의 chat template 이 content 를 tool_calls 앞에 렌더한다.
    바꿀 게 없으면 **원본 리스트를 그대로** 돌려준다(불필요한 복사 없음).
    """
    if not any(needs_text(m) for m in messages):
        return messages
    out = []
    for message in messages:
        if needs_text(message):
            message = replace(message, content=[TextBlock(text="")] + list(message.content))
        out.append(message)
    return out


def normalize_request(request: Any) -> Any:
    messages = getattr(request, "messages", None)
    if not messages:
        return request
    # 원본 리스트를 그대로 넘긴다 — `list(...)` 로 감싸면 항상 새 객체가 돼서
    # "바꿀 게 없으면 원본 유지" 최적화가 죽는다(요청마다 불필요한 재조립).
    fixed = normalize_messages(messages)
    return request if fixed is messages else replace(request, messages=fixed)


class GatewayCompatClient:
    """요청을 내려보내기 직전에 보정하는 얇은 래퍼. 응답은 건드리지 않는다."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def name(self) -> str:
        return str(getattr(self._inner, "name", "gateway-compat"))

    def __getattr__(self, item: str) -> Any:
        return getattr(self._inner, item)

    async def stream(self, request: Any) -> AsyncIterator[Any]:
        async for event in self._inner.stream(normalize_request(request)):
            yield event


def wrap_gateway_compat(client: Any) -> Any:
    """SA_TOOLCALL_TEXT_COMPAT=0 이면 무래핑(byte-for-byte 원복)."""
    return client if _disabled() else GatewayCompatClient(client)
