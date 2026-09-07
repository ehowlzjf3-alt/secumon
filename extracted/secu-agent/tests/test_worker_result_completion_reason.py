"""CORE-ASK ASK-2: worker_result completion_reason/metrics_version 승격.

- 엔진 LoopStopReason → 정규화 어휘 매핑 (normalize_completion_reason)
- build/roundtrip + 하위호환(구 파일 → None)
- extra='forbid' fail-closed (신 필드 쓴 결과를 구 코어가 거부하는 메커니즘)
"""
from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from secu_agent.agent.schema.worker_result import (
    COMPLETION_REASONS,
    WorkerResult,
    WorkerResultInvalid,
    build_worker_result,
    normalize_completion_reason,
    read_worker_result,
    write_worker_result,
)


# ── normalize_completion_reason ──────────────────────────────────────


def test_normalize_none_and_blank_to_none():
    assert normalize_completion_reason(None) is None
    assert normalize_completion_reason("") is None
    assert normalize_completion_reason("   ") is None


def test_normalize_maps_engine_reasons():
    # 엔진 어휘 → 정규화 어휘
    assert normalize_completion_reason("aborted") == "cancelled"
    assert normalize_completion_reason("stream_error") == "crash"


def test_normalize_passes_through_matching_and_unknown():
    # 어휘에 이미 맞는 값은 그대로
    for r in ("end_turn", "contract_violation", "max_tokens", "no_completion"):
        assert normalize_completion_reason(r) == r
    # max_turns 는 코어가 내보내는 실제 예산-소진 사유 — 그대로 통과
    assert normalize_completion_reason("max_turns") == "max_turns"
    # 미지값은 정보 손실 없이 통과
    assert normalize_completion_reason("domain-specific-xyz") == "domain-specific-xyz"


def test_normalize_clamps_length():
    long = "x" * 200
    assert len(normalize_completion_reason(long)) == 64


def test_recommended_vocab_is_frozenset():
    assert "cancelled" in COMPLETION_REASONS
    assert "crash" in COMPLETION_REASONS
    assert "timeout" in COMPLETION_REASONS  # 스킬 writer 몫이지만 어휘에 존재


# ── build + roundtrip ────────────────────────────────────────────────


def test_build_fills_and_roundtrips(tmp_path):
    r = build_worker_result(
        rc=3, status="error_crash", summary="s",
        completion_reason="cancelled", metrics_version=1,
    )
    assert r.completion_reason == "cancelled"
    assert r.metrics_version == 1
    write_worker_result(tmp_path, r)
    back = read_worker_result(tmp_path)
    assert isinstance(back, WorkerResult)
    assert back.completion_reason == "cancelled"
    assert back.metrics_version == 1


def test_build_defaults_are_none():
    r = build_worker_result(rc=0, status="ok", summary="s")
    assert r.completion_reason is None
    assert r.metrics_version is None


def test_build_clamps_reason_and_negative_version():
    r = build_worker_result(
        rc=0, status="ok", summary="s",
        completion_reason="  " + "y" * 200, metrics_version=-5,
    )
    assert len(r.completion_reason) == 64
    assert r.metrics_version == 0  # 음수 → 0 (거부 아님)


def test_build_blank_reason_becomes_none():
    r = build_worker_result(
        rc=0, status="ok", summary="s", completion_reason="   ",
    )
    assert r.completion_reason is None


# ── 하위호환 + fail-closed (락스텝 근거) ───────────────────────────────


def test_old_file_without_new_fields_parses_as_none(tmp_path):
    """구 워커(필드 부재) → 신 코어에서 None 으로 파싱 (하위호환)."""
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
    assert back.completion_reason is None
    assert back.metrics_version is None


def test_new_file_on_old_core_is_fail_closed(tmp_path):
    """신 필드를 모르는 구 코어(extra='forbid')는 fail-closed 로 거부한다 —

    구 코어를 import 할 수 없으니, 같은 forbid 메커니즘이 '모르는 필드'를
    schema-invalid 로 잡는지로 근거를 남긴다(→ 락스텝: 코어 먼저 배포).
    """
    future = {
        "rc": 0, "status": "ok", "summary": "done", "findings_count": 0,
        "turns_used": 1, "tokens_in": 0, "tokens_out": 0,
        "evidence_paths": [],
        "some_future_field_old_core_never_saw": "boom",
    }
    (tmp_path / "worker_result.json").write_text(
        json.dumps(future), encoding="utf-8",
    )
    back = read_worker_result(tmp_path)
    assert isinstance(back, WorkerResultInvalid)
    assert back.reason == "schema"


def test_overlong_completion_reason_is_rejected_by_model():
    """model_validate 직접 경로(빌더 우회)는 max_length 로 fail-closed."""
    with pytest.raises(ValidationError):
        WorkerResult.model_validate({
            "rc": 0, "status": "ok", "summary": "s", "findings_count": 0,
            "turns_used": 0, "tokens_in": 0, "tokens_out": 0,
            "completion_reason": "z" * 65,
        })
