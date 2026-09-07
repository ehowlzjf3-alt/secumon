"""Evidence file viewer API.

Only files under the configured evidence root are readable. This lets the web
UI inspect tool evidence without turning the endpoint into arbitrary file read.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import Depends, APIRouter, HTTPException, Query

from secu_agent.web.auth import require_token
from secu_agent.web.routes.chat import _evidence_dir


router = APIRouter()


def _allowed_roots() -> list[Path]:
    return [_evidence_dir().resolve()]


def _under_allowed_root(path: Path, roots: list[Path]) -> bool:
    return any(path == root or path.is_relative_to(root) for root in roots)


@router.get("/api/evidence")
def evidence(
    _auth: None = Depends(require_token),
    path: str = Query(..., min_length=1),
) -> dict[str, Any]:
    try:
        target = Path(path).expanduser().resolve()
    except OSError as e:
        raise HTTPException(400, f"invalid path: {e}") from e

    if not _under_allowed_root(target, _allowed_roots()):
        raise HTTPException(403, "evidence path outside allowed root")
    if not target.exists():
        raise HTTPException(404, "evidence file not found")
    if not target.is_file():
        raise HTTPException(400, "evidence path is not a file")

    size = target.stat().st_size
    if size > 2 * 1024 * 1024:
        raise HTTPException(413, "evidence file too large for inline view")
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        raise HTTPException(500, f"failed to read evidence: {e}") from e

    parsed: Any = None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    return {
        "path": str(target),
        "size": size,
        "text": text,
        "json": parsed,
    }
