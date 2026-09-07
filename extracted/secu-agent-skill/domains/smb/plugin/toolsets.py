"""SMB 도메인 sub-agent task_type → 도구셋 provider (register_task_toolset 용).

de-domain: 코어 build_registry_for_task 는 register_task_toolset 로 등록된 provider 를
task_type 별로 노출한다(미등록 → generic fallback). roles/ (hr·strategy·orchestrator)와
동형으로, SMB 의 sub-agent 역할(smb_file_inspect)을 여기서 명시 도구셋으로 공급하고
bootstrap 이 register_task_toolset 로 배선한다.

⚠️ 구 `smb_share_master`(v3.23 2단의 리드)는 2026-08-21 제거했다 — Phase 2 의
도메인 무관 리드(`_shared/lead_tools.py` + `lead_adapter.py`)가 대체한다. 그 역할은
`agents/*.md` 가 없어 이미 도달 불가였고, 본문 반환 도구(`read_file_quick`)를 들고
있어 리드 규격에도 어긋났다.

codex 리뷰: smb_task_agent._tool_classes()(smb_task 점검 워커 계약)를 재사용하지 말 것 — 역할이
다르다. 순환 import 방지를 위해 provider 안에서 지연 import 한다.
"""
from __future__ import annotations

import os

from typing import TYPE_CHECKING

if TYPE_CHECKING:  # 타입 힌트만 — 런타임 순환 import 회피
    from secu_agent.agent.tools.base import Tool


def smb_file_inspect_tools() -> "tuple[type[Tool], ...]":
    """smb_file_inspect 역할: 위임받은 파일 1개 정밀 검토 — 본문 읽기 + 검사보고."""
    from domains.smb.plugin.tools.inspect_tools import (
        InspectArchiveIndexTool,
        ReadFileContentTool,
        ReportInspectionTool,
    )
    # 2026-08-27: 큰 아카이브를 "안 보고 버리는" 것처럼 보였던 이유가 도구 부재였다.
    return (ReadFileContentTool, InspectArchiveIndexTool, ReportInspectionTool)


def _bool_env(name: str, default: bool = False) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on", "y"}


def smb_task_tools() -> list[type]:
    """#1 점검 unlock 도구 화이트리스트 (메일/POP3 도구 미포함 = contract 분리)."""
    from secu_agent.agent.tools.scan_text import ScanTextTool
    from secu_agent.agent.tools.skill_tool import SkillTool
    from secu_agent.agent.tools.tool_search_tool import ToolSearchTool

    from domains.smb.plugin.tools.smb_task_tools import SmbTaskPythonTool, SmbFetchScanTool
    # 2026-08-27: 코드가 훑고 LLM 이 판정한다. 없을 때 실측은 722,958개 중 5개 스캔이었다.
    from domains.smb.plugin.tools.smb_scan_tools import (
        SmbArchiveIndexTool, SmbArchiveScanTool, SmbScanShareTool,
    )
    from domains.smb.plugin.tools.smb_credential_probe_tool import SmbCredentialProbeTool
    from domains.smb.plugin.tools.smb_origin_credential_probe_tool import (
        SmbOriginCredentialProbeTool,
    )
    from domains.smb.plugin.tools.hit_triage_tools import (
        SmbListPendingHitsTool, SmbSetHitVerdictTool,
    )
    from domains.smb.plugin.tools.smb_submit_finding_tool import SmbSubmitFindingTool
    # v3.88 배선 갭 수정: #1 점검 워커는 이미지/PDF 심층검사 도구가 필요하다(redesign doc §#1 점검
    # 표: smb_inspect_image/pdf 포함, SKILL.md deepdive 안내). read-only·non-egress 검사 도구라
    # 안전하며, 이게 없으면 워커가 SKILL.md 가 지시하는 deepdive 를 실행할 수 없다(도구 미도달).
    from domains.smb.plugin.tools.smb_tools import SmbInspectImageTool, SmbInspectPdfTool
    from secu_agent.agent.tools.triage_candidates import TriageCandidatesTool

    from service.agents.candidate_counters import ensure_registered
    ensure_registered()  # v3.90 침묵 게이트 — 도메인 도구 후보 counter 배선

    classes = [
        SmbScanShareTool, SmbArchiveIndexTool, SmbArchiveScanTool,
        SmbTaskPythonTool, SmbFetchScanTool, SmbCredentialProbeTool,
        SmbOriginCredentialProbeTool,
        SmbSubmitFindingTool, TriageCandidatesTool,
        # 수집기가 걸어 둔 기존 hit 에 판정을 되돌려 쓴다(2026-08-28 복원).
        SmbListPendingHitsTool, SmbSetHitVerdictTool,
        SmbInspectImageTool, SmbInspectPdfTool,
        ScanTextTool, SkillTool, ToolSearchTool,
    ]
    # active DB-login 검증(recon→active 경계). 마스터 스위치 켜졌을 때만 도구 노출
    # (codex D6: 꺼진 상태에선 active capability 를 화이트리스트에서 제외). scope/단발원장/
    # 차단기는 도구 실행 시 코어가 재확인(fail-closed).
    if _bool_env("SA_CRED_PROBE"):
        from domains.smb.plugin.tools.smb_credential_login_probe_tool import (
            SmbCredentialLoginProbeTool,
        )
        classes.append(SmbCredentialLoginProbeTool)
    return classes
