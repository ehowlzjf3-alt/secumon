"""v3.76: EnrichFindingTool — narrative 백필(merge), None 생략, not_found, pivot 미실행."""
from __future__ import annotations

import asyncio
from pathlib import Path

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.agent.tools.enrich_finding import EnrichFindingTool


def _ctx(tmp_path: Path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path, metadata={})


def _run(payload, ctx):
    tool = EnrichFindingTool()
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_enrich_merges_narrative(tmp_db, tmp_path):
    from secu_agent import state

    fid, _ = state.finding_upsert(
        task_type="web", asset="https://x/.env", asset_kind="url",
        severity="high", summary="x", extra={"existing": "kept", "hits": [{"category": "secret"}]},
    )
    res = _run({
        "finding_id": fid,
        "risk_narrative": {
            "what_is_data": "DB 연결 문자열",
            "exploitation_path": "내부 비인가자 DB 접근",
        },
        "pivot_interpretation": "게이트웨이 도달 가능",
    }, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess)
    row = state.finding_get(fid)
    # merge_extra → 기존 키 보존
    assert row["extra"]["existing"] == "kept"
    assert row["extra"]["risk_narrative"]["what_is_data"] == "DB 연결 문자열"
    assert row["extra"]["pivot_interpretation"] == "게이트웨이 도달 가능"


def test_enrich_omits_none_fields(tmp_db, tmp_path):
    """제공 안 한 필드(None)는 적재하지 않고 기존 값 보존."""
    from secu_agent import state

    fid, _ = state.finding_upsert(
        task_type="web", asset="https://y/.env", asset_kind="url",
        severity="high", summary="y",
        extra={"pivot_interpretation": "이전 해석", "hits": []},
    )
    res = _run({
        "finding_id": fid,
        "risk_narrative": {"what_is_data": "토큰"},
        # pivot_interpretation / evidence_notes 미제공 → 기존 보존
    }, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess)
    row = state.finding_get(fid)
    assert row["extra"]["risk_narrative"]["what_is_data"] == "토큰"
    assert row["extra"]["pivot_interpretation"] == "이전 해석"  # 보존
    assert "evidence_notes" not in row["extra"]  # 미제공 → 추가 안 됨


def test_enrich_not_found(tmp_db, tmp_path):
    res = _run({
        "finding_id": 999999,
        "risk_narrative": {"what_is_data": "x"},
    }, _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert res.kind == "not_found"


def test_enrich_does_not_run_pivot(tmp_db, tmp_path):
    """enrich 는 finding enricher(구 pivot)를 재실행하지 않는다 — 등록된 enricher 가
    호출되면 fail. (run_finding_enrichers 는 예외를 삼키므로 raise 가 아니라 호출-spy 로
    감지한다.)"""
    from secu_agent import state
    from secu_agent.agent.finding_enrichment import (
        register_finding_enricher,
        unregister_all_finding_enrichers,
    )

    fid, _ = state.finding_upsert(
        task_type="web", asset="https://z/.env", asset_kind="url",
        severity="high", summary="z", extra={"hits": [{"category": "secret"}]},
    )

    called: list[bool] = []

    def _spy(*, asset, summary, hits):
        called.append(True)
        return {"version": 1, "exposed_count": 0}

    unregister_all_finding_enrichers()
    register_finding_enricher(_spy)
    try:
        res = _run({
            "finding_id": fid,
            "risk_narrative": {"what_is_data": "x"},
        }, _ctx(tmp_path))
        assert isinstance(res, ToolSuccess)
        assert called == [], "enrich_finding must NOT run finding enrichers"
        # pivot 키가 새로 안 생김
        row = state.finding_get(fid)
        assert "pivot" not in row["extra"]
    finally:
        unregister_all_finding_enrichers()


def test_enrich_no_fields_noop(tmp_db, tmp_path):
    from secu_agent import state

    fid, _ = state.finding_upsert(
        task_type="web", asset="https://n/.env", asset_kind="url",
        severity="high", summary="n", extra={"hits": []},
    )
    res = _run({"finding_id": fid}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess)
    assert "nothing to update" in res.content


def test_enrich_is_not_read_only():
    assert EnrichFindingTool.is_read_only is False
