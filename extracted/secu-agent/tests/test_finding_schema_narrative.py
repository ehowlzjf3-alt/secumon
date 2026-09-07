"""v3.76: TaskFinding 의 agent-writable narrative 필드 (risk_narrative/evidence_notes/pivot)."""
from __future__ import annotations

from secu_agent.agent.schema.finding import (
    EvidenceNote, TaskFinding, RiskNarrative,
)


def _base(**extra):
    return TaskFinding(
        task_type="web", severity="high", summary="x",
        hits=[], **extra,
    )


def test_narrative_roundtrip_into_extra():
    """model_dump 으로 narrative 필드가 직렬화돼 extra_json 에 적재 가능."""
    f = _base(
        risk_narrative=RiskNarrative(
            what_is_data="DB 연결 문자열",
            exploitation_path="내부 비인가자가 DB 직접 접근",
        ),
        evidence_notes={
            "https://x/.env": EvidenceNote(
                what_this_is="환경설정", sensitive_fields=["db_password"],
            ),
        },
        pivot_interpretation="게이트웨이 도달 가능",
    )
    dumped = f.model_dump(mode="json")
    assert dumped["risk_narrative"]["what_is_data"] == "DB 연결 문자열"
    assert dumped["risk_narrative"]["how_discovered"] == ""  # 미작성 부분은 기본 ""
    assert dumped["evidence_notes"]["https://x/.env"]["sensitive_fields"] == ["db_password"]
    assert dumped["pivot_interpretation"] == "게이트웨이 도달 가능"


def test_narrative_absent_defaults():
    """narrative 미지정 시 risk_narrative=None, evidence_notes={}, pivot_interpretation=''."""
    f = _base()
    dumped = f.model_dump(mode="json")
    assert dumped["risk_narrative"] is None
    assert dumped["evidence_notes"] == {}
    assert dumped["pivot_interpretation"] == ""


def test_description_enforces_masking():
    """스키마 description 에 '값 아닌 유형/마스킹' 룰이 명시돼야 한다 (마스킹 강제 가드)."""
    schema = TaskFinding.model_json_schema()
    # $defs 까지 직렬화한 전체 문자열에서 마스킹 룰 단어를 확인.
    import json
    blob = json.dumps(schema, ensure_ascii=False)
    assert "마스킹" in blob
    assert "유형" in blob
    # RiskNarrative / EvidenceNote 가 스키마에 정의됨
    rn = RiskNarrative.model_json_schema()
    assert "마스킹" in json.dumps(rn, ensure_ascii=False)
    en = EvidenceNote.model_json_schema()
    assert "값" in json.dumps(en, ensure_ascii=False)
