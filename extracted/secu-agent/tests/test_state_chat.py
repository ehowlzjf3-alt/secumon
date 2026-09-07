"""chat_session / chat_message 영속 layer.

- chat_session: 단일 long-lived session (id, started_at, source).
  v1 은 single session — 항상 같은 session 으로 append.
- chat_message: role + content_json + created_at + session_id.
  role ∈ {user, assistant, system, tool_event}.
  tool_event 는 turn 안의 ToolCallStarted/Completed 같은 LoopEvent — replay 용.
"""
from __future__ import annotations

import time


def test_chat_session_get_or_create_returns_singleton(tmp_db):
    from secu_agent import state
    sid1 = state.chat_session_get_or_create()
    sid2 = state.chat_session_get_or_create()
    assert sid1 == sid2
    assert isinstance(sid1, int)


def test_chat_session_agent_type_separation(tmp_db):
    """agent_type 별로 별도 session — smb session 과 github session 다름."""
    from secu_agent import state
    s_smb = state.chat_session_get_or_create(agent_type="smb")
    s_gh = state.chat_session_get_or_create(agent_type="github")
    s_smb2 = state.chat_session_get_or_create(agent_type="smb")
    assert s_smb != s_gh
    assert s_smb == s_smb2

    state.chat_message_add(s_smb, role="user", content={"text": "smb msg"})
    state.chat_message_add(s_gh, role="user", content={"text": "gh msg"})

    msg_smb = state.chat_messages_for(s_smb)
    msg_gh = state.chat_messages_for(s_gh)
    assert len(msg_smb) == 1 and msg_smb[0]["content"]["text"] == "smb msg"
    assert len(msg_gh) == 1 and msg_gh[0]["content"]["text"] == "gh msg"


def test_chat_session_default_agent_type_is_agent(tmp_db):
    """agent_type 인자 안 주면 default 'agent' — v3.82 U3b: 코어 중립 기본값."""
    from secu_agent import state
    s_default = state.chat_session_get_or_create()
    s_agent = state.chat_session_get_or_create(agent_type="agent")
    assert s_default == s_agent


def test_chat_session_new_creates_distinct(tmp_db):
    """명시적으로 새 session 시작 가능 (예: 운영자가 'reset' 했을 때)."""
    from secu_agent import state
    sid1 = state.chat_session_get_or_create()
    sid2 = state.chat_session_new()
    assert sid2 != sid1


def test_chat_message_add_and_list(tmp_db):
    from secu_agent import state
    sid = state.chat_session_get_or_create()

    state.chat_message_add(sid, role="user",
                           content={"text": "pending share 보여줘"})
    state.chat_message_add(sid, role="assistant",
                           content={"text": "지금 3개 있어"})
    state.chat_message_add(sid, role="tool_event",
                           content={"event": "ToolCallStarted",
                                    "name": "list_pending_shares"})

    msgs = state.chat_messages_for(sid)
    assert len(msgs) == 3
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"]["text"] == "pending share 보여줘"
    assert msgs[2]["role"] == "tool_event"


def test_chat_messages_for_orders_oldest_first_with_limit(tmp_db):
    """replay 위해 chronological. limit 은 최근 N 개 (오래된 거 자름)."""
    from secu_agent import state
    sid = state.chat_session_get_or_create()

    for i in range(10):
        state.chat_message_add(sid, role="user", content={"text": f"msg{i}"})

    all_msgs = state.chat_messages_for(sid)
    assert len(all_msgs) == 10
    assert all_msgs[0]["content"]["text"] == "msg0"
    assert all_msgs[-1]["content"]["text"] == "msg9"

    last_3 = state.chat_messages_for(sid, limit=3)
    assert len(last_3) == 3
    assert last_3[0]["content"]["text"] == "msg7"  # 가장 오래된 (limit 안에서)
    assert last_3[-1]["content"]["text"] == "msg9"


def test_chat_message_isolation_between_sessions(tmp_db):
    from secu_agent import state
    s1 = state.chat_session_get_or_create()
    state.chat_message_add(s1, role="user", content={"text": "in s1"})
    s2 = state.chat_session_new()
    state.chat_message_add(s2, role="user", content={"text": "in s2"})

    m1 = state.chat_messages_for(s1)
    m2 = state.chat_messages_for(s2)
    assert len(m1) == 1 and m1[0]["content"]["text"] == "in s1"
    assert len(m2) == 1 and m2[0]["content"]["text"] == "in s2"


def test_chat_session_get_or_create_picks_latest(tmp_db):
    """여러 session 있으면 가장 최근 걸 return."""
    from secu_agent import state
    s1 = state.chat_session_new()
    s2 = state.chat_session_new()
    assert state.chat_session_get_or_create() == s2


