"""v3.60 S3: smb-batch driver helpers — is_smb_batch_goal / build_smb_continuation_prompt."""
from __future__ import annotations

import pytest

from engine_extracts.goal_manager_domain import (
    build_smb_continuation_prompt, is_smb_batch_goal,
)


@pytest.mark.parametrize("text", [
    "[smb-batch] 발견된 host 전부 점검",
    "공유폴더 전부 점검",
    "파일서버 전부 점검",
    "모든 share 훑어",
])
def test_is_smb_batch_true(text):
    assert is_smb_batch_goal(text) is True


@pytest.mark.parametrize("text", [
    "[web-batch] cdep 사이트 점검",
    "특정 호스트 하나만",
    "",
])
def test_is_smb_batch_false(text):
    assert is_smb_batch_goal(text) is False


def test_build_smb_continuation_embeds_single_host():
    row = {"host": "10.0.0.5", "subnet": "10.0.0.0/24", "share_ids": [1, 2, 3]}
    out = build_smb_continuation_prompt(row, remaining=7)
    assert "10.0.0.5" in out
    assert "smb_host_sweep" in out
    assert "smb_host_set_status" in out
    assert "submit_finding" in out
    assert "7" in out  # remaining
    assert "하나만" in out  # 단일 host 집중


def test_build_smb_continuation_missing_fields_safe():
    out = build_smb_continuation_prompt({}, remaining=0)
    assert "smb_host_sweep" in out
