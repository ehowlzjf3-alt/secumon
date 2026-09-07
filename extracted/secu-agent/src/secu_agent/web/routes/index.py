"""GET / — 번들 HTML. vanilla JS가 /api/* 호출."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

_HTML_PATH = Path(__file__).resolve().parent.parent / "ui" / "index.html"
router = APIRouter()


@router.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    if not _HTML_PATH.exists():
        raise HTTPException(500, "index.html missing")
    # UI 를 자주 고치므로 브라우저 캐시 금지 — 새로고침이면 항상 최신 번들.
    return HTMLResponse(
        _HTML_PATH.read_text(encoding="utf-8"),
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )
