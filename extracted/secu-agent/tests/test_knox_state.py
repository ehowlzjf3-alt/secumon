"""knox_room_session 매핑 테이블 + get_or_create 헬퍼."""
from __future__ import annotations

from secu_agent import state


def test_get_or_create_creates_session_and_mapping(tmp_db):
    sid = state.knox_room_session_get_or_create(
        "205186313073722368", agent_type="smb", charter_ref="CHG-1",
    )
    assert isinstance(sid, int)
    # chat_session 행이 knox source 로 생성됨
    row = state.chat_session_get(sid)
    assert row is not None
    assert row["agent_type"] == "smb"
    assert row["source"] == "knox"
    # 매핑이 영속됨
    m = state.knox_room_session_get("205186313073722368")
    assert m is not None
    assert m["session_id"] == sid
    assert m["charter_ref"] == "CHG-1"
    assert m["agent_type"] == "smb"


def test_get_or_create_is_idempotent_per_room(tmp_db):
    a = state.knox_room_session_get_or_create("room-A", agent_type="smb", charter_ref="CHG-1")
    b = state.knox_room_session_get_or_create("room-A", agent_type="smb", charter_ref="CHG-1")
    assert a == b  # 같은 방 → 같은 세션 재사용 (컨텍스트 누적)


def test_distinct_rooms_get_distinct_sessions(tmp_db):
    a = state.knox_room_session_get_or_create("room-A", agent_type="smb", charter_ref="CHG-1")
    b = state.knox_room_session_get_or_create("room-B", agent_type="github", charter_ref="CHG-2")
    assert a != b
    assert state.knox_room_session_get("room-B")["agent_type"] == "github"


def test_get_missing_returns_none(tmp_db):
    assert state.knox_room_session_get("nope") is None
