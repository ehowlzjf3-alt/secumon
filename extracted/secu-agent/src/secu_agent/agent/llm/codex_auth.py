"""Codex (ChatGPT enterprise) OAuth 토큰 매니저 — v3.56.

`~/.codex/auth.json` 의 OAuth access_token 을 런타임에 resolve / refresh 한다.

보안 (사내 정책):
- 토큰값은 절대 로그·예외 메시지·chat 에 싣지 않는다 (password_ref 정책 동일선상).
  auth.json 만이 secret source — YAML/.env 로 토큰이 흘러나가지 않는다.
- codex CLI / VS Code 확장과 같은 파일을 공유하므로 refresh 시 기존 키를 보존적으로
  머지하고 atomic O_EXCL 0600 으로 쓴다 (TOCTOU + 권한 노출 차단).
- refresh 는 resolve 당 최대 1회 — 무한 재시도 루프 없음. refresh_token 이 다른
  클라이언트에 의해 소비(rotation)됐으면 relogin_required 로 명확히 올린다.
"""
from __future__ import annotations

import base64
import json
import os
import stat
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
REFRESH_SKEW_SECONDS = 120


class CodexAuthError(RuntimeError):
    """codex 인증 실패. relogin_required=True 면 사용자가 터미널에서 `codex` 재로그인 필요."""

    def __init__(
        self, message: str, *, code: str = "codex_auth_error",
        relogin_required: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.relogin_required = relogin_required


def _auth_path(path: str | os.PathLike[str] | None = None) -> Path:
    return Path(path or "~/.codex/auth.json").expanduser()


def load_codex_tokens(path: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """auth.json 전체를 읽어 반환 (tokens 유효성 검증 포함). 토큰값은 로그 안 함."""
    p = _auth_path(path)
    if not p.exists():
        raise CodexAuthError(
            f"codex auth 파일 없음: {p} — 터미널에서 `codex` 로 로그인 필요.",
            code="codex_auth_missing", relogin_required=True,
        )
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        raise CodexAuthError(
            f"codex auth 파일 파싱 실패: {p}",
            code="codex_auth_unreadable", relogin_required=True,
        ) from exc
    tokens = data.get("tokens") if isinstance(data, dict) else None
    if not isinstance(tokens, dict):
        raise CodexAuthError(
            "codex auth 에 tokens 없음 — 재로그인 필요.",
            code="codex_auth_invalid_shape", relogin_required=True,
        )
    if not str(tokens.get("access_token", "") or "").strip():
        raise CodexAuthError(
            "codex auth 에 access_token 없음 — 재로그인 필요.",
            code="codex_auth_missing_access_token", relogin_required=True,
        )
    if not str(tokens.get("refresh_token", "") or "").strip():
        raise CodexAuthError(
            "codex auth 에 refresh_token 없음 — 재로그인 필요.",
            code="codex_auth_missing_refresh_token", relogin_required=True,
        )
    return data


def _decode_jwt_claims(token: str) -> dict[str, Any]:
    """JWT payload claim 만 디코드. 검증 안 함 (exp / account_id 추출 용도)."""
    try:
        parts = str(token).split(".")
        if len(parts) < 2:
            return {}
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64))
        return claims if isinstance(claims, dict) else {}
    except Exception:
        return {}


def access_token_is_expiring(
    access_token: str, skew_seconds: int = REFRESH_SKEW_SECONDS,
) -> bool:
    """exp claim 이 skew 안으로 들어오면 True. exp 못 읽으면 False(=churn 방지,
    실제 만료 시 API 401 로 surface)."""
    exp = _decode_jwt_claims(access_token).get("exp")
    if not isinstance(exp, (int, float)):
        return False
    return float(exp) <= (time.time() + max(0, int(skew_seconds)))


def codex_account_id(access_token: str) -> str | None:
    """JWT 의 chatgpt_account_id claim — Cloudflare ChatGPT-Account-ID 헤더용."""
    auth = _decode_jwt_claims(access_token).get("https://api.openai.com/auth")
    if isinstance(auth, dict):
        acct = auth.get("chatgpt_account_id")
        if isinstance(acct, str) and acct.strip():
            return acct.strip()
    return None


