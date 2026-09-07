"""GET /api/pipeline/screenshot — 증거 스크린샷 서빙 (path-jail, 요구 4·7).

screenshot.rel_path 는 evidence_dir(SA_SMB_EVIDENCE_DIR) 상대. realpath + 확장자
allowlist 로 ../ escape 를 차단한다(raw evidence 격리 — KEEP 7). 메일 본문이 이
정적 URL 을 임베드한다(첨부 왕복 회피).
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

router = APIRouter(prefix="/api/pipeline")

_ALLOW_EXT = {".png", ".jpg", ".jpeg"}


def _evidence_root() -> Path:
    import tempfile
    return Path(os.environ.get("SA_SMB_EVIDENCE_DIR", "")
                or (Path(tempfile.gettempdir()) / "smb_e2e_evidence")).resolve()


@router.get("/screenshot")
def serve_screenshot(path: str = Query(..., description="evidence_dir 상대 경로")) -> FileResponse:
    base = _evidence_root()
    rel = str(path or "").strip().lstrip("/")
    if not rel:
        raise HTTPException(400, "empty path")
    target = (base / rel).resolve()
    try:
        target.relative_to(base)  # path-jail — ../ escape 차단
    except ValueError as e:
        raise HTTPException(403, "path escape blocked") from e
    if target.suffix.lower() not in _ALLOW_EXT:
        raise HTTPException(415, f"unsupported type: {target.suffix}")
    if not target.is_file():
        raise HTTPException(404, "screenshot not found")
    media = "image/png" if target.suffix.lower() == ".png" else "image/jpeg"
    return FileResponse(str(target), media_type=media)
