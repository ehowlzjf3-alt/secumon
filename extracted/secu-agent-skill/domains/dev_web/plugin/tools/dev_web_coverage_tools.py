"""dev_web 커버리지 마킹 래퍼 — sweep→deep-dive 순서를 증거로 남기는 도구들.

## 왜 이 모듈이 생겼나 (2026-08-20)

이 세 래퍼는 `service/agents/dev_web_task_agent.py` 의 `_tool_classes()` **안에서**
정의되고 있었다(함수 지역 클래스). 다른 3도메인엔 없는 패턴이라 규격이 어긋났고,
더 나쁜 건 층이 갈려 있었다는 것이다:

  · **생산자** — 플래그를 세우는 래퍼: `service/agents/`(워커 진입점)
  · **소비자** — 플래그를 요구하는 게이트: `domains/dev_web/plugin/tools/`

`dev_web_submit_finding` 은 `_dev_web_browser_deep_dive_seen` 이 없으면 제출을 거부한다.
즉 이건 스타일 문제가 아니라 **증거 게이트의 입력**이다. 게이트와 그 입력을 만드는
코드가 다른 층에 살면, 한쪽만 고쳐도 게이트가 조용히 항상-거부 또는 항상-통과가 된다.
같은 층으로 모은다.

## 게이트 의미

`web_site_sweep` 성공 → `_dev_web_saw_site_sweep`
그 **이후** 브라우저 열람 성공 → `_dev_web_browser_deep_dive_seen`

deep-dive 플래그는 sweep 플래그가 이미 서 있을 때만 선다 — 순서가 증거다.
"스윕만 하고 화면은 안 봤다"를 노출 보고로 승격시키지 않기 위한 것이다.
"""
from __future__ import annotations

from typing import Any

from secu_agent.agent.tools.browser_tool import BrowserQueryTool
from secu_agent.agent.tools.base import ToolSuccess

from domains.dev_web.plugin.tools.dev_web_browse_tool import DevWebBrowseTool
from domains.web.plugin.tools.web_site_sweep_tool import WebSiteSweepTool

# 게이트 계약의 단일 진실원 — dev_web_submit_finding_tool 이 같은 키를 읽는다.
SAW_SITE_SWEEP_KEY = "_dev_web_saw_site_sweep"
BROWSER_DEEP_DIVE_KEY = "_dev_web_browser_deep_dive_seen"

# browser_query 중 '화면을 실제로 봤다'로 인정하는 action.
_DEEP_DIVE_QUERY_ACTIONS = {"snapshot", "html", "screenshot"}


def mark_site_sweep(context: Any) -> None:
    try:
        context.metadata[SAW_SITE_SWEEP_KEY] = True
    except Exception:
        pass


def mark_deep_dive(context: Any) -> None:
    """⚠️ sweep 이 먼저 성공했을 때만 선다 — 순서 자체가 증거다."""
    try:
        if context.metadata.get(SAW_SITE_SWEEP_KEY):
            context.metadata[BROWSER_DEEP_DIVE_KEY] = True
    except Exception:
        pass


class DevWebSiteSweepTool(WebSiteSweepTool):
    """`web_site_sweep` + 성공 시 sweep 마킹. 이름은 원본을 유지한다(계약 이름)."""

    name = "web_site_sweep"

    async def execute(self, validated_input, context):  # type: ignore[no-untyped-def]
        result = await super().execute(validated_input, context)
        if isinstance(result, ToolSuccess):
            mark_site_sweep(context)
        return result


class DevWebBrowseWorkerTool(DevWebBrowseTool):
    """무인 워커용 non-destructive 브라우저 열람(confluence_browser_search 미러).

    raw `browser_session`/`browser_action`(is_destructive)은 승인거부라 노출하지 않는다 —
    이 도구가 세션 자동 확보 + read-only navigate + snapshot 을 대신한다.
    """

    name = "dev_web_browse"

    async def execute(self, validated_input, context):  # type: ignore[no-untyped-def]
        result = await super().execute(validated_input, context)
        if isinstance(result, ToolSuccess):
            mark_deep_dive(context)
        return result


class DevWebBrowserQueryTool(BrowserQueryTool):
    """`browser_query` + 화면을 실제로 본 action 일 때만 deep-dive 마킹."""

    name = "browser_query"

    async def execute(self, validated_input, context):  # type: ignore[no-untyped-def]
        result = await super().execute(validated_input, context)
        if isinstance(result, ToolSuccess):
            action = str(getattr(validated_input, "action", "")).lower()
            if action in _DEEP_DIVE_QUERY_ACTIONS:
                mark_deep_dive(context)
        return result
