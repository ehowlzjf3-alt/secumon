"""P2 W2: 스킬 state 스키마 register_schema 배선 검증 (순수 registry — DB 무접근).

bootstrap._register_state_schemas() 가 4 skill 네임스페이스를 코어 StatePort 에 등록하고,
platform 은 등록하지 않으며(코어 소유), MIGRATIONS 를 (version:int, ddl) 로 1-based 변환하는지 확인.
★codex F #4: **실제 등록된 SchemaSpec** 을 대조한다(테스트가 값을 재계산하지 않음) —
bootstrap 이 migrations=[]/idless=[] 로 바뀌면 잡히도록.
"""
from __future__ import annotations

import pytest


def _registered_spec(namespace: str):
    from secu_agent.persistence import schema_orchestrator as orch
    with orch._LOCK:
        return orch._REGISTERED.get(namespace)


def test_four_skill_namespaces_registered() -> None:
    from plugin.state_schema_wiring import register_state_schemas
    register_state_schemas()  # register_all() 우회 — state 등록만(agent_type/evidence_judge 충돌 회피)
    from secu_agent.persistence import schema_orchestrator as orch

    ns = orch.registered_namespaces()
    for expected in ("skill_smb", "skill_dev_web", "skill_github", "skill_confluence"):
        assert expected in ns, f"{expected} 미등록"


def test_platform_not_registered_by_skill() -> None:
    """platform 은 코어 소유 — 스킬이 register 하지 않고, orchestrator 도 거부."""
    from plugin.state_schema_wiring import register_state_schemas
    register_state_schemas()
    from secu_agent.persistence import schema_orchestrator as orch

    assert "platform" not in orch.registered_namespaces()

    from secu_agent.state import register_schema
    from service.state_split import platform

    with pytest.raises(ValueError):
        register_schema("platform", platform.BASELINE_DDL)


def test_registered_spec_matches_module_payload() -> None:
    """실제 등록된 SchemaSpec 이 모듈 payload 와 일치 — bootstrap 이 migrations/idless 를 빠뜨리면 실패."""
    from plugin.state_schema_wiring import register_state_schemas
    register_state_schemas()
    from service.state_split import skill_confluence, skill_dev_web, skill_github, skill_smb

    for module in (skill_smb, skill_dev_web, skill_github, skill_confluence):
        spec = _registered_spec(module.NAMESPACE)
        assert spec is not None, f"{module.NAMESPACE} SchemaSpec 없음"
        # baseline 그대로 등록
        assert spec.baseline_ddl == module.BASELINE_DDL, module.NAMESPACE
        # migrations: 등록된 version 이 1..N 이고 ddl 순서 보존(enumerate 1-based 변환 결과)
        reg_versions = [v for v, _ddl, _cs in spec.migrations]
        assert reg_versions == list(range(1, len(module.MIGRATIONS) + 1)), module.NAMESPACE
        reg_ddls = [ddl for _v, ddl, _cs in spec.migrations]
        mod_ddls = [ddl for _note, ddl in module.MIGRATIONS]
        assert reg_ddls == mod_ddls, module.NAMESPACE
        # idless 등록 payload 일치(skill_smb 만 asset_owner)
        assert set(spec.idless_tables) == set(module.IDLESS_TABLES), module.NAMESPACE


def test_only_skill_smb_registers_asset_owner_idless() -> None:
    """등록된 spec 기준 — skill_smb 만 asset_owner idless, 나머지는 없음."""
    from plugin.state_schema_wiring import register_state_schemas
    register_state_schemas()

    assert set(_registered_spec("skill_smb").idless_tables) == {"asset_owner"}
    for ns in ("skill_dev_web", "skill_github", "skill_confluence"):
        assert _registered_spec(ns).idless_tables == (), ns


def test_reregistration_is_noop() -> None:
    """같은 spec 재등록은 no-op (register_schema 멱등 — checksum 동일)."""
    from plugin.state_schema_wiring import register_state_schemas

    register_state_schemas()  # 이미 등록됐어도 동일 checksum → 예외 없음
    register_state_schemas()
