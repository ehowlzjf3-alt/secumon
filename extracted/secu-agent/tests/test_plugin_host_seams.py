"""v3.85 클린 플러그인 호스트 seam — 새 도메인이 코어 0줄 수정으로 확장 가능한지.

각 test 는 "가상의 dns 도메인 plugin 이 코어를 수정하지 않고 <능력>을 등록"하는
시나리오를 검증한다. 코어에 도메인 이름이 하드코딩되면 안 된다는 불변식의 회귀 가드.
"""
from __future__ import annotations

import pytest


# ── #1 register_task_toolset ────────────────────────────────────────────────
def test_task_toolset_zero_edit_registration():
    from secu_agent.agent.tools import (
        build_registry_for_task,
        register_task_toolset,
        registered_task_toolsets,
        unregister_task_toolset,
    )
    from secu_agent.agent.tools.scan_text import ScanTextTool

    # 코어 자신의 toolset 도 같은 공개 훅으로 등록돼 있다 (특별 경로 아님)
    assert {"operator", "package_sandbox", "finding_narrator"} <= registered_task_toolsets()

    # 새 도메인이 코어 0줄 수정으로 자기 toolset 등록
    try:
        register_task_toolset("dns_scan", lambda: (ScanTextTool,))
        reg = build_registry_for_task("dns_scan")
        assert [c.name for c in reg.all()] == ["scan_text"]
    finally:
        unregister_task_toolset("dns_scan")


def test_task_toolset_duplicate_is_fail_loud():
    from secu_agent.agent.tools import register_task_toolset

    with pytest.raises(ValueError):
        register_task_toolset("operator", lambda: ())  # 코어 override 금지


def test_task_toolset_unknown_falls_back_to_generic():
    from secu_agent.agent.tools import build_registry_for_task

    reg = build_registry_for_task("never_registered_task_type")
    assert sorted(c.name for c in reg.all()) == [
        "scan_text", "submit_finding", "triage_candidates",
    ]


# ── #2 register_task_contract ───────────────────────────────────────────────
def test_task_contract_zero_edit_registration():
    from secu_agent.agent.task_contract import (
        TaskContract,
        get_task_contract,
        register_task_contract,
        registered_task_contracts,
        unregister_task_contract,
    )
    import secu_agent.agent.cli  # noqa: F401 — 코어 계약 등록 side-effect

    # 코어 계약도 같은 공개 훅으로 등록돼 있다
    assert {"generic", "finding_narrator", "package_sandbox"} <= registered_task_contracts()

    # 미등록 task_type = None (워커가 unsupported 로 fail-closed)
    assert get_task_contract("never_registered") is None

    # 새 도메인이 코어 0줄 수정으로 자기 워커 계약 등록 → 워커가 그 task_type 을 허용
    try:
        register_task_contract(TaskContract(
            task_type="dns_scan",
            build_user_message=lambda spec, ev: "dns task",
            terminal_tools=frozenset({"submit_finding"}),
        ))
        c = get_task_contract("dns_scan")
        assert c is not None and c.build_user_message({}, None) == "dns task"
    finally:
        unregister_task_contract("dns_scan")


def test_task_contract_duplicate_is_fail_loud():
    import pytest as _pytest

    from secu_agent.agent.task_contract import TaskContract, register_task_contract
    import secu_agent.agent.cli  # noqa: F401

    with _pytest.raises(ValueError):
        register_task_contract(TaskContract(
            task_type="generic",  # 코어 override 금지
            build_user_message=lambda spec, ev: "",
            terminal_tools=frozenset(),
        ))


