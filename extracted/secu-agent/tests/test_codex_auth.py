"""v3.56: codex OAuth 토큰 매니저 — load/refresh/save/만료/account_id.

실제 토큰 없이 합성 JWT + mock httpx 로 검증. 토큰값은 테스트에서도 합성만 사용.
"""
from __future__ import annotations

import base64
import json
import os
import stat
import time
from pathlib import Path

import pytest

from secu_agent.agent.llm import codex_auth as ca
from secu_agent.agent.llm.codex_auth import CodexAuthError


def _b64(d: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")


def _make_jwt(claims: dict) -> str:
    return f"{_b64({'alg': 'none'})}.{_b64(claims)}.sig"


def _write_auth(path: Path, *, access: str, refresh: str = "rt-xyz", **extra) -> None:
    payload = {"tokens": {"access_token": access, "refresh_token": refresh}, **extra}
    path.write_text(json.dumps(payload), encoding="utf-8")


# ---- load ---------------------------------------------------------------

def test_load_missing_file_raises_relogin(tmp_path: Path) -> None:
    with pytest.raises(CodexAuthError) as e:
        ca.load_codex_tokens(tmp_path / "nope.json")
    assert e.value.relogin_required is True
    assert e.value.code == "codex_auth_missing"


def test_load_valid_returns_tokens(tmp_path: Path) -> None:
    p = tmp_path / "auth.json"
    _write_auth(p, access=_make_jwt({"exp": time.time() + 9999}))
    data = ca.load_codex_tokens(p)
    assert data["tokens"]["refresh_token"] == "rt-xyz"


def test_load_missing_access_token_raises(tmp_path: Path) -> None:
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"tokens": {"refresh_token": "r"}}), encoding="utf-8")
    with pytest.raises(CodexAuthError) as e:
        ca.load_codex_tokens(p)
    assert e.value.code == "codex_auth_missing_access_token"


# ---- expiry + account_id ------------------------------------------------

def test_token_not_expiring_when_exp_future() -> None:
    tok = _make_jwt({"exp": time.time() + 3600})
    assert ca.access_token_is_expiring(tok) is False


def test_token_expiring_when_exp_past() -> None:
    tok = _make_jwt({"exp": time.time() - 10})
    assert ca.access_token_is_expiring(tok) is True


def test_token_expiring_within_skew() -> None:
    tok = _make_jwt({"exp": time.time() + 60})  # skew 120 > 60
    assert ca.access_token_is_expiring(tok, skew_seconds=120) is True


def test_unreadable_exp_not_expiring() -> None:
    # exp claim 없으면 churn 방지로 False (실제 만료는 API 401 로 surface).
    assert ca.access_token_is_expiring(_make_jwt({"sub": "x"})) is False
    assert ca.access_token_is_expiring("not-a-jwt") is False


def test_account_id_extracted_from_claim() -> None:
    tok = _make_jwt({"https://api.openai.com/auth": {"chatgpt_account_id": "acct-42"}})
    assert ca.codex_account_id(tok) == "acct-42"


def test_account_id_none_when_absent() -> None:
    assert ca.codex_account_id(_make_jwt({"exp": 1})) is None


# ---- refresh (mock httpx) ----------------------------------------------

class _FakeResp:
    def __init__(self, status: int, payload: dict) -> None:
        self.status_code = status
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _FakeClient:
    status = 200
    payload: dict = {}
    last_data: dict | None = None

    def __init__(self, *a, **k) -> None:
        pass

    def __enter__(self) -> "_FakeClient":
        return self

    def __exit__(self, *a) -> bool:
        return False

    def post(self, url, headers=None, data=None):
        _FakeClient.last_data = data
        return _FakeResp(_FakeClient.status, _FakeClient.payload)


@pytest.fixture
def fake_httpx(monkeypatch):
    _FakeClient.status = 200
    _FakeClient.payload = {}
    _FakeClient.last_data = None
    monkeypatch.setattr(ca.httpx, "Client", _FakeClient)
    return _FakeClient


