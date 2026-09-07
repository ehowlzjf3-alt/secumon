"""v3.54 web-batch driver helpers — is_web_batch_goal / build_web_continuation_prompt."""
from __future__ import annotations

import pytest

from engine_extracts.goal_manager_domain import (
    build_web_continuation_prompt, is_web_batch_goal,
)


@pytest.mark.parametrize("text", [
    "오늘 cdep 웹 사이트 전부 점검 완료",
    "[web-batch] 전체 점검",
    "웹점검 전부",
    "task all websites today",
])
def test_is_web_batch_true(text):
    assert is_web_batch_goal(text) is True


@pytest.mark.parametrize("text", [
    "SMB 서브넷 전부 스캔",
    "특정 호스트 점검",
    "",
])
def test_is_web_batch_false(text):
    assert is_web_batch_goal(text) is False


def test_build_web_continuation_embeds_single_target():
    row = {"id": 7, "domain": "py0521--sfd-prod.cdep.samsungds.net", "event_count": 42}
    out = build_web_continuation_prompt(row, remaining=178)
    # 단일 타깃 명시
    assert "py0521--sfd-prod.cdep.samsungds.net" in out
    assert "target_id=7" in out
    assert "178" in out
    # 핵심 절차/지시
    assert "web_site_sweep(target_id=7)" in out
    assert "하나만" in out
    assert "다음 turn" in out  # 리스트 직접 순회 금지 신호
    assert "submit_finding" in out
    assert "web_target_set_status" in out


def test_build_web_continuation_missing_fields_safe():
    out = build_web_continuation_prompt({}, remaining=0)
    assert "target_id=?" in out  # 안전 기본값
