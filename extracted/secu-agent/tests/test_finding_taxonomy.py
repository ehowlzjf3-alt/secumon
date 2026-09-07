"""v3.74 C-1: 도메인-중립 finding 분류 헬퍼."""
from __future__ import annotations

from secu_agent.finding_taxonomy import canonical_task_type, classify, host_of


def test_host_of_variants():
    assert host_of("https://github.samsungds.net/a/b") == "github.samsungds.net"
    assert host_of("github.samsungds.net") == "github.samsungds.net"
    assert host_of("") == ""


def test_canonical_passthrough_without_registration():
    """v3.82 U3b: 코어 기본 = passthrough — 도메인 휴리스틱은 plugin 등록형."""
    assert canonical_task_type("devops", "https://github.example.test/o/r") == "devops"
    assert canonical_task_type("smb", "smb://fileserver/share/x") == "smb"
    assert canonical_task_type("web", "https://app.example.test/.env") == "web"


def test_register_task_type_canonicalizer():
    """등록된 canonicalizer 가 순서대로 시도되고 첫 비-None 채택, 중복=에러."""
    import pytest

    from secu_agent.finding_taxonomy import (
        register_task_type_canonicalizer, unregister_task_type_canonicalizer,
    )

    def by_host(task_type, asset):
        return "plugsvc" if "plugsvc" in host_of(asset) else None

    register_task_type_canonicalizer(by_host)
    try:
        assert canonical_task_type("devops", "https://plugsvc.example.test/x") == "plugsvc"
        assert canonical_task_type("devops", "https://other.example.test/x") == "devops"
        with pytest.raises(ValueError, match="이미 등록됨"):
            register_task_type_canonicalizer(by_host)
    finally:
        assert unregister_task_type_canonicalizer(by_host) is True
    assert unregister_task_type_canonicalizer(by_host) is False
    assert canonical_task_type("devops", "https://plugsvc.example.test/x") == "devops"


def test_classify_dominant_category_priority():
    # 2 misconfig + 1 credential → priority(credential=9) > priority(misconfig=2)
    hits = [{"category": "misconfig"}, {"category": "misconfig"}, {"category": "credential"}]
    r = classify(hits=hits)
    assert r["key"] == "credential"
    assert r["label"] == "크리덴셜 노출"


def test_classify_base_seven_labels():
    """de-domain (v3.81 T4): 코어 베이스 7종만 — 도메인 분류는 plugin 등록형."""
    pairs = [
        ("secret", "시크릿 노출"),
        ("credential", "크리덴셜 노출"),
        ("pii", "개인정보 노출"),
        ("web_vuln", "웹 취약점"),
        ("misconfig", "설정 오류"),
        ("internal_system", "내부 시스템 정보"),
        ("attack_surface", "공격 표면"),
    ]
    for cat, label in pairs:
        assert classify(hits=[{"category": cat}]) == {"key": cat, "label": label}


def test_unregistered_domain_category_passthrough():
    """미등록(plugin 미부착) 도메인 분류 — 라벨=원문, 우선순위=0 (legacy 안전)."""
    from secu_agent.finding_taxonomy import category_rank, classification_label

    r = classify(hits=[{"category": "semiconductor_process"}])
    assert r == {"key": "semiconductor_process", "label": "semiconductor_process"}
    assert category_rank("semiconductor_process") == 0
    assert classification_label("semiconductor_process") == "semiconductor_process"


def test_register_finding_category_plugin_api():
    """plugin 등록 → classify/rank/label 즉시 반영, 중복=에러, 베이스 제거 불가."""
    import pytest

    from secu_agent.finding_taxonomy import (
        category_rank, classification_label, register_finding_category,
        unregister_finding_category,
    )

    try:
        register_finding_category(
            "semiconductor_process", label="공정 정보", priority=7,
        )
        assert classification_label("semiconductor_process") == "공정 정보"
        assert category_rank("semiconductor_process") == 7
        # 우선순위 체계에 합류 — credential(9) > semiconductor_process(7) > misconfig(2)
        r = classify(hits=[{"category": "misconfig"},
                           {"category": "semiconductor_process"}])
        assert r["key"] == "semiconductor_process"
        with pytest.raises(ValueError, match="이미 등록"):
            register_finding_category(
                "semiconductor_process", label="x", priority=1,
            )
    finally:
        assert unregister_finding_category("semiconductor_process") is True
    assert unregister_finding_category("secret") is False  # 베이스 제거 불가


def test_register_finding_category_content_evidence_flag():
    """v3.82 U3a: requires_content_evidence=True 등록 분류는 evidence 게이트 집합에 합류."""
    from secu_agent.finding_taxonomy import (
        plugin_content_evidence_categories,
        register_finding_category,
        unregister_finding_category,
    )

    assert "plugtest_ce" not in plugin_content_evidence_categories()
    register_finding_category(
        "plugtest_ce", label="증거필수 분류", priority=7,
        requires_content_evidence=True,
    )
    try:
        assert "plugtest_ce" in plugin_content_evidence_categories()
    finally:
        assert unregister_finding_category("plugtest_ce") is True
    assert "plugtest_ce" not in plugin_content_evidence_categories()


def test_register_finding_category_default_no_content_evidence():
    from secu_agent.finding_taxonomy import (
        plugin_content_evidence_categories,
        register_finding_category,
        unregister_finding_category,
    )

    register_finding_category("plugtest_plain", label="평범 분류", priority=1)
    try:
        assert "plugtest_plain" not in plugin_content_evidence_categories()
    finally:
        unregister_finding_category("plugtest_plain")
