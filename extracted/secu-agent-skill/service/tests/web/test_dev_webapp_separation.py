"""dev_webapp is a separate server surface, not mounted into SMB webapp."""
from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_dev_webapp_exposes_dev_web_routes_only() -> None:
    from domains.dev_web.webapp.app import create_app

    app = create_app()
    paths = {route.path for route in app.routes}

    assert "/api/pipeline/overview" in paths
    assert "/api/dev-web/targets" in paths
    assert "/api/dev-web/reports" in paths
    assert "/api/smb/dashboard" not in paths


def test_dev_webapp_serves_domain_ui() -> None:
    from fastapi.testclient import TestClient

    from domains.dev_web.webapp.app import create_app

    response = TestClient(create_app()).get("/")

    assert response.status_code == 200
    assert "DevWeb E2E Pipeline" in response.text
    assert "/api/dev-web/targets" in response.text
    assert "/api/dev-web/reports" in response.text


def test_smb_webapp_does_not_mount_dev_web_routes() -> None:
    from domains.smb.webapp.app import create_app

    app = create_app()
    paths = {route.path for route in app.routes}

    assert "/api/pipeline/overview" in paths
    assert not any("dev-web" in path or "dev_web" in path for path in paths)


def test_dev_webapp_default_host_is_wildcard(monkeypatch) -> None:
    from domains.dev_web.webapp.app import _host

    monkeypatch.delenv("SA_DEV_WEB_HOST", raising=False)
    assert _host() == "0.0.0.0"

    monkeypatch.setenv("SA_DEV_WEB_HOST", "127.0.0.1")
    assert _host() == "127.0.0.1"


def test_legacy_webapp_shim_packages_are_gone() -> None:
    """루트 `webapp/`·`dev_webapp/` 호환 shim 은 2026-08-15 에 제거했다.

    제거 근거: 실행 경로(README·SKILL.md)·k8s manifest 4개·Dockerfile 이 전부
    `domains.<도메인>.webapp.app` 로 이전을 마쳤고, shim 을 부르는 곳은 자기 테스트뿐이었다.
    되살리면 도메인 경계가 다시 흐려지므로 존재 자체를 막는다.
    """
    for legacy in ("webapp", "dev_webapp"):
        assert not (ROOT / legacy).exists(), (
            f"루트 {legacy}/ 가 되살아났다. 진입점은 domains/<도메인>/webapp 하나뿐이다."
        )


def test_nothing_imports_the_legacy_webapp_packages() -> None:
    """shim 이 없는데 누가 import 하면 수집 단계에서 죽는다 — 소스에서 먼저 잡는다."""
    offenders: list[str] = []
    for path in ROOT.rglob("*.py"):
        if any(part in {".venv", "__pycache__", ".git"} for part in path.parts):
            continue
        if path == Path(__file__):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if re.search(r"(?<![.\w])(?:from|import)\s+(?:dev_)?webapp[.\s]", text):
            offenders.append(str(path.relative_to(ROOT)))
    assert not offenders, f"레거시 webapp shim 을 import 하는 파일: {offenders}"