def refresh_codex_tokens(
    refresh_token: str, *, timeout_seconds: float = 20.0,
) -> dict[str, str]:
    """refresh_token 으로 access_token 갱신 (auth state 안 건드리는 pure 함수)."""
    if not str(refresh_token or "").strip():
        raise CodexAuthError(
            "refresh_token 없음 — 재로그인 필요.",
            code="codex_auth_missing_refresh_token", relogin_required=True,
        )
    timeout = httpx.Timeout(max(5.0, float(timeout_seconds)))
    with httpx.Client(timeout=timeout, headers={"Accept": "application/json"}) as client:
        resp = client.post(
            CODEX_OAUTH_TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": CODEX_OAUTH_CLIENT_ID,
            },
        )
    if resp.status_code != 200:
        code = "codex_refresh_failed"
        relogin = resp.status_code in (401, 403)
        try:
            err = resp.json()
            eo = err.get("error") if isinstance(err, dict) else None
            if isinstance(eo, dict):
                code = str(eo.get("code") or eo.get("type") or code)
            elif isinstance(eo, str) and eo.strip():
                code = eo.strip()
        except Exception:
            pass
        if code in {"invalid_grant", "invalid_token", "invalid_request",
                    "refresh_token_reused"}:
            relogin = True
        msg = f"codex 토큰 refresh 실패 (status={resp.status_code}, code={code})."
        if code == "refresh_token_reused":
            msg = (
                "codex refresh token 이 다른 클라이언트(codex CLI / VSCode 확장)에 의해 "
                "이미 소비됨. 터미널에서 `codex` 재실행 후 다시 시도."
            )
        raise CodexAuthError(msg, code=str(code), relogin_required=relogin)
    try:
        payload = resp.json()
    except Exception as exc:
        raise CodexAuthError(
            "codex refresh 응답이 JSON 이 아님.",
            code="codex_refresh_invalid_json", relogin_required=True,
        ) from exc
    new_access = payload.get("access_token")
    if not isinstance(new_access, str) or not new_access.strip():
        raise CodexAuthError(
            "codex refresh 응답에 access_token 없음.",
            code="codex_refresh_missing_access_token", relogin_required=True,
        )
    updated: dict[str, str] = {
        "access_token": new_access.strip(),
        "refresh_token": str(refresh_token).strip(),
    }
    nxt = payload.get("refresh_token")
    if isinstance(nxt, str) and nxt.strip():
        updated["refresh_token"] = nxt.strip()
    idt = payload.get("id_token")
    if isinstance(idt, str) and idt.strip():
        updated["id_token"] = idt.strip()
    return updated


def save_codex_tokens(
    tokens: dict[str, Any],
    path: str | os.PathLike[str] | None = None,
    *,
    existing: dict[str, Any] | None = None,
) -> Path:
    """tokens 를 auth.json 에 보존적 머지 + atomic O_EXCL 0600 쓰기.

    기존 파일의 다른 키(auth_mode, account_id 등)는 보존한다. codex CLI 와 공유하는
    파일이므로 우리가 모르는 필드를 날리지 않는다.
    """
    p = _auth_path(path)
    base: dict[str, Any] = dict(existing) if isinstance(existing, dict) else {}
    if not base and p.exists():
        try:
            loaded = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                base = loaded
        except Exception:
            base = {}
    base = dict(base)
    merged_tokens = dict(base.get("tokens") or {})
    merged_tokens.update(tokens)
    base["tokens"] = merged_tokens
    base["last_refresh"] = (
        datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    )
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.tmp.{os.getpid()}.{uuid.uuid4().hex}")
    fd = os.open(
        str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        stat.S_IRUSR | stat.S_IWUSR,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(base, indent=2) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, p)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
    return p


@dataclass(frozen=True, slots=True)
class CodexCredentials:
    access_token: str
    account_id: str | None
    base_url: str = DEFAULT_CODEX_BASE_URL


def resolve_codex_credentials(
    path: str | os.PathLike[str] | None = None,
    *,
    skew_seconds: int = REFRESH_SKEW_SECONDS,
) -> CodexCredentials:
    """auth.json load → 만료 임박이면 refresh+save → 사용가능 access_token 반환."""
    data = load_codex_tokens(path)
    tokens = data["tokens"]
    access = str(tokens["access_token"]).strip()
    if access_token_is_expiring(access, skew_seconds):
        refreshed = refresh_codex_tokens(str(tokens["refresh_token"]).strip())
        save_codex_tokens(refreshed, path, existing=data)
        access = refreshed["access_token"]
    return CodexCredentials(access_token=access, account_id=codex_account_id(access))
