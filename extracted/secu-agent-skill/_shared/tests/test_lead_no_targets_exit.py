"""빈 큐를 만난 리드에게 합법적인 출구가 있다 — 그리고 그 출구는 우회로가 아니다.

## 왜 (2026-08-27 실측)

리드 **20건**이 `terminal tool contract violation: required terminal status tool
(['set_target_status']) was described as text but never invoked` 로 죽었다.
그중 **19건이 도구를 `list_targets` 하나만** 불렀다(confluence 15 · dev_web 3 · smb 1).

`list_targets` 는 자기 설명에 **"claim 하지 않는다"** 고 적힌 읽기 전용 도구다. 큐가
비면 리드는 claim 한 적 없는 대상에 `set_target_status` 를 찍을 수 없다 — 계약이
**이행 불가능한 요구**가 된다. 리마인더 2회 뒤 런이 죽는다.

## 이 파일이 지키는 것

계약은 그대로 산다. 면제는 **코드가 큐를 직접 다시 조회해서** 확인했을 때만 서고,
면제 뒤에 무언가를 하면 회수된다. LLM 이 "할 일 없었다" 고 쓰는 것으로는 안 선다.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from secu_agent.agent.terminal_contract import (
    TERMINAL_WAIVED_KEY,
    waive_terminal_tool,
)


# ── 코어: 면제는 근거 없이 못 선다 ───────────────────────────────────────

def test_waiver_requires_source_and_evidence():
    """근거 없는 면제를 조용히 통과시키지 않는다 — 그건 계약 무력화다."""
    for source, evidence in (("", {"rows": 0}), ("t", {}), ("t", None), ("  ", {"rows": 0})):
        with pytest.raises(ValueError):
            waive_terminal_tool({}, source=source, evidence=evidence)


def test_waiver_records_who_and_what():
    """누가 무엇을 관찰해서 면제했는지가 남아야 조용한 no-op 이 아니다."""
    md: dict = {}
    waive_terminal_tool(md, source="report_no_targets",
                        evidence={"queue": "q", "rows": 0})
    stamped = md[TERMINAL_WAIVED_KEY]
    assert stamped["source"] == "report_no_targets"
    assert stamped["evidence"]["rows"] == 0
    assert stamped["ts"] > 0


def test_engine_reads_the_waiver_but_never_writes_it():
    """코어는 도메인 지식을 안 갖는다 — 이 키를 읽기만 한다."""
    from pathlib import Path

    engine = Path(__file__).resolve().parents[2]
    src = (engine.parent / "secu-agent" / "src" / "secu_agent" / "agent" / "engine.py")
    if not src.exists():          # 코어 저장소가 옆에 없으면 건너뛴다
        pytest.skip("코어 저장소 경로 없음")
    body = src.read_text(encoding="utf-8")
    assert "TERMINAL_WAIVED_KEY" in body
    assert "waive_terminal_tool" not in body, "코어가 면제를 스스로 세우면 안 된다"


# ── 스킬: 출구 도구 ─────────────────────────────────────────────────────

class _Adapter:
    domain = "demo"
    queue_label = "데모 큐"
    statuses = ("pending", "tasked")
    claimable_statuses = ("pending",)

    def __init__(self, rows=None, boom=False):
        self._rows = rows or []
        self._boom = boom

    def list_targets(self, *, status=None, limit=50):
        if self._boom:
            raise RuntimeError("DB 안 됨")
        return list(self._rows)[: int(limit)]


class _Ctx:
    def __init__(self, tmp_path):
        self.evidence_dir = tmp_path
        self.metadata: dict = {}


def _run(tool, vi, ctx):
    return asyncio.run(tool._run(vi, ctx))


@pytest.fixture
def lead(monkeypatch, tmp_path):
    from _shared import lead_tools as lt

    lt.examined_reset_for_test()
    ctx = _Ctx(tmp_path)
    adapter = _Adapter()
    monkeypatch.setattr(lt, "_adapter_for", lambda _c: adapter)
    monkeypatch.setattr(lt, "_append_pivot", lambda _c, _e: None)
    return lt, ctx, adapter


def _payload(result) -> dict:
    return json.loads(result.content)


def test_empty_queue_waives_the_contract(lead):
    """★ 이 수정의 목적 — 닫을 게 없으면 합법적으로 끝난다."""
    lt, ctx, _ = lead
    out = _payload(_run(lt.ReportNoTargetsTool(),
                        lt.ReportNoTargetsInput(observed="큐가 비었다"), ctx))
    assert out["accepted"] is True
    assert out["waived"] is True
    assert ctx.metadata[TERMINAL_WAIVED_KEY]["source"] == "report_no_targets"
    assert ctx.metadata[TERMINAL_WAIVED_KEY]["evidence"]["rows"] == 0


def test_a_non_empty_queue_refuses_the_waiver(lead):
    """LLM 이 '없다' 고 써도 도구가 큐를 다시 본다 — 판정은 코드가 한다."""
    lt, ctx, adapter = lead
    adapter._rows = [{"id": 7, "status": "pending"}]
    out = _payload(_run(lt.ReportNoTargetsTool(),
                        lt.ReportNoTargetsInput(observed="없는 것 같다"), ctx))
    assert out["accepted"] is False
    assert TERMINAL_WAIVED_KEY not in ctx.metadata
    assert out["sample"]["id"] == 7


def test_query_failure_does_not_waive(lead):
    """못 세는 것과 0건은 다르다 — 모르면 면제하지 않는다(fail-closed)."""
    lt, ctx, adapter = lead
    adapter._boom = True
    out = _payload(_run(lt.ReportNoTargetsTool(),
                        lt.ReportNoTargetsInput(observed="비었다"), ctx))
    assert out["accepted"] is False
    assert TERMINAL_WAIVED_KEY not in ctx.metadata
    # ⚠️ ToolError 가 아니어야 한다 — 같은 실패 2회면 repeat-error 가드가 런을 죽인다.
    assert type(out) is dict


def test_examined_but_unclosed_targets_block_the_waiver(lead):
    """★ 계약이 잡으려던 실패모드 — '일 다 해놓고 종료를 글로만' 은 그대로 막힌다."""
    lt, ctx, _ = lead
    lt._mark_examined(ctx, 42)
    out = _payload(_run(lt.ReportNoTargetsTool(),
                        lt.ReportNoTargetsInput(observed="다 봤고 할 게 없다"), ctx))
    assert out["accepted"] is False
    assert "42" in out["why"]
    assert TERMINAL_WAIVED_KEY not in ctx.metadata


def test_waiver_is_revoked_once_the_lead_looks_at_something(lead):
    """★ 면제는 provisional 이다 — '면제 먼저 받고 일은 나중에' 를 막는다."""
    lt, ctx, _ = lead
    _run(lt.ReportNoTargetsTool(), lt.ReportNoTargetsInput(observed="비었다"), ctx)
    assert TERMINAL_WAIVED_KEY in ctx.metadata
    lt._mark_examined(ctx, 99)          # 뭔가를 들여다봤다
    assert TERMINAL_WAIVED_KEY not in ctx.metadata


def test_seeing_rows_in_the_queue_revokes_the_waiver(lead):
    """큐에서 row 를 보면 '닫을 게 없다' 는 더 이상 사실이 아니다."""
    lt, ctx, adapter = lead
    _run(lt.ReportNoTargetsTool(), lt.ReportNoTargetsInput(observed="비었다"), ctx)
    assert TERMINAL_WAIVED_KEY in ctx.metadata
    adapter._rows = [{"id": 3, "status": "pending"}]
    _run(lt.ListTargetsTool(), lt.ListTargetsInput(), ctx)
    assert TERMINAL_WAIVED_KEY not in ctx.metadata


def test_empty_unfiltered_list_points_at_the_exit(lead):
    """빈 큐를 조용히 0건으로 돌려주지 않는다 — 출구를 알려준다."""
    lt, ctx, _ = lead
    out = _payload(_run(lt.ListTargetsTool(), lt.ListTargetsInput(), ctx))
    assert out["total"] == 0
    assert "report_no_targets" in out["note"]


def test_the_exit_tool_is_not_a_terminal_tool():
    """★ terminal_tools 에 넣으면 부르기만 해도 게이트가 풀린다 — 일반 우회로가 된다."""
    from _shared import lead_contract

    src = lead_contract.__file__
    with open(src, encoding="utf-8") as fh:
        body = fh.read()
    assert '"terminal_tools": {"set_target_status"}' in body
    assert "report_no_targets" not in body.split("terminal_tools")[1][:400]
