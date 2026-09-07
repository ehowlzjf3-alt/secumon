"""_classify 회귀 가드 — 서버측 5xx/529 는 retryable(transient) 로 분류돼야 한다.

audit #8: InternalServerError(>=500)/529 overloaded 가 non-retryable 'other' 로
떨어지면 FallbackLLMClient 가 다음 provider 로 못 넘어가고 세션이 하드 실패한다.
_classify 는 gateway(OpenAICompatClient)와 codex_responses_client 양쪽이 공유한다.
"""
from __future__ import annotations

import httpx
import openai
import pytest

from secu_agent.agent.llm.internal_gateway import _classify


def _status_error(cls: type[openai.APIStatusError], status: int) -> openai.APIStatusError:
    req = httpx.Request("POST", "https://gw.example/v1/chat/completions")
    return cls("boom", response=httpx.Response(status, request=req), body=None)


@pytest.mark.parametrize("status", [500, 502, 503, 529])
def test_server_5xx_is_retryable_transient(status: int) -> None:
    err = _classify(_status_error(openai.InternalServerError, status))
    assert err.kind == "transient"
    assert err.retryable is True


def test_rate_limit_unchanged() -> None:
    err = _classify(_status_error(openai.RateLimitError, 429))
    assert err.kind == "rate_limit"
    assert err.retryable is True


def test_auth_unchanged_not_retryable() -> None:
    err = _classify(_status_error(openai.AuthenticationError, 401))
    assert err.kind == "auth"
    assert err.retryable is False


@pytest.mark.parametrize("cls,status", [
    (openai.NotFoundError, 404),
    (openai.PermissionDeniedError, 403),
    (openai.UnprocessableEntityError, 422),
])
def test_client_4xx_not_broadened_to_retryable(
    cls: type[openai.APIStatusError], status: int,
) -> None:
    # 5xx 재분류가 client 4xx 까지 retryable 로 넓히면 안 된다(무의미한 재시도 방지).
    err = _classify(_status_error(cls, status))
    assert err.kind == "other"
    assert err.retryable is False


def test_bad_request_still_invalid_request() -> None:
    err = _classify(_status_error(openai.BadRequestError, 400))
    assert err.kind == "invalid_request"
    assert err.retryable is False
