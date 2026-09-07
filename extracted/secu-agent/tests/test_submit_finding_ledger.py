"""submit_finding → candidate ledger 'submitted' 기록 (DB 없는 no-persist 경로)."""
from __future__ import annotations

import asyncio

from secu_agent.agent.candidate_ledger import candidate_ledger_stats
from secu_agent.agent.schema.finding import FindingHit, TaskFinding
from secu_agent.agent.tools import submit_finding as sf
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


class _Judgment:
    verdict = "confirmed"
    should_persist = False
    reason = "test"
    required_actions: tuple = ()

    def to_dict(self):
        return {"verdict": self.verdict, "reason": self.reason}


class _Rejected(_Judgment):
    verdict = "rejected"


def _finding(hits: int = 2) -> TaskFinding:
    return TaskFinding(
        task_type="generic",
        severity="medium",
        summary="테스트 노출 요약 — 위험 시나리오 포함",
        hits=[
            FindingHit(
                category="secret", kind="password",
                location=f"repo/config{i}.py", masked="p*****",
            )
            for i in range(hits)
        ],
    )


def _submit(tmp_path, monkeypatch, judgment) -> tuple[object, dict]:
    monkeypatch.setattr(sf, "judge_task_finding", lambda f: judgment)
    monkeypatch.setattr(sf, "browser_verification_required", lambda t: False)
    ctx = ToolContext(evidence_dir=tmp_path, metadata={})
    result = asyncio.run(sf.SubmitFindingTool().execute(
        sf.SubmitFindingInput(finding=_finding()), ctx,
    ))
    return result, ctx.metadata


def test_no_persist_submit_records_submitted(tmp_path, monkeypatch):
    result, metadata = _submit(tmp_path, monkeypatch, _Judgment())
    assert isinstance(result, ToolSuccess)
    assert candidate_ledger_stats(metadata) == (0, 2, 0)


def test_rejected_submit_does_not_account(tmp_path, monkeypatch):
    # 기각된 허풍은 침묵 부채를 해소하지 못한다 — deep-dive 후 재제출/기각 기록 필요.
    result, metadata = _submit(tmp_path, monkeypatch, _Rejected())
    assert isinstance(result, ToolError)
    assert candidate_ledger_stats(metadata) == (0, 0, 0)
