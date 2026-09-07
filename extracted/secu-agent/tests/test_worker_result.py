"""v3.80 Slice0d: worker_result.json 계약 — pydantic 스키마 + fail-closed reader.

Slice1 WorkerPool 의 유일한 워커→부모 결과 채널. 누락/깨짐/스키마위반 =
전부 실패 (해당 타깃 claim 해제 → 재점검). inspection_result.json fail-closed
패턴의 일반화. 소비자는 Slice1 — 이 슬라이스는 무동작 선반입.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest


def _valid_payload(**over) -> dict:
    base = {
        "rc": 0,
        "status": "ok",
        "summary": "share 10.0.0.5/docs 검토 완료 — finding 2건",
        "findings_count": 2,
        "turns_used": 14,
        "tokens_in": 52_000,
        "tokens_out": 4_100,
        "evidence_paths": ["audit.log.jsonl", "findings/f1.json"],
    }
    base.update(over)
    return base


# ─── 스키마 ──────────────────────────────────────────────────────


def test_valid_payload_accepted():
    from secu_agent.agent.schema.worker_result import WorkerResult
    r = WorkerResult.model_validate(_valid_payload())
    assert r.status == "ok"
    assert r.findings_count == 2
    assert r.evidence_paths == ["audit.log.jsonl", "findings/f1.json"]


def test_unknown_status_rejected():
    from pydantic import ValidationError
    from secu_agent.agent.schema.worker_result import WorkerResult
    with pytest.raises(ValidationError):
        WorkerResult.model_validate(_valid_payload(status="partial"))


def test_summary_over_500_rejected():
    from pydantic import ValidationError
    from secu_agent.agent.schema.worker_result import WorkerResult
    with pytest.raises(ValidationError):
        WorkerResult.model_validate(_valid_payload(summary="x" * 501))


def test_negative_counts_rejected():
    from pydantic import ValidationError
    from secu_agent.agent.schema.worker_result import WorkerResult
    for field in ("findings_count", "turns_used", "tokens_in", "tokens_out"):
        with pytest.raises(ValidationError):
            WorkerResult.model_validate(_valid_payload(**{field: -1}))


def test_extra_field_rejected():
    """extra=forbid — 모르는 필드는 계약 드리프트, fail-closed."""
    from pydantic import ValidationError
    from secu_agent.agent.schema.worker_result import WorkerResult
    with pytest.raises(ValidationError):
        WorkerResult.model_validate(_valid_payload(transcript="..."))


def test_status_ok_requires_rc_zero():
    """성공 주장 + 비정상 종료코드 = 불일치 — 스키마에서 차단."""
    from pydantic import ValidationError
    from secu_agent.agent.schema.worker_result import WorkerResult
    with pytest.raises(ValidationError):
        WorkerResult.model_validate(_valid_payload(rc=1))
    # 에러 status 는 임의 rc 허용 (graceful budget 종료가 rc=0 일 수도)
    r = WorkerResult.model_validate(
        _valid_payload(rc=0, status="error_budget"))
    assert r.status == "error_budget"
    r = WorkerResult.model_validate(
        _valid_payload(rc=-15, status="error_cancel"))
    assert r.rc == -15


def test_evidence_paths_escape_blocked():
    """상대경로 강제 — '..' / 절대경로 / 빈 문자열 차단."""
    from pydantic import ValidationError
    from secu_agent.agent.schema.worker_result import WorkerResult
    for bad in (["../outside.txt"], ["a/../../b"], ["/etc/passwd"], [""]):
        with pytest.raises(ValidationError):
            WorkerResult.model_validate(_valid_payload(evidence_paths=bad))


def test_evidence_paths_relative_ok():
    from secu_agent.agent.schema.worker_result import WorkerResult
    r = WorkerResult.model_validate(_valid_payload(
        evidence_paths=["a.json", "sub/dir/b.log", "한글파일.txt"],
    ))
    assert len(r.evidence_paths) == 3


# ─── fail-closed reader ──────────────────────────────────────────


def test_reader_roundtrip(tmp_path: Path):
    from secu_agent.agent.schema.worker_result import (
        WorkerResult, read_worker_result, write_worker_result,
    )
    written = WorkerResult.model_validate(_valid_payload())
    write_worker_result(tmp_path, written)
    got = read_worker_result(tmp_path)
    assert isinstance(got, WorkerResult)
    assert got == written


def test_reader_missing_fail_closed(tmp_path: Path):
    from secu_agent.agent.schema.worker_result import (
        WorkerResultInvalid, read_worker_result,
    )
    got = read_worker_result(tmp_path)
    assert isinstance(got, WorkerResultInvalid)
    assert got.reason == "missing"


def test_reader_corrupt_json_fail_closed(tmp_path: Path):
    from secu_agent.agent.schema.worker_result import (
        WORKER_RESULT_FILENAME, WorkerResultInvalid, read_worker_result,
    )
    (tmp_path / WORKER_RESULT_FILENAME).write_text("{ not json", encoding="utf-8")
    got = read_worker_result(tmp_path)
    assert isinstance(got, WorkerResultInvalid)
    assert got.reason == "parse"


def test_reader_truncated_write_fail_closed(tmp_path: Path):
    """crash 중 부분 기록 시뮬 — 잘린 JSON 은 parse 단계에서 잡힌다."""
    from secu_agent.agent.schema.worker_result import (
        WORKER_RESULT_FILENAME, WorkerResultInvalid, read_worker_result,
    )
    full = json.dumps(_valid_payload(), ensure_ascii=False)
    (tmp_path / WORKER_RESULT_FILENAME).write_text(
        full[: len(full) // 2], encoding="utf-8")
    got = read_worker_result(tmp_path)
    assert isinstance(got, WorkerResultInvalid)
    assert got.reason == "parse"


def test_reader_schema_violation_fail_closed(tmp_path: Path):
    """valid JSON 이지만 계약 위반 — reason=schema."""
    from secu_agent.agent.schema.worker_result import (
        WORKER_RESULT_FILENAME, WorkerResultInvalid, read_worker_result,
    )
    (tmp_path / WORKER_RESULT_FILENAME).write_text(
        json.dumps(_valid_payload(status="ok", rc=7)), encoding="utf-8")
    got = read_worker_result(tmp_path)
    assert isinstance(got, WorkerResultInvalid)
    assert got.reason == "schema"
    assert "rc=7" in got.detail


def test_reader_non_dict_json_fail_closed(tmp_path: Path):
    """JSON 으로는 valid 하지만 객체가 아님 (list/문자열) — schema 로 잡힘."""
    from secu_agent.agent.schema.worker_result import (
        WORKER_RESULT_FILENAME, WorkerResultInvalid, read_worker_result,
    )
    (tmp_path / WORKER_RESULT_FILENAME).write_text("[1, 2]", encoding="utf-8")
    got = read_worker_result(tmp_path)
    assert isinstance(got, WorkerResultInvalid)
    assert got.reason == "schema"


def test_reader_too_large_fail_closed(tmp_path: Path):
    """폭주 워커의 거대 결과 파일 — 읽기 전에 크기에서 차단."""
    from secu_agent.agent.schema.worker_result import (
        WORKER_RESULT_FILENAME, WorkerResultInvalid, read_worker_result,
    )
    (tmp_path / WORKER_RESULT_FILENAME).write_text(
        '{"pad": "' + "x" * (1024 * 1024 + 100) + '"}', encoding="utf-8")
    got = read_worker_result(tmp_path)
    assert isinstance(got, WorkerResultInvalid)
    assert got.reason == "too_large"


def test_reader_nested_json_bomb_fail_closed(tmp_path: Path):
    """'['*100k 는 1MB 캡 아래인데 json.loads 가 RecursionError 를 던진다
    (ValueError 계열 아님) — no-throw 계약 유지 확인 (리뷰 발견 H1)."""
    from secu_agent.agent.schema.worker_result import (
        WORKER_RESULT_FILENAME, WorkerResultInvalid, read_worker_result,
    )
    (tmp_path / WORKER_RESULT_FILENAME).write_text(
        "[" * 100_000, encoding="utf-8")
    got = read_worker_result(tmp_path)
    assert isinstance(got, WorkerResultInvalid)
    assert got.reason == "parse"


def test_reader_parse_detail_capped(tmp_path: Path):
    """UnicodeDecodeError repr 은 실패한 bytes 전체를 담는다 — detail 이
    파일 크기에 비례해 비대해지면 안 된다 (리뷰 발견 M2)."""
    from secu_agent.agent.schema.worker_result import (
        WORKER_RESULT_FILENAME, WorkerResultInvalid, read_worker_result,
    )
    (tmp_path / WORKER_RESULT_FILENAME).write_bytes(b"\x80" * 4096)
    got = read_worker_result(tmp_path)
    assert isinstance(got, WorkerResultInvalid)
    assert got.reason == "parse"
    assert len(got.detail) <= 500


@pytest.mark.skipif(os.geteuid() == 0, reason="root 는 파일 권한 무시")
def test_reader_stat_env_error_not_misdiagnosed_as_crash(tmp_path: Path):
    """PermissionError 등 환경 장애를 '워커 crash' 로 단정하면 안 된다 —
    원인 repr 이 detail 에 남아야 함 (리뷰 발견 L2)."""
    from secu_agent.agent.schema.worker_result import (
        WorkerResult, WorkerResultInvalid, read_worker_result,
        write_worker_result,
    )
    ev = tmp_path / "ev"
    ev.mkdir()
    write_worker_result(ev, WorkerResult.model_validate(_valid_payload()))
    ev.chmod(0)
    try:
        got = read_worker_result(ev)
    finally:
        ev.chmod(0o700)
    assert isinstance(got, WorkerResultInvalid)
    assert got.reason == "missing"  # fail-closed 동작은 동일
    assert "PermissionError" in got.detail
    assert "crash" not in got.detail


def test_writer_atomic_no_tmp_left(tmp_path: Path):
    from secu_agent.agent.schema.worker_result import (
        WORKER_RESULT_FILENAME, WorkerResult, write_worker_result,
    )
    path = write_worker_result(
        tmp_path, WorkerResult.model_validate(_valid_payload()))
    assert path.name == WORKER_RESULT_FILENAME
    assert path.exists()
    leftovers = [p for p in tmp_path.iterdir() if p.suffix == ".tmp"]
    assert leftovers == []


# ─── clamping 빌더 (워커 터미널/except/grace 경로용) ─────────────


def test_builder_clamps_empty_and_long_summary():
    """except 절의 summary=str(exc) 가 빈 문자열/500자 초과여도 보고가
    살아남아야 한다 — 안 그러면 부모는 missing 으로 오진 (리뷰 발견 L1)."""
    from secu_agent.agent.schema.worker_result import build_worker_result
    r = build_worker_result(rc=1, status="error_crash",
                            summary=str(ValueError()))  # 빈 예외 메시지
    assert r.summary == "<no message>"
    r = build_worker_result(rc=1, status="error_crash", summary="x" * 2000)
    assert len(r.summary) == 500


def test_builder_clamps_evidence_paths():
    from secu_agent.agent.schema.worker_result import build_worker_result
    raw = ["../escape"] + [f"f{i}.json" for i in range(220)]
    r = build_worker_result(rc=0, status="error_budget", summary="부분 결과",
                            evidence_paths=raw)
    assert len(r.evidence_paths) == 200
    assert "../escape" not in r.evidence_paths
    assert "무효 1개 제외" in r.summary
    assert "20개 절단" in r.summary


def test_builder_annotation_survives_long_summary():
    """절단 표기가 500자 캡에 밀려 사라지면 안 된다."""
    from secu_agent.agent.schema.worker_result import build_worker_result
    r = build_worker_result(rc=1, status="error_crash", summary="x" * 600,
                            evidence_paths=["../bad"])
    assert len(r.summary) <= 500
    assert "무효 1개 제외" in r.summary


def test_builder_clamps_negative_counts():
    from secu_agent.agent.schema.worker_result import build_worker_result
    r = build_worker_result(rc=1, status="error_crash", summary="죽음",
                            findings_count=-3, turns_used=-1)
    assert r.findings_count == 0
    assert r.turns_used == 0


def test_builder_output_roundtrips(tmp_path: Path):
    from secu_agent.agent.schema.worker_result import (
        WorkerResult, build_worker_result, read_worker_result,
        write_worker_result,
    )
    r = build_worker_result(rc=-15, status="error_cancel",
                            summary=str(KeyboardInterrupt()))
    write_worker_result(tmp_path, r)
    got = read_worker_result(tmp_path)
    assert isinstance(got, WorkerResult)
    assert got == r


def test_builder_code_level_contradiction_still_raises():
    """status↔rc 모순은 데이터가 아니라 호출부 버그 — clamp 대상 아님."""
    from pydantic import ValidationError
    from secu_agent.agent.schema.worker_result import build_worker_result
    with pytest.raises(ValidationError):
        build_worker_result(rc=1, status="ok", summary="모순")
