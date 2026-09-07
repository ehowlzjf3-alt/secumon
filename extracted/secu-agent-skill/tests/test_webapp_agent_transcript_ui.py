"""Static checks for the SMB agent transcript panel."""
from __future__ import annotations

from pathlib import Path


def test_smb_ui_has_no_duplicate_copy() -> None:
    """SMB UI 사본은 하나뿐이다.

    2026-08-15 이전엔 `webapp/ui/index.html` 과 `domains/smb/webapp/ui/index.html` 두 벌이
    있었고, 이 테스트가 "둘이 같은지" 를 검사해 **중복을 유지**하고 있었다. 한쪽만 고치면
    테스트가 깨지므로 매번 양쪽을 고쳐야 했다 — 동기화 비용을 테스트로 강제하던 셈이다.
    루트 shim 제거로 사본을 없앴으니, 이제는 **되살아나지 않는 것**을 검사한다.
    """
    assert Path("domains/smb/webapp/ui/index.html").exists()
    for legacy in (Path("webapp/ui/index.html"), Path("dev_webapp/ui/index.html")):
        assert not legacy.exists(), (
            f"{legacy} 사본이 되살아났다. UI 원본은 domains/<도메인>/webapp/ui 하나뿐이다."
        )


def test_agent_chat_renders_transcript_metadata() -> None:
    html = Path("domains/smb/webapp/ui/index.html").read_text(encoding="utf-8")

    assert "function renderAgentTranscriptMeta" in html
    assert "d&&d.transcript?d.transcript" in html
    assert "t.entry_count" in html
    assert "t.evidence_dir" in html
    assert "renderAgentTranscriptMeta(d,'host-session')" in html


def test_dashboard_exposes_operator_worker_console() -> None:
    html = Path("domains/smb/webapp/ui/index.html").read_text(encoding="utf-8")

    assert "function ensureDashboardShell" in html
    assert "id=\"dash-summary\"" in html
    assert "id=\"pipeline-grid\"" in html
    assert "id=\"agent-console-shell\"" in html
    assert "function renderAgentConsole" in html
    assert "id=\"agent-chat-modal\"" in html
    assert "function backdropCloseAgentSession" in html
    assert "function openPipelineTargetFromRow" in html
    assert "Operator / Worker Console" in html
    assert "worker-transcript" in html
    assert "worker-console" in html
    assert "thread-timeline" in html
    assert "open-thread-detail" in html


def test_worker_selection_renders_chat_context_instead_of_raw_status_line() -> None:
    html = Path("domains/smb/webapp/ui/index.html").read_text(encoding="utf-8")
    open_session = html.split("async function openAgentSession", 1)[1].split("function closeAgentSession", 1)[0]

    assert "function workerStatusLabel" in html
    assert "function renderAgentSessionContext" in html
    assert "function displayMessageText" in html
    assert "session-context" in html
    assert "Worker Chat" in html
    assert "$('#agent-chat')" in open_session
    assert "$('#agent-chat-modal')" not in open_session
    assert "class=\"agent-chat-modal\"" not in open_session
    assert "renderAgentSessionContext(d)}${renderMessages(d.messages)" in open_session
    assert "target=(\\\\\\\\.+?)" in html
    assert "상태: ${workerStatusLabel(target[2])}" in html


def test_pipeline_target_click_opens_agent_chat_modal() -> None:
    html = Path("domains/smb/webapp/ui/index.html").read_text(encoding="utf-8")
    target_list = html.split("function targetList", 1)[1].split("function renderAgents", 1)[0]
    pipeline_click = html.split("function openPipelineTargetFromRow", 1)[1].split("document.addEventListener('dblclick'", 1)[0]
    modal_fn = html.split("async function openAgentSessionModal", 1)[1].split("function closeAgentSessionModal", 1)[0]
    dblclick = html.split("document.addEventListener('dblclick'", 1)[1].split("function closeInvestigation", 1)[0]

    assert "openPipelineTargetFromRow(this)" in target_list
    assert "data-component" in target_list
    assert "data-ref" in target_list
    assert "openAgentSessionModal(component,ref)" in pipeline_click
    assert "$('#agent-chat-modal')" in modal_fn
    assert "class=\"agent-chat-modal\"" in modal_fn
    assert "role=\"dialog\"" in modal_fn
    assert "row.dataset&&row.dataset.component" in dblclick


def test_dashboard_keeps_pipeline_above_agent_console_without_full_reload() -> None:
    html = Path("domains/smb/webapp/ui/index.html").read_text(encoding="utf-8")
    shell = html.split("function ensureDashboardShell()", 1)[1].split("document.querySelectorAll", 1)[0]
    render_dash = html.split("async function renderDash()", 1)[1].split("async function toggleCron", 1)[0]

    assert shell.index("파이프라인 흐름") < shell.index("Operator / Worker Console")
    assert "ensureDashboardShell();" in render_dash
    assert "setHTMLIfChanged(summaryBox,summary)" in render_dash
    assert "setHTMLIfChanged(pipelineGrid,cards)" in render_dash
    assert "setHTMLIfChanged(agentShell,renderAgents(agents))" in render_dash
    assert "v.innerHTML='<p class=\"muted\">불러오는 중...</p>'" not in render_dash


def test_findings_and_report_are_split_with_tasking_completed_default() -> None:
    html = Path("domains/smb/webapp/ui/index.html").read_text(encoding="utf-8")
    render_findings = html.split("async function renderFindings()", 1)[1].split("function reportFindingCount", 1)[0]
    render_report_rows = html.split("function renderReportThreadRows", 1)[1].split("async function renderReport", 1)[0]
    render_report = html.split("async function renderReport()", 1)[1].split("function formatBytes", 1)[0]
    open_host = html.split("function openSmbHost", 1)[1].split("async function openSmbFinding", 1)[0]

    assert 'button data-tab="report">Report</button>' in html
    assert "const DEFAULT_HOST_STATUS='triaged_completed'" in html
    assert "const REPORT_READY_ONLY=true" in html
    assert "let findingState={" in html
    assert "status:String(persistedUiState.findingState?.status||DEFAULT_HOST_STATUS)" in html
    assert "let reportState={" in html
    assert "findingsOnly:persistedUiState.reportState?.findingsOnly!==false" in html
    assert "open-finding-detail" not in render_findings
    assert "report-thread-row" in render_report_rows
    assert "openReportThread(" in render_report_rows
    assert "const params={scope:'report',limit:1000}" in render_report
    assert "발송 전/발송 이후 포함" in render_report
    assert "loadReportThreadDetail(reportState.threadId" in html
    assert "setActiveTab('report')" in open_host
