"""제출 시도 장부(`<evidence_dir>/.harness/submissions.jsonl`)의 불변식.

배경 (2026-08-28 실측): 거부된 제출은 **아무 파일도 안 남겼다.** 거부 return 이
`finding.json` 경로를 정하는 줄보다 위라서, 판정에 걸린 순간 증거가 사라진다 —
4도메인 증거 디렉토리에서 거부가 기록된 run 172개 중 143개(83%)에 finding.json 이 없다.

이 파일이 지키는 것:
  ① 성공이든 거부든 **모든 종료 경로**가 정확히 한 줄을 남긴다.
  ② 장부에 자산 원문·masked·preview 가 **절대** 안 들어간다. 거부된 finding 의
     내용을 새 파일로 옮기면 그게 새 유출 표면이다.
  ③ 계측이 실패해도 제출은 죽지 않는다.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from secu_agent.agent.harness.submissions_log import (
    EXIT_PATHS,
    asset_fingerprint,
    record_submission,
)


def _rows(evidence_dir: Path) -> list[dict]:
    path = evidence_dir / ".harness" / "submissions.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def test_appends_one_row_per_call(tmp_path: Path):
    """append-only — `finding.json` 과 달리 덮어쓰지 않는다.

    `finding.json` 은 세션당 고정 이름 한 파일이라 성공한 제출도 마지막 1건만 남는다.
    장부는 시도 전부가 남아야 세어진다.
    """
    for path in ("judgment_rejected", "persist_success"):
        record_submission(tmp_path, tool="submit_finding", exit_path=path)
    rows = _rows(tmp_path)
    assert len(rows) == 2
    assert [r["exit_path"] for r in rows] == ["judgment_rejected", "persist_success"]


def test_never_records_asset_verbatim(tmp_path: Path):
    """자산은 지문으로만 적는다 — 같은 자산인지 비교만 하면 되고 되돌릴 필요가 없다."""
    asset = "smb://fileserver.corp.example.net/Finance$/2026/salary.xlsx"
    record_submission(tmp_path, tool="submit_finding", exit_path="judgment_rejected",
                      asset=asset)
    raw = (tmp_path / ".harness" / "submissions.jsonl").read_text(encoding="utf-8")
    assert asset not in raw
    assert "fileserver.corp.example.net" not in raw
    assert "salary.xlsx" not in raw
    assert _rows(tmp_path)[0]["asset_fingerprint"] == asset_fingerprint(asset)


def test_hit_outcomes_are_stripped_to_coordinates(tmp_path: Path):
    """판정이 실어 보낸 것 외의 키는 장부에 안 들어간다.

    상류가 실수로 masked 를 얹어도 여기서 걸러진다 — 계측은 마지막 관문이지
    상류를 믿는 자리가 아니다.
    """
    leaked = "AKIAIOSFODNN7EXAMPLE"
    record_submission(
        tmp_path, tool="submit_finding", exit_path="judgment_rejected",
        hit_outcomes=[{
            "index": 0, "category": "secret", "kind": "aws_access_key_id",
            "hit_verdict": "blocked", "hit_reason_code": "value_evidence_missing",
            "masked": leaked, "preview": f"key={leaked}",
        }],
    )
    raw = (tmp_path / ".harness" / "submissions.jsonl").read_text(encoding="utf-8")
    assert leaked not in raw
    outcome = _rows(tmp_path)[0]["hit_outcomes"][0]
    assert set(outcome) == {"index", "category", "kind", "hit_verdict", "hit_reason_code"}


def test_counts_are_derived_not_reported(tmp_path: Path):
    """confirmed/blocked 개수는 outcomes 에서 **계산**한다.

    ⚠️ 이 저장소는 자기신고 지표에 반복적으로 속았다(archive_index 22/22 success 인데
    21건이 0바이트, report_inspection 145회 중 files_seen 전달 0회). 셀 수 있는 값은
    받아적지 말고 세어야 한다.
    """
    record_submission(
        tmp_path, tool="submit_finding", exit_path="judgment_rejected",
        hit_categories=["secret", "credential", "pii"],
        hit_outcomes=[
            {"index": 0, "category": "secret", "kind": "k", "hit_verdict": "confirmed",
             "hit_reason_code": ""},
            {"index": 1, "category": "credential", "kind": "k", "hit_verdict": "blocked",
             "hit_reason_code": "value_evidence_missing"},
            {"index": 2, "category": "pii", "kind": "k", "hit_verdict": "blocked",
             "hit_reason_code": "content_evidence_missing"},
        ],
    )
    row = _rows(tmp_path)[0]
    assert row["confirmed_count"] == 1
    assert row["blocked_count"] == 2
    assert row["hit_count"] == 3


def test_logging_failure_never_raises(tmp_path: Path):
    """계측이 제출을 죽이면 안 된다 — 쓸 수 없는 경로여도 조용히 넘어간다."""
    blocked = tmp_path / "not-a-dir"
    blocked.write_text("x", encoding="utf-8")
    record_submission(blocked, tool="submit_finding", exit_path="judgment_rejected")


def test_empty_asset_fingerprints_to_empty_string():
    """지문이 없는 것과 빈 문자열의 지문을 구분한다."""
    assert asset_fingerprint("") == ""
    assert asset_fingerprint("   ") == ""
    assert len(asset_fingerprint("x")) == 16


# ── 도구 배선: 거부도 장부를 남긴다 ──────────────────────────────────────

def _context(tmp_path: Path):
    from secu_agent.agent.tools.base import ToolContext

    try:
        return ToolContext(evidence_dir=tmp_path, metadata={})
    except TypeError:
        ctx = ToolContext.__new__(ToolContext)
        object.__setattr__(ctx, "evidence_dir", tmp_path)
        object.__setattr__(ctx, "metadata", {})
        return ctx


@pytest.mark.parametrize(
    ("label", "hits", "expected_code"),
    [
        ("전부 막힘", [{"category": "credential", "kind": "password",
                     "location": "https://x.example.net/.env", "masked": "value_present"}],
         "all_blocked"),
        ("확정+막힘", [
            {"category": "secret", "kind": "aws_access_key_id",
             "location": "https://x.example.net/.env", "masked": "AKIAIOSFODNN7EXAMPLE"},
            {"category": "credential", "kind": "password",
             "location": "https://x.example.net/.env", "masked": "value_present"},
        ], "mixed_confidence"),
    ],
)
def test_rejected_submission_still_leaves_a_row(tmp_path: Path, label, hits, expected_code):
    """★ 이 변경의 핵심 — 거부돼도 흔적이 남는다.

    예전엔 여기서 아무것도 안 남아 사유를 셀 수 없었다.
    """
    from secu_agent.agent.tools.submit_finding import SubmitFindingInput, SubmitFindingTool

    payload = SubmitFindingInput(finding={
        "task_type": "dev_web", "severity": "high", "summary": "s",
        "target": "https://x.example.net", "hits": hits,
    })
    result = asyncio.run(SubmitFindingTool().execute(payload, _context(tmp_path)))

    rows = _rows(tmp_path)
    assert len(rows) == 1, label
    assert rows[0]["exit_path"] == "judgment_rejected", label
    assert rows[0]["reason_code"] == expected_code, label
    assert rows[0]["should_persist"] is False
    assert rows[0]["blocked_count"] >= 1
    # 거부는 여전히 ToolError 다 — 워커가 수리 턴을 갖는다.
    assert type(result).__name__ == "ToolError", label


def test_exit_paths_are_declared():
    """종료 경로를 늘리면 EXIT_PATHS 에 먼저 적는다 — 집계가 조용히 새는 걸 막는다."""
    source = Path(
        "src/secu_agent/agent/tools/submit_finding.py"
    ).read_text(encoding="utf-8")
    for path in EXIT_PATHS:
        assert f'"{path}"' in source, f"{path} 가 submit_finding 에 배선되지 않았다"
