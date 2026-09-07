"""v3.42 F3: context_brief 단위 테스트."""
from __future__ import annotations

from secu_agent import state
from secu_agent.agent.context_brief import build_context_brief


def test_brief_empty_when_no_state(tmp_db):
    sid = state.chat_session_get_or_create()
    assert build_context_brief(sid, {}) is None


def test_brief_includes_todo_summary(tmp_db):
    sid = state.chat_session_get_or_create()
    state.todo_write(sid, todos=[
        {"id": "1", "content": "subnet discovery", "status": "completed"},
        {"id": "2", "content": "walk shares", "status": "in_progress"},
        {"id": "3", "content": "review hits", "status": "pending"},
        {"id": "4", "content": "submit findings", "status": "pending"},
    ])
    out = build_context_brief(sid, {})
    assert out is not None
    assert "todo: 4 items" in out
    assert "completed=1" in out
    assert "in_progress=1" in out
    assert "pending=2" in out
    assert "walk shares" in out  # in_progress 항목


def test_brief_includes_last_error(tmp_db):
    sid = state.chat_session_get_or_create()
    metadata = {
        "_repeat_error_sig": "smb_python|exc:AttributeError|'Hit' object has no attribute 'preview'",
        "_repeat_error_count": 2,
    }
    out = build_context_brief(sid, metadata)
    assert out is not None
    assert "smb_python" in out
    assert "AttributeError" in out
    assert "preview" in out


def test_brief_includes_active_goal(tmp_db):
    sid = state.chat_session_get_or_create()
    gid = state.goal_set(sid, goal_text="11.106 전체 점검", max_turns=10)
    state.goal_update_checklist(gid, checklist=[
        {"text": "A", "status": "completed"},
        {"text": "B", "status": "completed"},
        {"text": "C", "status": "pending"},
    ], decomposed=True)
    out = build_context_brief(sid, {})
    assert out is not None
    assert "goal active" in out
    assert "11.106" in out
    assert "2/3" in out  # completed/total


def test_brief_includes_goal_criteria(tmp_db):
    sid = state.chat_session_get_or_create()
    state.goal_set(sid, goal_text="G", max_turns=5)
    state.goal_add_criteria(sid, "발견사항 기반 추가 분석")
    out = build_context_brief(sid, {})
    assert out is not None
    assert "criteria:" in out
    assert "발견사항 기반 추가 분석" in out


def test_brief_includes_bg_completions_after_last_user_turn(tmp_db):
    """v3.43-P5: 직전 user 메시지 이후 들어온 bg_task_completed system msg 흡수."""
    sid = state.chat_session_get_or_create()
    # 사용자 메시지 1
    state.chat_message_add(sid, role="user", content={"text": "start scan"})
    # 그 후 bg 완료 2개
    state.chat_message_add(sid, role="system", content={
        "event": "bg_task_completed",
        "process_id": "proc_x",
        "command": "long scan A",
        "exit_code": 0,
        "duration_sec": 12.3,
        "output_tail": "DONE: 3 findings\n",
    })
    state.chat_message_add(sid, role="system", content={
        "event": "bg_task_completed",
        "process_id": "proc_y",
        "command": "long scan B",
        "exit_code": 1,
        "duration_sec": 4.2,
        "output_tail": "Error: timeout\n",
    })
    out = build_context_brief(sid, {})
    assert out is not None
    assert "백그라운드 작업 2개 완료" in out
    assert "proc_x" in out
    assert "proc_y" in out
    assert "long scan A" in out
    assert "DONE: 3 findings" in out


def test_brief_skips_bg_completions_before_last_user_turn(tmp_db):
    """직전 user 메시지 *전*의 bg 는 흡수 안 함 (이미 처리됨)."""
    sid = state.chat_session_get_or_create()
    state.chat_message_add(sid, role="system", content={
        "event": "bg_task_completed",
        "process_id": "old_proc", "command": "old", "exit_code": 0,
        "duration_sec": 1.0, "output_tail": "old\n",
    })
    state.chat_message_add(sid, role="user", content={"text": "처리됨"})
    # 이후 새 bg 없음
    out = build_context_brief(sid, {})
    # old_proc 안 보여야
    assert out is None or "old_proc" not in out


def test_brief_combines_all_three_when_all_present(tmp_db):
    sid = state.chat_session_get_or_create()
    state.todo_write(sid, todos=[
        {"id": "1", "content": "T", "status": "pending"},
    ])
    state.goal_set(sid, goal_text="G", max_turns=5)
    out = build_context_brief(sid, {
        "_repeat_error_sig": "x|err:y|z",
        "_repeat_error_count": 1,
    })
    assert out is not None
    assert "todo:" in out
    assert "직전 도구" in out
    assert "goal active" in out