def test_chat_session_list_and_archive_agent_workspace(tmp_db):
    from secu_agent import state

    s1 = state.chat_session_new(agent_type="web", label="web dev agent")
    s2 = state.chat_session_new(agent_type="web", label="web office agent")
    state.chat_message_add(s1, role="user", content={"text": "old"})
    state.chat_message_add(s2, role="user", content={"text": "new"})

    rows = state.chat_session_list(agent_type="web")
    assert [r["id"] for r in rows] == [s2, s1]
    assert rows[0]["label"] == "web office agent"
    assert rows[0]["message_count"] == 1

    state.chat_session_update(s2, status="archived")

    assert state.chat_session_get_or_create(agent_type="web") == s1
    active_rows = state.chat_session_list(agent_type="web")
    assert [r["id"] for r in active_rows] == [s1]
    all_rows = state.chat_session_list(agent_type="web", include_archived=True)
    assert {r["id"] for r in all_rows} == {s1, s2}


def test_chat_session_new_becomes_empty_latest_for_agent_type(tmp_db):
    """새 대화 시작 시 agent_type 최신 세션이 빈 세션으로 바뀐다."""
    from secu_agent import state

    old_sid = state.chat_session_get_or_create(agent_type="web")
    state.chat_message_add(old_sid, role="user", content={"text": "old"})

    new_sid = state.chat_session_new(agent_type="web")

    assert new_sid != old_sid
    assert state.chat_session_get_or_create(agent_type="web") == new_sid
    assert state.chat_messages_for(new_sid) == []
    assert state.chat_messages_for(old_sid)[0]["content"]["text"] == "old"


def test_chat_session_delete_archives_without_removing_history(tmp_db):
    from secu_agent import state

    sid = state.chat_session_new(agent_type="agent", label="delete me")
    state.chat_message_add(sid, role="user", content={"text": "x"})
    state.chat_plan_mode_set(sid, plan={"rationale": "x", "steps": ["a"]})
    state.todo_write(
        sid,
        todos=[{"id": "a", "content": "todo", "status": "pending"}],
    )
    state.goal_set(sid, goal_text="goal")
    sched = state.schedule_create(
        agent_type="agent",
        prompt="scheduled",
        cron_expr="@once",
        next_run=1.0,
        origin="operator_agent",
        source_session_id=sid,
        source_message_id=1,
    )
    state.approval_audit_record_request(
        approval_id="appr-delete",
        session_id=sid,
        agent_type="agent",
        actor="tester",
        tool_name="tool",
        tool_input={},
        reason="test",
    )

    assert state.chat_session_delete(sid) is True
    row = state.chat_session_get(sid)
    assert row is not None
    assert row["status"] == "archived"
    assert row["archived_at"] is not None
    assert state.chat_messages_for(sid)[0]["content"]["text"] == "x"
    assert state.chat_plan_mode_get(sid)["active"] is True
    assert state.todo_read(sid)[0]["content"] == "todo"
    assert state.goal_get_active(sid)["goal_text"] == "goal"
    assert state.schedule_get(sched)["source_session_id"] == sid
    assert state.approval_audit_get("appr-delete")["session_id"] == sid
    assert state.chat_session_delete(sid) is True


def test_chat_plan_mode_state_persists_and_clears(tmp_db):
    from secu_agent import state

    sid = state.chat_session_get_or_create()
    plan = {
        "rationale": "전체 웹 점검 전 승인",
        "steps": ["crawl", "probe"],
        "estimated_minutes": 30,
    }

    state.chat_plan_mode_set(sid, plan=plan)
    active = state.chat_plan_mode_get(sid)
    assert active["active"] is True
    assert active["plan"] == plan
    assert active["last_summary"] is None

    state.chat_plan_mode_clear(sid, summary="crawl/probe 완료")
    cleared = state.chat_plan_mode_get(sid)
    assert cleared["active"] is False
    assert cleared["plan"] is None
    assert cleared["last_summary"] == "crawl/probe 완료"


def test_chat_plan_mode_status_transitions(tmp_db):
    from secu_agent import state

    sid = state.chat_session_get_or_create()
    plan = {
        "rationale": "웹 점검 승인",
        "steps": ["crawl", "probe"],
        "estimated_minutes": 10,
    }

    state.chat_plan_mode_set(sid, plan=plan)
    approved = state.chat_plan_mode_get(sid)
    assert approved["active"] is True
    assert approved["status"] == "approved"
    assert approved["started_at"] is None
    assert approved["finished_at"] is None

    state.chat_plan_mode_mark_executing(sid)
    executing = state.chat_plan_mode_get(sid)
    assert executing["active"] is True
    assert executing["status"] == "executing"
    assert executing["started_at"] is not None

    state.chat_plan_mode_clear(sid, summary="완료")
    completed = state.chat_plan_mode_get(sid)
    assert completed["active"] is False
    assert completed["status"] == "completed"
    assert completed["finished_at"] is not None


def test_chat_plan_mode_mark_failed(tmp_db):
    from secu_agent import state

    sid = state.chat_session_get_or_create()
    state.chat_plan_mode_set(sid, plan={"rationale": "x", "steps": ["a"]})
    state.chat_plan_mode_mark_failed(sid, summary="tool loop halted")

    failed = state.chat_plan_mode_get(sid)
    assert failed["active"] is False
    assert failed["status"] == "failed"
    assert failed["last_summary"] == "tool loop halted"
