"""v3.74 B: state.finding_attach_pivot — extra_json['pivot'] 병합."""
from __future__ import annotations


def test_finding_attach_pivot_merges_extra(tmp_db):
    from secu_agent import state

    fid, _ = state.finding_upsert(
        task_type="web", asset="https://a.samsungds.net/.env", asset_kind="url",
        severity="high", summary="x",
        extra={"hits": [{"category": "secret"}], "confidence": 0.9},
    )
    state.finding_attach_pivot(fid, {
        "version": 1, "candidates": ["https://a.samsungds.net/x"],
        "probes": [], "exposed_count": 0,
    })
    row = state.finding_get(fid)
    assert row["extra"]["confidence"] == 0.9
    assert row["extra"]["hits"]
    assert row["extra"]["pivot"]["version"] == 1
    assert row["extra"]["pivot"]["candidates"] == ["https://a.samsungds.net/x"]


def test_finding_attach_pivot_replaces_only_pivot_key(tmp_db):
    from secu_agent import state

    fid, _ = state.finding_upsert(
        task_type="web", asset="https://b.samsungds.net/.env", asset_kind="url",
        severity="low", summary="x", extra={"k": "v"},
    )
    state.finding_attach_pivot(fid, {"version": 1, "exposed_count": 0})
    state.finding_attach_pivot(fid, {"version": 1, "exposed_count": 2})
    row = state.finding_get(fid)
    assert row["extra"]["k"] == "v"
    assert row["extra"]["pivot"]["exposed_count"] == 2
