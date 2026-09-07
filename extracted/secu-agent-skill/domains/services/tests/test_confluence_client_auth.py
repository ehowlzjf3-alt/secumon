"""confluence _client() 인증 스킴 + 프록시 우회 회귀 가드.

live 타깃(confluence.samsungds.net = Confluence Server/DC, Seraph)은
Personal Access Token 을 **Authorization: Bearer** 로 보내야 하고, 사내 내부 호스트라
**trust_env=False**(코퍼릿 프록시 우회)가 필요하다(github 클라와 동일). 이 파일은
_client() 가 (a) 토큰만 있으면 Bearer, (b) user+token 이면 Basic, (c) 토큰 없으면
무인증, 그리고 항상 trust_env=False 인지 고정한다 — 회귀 시 즉시 실패.
"""
from __future__ import annotations

import pytest

from domains.services.confluence.plugin.agent_types import confluence as cf


def _client(monkeypatch, *, user: str | None, token: str | None,
            base: str = "https://confluence.samsungds.net"):
    monkeypatch.setenv("CONFLUENCE_BASE_URL", base)
    if user is None:
        monkeypatch.delenv("CONFLUENCE_USER", raising=False)
    else:
        monkeypatch.setenv("CONFLUENCE_USER", user)
    if token is None:
        monkeypatch.delenv("CONFLUENCE_API_TOKEN", raising=False)
    else:
        monkeypatch.setenv("CONFLUENCE_API_TOKEN", token)
    return cf._client()


def test_token_only_sends_bearer(monkeypatch):
    """CONFLUENCE_USER 미설정 + 토큰만 → DC PAT 스킴(Authorization: Bearer)."""
    with _client(monkeypatch, user=None, token="pat-abc123") as c:
        assert c.headers.get("authorization") == "Bearer pat-abc123"
        assert c.auth is None
        assert c.trust_env is False


def test_user_and_token_uses_basic(monkeypatch):
    """user 설정 시 Basic 유지(Cloud/back-compat) — 수동 헤더 아닌 httpx BasicAuth."""
    with _client(monkeypatch, user="alice", token="pw") as c:
        assert c.headers.get("authorization") is None
        assert type(c.auth).__name__ == "BasicAuth"
        assert c.trust_env is False


def test_no_token_is_unauthenticated(monkeypatch):
    """토큰 없으면 무인증(익명) — Authorization 헤더 없음."""
    with _client(monkeypatch, user=None, token="") as c:
        assert c.headers.get("authorization") is None
        assert c.auth is None
        assert c.trust_env is False


def test_missing_base_raises(monkeypatch):
    monkeypatch.setenv("CONFLUENCE_BASE_URL", "")
    with pytest.raises(RuntimeError):
        cf._client()