# ── #3 register_task_type_alias ─────────────────────────────────────────────
def test_task_type_alias_core_seed_and_plugin_registration():
    from secu_agent.agent.session_runtime import runtime_task_type
    from secu_agent.agent_type_registry import (
        register_task_type_alias,
        resolve_task_type,
        unregister_task_type_alias,
    )

    # 코어는 'agent'→'operator' 만 시드 (도메인 이름 없음)
    assert resolve_task_type("agent") == "operator"
    # 미등록 도메인 agent_type = identity (별칭 없음)
    assert resolve_task_type("dns") == "dns"

    # 도메인 plugin 이 코어 0줄 수정으로 별칭 등록 → operator 로 라우팅
    try:
        register_task_type_alias("dns", "operator")
        assert runtime_task_type("dns") == "operator"
    finally:
        unregister_task_type_alias("dns")
    assert resolve_task_type("dns") == "dns"


def test_task_type_alias_core_seed_not_removable():
    from secu_agent.agent_type_registry import unregister_task_type_alias

    assert unregister_task_type_alias("agent") is False  # 코어 별칭 제거 불가


def test_routing_files_have_no_domain_literal():
    """회귀 가드: 라우팅 헬퍼에 도메인 이름 리터럴이 다시 박히지 않게."""
    import pathlib

    import secu_agent.agent.session_runtime as sr
    import secu_agent.agent.scheduler_tick as st

    for mod in (sr, st):
        src = pathlib.Path(mod.__file__).read_text(encoding="utf-8")
        assert "\"smb\"" not in src and "'smb'" not in src


# ── #4 finding enrichment 결과계약 일반화 ───────────────────────────────────
def test_enrichment_descriptor_declares_own_slot_and_signal():
    """도메인 enricher 가 자기 slot/signal_key 를 선언하면 pivot 어휘와 충돌하지 않는다."""
    from secu_agent.agent.finding_enrichment import (
        ENRICHMENT_META_KEYS,
        run_finding_enrichers,
    )

    assert {"slot", "payload", "signal_key", "signal_count", "followup_hint"} == set(
        ENRICHMENT_META_KEYS
    )

    # descriptor 를 선언하는 enricher — 결과가 그대로 흘러가는지 (소비는 submit_finding)
    from secu_agent.agent.finding_enrichment import (
        register_finding_enricher,
        unregister_all_finding_enrichers,
    )

    unregister_all_finding_enrichers()
    try:
        register_finding_enricher(lambda *, asset, summary, hits: {
            "slot": "dns_zone", "signal_key": "resolvable", "signal_count": 3,
            "payload": {"zone": "corp.example"},
        })
        out = run_finding_enrichers(asset="a", summary="s", hits=[])
        assert out[0]["slot"] == "dns_zone" and out[0]["signal_key"] == "resolvable"
    finally:
        unregister_all_finding_enrichers()


def test_followup_hint_is_registration_driven_core_has_none():
    """코어는 하드코딩 [PIVOT] nudge 를 들지 않는다 — 도메인 hint 는 등록형."""
    from secu_agent.agent.finding_enrichment import (
        register_followup_hint,
        run_followup_hints,
        unregister_all_finding_enrichers,
    )

    unregister_all_finding_enrichers()
    # 등록 없음 = hint 없음 (도메인-프리 기본)
    assert run_followup_hints([]) == []
    try:
        register_followup_hint(lambda signals: ["[DNS] verify zone transfer"])
        assert run_followup_hints([]) == ["[DNS] verify zone transfer"]
    finally:
        unregister_all_finding_enrichers()


# ── #5 evidence judge / pii 정책 등록형 ─────────────────────────────────────
def test_category_evidence_judge_zero_edit_registration():
    from secu_agent.agent.evidence_judgment import (
        register_category_evidence_judge,
        unregister_category_evidence_judge,
    )

    try:
        register_category_evidence_judge("dns_leak", lambda finding, hit: None)
        with pytest.raises(ValueError):  # 중복 = 명시 에러
            register_category_evidence_judge("dns_leak", lambda f, h: None)
    finally:
        assert unregister_category_evidence_judge("dns_leak") is True


