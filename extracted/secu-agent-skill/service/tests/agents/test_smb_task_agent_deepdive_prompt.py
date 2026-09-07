from __future__ import annotations

from pathlib import Path

from service.agents import smb_task_agent


ROOT = Path(__file__).resolve().parents[3]


def test_task_worker_contract_requires_two_vantage_credential_deepdive() -> None:
    text = (ROOT / "domains/smb/skills/smb_task/worker.md").read_text()

    assert "Current runner vantage" in text
    assert "Credential-origin PC vantage" in text
    assert "origin_pc_validation=not_performed" in text
    assert "smb_origin_credential_probe" in text
    assert "Do not hand-roll credential replay" in text
    assert "remote command execution" in text


def test_task_worker_contract_requires_listing_based_candidate_review() -> None:
    text = (ROOT / "domains/smb/skills/smb_task/worker.md").read_text()

    assert "existing detector hits" in text
    assert "suspicious_name" in text
    assert "full file/directory listing sample" in text
    assert "Do not use search hits alone as evidence" in text
    assert "nearby config/document groups" in text


def test_smb_task_skill_requires_structured_credential_impact() -> None:
    text = (ROOT / "domains/smb/skills/smb_task/SKILL.md").read_text()

    assert "runner_vantage" in text
    assert "origin_pc_vantage" in text
    assert "origin_pc_validation=not_performed" in text
    assert "remote execution" in text
    assert "smb_origin_credential_probe" in text
    assert "발견 위치" in text


def test_smb_task_skill_requires_three_source_candidate_selection() -> None:
    text = (ROOT / "domains/smb/skills/smb_task/SKILL.md").read_text()

    assert "hits_only=True" in text
    assert "suspicious_only=True" in text
    assert "suspicious_only=False" in text
    assert "directories_for_share" in text
    assert "검색 hit만" in text
    assert "제목/목록 기반 의심 파일" in text


def test_task_agent_user_text_mentions_origin_pc_validation() -> None:
    user_text = smb_task_agent._build_user_text(
        {
            "host": "10.0.0.5",
            "shares": [{
                "id": 7,
                "share": "C$",
                "share_read": 1,
                "share_write": 0,
                "null_login_ok": 0,
                "guest_login_ok": 0,
                "auth_login_ok": 1,
                "status": "walked",
            }],
        },
        charter_ref="SECOPS-TEST",
    )

    assert "현재 runner 관점" in user_text
    assert "credential 발견 PC 관점" in user_text
    assert "smb_origin_credential_probe" in user_text
    assert "origin_pc_validation=not_performed" in user_text


def test_task_agent_user_text_mentions_listing_based_deepdive() -> None:
    user_text = smb_task_agent._build_user_text(
        {
            "host": "10.0.0.5",
            "shares": [{
                "id": 7,
                "share": "C$",
                "share_read": 1,
                "share_write": 0,
                "null_login_ok": 0,
                "guest_login_ok": 0,
                "auth_login_ok": 1,
                "status": "walked",
            }],
        },
        charter_ref="SECOPS-TEST",
    )

    assert "기존 hit 검색 결과만" in user_text
    assert "suspicious_only=True" in user_text
    assert "suspicious_only=False" in user_text
    assert "같은 폴더의 주변 파일" in user_text


def test_task_agent_unlocks_origin_credential_probe_tool() -> None:
    names = {tool.name for tool in smb_task_agent._tool_classes()}

    assert "smb_origin_credential_probe" in names
