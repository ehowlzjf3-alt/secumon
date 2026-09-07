"""role 스킬 공용 — control-plane/gateway HTTP 호출 헬퍼(propose/observe).

WebFetch가 loopback 차단하므로 httpx 직접(trust_env=False). role tools는 이 헬퍼로 control-plane
승인 요청(제안)·조회, gateway read-only 관측을 한다. 실행·게이트는 digisecu 소유(재구현 금지).
"""
from __future__ import annotations

import os

import httpx

CONTROL_PLANE_URL = os.environ.get("CONTROL_PLANE_URL", "http://127.0.0.1:8080").rstrip("/")
GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://127.0.0.1:8091").rstrip("/")
GATEWAY_TOKEN = os.environ.get("GATEWAY_TOKEN", "")
_TIMEOUT = 15.0


async def cp_request(method: str, path: str, body: dict | None = None) -> tuple[int, dict | str]:
    """control-plane 호출."""
    return await _request(method, f"{CONTROL_PLANE_URL}{path}", body)


async def gw_get(path: str) -> tuple[int, dict | str]:
    """gateway read-only 관측(Bearer 토큰)."""
    headers = {"authorization": f"Bearer {GATEWAY_TOKEN}"} if GATEWAY_TOKEN else {}
    return await _request("GET", f"{GATEWAY_URL}{path}", None, headers)


async def _request(method: str, url: str, body: dict | None, headers: dict | None = None) -> tuple[int, dict | str]:
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, trust_env=False) as c:
            r = await c.request(method, url, json=body if body is not None else None, headers=headers or {})
        try:
            return r.status_code, r.json()
        except Exception:  # noqa: BLE001
            return r.status_code, r.text
    except Exception as e:  # noqa: BLE001
        return 0, f"호출 실패({url}): {e!r}"
