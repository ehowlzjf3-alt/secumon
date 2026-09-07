"""v3.79-perf: chat 라이프사이클 리소스 관리 유닛 테스트.

두 가지 성능/누수 픽스를 검증한다 (관찰 가능한 채팅 시맨틱은 불변):
(a) _ensure_dotenv() 는 프로세스당 1회만 .env 파싱 (WS 접속마다 재파싱 X).
(b) 마지막 구독자가 떠나면 세션별 Hub/_SESSION_STOP/_SESSION_CANCEL 회수.

의도적으로 실 subprocess/network/DB/sleep 없이 fake/monkeypatch 만 사용.
"""
from __future__ import annotations

import asyncio

import pytest

from secu_agent.web.routes import chat as chat_mod


# ---------------------------------------------------------------------------
# (a) _ensure_dotenv 는 1회만 파일을 읽는다
# ---------------------------------------------------------------------------

def test_ensure_dotenv_parses_file_only_once(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("SA_LIFECYCLE_TEST_KEY=hello\n", encoding="utf-8")

    read_calls = {"n": 0}
    real_read_text = type(env_file).read_text

    def _counting_read_text(self, *a, **k):
        # 우리 .env 만 카운트 (다른 read_text 오염 방지)
        if str(self) == str(env_file):
            read_calls["n"] += 1
        return real_read_text(self, *a, **k)

    monkeypatch.setattr(chat_mod, "_project_root", lambda: tmp_path)
    monkeypatch.setattr(type(env_file), "read_text", _counting_read_text)
    monkeypatch.delenv("SA_LIFECYCLE_TEST_KEY", raising=False)

    # cache 초기화 후 여러 번 호출 — WS 접속 반복을 모사.
    chat_mod._ensure_dotenv.cache_clear()
    try:
        chat_mod._ensure_dotenv()
        chat_mod._ensure_dotenv()
        chat_mod._ensure_dotenv()
        # cache 통계는 finally 의 cache_clear() 前에 읽어야 한다(clear 가 0으로 리셋).
        info = chat_mod._ensure_dotenv.cache_info()
    finally:
        chat_mod._ensure_dotenv.cache_clear()

    # env 는 실제로 로드됐고(첫 사용 전 보장), 파일은 딱 1회만 파싱.
    assert __import__("os").environ.get("SA_LIFECYCLE_TEST_KEY") == "hello"
    assert read_calls["n"] == 1
    assert info.misses == 1
    assert info.hits >= 2


def test_ensure_dotenv_missing_file_is_noop(tmp_path, monkeypatch):
    monkeypatch.setattr(chat_mod, "_project_root", lambda: tmp_path)  # .env 없음
    chat_mod._ensure_dotenv.cache_clear()
    try:
        chat_mod._ensure_dotenv()  # raise 하면 실패
    finally:
        chat_mod._ensure_dotenv.cache_clear()


# ---------------------------------------------------------------------------
# (b) 채널 회수 — 마지막 구독자가 떠나면 Hub/stop/cancel 엔트리 제거
# ---------------------------------------------------------------------------

class _FakeWS:
    """asyncio.create_task 로 뜨는 _sender 가 즉시 죽도록 receive 를 막는다."""

    def __init__(self):
        self._closed = asyncio.Event()

    async def send_text(self, _payload):  # pragma: no cover - sender 는 큐 비어 대기
        await self._closed.wait()


def _run(coro):
    return asyncio.run(coro)


def test_release_channel_frees_hub_and_session_dicts(monkeypatch):
    async def scenario():
        channel = "agent:9991"
        sid = 9991
        hub = chat_mod._Hub()
        chat_mod._hubs[channel] = hub
        # stop/cancel 엔트리 모사 (loop 튜플 구조 그대로).
        loop = asyncio.get_running_loop()
        chat_mod._SESSION_STOP[sid] = (loop, asyncio.Event())
        chat_mod._SESSION_CANCEL[sid] = (loop, asyncio.Event())

        # 구독자 없음 → 회수돼야 함.
        await chat_mod._release_session_channel(channel, {sid}, hub)

        assert channel not in chat_mod._hubs
        assert sid not in chat_mod._SESSION_STOP
        assert sid not in chat_mod._SESSION_CANCEL

    _run(scenario())


def test_release_channel_keeps_hub_when_subscriber_remains(monkeypatch):
    async def scenario():
        channel = "agent:9992"
        sid = 9992
        hub = chat_mod._Hub()
        chat_mod._hubs[channel] = hub
        chat_mod._SESSION_STOP[sid] = (asyncio.get_running_loop(), asyncio.Event())

        ws = _FakeWS()
        await hub.join(ws)  # 구독자 1명 남김
        try:
            await chat_mod._release_session_channel(channel, {sid}, hub)
            # 아직 구독자가 있으므로 아무것도 회수하면 안 됨.
            assert chat_mod._hubs.get(channel) is hub
            assert sid in chat_mod._SESSION_STOP
        finally:
            await hub.leave(ws)
            chat_mod._hubs.pop(channel, None)
            chat_mod._SESSION_STOP.pop(sid, None)

    _run(scenario())


def test_release_channel_ignores_replaced_hub(monkeypatch):
    """회수 대상 hub 가 이미 새 Hub 로 교체됐으면 건드리지 않는다(재접속 안전)."""
    async def scenario():
        channel = "agent:9993"
        sid = 9993
        old_hub = chat_mod._Hub()
        new_hub = chat_mod._Hub()
        chat_mod._hubs[channel] = new_hub  # 재접속으로 이미 교체됨
        chat_mod._SESSION_STOP[sid] = (asyncio.get_running_loop(), asyncio.Event())
        try:
            await chat_mod._release_session_channel(channel, {sid}, old_hub)
            assert chat_mod._hubs.get(channel) is new_hub  # 교체본 유지
            assert sid in chat_mod._SESSION_STOP      # stop 도 안 건드림
        finally:
            chat_mod._hubs.pop(channel, None)
            chat_mod._SESSION_STOP.pop(sid, None)

    _run(scenario())
