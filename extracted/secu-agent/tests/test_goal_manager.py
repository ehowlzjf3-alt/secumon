"""v3.51-H4: goal_manager unit tests — decompose JSON parsing, apply_evaluate,
counters, continuation prompt."""
from __future__ import annotations

import pytest

from secu_agent.agent.goal_manager import (
    ADDED_BY_JUDGE,
    ChecklistItem,
    DecomposeResult,
    EvaluateResult,
    ITEM_COMPLETED,
    ITEM_IMPOSSIBLE,
    ITEM_PENDING,
    _extract_json_object,
    all_terminal,
    apply_evaluate,
    build_continuation_prompt,
    count_completed,
    count_pending,
)


# ─── _extract_json_object ──────────────────────────────────


def test_extract_json_passthrough():
    assert _extract_json_object('{"a": 1}') == {"a": 1}


def test_extract_json_embedded():
    s = "blah blah {\"checklist\": []} trailing"
    assert _extract_json_object(s) == {"checklist": []}


def test_extract_json_skips_non_json_braces():
    s = "example {not json} then {\"checklist\": [{\"text\": \"ok\"}]}"
    assert _extract_json_object(s) == {"checklist": [{"text": "ok"}]}


def test_extract_json_none_on_empty():
    assert _extract_json_object("") is None


def test_extract_json_none_on_garbage():
    assert _extract_json_object("just text no json") is None


def test_extract_json_array_root_returns_none():
    """root 가 array 면 dict 아니라 None 반환."""
    assert _extract_json_object("[1,2,3]") is None


# ─── ChecklistItem ─────────────────────────────────────────


def test_checklist_item_roundtrip():
    it = ChecklistItem(text="hello", status=ITEM_COMPLETED,
                       added_by=ADDED_BY_JUDGE, added_at=1.0,
                       completed_at=2.0, evidence="ev")
    d = it.to_dict()
    back = ChecklistItem.from_dict(d)
    assert back == it


def test_from_dict_invalid_status_falls_back():
    back = ChecklistItem.from_dict({"text": "x", "status": "weird"})
    assert back.status == ITEM_PENDING


def test_from_dict_empty_text_becomes_placeholder():
    back = ChecklistItem.from_dict({"text": ""})
    assert back.text == "(empty)"


# ─── apply_evaluate ────────────────────────────────────────


def test_apply_evaluate_flips_pending_to_completed():
    checklist = [
        ChecklistItem(text="a"),
        ChecklistItem(text="b"),
        ChecklistItem(text="c"),
    ]
    result = EvaluateResult(updates=[
        {"index": 1, "status": ITEM_COMPLETED, "evidence": "e1"},
        {"index": 3, "status": ITEM_IMPOSSIBLE, "evidence": "no host"},
    ])
    out, flipped = apply_evaluate(checklist, result)
    assert flipped == 2
    assert out[0].status == ITEM_COMPLETED
    assert out[0].evidence == "e1"
    assert out[0].completed_at is not None
    assert out[1].status == ITEM_PENDING  # untouched
    assert out[2].status == ITEM_IMPOSSIBLE


def test_apply_evaluate_does_not_reflip_terminal():
    checklist = [ChecklistItem(text="done already", status=ITEM_COMPLETED)]
    result = EvaluateResult(updates=[
        {"index": 1, "status": ITEM_PENDING, "evidence": "wat"},
    ])
    out, flipped = apply_evaluate(checklist, result)
    assert flipped == 0
    assert out[0].status == ITEM_COMPLETED


def test_apply_evaluate_appends_new_items():
    checklist = [ChecklistItem(text="orig")]
    result = EvaluateResult(
        updates=[],
        new_items=[ChecklistItem(text="new1"), ChecklistItem(text="new2")],
    )
    out, _ = apply_evaluate(checklist, result)
    assert len(out) == 3
    assert out[1].text == "new1"
    assert out[2].text == "new2"


# audit #5: new_items dedup + 크기 상한 (무진전 종료 갭 차단)

def test_apply_evaluate_dedups_reemitted_item_no_growth():
    # judge 가 기존 항목을 (대소문자/공백만 다르게) 재방출 → 추가 없음(added=0).
    checklist = [ChecklistItem(text="Scan host A")]
    result = EvaluateResult(
        updates=[],
        new_items=[ChecklistItem(text="  scan   host a ")],
    )
    out, _ = apply_evaluate(checklist, result)
    assert len(out) == len(checklist)  # 순증 0 → ralph 가 무진전으로 판정


def test_apply_evaluate_dedups_within_new_items_and_keeps_distinct():
    checklist = [ChecklistItem(text="orig")]
    result = EvaluateResult(
        updates=[],
        new_items=[
            ChecklistItem(text="dup"),
            ChecklistItem(text="DUP"),
            ChecklistItem(text="fresh"),
            ChecklistItem(text=""),  # 공백은 무시
        ],
    )
    out, _ = apply_evaluate(checklist, result)
    texts = [it.text for it in out]
    assert texts == ["orig", "dup", "fresh"]


def test_apply_evaluate_enforces_checklist_cap(monkeypatch):
    monkeypatch.setenv("SA_GOAL_CHECKLIST_MAX", "3")
    checklist = [ChecklistItem(text="a"), ChecklistItem(text="b")]
    result = EvaluateResult(
        updates=[],
        new_items=[ChecklistItem(text="c"), ChecklistItem(text="d"), ChecklistItem(text="e")],
    )
    out, _ = apply_evaluate(checklist, result)
    assert len(out) == 3  # 상한에서 멈춤 → 이후 턴 added=0 → 안전 pause 발동 가능
    assert [it.text for it in out] == ["a", "b", "c"]


# ─── counters ──────────────────────────────────────────────


def test_count_pending_and_completed():
    cl = [
        ChecklistItem(text="a", status=ITEM_PENDING),
        ChecklistItem(text="b", status=ITEM_COMPLETED),
        ChecklistItem(text="c", status=ITEM_IMPOSSIBLE),
        ChecklistItem(text="d", status=ITEM_PENDING),
    ]
    assert count_pending(cl) == 2
    assert count_completed(cl) == 1


def test_all_terminal_true_when_no_pending():
    cl = [
        ChecklistItem(text="a", status=ITEM_COMPLETED),
        ChecklistItem(text="b", status=ITEM_IMPOSSIBLE),
    ]
    assert all_terminal(cl) is True


def test_all_terminal_false_with_pending():
    cl = [
        ChecklistItem(text="a", status=ITEM_COMPLETED),
        ChecklistItem(text="b", status=ITEM_PENDING),
    ]
    assert all_terminal(cl) is False


def test_all_terminal_false_when_empty():
    """빈 list 는 not terminal (goal 시작도 안 한 상태)."""
    assert all_terminal([]) is False


# ─── continuation prompt ───────────────────────────────────


def test_build_continuation_prompt_includes_goal_and_checklist():
    cl = [
        ChecklistItem(text="step1", status=ITEM_COMPLETED),
        ChecklistItem(text="step2", status=ITEM_PENDING),
    ]
    prompt = build_continuation_prompt("task 12.25.146.0/24", cl,
                                       criteria=["high severity only"])
    assert "12.25.146.0/24" in prompt
    assert "1/2 완료" in prompt
    assert "step1" in prompt
    assert "step2" in prompt
    assert "high severity only" in prompt


def test_build_continuation_prompt_no_criteria():
    cl = [ChecklistItem(text="x")]
    prompt = build_continuation_prompt("g", cl, criteria=None)
    assert "추가 criteria 없음" in prompt
