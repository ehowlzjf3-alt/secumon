"""v3.82 U3c: entity_timeline — generic(finding_lifecycle) + 등록형 소스.

도메인 테이블 조인 버전(smb_share/web_target_domain/devops_target 분기)은
domain_entity_timeline 으로 skill repo service/state_domain.py 에 이동 —
행동 테스트도 함께 이동(service/tests/state/test_entity_timeline.py).
"""
from __future__ import annotations

import pytest


def _seed_finding(asset: str, *, severity="high", summary="요약") -> None:
    from secu_agent import state

    state.finding_upsert(
        task_type="web", asset=asset, asset_kind="url",
        severity=severity, summary=summary, evidence_ref="finding.json",
    )


def test_entity_timeline_findings_only(tmp_db):
    from secu_agent import state

    _seed_finding("192.0.2.50/data/conf/app.env", severity="critical",
                  summary="AWS access key 평문 노출")
    _seed_finding("198.51.100.9/other", summary="다른 호스트")

    events = state.entity_timeline("host", "192.0.2.50")
    assert len(events) == 1
    e = events[0]
    assert e["action"] == "finding_open"
    assert e["severity"] == "critical"
    assert "AWS" in e["detail"]


def test_entity_timeline_unknown_type_raises(tmp_db):
    from secu_agent import state

    with pytest.raises(ValueError, match="unknown entity_type"):
        state.entity_timeline("planet", "x")


def test_register_timeline_source_merges_and_sorts(tmp_db):
    from secu_agent import state

    _seed_finding("app.example.test/login", summary="도메인 finding")

    def source(entity_type, entity_id):
        assert entity_type == "domain"
        assert entity_id == "app.example.test"
        return [
            {"ts": 1.0, "source": "plugtest", "action": "domain_discovered",
             "detail": entity_id, "severity": None},
            {"ts": 9e12, "source": "plugtest", "action": "domain_tasked",
             "detail": entity_id, "severity": None},
        ]

    state.register_timeline_source(source)
    try:
        events = state.entity_timeline("domain", "app.example.test")
    finally:
        assert state.unregister_timeline_source(source) is True

    actions = [e["action"] for e in events]
    assert actions[0] == "domain_discovered"        # ts=1.0 이 맨 앞
    assert actions[-1] == "domain_tasked"           # ts=9e12 가 맨 뒤
    assert "finding_open" in actions                 # 코어 finding 병합

    # 해제 후엔 plugin 이벤트 없음
    events2 = state.entity_timeline("domain", "app.example.test")
    assert all(e["source"] != "plugtest" for e in events2)


def test_register_timeline_source_duplicate_is_error(tmp_db):
    from secu_agent import state

    fn = lambda et, eid: []  # noqa: E731
    state.register_timeline_source(fn)
    try:
        with pytest.raises(ValueError, match="이미 등록됨"):
            state.register_timeline_source(fn)
    finally:
        assert state.unregister_timeline_source(fn) is True
    assert state.unregister_timeline_source(fn) is False
