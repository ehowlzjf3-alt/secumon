"""스크린샷 렌더러 — graceful-degrade (smb_domain_e2e 요구 4).

Playwright headless 로 HTML/리포트를 PNG 로 렌더. 미설치/실패 시 발송을 막지 않고
graceful-degrade(추출 이미지/텍스트만, render_pdf_pages_as_images try/except 패턴).

단일 evidence_dir **path-jail**(realpath + .png allowlist) 공유 — #1 점검이 남긴 증거
이미지와 #2 가 렌더한 리포트 캡처가 같은 jail 안에 있다.
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path

log = logging.getLogger("service.services.shot_renderer")


class PathJailError(ValueError):
    """evidence_dir 밖 경로 접근 시도."""


def resolve_in_jail(evidence_dir: Path, rel_path: str, *, allow_ext: tuple[str, ...] = (".png", ".jpg", ".jpeg")) -> Path:
    """evidence_dir 안의 rel_path 를 안전하게 해석 (../ 차단 + 확장자 allowlist)."""
    base = Path(evidence_dir).resolve()
    rel = str(rel_path or "").strip().lstrip("/")
    if not rel:
        raise PathJailError("빈 경로")
    target = (base / rel).resolve()
    try:
        target.relative_to(base)
    except ValueError as e:
        raise PathJailError(f"path-jail 위반: {rel}") from e
    if allow_ext and target.suffix.lower() not in allow_ext:
        raise PathJailError(f"허용되지 않은 확장자: {target.suffix}")
    return target


def playwright_available() -> bool:
    try:
        import playwright  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def render_html_to_png(
    html: str, evidence_dir: Path, rel_path: str, *, width: int = 900,
) -> dict[str, object]:
    """HTML 을 evidence_dir/rel_path(.png) 로 렌더. graceful-degrade.

    반환: {ok, rel_path, sha256, mode} — mode='rendered'|'skipped'. 실패해도 raise 안 함.
    """
    try:
        out = resolve_in_jail(evidence_dir, rel_path, allow_ext=(".png",))
    except PathJailError as e:
        log.warning("[shot] path-jail 거부: %s", e)
        return {"ok": False, "rel_path": rel_path, "mode": "rejected", "error": str(e)}

    if not playwright_available():
        log.info("[shot] Playwright 미설치 — 렌더 skip (graceful-degrade)")
        return {"ok": False, "rel_path": rel_path, "mode": "skipped",
                "error": "playwright 미설치 — 텍스트/추출이미지만 사용"}

    try:
        from playwright.sync_api import sync_playwright
        out.parent.mkdir(parents=True, exist_ok=True)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page(viewport={"width": width, "height": 1200})
                page.set_content(html, wait_until="networkidle")
                page.screenshot(path=str(out), full_page=True)
            finally:
                browser.close()
        data = out.read_bytes()
        return {"ok": True, "rel_path": rel_path, "mode": "rendered",
                "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    except Exception as e:  # noqa: BLE001 — 렌더 실패가 발송을 막지 않음
        log.warning("[shot] 렌더 실패 (graceful-degrade): %r", e)
        return {"ok": False, "rel_path": rel_path, "mode": "error", "error": repr(e)[:200]}
