"""SMB evidence judge 행동 테스트 — 엔진 코어에서 이동한 원형 (v3.82 U3a).

원위치: 엔진 tests/test_evidence_judgment.py 의 SMB 4종 (코어 게이트가
등록형으로 전환되면서 judge 와 함께 이동 — 코어에는 dispatch 계약 테스트만 잔류).

실행 (엔진 스위트와 동시 실행 금지 — 직렬 only):
    cd ~/project/secu-agent-skill
    PYTHONPATH=~/project/secu-agent/src ~/project/secu-agent/.venv/bin/python \
        -m pytest plugin/tests/ -q
DB 불필요 (judge 는 순수 함수 — 등록만 fixture 로 수행).
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_PLUGIN_DIR = Path(__file__).resolve().parents[1]


def _judge_module():
    spec = importlib.util.spec_from_file_location(
        "secu_skill_smb_evidence_judge_test", _PLUGIN_DIR / "smb_evidence_judge.py",
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def smb_judge_registered():
    from secu_agent.agent.evidence_judgment import (
        register_evidence_judge,
        unregister_evidence_judge,
    )

    from secu_agent.agent import evidence_judgment as _ej

    # ⚠️ 다른 테스트가 먼저 돌면서 plugin bootstrap 을 끌어와 이미 등록해 뒀을 수 있다.
    #    (`service/tests/agents/test_dev_web_reclaim_wiring.py` 가 에이전트를 임포트하면서
    #     `register_all()` 을 부른다 — 실측으로 이 파일 하나가 오염원이었다.)
    #    "이미 등록됨" 은 이 테스트의 관심사가 아니다. 있던 것을 **기억했다가 되돌린다** —
    #    비워둔 채 끝내면 뒤에 오는 테스트가 반대 방향으로 깨진다.
    previous = _ej._TASK_TYPE_JUDGES.get("smb")
    mod = _judge_module()
    unregister_evidence_judge("smb")
    register_evidence_judge("smb", mod.judge_smb_credential_hit)
    try:
        yield
    finally:
        unregister_evidence_judge("smb")
        if previous is not None:
            register_evidence_judge("smb", previous)


def test_rejects_printer_driver_password_field_assertion(smb_judge_registered):
    """print$ 드라이버 INI의 password field 존재 주장만으로 credential finding 금지."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-smb-print-1",
        task_type="smb",
        severity="high",
        summary="print$ 드라이버 설정 파일에 비밀번호 필드가 있음",
        hits=[{
            "category": "credential",
            "kind": "printer_fax_config_password_fields",
            "location": "file:smb://10.0.0.5/print$/x64/BuAiniNT.ini:2113,2254",
            "masked": (
                "Document User Password=<masked,len=24>; "
                "SMTP Password=<masked,len=12>"
            ),
            "preview": (
                "Document User Password(value_present=True,len=24), "
                "SMTP Password(value_present=True,len=12)"
            ),
        }],
    )

    judgment = judge_task_finding(finding)

    assert judgment.verdict == "rejected"
    assert judgment.should_persist is False
    assert "printer driver password-field claim" in judgment.reason


def test_rejects_smb_credential_without_direct_file_value(smb_judge_registered):
    """SMB credential은 scan label/value_present만으로 저장하지 않는다."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-smb-cred-weak",
        task_type="smb",
        severity="high",
        summary="설정 파일에 비밀번호 필드가 있다고 탐지됨",
        hits=[{
            "category": "credential",
            "kind": "generic_password_assignment",
            "location": "smb://10.0.0.5/Public/app.ini",
            "masked": "<masked,len=12>",
            "preview": "password field value_present=True",
        }],
    )

    judgment = judge_task_finding(finding)

    assert judgment.verdict == "rejected"
    assert judgment.should_persist is False
    assert "deep-dive evidence" in judgment.reason


def test_suspects_smb_credential_pair_without_probe_validation(smb_judge_registered):
    """URL + id/pw 조합은 safe_probe 검증 결과 없이 바로 저장하지 않는다."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-smb-cred-probe-required",
        task_type="smb",
        severity="high",
        summary="로그인 URL과 계정쌍이 같은 파일에서 확인됨",
        hits=[{
            "category": "credential",
            "kind": "generic_password_assignment",
            "location": "smb://10.0.0.5/Public/login.txt",
            "masked": "id=svc_app; pw=p***",
            "preview": "login_url=https://app.example.test/login\nid=svc_app\npw=p***",
        }],
    )

    judgment = judge_task_finding(finding)

    assert judgment.verdict == "suspected"
    assert judgment.should_persist is False
    assert "validation result" in judgment.reason


