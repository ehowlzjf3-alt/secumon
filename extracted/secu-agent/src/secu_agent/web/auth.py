"""REST 인증 — 공유 토큰 (SA_CHAT_TOKEN).

v3.82 U3b: Authorization 헤더 우선 (`Bearer <token>` 또는 raw), `?token=`
쿼리는 구버전 클라이언트 폴백 — 쿼리 토큰은 access/프록시 로그에 남는
유출 표면이라 deprecated (WS 의 Sec-WebSocket-Protocol 전환과 같은 이유,
v3.79 ②). UI 의 헤더 전환은 U5.

라우트는 `Depends(require_token)` (또는 router dependencies=[...]) 로 건다.
"""
from __future__ import annotations

import hmac
import os

from fastapi import Header, HTTPException, Query


def expected_token() -> str:
    return os.environ.get("SA_CHAT_TOKEN", "devtoken")


def check_token(provided: str) -> bool:
    return hmac.compare_digest(provided.encode(), expected_token().encode())


def require_token(
    authorization: str | None = Header(None),
    token: str = Query(""),
) -> None:
    provided = ""
    if authorization:
        provided = authorization.strip()
        if provided.lower().startswith("bearer "):
            provided = provided[len("bearer "):].strip()
    if not provided:
        provided = token  # deprecated 쿼리 폴백
    if not check_token(provided):
        raise HTTPException(status_code=401, detail="invalid token")
