"""v3.35-C: GoalManager.evaluate / apply_evaluate — Phase B 단위 테스트."""
from __future__ import annotations

import asyncio
import json

from secu_agent.agent.eval.scripted_llm import (
    ScriptedLLMClient, ScriptedTurn,
)
from secu_agent.agent.goal_manager import (
    ChecklistItem, ITEM_COMPLETED, ITEM_IMPOSSIBLE, ITEM_PENDING,
    all_terminal, apply_evaluate, build_continuation_prompt, count_completed,
    count_pending, evaluate,
)


def _run(coro):
    return asyncio.run(coro)


def _pending(text: str) -> ChecklistItem:
    return ChecklistItem(text=text, status=ITEM_PENDING)


def test_evaluate_parses_updates_and_new_items():
    raw = json.dumps({
        "updates": [
            {"index": 1, "status": "completed", "evidence": "Added 152"},
            {"index": 2, "status": "impossible", "evidence": "no auth"},
        ],
        "new_items": [{"text": "추가 검증 - severity 보고"}],
        "reason": "agent showed bulk add output",
    })
    client = ScriptedLLMClient([ScriptedTurn(text=raw)])
    cl = [_pending("subnet add"), _pending("share walk")]
    r = _run(evaluate(client=client, goal_text="x", checklist=cl,
                     assistant_text="Added 152 subnets"))
    assert not r.parse_failed
    assert len(r.updates) == 2
    assert r.updates[0]["index"] == 1
    assert r.updates[0]["status"] == "completed"
    assert len(r.new_items) == 1


def test_evaluate_prompt_includes_user_criteria():
    class CapturingClient(ScriptedLLMClient):
        def __init__(self):
            super().__init__([ScriptedTurn(text=json.dumps({
                "updates": [],
                "new_items": [],
                "reason": "criteria considered",
            }))])
            self.requests = []

        async def stream(self, request):
            self.requests.append(request)
            async for ev in super().stream(request):
                yield ev

    client = CapturingClient()
    cl = [_pending("existing checklist")]
    r = _run(evaluate(
        client=client,
        goal_text="x",
        checklist=cl,
        assistant_text="working",
        criteria=["추가 분석 레포트 작성", "재시도 실패 시 원인 기록"],
    ))

    assert not r.parse_failed
    req_text = client.requests[0].messages[0].content[0].text
    assert "추가 분석 레포트 작성" in req_text
    assert "재시도 실패 시 원인 기록" in req_text


def test_evaluate_drops_invalid_index():
    raw = json.dumps({
        "updates": [
            {"index": 99, "status": "completed"},  # out of range
            {"index": 1, "status": "completed", "evidence": "ok"},
        ],
        "new_items": [],
        "reason": "x",
    })
    client = ScriptedLLMClient([ScriptedTurn(text=raw)])
    cl = [_pending("a")]
    r = _run(evaluate(client=client, goal_text="x", checklist=cl,
                     assistant_text="..."))
    assert len(r.updates) == 1
    assert r.updates[0]["index"] == 1


def test_evaluate_drops_invalid_status():
    raw = json.dumps({
        "updates": [
            {"index": 1, "status": "skip"},  # not in valid terminal set
            {"index": 1, "status": "pending"},  # not terminal — drop
        ],
        "new_items": [],
        "reason": "x",
    })
    client = ScriptedLLMClient([ScriptedTurn(text=raw)])
    cl = [_pending("a")]
    r = _run(evaluate(client=client, goal_text="x", checklist=cl,
                     assistant_text="..."))
    assert r.updates == []


def test_evaluate_stickiness_blocks_terminal_overrides():
    """이미 completed 인 항목 update 시도 → drop."""
    raw = json.dumps({
        "updates": [{"index": 1, "status": "impossible", "evidence": "no"}],
        "new_items": [],
        "reason": "x",
    })
    client = ScriptedLLMClient([ScriptedTurn(text=raw)])
    cl = [ChecklistItem(text="a", status=ITEM_COMPLETED)]
    r = _run(evaluate(client=client, goal_text="x", checklist=cl,
                     assistant_text="..."))
    assert r.updates == []


def test_evaluate_parse_failed_on_garbage():
    client = ScriptedLLMClient([ScriptedTurn(text="not json")])
    cl = [_pending("a")]
    r = _run(evaluate(client=client, goal_text="x", checklist=cl,
                     assistant_text="..."))
    assert r.parse_failed


