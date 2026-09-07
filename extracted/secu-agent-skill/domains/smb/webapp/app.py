"""SMB E2E 신규 독립 서비스 — FastAPI, 포트 8767 (smb_domain_e2e 요구 0·11·12).

기존 8766(service.app)의 검증된 read 라우터(smb/findings)를 그대로 include 재사용하고,
파이프라인 대시보드·cron 제어·메일 스레드·관리·스크린샷 라우터를 추가한다. DB 는 신규
풀 안 만들고 state_domain.connect()(엔진 core_connect 싱글톤 풀)를 공유한다.

**기존 8766 은 끈다** — 이 서비스가 대체(README/운영 가이드에서 8766 기동 중단).

실행:
    cd ~/project/secu-agent-skill
    PYTHONPATH=~/project/secu-agent/src:. SA_PLUGINS=plugin/bootstrap.py \
        python -m domains.smb.webapp.app  # 기본 :8767 (env SA_SMB_WEB_PORT)
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse

DEFAULT_PORT = 8767
DEFAULT_HOST = "0.0.0.0"
_UI_DIR = Path(__file__).resolve().parent / "ui"


def create_app() -> FastAPI:
    app = FastAPI(title="SMB E2E Pipeline Service", docs_url="/api/docs")

    # 신규 E2E 라우터.
    from domains.smb.webapp.routes import admin, agents, cron_control, mail_thread, pipeline, screenshot
    app.include_router(agents.router)
    app.include_router(pipeline.router)
    app.include_router(screenshot.router)
    app.include_router(cron_control.router)
    app.include_router(mail_thread.router)
    app.include_router(admin.router)

    # 기존 8766 의 검증된 SMB read 라우터 재사용 (대시보드/Findings 갤러리가 소비).
    from service.routes import findings_domain, smb
    app.include_router(smb.router)
    app.include_router(findings_domain.router)

    @app.get("/", response_class=HTMLResponse)
    def index() -> str:
        idx = _UI_DIR / "index.html"
        if idx.exists():
            return idx.read_text(encoding="utf-8")
        return "<h1>SMB E2E Pipeline Service</h1><p>UI 미배치 — /api/docs 참조</p>"

    @app.get("/api/health")
    def health() -> dict:
        return {"service": "smb-e2e", "port": _port(), "ok": True}

    return app


def _port() -> int:
    return int(os.environ.get("SA_SMB_WEB_PORT", str(DEFAULT_PORT)))


def _host() -> str:
    return os.environ.get("SA_SMB_WEB_HOST", DEFAULT_HOST)


def main() -> None:
    import uvicorn
    from service.runtime_env import load_runtime_env

    load_runtime_env(load_plugins=False)
    # plugin bootstrap (document_sensitivity seam + 도메인 등록) — 라우트가 도메인 모듈을
    # import 하므로 서비스 기동 시 선행 로드. SA_PLUGINS 로도 가능하나 명시 로드로 보강.
    try:
        from secu_agent.plugins import load_plugins
        load_plugins()
    except Exception:  # noqa: BLE001 — SA_PLUGINS 미설정/모놀리스면 무시
        pass
    uvicorn.run(create_app(), host=_host(), port=_port())


if __name__ == "__main__":
    main()