def test_pii_exclusion_policy_registration_never_excludes_sensitive():
    from secu_agent.agent.evidence_judgment import (
        _is_identifier_only_pii,
        register_pii_exclusion_policy,
        unregister_all_pii_exclusion_policies,
    )

    unregister_all_pii_exclusion_policies()
    try:
        # 도메인이 추가 저가치 kind 를 코어 0줄 수정으로 등록
        register_pii_exclusion_policy(lambda k: k == "badge_id")
        assert _is_identifier_only_pii("badge_id") is True
        # SAFETY-KEEP: 등록 정책이 "전부 제외"해도 진짜 민감 PII 는 절대 제외 안 됨
        register_pii_exclusion_policy(lambda k: True)
        for sensitive in ("rrn", "card_number", "bank_account", "phone", "passport"):
            assert _is_identifier_only_pii(sensitive) is False
    finally:
        unregister_all_pii_exclusion_policies()


# ── #6 web router / target extractor 등록형 ─────────────────────────────────
def test_target_extractor_zero_edit_domain_field():
    from secu_agent.web.routes.chat import (
        _extract_target,
        register_target_extractor,
        unregister_all_target_extractors,
    )

    # 도메인 필드('zone')는 코어가 모름 → 등록 전 None
    assert _extract_target("dns_scan", {"zone": "corp.example"}) is None
    unregister_all_target_extractors()
    try:
        register_target_extractor(lambda name, ti: ti.get("zone"))
        assert _extract_target("dns_scan", {"zone": "corp.example"}) == "corp.example"
        # 코어 generic 키는 그대로
        assert _extract_target("x", {"url": "http://a"}) == "http://a"
    finally:
        unregister_all_target_extractors()


def test_web_router_registration_mounts_under_require_token():
    from fastapi import APIRouter

    from secu_agent.web.app import (
        create_app,
        register_web_router,
        unregister_all_web_routers,
    )

    router = APIRouter()

    @router.get("/domain/dns/zones")
    def _zones():  # pragma: no cover - 마운트 확인만
        return {"ok": True}

    unregister_all_web_routers()
    try:
        register_web_router(router)
        app = create_app()
        assert "/domain/dns/zones" in [r.path for r in app.routes]
    finally:
        unregister_all_web_routers()


# ── #7 register_entity_type (timeline 축) ───────────────────────────────────
def test_entity_type_zero_edit_axis_registration():
    from secu_agent import state

    # 코어는 host/domain/url 만 (host=prefix)
    assert state.valid_entity_types() == frozenset({"host", "domain", "url"})
    assert state._entity_match_mode("host") == "prefix"
    assert state._entity_match_mode("domain") == "substring"

    # 도메인이 새 축('ip')을 코어 0줄 수정으로 등록
    try:
        state.register_entity_type("ip", match="prefix")
        assert "ip" in state.valid_entity_types()
        assert state._entity_match_mode("ip") == "prefix"
    finally:
        assert state.unregister_entity_type("ip") is True

    # 코어 축은 제거 불가
    assert state.unregister_entity_type("host") is False


# ── #8 register_index_renderer (session_search 위치 렌더) ────────────────────
def test_index_renderer_zero_edit_domain_location():
    from secu_agent import state

    # 코어 kind(memory_rule)는 미등록 → 위치 없음 (도메인-프리)
    assert state.render_index_location({"kind": "memory_rule"}) == ""

    # 도메인이 자기 색인 kind 의 위치 렌더러를 코어 0줄 수정으로 등록
    try:
        state.register_index_renderer(
            "share_review", lambda row: f"@ {row.get('host')}/{row.get('share_name')}"
        )
        assert state.render_index_location(
            {"kind": "share_review", "host": "h1", "share_name": "s1"}
        ) == "@ h1/s1"
        with pytest.raises(ValueError):  # 중복 = 명시 에러
            state.register_index_renderer("share_review", lambda r: "")
    finally:
        assert state.unregister_index_renderer("share_review") is True
