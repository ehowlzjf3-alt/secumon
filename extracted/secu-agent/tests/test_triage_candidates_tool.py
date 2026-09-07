"""triage_candidates — 후보 기각의 감사가능 기록 (침묵 게이트의 합법 출구)."""
from __future__ import annotations

import asyncio
import json

import pytest
from pydantic import ValidationError

from secu_agent.agent.candidate_ledger import candidate_ledger_stats
from secu_agent.agent.tools.base import ToolContext, ToolSuccess
from secu_agent.agent.tools.triage_candidates import (
    TRIAGE_FILENAME,
    TriageCandidatesInput,
    TriageCandidatesTool,
    _mask_triage,
)


def _run(tmp_path, payload: dict, metadata: dict | None = None):
    ctx = ToolContext(evidence_dir=tmp_path, metadata=metadata if metadata is not None else {})
    tool = TriageCandidatesTool()
    result = asyncio.run(tool.execute(
        TriageCandidatesInput.model_validate(payload), ctx,
    ))
    return result, ctx


def test_triage_writes_jsonl_and_updates_ledger(tmp_path):
    result, ctx = _run(tmp_path, {
        "dispositions": [
            {"location": "https://conf.example/page1",
             "reason": "로그인 요구 — 인증 없이 데이터 미노출"},
            {"location": "repo/config.tpl",
             "reason": "빈 password 필드의 드라이버 템플릿"},
        ],
        "note": "confluence 후보 22건 중 상위 2건 재확인",
    })
    assert isinstance(result, ToolSuccess)
    assert "2 candidate(s) triaged" in result.content
    assert candidate_ledger_stats(ctx.metadata) == (0, 0, 2)

    lines = (tmp_path / TRIAGE_FILENAME).read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["location"] == _mask_triage("https://conf.example/page1")
    assert first["note"] == _mask_triage("confluence 후보 22건 중 상위 2건 재확인")


def test_triage_appends_across_calls(tmp_path):
    md: dict = {}
    _run(tmp_path, {"dispositions": [
        {"location": "a", "reason": "OSS LICENSE 연락처 이메일이라 제외"},
    ]}, md)
    _run(tmp_path, {"dispositions": [
        {"location": "b", "reason": "placeholder 값 — 실제 credential 아님"},
    ]}, md)
    lines = (tmp_path / TRIAGE_FILENAME).read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert candidate_ledger_stats(md) == (0, 0, 2)


def test_triage_persisted_reason_is_masked(tmp_path):
    # codex 2R #7: fixpoint 마스킹이 single-pass 와 달라질 수 있으므로 exact-equality
    # 대신 secret 값 부재로 단정.
    secret_reason = "테스트 확인함 password=SuperSecret123! 은 데모 계정 값이라 제외"
    _run(tmp_path, {"dispositions": [{"location": "x", "reason": secret_reason}]})
    line = (tmp_path / TRIAGE_FILENAME).read_text(encoding="utf-8")
    assert "SuperSecret123!" not in line


def test_triage_rejects_empty_and_short_reason():
    with pytest.raises(ValidationError):
        TriageCandidatesInput.model_validate({"dispositions": []})
    with pytest.raises(ValidationError):
        TriageCandidatesInput.model_validate({
            "dispositions": [{"location": "a", "reason": "n/a"}],
        })


def test_triage_rejects_whitespace_gaming():
    # codex #2: 공백-only 로 min_length 통과시켜 가짜 triage 로 게이트 무력화 차단.
    with pytest.raises(ValidationError):
        TriageCandidatesInput.model_validate({
            "dispositions": [{"location": " ", "reason": "            "}],
        })
    with pytest.raises(ValidationError):
        TriageCandidatesInput.model_validate({
            "dispositions": [{"location": "x", "reason": "   \t   \n   "}],
        })


def test_triage_rejects_zero_width_gaming():
    # codex 2R #5: strip()이 못 지우는 zero-width/format 문자로 보이지 않는 가짜
    # disposition 을 만드는 것 차단.
    zw = "​"
    with pytest.raises(ValidationError):
        TriageCandidatesInput.model_validate({
            "dispositions": [{"location": zw, "reason": zw * 20}],
        })
    with pytest.raises(ValidationError):
        TriageCandidatesInput.model_validate({
            "dispositions": [{"location": "x", "reason": "﻿" * 15}],
        })
    # codex 4R #2: 결합표시(Mn) — U+034F(CGJ)·U+FE00(변이선택자)만으로도 거부.
    with pytest.raises(ValidationError):
        TriageCandidatesInput.model_validate({
            "dispositions": [{"location": "͏", "reason": "͏︀" * 10}],
        })


def test_triage_accepts_legit_korean_and_emoji():
    # 정상 한글/이모지 사유는 통과(가시 base 문자 존재).
    TriageCandidatesInput.model_validate({
        "dispositions": [{
            "location": "https://x/y",
            "reason": "로그인 요구 화면이라 데이터 미노출 ✅ 제외함",
        }],
    })


def test_triage_masks_high_entropy_token(tmp_path):
    # codex #13: 키워드 없는 세션 토큰도 엔트로피 스캔으로 마스킹 — 평문 영속 금지.
    token = "kJ8xQ2mP9zL4vR7nW1cB5dF3gH6jK0sAeT"
    _run(tmp_path, {"dispositions": [{
        "location": "https://x/y",
        "reason": f"세션 토큰 {token} 은 만료된 데모 값이라 제외함",
    }]})
    line = (tmp_path / TRIAGE_FILENAME).read_text(encoding="utf-8")
    assert token not in line


def test_triage_masks_beyond_entropy_cap(tmp_path):
    # codex 2R #1(치명): 엔트로피 스캐너 4-hit 캡을 넘는 토큰 6개도 전부 마스킹돼야
    # 한다(반복 마스킹). 5번째부터 평문 영속하면 안 됨.
    toks = [f"kJ8xQ2mP9zL4vR7nW1cB5dF3gH6jK0sAeT{i}" for i in range(6)]
    reason = "확인함: " + " ".join(toks) + " 는 전부 만료된 데모 토큰이라 제외"
    _run(tmp_path, {"dispositions": [{"location": "https://x/y", "reason": reason}]})
    line = (tmp_path / TRIAGE_FILENAME).read_text(encoding="utf-8")
    for t in toks:
        assert t not in line, t
