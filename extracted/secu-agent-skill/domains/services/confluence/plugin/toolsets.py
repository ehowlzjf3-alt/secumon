"""confluence 도메인 도구셋 provider — task_type → 도구 화이트리스트.

## 왜 여기인가 (규격)

도구셋은 **도메인 소유**다. 워커 진입점(`service/agents/`)이 자기 도구 목록을 들고
있으면 같은 도메인의 다른 실행 경로(sub-agent 위임, 재검증, 운영자)가 그 목록을
재사용할 수 없다 — 실제로 4도메인이 제각각이었다(smb 만 toolsets.py 가 있었다).

코어는 `register_task_toolset(task_type, provider)` 로 등록형 훅을 이미 제공한다
(v3.85 — 코어 하드코딩 switch 없음). 이 모듈이 그 provider 를 공급하고
`plugin/bootstrap.py` 가 배선한다.

⚠️ 순환 import 회피를 위해 provider **안에서** 지연 import 한다.
"""
from __future__ import annotations

import os

from typing import TYPE_CHECKING

if TYPE_CHECKING:  # 타입 힌트만 — 런타임 순환 import 회피
    from secu_agent.agent.tools.base import Tool


def confluence_task_tools(kind: str | None = None) -> list[type]:
    from secu_agent.agent.tools.browser_tool import (
        BrowserActionTool,
        BrowserQueryTool,
        BrowserSessionTool,
    )
    from secu_agent.agent.tools.scan_text import ScanTextTool
    from secu_agent.agent.tools.skill_tool import SkillTool
    from domains.services.confluence.plugin.tools.confluence_submit_finding_tool import (
        ConfluenceSubmitFindingTool,
    )
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool
    from secu_agent.agent.tools.triage_candidates import TriageCandidatesTool
    from secu_agent.agent.tools.web_fetch_tool import WebFetchTool

    from service.agents.candidate_counters import ensure_registered
    ensure_registered()  # v3.90 침묵 게이트 — 도메인 도구 후보 counter 배선

    from domains.services.confluence.plugin.tools.confluence_browser_search_tool import (
        ConfluenceBrowserSearchTool,
        ConfluenceSearchSetStatusTool,
    )
    from domains.services.confluence.plugin.tools.confluence_space_discovery_tool import (
        ConfluenceSpaceSetStatusTool,
    )
    from domains.services.plugin.tools.devops_discovery_tool import DevopsTargetSetStatusTool
    from domains.web.plugin.tools.web_site_sweep_tool import WebSiteSweepTool

    # kind별 도구 격리(fail-closed): keyword_search 는 브라우저 검색+검색상태툴만 노출한다. space/devops
    # setter 와 REST/web_site_sweep/browser_* 를 빼서, 에이전트가 실수로 엉뚱한 큐(confluence_space_target/
    # devops_target)를 닫거나 죽은 REST 를 쓰는 것을 구조적으로 차단(적대검증 지적). space_batch/sso_url 은
    # 종전 도구면을 그대로 유지(검색툴 미포함 — 역방향 오염도 차단).
    if kind == "keyword_search":
        return [
            ConfluenceBrowserSearchTool,
            ConfluenceSearchSetStatusTool,
            ConfluenceSubmitFindingTool,
            TriageCandidatesTool,
            ScanTextTool,
            SkillTool,
            ToolSearchTool,
        ]
    # ── space/sso 분기도 **브라우저 전용**이다 (사용자 결정 2026-08-26) ──────────
    #
    # confluence REST 는 두 겹으로 막혀 있다. 실측(2026-08-26, /rest/api/search):
    #
    #     Basic (user+token)  403  {"message":"Basic Authentication has been disabled
    #                               on this instance."}
    #     Bearer PAT          429  {"message":"속도 제한이 초과되었습니다."}
    #     인증 없음            429
    #
    # 즉 403 은 **권한 문제가 아니라 인증 방식 문제**였고(DC 는 Basic 을 껐는데
    # `_client()` 가 `CONFLUENCE_USER` 가 있다는 이유로 Basic 을 골랐다), 그걸 고쳐도
    # 상시 rate-limit 429 가 남는다. `confluence_browser_search_tool` 주석이
    # 2026-08-24 에 이미 그렇게 적어 뒀는데 **도구셋만 안 따라왔다.**
    #
    # 그 결과가 실데이터에 그대로 남았다: space 25건이 전부
    # `"CQL search returned HTTP 403; access blocked, not assessed clean."` 로
    # skipped — "접근 불가" 라는 **오진**이 몇 주간 쌓였다.
    #
    # ★ 살아 있는 경로는 브라우저 하나뿐이고, 그건 이미 증명돼 있다 —
    #   keyword_search 큐(87건 tasked)가 API 도구 0개로 돈다.
    #   `confluence_browser_search` 는 `scope_space_keys` 를 받으므로 space 큐도 덮는다.
    #
    # ⚠️ 되살리지 마라. REST 도구를 도구면에 다시 올리면 워커가 그걸 먼저 집고,
    #    403/429 를 "접근 불가" 로 기록하고, 그 기록이 다시 판단 재료가 된다.
    classes = [
        ConfluenceBrowserSearchTool,
        ConfluenceSpaceSetStatusTool,
        WebSiteSweepTool,
        BrowserSessionTool,
        BrowserActionTool,
        BrowserQueryTool,
        WebFetchTool,
        ConfluenceSubmitFindingTool,
        TriageCandidatesTool,
        DevopsTargetSetStatusTool,
        ScanTextTool,
        SkillTool,
        ToolSearchTool,
    ]
    # active 크리덴셜 유효성 검증 — 마스터 스위치 켜졌을 때만 노출(codex D6). scope/단발원장/
    # 차단기는 실행 시 코어가 재확인(fail-closed). keyword_search 분기엔 미노출(도구면 격리 유지).
    if (os.environ.get("SA_CRED_PROBE") or "").strip().lower() in ("1", "true", "yes", "on"):
        from domains.services.confluence.plugin.tools.confluence_credential_login_probe_tool import (
            ConfluenceCredentialLoginProbeTool,
        )
        classes.append(ConfluenceCredentialLoginProbeTool)
    return classes
