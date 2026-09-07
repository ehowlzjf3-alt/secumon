"""v3.42 F3: 새 user turn 시작 시 직전 진행 상태 brief auto-inject.

라이브 케이스 (session 7, 2026-05-18 10:14):
- agent 가 12.25.146.0/24 walk 중 두 번 연속 에러로 멈춤
- 사용자: "왜 끊겼어"
- agent 가 컨텍스트 무시하고 처음부터 다시 시작 (todo 12개 새로 + scan_start)

이 모듈은 chat session 의 직전 상태 (active todo + 최근 도구 결과 + halt 사유 등) 를
짧은 brief 로 만들어 새 user 메시지 앞에 system note 형태로 inject.
agent 가 "처음부터 다시" 가 아니라 "직전 작업 회복" 으로 응답하게 유도.

핵심: brief 는 reminder 일 뿐 LLM 이 그대로 따를 의무 없음. 단 "직전 진행 상태가 있다"
는 신호를 명확히 전달.
"""
from __future__ import annotations

import os
from typing import Any

from secu_agent import state

_BRIEF_HEAD = "[직전 진행 상태 brief — 이 turn 의 사용자 의도가 'reset' 이 아니면 회복 우선]"

_DEFAULT_BRIEF_MAX_MESSAGES = 200


def _brief_max_messages() -> int:
    """brief 가 훑을 최근 chat_message 상한 (SA_CONTEXT_BRIEF_MAX_MESSAGES).

    brief 는 '가장 최근 user turn 이후' 의 bg completion 만 필요하므로 전체
    history 를 매 turn 로드할 필요가 없다. 상한을 두어 O(history) 를 O(1) 로 묶는다.
    안전 default(200) 은 현실적인 last-user-turn 창을 충분히 덮는다.
    잘못된/음수 값이면 default 로 fallback.
    """
    raw = (os.environ.get("SA_CONTEXT_BRIEF_MAX_MESSAGES") or "").strip()
    if not raw:
        return _DEFAULT_BRIEF_MAX_MESSAGES
    try:
        val = int(raw)
    except (TypeError, ValueError):
        return _DEFAULT_BRIEF_MAX_MESSAGES
    if val <= 0:
        return _DEFAULT_BRIEF_MAX_MESSAGES
    return val


def _todo_summary(session_id: int) -> str | None:
    todos = state.todo_read(session_id)
    if not todos:
        return None
    counts = {"pending": 0, "in_progress": 0, "completed": 0, "cancelled": 0}
    in_progress: list[str] = []
    for t in todos:
        status = t.get("status", "pending")
        counts[status] = counts.get(status, 0) + 1
        if status == "in_progress":
            in_progress.append(str(t.get("content", "")))
    total = len(todos)
    parts = [
        f"todo: {total} items "
        f"(pending={counts['pending']}, in_progress={counts['in_progress']}, "
        f"completed={counts['completed']}"
        + (f", cancelled={counts['cancelled']}" if counts['cancelled'] else "")
        + ")"
    ]
    if in_progress:
        parts.append("  진행중: " + "; ".join(in_progress[:3]))
    return "\n".join(parts)


def _last_tool_summary(metadata: dict[str, Any]) -> str | None:
    """RepeatErrorState 의 직전 에러 fingerprint 가 있으면 보고."""
    sig = metadata.get("_repeat_error_sig")
    count = int(metadata.get("_repeat_error_count", 0))
    if not sig or count <= 0:
        return None
    parts = sig.split("|", 2)
    if len(parts) == 3:
        tool, kind, msg = parts
        return (
            f"직전 도구 `{tool}` 에러 ({kind}) {count}회: {msg[:120]}"
        )
    return f"직전 에러 sig={sig} count={count}"


def _bg_completion_summary(session_id: int) -> str | None:
    """v3.43-P5: 최근 bg_task_completed system 메시지 흡수.

    chat_message system role 안에 dict 형태로 박힌 completion 들을 골라 짧게 요약.
    """
    # perf: 전체 history 대신 최근 N 개만 로드 (bg completion 은 last-user-turn
    # 이후, 즉 가장 최근 창에만 존재하므로 상한 로드로 출력 동일성 유지).
    msgs = state.chat_messages_for(session_id, limit=_brief_max_messages())
    # 가장 최근 user 메시지 이후 들어온 bg completion 만
    last_user_idx = -1
    for i, m in enumerate(msgs):
        if m["role"] == "user":
            last_user_idx = i
    candidates = msgs[last_user_idx + 1:] if last_user_idx >= 0 else msgs
    bg = []
    for m in candidates:
        if m["role"] != "system":
            continue
        c = m.get("content")
        if isinstance(c, dict) and c.get("event") == "bg_task_completed":
            bg.append(c)
    if not bg:
        return None
    parts = [f"직전 백그라운드 작업 {len(bg)}개 완료:"]
    for c in bg[:5]:
        cmd = c.get("command", "?")[:80]
        ec = c.get("exit_code")
        dur = c.get("duration_sec")
        tail = c.get("output_tail", "").strip().splitlines()[-1:]
        tail_str = f" tail: {tail[0][:80]}" if tail else ""
        parts.append(
            f"  - [{c.get('process_id')}] exit={ec} dur={dur}s `{cmd}`{tail_str}"
        )
    return "\n".join(parts)


def _goal_summary(session_id: int) -> str | None:
    """active goal 있으면 미완료 checklist 요약."""
    goal = state.goal_get_active(session_id)
    if not goal:
        return None
    items = goal.get("checklist") or []
    criteria = goal.get("criteria") or []
    criteria_text = ""
    if criteria:
        criteria_text = " — criteria: " + "; ".join(str(c)[:80] for c in criteria[:3])
    if not items:
        return f"goal active: {goal['goal_text'][:80]} (아직 decompose 전){criteria_text}"
    pending = sum(1 for it in items if it.get("status") == "pending")
    done = sum(1 for it in items if it.get("status") == "completed")
    return (
        f"goal active: {goal['goal_text'][:80]} — "
        f"checklist {done}/{len(items)} 완료, pending {pending}"
        f"{criteria_text}"
    )


def build_context_brief(
    session_id: int, metadata: dict[str, Any]
) -> str | None:
    """직전 진행 brief 생성. 아무것도 없으면 None.

    Output 예:
        [직전 진행 상태 brief — ...]
        todo: 12 items (pending=4, in_progress=1, completed=7)
          진행중: 12.25.146 walk 완료
        직전 도구 `smb_python` 에러 (exc:AttributeError) 2회: 'Hit' object has no attribute 'preview'
        goal active: 11.106 점검 끝까지 — checklist 5/8 완료, pending 3
    """
    blocks: list[str] = []
    todo = _todo_summary(session_id)
    if todo:
        blocks.append(todo)
    err = _last_tool_summary(metadata)
    if err:
        blocks.append(err)
    bg = _bg_completion_summary(session_id)
    if bg:
        blocks.append(bg)
    goal = _goal_summary(session_id)
    if goal:
        blocks.append(goal)
    if not blocks:
        return None
    return _BRIEF_HEAD + "\n" + "\n".join(blocks)
