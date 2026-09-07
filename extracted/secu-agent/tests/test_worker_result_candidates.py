"""worker_result candidate ledger 필드 — 침묵 장부의 부모 전파."""
from __future__ import annotations

import json

from secu_agent.agent.schema.worker_result import (
    WorkerResult,
    build_worker_result,
    read_worker_result,
    write_worker_result,
)


def test_build_clamps_negative_candidate_counts():
    r = build_worker_result(
        rc=0, status="ok", summary="s",
        candidates_seen=-3, candidates_accounted=-1,
    )
    assert r.candidates_seen == 0
    assert r.candidates_accounted == 0


def test_candidate_fields_roundtrip(tmp_path):
    r = build_worker_result(
        rc=3, status="error_crash",
        summary="task t1 (confluence): reason=contract_violation, submit=False, "
                "candidates seen=22 accounted=0",
        candidates_seen=22, candidates_accounted=0,
    )
    write_worker_result(tmp_path, r)
    back = read_worker_result(tmp_path)
    assert isinstance(back, WorkerResult)
    assert back.candidates_seen == 22
    assert back.candidates_accounted == 0


def test_old_result_without_candidate_fields_still_validates(tmp_path):
    # 구 워커가 쓴 파일(필드 부재) — default 0 으로 하위호환.
    legacy = {
        "rc": 0, "status": "ok", "summary": "done", "findings_count": 1,
        "turns_used": 2, "tokens_in": 10, "tokens_out": 5,
        "evidence_paths": [],
    }
    (tmp_path / "worker_result.json").write_text(
        json.dumps(legacy), encoding="utf-8",
    )
    back = read_worker_result(tmp_path)
    assert isinstance(back, WorkerResult)
    assert back.candidates_seen == 0
    assert back.candidates_accounted == 0