def test_accepts_smb_credential_pair_with_probe_validation(smb_judge_registered):
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-smb-cred-probed",
        task_type="smb",
        severity="high",
        summary="로그인 URL과 계정쌍이 같은 파일에서 확인되고 검증됨",
        hits=[{
            "category": "credential",
            "kind": "generic_password_assignment",
            "location": "smb://10.0.0.5/Public/login.txt",
            "masked": "id=svc_app; pw=p***",
            "preview": "login_url=https://app.example.test/login\nid=svc_app\npw=p***",
            "validation": {
                "kind": "credential_reachability",
                "policy": "GET and login-form POST only; non-login POST/PUT/PATCH/DELETE not sent",
                "attempted": True,
                "targets": [{"method": "GET", "url": "https://app.example.test/login"}],
                "auth_attempts": [{"type": "form_login_post", "method": "POST"}],
            },
        }],
    )

    judgment = judge_task_finding(finding)

    assert judgment.verdict == "confirmed"
    assert judgment.should_persist is True


def test_non_credential_category_falls_back_to_generic(smb_judge_registered):
    """credential/secret 외 카테고리는 None 폴백 — 코어 generic 계약 적용."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-smb-pii-1", task_type="smb", severity="high",
        summary="인증 없이 주민등록번호 노출",
        hits=[{
            "category": "pii", "kind": "kr_rrn",
            "masked": "900101-1******",
            "location": "smb://10.0.0.5/Public/doc.xlsx", "preview": "",
        }],
    )
    judgment = judge_task_finding(finding)
    assert judgment.verdict == "confirmed"


# ── #33: 개인키는 SMB judge 도 통과해야 한다 ─────────────────────────────
#
# 2026-08-22 target 1766 `workspace/platform/config/gpg/arcashield.asc`.
# 검토원이 3회 제출을 시도했고 3회 다 이 judge 가 거부했다. 원인은 판정이 아니라
# **증거가 오는 길**이었다: 코어 `mask_secret` 이 armor 헤더의 다섯째 대시를 별표로
# 만들어(`-----BEGIN …-----` → `----***…----`) 이 judge 가 요구하는 바로 그
# "PEM 라인" 을 파이프라인이 스스로 파괴했다. 게다가 판정기 마커 정규식엔
# `( BLOCK)?` 가 없어 PGP armor 는 원문이 온전해도 거부됐다. 둘 다 코어에서 고쳤다.
#
# 여기서 고정하는 건 **도메인 계약**이다 — 스캔이 내놓은 masked 를 그대로 제출하면
# 개인키는 통과하고, 라벨·주장만인 것은 여전히 거부된다.

_PK_ARMORS = [
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
]


@pytest.mark.parametrize("armor", _PK_ARMORS)
def test_accepts_private_key_evidence_as_produced_by_the_scanner(
    armor, smb_judge_registered,
):
    """검토원이 실제로 밟는 경로 — 스캔의 masked 를 그대로 제출한다."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding
    from secu_agent.detectors import scan_text

    body = "MIIEpAIBAAKCAQEA2M8PsWFq+qRDgYLOzQ7bF7a3D1fdHJXVPSM27AGKy2s09VXE"
    hits = [h for h in scan_text(armor + "\n" + body).hits
            if h.kind == "private_key_block"]
    assert hits, f"탐지 실패: {armor}"
    masked = hits[0].masked

    finding = TaskFinding(
        task_id="task-smb-pk",
        task_type="smb",
        severity="high",
        summary="공유 폴더에 개인키가 평문 노출됨",
        hits=[{
            "category": "secret",
            "kind": "private_key_block",
            "location": "smb://12.36.137.172/share/workspace/platform/config/gpg/k.asc",
            "masked": masked,
            "preview": masked,
        }],
    )
    j = judge_task_finding(finding)
    assert j.should_persist, f"{armor} → {j.verdict}: {j.reason}"


def test_still_rejects_a_private_key_claim_with_no_armor_line(smb_judge_registered):
    """★ 약화 회귀 — 산문으로 '개인키가 있다' 고만 하면 여전히 거부."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-smb-pk-weak",
        task_type="smb",
        severity="high",
        summary="개인키로 보이는 파일이 있음",
        hits=[{
            "category": "secret",
            "kind": "private_key_block",
            "location": "smb://12.36.137.172/share/x.pem",
            "masked": "private key file detected",
            "preview": "value_present=True",
        }],
    )
    j = judge_task_finding(finding)
    assert j.verdict == "rejected"
    assert j.should_persist is False
