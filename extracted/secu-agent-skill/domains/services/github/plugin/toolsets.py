"""github 도메인 도구셋 provider — task_type → 도구 화이트리스트.

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


def github_task_tools() -> list[type]:
    from secu_agent.agent.tools.browser_tool import BrowserQueryTool
    from secu_agent.agent.tools.scan_text import ScanTextTool
    from secu_agent.agent.tools.skill_tool import SkillTool
    from domains.services.github.plugin.tools.github_submit_finding_tool import (
        GithubSubmitFindingTool,
    )
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool
    from secu_agent.agent.tools.triage_candidates import TriageCandidatesTool
    from secu_agent.agent.tools.web_fetch_tool import WebFetchTool

    from domains.services.github.plugin.tools.github_browse_tool import GithubBrowseTool
    from domains.services.plugin.tools.devops_discovery_tool import DevopsTargetSetStatusTool
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool
    from domains.web.plugin.tools.web_site_sweep_tool import WebSiteSweepTool

    from service.agents.candidate_counters import ensure_registered
    ensure_registered()  # v3.90 침묵 게이트 — 도메인 도구 후보 counter 배선

    # 무인 워커(runtime.run_agent, approval_resolver 없음)는 destructive raw browser_session/
    # browser_action 을 노출하지 않는다(승인거부). confluence_browser_search 미러인 non-destructive
    # github_browse(SSO 로그인+same-origin read-only navigate+snapshot)로 인증 파일 확인·정책 A 충족.
    classes = [
        GithubTaskScanTool,
        WebSiteSweepTool,
        GithubBrowseTool,
        BrowserQueryTool,
        WebFetchTool,
        GithubSubmitFindingTool,
        TriageCandidatesTool,
        DevopsTargetSetStatusTool,
        ScanTextTool,
        SkillTool,
        ToolSearchTool,
    ]
    # active 크리덴셜 유효성 검증(PAT whoami·DB login) — 마스터 스위치 켜졌을 때만 노출
    # (codex D6). scope/단발원장/차단기는 실행 시 코어가 재확인(fail-closed).
    if (os.environ.get("SA_CRED_PROBE") or "").strip().lower() in ("1", "true", "yes", "on"):
        from domains.services.github.plugin.tools.github_credential_login_probe_tool import (
            GithubCredentialLoginProbeTool,
        )
        classes.append(GithubCredentialLoginProbeTool)
    return classes


def github_scan_tools() -> list[type]:
    """repo 스캔 워커 도구셋 — `github_task_tools`(SSO URL 점검용)와 **다르다.**

    SSO 쪽은 브라우저·웹패치가 중심이고, repo 스캔은 API 스캔 + 제출 + 종료다.
    한 목록으로 합치지 않는 이유: 스캔 워커에 브라우저를 주면 무인 워커가 승인 없는
    destructive 도구 앞에서 멈추고, SSO 워커에 repo 종료 도구를 주면 남의 큐를 닫는다.

    ★ finding 은 반드시 `github_submit_finding` 으로 낸다. 그래야 코어
      `judge_task_finding` 을 타고 category 판정자(PII 소수부 거부 R1 등)까지 닿는다.
      스캐너가 `finding_upsert` 로 직접 쓰던 경로는 그 판정을 통째로 건너뛰었다
      (2026-08-26 실측: kr_phone 오탐 3,867건이 그렇게 들어왔다).
    """
    from secu_agent.agent.tools.scan_text import ScanTextTool
    from secu_agent.agent.tools.skill_tool import SkillTool
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool
    from secu_agent.agent.tools.triage_candidates import TriageCandidatesTool

    from domains.services.github.plugin.tools.github_repo_set_status_tool import (
        GithubRepoSetStatusTool,
    )
    from domains.services.github.plugin.tools.github_submit_finding_tool import (
        GithubSubmitFindingTool,
    )
    from domains.services.plugin.tools.service_task_tools import GithubTaskScanTool

    from service.agents.candidate_counters import ensure_registered
    ensure_registered()  # v3.90 침묵 게이트 — 도메인 도구 후보 counter 배선

    return [
        GithubTaskScanTool,
        GithubSubmitFindingTool,
        GithubRepoSetStatusTool,
        TriageCandidatesTool,
        ScanTextTool,
        SkillTool,
        ToolSearchTool,
    ]
