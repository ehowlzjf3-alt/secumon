"""Agent에 노출되는 도구들.

task_type에 맞춰 registry를 빌드한다.

de-domain: 도메인(점검) 툴/branch 는 secu-agent-skill 로 추출됨. 코어는
operator / package_sandbox / finding_narrator + generic fallback 만 빌드한다.
미지의 task_type 은 generic fallback (ScanText + SubmitFinding) — 재부착
plugin API 가 도메인 branch 를 다시 공급한다.

v3.85: task_type→도구셋은 register_task_toolset 등록형(더 이상 하드코딩 switch
아님). 코어 operator/package_sandbox/finding_narrator 도 같은 공개 훅으로 등록 —
도메인 plugin 은 register_task_toolset("dns", provider) 로 코어 0줄 수정 없이 등록.
"""
from collections.abc import Callable, Iterable

from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolInvocation,
    ToolResult,
    ToolSuccess,
)
from secu_agent.agent.tools.discovery import (
    Toolset,
    build_registry_from_toolset,
    discover_tool_classes,
)
from secu_agent.agent.tools.registry import ToolRegistry
from secu_agent.agent.tools.scan_text import ScanTextTool
from secu_agent.agent.tools.submit_finding import SubmitFindingTool
from secu_agent.agent.tools.enrich_finding import EnrichFindingTool
from secu_agent.agent.tools.agent_tool import AgentTool
from secu_agent.agent.tools.schedule_tool import ScheduleTool
from secu_agent.agent.tools.skill_tool import SkillTool
from secu_agent.agent.tools.todo_tool import TodoTool
from secu_agent.agent.tools.goal_tool import GoalTool
from secu_agent.agent.tools.python_exec_tool import PythonExecTool
from secu_agent.agent.tools.submit_task_result import SubmitTaskResultTool
from secu_agent.agent.tools.clarify_tool import ClarifyTool
from secu_agent.agent.tools.deep_mode import DeepModeTool
from secu_agent.agent.tools.evidence_tools import (
    BashEvidenceTool, GrepEvidenceTool, ReadEvidenceFileTool,
)
from secu_agent.agent.tools.read_extract import ReadExtractTool
from secu_agent.agent.tools.submit_verdict import SubmitVerdictTool
from secu_agent.agent.tools.host_tools import (
    HostCodeOutlineTool, HostCopyFileTool, HostEditFileTool, HostMoveFileTool,
    HostReadFileTool, HostSearchTool, HostWriteFileTool,
)
from secu_agent.agent.tools.terminal_tool import TerminalTool
from secu_agent.agent.tools.process_tool import ProcessTool
from secu_agent.agent.tools.image_tools import ImageInspectTool
from secu_agent.agent.tools.memory_tool import MemoryTool
from secu_agent.agent.tools.browser_tool import (
    BrowserActionTool, BrowserQueryTool, BrowserSessionTool, BrowserSupervisorTool,
)
from secu_agent.agent.tools.schedule_wakeup_tool import ScheduleWakeupTool
from secu_agent.agent.tools.plan_mode_tools import (
    EnterPlanModeTool, ExitPlanModeTool,
)
from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool
from secu_agent.agent.tools.session_search_tool import SessionSearchTool
from secu_agent.agent.tools.deliver_tool import DeliverTool
from secu_agent.agent.tools.triage_candidates import TriageCandidatesTool
from secu_agent.agent.tools.web_fetch_tool import WebFetchTool
from secu_agent.agent.tools.tool_search_tool import ToolSearchTool


def _register_capable(r: ToolRegistry, cls: type[Tool],
                      caps: frozenset[str]) -> None:
    """v3.25-A — 도구의 requires_capabilities 가 frontend caps 의 subset 일 때만 등록.

    None 같으면 caps 미명시 = capability 요구 도구는 모두 제외 (conservative).
    """
    needed = cls.requires_capabilities
    if needed and not needed.issubset(caps):
        return
    r.register(cls)


def _register_mcp_tools(r: ToolRegistry, caps: frozenset[str]) -> None:
    """v3.52-A4: lifespan 이 bootstrap 한 MCP 도구를 registry 에 추가.

    cache 가 비어있으면 (bootstrap 안 됐거나 server 죽음) no-op — 안전.
    """
    try:
        from secu_agent.mcp.state import registered_mcp_tools
    except Exception:
        return
    for cls in registered_mcp_tools():
        _register_capable(r, cls, caps)


# ── task_type → 도구셋 provider 레지스트리 (v3.85: 등록형 전환) ──────────────
# 이전엔 build_registry_for_task 가 task_type 하드코딩 if-switch 였다 — 새 도메인
# task_type 은 자기 도구를 노출하려면 코어를 수정해야 했다(도메인 누출). 이제 코어는
# task_type→provider 레지스트리만 들고, 코어 자신의 operator/package_sandbox/
# finding_narrator 도 아래에서 같은 공개 훅(register_task_toolset)으로 등록한다.
_TASK_TOOLSETS: dict[str, Callable[[], Iterable[type[Tool]]]] = {}


def register_task_toolset(
    task_type: str, provider: Callable[[], Iterable[type[Tool]]]
) -> None:
    """task_type 의 도구셋 provider 등록 (plugin API). 중복은 명시 에러.

    provider() 는 노출할 Tool 서브클래스를 순서대로 반환. 실제 registry 는
    build_registry_for_task 가 frontend capability 게이트(_register_capable)와
    MCP 도구 레이어(_register_mcp_tools)를 균일 적용해 빌드한다 — provider 는
    이 안전 파이프라인을 우회할 수 없다.
    """
    if task_type in _TASK_TOOLSETS:
        raise ValueError(f"task_type toolset already registered: {task_type!r}")
    _TASK_TOOLSETS[task_type] = provider


