"""redact_sensitive_text — context_summarizer 가 LLM-summary 보내기 전에 마스킹.

SA_REDACT_SECRETS=true 환경변수 / force=True 일 때만 활성.
"""
from __future__ import annotations

import pytest

from secu_agent.agent.redact import (
    _mask_token, mask_secret, redact_sensitive_text,
)


# ============================================================
# 활성화 게이트
# ============================================================

def test_redact_default_off_passes_through():
    """기본 OFF — SA_REDACT_SECRETS 안 set 이면 그대로."""
    text = "API_KEY=sk-abcdefghijklmnopqrstuvwxyz"
    assert redact_sensitive_text(text) == text


def test_redact_force_works_without_env(monkeypatch):
    """force=True 면 env 무관 redact."""
    monkeypatch.delenv("SA_REDACT_SECRETS", raising=False)
    text = "API_KEY=sk-abcdefghijklmnopqrstuvwxyz"
    out = redact_sensitive_text(text, force=True)
    assert "sk-abcdefghijklmnopqrstuvwxyz" not in out


def test_redact_none_input():
    assert redact_sensitive_text(None) == ""


def test_redact_empty_input():
    assert redact_sensitive_text("") == ""


def test_redact_non_string():
    """비-string 도 str(...) 통과."""
    out = redact_sensitive_text(12345, force=True)
    assert out == "12345"


# ============================================================
# 패턴 — known prefix
# ============================================================

def test_redact_openai_sk_prefix():
    out = redact_sensitive_text("key=sk-abcd1234efgh5678ijkl", force=True)
    assert "sk-abcd1234efgh5678ijkl" not in out


def test_redact_github_pat():
    out = redact_sensitive_text("token=ghp_abcd1234efgh5678ijkl", force=True)
    assert "ghp_abcd1234efgh5678ijkl" not in out


def test_redact_aws_access_key_id():
    out = redact_sensitive_text("AKIAIOSFODNN7EXAMPLE found", force=True)
    assert "AKIAIOSFODNN7EXAMPLE" not in out


def test_redact_slack_token():
    out = redact_sensitive_text("xoxb-12345-6789-abcdefghij found", force=True)
    assert "xoxb-12345-6789-abcdefghij" not in out


# ============================================================
# ENV / JSON 할당 패턴
# ============================================================

def test_redact_env_assign():
    out = redact_sensitive_text(
        'MY_API_KEY="abcdefghijklmnopqrst"', force=True,
    )
    assert "abcdefghijklmnopqrst" not in out
    assert "MY_API_KEY" in out


def test_redact_json_field():
    out = redact_sensitive_text(
        '{"apiKey": "abcdefghijklmnopqrst"}', force=True,
    )
    assert "abcdefghijklmnopqrst" not in out


def test_redact_code_file_skips_env():
    """code_file=True 면 ENV/JSON 스킵."""
    text = 'MAX_TOKENS=abcdefghijklmnop'
    out = redact_sensitive_text(text, force=True, code_file=True)
    # ENV 패턴 skip → 원본 유지
    assert "abcdefghijklmnop" in out


# ============================================================
# Authorization / private key / DB / JWT
# ============================================================

def test_redact_auth_header():
    out = redact_sensitive_text(
        "Authorization: Bearer eyJxyzabcdefghijk", force=True,
    )
    assert "eyJxyzabcdefghijk" not in out


def test_redact_private_key_block():
    pk = (
        "-----BEGIN RSA PRIVATE KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOC\n"
        "-----END RSA PRIVATE KEY-----"
    )
    out = redact_sensitive_text(pk, force=True)
    assert "MIIBIjAN" not in out
    assert "REDACTED PRIVATE KEY" in out


def test_redact_db_connstr():
    out = redact_sensitive_text(
        "postgres://user:secretpass@localhost/db", force=True,
    )
    assert "secretpass" not in out
    assert "user" in out  # username 보존


def test_redact_jwt():
    out = redact_sensitive_text(
        "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadabc.sigxyz",
        force=True,
    )
    assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in out


# ============================================================
# _mask_token / mask_secret
# ============================================================

def test_mask_token_short():
    """18자 미만 — 전부 마스킹."""
    assert _mask_token("short") == "***"


def test_mask_token_long():
    """18자 이상 — 앞 6 + 뒤 4."""
    out = _mask_token("sk-abcdefghijklmnopqrstuvwx")
    assert out.startswith("sk-abc")
    assert out.endswith("uvwx")
    assert "..." in out


def test_mask_secret_helper():
    assert mask_secret("") == ""
    assert mask_secret("short", floor=12) == "***"
    assert mask_secret("longersecret123", floor=12, head=3, tail=3) == "lon***123"


# ============================================================
# 통과 (false positive 회피)
# ============================================================

def test_redact_normal_text_unchanged():
    text = "Samsung DS 기업 보안 SMB 점검 결과 5개 finding"
    out = redact_sensitive_text(text, force=True)
    assert out == text


def test_redact_short_word_unchanged():
    """짧은 token-like 단어 — false positive 안 됨."""
    text = "key=abc"
    out = redact_sensitive_text(text, force=True)
    # 패턴 모두 길이 제한 (10+) 이라 짧은 건 그대로
    assert "abc" in out
