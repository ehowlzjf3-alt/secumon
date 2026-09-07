"""smb_target_subnet 영속 layer — operator agent 가 DB 에 직접 추가/관리 가능한 subnet 풀.

설계:
- config/targets.yaml 은 source-controlled — 코드 일관성. 점검 운영 중 동적으로 추가하고 싶을 때
  DB 측에 별도 풀. scan-smb 가 둘다 merge.
- CIDR 검증 (ipaddress.ip_network strict=False) — 오타 차단.
- enabled flag 로 일시 끄기 가능.
- audit: added_by + created_at, 누가 추가했는지 추적.
"""
from __future__ import annotations

import service.state_domain as sd

import pytest


def test_smb_target_add_returns_id_and_persists(tmp_db):
    from secu_agent import state  # noqa: F401
    tid = sd.smb_target_add(
        subnet="192.0.2.0/24",
        note="office floor 4",
        charter_ref="CHARTER-PLACEHOLDER-001",
        added_by="operator",
    )
    assert isinstance(tid, int)
    rows = sd.smb_target_list()
    assert len(rows) == 1
    r = rows[0]
    assert r["subnet"] == "192.0.2.0/24"
    assert r["note"] == "office floor 4"
    assert r["enabled"] == 1
    assert r["added_by"] == "operator"


def test_smb_target_add_normalizes_cidr(tmp_db):
    """strict=False 로 host bits 허용. ipaddress 가 정규화한 표현으로 저장."""
    from secu_agent import state
    tid = sd.smb_target_add(subnet="192.0.2.5/24")
    r = sd.smb_target_list()[0]
    # /24 정규화: 192.0.2.0/24
    assert r["subnet"] == "192.0.2.0/24"


def test_smb_target_add_rejects_garbage_cidr(tmp_db):
    from secu_agent import state
    with pytest.raises(ValueError):
        sd.smb_target_add(subnet="not a CIDR")
    with pytest.raises(ValueError):
        sd.smb_target_add(subnet="300.300.300.0/24")


def test_smb_target_add_duplicate_returns_same_id(tmp_db):
    """같은 subnet 두번 추가하면 노트만 업데이트 — UNIQUE."""
    from secu_agent import state
    a = sd.smb_target_add(subnet="192.0.2.0/24", note="first")
    b = sd.smb_target_add(subnet="192.0.2.0/24", note="second")
    assert a == b
    r = sd.smb_target_list()[0]
    assert r["note"] == "second"


def test_smb_target_list_enabled_only(tmp_db):
    from secu_agent import state
    a = sd.smb_target_add(subnet="192.0.2.0/24")
    b = sd.smb_target_add(subnet="192.0.2.0/24")
    sd.smb_target_set_enabled(b, False)

    all_rows = sd.smb_target_list()
    assert len(all_rows) == 2
    en = sd.smb_target_list(enabled_only=True)
    assert [r["id"] for r in en] == [a]


def test_smb_target_remove(tmp_db):
    from secu_agent import state
    a = sd.smb_target_add(subnet="192.0.2.0/24")
    sd.smb_target_remove(a)
    assert sd.smb_target_list() == []


def test_smb_target_remove_by_subnet_string(tmp_db):
    from secu_agent import state
    sd.smb_target_add(subnet="192.0.2.0/24")
    sd.smb_target_remove_by_subnet("192.0.2.0/24")
    assert sd.smb_target_list() == []
