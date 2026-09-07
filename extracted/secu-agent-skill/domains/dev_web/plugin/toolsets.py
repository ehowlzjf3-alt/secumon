"""dev_web 도메인 도구셋 provider — task_type → 도구 화이트리스트.

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


def dev_web_task_tools() -> list[type]:
    from secu_agent.agent.tools.scan_text import ScanTextTool
    from secu_agent.agent.tools.skill_tool import SkillTool
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool
    from secu_agent.agent.tools.triage_candidates import TriageCandidatesTool

    from domains.dev_web.plugin.tools.dev_web_discovery_tool import DevWebTargetSetStatusTool
    from domains.dev_web.plugin.tools.dev_web_submit_finding_tool import DevWebSubmitFindingTool
    from domains.web.plugin.tools.web_tools import (
        WebFetchTool,
        WebTaskScanTool,
        WebResourceProbeTool,
    )

    from domains.dev_web.plugin.tools.dev_web_coverage_tools import (
        DevWebBrowseWorkerTool,
        DevWebBrowserQueryTool,
        DevWebSiteSweepTool,
    )

    from service.agents.candidate_counters import ensure_registered
    ensure_registered()  # v3.90 침묵 게이트 — 도메인 도구 후보 counter 배선

    classes = [
        DevWebSiteSweepTool,
        DevWebBrowseWorkerTool,
        DevWebBrowserQueryTool,
        WebFetchTool,
        WebResourceProbeTool,
        WebTaskScanTool,
        DevWebSubmitFindingTool,
        TriageCandidatesTool,
        DevWebTargetSetStatusTool,
        ScanTextTool,
        SkillTool,
        ToolSearchTool,
    ]
    # active 크리덴셜 유효성 검증 — 마스터 스위치 켜졌을 때만 노출(codex D6). scope/단발원장/
    # 차단기는 실행 시 코어가 재확인(fail-closed).
    if (os.environ.get("SA_CRED_PROBE") or "").strip().lower() in ("1", "true", "yes", "on"):
        from domains.dev_web.plugin.tools.dev_web_credential_login_probe_tool import (
            DevWebCredentialLoginProbeTool,
        )
        classes.append(DevWebCredentialLoginProbeTool)
    return classes
