"""v3.79-perf: Codex 자격증명 resolve 를 이벤트 루프 밖(스레드)에서 도는지 검증.

resolve_codex_credentials 는 토큰 만료 임박 시 **동기** httpx OAuth refresh(수 초)를
수행할 수 있다. async stream() 이 이를 직접 부르면 그 사이 이벤트 루프 전체가 막혀
동시성이 죽는다. 수정은 self._build_client() 호출(=resolve 를 감싸는 sync 진입점)을
asyncio.to_thread 로 오프로드한다. 여기서는:
  1) _build_client 가 이벤트 루프 스레드가 **아닌** 워커 스레드에서 실행되는지,
  2) 블로킹 refresh 동안 다른 코루틴이 계속 진행되는지(루프 안 막힘),
  3) 자격증명 에러 시맨틱이 그대로 보존되어 StreamError(auth) 로 표출되는지
를 실제 네트워크/토큰/sleep 없이 결정론적으로 검증한다.
"""
from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace
from typing import Any

from secu_agent.agent.llm.codex_auth import CodexAuthError
from secu_agent.agent.llm.codex_responses_client import CodexResponsesClient
from secu_agent.agent.llm.profile import AuthConfig, LLMProfile
from secu_agent.agent.llm.types import LLMRequest, StreamError


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


class _FakeEventStream:
    """async 이터레이터 하나만 흘려 stream() 이 정상 종료되게 한다."""

    def __init__(self, events: list[Any]) -> None:
        self._events = events

    def __aiter__(self):
        async def _gen():
            for e in self._events:
                yield e
        return _gen()


def _wire_fake_build(client: CodexResponsesClient) -> dict[str, Any]:
    """_build_client 를 동기 대체(=수정 후에도 to_thread 로 감싸 부르는 진입점)로 몽키패치.

    호출된 스레드를 기록해 이벤트 루프 밖에서 도는지 확인한다.
    """
    captured: dict[str, Any] = {}
    final = SimpleNamespace(output=[], status="completed", usage=None)

    class _Responses:
        async def create(self, **kw):
            return _FakeEventStream([
                SimpleNamespace(type="response.completed", response=final),
            ])

    fake_client = SimpleNamespace(responses=_Responses())

    def _fake_build():  # sync — 수정본은 이걸 asyncio.to_thread 로 감싼다
        captured["thread"] = threading.current_thread()
        return fake_client

    client._build_client = _fake_build  # type: ignore[method-assign]
    return captured


def _drain(client: CodexResponsesClient, req: LLMRequest) -> list[Any]:
    async def _go() -> list[Any]:
        out = []
        async for ev in client.stream(req):
            out.append(ev)
        await client.aclose()
        return out

    return asyncio.run(_go())


def test_build_client_runs_off_event_loop_thread() -> None:
    """_build_client(=자격증명 resolve 진입점)은 루프 스레드가 아닌 워커 스레드에서 돈다."""
    c = _client()
    captured = _wire_fake_build(c)
    _drain(c, LLMRequest(messages=[]))
    assert "thread" in captured, "_build_client 가 호출되지 않았다"
    assert captured["thread"] is not threading.main_thread(), (
        "_build_client 가 이벤트 루프(main) 스레드에서 돌았다 — 오프로드 안 됨"
    )


def test_blocking_refresh_does_not_block_event_loop() -> None:
    """_build_client 안의 블로킹(동기 refresh 모사) 동안 다른 코루틴이 진행된다."""
    c = _client()
    gate = threading.Event()
    progressed: list[str] = []

    def _blocking_build():
        # 동기 httpx refresh 모사: 다른 코루틴이 tick 을 남길 때까지 블록.
        # 오프로드되지 않았다면 루프가 막혀 progressed 가 채워지지 못하고 데드락난다.
        assert gate.wait(timeout=5.0), "코루틴이 진행 못함 — 루프가 막혔다(오프로드 실패)"
        return SimpleNamespace(responses=_wire_resp())

    def _wire_resp():
        final = SimpleNamespace(output=[], status="completed", usage=None)

        class _Responses:
            async def create(self, **kw):
                return _FakeEventStream([
                    SimpleNamespace(type="response.completed", response=final),
                ])
        return _Responses()

    c._build_client = _blocking_build  # type: ignore[method-assign]

    async def _go() -> None:
        async def _ticker():
            await asyncio.sleep(0)
            progressed.append("tick")
            gate.set()

        stream_task = asyncio.create_task(_collect(c, LLMRequest(messages=[])))
        tick_task = asyncio.create_task(_ticker())
        await asyncio.wait_for(asyncio.gather(stream_task, tick_task), timeout=5.0)
        await c.aclose()

    async def _collect(client: CodexResponsesClient, req: LLMRequest) -> None:
        async for _ in client.stream(req):
            pass

    asyncio.run(_go())
    assert progressed == ["tick"], "블로킹 동안 다른 코루틴이 진행하지 못함(루프 막힘)"


def test_creds_auth_error_still_surfaces_after_offload() -> None:
    """오프로드 후에도 CodexAuthError 시맨틱 보존 → StreamError(kind=auth)."""
    c = _client()

    def _boom():
        raise CodexAuthError("재로그인", relogin_required=True)

    c._build_client = _boom  # type: ignore[method-assign]
    out = _drain(c, LLMRequest(messages=[]))
    errs = [e for e in out if isinstance(e, StreamError)]
    assert errs and errs[0].kind == "auth"