def unregister_task_toolset(task_type: str) -> None:
    """등록 해제 (test/plugin 재부착용). 미등록은 무시."""
    _TASK_TOOLSETS.pop(task_type, None)


def registered_task_toolsets() -> frozenset[str]:
    """등록된 task_type 집합 (generic fallback 미포함)."""
    return frozenset(_TASK_TOOLSETS)


_GENERIC_FALLBACK_TOOLS: tuple[type[Tool], ...] = (
    ScanTextTool, SubmitFindingTool, TriageCandidatesTool,
)


def build_registry_for_task(
    task_type: str,
    *,
    frontend_capabilities: set[str] | frozenset[str] | None = None,
) -> ToolRegistry:
    """task_type에 맞는 도구만 노출.

    task_type→provider 는 register_task_toolset 로 등록된다(코어 operator/
    package_sandbox/finding_narrator 포함). 미등록 task_type → generic fallback
    (scan_text + submit_finding) — plugin 재부착 전까지 최소 공통 도구만.

    frontend_capabilities (v3.25-A):
        frontend 가 처리 가능한 capability set. 도구가 requires_capabilities 로
        요구하면 frontend caps 의 subset 일 때만 등록. None = 보수적 (capability
        요구 도구 모두 제외).
        예: chat WS = None / {} → enter_plan_mode 자동 제외.
        CLI keystroke approval 환경 = {"interactive_approval"} → 노출.
    """
    caps: frozenset[str] = frozenset(frontend_capabilities or ())
    provider = _TASK_TOOLSETS.get(task_type)
    classes: Iterable[type[Tool]] = (
        provider() if provider is not None else _GENERIC_FALLBACK_TOOLS
    )
    r = ToolRegistry()
    for cls in classes:
        _register_capable(r, cls, caps)
    _register_mcp_tools(r, caps)
    return r


# ── 코어 task_type 도구셋 (도메인 아님 — 범용/코어 상주 sub-agent) ──────────────
def _operator_tools() -> tuple[type[Tool], ...]:
    # v3.24: operator = main agent (Claude Code 패러다임).
    # de-domain: 도메인 점검 도구는 secu-agent-skill 로 추출됨 — 코어 생존자만.
    # ClarifyTool 은 frontend marker 미구현이라 제외 — 자연어 final message 로 대체.
    # v3.25-A: enter/exit_plan_mode 는 requires_capabilities 기반 게이트 —
    # chat WS (caps 없음) 에선 자동 제외, CLI ({"interactive_approval"}) 에선 노출.
    return (
        SubmitFindingTool, EnrichFindingTool, ScanTextTool, TriageCandidatesTool,
        AgentTool, SkillTool,
        TodoTool, DeepModeTool, GoalTool, SessionSearchTool, PythonExecTool,
        RunInSandboxTool, EnterPlanModeTool, ExitPlanModeTool, TerminalTool,
        ProcessTool, ImageInspectTool, MemoryTool, ReadEvidenceFileTool,
        GrepEvidenceTool, BashEvidenceTool, HostReadFileTool, HostSearchTool,
        HostCodeOutlineTool, HostCopyFileTool, HostMoveFileTool, HostWriteFileTool,
        HostEditFileTool, BrowserSessionTool, BrowserActionTool, BrowserQueryTool,
        BrowserSupervisorTool, ScheduleTool, ScheduleWakeupTool, DeliverTool,
        WebFetchTool, ToolSearchTool,
    )


def _package_sandbox_tools() -> tuple[type[Tool], ...]:
    # spike: ai-sandbox 패키지 분석 도메인 포팅. evidence_dir 정적 분석 +
    # submit_verdict 종료. (코어 상주 — 물리 이관은 별도 skill 작업.)
    return (
        ReadExtractTool, ReadEvidenceFileTool, GrepEvidenceTool, BashEvidenceTool,
        SubmitVerdictTool, ToolSearchTool,
    )


def _finding_narrator_tools() -> tuple[type[Tool], ...]:
    # v3.76: finding_narrator subagent — 기존 finding 의 4부 위험내용 백필 전용.
    # 읽기도구(DB/증거 조회) + enrich_finding 만 노출. submit_finding/pivot/
    # browser-write/scan 제외 — 새 finding 생성·라이브 재탐색 금지(GET-only,
    # record-only 보존). 마스킹은 enrich_finding 스키마 description + skill 룰로 강제.
    return (
        EnrichFindingTool, SessionSearchTool, ReadEvidenceFileTool,
        GrepEvidenceTool, SkillTool, ToolSearchTool,
    )


register_task_toolset("operator", _operator_tools)
register_task_toolset("package_sandbox", _package_sandbox_tools)
register_task_toolset("finding_narrator", _finding_narrator_tools)


__all__ = [
    "Tool", "ToolContext", "ToolError", "ToolInvocation", "ToolResult", "ToolSuccess",
    "ToolRegistry", "Toolset", "build_registry_for_task",
    "build_registry_from_toolset", "discover_tool_classes",
    "register_task_toolset", "unregister_task_toolset", "registered_task_toolsets",
]
