"""PII 정오탐 category judge 행동 테스트.

실행 (엔진 스위트와 동시 실행 금지 — 직렬 only):
    cd ~/project/secu-agent-skill
    PYTHONPATH=~/project/secu-agent/src ~/project/secu-agent/.venv/bin/python \
        -m pytest plugin/tests/test_pii_evidence_judge.py -q
DB 불필요 (judge 는 순수 함수 — 등록만 fixture 로 수행).
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_PLUGIN_DIR = Path(__file__).resolve().parents[1]


def _pii_judge_module():
    spec = importlib.util.spec_from_file_location(
        "secu_skill_pii_evidence_judge_test", _PLUGIN_DIR / "pii_evidence_judge.py",
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def pii_judge_registered():
    from secu_agent.agent.evidence_judgment import (
        register_category_evidence_judge,
        unregister_category_evidence_judge,
    )

    from secu_agent.agent import evidence_judgment as _ej

    # ⚠️ 다른 테스트가 먼저 돌면서 plugin bootstrap 을 끌어와 이미 등록해 뒀을 수 있다.
    #    (`service/tests/agents/test_dev_web_reclaim_wiring.py` 가 에이전트를 임포트하면서
    #     `register_all()` 을 부른다 — 실측으로 이 파일 하나가 오염원이었다.)
    #    "이미 등록됨" 은 이 테스트의 관심사가 아니다. 있던 것을 **기억했다가 되돌린다** —
    #    비워둔 채 끝내면 뒤에 오는 테스트가 반대 방향으로 깨진다.
    previous = _ej._CATEGORY_JUDGES.get("pii")
    mod = _pii_judge_module()
    unregister_category_evidence_judge("pii")
    register_category_evidence_judge("pii", mod.judge_pii_hit)
    try:
        yield
    finally:
        unregister_category_evidence_judge("pii")
        if previous is not None:
            register_category_evidence_judge("pii", previous)


def _finding(hit: dict):
    from secu_agent.agent.schema.finding import TaskFinding

    return TaskFinding(
        task_id="task-pii-1", task_type="smb", severity="high",
        summary="PII 노출 의심", hits=[hit],
    )


def test_rejects_rrn_matched_as_float_fraction(pii_judge_registered):
    """실사고 재현 #18318 — 부동소수 18.38118732 의 소수부가 RRN 으로 오탐된 계측 CSV."""
    from secu_agent.agent.evidence_judgment import judge_task_finding

    judgment = judge_task_finding(_finding({
        "category": "pii", "kind": "kr_rrn",
        "masked": "38118732******",
        "location": "smb://10.0.0.5/Data/DataExtractor1.csv",
        "preview": "...,MTS,X,18.38118732******,nm,18.4,5.8,21.3,15.5,...",
    }))

    assert judgment.verdict == "rejected"
    assert judgment.should_persist is False
    assert "소수부" in judgment.reason
    # 계측 맥락(nm/수치테이블) 이므로 공정정보 재분류 지시가 붙는다.
    assert "semiconductor_process" in judgment.reason


def test_rejects_rrn_with_invalid_date(pii_judge_registered):
    """앞 6자리가 11월 87일 — 유효 생년월일 아님 → 오탐 거부."""
    from secu_agent.agent.evidence_judgment import judge_task_finding

    judgment = judge_task_finding(_finding({
        "category": "pii", "kind": "kr_rrn",
        "masked": "381187-3******",
        "location": "smb://10.0.0.5/Public/list.txt",
        "preview": "seq=42 code=381187-3xxxxxx label=sample",
    }))

    assert judgment.verdict == "rejected"
    assert judgment.should_persist is False
    assert "생년월일" in judgment.reason or "YYMMDD" in judgment.reason


def test_valid_rrn_falls_through_to_core_confirm(pii_judge_registered):
    """정상형 RRN(유효 날짜·소수부 아님)은 None 폴백 → 코어 계약이 confirmed (약화 없음)."""
    from secu_agent.agent.evidence_judgment import judge_task_finding

    judgment = judge_task_finding(_finding({
        "category": "pii", "kind": "kr_rrn",
        "masked": "900101-1******",
        "location": "smb://10.0.0.5/HR/roster.xlsx",
        "preview": "이름,주민번호\n홍길동,900101-1******",
    }))

    assert judgment.verdict == "confirmed"
    assert judgment.should_persist is True


def test_valid_rrn_empty_preview_still_confirmed(pii_judge_registered):
    """기존 코어 동작 보존 — 유효 RRN 은 preview 비어도 masked 관찰값으로 confirmed."""
    from secu_agent.agent.evidence_judgment import judge_task_finding

    judgment = judge_task_finding(_finding({
        "category": "pii", "kind": "kr_rrn",
        "masked": "900101-1******",
        "location": "smb://10.0.0.5/HR/roster.xlsx",
        "preview": "",
    }))

    assert judgment.verdict == "confirmed"
    assert judgment.should_persist is True
