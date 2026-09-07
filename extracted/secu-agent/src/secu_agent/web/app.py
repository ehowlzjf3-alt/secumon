"""FastAPI 앱 팩토리 — 라우터 모음 + scheduler background task.

scheduler tick:
- 60초 주기 (env SA_SCHEDULER_INTERVAL 로 변경 가능)
- env SA_SCHEDULER=off 면 skip (테스트 / 임시 끄기)
- chat hub broadcast 와 연결 — deliver="chat" schedule 결과 사용자 채팅창에 흘러나옴.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI

# v3.82 U3b: 도메인 라우터(smb/domains/domain_reports)는 도메인 서비스
# (secu-agent-skill service/, 별도 포트)로 이관 — 코어 8765 = 엔진+채팅만.
from secu_agent.web.routes import approvals, chat as chat_routes
from secu_agent.web.routes import evidence, findings, health, index
from secu_agent.web.routes import scheduler as scheduler_routes

log = logging.getLogger("secu_agent.app")


# ── 도메인 read-only 뷰 라우터 (v3.85: 등록형 마운트) ────────────────────────
# 이전엔 create_app 이 7개 include_router 를 하드코딩해, 도메인이 통합 뷰어(8765)에
# 자기 읽기 뷰를 얹으려면 별도 FastAPI 서비스(8766)를 세우는 수밖에 없었다. 이제
# 도메인 plugin 이 register_web_router 로 라우터를 등록하면 create_app 이 load_plugins
# 후 마운트한다. SAFETY-KEEP: 마운트 시 require_token 의존성을 강제하고(인증 우회 금지),
# 등록 라우터는 read-only GET 계약이다(evidence path-jail 등 코어 게이트는 코어 유지).
_PLUGIN_ROUTERS: list = []


def register_web_router(router) -> None:
    """도메인 read-only 뷰 라우터 등록 (plugin API). create_app 이 require_token
    의존성과 함께 마운트한다. 라우터는 read-only GET 만 노출해야 한다."""
    _PLUGIN_ROUTERS.append(router)


def unregister_all_web_routers() -> None:
    """등록 전체 해제 (테스트/재부착 멱등용)."""
    _PLUGIN_ROUTERS.clear()


def _scheduler_enabled() -> bool:
    return os.environ.get("SA_SCHEDULER", "on").lower() not in (
        "off", "0", "false", "no",
    )


def _scheduler_interval() -> float:
    try:
        return float(os.environ.get("SA_SCHEDULER_INTERVAL", "60"))
    except ValueError:
        return 60.0


@asynccontextmanager
async def _lifespan(app: FastAPI):
    stop = asyncio.Event()
    task: asyncio.Task | None = None
    reaper_task: asyncio.Task | None = None
    # v3.52-A4: MCP bootstrap — config/mcp_servers.yaml 의 server 들 connect.
    # Server 죽어있어도 무시 (log only) — agent 자체는 살아야.
    try:
        from secu_agent.mcp.state import bootstrap_from_yaml
        n = await bootstrap_from_yaml()
        if n:
            log.info("mcp tools registered: %d", n)
    except Exception as e:
        log.warning("mcp bootstrap failed: %s", e)
    # F5-B: 스케줄러/브라우저 시작 **前에** 직전 crash 가 남긴 고아 chromium 회수
    # (토큰·starttime·owner-사망 검증 후만). scheduler 첫 tick 이 browser 를 띄우기
    # 전에 완료돼야 하므로 스케줄러 생성보다 앞. latch 라 이후 launch 도 이 완료를 await.
    from secu_agent.agent.tools.browser_tool import reap_orphan_browsers_once
    await reap_orphan_browsers_once()
    if _scheduler_enabled():
        from secu_agent.agent.scheduler_tick import scheduler_loop
        from secu_agent.web.routes.chat import (
            _evidence_dir, _get_hub, _session_cancel_event, _session_stop_event,
        )
        task = asyncio.create_task(
            scheduler_loop(
                get_hub=_get_hub,
                evidence_dir=_evidence_dir(),
                interval_seconds=_scheduler_interval(),
                stop_event=stop,
                # v3.79 ④-2: 스케줄 fire 도 세션 stop(X)/cancel(ESC) 로 멈춤
                interrupt_events=lambda sid: [
                    _session_stop_event(sid), _session_cancel_event(sid),
                ],
            ),
            name="scheduler_loop",
        )
        log.info("scheduler task started")
    # v3.69: browser idle reaper — stop 안 불린 chromium 세션을 idle 임계 후 자동 회수.
    from secu_agent.agent.tools.browser_tool import browser_reaper_loop
    reaper_task = asyncio.create_task(
        browser_reaper_loop(stop_event=stop), name="browser_reaper",
    )
    try:
        yield
    finally:
        stop.set()
        for t in (task, reaper_task):
            if t is None:
                continue
            try:
                await asyncio.wait_for(t, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                t.cancel()
        # v3.69: graceful 종료 시 chromium 회수 (orphan 누수 방지). SIGKILL 엔 안 돎.
        try:
            from secu_agent.agent.tools.browser_tool import shutdown_browser
            await shutdown_browser()
        except Exception as e:
            log.warning("browser shutdown failed: %s", e)
        try:
            from secu_agent.mcp.state import shutdown_mcp
            await shutdown_mcp()
        except Exception as e:
            log.warning("mcp shutdown failed: %s", e)


def create_app() -> FastAPI:
    # uvicorn --reload 는 fresh process 에서 factory 만 재실행 — cli.main 의 plugin
    # 로드가 닿지 않으므로 여기서도 보장한다 (멱등). 실패는 전파 = 서버 미기동.
    from secu_agent.plugins import load_plugins
    load_plugins()
    app = FastAPI(title="Enterprise Security Agent", docs_url="/api/docs",
                  lifespan=_lifespan)
    app.include_router(health.router)
    app.include_router(findings.router)
    app.include_router(approvals.router)
    app.include_router(scheduler_routes.router)
    app.include_router(evidence.router)
    app.include_router(chat_routes.router)
    app.include_router(index.router)
    # 도메인 plugin 라우터 — require_token 강제 마운트 (인증 우회 금지).
    from secu_agent.web.auth import require_token
    for router in _PLUGIN_ROUTERS:
        app.include_router(router, dependencies=[Depends(require_token)])
    return app
