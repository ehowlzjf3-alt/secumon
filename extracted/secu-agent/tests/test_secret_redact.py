"""v3.51-S1: secret_redact unit tests."""
from __future__ import annotations

import os

import pytest

from secu_agent.agent.secret_redact import (
    SENSITIVE_ENV_KEYS,
    redact_secrets,
)


@pytest.fixture
def smb_pw(monkeypatch):
    monkeypatch.setenv("SMB_PASSWORD", "supersecret_pw_98765")
    return "supersecret_pw_98765"


def test_redacts_smb_password_in_text(smb_pw):
    out = redact_secrets(f"login OK user=dssoc password={smb_pw} done")
    assert smb_pw not in out
    assert "***REDACTED***(SMB_PASSWORD)" in out


def test_no_env_no_op():
    # ensure no sensitive env set
    saved = {k: os.environ.pop(k, None) for k in SENSITIVE_ENV_KEYS}
    try:
        assert redact_secrets("hello world") == "hello world"
    finally:
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v


def test_empty_text_passthrough(smb_pw):
    assert redact_secrets("") == ""
    assert redact_secrets(None) is None  # type: ignore[arg-type]


def test_short_value_skipped(monkeypatch):
    monkeypatch.setenv("SMB_PASSWORD", "ab")  # <4
    out = redact_secrets("the value ab appears here")
    assert "ab" in out  # too short — not redacted


def test_multiple_keys_redacted(monkeypatch):
    monkeypatch.setenv("SMB_PASSWORD", "smbpw_longvalue")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-key-12345")
    out = redact_secrets(
        "smb=smbpw_longvalue and api=sk-openai-key-12345 sandwich"
    )
    assert "smbpw_longvalue" not in out
    assert "sk-openai-key-12345" not in out
    assert "(SMB_PASSWORD)" in out
    assert "(OPENAI_API_KEY)" in out


def test_value_appearing_multiple_times(smb_pw):
    text = f"first {smb_pw} second {smb_pw} third"
    out = redact_secrets(text)
    assert out.count("***REDACTED***(SMB_PASSWORD)") == 2
    assert smb_pw not in out


def test_longer_value_redacted_first(monkeypatch):
    """짧은 값이 긴 값의 substring 인 경우 — 긴 값부터 redact 해야 깨끗하게."""
    monkeypatch.setenv("SMB_PASSWORD", "abcdef1234")
    monkeypatch.setenv("OPENAI_API_KEY", "abcdef")  # substring
    out = redact_secrets("here is abcdef1234 and here is abcdef alone")
    # 긴 거 먼저 처리 → "abcdef1234" 가 SMB_PASSWORD 로 redact
    # 남은 "abcdef alone" 의 abcdef 는 OPENAI_API_KEY 로 redact
    assert "abcdef1234" not in out
    assert "(SMB_PASSWORD)" in out
    assert "(OPENAI_API_KEY)" in out
