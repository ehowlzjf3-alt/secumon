"""dev_web E2E independent FastAPI service.

This service intentionally does not mount the SMB 8767 webapp. It exposes only
dev_web pipeline/control/read APIs plus the generic domain report routes.

Run:
    PYTHONPATH=~/project/secu-agent/src:. SA_PLUGINS=$PWD/plugin/bootstrap.py \
        python -m domains.dev_web.webapp.app
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse

DEFAULT_PORT = 8769
DEFAULT_HOST = "0.0.0.0"
_UI_DIR = Path(__file__).resolve().parent / "ui"


def create_app() -> FastAPI:
    app = FastAPI(title="dev_web E2E Pipeline Service", docs_url="/api/docs")

    from domains.dev_web.webapp.routes import control, pipeline, targets
    app.include_router(pipeline.router)
    app.include_router(targets.router)
    app.include_router(control.router)

    # Generic finding/report projections are domain-neutral service routes.
    from service.routes import domain_reports, findings_domain
    app.include_router(domain_reports.router)
    app.include_router(findings_domain.router)

    @app.get("/", response_class=HTMLResponse)
    def index() -> str:
        idx = _UI_DIR / "index.html"
        if idx.exists():
            return idx.read_text(encoding="utf-8")
        return (
            "<h1>dev_web E2E Pipeline Service</h1>"
            "<ul>"
            "<li><a href='/api/pipeline/overview'>Pipeline overview</a></li>"
            "<li><a href='/api/dev-web/targets'>Targets</a></li>"
            "<li><a href='/api/dev-web/reports'>Reports</a></li>"
            "<li><a href='/api/docs'>API docs</a></li>"
            "</ul>"
        )

    @app.get("/api/health")
    def health() -> dict:
        return {"service": "dev-web-e2e", "port": _port(), "ok": True}

    return app


def _port() -> int:
    return int(os.environ.get("SA_DEV_WEB_PORT", str(DEFAULT_PORT)))


def _host() -> str:
    return os.environ.get("SA_DEV_WEB_HOST", DEFAULT_HOST)


def main() -> None:
    import uvicorn
    from service.runtime_env import load_runtime_env

    load_runtime_env(load_plugins=False)
    try:
        from secu_agent.plugins import load_plugins
        load_plugins()
    except Exception:  # noqa: BLE001
        pass
    uvicorn.run(create_app(), host=_host(), port=_port())


if __name__ == "__main__":
    main()