def test_evaluate_skips_when_no_checklist():
    """checklist 빈 경우 LLM 호출 없이 fast return."""
    client = ScriptedLLMClient([])  # 빈 script — 호출되면 raise
    r = _run(evaluate(client=client, goal_text="x", checklist=[],
                     assistant_text="..."))
    assert not r.parse_failed
    assert r.updates == []
    assert "empty checklist" in r.reason


def test_apply_evaluate_flips_pending_to_completed():
    from secu_agent.agent.goal_manager import EvaluateResult
    cl = [_pending("a"), _pending("b")]
    res = EvaluateResult(
        updates=[
            {"index": 1, "status": "completed", "evidence": "ok"},
        ],
        new_items=[ChecklistItem(text="c", status=ITEM_PENDING)],
        reason="x",
    )
    new_cl, flipped = apply_evaluate(cl, res)
    assert flipped == 1
    assert new_cl[0].status == ITEM_COMPLETED
    assert new_cl[0].evidence == "ok"
    assert new_cl[0].completed_at is not None
    assert new_cl[1].status == ITEM_PENDING
    # new_item 추가됨
    assert len(new_cl) == 3
    assert new_cl[2].text == "c"


def test_all_terminal_and_counters():
    cl = [
        ChecklistItem(text="a", status=ITEM_COMPLETED),
        ChecklistItem(text="b", status=ITEM_IMPOSSIBLE),
    ]
    assert all_terminal(cl) is True
    cl2 = cl + [_pending("c")]
    assert all_terminal(cl2) is False
    assert count_pending(cl2) == 1
    assert count_completed(cl2) == 1


def test_continuation_prompt_includes_progress():
    cl = [
        ChecklistItem(text="a", status=ITEM_COMPLETED),
        _pending("b"),
        _pending("c"),
    ]
    text = build_continuation_prompt("내 goal", cl)
    assert "내 goal" in text
    assert "1/3" in text
    assert "[x] a" in text
    assert "[ ] b" in text
    assert "judge" in text


def test_continuation_prompt_includes_criteria():
    text = build_continuation_prompt(
        "내 goal",
        [_pending("b")],
        criteria=["발견 사항 기반 deep dive"],
    )
    assert "발견 사항 기반 deep dive" in text


# ── F2: findings-grounded judge (증거 맹목 해소) ──────────────────────────

class _CapturingClient(ScriptedLLMClient):
    def __init__(self):
        super().__init__([ScriptedTurn(text=json.dumps(
            {"updates": [], "new_items": [], "reason": "ok"}))])
        self.requests = []

    async def stream(self, request):
        self.requests.append(request)
        async for ev in super().stream(request):
            yield ev


def test_f2_evaluate_prompt_includes_evidence_digest():
    client = _CapturingClient()
    r = _run(evaluate(
        client=client, goal_text="x", checklist=[_pending("확인 항목")],
        assistant_text="다 했습니다",
        evidence_digest="- [high] web @ https://corp.test/.env: 인증없이 설정파일 노출",
    ))
    assert not r.parse_failed
    req_text = client.requests[0].messages[0].content[0].text
    # 확정 findings 가 judge 프롬프트에 주입됨 + '완료는 근거 있을때만' 지시
    assert "실제로 확정된 findings" in req_text
    assert "https://corp.test/.env" in req_text
    assert "확정 findings" in req_text


def test_f2_evaluate_empty_digest_is_failopen_no_evidence_block():
    # 빈 digest → 증거 prefix 없이 원본 프롬프트 그대로(fail-open, 과차단 방지).
    client = _CapturingClient()
    _run(evaluate(client=client, goal_text="x", checklist=[_pending("항목")],
                  assistant_text="완료했습니다", evidence_digest=""))
    req_text = client.requests[0].messages[0].content[0].text
    assert "실제로 확정된 findings" not in req_text          # 증거 블록 없음
    assert "각 pending 항목과 추가 criteria 를 평가" in req_text  # 원본 프롬프트 유지


def test_f2_build_evidence_digest_from_confirmed_findings(monkeypatch):
    from secu_agent.agent import ralph_controller as rc
    monkeypatch.setattr(rc.state, "finding_list", lambda **kw: [
        {"severity": "high", "task_type": "web", "asset": "https://c.test/x",
         "summary": "인증없이 접근 가능"},
        {"severity": "critical", "task_type": "web", "asset": "https://c.test/.env",
         "summary": "설정 노출"},
    ])
    d = rc._build_evidence_digest()
    assert "[high] web @ https://c.test/x" in d
    assert "설정 노출" in d
    # 조회 실패는 fail-open ("")
    monkeypatch.setattr(rc.state, "finding_list",
                        lambda **kw: (_ for _ in ()).throw(RuntimeError("db down")))
    assert rc._build_evidence_digest() == ""
