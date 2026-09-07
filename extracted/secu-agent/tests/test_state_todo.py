"""chat_todo 영속 layer — operator agent 가 큰 작업 plan 짜고 순차 진행.

설계:
- chat_session_id 기준으로 scope — 각 chat session 마다 별도 todo list.
- item: id (agent 가 고름) + content + status + position (order).
- write 모드 2가지: replace (전체 교체) / merge (id 매칭 update + append).
- chronological 순서 유지 — position 으로.
"""
from __future__ import annotations


def test_todo_write_creates_items(tmp_db):
    from secu_agent import state
    sid = state.chat_session_get_or_create(agent_type="smb")
    items = state.todo_write(sid, todos=[
        {"id": "1", "content": "subnets 198.51.100.x 배치", "status": "pending"},
        {"id": "2", "content": "subnets 10.125.x 배치", "status": "pending"},
    ])
    assert len(items) == 2
    assert items[0]["id"] == "1"
    assert items[0]["content"] == "subnets 198.51.100.x 배치"
    assert items[0]["status"] == "pending"


def test_todo_read_returns_chronological(tmp_db):
    from secu_agent import state
    sid = state.chat_session_get_or_create(agent_type="smb")
    state.todo_write(sid, todos=[
        {"id": "a", "content": "first"},
        {"id": "b", "content": "second"},
        {"id": "c", "content": "third"},
    ])
    items = state.todo_read(sid)
    assert [i["id"] for i in items] == ["a", "b", "c"]


def test_todo_replace_mode_clears_existing(tmp_db):
    from secu_agent import state
    sid = state.chat_session_get_or_create(agent_type="smb")
    state.todo_write(sid, todos=[{"id": "old1"}, {"id": "old2"}])
    state.todo_write(sid, todos=[{"id": "new1"}], merge=False)
    items = state.todo_read(sid)
    assert [i["id"] for i in items] == ["new1"]


def test_todo_merge_mode_updates_existing_appends_new(tmp_db):
    from secu_agent import state
    sid = state.chat_session_get_or_create(agent_type="smb")
    state.todo_write(sid, todos=[
        {"id": "1", "content": "old1", "status": "pending"},
        {"id": "2", "content": "old2", "status": "pending"},
    ])
    state.todo_write(sid, merge=True, todos=[
        {"id": "1", "status": "in_progress"},        # update status
        {"id": "3", "content": "new3"},              # append
    ])
    items = state.todo_read(sid)
    by_id = {i["id"]: i for i in items}
    assert by_id["1"]["status"] == "in_progress"
    assert by_id["1"]["content"] == "old1"  # not erased
    assert by_id["2"]["status"] == "pending"  # untouched
    assert by_id["3"]["content"] == "new3"
    assert [i["id"] for i in items] == ["1", "2", "3"]


def test_todo_invalid_status_falls_back_to_pending(tmp_db):
    from secu_agent import state
    sid = state.chat_session_get_or_create(agent_type="smb")
    state.todo_write(sid, todos=[
        {"id": "1", "content": "x", "status": "bogus"},
    ])
    assert state.todo_read(sid)[0]["status"] == "pending"


def test_todo_blocked_status_is_persisted(tmp_db):
    from secu_agent import state
    sid = state.chat_session_get_or_create(agent_type="smb")
    state.todo_write(sid, todos=[
        {"id": "1", "content": "cannot continue", "status": "blocked"},
    ])

    assert state.todo_read(sid)[0]["status"] == "blocked"


def test_todo_session_isolation(tmp_db):
    from secu_agent import state
    s1 = state.chat_session_get_or_create(agent_type="smb")
    s2 = state.chat_session_new(agent_type="smb")
    state.todo_write(s1, todos=[{"id": "for-s1", "content": "x"}])
    state.todo_write(s2, todos=[{"id": "for-s2", "content": "y"}])
    assert [i["id"] for i in state.todo_read(s1)] == ["for-s1"]
    assert [i["id"] for i in state.todo_read(s2)] == ["for-s2"]


def test_todo_clear(tmp_db):
    from secu_agent import state
    sid = state.chat_session_get_or_create(agent_type="smb")
    state.todo_write(sid, todos=[{"id": "1"}])
    state.todo_clear(sid)
    assert state.todo_read(sid) == []


def test_todo_dedupe_by_id_within_same_write(tmp_db):
    """같은 id 두번 들어오면 마지막 것 우선 (hermes 패턴 lift)."""
    from secu_agent import state
    sid = state.chat_session_get_or_create(agent_type="smb")
    state.todo_write(sid, todos=[
        {"id": "1", "content": "first"},
        {"id": "1", "content": "last"},
    ])
    items = state.todo_read(sid)
    assert len(items) == 1
    assert items[0]["content"] == "last"
