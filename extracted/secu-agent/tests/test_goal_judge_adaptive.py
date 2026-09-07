"""F2 adaptive judge routing — 판정 복잡도에 맞춘 출력 예산(max_tokens) 조정.

effort 는 low 고정(파싱 안전 불변식)이라 난이도 적응은 출력 예산으로 한다: 큰 checklist/
긴 증거는 예산을 상향해 truncation 파싱실패를 막고, 작은 판정은 base 유지.
"""
from __future__ import annotations

import asyncio

from secu_agent.agent.goal_manager import (
    _JUDGE_MAX_TOKENS_BASE,
    _adaptive_judge_max_tokens,
    _judge_max_tokens_cap,
    ChecklistItem,
    evaluate,
)
from secu_agent.agent import goal_manager as gm


def _run(coro):
    return asyncio.run(coro)


# ── 단위: _adaptive_judge_max_tokens ────────────────────────────────────────

def test_small_judgment_uses_base():
    assert _adaptive_judge_max_tokens(checklist_len=1, evidence_chars=0) == _JUDGE_MAX_TOKENS_BASE
    assert _adaptive_judge_max_tokens(checklist_len=0, evidence_chars=0) == _JUDGE_MAX_TOKENS_BASE


def test_large_checklist_scales_up():
    small = _adaptive_judge_max_tokens(checklist_len=2, evidence_chars=0)
    large = _adaptive_judge_max_tokens(checklist_len=40, evidence_chars=0)
    assert large > small
    assert large > _JUDGE_MAX_TOKENS_BASE


def test_long_evidence_scales_up():
    base = _adaptive_judge_max_tokens(checklist_len=1, evidence_chars=0)
    withev = _adaptive_judge_max_tokens(checklist_len=1, evidence_chars=6000)
    assert withev > base


def test_capped_at_max(monkeypatch):
    monkeypatch.delenv("SA_GOAL_JUDGE_MAX_TOKENS", raising=False)
    huge = _adaptive_judge_max_tokens(checklist_len=100000, evidence_chars=10_000_000)
    assert huge == _judge_max_tokens_cap()


def test_never_below_base():
    assert _adaptive_judge_max_tokens(checklist_len=-5, evidence_chars=-5) >= _JUDGE_MAX_TOKENS_BASE


def test_cap_env_override(monkeypatch):
    monkeypatch.setenv("SA_GOAL_JUDGE_MAX_TOKENS", "10000")
    assert _judge_max_tokens_cap() == 10000
    # 아무리 커도 override 한 cap 을 넘지 않음.
    assert _adaptive_judge_max_tokens(checklist_len=100000, evidence_chars=0) == 10000


def test_cap_env_floors_at_base(monkeypatch):
    monkeypatch.setenv("SA_GOAL_JUDGE_MAX_TOKENS", "100")  # base 미만
    assert _judge_max_tokens_cap() == _JUDGE_MAX_TOKENS_BASE


def test_cap_env_invalid_falls_back(monkeypatch):
    monkeypatch.setenv("SA_GOAL_JUDGE_MAX_TOKENS", "not-int")
    assert _judge_max_tokens_cap() >= _JUDGE_MAX_TOKENS_BASE


# ── 통합: evaluate 가 adaptive 예산을 _judge_call 로 넘긴다 ───────────────────

def test_evaluate_passes_adaptive_budget(monkeypatch):
    seen = {}

    async def fake_judge_call(*, client, system_prompt, user_text, max_tokens=8192):
        seen["max_tokens"] = max_tokens
        return '{"updates": [], "new_items": [], "reason": "ok"}'

    monkeypatch.setattr(gm, "_judge_call", fake_judge_call)

    big_checklist = [ChecklistItem(text=f"item {i}") for i in range(50)]
    r = _run(evaluate(
        client=object(), goal_text="x", checklist=big_checklist,
        assistant_text="working", evidence_digest="- [high] web @ x: y" * 100,
    ))
    assert not r.parse_failed
    assert seen["max_tokens"] > _JUDGE_MAX_TOKENS_BASE  # 큰 판정 → 예산 상향


def test_evaluate_small_uses_base_budget(monkeypatch):
    seen = {}

    async def fake_judge_call(*, client, system_prompt, user_text, max_tokens=8192):
        seen["max_tokens"] = max_tokens
        return '{"updates": [], "new_items": [], "reason": "ok"}'

    monkeypatch.setattr(gm, "_judge_call", fake_judge_call)
    r = _run(evaluate(
        client=object(), goal_text="x",
        checklist=[ChecklistItem(text="only one")],
        assistant_text="working",
    ))
    assert not r.parse_failed
    assert seen["max_tokens"] == _JUDGE_MAX_TOKENS_BASE  # 작은 판정 → base