def test_refresh_success_returns_new_access(fake_httpx) -> None:
    fake_httpx.payload = {"access_token": "new-at", "refresh_token": "new-rt"}
    out = ca.refresh_codex_tokens("old-rt")
    assert out["access_token"] == "new-at"
    assert out["refresh_token"] == "new-rt"
    # 올바른 grant + client_id 전송
    assert fake_httpx.last_data["grant_type"] == "refresh_token"
    assert fake_httpx.last_data["client_id"] == ca.CODEX_OAUTH_CLIENT_ID


def test_refresh_keeps_old_refresh_when_not_rotated(fake_httpx) -> None:
    fake_httpx.payload = {"access_token": "new-at"}  # no new refresh_token
    out = ca.refresh_codex_tokens("old-rt")
    assert out["refresh_token"] == "old-rt"


def test_refresh_invalid_grant_forces_relogin(fake_httpx) -> None:
    fake_httpx.status = 400
    fake_httpx.payload = {"error": "invalid_grant"}
    with pytest.raises(CodexAuthError) as e:
        ca.refresh_codex_tokens("old-rt")
    assert e.value.relogin_required is True
    assert e.value.code == "invalid_grant"


def test_refresh_token_reused_message(fake_httpx) -> None:
    fake_httpx.status = 400
    fake_httpx.payload = {"error": {"code": "refresh_token_reused"}}
    with pytest.raises(CodexAuthError) as e:
        ca.refresh_codex_tokens("old-rt")
    assert e.value.relogin_required is True
    assert "codex" in str(e.value)


# ---- save (atomic 0600) -------------------------------------------------

def test_save_writes_0600_and_preserves_other_keys(tmp_path: Path) -> None:
    p = tmp_path / "auth.json"
    _write_auth(p, access="old-at", refresh="old-rt", auth_mode="chatgpt", keep="me")
    ca.save_codex_tokens({"access_token": "new-at", "refresh_token": "new-rt"}, p)
    data = json.loads(p.read_text())
    assert data["tokens"]["access_token"] == "new-at"
    assert data["auth_mode"] == "chatgpt"   # 보존
    assert data["keep"] == "me"             # 보존
    assert "last_refresh" in data
    mode = stat.S_IMODE(os.stat(p).st_mode)
    assert mode == 0o600


# ---- resolve orchestration ---------------------------------------------

def test_resolve_no_refresh_when_token_fresh(tmp_path: Path, monkeypatch) -> None:
    p = tmp_path / "auth.json"
    acc = _make_jwt({
        "exp": time.time() + 3600,
        "https://api.openai.com/auth": {"chatgpt_account_id": "acct-9"},
    })
    _write_auth(p, access=acc)

    def _boom(*a, **k):
        raise AssertionError("fresh 토큰인데 refresh 호출됨")

    monkeypatch.setattr(ca, "refresh_codex_tokens", _boom)
    cred = ca.resolve_codex_credentials(p)
    assert cred.access_token == acc
    assert cred.account_id == "acct-9"
    assert cred.base_url == ca.DEFAULT_CODEX_BASE_URL


def test_resolve_refreshes_and_saves_when_expiring(tmp_path: Path, monkeypatch) -> None:
    p = tmp_path / "auth.json"
    _write_auth(p, access=_make_jwt({"exp": time.time() - 5}), refresh="old-rt")
    new_acc = _make_jwt({
        "exp": time.time() + 3600,
        "https://api.openai.com/auth": {"chatgpt_account_id": "acct-new"},
    })
    monkeypatch.setattr(
        ca, "refresh_codex_tokens",
        lambda rt, **k: {"access_token": new_acc, "refresh_token": "rotated-rt"},
    )
    cred = ca.resolve_codex_credentials(p)
    assert cred.access_token == new_acc
    assert cred.account_id == "acct-new"
    # auth.json 에 새 토큰 저장됨
    saved = json.loads(p.read_text())
    assert saved["tokens"]["access_token"] == new_acc
    assert saved["tokens"]["refresh_token"] == "rotated-rt"
