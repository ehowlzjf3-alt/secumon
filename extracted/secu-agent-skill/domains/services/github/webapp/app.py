"""GitHub E2E standalone FastAPI service.

Run separately from the SMB E2E service:

    PYTHONPATH=~/project/secu-agent/src:. SA_PLUGINS=plugin/bootstrap.py \
        python -m domains.services.github.webapp.app
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse

DEFAULT_PORT = 8770
_UI_DIR = Path(__file__).resolve().parent / "ui"


def create_app() -> FastAPI:
    app = FastAPI(title="GitHub E2E Pipeline Service", docs_url="/api/docs")

    from domains.services.github.webapp.routes import router

    app.include_router(router)

    @app.get("/", response_class=HTMLResponse)
    def index() -> str:
        idx = _UI_DIR / "index.html"
        if idx.exists():
            return idx.read_text(encoding="utf-8")
        return "<h1>GitHub E2E Pipeline Service</h1><p>UI missing; use /api/docs.</p>"

    @app.get("/api/health")
    def health() -> dict:
        return {"service": "github-e2e", "port": _port(), "ok": True}

    return app


def _port() -> int:
    return int(os.environ.get("SA_GITHUB_WEB_PORT", str(DEFAULT_PORT)))


def main() -> None:
    import uvicorn
    from service.runtime_env import load_runtime_env

    load_runtime_env(load_plugins=False)
    try:
        from secu_agent.plugins import load_plugins

        load_plugins()
    except Exception:
        pass
    host = os.environ.get("SA_GITHUB_WEB_HOST", "0.0.0.0")
    uvicorn.run(create_app(), host=host, port=_port())


if __name__ == "__main__":
    main()
