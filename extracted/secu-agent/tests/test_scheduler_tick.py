"""scheduler_tick — 1분 주기 background tick.

설계:
- scheduler_tick_once(*, broadcaster, llm_factory, evidence_dir, now=None)
    1) state.schedule_due(now) 로 due job 조회
    2) 각 job 에 대해:
       - schedule_fire_start → fire_id
       - sub-ChatSession (operator task_type) 새로 만들어서 prompt 실행
       - deliver="chat" 이면 매 LoopEvent broadcast
       - deliver="silent" 이면 broadcast 안 하고 결과만 fire row 에
       - 끝나면 schedule_fire_finish(ok/error) + next_run 재계산
    3) repeat cap 도달 schedule 은 _fire_start 안에서 자동 paused

테스트: LLM/ChatSession 은 monkeypatch — 실제 gateway 안 친다.
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

import pytest

from secu_agent.agent.events import (
    LoopCompleted, ToolCallCompleted, ToolCallStarted, TextChunk,
)
from secu_agent.agent.llm.messages import (
    AssistantMessage, TextBlock,
)
from secu_agent.agent.tools.base import ToolSuccess


class _FakeBroadcaster:
    def __init__(self):
        self.calls: list[dict[str, Any]] = []

    async def broadcast(self, payload: dict[str, Any]) -> None:
        self.calls.append(payload)


class _FakeSession:
    """ChatSession 흉내. turn() 이 미리 정해진 events 를 yield."""
    instances: list["_FakeSession"] = []

    def __init__(self, *, events: list, final_text: str = "done"):
        self._events = events
        self._final_text = final_text
        self.turn_prompts: list[str] = []
        self.session_id = 999
        _FakeSession.instances.append(self)

    async def turn(self, user_text: str):
        self.turn_prompts.append(user_text)
        for ev in self._events:
            yield ev


def _install_fake_session(monkeypatch, events, final_text="done"):
    from secu_agent.agent import scheduler_tick

    def _factory(*, agent_type, evidence_dir):
        return _FakeSession(events=events, final_text=final_text)
    monkeypatch.setattr(scheduler_tick, "_make_sub_session", _factory)


def _run(coro):
    return asyncio.run(coro)


def test_tick_does_nothing_when_no_due(tmp_db, tmp_path, monkeypatch):
    from secu_agent import state
    from secu_agent.agent.scheduler_tick import scheduler_tick_once
    # future
    state.schedule_create(
        agent_type="agent", prompt="x", cron_expr="0 * * * *",
        next_run=time.time() + 3600, origin="operator_agent",
    )
    bc = _FakeBroadcaster()

    async def _hub(_agent_type):
        return bc

    _install_fake_session(monkeypatch, events=[
        LoopCompleted(reason="end_turn", total_turns=1, final_message=None, usage=None),
    ])

    _run(scheduler_tick_once(
        get_hub=_hub, evidence_dir=tmp_path, now=time.time(),
    ))
    assert bc.calls == []
    # fire 없음
    assert state.schedule_fires_for(1) == []


def test_tick_fires_due_job_and_broadcasts(tmp_db, tmp_path, monkeypatch):
    from secu_agent import state
    from secu_agent.agent.scheduler_tick import scheduler_tick_once

    sid = state.schedule_create(
        agent_type="agent", prompt="walked share 자동 review",
        cron_expr="* * * * *",
        next_run=time.time() - 10, origin="operator_agent",
        deliver="chat",
    )

    bc = _FakeBroadcaster()

    async def _hub(_agent_type):
        return bc

    _install_fake_session(monkeypatch, events=[
        TextChunk(text="시작"),
        LoopCompleted(reason="end_turn", total_turns=1, final_message=None, usage=None),
    ])

    _run(scheduler_tick_once(
        get_hub=_hub, evidence_dir=tmp_path, now=time.time(),
    ))

    # 1) ChatSession 1개 생성됐고 prompt 전달됨
    assert len(_FakeSession.instances) == 1
    assert "walked share 자동 review" in _FakeSession.instances[0].turn_prompts[0]
    _FakeSession.instances.clear()

    # 2) broadcast: 최소 ScheduleFireStarted + 본 이벤트들 + ScheduleFireFinished
    event_names = [c.get("event") for c in bc.calls]
    assert "ScheduleFireStarted" in event_names
    assert "ScheduleFireFinished" in event_names
    assert "TextChunk" in event_names

    # 3) fire row 가 ok 상태
    fires = state.schedule_fires_for(sid)
    assert len(fires) == 1
    assert fires[0]["status"] == "ok"

    # 4) next_run 이 미래로 advance
    row = state.schedule_get(sid)
    assert row["next_run"] > time.time()


def test_tick_silent_does_not_broadcast(tmp_db, tmp_path, monkeypatch):
    from secu_agent import state
    from secu_agent.agent.scheduler_tick import scheduler_tick_once

    sid = state.schedule_create(
        agent_type="agent", prompt="silent job here", cron_expr="* * * * *",
        next_run=time.time() - 10, origin="operator_agent",
        deliver="silent",
    )

    bc = _FakeBroadcaster()

    async def _hub(_agent_type):
        return bc

    _install_fake_session(monkeypatch, events=[
        TextChunk(text="hi"),
        LoopCompleted(reason="end_turn", total_turns=1, final_message=None, usage=None),
    ])

    _run(scheduler_tick_once(
        get_hub=_hub, evidence_dir=tmp_path, now=time.time(),
    ))
    # silent — chat broadcast 안 함
    assert bc.calls == []
    # 하지만 fire row 는 기록
    assert len(state.schedule_fires_for(sid)) == 1
    assert state.schedule_fires_for(sid)[0]["status"] == "ok"
    _FakeSession.instances.clear()


def test_tick_records_internal_delivery_dry_run(tmp_db, tmp_path, monkeypatch):
    from secu_agent import state
    from secu_agent.agent.scheduler_tick import scheduler_tick_once

    sid = state.schedule_create(
        agent_type="agent", prompt="scheduled report here", cron_expr="* * * * *",
        next_run=time.time() - 10, origin="operator_agent",
        deliver="silent",
    )

    _install_fake_session(monkeypatch, events=[
        TextChunk(text="report summary"),
        LoopCompleted(reason="end_turn", total_turns=1, final_message=None, usage=None),
    ])

    _run(scheduler_tick_once(
        get_hub=None, evidence_dir=tmp_path, now=time.time(),
    ))

    fire = state.schedule_fires_for(sid)[0]
    deliveries = state.schedule_deliveries_for_fire(fire["id"])
    assert len(deliveries) == 1
    assert deliveries[0]["channel"] == "internal_report_dry_run"
    assert deliveries[0]["status"] == "dry_run"
    payload = json.loads(deliveries[0]["payload_json"])
    assert payload["schedule_id"] == sid
    assert payload["fire_id"] == fire["id"]
    assert payload["status"] == "ok"
    assert payload["result_summary"] == "report summary"
    _FakeSession.instances.clear()


def test_tick_records_error_on_exception(tmp_db, tmp_path, monkeypatch):
    from secu_agent import state
    from secu_agent.agent.scheduler_tick import scheduler_tick_once

    sid = state.schedule_create(
        agent_type="agent", prompt="failing job here", cron_expr="* * * * *",
        next_run=time.time() - 10, origin="operator_agent",
    )

    class _BoomSession:
        def __init__(self, *a, **kw):
            self.session_id = 0
        async def turn(self, user_text):
            raise RuntimeError("LLM gateway down")
            yield None  # noqa — make this an async generator

    from secu_agent.agent import scheduler_tick
    monkeypatch.setattr(
        scheduler_tick, "_make_sub_session",
        lambda *, agent_type, evidence_dir: _BoomSession(),
    )

    bc = _FakeBroadcaster()

    async def _hub(_agent_type):
        return bc

    _run(scheduler_tick_once(
        get_hub=_hub, evidence_dir=tmp_path, now=time.time(),
    ))
    fires = state.schedule_fires_for(sid)
    assert len(fires) == 1
    assert fires[0]["status"] == "error"
    assert "LLM gateway down" in (fires[0]["result_summary"] or "")
    # 그래도 next_run 은 advance (계속 시도)
    assert state.schedule_get(sid)["next_run"] > time.time()


def test_tick_skips_paused_jobs(tmp_db, tmp_path, monkeypatch):
    from secu_agent import state
    from secu_agent.agent.scheduler_tick import scheduler_tick_once

    sid = state.schedule_create(
        agent_type="agent", prompt="paused job here", cron_expr="* * * * *",
        next_run=time.time() - 10, origin="operator_agent",
    )
    state.schedule_pause(sid)

    bc = _FakeBroadcaster()

    async def _hub(_agent_type):
        return bc

    _install_fake_session(monkeypatch, events=[
        LoopCompleted(reason="end_turn", total_turns=1, final_message=None, usage=None),
    ])

    _run(scheduler_tick_once(
        get_hub=_hub, evidence_dir=tmp_path, now=time.time(),
    ))
    assert state.schedule_fires_for(sid) == []
    _FakeSession.instances.clear()


def test_tick_respects_repeat_cap_self_pauses(tmp_db, tmp_path, monkeypatch):
    """repeat=1 schedule 은 1번 fire 후 자동 paused — 두번째 tick 에선 안 fire."""
    from secu_agent import state
    from secu_agent.agent.scheduler_tick import scheduler_tick_once

    sid = state.schedule_create(
        agent_type="agent", prompt="one-shot job here", cron_expr="* * * * *",
        next_run=time.time() - 10, origin="operator_agent",
        repeat=1,
    )

    bc = _FakeBroadcaster()

    async def _hub(_agent_type):
        return bc

    _install_fake_session(monkeypatch, events=[
        LoopCompleted(reason="end_turn", total_turns=1, final_message=None, usage=None),
    ])

    # 1차 tick — fire 1번
    _run(scheduler_tick_once(
        get_hub=_hub, evidence_dir=tmp_path, now=time.time(),
    ))
    assert len(state.schedule_fires_for(sid)) == 1
    assert state.schedule_get(sid)["status"] == "paused"

    # 2차 tick — fire 안 일어남 (paused)
    _FakeSession.instances.clear()
    _run(scheduler_tick_once(
        get_hub=_hub, evidence_dir=tmp_path, now=time.time() + 120,
    ))
    assert len(state.schedule_fires_for(sid)) == 1  # 그대로
    assert _FakeSession.instances == []


def test_tick_skips_superseded_self_wakeup(tmp_db, tmp_path, monkeypatch):
    from secu_agent import state
    from secu_agent.agent.scheduler_tick import scheduler_tick_once

    session_id = state.chat_session_new(agent_type="agent")
    source_msg = state.chat_message_add(
        session_id, role="user", content={"text": "check later"},
    )
    sid = state.schedule_create(
        agent_type="agent",
        prompt="old self wakeup",
        cron_expr="@once",
        next_run=time.time() - 10,
        origin="operator_agent",
        deliver="chat",
        repeat=1,
        schedule_kind="self_wakeup",
        stale_policy="skip_if_superseded",
        source_session_id=session_id,
        source_message_id=source_msg,
        expires_at=time.time() + 300,
    )
    state.chat_message_add(
        session_id, role="user", content={"text": "new direction"},
    )

    bc = _FakeBroadcaster()

    async def _hub(_agent_type):
        return bc

    _install_fake_session(monkeypatch, events=[
        TextChunk(text="should not run"),
    ])

    processed = _run(scheduler_tick_once(
        get_hub=_hub, evidence_dir=tmp_path, now=time.time(),
    ))

    assert processed == 1
    assert _FakeSession.instances == []
    fire = state.schedule_fires_for(sid)[0]
    assert fire["status"] == "skipped"
    assert "superseded" in fire["result_summary"]
    assert state.schedule_get(sid)["status"] == "paused"
    assert any(c.get("event") == "ScheduleFireSkipped" for c in bc.calls)


def test_tick_queues_confirm_if_superseded_self_wakeup(
    tmp_db, tmp_path, monkeypatch,
):
    from secu_agent import state
    from secu_agent.agent.scheduler_tick import scheduler_tick_once

    session_id = state.chat_session_new(agent_type="agent")
    source_msg = state.chat_message_add(
        session_id, role="user", content={"text": "check later"},
    )
    sid = state.schedule_create(
        agent_type="agent",
        prompt="confirmable self wakeup",
        cron_expr="@once",
        next_run=time.time() - 10,
        origin="operator_agent",
        deliver="chat",
        repeat=1,
        schedule_kind="self_wakeup",
        stale_policy="confirm_if_superseded",
        source_session_id=session_id,
        source_message_id=source_msg,
        expires_at=time.time() + 300,
    )
    state.chat_message_add(
        session_id, role="user", content={"text": "new direction"},
    )

    bc = _FakeBroadcaster()

    async def _hub(_agent_type):
        return bc

    _install_fake_session(monkeypatch, events=[TextChunk(text="should not run")])

    processed = _run(scheduler_tick_once(
        get_hub=_hub, evidence_dir=tmp_path, now=time.time(),
    ))

    assert processed == 1
    assert _FakeSession.instances == []
    fire = state.schedule_fires_for(sid)[0]
    assert fire["status"] == "queued"
    assert "confirmation_required" in fire["result_summary"]
    deliveries = state.schedule_deliveries_for_fire(fire["id"])
    payload = json.loads(deliveries[0]["payload_json"])
    assert payload["status"] == "queued"
    assert any(c.get("event") == "ScheduleFireQueued" for c in bc.calls)


def test_tick_runs_self_wakeup_when_source_not_superseded(tmp_db, tmp_path, monkeypatch):
    from secu_agent import state
    from secu_agent.agent.scheduler_tick import scheduler_tick_once

    session_id = state.chat_session_new(agent_type="agent")
    source_msg = state.chat_message_add(
        session_id, role="user", content={"text": "check later"},
    )
    sid = state.schedule_create(
        agent_type="agent",
        prompt="fresh self wakeup",
        cron_expr="@once",
        next_run=time.time() - 10,
        origin="operator_agent",
        deliver="silent",
        repeat=1,
        schedule_kind="self_wakeup",
        stale_policy="skip_if_superseded",
        source_session_id=session_id,
        source_message_id=source_msg,
        expires_at=time.time() + 300,
    )

    _install_fake_session(monkeypatch, events=[
        TextChunk(text="ran"),
        LoopCompleted(reason="end_turn", total_turns=1, final_message=None, usage=None),
    ])

    _run(scheduler_tick_once(
        get_hub=None, evidence_dir=tmp_path, now=time.time(),
    ))

    assert len(_FakeSession.instances) == 1
    assert _FakeSession.instances[0].turn_prompts == ["fresh self wakeup"]
    assert state.schedule_fires_for(sid)[0]["status"] == "ok"
    _FakeSession.instances.clear()


def test_tick_sets_schedule_origin_metadata_on_running_session(
    tmp_db, tmp_path, monkeypatch,
):
    from secu_agent import state
    from secu_agent.agent.scheduler_tick import scheduler_tick_once

    sid = state.schedule_create(
        agent_type="agent",
        prompt="scheduled web scan",
        cron_expr="* * * * *",
        next_run=time.time() - 10,
        origin="operator_agent",
        deliver="silent",
    )

    _install_fake_session(monkeypatch, events=[
        TextChunk(text="ran"),
        LoopCompleted(reason="end_turn", total_turns=1, final_message=None, usage=None),
    ])

    _run(scheduler_tick_once(
        get_hub=None, evidence_dir=tmp_path, now=time.time(),
    ))

    inst = _FakeSession.instances[0]
    assert getattr(inst, "schedule_origin", None)["schedule_id"] == sid
    assert getattr(inst, "input_origin", None)["type"] == "schedule"
    _FakeSession.instances.clear()


def test_tick_routes_generic_agent_schedule_to_source_session(
    tmp_db, tmp_path, monkeypatch,
):
    from secu_agent import state
    from secu_agent.agent import scheduler_tick
    from secu_agent.agent.scheduler_tick import scheduler_tick_once

    session_id = state.chat_session_new(agent_type="agent", label="general agent")
    sid = state.schedule_create(
        agent_type="agent",
        prompt="refresh discovered domain outputs",
        cron_expr="* * * * *",
        next_run=time.time() - 10,
        origin="operator_agent",
        deliver="chat",
        source_session_id=session_id,
    )

    captured: dict[str, Any] = {}

    def _factory(*, agent_type, evidence_dir, session_id=None):
        captured.update({
            "agent_type": agent_type,
            "evidence_dir": evidence_dir,
            "session_id": session_id,
        })
        fake = _FakeSession(events=[
            TextChunk(text="agent refresh ran"),
            LoopCompleted(
                reason="end_turn",
                total_turns=1,
                final_message=None,
                usage=None,
            ),
        ])
        fake.session_id = session_id or fake.session_id
        return fake

    monkeypatch.setattr(scheduler_tick, "_make_sub_session", _factory)

    bc = _FakeBroadcaster()
    hub_channels: list[str] = []

    async def _hub(channel):
        hub_channels.append(channel)
        return bc

    _run(scheduler_tick_once(
        get_hub=_hub, evidence_dir=tmp_path, now=time.time(),
    ))

    assert captured["agent_type"] == "agent"
    assert captured["session_id"] == session_id
    assert hub_channels == [f"agent:{session_id}"]
    fire = state.schedule_fires_for(sid)[0]
    assert fire["status"] == "ok"
    assert fire["child_session_id"] == session_id
    _FakeSession.instances.clear()


def test_tick_keeps_user_recurring_schedule_unaffected_by_chat_changes(
    tmp_db, tmp_path, monkeypatch,
):
    from secu_agent import state
    from secu_agent.agent.scheduler_tick import scheduler_tick_once

    session_id = state.chat_session_new(agent_type="agent")
    state.chat_message_add(session_id, role="user", content={"text": "old"})
    state.chat_message_add(session_id, role="user", content={"text": "new"})
    sid = state.schedule_create(
        agent_type="agent",
        prompt="user recurring report",
        cron_expr="* * * * *",
        next_run=time.time() - 10,
        origin="user",
        deliver="silent",
    )

    _install_fake_session(monkeypatch, events=[
        TextChunk(text="recurring ran"),
        LoopCompleted(reason="end_turn", total_turns=1, final_message=None, usage=None),
    ])

    _run(scheduler_tick_once(
        get_hub=None, evidence_dir=tmp_path, now=time.time(),
    ))

    assert len(_FakeSession.instances) == 1
    assert state.schedule_fires_for(sid)[0]["status"] == "ok"
    _FakeSession.instances.clear()
