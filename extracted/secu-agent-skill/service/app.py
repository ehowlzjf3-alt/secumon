"""도메인 서비스 FastAPI 앱 팩토리 — standalone 뷰어 (v3.82 U3d).

엔진 코어(8765, 엔진+채팅)에서 분리된 도메인 표면을 단독 서빙한다:
- /api/smb/*            SMB 대시보드/share/file/host report
- /api/domains/*        도메인 overview
- /api/domain-reports/* 도메인 finding report projection
- /api/findings/*       aggregate + owner-mail 3종 (generic CRUD 는 코어 소유)

scheduler/MCP/browser lifespan 없음 — 순수 DB-read 뷰어 + owner-mail 트리거
(백그라운드 작업은 엔진 소유). 실행:

    cd ~/project/secu-agent-skill
    PYTHONPATH=~/project/secu-agent/src:. python -m service.app   # 기본 :8766
"""
from __future__ import annotations

import os

from fastapi import FastAPI

from service.routes import domain_reports, domains, findings_domain, smb

DEFAULT_PORT = 8766


def create_app() -> FastAPI:
    app = FastAPI(title="Secu Agent Domain Service", docs_url="/api/docs")
    app.include_router(smb.router)
    app.include_router(domains.router)
    app.include_router(domain_reports.router)
    app.include_router(findings_domain.router)

    @app.get("/")
    def index() -> dict:
        return {
            "service": "Secu Agent Domain Service",
            "endpoints": [
                "/api/docs",
                "/api/smb/dashboard",
                "/api/smb/shares",
                "/api/smb/reports/{host}",
                "/api/smb/report-by-asset",
                "/api/domains/overview",
                "/api/domain-reports",
                "/api/domain-reports/{domain_key}",
                "/api/findings/aggregate",
            ],
        }

    return app


def main() -> None:
    """uvicorn 러너 — 포트는 env SA_DOMAIN_WEB_PORT (기본 8766)."""
    import uvicorn

    port = int(os.environ.get("SA_DOMAIN_WEB_PORT", str(DEFAULT_PORT)))
    host = os.environ.get("SA_DOMAIN_WEB_HOST", "127.0.0.1")
    uvicorn.run(create_app(), host=host, port=port)


if __name__ == "__main__":
    main()
