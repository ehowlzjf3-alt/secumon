"""v3.35-B: GoalManager.decompose — Phase A 단위 테스트."""
from __future__ import annotations

import asyncio
import json

from secu_agent.agent.eval.scripted_llm import (
    ScriptedLLMClient, ScriptedTurn,
)
from secu_agent.agent.goal_manager import (
    ITEM_PENDING, ADDED_BY_FALLBACK, ADDED_BY_JUDGE, DECOMPOSE_SYSTEM_PROMPT,
    decompose, fallback_decompose,
)


def _run(coro):
    return asyncio.run(coro)


def test_decompose_parses_valid_json():
    raw = json.dumps({
        "checklist": [
            {"text": "subnet 203.0.113.0/24 alive host 카운트 보고"},
            {"text": "share 권한 측정 (null/guest/auth 3모드)"},
            {"text": "accessible share walk + 의심 파일 fetch"},
            {"text": "detectors.scan_text 결과 file_finding 저장"},
            {"text": "사용자 보고: severity 별 카운트 + 다음 액션"},
        ]
    })
    client = ScriptedLLMClient([ScriptedTurn(text=raw, stop_reason="end_turn")])
    result = _run(decompose(client=client, goal_text="203.0.113.0/24 점검"))
    assert not result.parse_failed
    assert len(result.items) == 5
    assert result.items[0].text.startswith("subnet 203.0.113.0/24")
    assert result.items[0].status == ITEM_PENDING
    assert result.items[0].added_by == ADDED_BY_JUDGE


def test_decompose_system_prompt_is_domain_neutral():
    forbidden = ("SMB", "subnet", "share 권한", "detectors.scan_text")
    assert not any(term in DECOMPOSE_SYSTEM_PROMPT for term in forbidden)


def test_decompose_extracts_json_from_surrounding_text():
    """judge LLM 이 가끔 '여기 답변:\\n{json}' 같이 wrap 해서 보냄."""
    raw = (
        "Here is the checklist:\n"
        '{"checklist": [{"text": "step 1"}, {"text": "step 2"}, {"text": "step 3"}]}'
        "\n\n끝."
    )
    client = ScriptedLLMClient([ScriptedTurn(text=raw)])
    result = _run(decompose(client=client, goal_text="x"))
    assert not result.parse_failed
    assert len(result.items) == 3


def test_decompose_parse_failed_on_garbage():
    client = ScriptedLLMClient([ScriptedTurn(text="이건 JSON 아님")])
    result = _run(decompose(client=client, goal_text="x"))
    assert result.parse_failed
    assert result.items == []


def test_decompose_parse_failed_on_empty_checklist():
    """checklist 가 빈 배열이면 못 쓴 것 — fail."""
    raw = '{"checklist": []}'
    client = ScriptedLLMClient([ScriptedTurn(text=raw)])
    result = _run(decompose(client=client, goal_text="x"))
    assert result.parse_failed


def test_decompose_skips_invalid_entries():
    raw = json.dumps({
        "checklist": [
            {"text": "good item 1"},
            {"text": ""},          # 빈 텍스트 skip
            123,                    # text 로 해석 불가한 entry skip
            {"text": "good item 2"},
        ]
    })
    client = ScriptedLLMClient([ScriptedTurn(text=raw)])
    result = _run(decompose(client=client, goal_text="x"))
    assert not result.parse_failed
    assert len(result.items) == 2
    assert result.items[0].text == "good item 1"
    assert result.items[1].text == "good item 2"


def test_decompose_accepts_string_entries():
    raw = json.dumps({"checklist": ["step 1", "step 2"]})
    client = ScriptedLLMClient([ScriptedTurn(text=raw)])
    result = _run(decompose(client=client, goal_text="x"))
    assert not result.parse_failed
    assert [item.text for item in result.items] == ["step 1", "step 2"]


def test_fallback_decompose_returns_checklist():
    result = fallback_decompose("전체 SMB 대상을 순차적으로 점검", raw="not json")
    assert not result.parse_failed
    assert len(result.items) >= 5
    assert all(item.status == ITEM_PENDING for item in result.items)
    assert all(item.added_by == ADDED_BY_FALLBACK for item in result.items)
    assert "SMB" in result.items[0].text


def test_decompose_preserves_fallback_added_by_roundtrip():
    from secu_agent.agent.goal_manager import ChecklistItem

    item = ChecklistItem.from_dict({
        "text": "fallback item",
        "status": "pending",
        "added_by": ADDED_BY_FALLBACK,
    })

    assert item.added_by == ADDED_BY_FALLBACK
