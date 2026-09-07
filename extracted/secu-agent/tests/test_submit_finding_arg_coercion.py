"""submit_finding `finding` 인자 JSON-문자열 coercion (CORE-ASK, 워커 완주 블로커).

라이브 재현: gauss 가 중첩 객체 finding 을 JSON 문자열로 직렬화해 보내
`Input should be a valid dictionary or instance of TaskFinding` ×2 →
repeat_error_halt 로 워커가 finding 0 으로 죽었다. submit_verdict 가 이미 쓰는
_coerce_json_container 를 공용 승격해 SubmitFindingInput.finding 에 배선.
invoker 는 input_model.model_validate(raw_input) 를 부르므로(모델 레벨이
프로덕션 seam) 여기서 모델 검증으로 커버한다.
"""
from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from secu_agent.agent.tools._arg_coercion import (
    _coerce_json_container,
    _coerce_str_list,
)
from secu_agent.agent.tools.submit_finding import SubmitFindingInput


def _finding_dict() -> dict:
    return {
        "task_type": "confluence",
        "target": "https://wiki.example.test/spaces/ENG",
        "severity": "high",
        "summary": "위키 페이지에 자격증명 평문 노출 — 즉시 회수 필요한 수준의 설명 텍스트",
        "hits": [
            {
                "category": "credential",
                "kind": "plaintext_password",
                "masked": "pw=***",
                "location": "https://wiki.example.test/pages/123",
                "preview": "pw=***",
            }
        ],
        "recommended_actions": ["페이지 접근권한 축소", "노출 자격증명 교체"],
    }


def test_finding_as_json_string_coerces_and_validates():
    """수용기준 1: JSON 문자열 finding → dict coerce 후 정상 검증 (라이브 재현 형태)."""
    raw = {"finding": json.dumps(_finding_dict())}
    inp = SubmitFindingInput.model_validate(raw)
    assert inp.finding.task_type == "confluence"
    assert inp.finding.hits[0].category == "credential"


def test_finding_as_dict_unchanged():
    """수용기준 1(후반): 이미 dict 면 종전과 동일하게 검증."""
    inp = SubmitFindingInput.model_validate({"finding": _finding_dict()})
    assert inp.finding.severity == "high"


def test_plain_string_still_clean_validation_error():
    """수용기준 2: '{'-비접두 평문은 coerce 시도 없이 원문 보존 → 깨끗한
    ValidationError (crash 아님)."""
    with pytest.raises(ValidationError):
        SubmitFindingInput.model_validate({"finding": "just a plain sentence"})


def test_broken_json_string_preserved_then_validation_error():
    """수용기준 2(후반): 파싱 실패 '{'-문자열은 원문 보존 → pydantic 이 거부.
    coercion 이 새 실패 모드를 만들지 않는다."""
    with pytest.raises(ValidationError):
        SubmitFindingInput.model_validate({"finding": '{"task_type": broken'})


def test_python_repr_dict_string_coerces():
    """json.loads 실패 → ast.literal_eval 재시도 경로 (단따옴표 Python-repr)."""
    repr_str = str(_finding_dict())  # 단따옴표 dict repr
    inp = SubmitFindingInput.model_validate({"finding": repr_str})
    assert inp.finding.task_type == "confluence"


def test_shared_helpers_importable_from_submit_verdict_too():
    """공용 승격 후에도 submit_verdict 네임스페이스에 종전 이름 유지(back-compat)."""
    from secu_agent.agent.tools import submit_verdict as sv

    assert sv._coerce_json_container is _coerce_json_container
    assert sv._coerce_str_list is _coerce_str_list


# ── triage_candidates.dispositions — 침묵 게이트의 합법 출구도 같은 보정 ─────


def test_triage_dispositions_as_json_string_coerces():
    """침묵 게이트가 gauss 에게 지시하는 도구 — list-of-objects 문자열화 보정."""
    from secu_agent.agent.tools.triage_candidates import TriageCandidatesInput

    raw = {"dispositions": json.dumps([
        {"location": "https://wiki.example.test/pages/1",
         "reason": "빈 password 템플릿 필드 — 실제 값 없음 확인"},
    ])}
    inp = TriageCandidatesInput.model_validate(raw)
    assert len(inp.dispositions) == 1
    assert inp.dispositions[0].location.endswith("/pages/1")


def test_triage_dispositions_dict_list_unchanged():
    from secu_agent.agent.tools.triage_candidates import TriageCandidatesInput

    inp = TriageCandidatesInput.model_validate({"dispositions": [
        {"location": "smb://share/doc.pdf", "reason": "OSS LICENSE 연락처 이메일만 존재"},
    ]})
    assert inp.dispositions[0].reason.startswith("OSS")


def test_triage_broken_string_still_clean_validation_error():
    from secu_agent.agent.tools.triage_candidates import TriageCandidatesInput

    with pytest.raises(ValidationError):
        TriageCandidatesInput.model_validate({"dispositions": '[{"location": broken'})
