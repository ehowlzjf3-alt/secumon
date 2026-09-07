"""evidence_dir scope 강제 — 모든 파일 접근 도구가 사용."""
from __future__ import annotations

from pathlib import Path


class PathEscapeError(Exception):
    """evidence_dir 밖으로 나가려는 경로 거부."""


def safe_path(user_path: str, evidence_dir: Path) -> Path:
    """user가 준 경로를 evidence_dir 안으로 강제.

    - 절대경로 거부
    - .. traversal 차단
    - symlink resolve 후 evidence_dir 안인지 검증
    - hidden file (.git, .ssh) 거부

    Raises:
        PathEscapeError: scope 위반
    """
    evidence_dir = evidence_dir.resolve(strict=True)

    p = Path(user_path)
    if p.is_absolute():
        raise PathEscapeError(f"absolute path forbidden: {user_path}")

    # 결합 후 resolve (symlink 따라감)
    resolved = (evidence_dir / p).resolve()

    # evidence_dir 하위인지 검증
    try:
        resolved.relative_to(evidence_dir)
    except ValueError:
        raise PathEscapeError(
            f"path escapes evidence_dir: {user_path} -> {resolved}"
        )

    # hidden file/dir 거부 (.git, .ssh, .env 등)
    for part in resolved.relative_to(evidence_dir).parts:
        if part.startswith("."):
            raise PathEscapeError(f"hidden path forbidden: {user_path}")

    return resolved
